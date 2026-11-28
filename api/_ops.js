// Error reporting to the outside watcher (edge/ops-watch on Cloudflare).
//
// Every request to /api/ai and /api/chat passes opsAfter() on its way out.
// A healthy request costs one in-memory counter update and nothing else. A
// failed one (5xx or a thrown error) sends one small report, capped at 300 ms
// and never able to change the reply. Roughly every 10 minutes one request
// per server instance also carries the request counts, so the watcher knows
// the share of calls that fail. Nothing here touches the database.
//
// Off switch: OPS_WATCH=0. Unset OPS_WATCH_URL / OPS_WATCH_SECRET also means off.

const env = () => globalThis.process?.env || {};
const TALLY_EVERY_MS = 10 * 60_000;
const MAX_PER_MIN = 20;

const tally = new Map();          // route -> [ok, failed, total ms]
let tallySince = Date.now();
let win = { at: 0, n: 0 };
let fwd = { at: 0, n: 0 };

function target() {
  const e = env();
  if (String(e.OPS_WATCH || "1").trim() === "0") return null;
  const url = String(e.OPS_WATCH_URL || "").trim().replace(/\/+$/, "");
  const secret = String(e.OPS_WATCH_SECRET || "").trim();
  return url && secret ? { url, secret } : null;
}
const deploy = () => String(env().VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || undefined;

export function opsSecretOk(req) {
  const t = target();
  const hdr = req.headers.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  if (!t || !token || token.length !== t.secret.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ t.secret.charCodeAt(i);
  return diff === 0;
}

async function shortHash(text) {
  try {
    const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    let s = "";
    for (let i = 0; i < 6; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  } catch { return undefined; }
}
// Who was affected, as a day-keyed hash: enough to count different people,
// useless for identifying anyone.
async function whoOf(req, secret) {
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "").split(",")[0].trim();
  return ip ? shortHash(`${ip}|${new Date().toISOString().slice(0, 10)}|${secret}`) : undefined;
}

export function opsRoute(req, base) {
  try {
    const op = new URL(req.url).searchParams.get("op");
    return op ? `${base}?op=${op.slice(0, 40)}` : base;
  } catch { return base; }
}

function takeTally(force) {
  if (!tally.size || (!force && Date.now() - tallySince < TALLY_EVERY_MS)) return null;
  const out = Object.fromEntries(tally);
  tally.clear();
  tallySince = Date.now();
  return out;
}

async function send(t, payload, capMs = 300) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), capMs);
  try {
    await fetch(`${t.url}/e`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t.secret}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch { /* reporting must never break a reply */ }
  finally { clearTimeout(timer); }
}

// A handler that catches its own errors and answers 500 would hide what went
// wrong. It hands the error over here first, so the report still carries the
// real message and call path.
const caught = new WeakMap();
export function opsCaught(req, err) {
  try { caught.set(req, err); } catch {}
}

// Returns null when there is nothing to send (the normal case), otherwise a
// promise the caller hands to waitUntil() or awaits.
export function opsAfter(req, route, res, ms, err) {
  const t = target();
  if (!t) return null;
  if (!err && res && res.status >= 500) err = caught.get(req) || null;
  const status = res?.status || (err ? 500 : 0);
  const failed = !!err || status >= 500;
  const row = tally.get(route) || [0, 0, 0];
  row[failed ? 1 : 0]++; row[2] += ms;
  tally.set(route, row);
  if (tally.size > 200) tally.clear();
  if (!failed) {
    const due = takeTally(false);
    return due ? send(t, { src: "js", deploy: deploy(), tally: due, events: [] }) : null;
  }
  const now = Date.now();
  if (now - win.at > 60_000) win = { at: now, n: 0 };
  if (++win.n > MAX_PER_MIN) return null;      // storm guard: counted in the tally, not sent one by one
  return (async () => {
    const ev = { t: now, route, method: req.method, status, ms, who: await whoOf(req, t.secret), region: env().VERCEL_REGION || undefined };
    if (err) {
      ev.kind = "exception";
      ev.etype = String(err?.name || "Error").slice(0, 60);
      ev.msg = String(err?.message || err).slice(0, 300);
      ev.frames = String(err?.stack || "").split("\n").slice(1, 9)
        .map((l) => (/^\s*at\s+(?:async\s+)?([A-Za-z0-9_$.<>]+)\s*\(/.exec(l) || [])[1]).filter(Boolean);
    } else {
      ev.kind = "http5xx";
      try {
        if ((res.headers.get("Content-Type") || "").includes("json")) {
          const text = (await res.clone().text()).slice(0, 400);
          ev.body = text;
          const m = /"error"\s*:\s*"([^"]{1,60})"/.exec(text);
          if (m) ev.code = m[1];
        }
      } catch {}
      if (status === 504 && ev.code === "timeout") ev.kind = "timeout";
    }
    try { console.log("OPS_EVT " + JSON.stringify(ev)); } catch {}
    await send(t, { src: "js", deploy: deploy(), tally: takeTally(false) || undefined, events: [ev] });
  })();
}

// Wraps an Edge handler so every request is counted and every failure reported.
export function withOps(base, inner) {
  return async function handler(req, ctx) {
    const t0 = Date.now();
    let res;
    try {
      res = await inner(req, ctx);
    } catch (e) {
      const p = opsAfter(req, opsRoute(req, base), null, Date.now() - t0, e);
      if (p) await p;
      throw e;
    }
    const p = opsAfter(req, opsRoute(req, base), res, Date.now() - t0, null);
    if (p) {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
      else await p;
    }
    return res;
  };
}

// Browser-side failures arrive at /api/ai?op=ev anyway (telemetry.js). The
// three kinds that mean "something broke" are passed on; the visitor id is
// hashed first.
export async function opsForwardBrowser(vid, rows) {
  const t = target();
  if (!t || !rows.length) return;
  const now = Date.now();
  if (now - fwd.at > 60_000) fwd = { at: now, n: 0 };
  if (++fwd.n > 60) return;
  const events = rows.slice(0, 40).map((r) => ({ t: Date.parse(r.ts) || now, kind: r.kind, path: r.path, target: r.target, props: r.props }));
  await send(t, { src: "browser", vid: await shortHash(`v|${vid}`), deploy: deploy(), events });
}

// Sign-up truth. The watcher compares what people did on the sign-up page
// (as their browsers report it, the moment it happens) with the accounts the
// database really created. Only counts leave here: no ids, no text.
let flowWin = { at: 0, n: 0 };
export async function opsSignupFlow(rows) {
  const t = target();
  if (!t || !rows.length) return;
  const flow = {};
  const add = (k) => { flow[k] = (flow[k] || 0) + 1; };
  for (const r of rows) {
    if (r.kind === "page" && (r.path === "/register" || r.path === "/register/")) add("view");
    else if (r.kind === "form_start" && r.target === "reg-form") add("start");
    // "submit" = a sign-up request really sent (register.js logs reg-sent
    // after the form checks pass). Presses of the button the checks stop
    // (reg-form) once raised a stuck alarm: 8 presses, 1 request.
    else if (r.kind === "form_submit" && r.target === "reg-sent") add("submit");
    else if (r.kind === "form_submit" && r.target === "otp-form") add("otp");
    else if (r.kind === "form_error" && (r.target === "reg-form" || r.target === "otp-form")) add("error");
  }
  if (!Object.keys(flow).length) return;
  const now = Date.now();
  if (now - flowWin.at > 60_000) flowWin = { at: now, n: 0 };
  if (++flowWin.n > 120) return;
  await send(t, { src: "js", flow, events: [] });
}

// Hourly test report asked for by the watcher: proves this path still works.
export async function opsCanary() {
  const t = target();
  if (!t) return false;
  await send(t, { src: "js", deploy: deploy(), tally: takeTally(true) || undefined, events: [{ kind: "canary", t: Date.now() }] }, 2000);
  return true;
}

// Server-side read of the watcher's own status, for the admin Issues tab.
export async function opsStatus() {
  const t = target();
  if (!t) return { ok: false, why: "not_configured" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${t.url}/status`, { headers: { Authorization: `Bearer ${t.secret}` }, signal: ctrl.signal });
    return r.ok ? await r.json() : { ok: false, why: `status_${r.status}` };
  } catch { return { ok: false, why: "unreachable" }; }
  finally { clearTimeout(timer); }
}

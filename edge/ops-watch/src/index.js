// Ops watcher: receives error reports, runs the one-minute pulse.
// Runs on its own workers.dev address, outside the site and the database it
// watches, so it still works when either is down.

import { ingest, kvGet, kvPut, mergeSignatures, splitSignature } from "./core.js";
import { runPulse } from "./pulse.js";
import { setActive, setUsage, setPaused, answer, addNote, gateView, gateSummary, testWake } from "./gaterun.js";
import { page } from "./page.js";
import { runRobot, robotView } from "./robot.js";
import { flowSums } from "./senses.js";
import { dayInfo } from "./calendar.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
const authed = (req, env) => sameSecret((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""), env.OPS_SECRET || "");

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs || 8000);
  try {
    const { timeoutMs, ...rest } = init;
    const r = await fetch(url, { ...rest, signal: ctrl.signal, redirect: "manual" });
    try { await r.body?.cancel(); } catch {}
    return { status: r.status };
  } finally { clearTimeout(timer); }
}

export function makeDeps(env) {
  const now = () => Date.now();
  return {
    now,
    fetch: timedFetch,
    // A full request for the journey robot: status, time and the (short) body.
    async http(url, init = {}) {
      const t0 = now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), init.timeoutMs || 10000);
      try {
        const { timeoutMs, ...rest } = init;
        const r = await fetch(url, { ...rest, signal: ctrl.signal, redirect: "manual" });
        const text = (await r.text()).slice(0, 20000);
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: r.status, ms: now() - t0, text, json };
      } catch (e) {
        return { status: 0, ms: now() - t0, err: String(e?.message || e).slice(0, 80), text: "", json: null };
      } finally { clearTimeout(timer); }
    },
    // Calls one function in the main database. The public (anon) key only
    // gets the request through the door; each function checks the collector's
    // own secret before doing anything.
    async rpc(name, p) {
      const t0 = now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 7000);
      try {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
          body: JSON.stringify({ p_secret: env.OPS_SECRET, p }),
          signal: ctrl.signal,
        });
        const ms = now() - t0;
        if (!r.ok) { try { await r.body?.cancel(); } catch {} return { ok: false, status: r.status, ms }; }
        return { ok: true, status: r.status, ms, data: await r.json() };
      } catch (e) {
        return { ok: false, status: 0, ms: now() - t0, err: String(e?.message || e).slice(0, 120) };
      } finally { clearTimeout(timer); }
    },
    // Direct e-mail for when the normal alert path (which needs the database)
    // cannot be used. At most one every 10 minutes unless forced.
    async mail(title, body, opts = {}) {
      try {
        if (!opts.force) {
          const last = await kvGet(env, "mail_last");
          if (last && now() - last.at < 10 * 60_000) {
            await kvPut(env, "mail_last", { at: last.at, held: (last.held || 0) + 1 }, now()).run();
            return false;
          }
          if (last?.held) body += `\n\n(${last.held} more alert(s) were held back in the last 10 minutes; they are in the admin panel, Issues tab.)`;
        }
        await kvPut(env, "mail_last", { at: now(), held: 0 }, now()).run();
        if (env.RESEND_API_KEY) {
          const r = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: env.OPS_MAIL_FROM, to: [env.OPS_MAIL_TO], subject: title.slice(0, 200), text: body.slice(0, 6000) }),
          });
          try { await r.body?.cancel(); } catch {}
          if (r.ok) return true;
        }
        const r = await timedFetch(`${env.SITE_URL}/api/ai?op=ops-mail`, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.OPS_SECRET}`, "Content-Type": "application/json" },
          body: JSON.stringify({ to: env.OPS_MAIL_TO, title: title.slice(0, 200), body: body.slice(0, 6000) }),
          timeoutMs: 10000,
        });
        return r.status >= 200 && r.status < 300;
      } catch { return false; }
    },
    // Starts the agent: one call to the routine's own start address. Every
    // call creates a new session, so there is no retry in here. `status: 0`
    // without `why` means "no answer": it may or may not have started.
    async wake(text) {
      if (!env.AGENT_FIRE_URL || !env.AGENT_FIRE_TOKEN) return { ok: false, status: 0, why: "no_token" };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const r = await fetch(String(env.AGENT_FIRE_URL).trim(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${String(env.AGENT_FIRE_TOKEN).trim()}`, "Content-Type": "application/json",
            "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01",
          },
          body: JSON.stringify({ text: String(text).slice(0, 6000) }),
          signal: ctrl.signal,
        });
        let id = null, err = null;
        try {
          const raw = await r.text();
          let j = null;
          try { j = JSON.parse(raw); } catch {}
          id = j?.claude_code_session_id || j?.session_id || j?.id || null;
          if (!r.ok) err = String(j?.error?.message || j?.error?.type || j?.message || raw || "").slice(0, 300) || null;
          // Says nothing about the token except its shape, which is what a bad paste breaks.
          if (!r.ok && !err) {
            const t = String(env.AGENT_FIRE_TOKEN);
            err = `refused with no reason given; token is ${t.length} characters${/^[!-~]+$/.test(t) ? "" : ", and holds spaces or unprintable characters"}; address ${/^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/.test(String(env.AGENT_FIRE_URL)) ? "looks right" : "looks wrong"}`;
          }
        } catch {}
        return { ok: r.ok, status: r.status, id, err };
      } catch (e) {
        return { ok: false, status: 0, err: String(e?.message || e).slice(0, 120) };
      } finally { clearTimeout(timer); }
    },
  };
}

// The collector's own public address, learned from the first signed-in request
// (the site posts here all day). Used only to build links in the daily brief.
let selfKnown = false;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/favicon.ico") return new Response("ok", { status: 200 });
    // Signed links from the daily brief: no password, the signature is the key.
    if (url.pathname === "/p") {
      try { return await page(req, env, makeDeps(env)); } catch { return new Response(null, { status: 500 }); }
    }
    if (!authed(req, env)) return new Response(null, { status: 404 });
    const deps = makeDeps(env);
    if (!selfKnown) {
      selfKnown = true;
      ctx.waitUntil(kvPut(env, "self", { origin: url.origin }, Date.now()).run().catch(() => {}));
    }
    try {
      if (req.method === "POST" && url.pathname === "/e") {
        let body;
        try { body = JSON.parse((await req.text()).slice(0, 200_000)); } catch { return json(400, { ok: false, why: "bad_body" }); }
        // Senders give up after 300 ms, so answer at once and finish the
        // work afterwards. ?wait=1 (tests) returns the result instead.
        if (url.searchParams.get("wait") === "1") return json(200, await ingest(env, deps, body));
        ctx.waitUntil(ingest(env, deps, body).catch(async (e) => {
          try { await kvPut(env, "ingest_error", { at: Date.now(), err: String(e?.stack || e).slice(0, 600) }, Date.now()).run(); } catch {}
        }));
        return json(202, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/status") return json(200, await status(env, deps));
      if (req.method === "GET" && url.pathname === "/sig") {
        const fp = url.searchParams.get("fp") || "";
        const row = await env.DB.prepare("SELECT * FROM sig WHERE fp = ?1").bind(fp).first();
        if (!row) return json(404, { ok: false });
        const days = await env.DB.prepare("SELECT day, hits, people FROM sig_day WHERE fp = ?1 ORDER BY day DESC LIMIT 60").bind(fp).all();
        const merged = await env.DB.prepare("SELECT fp, why FROM alias WHERE head = ?1").bind(fp).all();
        return json(200, { ok: true, sig: row, days: days.results, merged: merged.results });
      }
      if (req.method === "POST" && url.pathname === "/admin") {
        const b = await req.json().catch(() => ({}));
        if (b.op === "merge") return json(200, await mergeSignatures(env, deps, b));
        if (b.op === "split") return json(200, await splitSignature(env, deps, b));
        if (b.op === "pulse") return json(200, await runPulse(env, deps));
        // The journey robot, run now (Saathi only when asked: it costs AI money).
        if (b.op === "robot") return json(200, await runRobot(env, deps, { force: true, saathi: b.saathi === true }));
        if (b.op === "senses") {
          const now = deps.now();
          const runs = await env.DB.prepare("SELECT t, step, ok, ms, why, what FROM robot_run ORDER BY t DESC, step LIMIT 40").all();
          return json(200, { ok: true, calendar: dayInfo(now), robot: await robotView(env, now), runs: runs.results, outside: await kvGet(env, "outside"),
            signup_flow: { last_30_min: await flowSums(env, now, 30), last_60_min: await flowSums(env, now, 60), last_24_h: await flowSums(env, now, 1440) },
            nightly: await kvGet(env, "senses"), builds_watched: ((await kvGet(env, "state")) || {}).dep || [] });
        }
        if (b.op === "memo") {
          const r = await env.DB.prepare("SELECT kind, id, data FROM memo WHERE kind = ?1 LIMIT 300").bind(b.kind === "recipes" ? "recipes" : "cases").all();
          return json(200, { ok: true, rows: r.results });
        }
        if (b.op === "test") {
          // Point the pulse somewhere that fails, for a few minutes, to prove
          // the outage alarm works. Only this-site test addresses are accepted.
          const st = (await kvGet(env, "state")) || {};
          const mins = Math.max(1, Math.min(10, Number(b.minutes) || 3));
          const bad = `${env.SITE_URL}/__ops_watch_test_${Date.now()}__`;
          st.test = { until: Date.now() + mins * 60_000, site: b.site ? bad : undefined, api: b.api ? bad : undefined, db: !!b.db };
          await kvPut(env, "state", st, Date.now()).run();
          return json(200, { ok: true, test: { ...st.test, site: !!st.test.site, api: !!st.test.api } });
        }
        // The plan meter: posted by the meter script and by the owner's sessions.
        if (b.op === "active") return json(200, await setActive(env, deps));
        if (b.op === "usage") return json(200, await setUsage(env, deps, b));
        // A short note from a work session: what changed and why.
        if (b.op === "work") return json(200, await addNote(env, deps, b));
        if (b.op === "approve") return json(200, await answer(env, deps, { fp: b.fp, issue: b.issue, action: b.action === "later" ? "later" : "approve" }));
        // The judge: what it would do now (always), plus switches.
        if (b.op === "gate") {
          if (typeof b.paused === "boolean") await setPaused(env, deps, b.paused);
          if (b.fire_test === true) return json(200, { ok: true, test: await testWake(env, deps) });
          return json(200, await gateView(env, deps));
        }
        return json(400, { ok: false, why: "unknown_op" });
      }
      return new Response(null, { status: 404 });
    } catch (e) {
      return json(500, { ok: false, why: String(e?.message || e).slice(0, 200) });
    }
  },

  async scheduled(event, env, ctx) {
    // Not configured yet (first deploy, before the secrets are set): do nothing
    // rather than report a false outage.
    if (!env.OPS_SECRET || !env.SUPABASE_ANON_KEY || !env.OPS_MAIL_TO) return;
    // The robot has its own two slots (minute 4 of every ten, and minute 5 as
    // a second try) and its own record, apart from the one-minute pulse.
    if (event.cron && event.cron !== "* * * * *") {
      ctx.waitUntil(runRobot(env, makeDeps(env)).catch(async (e) => {
        try { await kvPut(env, "robot_error", { at: Date.now(), err: String(e?.stack || e).slice(0, 600) }, Date.now()).run(); } catch {}
      }));
      return;
    }
    ctx.waitUntil(runPulse(env, makeDeps(env)).catch(async (e) => {
      // The watcher's own failures are recorded where the next pulse and the
      // status page can see them.
      try { await kvPut(env, "pulse_error", { at: Date.now(), err: String(e?.stack || e).slice(0, 600) }, Date.now()).run(); } catch {}
    }));
  },
};

async function status(env, deps) {
  const now = deps.now();
  const last = await env.DB.prepare("SELECT t, site, site_ms, api, api_ms, db, db_ms FROM pulse ORDER BY t DESC LIMIT 1").first();
  const st = (await kvGet(env, "state")) || {};
  const counts = await env.DB.prepare("SELECT state, COUNT(*) n FROM sig GROUP BY state").all();
  const today = await env.DB.prepare("SELECT k, v FROM kv WHERE k LIKE 'n:%' ORDER BY k DESC LIMIT 1").first();
  const outbox = await env.DB.prepare("SELECT COUNT(*) n FROM outbox").first();
  const up = await env.DB.prepare("SELECT COUNT(*) n, SUM(site) site, SUM(api) api, SUM(db) db FROM pulse WHERE t >= ?1").bind(now - 86400_000).first();
  return {
    ok: true, now,
    last_pulse: last || null,
    pulse_age_s: last ? Math.round((now - last.t) / 1000) : null,
    down: st.down || {},
    learning_until: st.learning_until || null,
    signatures: Object.fromEntries((counts.results || []).map((r) => [r.state, r.n])),
    reports_today: today ? Number(today.v) : 0,
    waiting_to_send: outbox?.n || 0,
    last_24h: up || null,
    canary: { js: await kvGet(env, "canary:js"), py: await kvGet(env, "canary:py"), sent: st.canary_sent || null },
    gate: await gateSummary(env, deps),
    calendar: dayInfo(now).line,
    robot: await robotView(env, now).catch(() => ({ state: "unknown", why: "could not be read" })),
    robot_error: await kvGet(env, "robot_error"),
    outside: await kvGet(env, "outside"),
    gate_error: await kvGet(env, "gate_error"),
    pulse_error: await kvGet(env, "pulse_error"),
    ingest_error: await kvGet(env, "ingest_error"),
  };
}

// The once-a-minute pulse. Knocks on the site, the API and the database from
// outside, and reads the handful of numbers the database already keeps in
// memory. Catches the problems that throw no error: outages, jobs that stopped,
// sign-ups drying up, a fix that made things worse.

import { record, kvGet, kvPut, syncCounts, flushOutbox, applyIssueChanges } from "./core.js";
import { scrub, fingerprint } from "./signature.js";
import { parseCron, prevRun } from "./cronexpr.js";
import { baseline, farOff, silentTooLong, fixVerdict, watchWindow, hourOfWeek, istDay, marketOpen } from "./rules.js";
import { isNseTradingDay } from "../../../js/data/nseCalendar.js";

const MIN = 60_000, HOUR = 3600_000;
const LOW_VITALS = ["signups", "trades", "views"];
const HIGH_VITALS = ["db_ms", "site_ms", "api_ms", "err_share", "conns"];

const item = (kind, sig, title, sampleObj, extra = {}) => ({
  d: { sig, src: sig.split("|")[0], kind, route: extra.route || null, title, trusted: 1, severity: extra.severity, extra: extra.extra },
  n: extra.n || 1, who: new Set(), first: sampleObj, last: sampleObj,
});

async function probe(deps, url, headers = {}) {
  const t0 = deps.now();
  try {
    const r = await deps.fetch(url, { method: "GET", headers: { "User-Agent": "StockSaathi-OpsWatch/1", "Cache-Control": "no-cache", ...headers }, timeoutMs: 8000 });
    return { ok: r.status >= 200 && r.status < 400, status: r.status, ms: deps.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: deps.now() - t0, err: String(e?.message || e).slice(0, 120) };
  }
}

export async function runPulse(env, deps) {
  const now = deps.now();
  const minute = Math.floor(now / MIN);
  const st = (await kvGet(env, "state")) || {};
  st.fail ||= { site: 0, api: 0, db: 0 };
  st.good ||= { site: 0, api: 0, db: 0 };
  st.down ||= {};
  st.cron_last ||= {};
  st.ring ||= [];
  st.acc ||= null;
  st.watch ||= {};
  st.streak ||= {};
  if (!st.since) {
    st.since = now; st.track_since = now; st.learning_until = now + 24 * HOUR;
    await kvPut(env, "learning_until", st.learning_until, now).run();
  }
  const test = st.test && st.test.until > now ? st.test : null;

  const t0 = now;
  const [site, api, dbr] = await Promise.all([
    probe(deps, test?.site || `${env.SITE_URL}/`),
    probe(deps, test?.api || `${env.SITE_URL}/api/health`),
    deps.rpc("ops_db_pulse", { cron_cursor: st.cron_cursor ?? null, net_cursor: st.net_cursor ?? null, since: st.issues_since ?? null, ms: st.last_db_ms ?? null }),
  ]);
  const db = { ok: !!(dbr.ok && dbr.data && dbr.data.ok), ms: dbr.ms ?? deps.now() - t0, status: dbr.status || 0, data: dbr.data || null };
  if (test?.db) db.ok = false;
  st.last_db_ms = db.ms;
  const items = [];

  // --- outages: two misses in a row ---
  const checks = { site, api, db };
  const NAMES = { site: "The website", api: "The API", db: "The database" };
  for (const k of ["site", "api", "db"]) {
    const c = checks[k];
    if (c.ok) { st.fail[k] = 0; st.good[k]++; } else { st.fail[k]++; st.good[k] = 0; }
    if (st.fail[k] >= 2) {
      if (!st.down[k]) st.down[k] = now - MIN;
      items.push(item("pulse", `pulse|${k}_down`, `${test ? "[TEST] " : ""}${NAMES[k]} is not answering`,
        { t: now, status: c.status, ms: c.ms, err: c.err || null, misses: st.fail[k] }));
    }
  }

  let d = null;
  if (db.ok) {
    d = db.data;
    processCron(st, d, now, items);
    for (const f of (d.net?.fails || []).slice(0, 20)) {
      const cls = f.timed_out ? "timeout" : f.status ? String(f.status) : "error";
      items.push(item("net", `db|pg_net|${cls}`, `Calls made by the database are failing (${cls})`, { t: now, status: f.status, timed_out: f.timed_out, err: scrub(f.err || "", 200) }));
    }
    if (d.net?.cursor != null) st.net_cursor = d.net.cursor;
    if (d.now) st.issues_since = d.now;

    // Hard limits that need no history.
    streak(st, "conns", d.max_conn > 0 && d.conns >= 0.85 * d.max_conn, 3, () =>
      items.push(item("pulse", "pulse|conns_high", "Database connections are nearly used up", { t: now, conns: d.conns, max: d.max_conn }, { severity: "high" })));
    streak(st, "longq", d.longest_s > 180, 2, () =>
      items.push(item("pulse", "pulse|long_query", "A database query has been running for minutes", { t: now, seconds: d.longest_s, query: scrub(d.longest_q || "", 200) }, { severity: "high" })));
    streak(st, "dbslow", db.ms > 3000, 3, () =>
      items.push(item("pulse", "pulse|db_slow", "The database is answering slowly", { t: now, ms: db.ms }, { severity: "high" })));
    const prev = st.counters;
    if (prev && d.dead > prev.dead) items.push(item("net", "db|deadlocks", "Database deadlocks", { t: now, new: d.dead - prev.dead }, { n: d.dead - prev.dead }));
  }

  // --- per-minute changes of the counters the database keeps anyway ---
  const delta = { signups: null, trades: null, views: null };
  if (d) {
    const cur = { dead: d.dead, hit: d.hit, read: d.read, ...d.ins };
    const prev = st.counters;
    if (prev) for (const k of Object.keys(delta)) {
      const x = cur[k] - prev[k];
      delta[k] = Number.isFinite(x) && x >= 0 ? x : null;   // negative = counters were reset
    }
    st.counters = cur;
    st.total_views = (st.total_views || 0) + (delta.views || 0);
  }
  st.ring.push([minute, delta.signups, delta.trades, delta.views]);
  if (st.ring.length > 180) st.ring = st.ring.slice(-180);

  // --- hourly figures and "far from usual" ---
  const hour = Math.floor(now / HOUR);
  if (!st.acc || st.acc.hour !== hour) {
    if (st.acc) await closeHour(env, deps, st, st.acc, items);
    st.acc = { hour, n: 0, signups: 0, trades: 0, views: 0, db_ms: 0, site_ms: 0, api_ms: 0, conns: 0, okn: 0, incident: 0 };
  }
  const a = st.acc;
  a.n++;
  for (const k of ["signups", "trades", "views"]) a[k] += delta[k] || 0;
  if (site.ok && api.ok && db.ok) { a.okn++; a.db_ms += db.ms; a.site_ms += site.ms; a.api_ms += api.ms; a.conns = Math.max(a.conns, d.conns || 0); }
  if (Object.keys(st.down).length) a.incident = 1;
  if (db.ok && minute % 10 === 3) await silentCheck(env, st, now, items);

  // --- error reporting itself: an hourly test report must arrive ---
  const mm = new Date(now).getUTCMinutes();
  if (mm === 7 && !test) {
    st.canary_sent = now;
    await Promise.all([
      probe(deps, `${env.SITE_URL}/api/ai?op=ops-canary`, { Authorization: `Bearer ${env.OPS_SECRET}` }),
      probe(deps, `${env.SITE_URL}/api/health`, { "X-Ops-Canary": env.OPS_SECRET }),
    ]);
  }
  if (mm === 12 && st.canary_sent && now - st.canary_sent < 10 * MIN) {
    for (const src of ["js", "py"]) {
      const c = await kvGet(env, `canary:${src}`);
      const lost = !c || c.at < st.canary_sent - MIN;
      streak(st, `canary_${src}`, lost && site.ok && api.ok, 2, () =>
        items.push(item("pulse", `pulse|canary_${src}`, `Error reporting from the ${src === "js" ? "JS" : "Python"} API is not arriving`, { t: now, last: c?.at || null }, { severity: "high" })));
    }
  }

  // --- problems found by this pulse go through the same intake as errors ---
  if (items.length) await record(env, deps, items, { noMail: !db.ok });

  // --- recoveries ---
  for (const k of Object.keys(st.down)) {
    if (st.good[k] >= 3) {
      const mins = Math.round((now - st.down[k]) / MIN) - 3;
      await send(env, deps, "ops_issue_note", { fp: await fingerprint(`pulse|${k}_down`), event: "recovered", note: `${NAMES[k]} is answering again after about ${Math.max(mins, 1)} minute(s).` });
      delete st.down[k];
    }
  }
  // The database path is dead: tell the owner directly, once per outage, and
  // again when it is over.
  if (st.fail.db === 2 || (st.fail.site === 2 && !db.ok) || (st.fail.api === 2 && !db.ok)) {
    await deps.mail(`${test ? "[TEST] " : ""}StockSaathi outage: ${["site", "api", "db"].filter((k) => st.fail[k] >= 2).map((k) => NAMES[k].toLowerCase()).join(" and ")} not answering`,
      `Two checks in a row failed at ${new Date(now).toISOString()}.\n\nWebsite: ${site.ok ? "ok" : "FAILED"} (${site.status}, ${site.ms} ms)\nAPI: ${api.ok ? "ok" : "FAILED"} (${api.status}, ${api.ms} ms)\nDatabase: ${db.ok ? "ok" : "FAILED"} (${db.status}, ${db.ms} ms)\n\nSent by the outside watcher because the normal alert path needs the database.`, { force: true });
    st.mailed_down = now;
  }
  if (st.mailed_down && db.ok && site.ok && api.ok && st.good.db >= 3 && st.good.site >= 3 && st.good.api >= 3) {
    await deps.mail("StockSaathi recovered", `Website, API and database are answering again (${new Date(now).toISOString()}). Down for about ${Math.round((now - st.mailed_down) / MIN)} minute(s).`, { force: true });
    st.mailed_down = 0;
  }

  if (db.ok) {
    if (d.issues?.length) await applyIssueChanges(env, deps, d.issues);
    await judgeWatches(env, deps, st, d.watches || [], { site, api, db });
    await flushOutbox(env, deps);
    await syncCounts(env, deps);
    if (minute % 5 === 0) await learnDeploys(env, deps, st, now);
  }
  if (mm === 35 && new Date(now).getUTCHours() === 20) await nightly(env, deps, st, now);
  if (st.learning_until && now >= st.learning_until && !st.learning_done && db.ok) await baselineReview(env, deps, st);

  const row = d ? { c: d.conns, a: d.active, lq: d.longest_s, s: delta.signups, tr: delta.trades, v: delta.views } : {};
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO pulse (t, site, site_ms, api, api_ms, db, db_ms, d) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(minute * MIN, site.ok ? 1 : 0, site.ms, api.ok ? 1 : 0, api.ms, db.ok ? 1 : 0, db.ms, JSON.stringify(row)),
    kvPut(env, "state", st, now),
  ]);
  return { site: site.ok, api: api.ok, db: db.ok, items: items.length };
}

function streak(st, key, bad, need, fire) {
  if (!bad) { st.streak[key] = 0; return; }
  st.streak[key] = (st.streak[key] || 0) + 1;
  if (st.streak[key] >= need) fire();
}

// Sends now, or queues for the next minute the database answers.
async function send(env, deps, rpc, body) {
  const r = await deps.rpc(rpc, body);
  if (r.ok && r.data?.ok !== false) return r;
  await env.DB.prepare("INSERT INTO outbox (rpc, body, created) VALUES (?1, ?2, ?3)").bind(rpc, JSON.stringify(body), deps.now()).run();
  return r;
}

function processCron(st, d, now, items) {
  const cron = d.cron;
  if (!cron) return;
  const jobs = new Map((cron.jobs || []).map((j) => [j.id, j]));
  for (const r of cron.runs || []) {
    const j = jobs.get(r.job);
    const name = j?.name || `job ${r.job}`;
    const start = Date.parse(r.start) || now;
    if (!st.cron_last[r.job] || start > st.cron_last[r.job]) st.cron_last[r.job] = start;
    if (r.status === "failed") {
      const c = j ? parseCron(j.schedule) : null;
      const msg = scrub(String(r.msg || "").split("\n")[0], 200);
      items.push(item(c?.everyMinute ? "cron_failed_minutely" : "cron_failed", `cron|${name}|failed|${msg.replace(/\d+/g, "N").slice(0, 80)}`,
        `Scheduled job ${name} failed`, { t: start, job: name, schedule: j?.schedule, msg }, { route: name }));
    }
  }
  // A job still running did start on time.
  for (const r of cron.running || []) {
    const start = Date.parse(r.start);
    if (start && (!st.cron_last[r.job] || start > st.cron_last[r.job])) st.cron_last[r.job] = start;
  }
  if (cron.cursor != null) st.cron_cursor = cron.cursor;
  for (const c of cron.changed || []) {
    if (c.what === "deactivated" || c.what === "removed") {
      items.push(item("cron_missed", `cron|${c.job}|${c.what}`, `Scheduled job ${c.job} was ${c.what === "removed" ? "removed" : "switched off"}`, { t: now, ...c }, { route: c.job }));
    }
  }
  // Did every active job run when it should have? (every 5th minute)
  if (Math.floor(now / MIN) % 5 !== 1) return;
  for (const j of cron.jobs || []) {
    if (!j.active) continue;
    const c = parseCron(j.schedule);
    if (!c) continue;
    const due = prevRun(c, now - 4 * MIN);
    if (due == null || due <= (st.track_since || now) + MIN) continue;
    const last = st.cron_last[j.id] || 0;
    if (last >= due - 30_000) continue;
    items.push(item("cron_missed", `cron|${j.name}|missed`, `Scheduled job ${j.name} did not run`,
      { t: now, job: j.name, schedule: j.schedule, due: new Date(due).toISOString(), last_run: last ? new Date(last).toISOString() : null }, { route: j.name }));
  }
}

async function closeHour(env, deps, st, a, items) {
  const set = [];
  const put = (vital, v) => { if (Number.isFinite(v)) set.push(env.DB.prepare("INSERT OR REPLACE INTO vital_hour (vital, hour, v, incident) VALUES (?1, ?2, ?3, ?4)").bind(vital, a.hour, v, a.incident ? 1 : 0)); };
  const complete = a.n >= 50;      // a mostly-observed hour; partial hours would look like drops
  const vals = {};
  if (complete) { vals.signups = a.signups; vals.trades = a.trades; vals.views = a.views; }
  if (a.okn >= 10) { vals.db_ms = a.db_ms / a.okn; vals.site_ms = a.site_ms / a.okn; vals.api_ms = a.api_ms / a.okn; vals.conns = a.conns; }
  const t = await env.DB.prepare("SELECT SUM(ok) ok, SUM(err) err FROM tally WHERE hour = ?1").bind(a.hour).first();
  if (t && t.ok + t.err >= 200) vals.err_share = t.err / (t.ok + t.err);
  for (const [k, v] of Object.entries(vals)) put(k, v);
  if (set.length) await env.DB.batch(set);
  if (a.incident) return;

  const hourMs = a.hour * HOUR;
  for (const vital of Object.keys(vals)) {
    const dir = LOW_VITALS.includes(vital) ? "low" : "high";
    if (vital === "trades" && !marketOpen(hourMs + 30 * MIN, isNseTradingDay)) continue;
    const base = await usual(env, vital, a.hour);
    const off = farOff(vals[vital], base, dir, vital === "err_share" ? 0.02 : vital.endsWith("_ms") ? 400 : 0);
    const key = `vital_${vital}`;
    const need = vital === "signups" && !farOff(vals.views, await usual(env, "views", a.hour), "low") ? 1 : 2;
    streak(st, key, off, need, () => items.push(item("vital", `vital|${vital}|${dir}`,
      dir === "low" ? `${label(vital)} far below usual for this hour` : `${label(vital)} far above usual for this hour`,
      { t: hourMs, value: round(vals[vital]), usual: round(base.med), spread: round(base.mad), hours_compared: base.n, views_this_hour: vals.views ?? null })));
  }
}
const label = (v) => ({ signups: "Sign-ups", trades: "Trades", views: "Page activity", db_ms: "Database answer time", site_ms: "Website answer time", api_ms: "API answer time", err_share: "Share of failed API calls", conns: "Database connections" }[v] || v);
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

// Usual value for this hour: the same hour of the week in earlier weeks; until
// three of those exist, the same hour on earlier days of the same kind
// (trading day or not). Hours inside an incident never count.
async function usual(env, vital, hour) {
  const weeks = [1, 2, 3, 4, 5, 6, 7, 8].map((w) => hour - w * 168);
  const days = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13].map((dd) => hour - dd * 24);
  const all = [...weeks, ...days];
  const r = await env.DB.prepare(`SELECT hour, v FROM vital_hour WHERE vital = ?1 AND incident = 0 AND hour IN (${all.join(",")})`).bind(vital).all();
  const by = new Map((r.results || []).map((x) => [x.hour, x.v]));
  const wk = weeks.filter((h) => by.has(h)).map((h) => by.get(h));
  if (wk.length >= 3) return baseline(wk);
  const cls = (h) => { const ms = h * HOUR + 30 * MIN; const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(ms + 330 * MIN).getUTCDay()]; return isNseTradingDay(istDay(ms), wd); };
  const mine = cls(hour);
  return baseline([...wk, ...days.filter((h) => by.has(h) && cls(h) === mine).map((h) => by.get(h))]);
}

// "Nothing at all" check, every 10 minutes: zero sign-ups (or zero trades in
// market hours) in a window where the usual numbers say several were certain.
async function silentCheck(env, st, now, items) {
  const hour = Math.floor(now / HOUR);
  for (const [vital, col] of [["signups", 1], ["trades", 2]]) {
    if (vital === "trades" && !(marketOpen(now, isNseTradingDay) && marketOpen(now - 60 * MIN, isNseTradingDay))) continue;
    const base = await usual(env, vital, hour);
    if (!base) continue;
    for (const w of [30, 60, 120, 180]) {
      if (vital === "trades" && w > 60) break;
      const win = st.ring.filter((r) => r[0] > Math.floor(now / MIN) - w);
      if (win.length < w * 0.9 || win.some((r) => r[col] == null)) continue;
      const seen = win.reduce((s, r) => s + r[col], 0);
      const viewsSeen = win.reduce((s, r) => s + (r[3] || 0), 0);
      if (silentTooLong(seen, (base.med * w) / 60) && viewsSeen > 0) {
        items.push(item("vital", `vital|${vital}|zero`, vital === "signups" ? "Nobody is getting through sign-up" : "No trades are going through",
          { t: now, window_min: w, seen: 0, usual_per_hour: round(base.med), site_activity_in_window: viewsSeen }, { severity: "critical" }));
        break;
      }
    }
  }
}

// Fix verification. The fixer wrote down what it expected before the change;
// the verdict comes from here, from counts it cannot touch.
async function judgeWatches(env, deps, st, watches, cur) {
  const now = deps.now();
  const live = new Set();
  for (const w of watches.slice(0, 10)) {
    const id = String(w.attempt_id);
    live.add(id);
    const liveAt = Date.parse(w.live_at);
    if (!Number.isFinite(liveAt)) continue;
    const age = now - liveAt;
    const fps = (Array.isArray(w.expected?.quiet_fps) && w.expected.quiet_fps.length ? w.expected.quiet_fps : [w.fp]).filter(Boolean).slice(0, 10);
    const s = (st.watch[id] ||= { stage: "window" });

    if (s.stage === "window") {
      if (age < 3 * MIN) continue;
      const b = await windowStats(env, liveAt, now);
      const a = await windowStats(env, liveAt - 10 * MIN, liveAt);
      b.newCrashes = (await env.DB.prepare("SELECT COUNT(*) n FROM sig WHERE kind = 'exc' AND first_seen >= ?1 AND hits >= 3").bind(liveAt).first())?.n || 0;
      b.down = !cur.site.ok || !cur.api.ok || !cur.db.ok;
      const worse = watchWindow(a, b);
      if (worse.length) {
        await send(env, deps, "ops_attempt_verdict", { attempt_id: w.attempt_id, verdict: "made_worse", after: { ...b, at: now }, note: worse.join("; ") });
        s.stage = "done";
        continue;
      }
      if (age >= 10 * MIN) {
        const snap = await sigTotals(env, fps);
        s.stage = "quiet"; s.hits0 = snap.hits; s.views0 = st.total_views || 0; s.t0 = now; s.checked = now;
        await send(env, deps, "ops_attempt_verdict", { attempt_id: w.attempt_id, verdict: null, after: { ...b, at: now }, note: "watch window passed: no worse than before" });
      }
      continue;
    }
    if (s.stage === "quiet" && now - (s.checked || 0) >= 15 * MIN) {
      s.checked = now;
      const snap = await sigTotals(env, fps);
      const viewsBefore = (await env.DB.prepare("SELECT SUM(v) s FROM vital_hour WHERE vital = 'views' AND hour >= ?1 AND hour <= ?2")
        .bind(Math.floor(snap.first / HOUR), Math.floor(liveAt / HOUR)).first())?.s || 0;
      const v = fixVerdict(
        { hits: Math.max(s.hits0, 1), firstSeen: snap.first, lastSeen: Math.min(snap.last0 ?? liveAt, liveAt), activity: viewsBefore },
        { ms: now - s.t0, hits: snap.hits - s.hits0, activity: (st.total_views || 0) - s.views0 },
      );
      if (v.verdict) {
        await send(env, deps, "ops_attempt_verdict", { attempt_id: w.attempt_id, verdict: v.verdict, after: { hits_since: snap.hits - s.hits0, hours: Math.round((now - s.t0) / HOUR), at: now }, note: v.why });
        s.stage = "done";
      }
    }
  }
  for (const id of Object.keys(st.watch)) if (!live.has(id)) delete st.watch[id];
}

async function windowStats(env, from, to) {
  const p = await env.DB.prepare("SELECT AVG(site_ms) s, AVG(db_ms) d, COUNT(*) n FROM pulse WHERE t >= ?1 AND t < ?2 AND site = 1 AND db = 1").bind(from, to).first();
  const e = await env.DB.prepare("SELECT COALESCE(SUM(CAST(v AS INTEGER)), 0) n FROM kv WHERE k >= ?1 AND k < ?2")
    .bind(`m:${Math.floor(from / MIN)}`, `m:${Math.floor(to / MIN)}`).first();
  const mins = Math.max((to - from) / MIN, 1);
  return { errRate: (e?.n || 0) / mins, siteMs: p?.s || 0, dbMs: p?.d || 0 };
}
async function sigTotals(env, fps) {
  if (!fps.length) return { hits: 0, first: Date.now(), last0: null };
  const marks = fps.map((_, i) => `?${i + 1}`).join(",");
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(hits), 0) hits, MIN(first_seen) first, MAX(last_seen) last FROM sig WHERE fp IN (${marks})`).bind(...fps).first();
  return { hits: r?.hits || 0, first: r?.first || Date.now(), last0: r?.last || null };
}

// Every build that reported in becomes an entry in the change ledger.
async function learnDeploys(env, deps, st, now) {
  const r = await env.DB.prepare("SELECT k, v, t FROM kv WHERE k LIKE 'deploy:%' AND v NOT LIKE '%\"told\"%' LIMIT 5").all();
  for (const row of r.results || []) {
    const ref = row.k.slice(7);
    const reply = await deps.rpc("ops_change_note", { kind: "deploy", ref, at: new Date(row.t).toISOString(), summary: "New build first seen serving traffic", actor: "collector" });
    if (reply.ok) await kvPut(env, row.k, { told: 1 }, row.t).run();
  }
}

async function nightly(env, deps, st, now) {
  const day = (back) => istDay(now - back * 86400_000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pulse WHERE t < ?1").bind(now - 14 * 86400_000),
    env.DB.prepare("DELETE FROM sig_who WHERE day < ?1").bind(day(3)),
    env.DB.prepare("DELETE FROM sig_day WHERE day < ?1").bind(day(60)),
    env.DB.prepare("DELETE FROM tally WHERE hour < ?1").bind(Math.floor(now / HOUR) - 24 * 30),
    env.DB.prepare("DELETE FROM vital_hour WHERE hour < ?1").bind(Math.floor(now / HOUR) - 24 * 70),
    env.DB.prepare("DELETE FROM kv WHERE (k LIKE 'm:%' OR k LIKE 'n:%') AND t < ?1").bind(now - 3 * 86400_000),
    env.DB.prepare("DELETE FROM kv WHERE k LIKE 'deploy:%' AND t < ?1").bind(now - 30 * 86400_000),
    env.DB.prepare("UPDATE sig SET first_samples = '[]', last_samples = '[]' WHERE last_seen < ?1 AND state IN ('watch', 'baseline', 'fixed', 'ignored', 'alias')").bind(now - 30 * 86400_000),
    env.DB.prepare("UPDATE sig SET peak_day = COALESCE((SELECT MAX(hits) FROM sig_day WHERE sig_day.fp = sig.fp AND day >= ?1 AND day < ?2), 0) WHERE last_seen > ?3")
      .bind(day(14), day(0), now - 15 * 86400_000),
  ]);
  // Two-way copy, so memory survives either side being down.
  const memo = await deps.rpc("ops_memo_export", {});
  if (memo.ok && memo.data?.ok) {
    const set = [];
    for (const kind of ["cases", "recipes"]) for (const x of (memo.data[kind] || []).slice(0, 300)) {
      set.push(env.DB.prepare("INSERT OR REPLACE INTO memo (kind, id, data, t) VALUES (?1, ?2, ?3, ?4)").bind(kind, x.id, JSON.stringify(x), now));
    }
    for (let i = 0; i < set.length; i += 50) await env.DB.batch(set.slice(i, i + 50));
  }
  const b = await env.DB.prepare("SELECT vital, COUNT(*) n, AVG(v) mean, MIN(v) lo, MAX(v) hi FROM vital_hour WHERE incident = 0 AND hour >= ?1 GROUP BY vital")
    .bind(Math.floor(now / HOUR) - 24 * 28).all();
  await deps.rpc("ops_baseline_put", { at: new Date(now).toISOString(), vitals: b.results || [] });
}

// End of the first day: everything that already existed is handed over as one
// review item instead of dozens of alerts.
async function baselineReview(env, deps, st) {
  const r = await env.DB.prepare("SELECT fp, title, kind, hits, people FROM sig WHERE state = 'baseline' ORDER BY people DESC, hits DESC LIMIT 60").all();
  st.learning_done = 1;
  if (!(r.results || []).length) return;
  await record(env, deps, [item("pulse", "pulse|baseline_review", `First-day review: ${r.results.length} existing error patterns to sort`,
    { t: deps.now(), patterns: r.results }, { severity: "low", extra: { how: "Each pattern existed before the watcher started. Sort each into: real bug (open it), expected (ignore with a reason), or same as another (merge)." } })], {});
}

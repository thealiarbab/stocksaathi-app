// Reflexes: first aid by plain code, for the minutes when something serious is
// happening and the agent cannot start (the start call failed, Claude's limit
// is full, or the owner is working and the agent is held back).
//
// TELL-ONLY. Nothing in this file changes anything on the site or in the
// database. A reflex writes down "I would have done X because Y", mails that
// to the owner, and looks again five minutes later to see whether the trouble
// stopped by itself. There is no switch, setting or stored value that makes a
// reflex act: MODE is a constant. Going live is a code change the owner asks
// for, after 14 clean days and a correct replay of past outages
// (test/reflex.test.mjs).
//
// A reflex never starts the agent.
//
// The rules at the top are pure (facts in, words out) so the tests can feed
// them the timeline of a past outage.

import { kvGet, kvPut } from "./core.js";

export const MODE = "tell_only";
export const CLEAN_DAYS_NEEDED = 14;

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;
const DEPLOY_WINDOW = 15 * MIN;
const LONG_JOB_S = 120, LONG_JOB_TIMES = 4, HOG_QUERY_S = 120, FLOOD_TIMES = 2;

// The only database jobs a reflex may ever name for a pause: reports, caches
// and tidy-up. Anything that fills orders, takes snapshots of portfolios,
// sends messages or guards the site is absent on purpose.
export const PAUSABLE = new Set([
  "admin-growth-cache", "admin-overview-cache", "behaviour-cache", "signup-funnel-cache", "signup-stats-cache",
  "user-events-rollup", "web-events-rollup", "web-events-prune", "experiment-daily", "ai-watch-daily",
  "achievements-sweep", "achievements-drafts", "ops-senses-nightly", "ops-consolidate",
]);
// Queries run by the database's own services (replication, live updates,
// connection pooling) are never a reflex's to cancel.
const SYSTEM_USER = /^(supabase_|pgbouncer|pg_|replic)/i;

const KIND_WORD = { rollback: "put the previous build back", pause_job: "pause a database job", cancel_query: "cancel one database query", saved_answers: "serve saved AI answers" };

// Why the agent cannot start for this issue right now, or null when it can
// (or already has). g is a judged row from the gate, v the judge's decision.
export function cannotStart(g, v, now) {
  if (v?.act === "hold" && v.why === "owner_busy") return "you are working in Claude, so the agent is held back";
  if (v?.act === "hold" && v.why === "limit_full") return "Claude's limit is full";
  if (g.why === "nowake" && now < (g.nextAt || 0)) return "the call that starts the agent was refused";
  if (g.state === "woken" && g.wokenAt && !g.pickedAt && now - g.wokenAt >= 15 * MIN) return "the agent was started but nothing picked the work up";
  return null;
}

export function dbSlow(db) {
  if (!db) return false;
  return db.ok === false || (db.ms || 0) >= 3000 || (db.longest_s || 0) >= 180 || (db.max_conn > 0 && (db.conns || 0) >= 0.85 * db.max_conn);
}

// 1. The problem began within 15 minutes of a build going live.
//    deploys: [{ sha, t }] in any order; t = when the build was first seen.
export function rollbackRule({ issue, deploys }) {
  const list = (deploys || []).filter((d) => d && d.sha && Number.isFinite(d.t)).sort((a, b) => a.t - b.t);
  let at = -1;
  for (let i = 0; i < list.length; i++) if (list[i].t <= issue.opened + 2 * MIN) at = i;
  if (at < 1) return null;
  const d = list[at], prev = list[at - 1];
  const gap = issue.opened - d.t;
  if (gap > DEPLOY_WINDOW) return null;
  const mins = Math.max(0, Math.round(gap / MIN));
  return {
    kind: "rollback", target: prev.sha,
    would: `put the previous build (${String(prev.sha).slice(0, 7)}) back in place of ${String(d.sha).slice(0, 7)}`,
    because: `the problem began ${mins} minute(s) after build ${String(d.sha).slice(0, 7)} went live`,
  };
}

// 2. A database job runs far too long while the database is slow.
//    facts.jobs: [{ name, secs, usual_s, pid }]
export function pauseJobRule({ db, facts }) {
  if (!dbSlow(db) || !facts?.jobs?.length) return { tell: null, notes: [] };
  const long = facts.jobs
    .filter((j) => j.secs >= Math.max(LONG_JOB_S, LONG_JOB_TIMES * (j.usual_s || 0)))
    .sort((a, b) => b.secs - a.secs);
  const notes = long.filter((j) => !PAUSABLE.has(j.name)).map((j) => `the job "${j.name}" has run ${j.secs} s, but it is not on the list of jobs a reflex may pause`);
  const j = long.find((x) => PAUSABLE.has(x.name));
  if (!j) return { tell: null, notes };
  return { notes, tell: {
    kind: "pause_job", target: j.name,
    would: `pause the database job "${j.name}" and stop its current run`,
    because: `it has been running ${j.secs} s (its usual run takes ${j.usual_s ? `${j.usual_s} s` : "an unknown time"}) while the database is slow`,
  } };
}

// 3. One query hogs the database. Exactly one, the longest, and never a job
//    (rule 2 owns those) or one of the database's own services.
//    facts.queries: [{ pid, user, secs, is_cron }]
export function cancelQueryRule({ db, facts }) {
  if (!dbSlow(db) || !facts?.queries?.length) return { tell: null, notes: [] };
  const hogs = facts.queries.filter((q) => q.secs >= HOG_QUERY_S && !q.is_cron).sort((a, b) => b.secs - a.secs);
  const notes = hogs.filter((q) => SYSTEM_USER.test(q.user || "")).slice(0, 2)
    .map((q) => `a query by the database's own service "${q.user}" has run ${q.secs} s: a reflex never cancels those`);
  const q = hogs.find((x) => !SYSTEM_USER.test(x.user || ""));
  if (!q) return { tell: null, notes };
  return { notes, tell: {
    kind: "cancel_query", target: String(q.pid),
    would: `cancel one database query (process ${q.pid}, started by "${q.user || "unknown"}")`,
    because: `it has been running ${q.secs} s while the database is slow`,
  } };
}

// 4. AI cost flood: far more AI use than the busiest quarter-hour of the last
//    four weeks, and saved answers are not already switched on.
//    facts.ai: { tok_15m, base_15m, lockdown }
export function savedAnswersRule({ facts }) {
  const a = facts?.ai;
  if (!a || a.lockdown || !(a.base_15m > 0) || !(a.tok_15m >= FLOOD_TIMES * a.base_15m)) return null;
  return {
    kind: "saved_answers", target: "30 min",
    would: "serve saved AI answers only, for 30 minutes (no new paid AI calls)",
    because: `AI use in the last 15 minutes is ${Math.round((a.tok_15m / a.base_15m) * 10) / 10} times the busiest 15 minutes of the last four weeks`,
  };
}

// All four rules for one serious issue the agent cannot start for.
//   facts === null means the database could not be asked.
export function consider({ issue, deploys, db, facts }) {
  const tells = [], notes = [];
  const r = rollbackRule({ issue, deploys });
  if (r) tells.push(r);
  if (facts) {
    const p = pauseJobRule({ db, facts }); if (p.tell) tells.push(p.tell); notes.push(...p.notes);
    const c = cancelQueryRule({ db, facts }); if (c.tell) tells.push(c.tell); notes.push(...c.notes);
    const s = savedAnswersRule({ facts }); if (s) tells.push(s);
  } else if (db && db.ok === false) {
    notes.push("the database did not answer, so its jobs and queries could not be looked at");
  }
  return { tells, notes };
}

// ---- the runner: gathers the facts, writes the rows, tells the owner ----

async function since(env, now) {
  let s = await kvGet(env, "reflex_since");
  if (!s?.at) { s = { at: now }; await kvPut(env, "reflex_since", s, now).run(); }
  return s.at;
}

export async function cleanDays(env, now) {
  const start = await since(env, now);
  const bad = await env.DB.prepare("SELECT MAX(COALESCE(verdict_at, at)) t FROM reflex WHERE verdict IN ('wrong', 'unneeded')").first();
  return Math.max(0, Math.floor((now - Math.max(start, bad?.t || 0)) / DAY));
}

// Five minutes after each "I would have": did the trouble stop by itself?
async function followUp(env, now) {
  const due = await env.DB.prepare(
    "SELECT r.id, r.at, s.last_seen FROM reflex r LEFT JOIN sig s ON s.fp = r.fp WHERE r.after IS NULL AND r.kind != 'none' AND r.at <= ?1 LIMIT 10",
  ).bind(now - 5 * MIN).all();
  const set = (due.results || []).map((r) => {
    const still = (r.last_seen || 0) > r.at + 2 * MIN;
    // Stopped by itself: the action would not have been needed. That is not
    // a clean call, so it restarts the clean-days count.
    return env.DB.prepare("UPDATE reflex SET after = ?1, after_at = ?2, verdict = COALESCE(verdict, ?3), verdict_at = COALESCE(verdict_at, ?4) WHERE id = ?5")
      .bind(still ? "still" : "eased", now, still ? null : "unneeded", still ? null : now, r.id);
  });
  if (set.length) await env.DB.batch(set);
}

// cands: [{ g (gate row), blocked (words) }], db: this minute's database pulse.
export async function runReflexes(env, deps, cands, db) {
  const now = deps.now();
  await followUp(env, now);
  if (!cands.length) return { told: 0 };
  // The facts call reads inside a database that may be struggling: at most
  // once every ten minutes.
  const last = await kvGet(env, "reflex_run");
  if (last?.at && now - last.at < 10 * MIN) return { told: 0, waited: true };
  await kvPut(env, "reflex_run", { at: now }, now).run();

  const dep = await env.DB.prepare("SELECT k, t FROM kv WHERE k LIKE 'deploy:%' AND t >= ?1 ORDER BY t").bind(now - 3 * DAY).all();
  const deploys = (dep.results || []).map((x) => ({ sha: x.k.slice(7), t: x.t }));
  const pulse = db ? { ok: db.ok, ms: db.ms, conns: db.data?.conns, max_conn: db.data?.max_conn, longest_s: db.data?.longest_s } : null;
  let facts = null;
  if (pulse?.ok) {
    const r = await deps.rpc("ops_reflex_facts", {});
    if (r.ok && r.data?.ok) facts = r.data;
  }

  const fresh = [], set = [];
  for (const { g, blocked } of cands.slice(0, 3)) {
    const seen = await env.DB.prepare("SELECT kind FROM reflex WHERE fp = ?1 AND at >= ?2").bind(g.fp, now - 6 * HOUR).all();
    const had = new Set((seen.results || []).map((x) => x.kind));
    const { tells, notes } = consider({ issue: { opened: g.opened, area: g.area }, deploys, db: pulse, facts });
    const add = (kind, would, because, target, note) => set.push(env.DB.prepare(
      "INSERT INTO reflex (at, fp, issue_id, kind, why_blocked, would, because, target, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    ).bind(now, g.fp, g.id || null, kind, blocked, would, because, target, note));
    const mine = tells.filter((t) => !had.has(t.kind));
    for (const t of mine) { add(t.kind, t.would, t.because, t.target, notes.join("; ").slice(0, 500) || null); fresh.push({ g, blocked, t }); }
    // Looked and found nothing it is allowed to do: written down once, so the
    // owner can see the reflexes were awake.
    if (!tells.length && !had.has("none")) add("none", null, null, null, notes.join("; ").slice(0, 500) || "none of the four reflexes fits what was seen");
  }
  if (set.length) await env.DB.batch(set);
  if (fresh.length) {
    const days = await cleanDays(env, now);
    await deps.mail(`StockSaathi ops reflex (tell-only): I would have ${fresh.length === 1 ? KIND_WORD[fresh[0].t.kind] : `done ${fresh.length} things`}`,
      [...fresh.map(({ g, blocked, t }) => `Serious issue ${g.id ? `#${g.id}` : "(no number yet)"}, and the agent cannot start: ${blocked}.\nI would have: ${t.would}.\nBecause: ${t.because}.`),
        "NOTHING WAS CHANGED. Reflexes only say what they would have done.",
        `Clean days so far: ${days} of ${CLEAN_DAYS_NEEDED}. They can only be made to act by you, after ${CLEAN_DAYS_NEEDED} clean days. If this call was wrong, say so in a Claude session ("/ops", then "reflex ... was wrong") and the count starts again.`].join("\n\n"), { force: true });
  }
  return { told: fresh.length };
}

export async function reflexView(env, now, n = 5) {
  const rows = await env.DB.prepare("SELECT id, at, issue_id, kind, why_blocked, would, because, after, verdict, note FROM reflex ORDER BY id DESC LIMIT ?1").bind(n).all();
  return {
    mode: MODE, acts_on_the_site: false, clean_days: await cleanDays(env, now), clean_days_needed: CLEAN_DAYS_NEEDED,
    since: await since(env, now),
    // The rollback reflex will need a Vercel token (wrangler secret
    // VERCEL_TOKEN) before it could ever act. Shown so nobody has to guess.
    rollback_token_set: !!env.VERCEL_TOKEN,
    last: rows.results || [],
  };
}

// The owner (or the agent's weekly review) says whether a call was right.
export async function setVerdict(env, deps, b) {
  const now = deps.now();
  const verdict = b.verdict === "wrong" ? "wrong" : b.verdict === "right" ? "right" : null;
  if (!verdict || !Number.isInteger(Number(b.id))) return { ok: false, why: "need id and verdict right|wrong" };
  const r = await env.DB.prepare("UPDATE reflex SET verdict = ?1, verdict_at = ?2, note = COALESCE(?3, note) WHERE id = ?4 AND kind != 'none'")
    .bind(verdict, now, b.note ? String(b.note).slice(0, 500) : null, Number(b.id)).run();
  if (!r?.meta?.changes) return { ok: false, why: "no such reflex record" };
  return { ok: true, verdict, clean_days: await cleanDays(env, now) };
}

// For the daily brief.
export async function reflexLines(env, now, dayStart) {
  const v = await reflexView(env, now, 8);
  const today = v.last.filter((r) => r.at >= dayStart && r.kind !== "none");
  const looked = v.last.filter((r) => r.at >= dayStart && r.kind === "none").length;
  const head = `Reflexes (tell-only, they change nothing): ${v.clean_days} clean day(s) of ${v.clean_days_needed}.`;
  if (!today.length) return `${head} ${looked ? `Looked ${looked} time(s) today while the agent could not start; none of the four fitted.` : "Not needed today."}`;
  return `${head}\n${today.map((r) => `  ${r.issue_id ? `#${r.issue_id}` : "issue"}: would have ${r.would}, because ${r.because}. Five minutes later: ${r.after === "eased" ? "it had stopped by itself (not needed)" : r.after === "still" ? "still happening" : "not checked yet"}.`).join("\n")}`;
}

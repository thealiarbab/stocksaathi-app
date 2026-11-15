import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeWorld } from "./d1.mjs";
import { kvPut, kvGet } from "../src/core.js";
import { runPulse } from "../src/pulse.js";
import { setActive, setPaused } from "../src/gaterun.js";
import * as reflex from "../src/reflex.js";
import { MODE, CLEAN_DAYS_NEEDED, PAUSABLE, cannotStart, dbSlow, rollbackRule, pauseJobRule, cancelQueryRule, savedAnswersRule, consider, runReflexes, cleanDays, reflexView, setVerdict, reflexLines } from "../src/reflex.js";
import { ASK_ID, askLink, ask } from "../src/ask.js";
import { page } from "../src/page.js";
import { growthLines } from "../src/brief.js";
import { TUNE, tuned, signupTruth } from "../src/senses.js";

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;
const IST = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - 330 * MIN;
const SLOW = { ok: true, ms: 4200, conns: 55, max_conn: 60, longest_s: 240 };
const FINE = { ok: true, ms: 60, conns: 12, max_conn: 60, longest_s: 1 };

// ---------- the four rules ----------

test("when the agent cannot start, and when it can", () => {
  const now = 1_000_000_000_000;
  const g = { state: "hold", why: "owner_busy" };
  assert.match(cannotStart(g, { act: "hold", why: "owner_busy" }, now), /you are working in Claude/);
  assert.match(cannotStart(g, { act: "hold", why: "limit_full" }, now), /limit is full/);
  assert.match(cannotStart({ state: "new", why: "nowake", nextAt: now + 5 * MIN }, undefined, now), /refused/);
  assert.equal(cannotStart({ state: "new", why: "nowake", nextAt: now - MIN }, undefined, now), null, "the retry time has come");
  assert.match(cannotStart({ state: "woken", wokenAt: now - 16 * MIN, pickedAt: null }, { act: "idle" }, now), /nothing picked the work up/);
  assert.equal(cannotStart({ state: "woken", wokenAt: now - 16 * MIN, pickedAt: now - 10 * MIN }, { act: "idle" }, now), null, "picked up");
  assert.equal(cannotStart({ state: "woken", wokenAt: now - 5 * MIN }, { act: "idle" }, now), null, "started 5 minutes ago");
  assert.equal(cannotStart({ state: "new" }, { act: "wake", why: "serious" }, now), null, "it is being started this minute");
  assert.equal(cannotStart({ state: "hold" }, { act: "hold", why: "five" }, now), null, "a small issue waiting is not a reflex's business");
});

test("slow database", () => {
  assert.equal(dbSlow(null), false);
  assert.equal(dbSlow(FINE), false);
  assert.equal(dbSlow({ ok: false }), true);
  assert.equal(dbSlow({ ok: true, ms: 3100 }), true);
  assert.equal(dbSlow({ ok: true, ms: 50, longest_s: 200 }), true);
  assert.equal(dbSlow({ ok: true, ms: 50, conns: 52, max_conn: 60 }), true);
});

test("reflex 1: put the previous build back", () => {
  const t = 1_000_000_000_000;
  const deploys = [{ sha: "aaaaaaa111", t: t - 2 * DAY }, { sha: "bbbbbbb222", t: t - 6 * MIN }];
  const r = rollbackRule({ issue: { opened: t }, deploys });
  assert.equal(r.kind, "rollback");
  assert.equal(r.target, "aaaaaaa111");
  assert.match(r.because, /6 minute\(s\) after build bbbbbbb/);
  assert.equal(rollbackRule({ issue: { opened: t }, deploys: [{ sha: "a", t: t - 2 * DAY }, { sha: "b", t: t - 16 * MIN }] }), null, "16 minutes is outside the window");
  assert.equal(rollbackRule({ issue: { opened: t }, deploys: [{ sha: "b", t: t - 6 * MIN }] }), null, "no earlier build is known to go back to");
  assert.equal(rollbackRule({ issue: { opened: t }, deploys: [{ sha: "a", t: t - 2 * DAY }, { sha: "b", t: t + 10 * MIN }] }), null, "a build after the problem did not cause it");
  assert.equal(rollbackRule({ issue: { opened: t }, deploys: [] }), null);
});

test("reflex 2: pause a job, only from the allowed list", () => {
  const jobs = [{ name: "behaviour-cache", secs: 500, usual_s: 60 }, { name: "order-matcher", secs: 900, usual_s: 2 }];
  const r = pauseJobRule({ db: SLOW, facts: { jobs } });
  assert.equal(r.tell.kind, "pause_job");
  assert.equal(r.tell.target, "behaviour-cache", "never the order matcher, although it has run longer");
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /order-matcher.*not on the list/);
  assert.equal(pauseJobRule({ db: FINE, facts: { jobs } }).tell, null, "the database is not slow");
  assert.equal(pauseJobRule({ db: SLOW, facts: { jobs: [{ name: "behaviour-cache", secs: 110, usual_s: 20 }] } }).tell, null, "under two minutes");
  assert.equal(pauseJobRule({ db: SLOW, facts: { jobs: [{ name: "behaviour-cache", secs: 200, usual_s: 90 }] } }).tell, null, "not four times its usual run");
  const only = pauseJobRule({ db: SLOW, facts: { jobs: [{ name: "portfolio-snapshot", secs: 700, usual_s: 5 }] } });
  assert.equal(only.tell, null);
  assert.equal(only.notes.length, 1);
  for (const never of ["order-matcher", "portfolio-snapshot", "order-expiry", "notify-morning", "ops-health", "ai-watch", "nav-refresh"]) assert.equal(PAUSABLE.has(never), false, never);
});

test("reflex 3: cancel one query, never a job or the database's own service", () => {
  const queries = [
    { pid: 11, user: "supabase_admin", secs: 900, is_cron: false },
    { pid: 12, user: "postgres", secs: 400, is_cron: true },
    { pid: 13, user: "authenticator", secs: 300, is_cron: false },
    { pid: 14, user: "authenticator", secs: 150, is_cron: false },
  ];
  const r = cancelQueryRule({ db: SLOW, facts: { queries } });
  assert.equal(r.tell.target, "13", "exactly one: the longest that is neither a job nor a system service");
  assert.match(r.notes[0], /supabase_admin/);
  assert.equal(cancelQueryRule({ db: FINE, facts: { queries } }).tell, null);
  assert.equal(cancelQueryRule({ db: SLOW, facts: { queries: [{ pid: 1, user: "authenticator", secs: 100 }] } }).tell, null, "under two minutes");
  assert.doesNotMatch(JSON.stringify(r), /select|update|insert/i, "no query text anywhere");
});

test("reflex 4: saved AI answers during a cost flood", () => {
  assert.equal(savedAnswersRule({ facts: { ai: { tok_15m: 900_000, base_15m: 400_000, lockdown: false } } }).kind, "saved_answers");
  assert.equal(savedAnswersRule({ facts: { ai: { tok_15m: 700_000, base_15m: 400_000, lockdown: false } } }), null, "under twice the busiest quarter-hour");
  assert.equal(savedAnswersRule({ facts: { ai: { tok_15m: 900_000, base_15m: 400_000, lockdown: true } } }), null, "already switched on by the AI watcher");
  assert.equal(savedAnswersRule({ facts: { ai: { tok_15m: 900_000, base_15m: 0 } } }), null, "no history to compare with");
  assert.equal(savedAnswersRule({ facts: {} }), null);
});

// ---------- replay of the two real outages ----------
// The timelines below are rebuilt from the owner's outage notes (what was
// running, for how long, who held the database), not from recorded data: the
// watcher did not exist yet on either day.

test("replay 25 Oct 2026, 20:32 IST: a report job drained the database", () => {
  const opened = IST(2026, 10, 25, 20, 34);
  const out = consider({
    issue: { opened, area: "core" },
    deploys: [{ sha: "d8e2bcc4aa", t: IST(2026, 10, 25, 14, 10) }, { sha: "50eec3a3bb", t: IST(2026, 10, 25, 17, 5) }],
    db: { ok: true, ms: 6800, conns: 41, max_conn: 60, longest_s: 469 },
    facts: {
      jobs: [{ name: "behaviour-cache", secs: 469, usual_s: 60, pid: 4411 }, { name: "signup-stats-cache", secs: 58, usual_s: 40, pid: 4420 }, { name: "order-matcher", secs: 31, usual_s: 2, pid: 4431 }],
      queries: [{ pid: 4411, user: "postgres", secs: 469, is_cron: true }, { pid: 5102, user: "authenticator", secs: 44, is_cron: false }],
      ai: { tok_15m: 210_000, base_15m: 640_000, lockdown: false },
    },
  });
  assert.deepEqual(out.tells.map((t) => t.kind), ["pause_job"], "one call, and it is the right one");
  assert.equal(out.tells[0].target, "behaviour-cache");
  assert.match(out.tells[0].because, /469 s.*usual run takes 60 s/);
});

test("replay 11 Nov 2026, 09:00 IST: the database was too small for market open", () => {
  // Nothing a reflex may touch was at fault: no build, no long job on the
  // list, and the slow queries belonged to the database's own live-updates
  // service. It needed the owner (a bigger database and an index). The
  // honest answer is "I would have done nothing", and that is what is checked.
  const morning = consider({
    issue: { opened: IST(2026, 11, 11, 9, 4), area: "core" },
    deploys: [{ sha: "21aede59cc", t: IST(2026, 11, 8, 22, 40) }],
    db: { ok: true, ms: 9100, conns: 58, max_conn: 60, longest_s: 25 },
    facts: {
      jobs: [{ name: "order-matcher", secs: 38, usual_s: 2, pid: 900 }, { name: "signup-stats-cache", secs: 51, usual_s: 40, pid: 901 }],
      queries: [{ pid: 700, user: "supabase_admin", secs: 25, is_cron: false }, { pid: 701, user: "supabase_admin", secs: 11, is_cron: false }, { pid: 702, user: "authenticator", secs: 19, is_cron: false }],
      ai: { tok_15m: 380_000, base_15m: 640_000, lockdown: false },
    },
  });
  assert.deepEqual(morning.tells, [], "no reflex fits");
  // 12:30 IST: the database stopped answering at all, so it could not be asked.
  const noon = consider({ issue: { opened: IST(2026, 11, 11, 9, 4), area: "core" }, deploys: [], db: { ok: false, ms: 7000 }, facts: null });
  assert.deepEqual(noon.tells, []);
  assert.match(noon.notes[0], /database did not answer/);
  // Had a long system query been there, it is named in a note, never a call.
  const sys = consider({ issue: { opened: 0 }, deploys: [], db: SLOW, facts: { jobs: [], queries: [{ pid: 700, user: "supabase_admin", secs: 300, is_cron: false }] } });
  assert.deepEqual(sys.tells, []);
  assert.match(sys.notes[0], /never cancels/);
});

// ---------- the runner ----------

const cand = (w, over = {}) => ({ g: { fp: "f".repeat(20), id: 7, opened: w.t - 3 * MIN, area: "core", ...over }, blocked: "you are working in Claude, so the agent is held back" });
const slowPulse = { ok: true, ms: 5000, status: 200, data: { conns: 50, max_conn: 60, longest_s: 300 } };
const FACTS = { ok: true, jobs: [{ name: "behaviour-cache", secs: 480, usual_s: 60, pid: 1 }], queries: [], ai: { tok_15m: 1, base_15m: 100, lockdown: false } };

test("tell-only: a record and one mail, and nothing else happens", async () => {
  const w = makeWorld();
  w.reply = (name) => (name === "ops_reflex_facts" ? FACTS : undefined);
  const r = await runReflexes(w.env, w.deps, [cand(w)], slowPulse);
  assert.equal(r.told, 1);
  const rows = (await w.env.DB.prepare("SELECT * FROM reflex").all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "pause_job");
  assert.equal(rows[0].target, "behaviour-cache");
  assert.equal(rows[0].issue_id, 7);
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0].title, /tell-only.*pause a database job/);
  assert.match(w.mails[0].body, /NOTHING WAS CHANGED/);
  assert.doesNotMatch(w.mails[0].body, /https?:\/\//, "no link of any kind in the mail");
  assert.equal(w.wakes.length, 0, "a reflex never starts the agent");
  assert.equal(w.https.length, 0);
  assert.equal(w.fetches.length, 0);
  assert.deepEqual(w.rpcs.map((x) => x.name), ["ops_reflex_facts"], "the only database call is the read of the facts");

  // The same thing is not said twice, and the database is not asked again
  // inside ten minutes.
  w.tick(3 * MIN);
  assert.equal((await runReflexes(w.env, w.deps, [cand(w)], slowPulse)).waited, true);
  w.tick(20 * MIN);
  await runReflexes(w.env, w.deps, [cand(w)], slowPulse);
  assert.equal((await w.env.DB.prepare("SELECT COUNT(*) n FROM reflex").first()).n, 1);
  assert.equal(w.mails.length, 1);
  assert.equal(w.wakes.length, 0);
});

test("nothing fits: written down once, no mail", async () => {
  const w = makeWorld();
  w.reply = (name) => (name === "ops_reflex_facts" ? { ok: true, jobs: [], queries: [], ai: null } : undefined);
  await runReflexes(w.env, w.deps, [cand(w)], slowPulse);
  w.tick(11 * MIN);
  await runReflexes(w.env, w.deps, [cand(w)], slowPulse);
  const rows = (await w.env.DB.prepare("SELECT kind, note FROM reflex").all()).results;
  assert.deepEqual(rows.map((x) => x.kind), ["none"]);
  assert.equal(w.mails.length, 0);
  // Database unreachable: it is not asked at all.
  const w2 = makeWorld();
  await runReflexes(w2.env, w2.deps, [cand(w2)], { ok: false, ms: 7000, status: 0 });
  assert.equal(w2.rpcs.length, 0);
  assert.match((await w2.env.DB.prepare("SELECT note FROM reflex").first()).note, /database did not answer/);
});

test("five minutes later, clean days, and the owner's verdict", async () => {
  const w = makeWorld();
  await kvPut(w.env, "reflex_since", { at: w.t - 20 * DAY }, w.t).run();
  assert.equal(await cleanDays(w.env, w.t), 20);
  w.reply = (name) => (name === "ops_reflex_facts" ? FACTS : undefined);
  const fp = "a".repeat(20);
  await w.env.DB.prepare("INSERT INTO sig (fp, sig, src, kind, title, state, first_seen, last_seen) VALUES (?1, 'pulse|db_slow', 'pulse', 'pulse', 'slow', 'open', ?2, ?2)").bind(fp, w.t).run();
  await runReflexes(w.env, w.deps, [cand(w, { fp })], slowPulse);
  // Still happening five minutes later: the call stands, days stay clean.
  w.tick(6 * MIN);
  await w.env.DB.prepare("UPDATE sig SET last_seen = ?1 WHERE fp = ?2").bind(w.t - MIN, fp).run();
  await runReflexes(w.env, w.deps, [], null);
  let row = await w.env.DB.prepare("SELECT after, verdict FROM reflex").first();
  assert.deepEqual([row.after, row.verdict], ["still", null]);
  assert.equal(await cleanDays(w.env, w.t), 20);
  // The owner says it was right: still clean. Wrong: the count starts again.
  assert.equal((await setVerdict(w.env, w.deps, { id: 1, verdict: "right" })).clean_days, 20);
  w.tick(2 * DAY);
  const bad = await setVerdict(w.env, w.deps, { id: 1, verdict: "wrong", note: "that job was not the cause" });
  assert.equal(bad.clean_days, 0);
  w.tick(3 * DAY);
  assert.equal(await cleanDays(w.env, w.t), 3);
  assert.equal((await setVerdict(w.env, w.deps, { id: 99, verdict: "right" })).ok, false);
  assert.equal((await setVerdict(w.env, w.deps, { id: 1, verdict: "go_live" })).ok, false);

  // A problem that stopped by itself: the action would not have been needed.
  const w2 = makeWorld();
  await kvPut(w2.env, "reflex_since", { at: w2.t - 20 * DAY }, w2.t).run();
  w2.reply = w.reply;
  await w2.env.DB.prepare("INSERT INTO sig (fp, sig, src, kind, title, state, first_seen, last_seen) VALUES (?1, 'pulse|db_slow', 'pulse', 'pulse', 'slow', 'open', ?2, ?2)").bind(fp, w2.t).run();
  await runReflexes(w2.env, w2.deps, [cand(w2, { fp })], slowPulse);
  w2.tick(6 * MIN);
  await runReflexes(w2.env, w2.deps, [], null);
  row = await w2.env.DB.prepare("SELECT after, verdict FROM reflex").first();
  assert.deepEqual([row.after, row.verdict], ["eased", "unneeded"]);
  assert.equal(await cleanDays(w2.env, w2.t), 0);
  const line = await reflexLines(w2.env, w2.t, w2.t - DAY);
  assert.match(line, /0 clean day\(s\) of 14/);
  assert.match(line, /stopped by itself/);
});

test("there is no switch: nothing stored or sent can make a reflex act", async () => {
  assert.equal(MODE, "tell_only");
  assert.equal(CLEAN_DAYS_NEEDED, 14);
  const w = makeWorld();
  // Even with 100 clean days, a token and every setting someone might try.
  await kvPut(w.env, "reflex_since", { at: w.t - 100 * DAY }, w.t).run();
  for (const k of ["reflex_mode", "reflex_live", "reflex"]) await kvPut(w.env, k, { mode: "live", live: true }, w.t).run();
  w.env.VERCEL_TOKEN = "x"; w.env.REFLEX_MODE = "live";
  w.reply = (name) => (name === "ops_reflex_facts" ? FACTS : undefined);
  await runReflexes(w.env, w.deps, [cand(w)], slowPulse);
  const v = await reflexView(w.env, w.t);
  assert.equal(v.mode, "tell_only");
  assert.equal(v.acts_on_the_site, false);
  assert.equal(v.clean_days, 100);
  assert.equal(v.rollback_token_set, true);
  assert.equal(w.wakes.length + w.https.length + w.fetches.length, 0);
  assert.deepEqual(w.rpcs.map((x) => x.name), ["ops_reflex_facts"]);
  // The module exports nothing that sets the mode, and its source makes no
  // outside call other than the facts read and the mail.
  assert.deepEqual(Object.keys(reflex).filter((k) => /live|enable|mode|switch/i.test(k)), ["MODE"]);
  const src = readFileSync(new URL("../src/reflex.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /deps\.(wake|http|fetch)\b|\bfetch\(/);
  assert.deepEqual([...src.matchAll(/deps\.rpc\("([a-z_]+)"/g)].map((m) => m[1]), ["ops_reflex_facts"]);
});

test("through the real pulse: serious, the owner is working, so the agent is held and a reflex looks", async () => {
  const w = makeWorld();
  await setPaused(w.env, w.deps, false);
  await kvPut(w.env, "state", { learning_done: 1, learning_until: 1 }, w.t).run();
  w.dbUp = false;
  for (let i = 0; i < 14; i++) { await setActive(w.env, w.deps); await runPulse(w.env, w.deps); w.tick(); }
  const held = (await w.env.DB.prepare("SELECT state, why FROM gate WHERE why = 'owner_busy'").all()).results;
  assert.ok(held.length >= 1, "the outage is held back while the owner works");
  assert.equal(w.wakes.length, 0, "nothing started the agent");
  const rows = (await w.env.DB.prepare("SELECT kind, why_blocked, note FROM reflex").all()).results;
  assert.ok(rows.length >= 1, "a reflex looked");
  assert.ok(rows.every((x) => x.kind === "none"), "and with the database unreachable it had nothing to say");
  assert.match(rows[0].why_blocked, /you are working in Claude/);
  assert.equal(w.calls("ops_reflex_facts").length, 0);
  assert.equal(await kvGet(w.env, "reflex_error"), null);
  assert.equal(await kvGet(w.env, "gate_error"), null);
});

// ---------- the Ask box ----------

test("ask box: answer comes from the site's AI, with live numbers; capped per day", async () => {
  const w = makeWorld();
  w.httpReply = () => ({ status: 200, json: { ok: true, answer: "Nothing is open right now.", memory: true } });
  const r = await ask(w.env, w.deps, "  What is open   right now? ");
  assert.equal(r.ok, true);
  assert.equal(r.answer, "Nothing is open right now.");
  assert.equal(w.https.length, 1);
  assert.equal(w.https[0].url, "https://site.test/api/ai?op=ops-ask");
  const sent = JSON.parse(w.https[0].init.body);
  assert.equal(sent.q, "What is open right now?");
  assert.equal(sent.live.reflexes.mode, "tell_only");
  assert.ok("open_issues" in sent.live && "claude_limits" in sent.live);
  assert.doesNotMatch(JSON.stringify(sent), /s3cret/, "the secret travels in the header only");
  assert.equal(w.wakes.length, 0, "asking never starts the agent");
  assert.equal((await w.env.DB.prepare("SELECT q, a, ok FROM ask").first()).a, "Nothing is open right now.");
  assert.equal((await ask(w.env, w.deps, "a")).ok, false);
  // The site's AI is down: said plainly, stored as not answered.
  w.httpReply = () => ({ status: 503, json: { error: "busy" } });
  assert.match((await ask(w.env, w.deps, "Is the site up?")).why, /busy or switched to saved answers/);
  // Thirty a day.
  for (let i = 0; i < 30; i++) await w.env.DB.prepare("INSERT INTO ask (at, q, ok) VALUES (?1, 'x', 1)").bind(w.t).run();
  const n = w.https.length;
  assert.match((await ask(w.env, w.deps, "One more?")).why, /daily cap/);
  assert.equal(w.https.length, n, "no AI call past the cap");
});

test("ask page: opening the link asks nothing; the form does; a bad link shows nothing", async () => {
  const w = makeWorld();
  w.httpReply = () => ({ status: 200, json: { ok: true, answer: "Two issues are open <b>now</b>.", memory: false } });
  const link = await askLink(w.env, "https://w.test", w.t);
  assert.match(link, new RegExp(`/p\\?i=${ASK_ID}&e=\\d+&k=[0-9a-f]{40}$`));
  const get = await page(new Request(link), w.env, w.deps);
  assert.equal(get.status, 200);
  const html = await get.text();
  assert.match(html, /<textarea name="q"/);
  assert.equal(w.https.length, 0, "a mail scanner opening the link costs nothing");
  assert.doesNotMatch(html, /<script/i);
  const u = new URL(link);
  const body = new URLSearchParams({ i: ASK_ID, e: u.searchParams.get("e"), k: u.searchParams.get("k"), q: "What is open?" });
  const post = await page(new Request("https://w.test/p", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), w.env, w.deps);
  const out = await post.text();
  assert.equal(w.https.length, 1);
  assert.match(out, /Two issues are open &lt;b&gt;now&lt;\/b&gt;\./, "the answer is shown as text, never as markup");
  assert.match(out, /memory could not be read/);
  // Forty-nine hours later the same link is dead, and so is a changed one.
  const bad = await page(new Request(link.replace(/k=..../, "k=0000")), w.env, w.deps);
  assert.equal(bad.status, 404);
  w.tick(49 * HOUR);
  assert.equal((await page(new Request(link), w.env, w.deps)).status, 404);
  assert.equal(w.https.length, 1);
});

// ---------- self-tuning ----------

test("tuning: whatever number arrives is clamped to the coded bounds", () => {
  assert.equal(tuned(undefined, "signup_stuck_submits"), 7);
  assert.equal(tuned({ signup_stuck_submits: 6 }, "signup_stuck_submits"), 6);
  assert.equal(tuned({ signup_stuck_submits: 1 }, "signup_stuck_submits"), TUNE.signup_stuck_submits[1]);
  assert.equal(tuned({ signup_stuck_submits: 999 }, "signup_stuck_submits"), TUNE.signup_stuck_submits[2]);
  assert.equal(tuned({ signup_unconfirmed_accounts: "abc" }, "signup_unconfirmed_accounts"), 8);
  const f = { submit: 6 }, db = { ok: true, email_created_30: 0, email_created_60: 0, confirmed_60: 0 };
  assert.equal(signupTruth(f, f, db).length, 0, "6 forms is under the usual 7");
  assert.equal(signupTruth(f, f, db, { signup_stuck_submits: 6 }).length, 1, "tuned one step down: 6 now counts");
  assert.equal(signupTruth({ submit: 4 }, { submit: 4 }, db, { signup_stuck_submits: 0 }).length, 0, "a zero cannot make every quiet half hour an alarm");
});

test("brief: tuning and proposals are reported; the score only on Sunday", () => {
  const g = {
    ok: true,
    tuning: { values: {}, changes: [{ key: "signup_stuck_submits", old: 7, new: 6, why: "two real stalls were noticed a half hour late" }],
      proposals: [{ key: "memory_min_meaning", new: 0.7, refused_why: "outside the fixed limits", why: "wants many more past cases" }] },
    week: { week_start: "2026-11-09", merged: 1, near_duplicates: 4, skill_candidates: 2, score: { issues_opened: 9, fixed: 6, notice_min_median: 3, fix_min_median: 41, wrong_diagnoses: 1, runs: 10, runs_not_worth_it: 2, runs_died: 1 } },
  };
  const sunday = growthLines(g, IST(2026, 11, 15, 21, 0)), monday = growthLines(g, IST(2026, 11, 16, 21, 0));
  assert.match(sunday, /7 -> 6/);
  assert.match(sunday, /needs you/);
  assert.match(sunday, /Wrong diagnoses: 1/);
  assert.match(sunday, /2 changed nothing/);
  assert.doesNotMatch(monday, /The agent's week/);
  assert.equal(growthLines(null, 0), null);
  assert.equal(growthLines({ ok: true, tuning: { changes: [], proposals: [] } }, IST(2026, 11, 16, 21, 0)), null);
});

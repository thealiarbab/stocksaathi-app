import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./d1.mjs";
import { ingest, applyIssueChanges, mergeSignatures, flushOutbox, syncCounts, kvPut } from "../src/core.js";
import { runPulse } from "../src/pulse.js";
import { decide, fixVerdict, watchWindow, baseline, farOff, silentTooLong } from "../src/rules.js";
import { fingerprint } from "../src/signature.js";

const crash = (over = {}) => ({ kind: "exception", route: "/api/quote", etype: "KeyError", msg: "'chart'", frames: ["handlers/quote.py:fetch"], who: "aaaaaaaa", ...over });
const sig = (w, fp) => w.env.DB.prepare("SELECT * FROM sig WHERE fp = ?1").bind(fp).first();
const fpOf = async (w, like) => (await w.env.DB.prepare("SELECT fp FROM sig WHERE sig LIKE ?1").bind(like).first())?.fp;

test("a server crash becomes one issue on its first hit; 50 repeats stay one issue", async () => {
  const w = makeWorld();
  const r1 = await ingest(w.env, w.deps, { src: "py", deploy: "abc1234", events: [crash()] });
  assert.equal(r1.opened, 1);
  assert.equal(w.calls("ops_issue_upsert").length, 1);
  const p = w.calls("ops_issue_upsert")[0].p;
  assert.equal(p.event, "open"); assert.equal(p.source, "server_py"); assert.equal(p.trusted, true); assert.equal(p.severity, "high");
  assert.equal(p.evidence.first_samples.length, 1);
  for (let i = 0; i < 49; i++) { w.tick(1000); await ingest(w.env, w.deps, { src: "py", deploy: "abc1234", events: [crash({ who: `person${i % 7}xx` })] }); }
  assert.equal(w.calls("ops_issue_upsert").length, 1, "no duplicate issue, no second alert");
  const row = await sig(w, p.fp);
  assert.equal(row.hits, 50); assert.equal(row.people, 8); assert.equal(row.state, "open"); assert.equal(row.issue_id, 100);
  assert.equal(JSON.parse(row.first_samples).length, 5); assert.equal(JSON.parse(row.last_samples).length, 5);
  assert.equal(row.dirty, 1);
  w.tick(11 * 60_000);
  assert.equal(await syncCounts(w.env, w.deps), 1);
  assert.equal(w.calls("ops_issues_sync")[0].p.rows[0].hits, 50);
});

test("a browser error needs three different people (the browser endpoint is public)", async () => {
  const w = makeWorld();
  const ev = { kind: "error", target: "x is not defined", props: { src: "/assets/core.11112222.js:1:5" }, path: "/" };
  for (let i = 0; i < 10; i++) await ingest(w.env, w.deps, { src: "browser", vid: "samevisitor1", events: [ev] });
  assert.equal(w.calls("ops_issue_upsert").length, 0, "one person repeating does not open an issue");
  await ingest(w.env, w.deps, { src: "browser", vid: "visitor00002", events: [ev] });
  await ingest(w.env, w.deps, { src: "browser", vid: "visitor00003", events: [ev] });
  assert.equal(w.calls("ops_issue_upsert").length, 1);
  assert.equal(w.calls("ops_issue_upsert")[0].p.trusted, false);
});

test("first day: existing browser noise builds a baseline instead of a flood of issues", async () => {
  const w = makeWorld();
  await kvPut(w.env, "learning_until", w.t + 86400_000, w.t).run();
  const ev = { kind: "api", target: "db /auth/v1/token", props: { st: 400, ms: 120 }, path: "/login" };
  for (let i = 0; i < 20; i++) await ingest(w.env, w.deps, { src: "browser", vid: `visitor${String(i).padStart(5, "0")}`, events: [ev] });
  assert.equal(w.calls("ops_issue_upsert").length, 0);
  assert.equal((await sig(w, await fpOf(w, "br|api|%"))).state, "baseline");
  // ...but a server crash in the same period still opens at once.
  await ingest(w.env, w.deps, { src: "js", events: [{ kind: "exception", route: "/api/ai?op=news", etype: "TypeError", msg: "x", frames: ["opNews"] }] });
  assert.equal(w.calls("ops_issue_upsert").length, 1);
});

test("fixed, then seen again = regressed; ignored things come back only on a tenfold surge", async () => {
  const w = makeWorld();
  await ingest(w.env, w.deps, { src: "py", events: [crash()] });
  const fp = w.calls("ops_issue_upsert")[0].p.fp;
  await applyIssueChanges(w.env, w.deps, [{ fp, id: 100, status: "fixed", fixed_at: new Date(w.t).toISOString(), fix_deploy: "new5678" }]);
  w.tick(2 * 60_000);
  await ingest(w.env, w.deps, { src: "py", deploy: "old1234", events: [crash()] });
  assert.equal(w.calls("ops_issue_upsert").length, 1, "stragglers from the old build right after the fix do not count");
  w.tick(3 * 3600_000);
  await ingest(w.env, w.deps, { src: "py", deploy: "new5678", events: [crash()] });
  assert.equal(w.calls("ops_issue_upsert").length, 2);
  assert.equal(w.calls("ops_issue_upsert")[1].p.event, "regress");
  assert.equal((await sig(w, fp)).state, "open");

  await applyIssueChanges(w.env, w.deps, [{ fp, id: 100, status: "ignored" }]);
  await w.env.DB.prepare("UPDATE sig SET peak_day = 3 WHERE fp = ?1").bind(fp).run();
  w.tick(86400_000);
  await ingest(w.env, w.deps, { src: "py", events: Array(20).fill(crash()) });
  assert.equal(w.calls("ops_issue_upsert").length, 2, "below ten times its worst day: stays quiet");
  await ingest(w.env, w.deps, { src: "py", events: Array(15).fill(crash()) });
  assert.equal(w.calls("ops_issue_upsert")[2].p.event, "unmute");
});

test("a known problem far above its own worst day alerts once", async () => {
  const w = makeWorld();
  await ingest(w.env, w.deps, { src: "py", events: [crash()] });
  const fp = w.calls("ops_issue_upsert")[0].p.fp;
  await w.env.DB.prepare("UPDATE sig SET peak_day = 5 WHERE fp = ?1").bind(fp).run();
  w.tick(86400_000);
  await ingest(w.env, w.deps, { src: "py", events: Array(25).fill(crash()) });
  await ingest(w.env, w.deps, { src: "py", events: Array(25).fill(crash()) });
  const spikes = w.calls("ops_issue_upsert").filter((c) => c.p.event === "spike");
  assert.equal(spikes.length, 1);
});

test("database down: the issue waits in the outbox, the owner is mailed, then it is delivered", async () => {
  const w = makeWorld();
  w.dbUp = false;
  const r = await ingest(w.env, w.deps, { src: "py", events: [crash()] });
  assert.equal(r.queued, 1);
  assert.equal(w.mails.length, 1);
  w.dbUp = true;
  assert.equal(await flushOutbox(w.env, w.deps), 1);
  assert.equal((await sig(w, await fpOf(w, "py|exc|%"))).issue_id, 100);
});

test("merging signatures: later reports of the merged one count on the head", async () => {
  const w = makeWorld();
  await ingest(w.env, w.deps, { src: "py", events: [crash()] });
  await ingest(w.env, w.deps, { src: "py", events: [crash({ msg: "'chart' missing in reply (gateway)" })] });
  const head = await fpOf(w, "%|'chart'|%"), other = await fpOf(w, "%(gateway)%");
  assert.ok(head && other && head !== other);
  assert.deepEqual(await mergeSignatures(w.env, w.deps, { from: other, head, why: "same Yahoo reply problem", needle: "'chart' missing" }), { ok: true });
  await ingest(w.env, w.deps, { src: "py", events: [crash({ msg: "'chart' missing in reply (gateway)" })] });
  assert.equal((await sig(w, head)).hits, 3);
  // The learned grouping also catches a variant never seen before.
  await ingest(w.env, w.deps, { src: "py", events: [crash({ msg: "'chart' missing in reply (timeout)" })] });
  assert.equal((await sig(w, head)).hits, 4);
  assert.equal(w.calls("ops_issue_upsert").length, 2, "no third issue for the variant");
});

test("hostile input is bounded and cannot break intake", async () => {
  const w = makeWorld();
  const big = "A".repeat(50_000);
  const r = await ingest(w.env, w.deps, { src: "py", events: [crash({ msg: big, frames: [big], body: { x: big } }), null, 5, { kind: "exception" }], tally: { "/api/x": [10, 1, 500], bad: "x" } });
  assert.equal(r.ok, true);
  const row = await w.env.DB.prepare("SELECT length(first_samples) n, length(title) t FROM sig ORDER BY n DESC LIMIT 1").first();
  assert.ok(row.n < 5000 && row.t <= 180);
  assert.deepEqual(await ingest(w.env, w.deps, { src: "pulse", events: [] }), { ok: false, why: "bad_src" });
  assert.equal((await w.env.DB.prepare("SELECT ok, err FROM tally").first()).ok, 10);
});

test("pulse: two misses in a row = outage, mailed directly when the database is the one down; recovery is reported", async () => {
  const w = makeWorld();
  await runPulse(w.env, w.deps); w.tick();
  w.dbUp = false;
  await runPulse(w.env, w.deps); w.tick();
  assert.equal(w.mails.length, 0, "one miss is not an outage");
  await runPulse(w.env, w.deps); w.tick();
  assert.equal(w.mails.length, 1);
  assert.match(w.mails[0].title, /outage: the database not answering/);
  assert.equal(w.mails[0].opts.force, true);
  for (let i = 0; i < 5; i++) { await runPulse(w.env, w.deps); w.tick(); }
  assert.equal(w.mails.length, 1, "one mail per outage, not one per minute");
  w.dbUp = true;
  for (let i = 0; i < 4; i++) { await runPulse(w.env, w.deps); w.tick(); }
  assert.match(w.mails[1].title, /recovered/);
  const opened = w.calls("ops_issue_upsert").filter((c) => c.p.title.includes("database"));
  assert.ok(opened.length >= 1, "the outage is delivered as an issue once the database is back");
  assert.equal(w.calls("ops_issue_note").length, 1);
});

test("pulse: site down while the database is up goes through the normal alert path", async () => {
  const w = makeWorld();
  await runPulse(w.env, w.deps); w.tick();
  w.siteUp = false;
  await runPulse(w.env, w.deps); w.tick();
  await runPulse(w.env, w.deps); w.tick();
  const up = w.calls("ops_issue_upsert");
  assert.equal(up.length, 1);
  assert.equal(up[0].p.severity, "critical"); assert.equal(up[0].p.source, "pulse");
  assert.equal(w.mails.length, 0);
});

test("pulse: failed and missed scheduled jobs, and a job switched off", async () => {
  const w = makeWorld(Date.UTC(2026, 10, 12, 6, 0, 0));
  const jobs = [{ id: 7, name: "ops-health", schedule: "*/5 * * * *", active: true }, { id: 2, name: "order-matcher", schedule: "* 3-10 * * 1-5", active: true }];
  let runs = [], changed = [], n = 1;
  w.pulse = () => ({ ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades: 0, views: 0 },
    cron: { jobs, runs, cursor: n, changed }, net: { cursor: 1, fails: [] } });
  const ok = (job) => ({ id: n++, job, status: "succeeded", start: new Date(w.t).toISOString() });
  for (let i = 0; i < 12; i++) {           // 12 healthy minutes
    runs = [ok(2)]; if (new Date(w.t).getUTCMinutes() % 5 === 0) runs.push(ok(7));
    await runPulse(w.env, w.deps); w.tick();
  }
  assert.equal(w.calls("ops_issue_upsert").length, 0, "healthy jobs raise nothing");
  for (let i = 0; i < 12; i++) {           // ops-health silently stops; matcher keeps failing
    runs = [{ id: n++, job: 2, status: "failed", start: new Date(w.t).toISOString(), msg: "ERROR: canceling statement due to statement timeout" }];
    await runPulse(w.env, w.deps); w.tick();
  }
  const titles = w.calls("ops_issue_upsert").map((c) => c.p.title);
  assert.ok(titles.includes("Scheduled job ops-health did not run"), titles.join(" | "));
  assert.ok(titles.includes("Scheduled job order-matcher failed"));
  assert.equal(titles.length, 2, "one issue each, however long it lasts");
  runs = []; changed = [{ job: "ops-health", what: "deactivated" }];
  await runPulse(w.env, w.deps);
  assert.ok(w.calls("ops_issue_upsert").some((c) => c.p.title === "Scheduled job ops-health was switched off"));
});

test("pulse: a daily job added after its slot is not reported missed; a real miss later is", async () => {
  const w = makeWorld(Date.UTC(2026, 10, 14, 20, 0, 0));
  const jobs = [{ id: 7, name: "ops-health", schedule: "*/5 * * * *", active: true }];
  let n = 1;
  w.pulse = () => ({ ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades: 0, views: 0 },
    cron: { jobs, runs: new Date(w.t).getUTCMinutes() % 5 === 0 ? [{ id: n++, job: 7, status: "succeeded", start: new Date(w.t).toISOString() }] : [], cursor: n, changed: [] }, net: { cursor: 1, fails: [] } });
  for (let i = 0; i < 60; i++) { await runPulse(w.env, w.deps); w.tick(); }   // 20:00-21:00, collector tracking
  jobs.push({ id: 23, name: "nightly", schedule: "20 20 * * *", active: true }); // added at 21:00, slot 20:20 already gone
  for (let i = 0; i < 30; i++) { await runPulse(w.env, w.deps); w.tick(); }
  const cronIssues = () => w.calls("ops_issue_upsert").filter((c) => c.p.title.startsWith("Scheduled job"));
  assert.equal(cronIssues().length, 0, "a slot before the job existed is not a miss");
  w.tick(Date.UTC(2026, 10, 15, 20, 30, 0) - w.t);                              // next day: slot 20:20 passes with no run
  for (let i = 0; i < 10; i++) { await runPulse(w.env, w.deps); w.tick(); }
  assert.ok(cronIssues().some((c) => c.p.title === "Scheduled job nightly did not run"));
});

test("pulse: zero sign-ups when several were certain raises 'nobody is getting through'", async () => {
  const w = makeWorld(Date.UTC(2026, 10, 12, 9, 0, 0));
  const hour = Math.floor(w.t / 3600_000);
  for (const d of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) {
    await w.env.DB.prepare("INSERT INTO vital_hour (vital, hour, v) VALUES ('signups', ?1, ?2), ('views', ?1, 900)").bind(hour - d * 24, 16 + d).run();
    await w.env.DB.prepare("INSERT INTO vital_hour (vital, hour, v) VALUES ('signups', ?1, ?2)").bind(hour + 1 - d * 24, 16 + d).run();
  }
  let su = 1000, views = 5000;
  w.pulse = () => ({ ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: su, trades: 0, views } });
  for (let i = 0; i < 70; i++) { views += 15; await runPulse(w.env, w.deps); w.tick(); }
  const hit = w.calls("ops_issue_upsert").find((c) => c.p.title === "Nobody is getting through sign-up");
  assert.ok(hit, "raised");
  assert.equal(hit.p.severity, "critical");
  // Same traffic with sign-ups flowing raises nothing.
  const w2 = makeWorld(Date.UTC(2026, 10, 12, 9, 0, 0));
  for (const d of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13]) await w2.env.DB.prepare("INSERT INTO vital_hour (vital, hour, v) VALUES ('signups', ?1, 18), ('signups', ?2, 18)").bind(hour - d * 24, hour + 1 - d * 24).run();
  let su2 = 0, v2 = 0;
  w2.pulse = () => ({ ok: true, now: new Date(w2.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: su2, trades: 0, views: v2 } });
  for (let i = 0; i < 70; i++) { v2 += 15; if (i % 4 === 0) su2++; await runPulse(w2.env, w2.deps); w2.tick(); }
  assert.equal(w2.calls("ops_issue_upsert").length, 0);
});

test("pulse: a fix that makes things worse is called out within minutes; a good one must stay quiet long enough", async () => {
  const w = makeWorld();
  await ingest(w.env, w.deps, { src: "py", events: [crash()] });
  const fp = w.calls("ops_issue_upsert")[0].p.fp;
  for (let i = 0; i < 12; i++) { await runPulse(w.env, w.deps); w.tick(); }
  const liveAt = w.t;
  let watches = [{ attempt_id: 9, issue_id: 100, fp, live_at: new Date(liveAt).toISOString(), expected: {} }];
  w.pulse = () => ({ ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades: 0, views: 0 }, watches });
  for (let i = 0; i < 4; i++) {
    await ingest(w.env, w.deps, { src: "py", events: Array(3).fill(crash({ route: "/api/portfolio", etype: "NameError", msg: "name 'x' is not defined" })) });
    await runPulse(w.env, w.deps); w.tick();
  }
  const v = w.calls("ops_attempt_verdict");
  assert.equal(v[0].p.verdict, "made_worse");
  assert.match(v[0].p.note, /new server crash/);

  // A clean change: passes the watch window, then no verdict until enough quiet time.
  const w2 = makeWorld();
  await ingest(w2.env, w2.deps, { src: "py", events: [crash()] });
  const fp2 = w2.calls("ops_issue_upsert")[0].p.fp;
  const live2 = w2.t;
  w2.pulse = () => ({ ok: true, now: new Date(w2.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades: 0, views: 0 },
    watches: [{ attempt_id: 4, issue_id: 100, fp: fp2, live_at: new Date(live2).toISOString(), expected: {} }] });
  for (let i = 0; i < 14; i++) { await runPulse(w2.env, w2.deps); w2.tick(); }
  const first = w2.calls("ops_attempt_verdict");
  assert.equal(first.length, 1); assert.equal(first[0].p.verdict, null); assert.match(first[0].p.note, /watch window passed/);
  for (let i = 0; i < 20; i++) { w2.tick(30 * 60_000); await runPulse(w2.env, w2.deps); }
  assert.equal(w2.calls("ops_attempt_verdict").length, 1, "10 hours of quiet is not yet proof");
  for (let i = 0; i < 40; i++) { w2.tick(30 * 60_000); await runPulse(w2.env, w2.deps); }
  assert.equal(w2.calls("ops_attempt_verdict").at(-1).p.verdict, "held");
});

test("rules: verdicts, watch window, usual-value maths", () => {
  const before = { hits: 40, firstSeen: 0, lastSeen: 4 * 3600_000, activity: 4000 };
  assert.equal(fixVerdict(before, { ms: 3600_000, hits: 2, activity: 100 }).verdict, "no_effect");
  assert.equal(fixVerdict(before, { ms: 5 * 3600_000, hits: 0, activity: 9000 }).verdict, null, "needs a full day at least");
  assert.equal(fixVerdict(before, { ms: 25 * 3600_000, hits: 0, activity: 200 }).verdict, null, "a quiet day with no traffic proves nothing");
  assert.equal(fixVerdict(before, { ms: 25 * 3600_000, hits: 0, activity: 9000 }).verdict, "held");
  assert.deepEqual(watchWindow({ errRate: 1, siteMs: 300, dbMs: 80 }, { errRate: 1.5, siteMs: 340, dbMs: 90, newCrashes: 0 }), []);
  assert.equal(watchWindow({ errRate: 1, siteMs: 300, dbMs: 80 }, { errRate: 9, siteMs: 2400, dbMs: 90, newCrashes: 0 }).length, 2);
  const b = baseline([10, 12, 11, 13, 90]);
  assert.equal(b.med, 12);
  assert.ok(farOff(2, b, "low")); assert.ok(!farOff(8, b, "low")); assert.ok(farOff(40, b, "high")); assert.ok(!farOff(15, b, "high"));
  assert.equal(baseline([1, 2]), null);
  assert.ok(silentTooLong(0, 7.5)); assert.ok(!silentTooLong(0, 3)); assert.ok(!silentTooLong(1, 50));
  assert.equal(decide({ state: "alias", kind: "exc" }, { hits: 99, people: 9 }, {}).action, "none");
});

test("fingerprints are stable", async () => {
  assert.equal(await fingerprint("pulse|site_down"), await fingerprint("pulse|site_down"));
  assert.match(await fingerprint("x"), /^[0-9a-f]{20}$/);
});

test("visitor-side slowness and load failures need the server to agree", async () => {
  const { visitorSide, serverAgrees } = await import("../src/rules.js");
  assert.equal(visitorSide({ src: "browser", kind: "apislow", sig: "br|api|/api/quote|slow" }), "slow");
  assert.equal(visitorSide({ src: "browser", kind: "api5", sig: "br|api|/api/quote|network" }), "network");
  assert.equal(visitorSide({ src: "browser", kind: "api5", sig: "br|api|/api/quote|5xx:502" }), null);
  assert.equal(visitorSide({ src: "py", kind: "slow", sig: "py|slow|/api/history" }), null);
  assert.equal(serverAgrees("slow", { people: 200 }, { serverHits: 0, badMinutes: 2 }), false);
  assert.equal(serverAgrees("slow", { people: 15 }, { serverHits: 1, badMinutes: 0 }), true);
  assert.equal(serverAgrees("slow", { people: 15 }, { serverHits: 0, badMinutes: 3 }), true);
  assert.equal(serverAgrees("network", { people: 29 }, { serverHits: 0, badMinutes: 0 }), false);
  assert.equal(serverAgrees("network", { people: 30 }, { serverHits: 0, badMinutes: 0 }), true);
});

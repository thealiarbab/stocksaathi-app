// Phase 3, the senses: journey robot, sign-up truth, funnels and returning
// users, outside services, the deploy watch, the calendar, three states, and
// "a fix only held if the robot is clean too".
import test from "node:test";
import assert from "node:assert/strict";
import { makeWorld } from "./d1.mjs";
import { ingest, kvGet, kvPut } from "../src/core.js";
import { runPulse } from "../src/pulse.js";
import { areaOf, bandOf, decide, wakeText } from "../src/gate.js";
import { gateView } from "../src/gaterun.js";
import { buildBrief } from "../src/brief.js";
import { dayInfo, nextOpen, prevOpen } from "../src/calendar.js";
import { blameOf, readStatus } from "../src/outside.js";
import { runRobot, robotClean, robotView } from "../src/robot.js";
import { signupTruth, judgeFunnel, judgeReturning, nightlySenses, deployWatch } from "../src/senses.js";

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;
const IST = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - 330 * MIN;

// ---------- calendar ----------

test("calendar: trading day, weekend, holiday, next and previous open", () => {
  const sun = dayInfo(IST(2026, 11, 15, 12));
  assert.equal(sun.trading, false); assert.equal(sun.weekend, true); assert.equal(sun.open, false);
  assert.equal(sun.nextOpen, IST(2026, 11, 16, 9, 15));
  assert.match(sun.line, /closed today \(weekend\); next open Mon 16 Nov 09:15 IST/);
  const hol = dayInfo(IST(2026, 11, 10, 11));
  assert.equal(hol.trading, false); assert.match(hol.line, /Diwali/);
  assert.equal(dayInfo(IST(2026, 11, 12, 11)).open, true);
  assert.equal(dayInfo(IST(2026, 11, 12, 16)).open, false);
  assert.match(dayInfo(IST(2026, 11, 12, 8)).line, /opens at 09:15/);
  // Friday evening: next open is Monday. Monday's previous open is Friday.
  assert.equal(nextOpen(IST(2026, 11, 13, 18)), IST(2026, 11, 16, 9, 15));
  assert.equal(prevOpen(IST(2026, 11, 16, 9, 15)), IST(2026, 11, 13, 9, 15));
  // Across the Diwali holiday (Tue 10 Nov): Wednesday's previous open is Monday.
  assert.equal(prevOpen(IST(2026, 11, 11, 9, 15)), IST(2026, 11, 9, 9, 15));
});

// ---------- outside services ----------

test("outside: whose fault it is", () => {
  const now = 1e12, bad = (k) => ({ at: now - MIN, supabase: "ok", vercel: "ok", resend: "ok", [k]: "bad" }), fine = bad("none");
  assert.equal(blameOf({ sig: "py|http|/api/live-quote|502|yahoo_unreachable", route: "/api/live-quote" }, {}, fine, now), "yahoo");
  assert.equal(blameOf({ sig: "js|http|/api/chat|502|x", route: "/api/chat" }, { body: "vertex 429 RESOURCE_EXHAUSTED" }, fine, now), "google_ai");
  assert.equal(blameOf({ sig: "js|http|/api/chat|502|upstream_error", route: "/api/chat" }, {}, fine, now), "google_ai");
  assert.equal(blameOf({ sig: "py|exc|/api/portfolio|KeyError", route: "/api/portfolio" }, { msg: "upstream" }, fine, now), null, "our own crash stays ours");
  assert.equal(blameOf({ sig: "pulse|db_down" }, {}, fine, now), null, "database down and Supabase says all is well: treated as ours");
  assert.equal(blameOf({ sig: "pulse|db_down" }, {}, bad("supabase"), now), "supabase");
  assert.equal(blameOf({ sig: "robot|login" }, { why: "status 500" }, bad("supabase"), now), "supabase");
  assert.equal(blameOf({ sig: "pulse|site_down" }, {}, bad("vercel"), now), "vercel");
  assert.equal(blameOf({ sig: "vital|signups|unconfirmed" }, {}, bad("resend"), now), "resend");
  assert.equal(blameOf({ sig: "pulse|site_down" }, {}, { ...bad("vercel"), at: now - HOUR }, now), null, "an hour-old status reading proves nothing");
});

test("outside: the status pages are read as ok, bad or unknown", async () => {
  const w = makeWorld();
  w.httpReply = (url) => (url.includes("vercel") ? { json: { status: { indicator: "major", description: "Elevated errors" } } }
    : url.includes("resend") ? { status: 503 } : { json: { status: { indicator: "none" } } });
  const s = await readStatus(w.deps);
  assert.equal(s.supabase, "ok"); assert.equal(s.vercel, "bad"); assert.equal(s.vercel_says, "Elevated errors"); assert.equal(s.resend, "unknown");
});

const NOW = Date.UTC(2026, 10, 10, 6, 0, 0);
const U = { known: true, fresh: true, weekly: 30, five: 10, weeklyReset: NOW + 3 * DAY, fiveReset: NOW + 2 * HOUR, age: 10 * MIN };
const G = (over = {}) => ({ state: "new", band: "serious", status: "open", area: "trading", kind: "pulse", sev: "medium", opened: NOW - 31 * MIN, lastSeen: NOW - 2 * MIN, people: 0, hits: 6, wakes: 0, ...over });
const C = (over = {}) => ({ now: NOW, usage: U, lastWakeAt: 0, lastSeriousWakeAt: 0, wakesToday: 0, blindToday: 0, ...over });

test("judge: an outside cause does not start the agent, unless it lasts or the owner says go", () => {
  const v = decide(G({ outside: "yahoo" }), C());
  assert.equal(v.act, "brief"); assert.equal(v.why, "outside"); assert.match(v.reason, /Yahoo Finance.*nothing of ours to change/);
  // The same issue without the mark would have woken the agent at once.
  assert.equal(decide(G(), C()).act, "wake");
  // Still happening two hours later, never looked at: one look.
  const long = decide(G({ outside: "yahoo", opened: NOW - 3 * HOUR }), C());
  assert.equal(long.act, "wake"); assert.equal(long.mode, "look"); assert.equal(long.why, "outside_long");
  // ...but never while the owner is working in Claude.
  assert.equal(decide(G({ outside: "yahoo", opened: NOW - 3 * HOUR }), C({ ownerActiveAt: NOW - 5 * MIN })).why, "owner_busy");
  // Looked at once already: back to the brief. Stopped: the brief.
  assert.equal(decide(G({ outside: "yahoo", opened: NOW - 3 * HOUR, wakes: 1 }), C()).why, "outside");
  assert.equal(decide(G({ outside: "yahoo", opened: NOW - 3 * HOUR, lastSeen: NOW - HOUR }), C()).why, "outside");
  // The owner's OK starts it whatever the cause.
  const ok = decide(G({ outside: "yahoo", approvedAt: NOW - MIN }), C({ ownerActiveAt: NOW - 5 * MIN }));
  assert.equal(ok.act, "wake");
});

test("judge: a low trading number on a closed-market day is the calendar, not a fault", () => {
  const g = G({ band: "middle", kind: "vital", sev: "high" });
  assert.equal(decide(g, C({ tradingDay: false })).why, "market_closed");
  assert.notEqual(decide(g, C({ tradingDay: true })).why, "market_closed");
  assert.notEqual(decide({ ...g, sev: "critical" }, C({ tradingDay: false })).why, "market_closed", "an outright stop is still judged");
  assert.notEqual(decide({ ...g, area: "signup" }, C({ tradingDay: false })).why, "market_closed", "sign-ups do not follow the market");
  assert.match(wakeText({ now: NOW, rows: [], usage: U, market: "the market is open" }), /\nmarket: the market is open\n/);
  assert.match(wakeText({ now: NOW, rows: [{ id: 5, mode: "look", area: "trading", band: "small", sev: "medium", outside: "yahoo", people: 0, hits: 1, opened: NOW, lastSeen: NOW }], usage: U }), /outside_cause=yahoo/);
});

// ---------- the journey robot ----------

function site(w, over = {}) {
  const s = { login: true, yahoo: false, chat: true, vercel: "none", page: 200, ...over };
  w.env.ROBOT_EMAIL = "robot@test"; w.env.ROBOT_PASSWORD = "pw-not-real";
  w.httpReply = (url) => {
    if (url.includes("status.json")) return { json: { status: { indicator: url.includes("vercel") ? s.vercel : "none", description: "incident" } } };
    if (url.endsWith("/register")) return { text: "<html>" };
    if (url.includes("/auth/v1/settings")) return { json: { external: { email: true } } };
    if (url.includes("/auth/v1/token")) return s.login ? { json: { access_token: "tok" } } : { status: 400, json: { error_code: "invalid_credentials" } };
    if (url.includes("/rest/v1/portfolios")) return { json: [{ cash_paise: 1 }] };
    if (url.includes("/rest/v1/holdings")) return { json: [] };
    if (url.includes("/api/live-quote")) { const sym = url.split("symbols=")[1]; return s.yahoo ? { status: 502, json: { error: "yahoo_unreachable" } } : { json: { ok: true, quotes: { [sym]: { price: 2500 } } } }; }
    if (url.includes("place_limit_order")) return { json: { ok: true, order_id: "o-1" } };
    if (url.includes("/api/chat")) return s.chat ? { json: { choices: [{ message: { content: "A stop loss is an order that sells..." } }] } } : { status: 503, json: { error: "busy" } };
    if (url.includes("/rest/v1/rpc/")) return { json: { ok: true } };
    return { status: s.page, text: "ok" };
  };
  return s;
}
const at = (w, hh, mm) => { w.t = Date.UTC(2026, 10, 12, hh, mm, 0); };   // Thu 12 Nov, UTC
const hit = (w, part) => w.https.filter((h) => h.url.includes(part));
const steps = (r) => Object.fromEntries(r.steps.map((s) => [s.step, s.ok]));

test("robot: does the whole journey, varies stock and page, asks Saathi once an hour only", async () => {
  const w = makeWorld(); site(w);
  at(w, 6, 3);
  assert.equal((await runRobot(w.env, w.deps)).skipped, "not_due");
  at(w, 6, 4);
  const r1 = await runRobot(w.env, w.deps);
  assert.deepEqual(steps(r1), { register: true, login: true, portfolio: true, page: true, prices: true, order: true, trade: true });
  assert.equal(hit(w, "/api/chat").length, 0, "no AI question on an ordinary run");
  const order = JSON.parse(hit(w, "place_limit_order")[0].init.body);
  assert.equal(order.p_qty, 1); assert.equal(order.p_limit_price_paise, 242500, "3% under the price");
  assert.equal(hit(w, "cancel_limit_order").length, 1, "the order is cancelled at once: no trade row");
  assert.equal(hit(w, "apply_trade").length, 2, "one real buy and sell in the first run of a market hour");
  assert.equal(hit(w, "/auth/v1/signup").length, 0, "never creates an account");
  at(w, 6, 5);
  assert.equal((await runRobot(w.env, w.deps)).skipped, "nothing_to_retry");
  at(w, 6, 14);
  await runRobot(w.env, w.deps);
  assert.equal(hit(w, "apply_trade").length, 2, "one paper trade an hour, not one a run");
  const quotes = hit(w, "/api/live-quote").map((h) => h.url.split("symbols=")[1]);
  assert.notEqual(quotes[0], quotes[1], "a different stock each run");
  at(w, 6, 34);
  const r3 = await runRobot(w.env, w.deps);
  assert.equal(steps(r3).saathi, true);
  const chat = hit(w, "/api/chat")[0].init;
  assert.equal(chat.headers.Origin, "https://site.test"); assert.equal(chat.headers["X-Saathi-Feature"], "ops-robot");
  assert.equal(w.calls("ops_issue_upsert").length, 0);
  const v = await robotView(w.env, w.t);
  assert.equal(v.state, "ok"); assert.equal(v.paper_trades_made, 2); assert.equal(v.runs_24h, 3);
  assert.equal((await robotView(w.env, w.t + 45 * MIN)).state, "unknown", "no run for 45 minutes is 'unknown', not 'ok'");
  // After the close: no real trade, and the test portfolio is reset once a day.
  at(w, 11, 4);
  await runRobot(w.env, w.deps);
  assert.equal(hit(w, "apply_trade").length, 2);
  assert.equal(hit(w, "reset_my_portfolio").length, 1);
  at(w, 11, 14);
  await runRobot(w.env, w.deps);
  assert.equal(hit(w, "reset_my_portfolio").length, 1);
});

test("robot: a step failing twice in a row becomes a serious issue in the right area; passing again is recorded", async () => {
  const w = makeWorld(); const s = site(w);
  at(w, 6, 4); await runRobot(w.env, w.deps);
  s.login = false;
  at(w, 6, 14);
  const r = await runRobot(w.env, w.deps);
  assert.equal(steps(r).login, false);
  assert.equal(steps(r).portfolio, undefined, "steps that need a login are not tried, and not blamed");
  assert.equal(w.calls("ops_issue_upsert").length, 0, "one failed run is not an issue yet");
  at(w, 6, 15);
  const r2 = await runRobot(w.env, w.deps);
  assert.equal(r2.raised, 1);
  const p = w.calls("ops_issue_upsert")[0].p;
  assert.match(p.title, /test account cannot log in/); assert.equal(p.severity, "high"); assert.equal(p.source, "pulse"); assert.equal(p.trusted, true);
  assert.match(p.evidence.last_samples[0].why, /status 400 invalid_credentials/);
  assert.doesNotMatch(JSON.stringify(p), /pw-not-real|Bearer|"tok"/, "no password or token in the issue");
  const g = await w.env.DB.prepare("SELECT area, sev, outside FROM gate WHERE fp = ?1").bind(p.fp).first();
  assert.deepEqual({ ...g }, { area: "signup", sev: "high", outside: null });
  const row = (await gateView(w.env, w.deps)).rows[0];
  assert.equal(row.band, "serious"); assert.equal(row.now_would, "wake");
  at(w, 6, 24); await runRobot(w.env, w.deps);
  assert.equal(w.calls("ops_issue_upsert").length, 1, "still failing: the same issue, not a new one");
  s.login = true;
  at(w, 6, 34);
  const r3 = await runRobot(w.env, w.deps);
  assert.deepEqual(r3.recovered, ["login"]);
  const note = w.calls("ops_issue_note").at(-1).p;
  assert.equal(note.fp, p.fp); assert.equal(note.event, "recovered");
});

test("robot: areas, and a step that never passed cannot have 'broken'", async () => {
  for (const [step, area] of [["register", "signup"], ["login", "signup"], ["portfolio", "trading"], ["prices", "trading"], ["order", "trading"], ["trade", "trading"], ["saathi", "saathi"], ["page", "core"]]) {
    assert.equal(areaOf({ sig: `robot|${step}`, kind: "pulse" }), area);
    assert.equal(bandOf({ area, sev: "high", kind: "pulse", trusted: true, people: 0, hits: 1 }), "serious");
  }
  assert.equal(areaOf({ sig: "vital|signups|stuck", kind: "vital" }), "signup");
  assert.equal(areaOf({ sig: "vital|signups|funnel|google|account", kind: "vital" }), "signup");
  assert.equal(areaOf({ sig: "vital|returning|d7", kind: "vital" }), "other");
  const w = makeWorld(); site(w, { chat: false });
  at(w, 6, 34); await runRobot(w.env, w.deps);
  at(w, 6, 35);
  const r = await runRobot(w.env, w.deps);
  assert.equal(steps(r).saathi, false, "the second try asks Saathi again because that is what failed");
  assert.equal(w.calls("ops_issue_upsert").length, 0);
  assert.ok((await robotView(w.env, w.t)).never_passed_yet.includes("saathi"));
  // Not configured: the robot does nothing at all.
  const w2 = makeWorld();
  assert.equal((await runRobot(w2.env, w2.deps, { force: true })).why, "not_configured");
});

test("robot + outside: prices failing because Yahoo is down is marked as theirs and goes to the brief", async () => {
  const w = makeWorld(); const s = site(w);
  at(w, 6, 4); await runRobot(w.env, w.deps);
  s.yahoo = true;
  at(w, 6, 14); await runRobot(w.env, w.deps);
  at(w, 6, 15); await runRobot(w.env, w.deps);
  const p = w.calls("ops_issue_upsert")[0].p;
  assert.match(p.title, /live prices/); assert.equal(p.severity, "medium");
  assert.equal(p.evidence.outside.service, "yahoo"); assert.match(p.evidence.outside.note, /Yahoo Finance, not our code/);
  assert.equal((await w.env.DB.prepare("SELECT outside FROM gate WHERE fp = ?1").bind(p.fp).first()).outside, "yahoo");
  const row = (await gateView(w.env, w.deps)).rows[0];
  assert.equal(row.now_would, "brief"); assert.match(row.because, /Yahoo Finance/);
  const b = await buildBrief(w.env, w.deps, { rows: (await import("../src/gaterun.js")).loadGate ? await (await import("../src/gaterun.js")).loadGate(w.env, w.t) : [], usage: U, paused: true, log: [], origin: null });
  assert.match(b.body, /Caused by an outside service[^\n]*: 1\n[^\n]*live prices/);
  assert.match(b.body, /Robot journey \[bad\]/); assert.match(b.body, /Failing now: prices/);
  // A main page failing while Vercel reports an incident: theirs too.
  const w2 = makeWorld(); const s2 = site(w2);
  at(w2, 6, 4); await runRobot(w2.env, w2.deps);
  s2.vercel = "major"; s2.page = 500;
  at(w2, 6, 14); await runRobot(w2.env, w2.deps);
  at(w2, 6, 15); await runRobot(w2.env, w2.deps);
  assert.equal(w2.calls("ops_issue_upsert")[0].p.evidence.outside.service, "vercel");
});

test("robot: its own paper trades are kept out of the trades number", async () => {
  const w = makeWorld();
  let trades = 10;
  w.pulse = () => ({ ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades, views: 0 } });
  const last = async () => JSON.parse((await w.env.DB.prepare("SELECT d FROM pulse ORDER BY t DESC LIMIT 1").first()).d).tr;
  await runPulse(w.env, w.deps); w.tick();
  trades = 13; await runPulse(w.env, w.deps); w.tick();
  assert.equal(await last(), 3, "students' trades are counted");
  await kvPut(w.env, "robot", { tr: 2 }, w.t).run();
  trades = 15; await runPulse(w.env, w.deps); w.tick();
  assert.equal(await last(), 0, "the robot's buy and sell are not");
  trades = 16; await runPulse(w.env, w.deps);
  assert.equal(await last(), 1);
});

// ---------- sign-up truth ----------

test("sign-up truth: form submits against accounts really created", () => {
  const sub = (n) => ({ submit: n, view: 40, error: 2 });
  assert.deepEqual(signupTruth(sub(6), sub(7), { ok: true, email_created_30: 0, email_created_60: 0, confirmed_60: 0 }), [], "a few submits and no account can be chance");
  const hi = signupTruth(sub(7), sub(7), { ok: true, email_created_30: 0, email_created_60: 0, confirmed_60: 0 });
  assert.equal(hi[0].sig, "vital|signups|stuck"); assert.equal(hi[0].severity, "high"); assert.equal(hi[0].sample.window_min, 30);
  assert.equal(signupTruth(sub(7), sub(9), { ok: true, email_created_30: 0, email_created_60: 0, confirmed_60: 0 })[0].severity, "critical");
  assert.deepEqual(signupTruth(sub(7), sub(9), { ok: true, email_created_30: 1, email_created_60: 3, confirmed_60: 2 }), [], "accounts are being made");
  const un = signupTruth(sub(2), sub(9), { ok: true, email_created_30: 4, email_created_60: 8, confirmed_60: 0 });
  assert.equal(un.length, 1); assert.equal(un[0].sig, "vital|signups|unconfirmed"); assert.equal(un[0].severity, "critical");
  assert.deepEqual(signupTruth(sub(9), sub(9), null), [], "no reading from the database: say nothing");
  assert.deepEqual(signupTruth(sub(9), sub(9), { ok: true }), [], "numbers missing: say nothing");
});

test("sign-up truth: counted from the site's own events as they happen, then judged by the pulse", async () => {
  const w = makeWorld();
  for (let i = 0; i < 9; i++) { await ingest(w.env, w.deps, { src: "js", flow: { view: 3, submit: 1, bogus: 5, error: "x" }, events: [] }); w.tick(2 * MIN); }
  const f = await w.env.DB.prepare("SELECT k, SUM(n) n FROM flow GROUP BY k ORDER BY k").all();
  assert.deepEqual(f.results.map((x) => [x.k, x.n]), [["submit", 9], ["view", 27]], "only known counters, only numbers");
  w.reply = (name) => (name === "ops_senses" ? { ok: true, email_created_30: 0, email_created_60: 0, confirmed_60: 0, created_30: 2, created_60: 5 } : undefined);
  w.t = Date.UTC(2026, 10, 12, 6, 25, 0);
  await runPulse(w.env, w.deps);
  assert.equal(w.calls("ops_issue_upsert").length, 0, "judged every 10 minutes, at minute 6");
  w.tick();
  await runPulse(w.env, w.deps);
  const p = w.calls("ops_issue_upsert")[0].p;
  assert.match(p.title, /sending the sign-up form but no account/); assert.equal(p.severity, "critical"); assert.equal(p.kind, "vital");
  assert.equal(p.evidence.last_samples[0].form_submits, 9);
  assert.equal((await w.env.DB.prepare("SELECT area FROM gate WHERE fp = ?1").bind(p.fp).first()).area, "signup");
  // Accounts created but none confirmed, while Resend reports an incident: theirs.
  const w2 = makeWorld(Date.UTC(2026, 10, 12, 6, 26, 0));
  await kvPut(w2.env, "outside", { at: w2.t, supabase: "ok", vercel: "ok", resend: "bad", resend_says: "Delayed delivery" }, w2.t).run();
  w2.reply = (name) => (name === "ops_senses" ? { ok: true, email_created_30: 4, email_created_60: 9, confirmed_60: 0 } : undefined);
  await runPulse(w2.env, w2.deps);
  const p2 = w2.calls("ops_issue_upsert")[0].p;
  assert.equal(p2.evidence.outside.service, "resend"); assert.match(p2.evidence.outside.note, /Delayed delivery/); assert.equal(p2.severity, "medium");
});

// ---------- funnels by source, returning users ----------

const day = (i) => new Date(Date.UTC(2026, 9, 1) + i * DAY).toISOString().slice(0, 10);
const funnelRows = (src, n, lastOver = {}) => Array.from({ length: n }, (_, i) => ({ day: day(i), src, v: 200, r: 20 + (i % 3), a: 10 + (i % 2), t: 4, ...(i === n - 1 ? lastOver : {}) }));

test("funnel: each source against its own history; three states", () => {
  const by = (rows) => Object.fromEntries(judgeFunnel(rows).map((f) => [`${f.src}|${f.step}`, f.state]));
  const ok = by([...funnelRows("chatgpt", 12), ...funnelRows("google", 12, { r: 3, a: 1 })]);
  assert.equal(ok["chatgpt|register"], "ok"); assert.equal(ok["chatgpt|account"], "ok"); assert.equal(ok["chatgpt|trade"], "ok");
  assert.equal(ok["google|register"], "bad", "Google visitors stopped reaching sign-up; ChatGPT's are fine");
  assert.equal(ok["google|account"], "bad");
  assert.equal(ok["google|trade"], "unknown", "one account is too few to judge first trades");
  assert.equal(by(funnelRows("direct", 5, { r: 0 }))["direct|register"], "unknown", "4 earlier days are not a history");
  assert.equal(by(funnelRows("social", 12, { v: 12, r: 0, a: 0 }))["social|register"], "unknown", "12 visitors are not a day");
  const f = judgeFunnel(funnelRows("google", 12, { r: 3 })).find((x) => x.step === "register");
  assert.equal(f.day, day(11)); assert.equal(f.days, 11); assert.ok(Math.abs(f.usual - 0.105) < 0.01);
});

test("funnel: bad two days running becomes an issue; returning users are judged once a week", async () => {
  const w = makeWorld(Date.UTC(2026, 10, 12, 20, 35, 0));   // a Thursday night
  let rows = funnelRows("google", 12, { r: 3 });
  const weeks = [1, 2, 3, 4, 5].map((i) => ({ week: day(i * 7), n: 100, n1: 100, d1: i === 5 ? 5 : 30, n7: 100, d7: 12, n30: i < 3 ? 100 : 0, d30: 4 }));
  w.reply = (name, p) => (name === "ops_senses" && p.full ? { ok: true, funnel: rows, returning: weeks } : undefined);
  assert.deepEqual(await nightlySenses(w.env, w.deps, w.t), [], "one bad day is not an issue");
  assert.deepEqual(await nightlySenses(w.env, w.deps, w.t + HOUR), [], "the same day read twice is still one day");
  rows = [...rows.slice(0, -1), { ...rows[11], r: 21 }, { day: day(12), src: "google", v: 200, r: 2, a: 10, t: 4 }];
  const found = await nightlySenses(w.env, w.deps, w.t + DAY);
  assert.equal(found.length, 1);
  assert.equal(found[0].sig, "vital|signups|funnel|google|register"); assert.equal(found[0].severity, "medium");
  assert.match(found[0].title, /Fewer visitors from Google open the sign-up page than usual, two days running/);
  const saved = await kvGet(w.env, "senses");
  const ret = Object.fromEntries(saved.returning.map((f) => [f.k, f.state]));
  assert.deepEqual(ret, { 1: "bad", 7: "ok", 30: "unknown" });
  // Sunday night (UTC): the weekly judgement of returning users.
  const sunday = await nightlySenses(w.env, w.deps, Date.UTC(2026, 10, 15, 20, 35, 0));
  assert.ok(sunday.some((f) => f.sig === "vital|returning|d1" && f.severity === "low"));
  assert.deepEqual(judgeReturning([]).map((f) => f.state), ["unknown", "unknown", "unknown"]);
  // A good day in between resets the count.
  const w3 = makeWorld(Date.UTC(2026, 10, 12, 20, 35, 0));
  let r3 = funnelRows("google", 12, { r: 3 });
  w3.reply = (name) => (name === "ops_senses" ? { ok: true, funnel: r3, returning: [] } : undefined);
  await nightlySenses(w3.env, w3.deps, w3.t);
  r3 = [...r3.slice(0, -1), { ...r3[11], r: 21 }, { day: day(12), src: "google", v: 200, r: 21, a: 10, t: 4 }];
  await nightlySenses(w3.env, w3.deps, w3.t + DAY);
  r3 = [...r3, { day: day(13), src: "google", v: 200, r: 2, a: 10, t: 4 }];
  assert.deepEqual(await nightlySenses(w3.env, w3.deps, w3.t + 2 * DAY), []);
});

// ---------- every build is watched ----------

const crash = (over = {}) => ({ kind: "exception", route: "/api/quote", etype: "KeyError", msg: "'chart'", frames: ["handlers/quote.py:fetch"], who: "aaaaaaaa", ...over });

test("deploy watch: a build that breaks things is named within 15 minutes", async () => {
  const w = makeWorld();
  for (let i = 0; i < 11; i++) { await runPulse(w.env, w.deps); w.tick(); }
  await ingest(w.env, w.deps, { src: "js", deploy: "abc1234", tally: { "/api/ai": [5, 0, 100] }, events: [] });
  for (let i = 0; i < 5; i++) { await runPulse(w.env, w.deps); w.tick(); }
  assert.equal(w.calls("ops_change_note").length, 1, "the build is in the change ledger");
  assert.equal(w.calls("ops_issue_upsert").length, 0, "a build that changes nothing raises nothing");
  await ingest(w.env, w.deps, { src: "js", deploy: "abc1234", events: Array(3).fill(crash({ route: "/api/ai?op=news", etype: "TypeError", msg: "x is undefined", frames: ["opNews"] })) });
  await runPulse(w.env, w.deps);
  const p = w.calls("ops_issue_upsert").map((c) => c.p).find((x) => /right after a new build/.test(x.title));
  assert.ok(p, "the regression is raised");
  const s = p.evidence.last_samples[0];
  assert.equal(s.suspect_commit, "abc1234"); assert.match(s.what_got_worse.join(" "), /new server crash/);
  assert.equal((await w.env.DB.prepare("SELECT area FROM gate WHERE fp = ?1").bind(p.fp).first()).area, "core");
  for (let i = 0; i < 20; i++) { w.tick(); await runPulse(w.env, w.deps); }
  assert.equal(w.calls("ops_issue_upsert").filter((c) => /right after a new build/.test(c.p.title)).length, 1, "raised once");
});

test("deploy watch: a build made at the weekend is checked again at the next market open, against the open before", async () => {
  const w = makeWorld();
  const friOpen = IST(2026, 11, 13, 9, 15), monOpen = IST(2026, 11, 16, 9, 15), built = IST(2026, 11, 14, 14, 0);
  const seed = async (from, tr, ok = 1) => {
    for (let i = 0; i < 30; i++) await w.env.DB.prepare("INSERT INTO pulse (t, site, site_ms, api, api_ms, db, db_ms, d) VALUES (?1, 1, 300, 1, 300, 1, 60, ?2)").bind(from + i * MIN, JSON.stringify({ tr })).run();
    for (const k of [4, 14, 24]) await w.env.DB.prepare("INSERT INTO robot_run (t, step, ok, ms) VALUES (?1, 'order', ?2, 5)").bind(from + k * MIN, ok).run();
  };
  await seed(friOpen, 2); await seed(monOpen, 0, 0);
  // Quiet weekend minutes after the build: the 15-minute window passes, then it waits for Monday.
  const st = { dep: [{ sha: "wkend01", at: built, stage: "window" }] };
  assert.deepEqual(await deployWatch(w.env, st, built + 16 * MIN, { down: false }), []);
  assert.equal(st.dep[0].stage, "open"); assert.equal(st.dep[0].open, monOpen);
  assert.deepEqual(await deployWatch(w.env, st, monOpen + 10 * MIN, { down: false }), [], "not before half an hour of trading");
  const found = await deployWatch(w.env, st, monOpen + 31 * MIN, { down: false });
  assert.equal(found.length, 1);
  assert.equal(found[0].sig, "pulse|deploy_open_regress");
  assert.deepEqual(found[0].sample.suspect_commits, ["wkend01"]);
  assert.match(found[0].sample.what_got_worse.join("; "), /trades in the first 30 minutes 60 -> 0/);
  assert.match(found[0].sample.what_got_worse.join("; "), /robot's order step stopped working/);
  assert.equal(st.dep.length, 0);
  // A build made in market hours has nothing to wait for.
  const st2 = { dep: [{ sha: "day0001", at: friOpen + 2 * HOUR, stage: "window" }] };
  await deployWatch(w.env, st2, friOpen + 2 * HOUR + 16 * MIN, { down: false });
  assert.equal(st2.dep.length, 0);
});

// ---------- a fix "held" only if the robot is clean too ----------

test("held: robot runs since the fix must be clean", () => {
  assert.deepEqual(robotClean([]), { known: false, clean: true, runs: 0 });
  assert.equal(robotClean([{ t: 1, ok: 1 }]).clean, false, "one run is not enough");
  assert.equal(robotClean([{ t: 1, ok: 1 }, { t: 2, ok: 1 }]).clean, true);
  assert.equal(robotClean([{ t: 1, ok: 0 }, { t: 2, ok: 1 }, { t: 3, ok: 1 }, { t: 4, ok: 1 }]).clean, true, "an old failure, three clean runs since");
  const bad = robotClean([{ t: 1, ok: 1 }, { t: 2, ok: 1 }, { t: 3, ok: 1 }, { t: 3, ok: 0 }]);
  assert.equal(bad.clean, false); assert.match(bad.why, /failed in 1 of its last 3 runs/);
});

test("held: errors going quiet is not enough while the robot still fails in that area", async () => {
  const run = async (robotOk) => {
    const w = makeWorld();
    await ingest(w.env, w.deps, { src: "py", events: [crash()] });       // /api/quote = trading
    const fp = w.calls("ops_issue_upsert")[0].p.fp, live = w.t;
    w.pulse = () => ({ ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades: 0, views: 0 },
      watches: [{ attempt_id: 4, issue_id: 100, fp, live_at: new Date(live).toISOString(), expected: {} }] });
    for (const h of [1, 2, 3]) await w.env.DB.prepare("INSERT INTO robot_run (t, step, ok, ms) VALUES (?1, 'prices', ?2, 5)").bind(live + h * HOUR, robotOk).run();
    await w.env.DB.prepare("INSERT INTO robot_run (t, step, ok, ms) VALUES (?1, 'saathi', 0, 5)").bind(live + HOUR).run();   // another area: not its business
    for (let i = 0; i < 14; i++) { await runPulse(w.env, w.deps); w.tick(); }
    for (let i = 0; i < 64; i++) { w.tick(30 * MIN); await runPulse(w.env, w.deps); }      // 32 hours
    return w;
  };
  const good = await run(1);
  const v = good.calls("ops_attempt_verdict").at(-1).p;
  assert.equal(v.verdict, "held"); assert.match(v.note, /robot's journey there is clean \(3 runs\)/);
  const w = await run(0);
  assert.equal(w.calls("ops_attempt_verdict").at(-1).p.verdict, null, "32 quiet hours, but the robot cannot fetch a price: not held");
  for (let i = 0; i < 40; i++) { w.tick(30 * MIN); await runPulse(w.env, w.deps); }        // past 48 hours
  const late = w.calls("ops_attempt_verdict").at(-1).p;
  assert.equal(late.verdict, "no_effect"); assert.match(late.note, /errors stopped, but the robot's journey failed in 3 of its last 3 runs/);
});

// ---------- the brief: three states, never a guess ----------

test("brief: numbers say ok, bad or unknown; the calendar and the robot are in it", async () => {
  const w = makeWorld(Date.UTC(2026, 10, 15, 15, 30, 0));   // Sunday 21:00 IST
  const h1 = Math.floor(w.t / HOUR);
  const put = (vital, hour, v) => w.env.DB.prepare("INSERT INTO vital_hour (vital, hour, v) VALUES (?1, ?2, ?3)").bind(vital, hour, v).run();
  for (let i = 1; i <= 20; i++) { await put("signups", h1 - i, 1); await put("signups", h1 - i - 168, 10); await put("views", h1 - i, 50); await put("views", h1 - i - 168, 55); }
  for (let i = 1; i <= 4; i++) await put("trades", h1 - i, 0);
  const b = await buildBrief(w.env, w.deps, { rows: [], usage: U, paused: false, log: [], origin: null });
  assert.match(b.body, /sign-ups 20 \[bad\] \(200 a week ago\)/);
  assert.match(b.body, /page activity 1,000 \[ok\]/);
  assert.match(b.body, /trades 0 \[unknown\]/, "4 of 21 hours measured: not enough to say");
  assert.match(b.body, /Calendar: the market is closed today \(weekend\); next open Mon 16 Nov 09:15 IST\. Almost no trades is normal today\./);
  assert.match(b.body, /Robot journey \[unknown\]: the robot has not run yet\./);
  await kvPut(w.env, "senses", { at: w.t, funnel: judgeFunnel([...funnelRows("chatgpt", 12), ...funnelRows("google", 12, { r: 3 }), ...funnelRows("direct", 3)]), returning: judgeReturning([]) }, w.t).run();
  const b2 = await buildBrief(w.env, w.deps, { rows: [], usage: U, paused: false, log: [], origin: null });
  assert.match(b2.body, /Sign-up funnel by source[^\n]*ChatGPT \[ok\] 200 visitors/);
  assert.match(b2.body, /Google \[bad\] 200 visitors \(reach sign-up 1\.5%, usual 10\.5%\)/);
  assert.match(b2.body, /direct visits \[unknown\]/);
  assert.match(b2.body, /New users who came back: day 1 \[unknown\], day 7 \[unknown\], day 30 \[unknown\]/);
});

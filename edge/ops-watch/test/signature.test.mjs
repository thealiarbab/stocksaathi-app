import test from "node:test";
import assert from "node:assert/strict";
import { scrub, scrubDeep, normalize, describe, fingerprint, sample } from "../src/signature.js";
import { parseCron, cronMatches, prevRun } from "../src/cronexpr.js";

test("private values never survive scrubbing", () => {
  const s = scrub("user a.b+c@example.co.in tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456 Bearer abcdefgh12345678 from 103.21.44.9 id 63aee5be-4eaa-409d-9c1e-f60c4daa5823 call 9876543210 /x?token=abc123&op=y");
  for (const leak of ["example.co.in", "eyJhbGci", "abcdefgh12345678", "103.21.44.9", "63aee5be", "9876543210", "abc123"]) assert.ok(!s.includes(leak), leak);
  assert.match(s, /<email>/); assert.match(s, /<jwt>/); assert.match(s, /<ip>/); assert.match(s, /<uuid>/); assert.match(s, /<phone>/);
  assert.match(s, /op=y/, "harmless parameters stay");
});

test("scrubDeep redacts secret-looking keys and bounds size", () => {
  const o = scrubDeep({ password: "hunter2", note: "mail me x@y.io", deep: { a: { b: { c: { d: 1 } } } }, list: Array(50).fill("z") });
  assert.equal(o.password, "<redacted>");
  assert.equal(o.note, "mail me <email>");
  assert.equal(o.list.length, 12);
  assert.equal(o.deep.a.b.c, null);
});

test("prices and version numbers are not mistaken for phones or addresses", () => {
  assert.equal(scrub("price 2847.35 qty 10"), "price 2847.35 qty 10");
  assert.equal(scrub("took 1234567890123 ms"), "took 1234567890123 ms");
});

test("the same problem keeps one signature across builds and values", async () => {
  const a = describe("browser", { kind: "error", target: "Cannot read properties of null (reading 'value')", props: { src: "/assets/core.1074fd29.js:1:88213" }, path: "/trade" });
  const b = describe("browser", { kind: "error", target: "Cannot read properties of null (reading 'value')", props: { src: "/assets/core.9ab3c55e.js:1:90117" }, path: "/portfolio" });
  assert.equal(a.sig, b.sig);
  assert.equal(await fingerprint(a.sig), await fingerprint(b.sig));
  const c = describe("browser", { kind: "error", target: "Cannot read properties of null (reading 'checked')", props: { src: "/assets/core.9ab3c55e.js:1:90117" } });
  assert.notEqual(a.sig, c.sig, "a different property is a different bug");

  const p1 = describe("py", { kind: "exception", route: "/api/history?symbol=TCS&range=1mo", etype: "KeyError", msg: "'chart' for TCS.NS after 3 tries", frames: ["handlers/history.py:fetch"] });
  const p2 = describe("py", { kind: "exception", route: "/api/history?symbol=INFY&range=5d", etype: "KeyError", msg: "'chart' for INFY.NS after 7 tries", frames: ["handlers/history.py:fetch"] });
  assert.equal(p1.sig, p2.sig);
  assert.equal(p1.route, "/api/history");
  const j = describe("js", { kind: "http5xx", route: "/api/ai?op=news&x=1", status: 502, code: "query_failed" });
  assert.equal(j.route, "/api/ai?op=news");
});

test("a visitor leaving or being offline is not a problem", () => {
  assert.equal(describe("browser", { kind: "api", target: "/api/live-quote", props: { st: "left page" } }), null);
  assert.equal(describe("browser", { kind: "api", target: "/api/live-quote", props: { st: "offline" } }), null);
  assert.equal(describe("browser", { kind: "api", target: "/api/live-quote", props: { st: "network error" } }).kind, "api5");
  assert.equal(describe("browser", { kind: "api", target: "/api/live-quote", props: { st: 502 } }).kind, "api5");
  assert.equal(describe("browser", { kind: "api", target: "db /rpc/x", props: { st: 401 } }).kind, "api4");
  assert.equal(describe("browser", { kind: "api", target: "/api/quote", props: { st: 200, ms: 4000 } }).kind, "apislow");
  assert.equal(describe("browser", { kind: "page", target: "x" }), null);
  assert.equal(describe("nope", { kind: "exception" }), null);
});

test("stored samples are scrubbed", () => {
  const s = sample("py", { kind: "exception", route: "/api/x", msg: "failed for user a@b.com", frames: ["handlers/x.py:go"], t: 5 }, 10);
  assert.equal(s.msg, "failed for user <email>");
  assert.equal(s.t, 5);
});

test("cron: when should a job last have run", () => {
  const every5 = parseCron("*/5 * * * *");
  const t = Date.UTC(2026, 10, 12, 10, 7, 30);
  assert.equal(prevRun(every5, t), Date.UTC(2026, 10, 12, 10, 5));
  const matcher = parseCron("* 3-10 * * 1-5");
  assert.ok(matcher.everyMinute);
  assert.ok(cronMatches(matcher, Date.UTC(2026, 10, 12, 3, 0)));         // Thursday
  assert.ok(!cronMatches(matcher, Date.UTC(2026, 10, 14, 5, 0)));        // Saturday
  assert.equal(prevRun(matcher, Date.UTC(2026, 10, 14, 5, 0)), Date.UTC(2026, 10, 13, 10, 59));
  const odd = parseCron("13,43 0-2,11-23 * * *");
  assert.equal(prevRun(odd, Date.UTC(2026, 10, 12, 5, 0)), Date.UTC(2026, 10, 12, 2, 43));
  assert.equal(parseCron("30 seconds"), null);
  assert.equal(parseCron("61 * * * *"), null);
});

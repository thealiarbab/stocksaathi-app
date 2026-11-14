// A stand-in for Cloudflare D1 on top of Node's built-in SQLite, so the tests
// run the collector's real SQL.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    _exec() {
      const s = db.prepare(sql);
      const reads = /^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql);
      if (reads) return { success: true, results: s.all(...this.args).map((r) => ({ ...r })), meta: { changes: 0 } };
      const r = s.run(...this.args);
      return { success: true, results: [], meta: { changes: Number(r.changes) } };
    },
    async run() { return this._exec(); },
    async all() { return this._exec(); },
    async first() { return this._exec().results[0] ?? null; },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec("BEGIN");
      try { const out = list.map((s) => s._exec()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

// Fake outside world: a clock, the main database's functions, mail, fetch.
export function makeWorld(start = Date.UTC(2026, 10, 12, 6, 0, 0)) {
  const w = {
    t: start,
    rpcs: [], mails: [], fetches: [], wakes: [],
    wakeReply: null,       // what the agent's start address answers; default: started
    dbUp: true, siteUp: true, apiUp: true,
    nextId: 100,
    pulse: null,           // function (p) -> data for ops_db_pulse
    env: null,
  };
  w.env = { DB: makeD1(), SITE_URL: "https://site.test", OPS_SECRET: "s3cret", SUPABASE_URL: "https://db.test", SUPABASE_ANON_KEY: "anon" };
  w.deps = {
    now: () => w.t,
    async fetch(url, init) {
      w.fetches.push({ url, init });
      const up = url.includes("/api/") ? w.apiUp : w.siteUp;
      if (!up || url.includes("__ops_watch_test_")) return { status: 503 };
      return { status: 200 };
    },
    async rpc(name, p) {
      w.rpcs.push({ name, p });
      if (!w.dbUp) return { ok: false, status: 0, ms: 7000 };
      if (name === "ops_db_pulse") return { ok: true, status: 200, ms: 40, data: w.pulse ? w.pulse(p) : { ok: true, now: new Date(w.t).toISOString(), conns: 20, max_conn: 60, longest_s: 0, dead: 0, hit: 1, read: 1, ins: { signups: 0, trades: 0, views: 0 } } };
      if (name === "ops_issue_upsert") return { ok: true, status: 200, ms: 30, data: { ok: true, id: w.nextId++, status: "open" } };
      return { ok: true, status: 200, ms: 20, data: { ok: true } };
    },
    async mail(title, body, opts) { w.mails.push({ title, body, opts }); return true; },
    async wake(text) { w.wakes.push(text); return w.wakeReply || { ok: true, status: 200, id: `sess${w.wakes.length}` }; },
  };
  w.calls = (name) => w.rpcs.filter((r) => r.name === name);
  w.tick = (ms = 60_000) => { w.t += ms; };
  return w;
}

// The journey robot. Every 10 minutes it does what a student does, from
// outside, with one permanent test account: opens the sign-up page, logs in,
// loads the portfolio, fetches a price, places a small paper order, and once
// an hour asks Saathi a real question. It catches what throws no error: a
// login that quietly stopped working, prices that stopped arriving.
//
// It runs in its own scheduled call (minute 4 of every ten; minute 5 is a
// second try when something failed) and keeps its own record (kv "robot"),
// so it never touches the one-minute pulse's state.
//
// The test account is marked in the main database (ops_test_accounts) and is
// kept out of every business number. Its password lives only in the watcher.

import { record, kvGet, kvPut, sendOrQueue } from "./core.js";
import { fingerprint } from "./signature.js";
import { readStatus, blameOf } from "./outside.js";
import { marketOpen, istDay, istHour } from "./rules.js";
import { isNseTradingDay } from "../../../js/data/nseCalendar.js";

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;

const SYMBOLS = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "ITC", "LT", "BHARTIARTL", "HINDUNILVR", "AXISBANK", "MARUTI"];
const PAGES = ["/portfolio", "/learn", "/news", "/report-card", "/chat", "/markets"];
const QUESTIONS = [
  "What is a stop loss, in two sentences?",
  "Explain what a P/E ratio tells me, briefly.",
  "What is the difference between a limit order and a market order?",
  "Why do people say not to put all the money in one stock?",
  "What does it mean when a stock hits its 52-week high?",
  "What is an index fund, in simple words?",
];

// Which part of the product each step belongs to (the owner's four areas).
export const STEP_AREA = { register: "signup", login: "signup", portfolio: "trading", prices: "trading", order: "trading", trade: "trading", saathi: "saathi", page: "core" };
const ROUTE = { register: "/register", login: "db /auth/v1/token", portfolio: "/portfolio", prices: "/api/live-quote", order: "place_limit_order", trade: "apply_trade", saathi: "/api/chat", page: "/" };
const TITLE = {
  register: "Robot: the sign-up page or the sign-up service is not answering",
  login: "Robot: the test account cannot log in",
  portfolio: "Robot: the portfolio does not load after login",
  prices: "Robot: live prices are not coming through",
  order: "Robot: a paper order cannot be placed",
  trade: "Robot: a paper trade does not go through",
  saathi: "Robot: Saathi does not answer a question",
  page: "Robot: a main page does not load",
};

const short = (x) => String(x ?? "").replace(/\s+/g, " ").slice(0, 160);
// What a failed call said, without anything private: the status and the
// service's own short error code.
const said = (r) => short(`status ${r?.status ?? 0}${r?.err ? ` ${r.err}` : ""}${r?.json ? ` ${r.json.error_code || r.json.code || r.json.error || r.json.msg || r.json.message || r.json.why || ""}` : ""}`);

export async function runRobot(env, deps, opts = {}) {
  const now = deps.now();
  if (!env.ROBOT_PASSWORD || !env.ROBOT_EMAIL) return { ok: false, why: "not_configured" };
  const minute = Math.floor(now / MIN), mm = new Date(now).getUTCMinutes();
  const R = (await kvGet(env, "robot")) || {};
  R.n ||= 0; R.streak ||= {}; R.open ||= {}; R.passed ||= {}; R.tr ||= 0;
  const retry = !opts.force && mm % 10 === 5;
  if (retry && !(R.last?.fail || []).length) return { ok: true, skipped: "nothing_to_retry" };
  if (!opts.force && !retry && mm % 10 !== 4) return { ok: true, skipped: "not_due" };

  const n = R.n++;
  const sym = SYMBOLS[n % SYMBOLS.length], pagePath = PAGES[n % PAGES.length];
  const askSaathi = opts.saathi === true || (retry ? (R.last?.fail || []).includes("saathi") : !opts.force && Math.floor(mm / 10) === 3);
  const SB = env.SUPABASE_URL, SITE = env.SITE_URL, key = env.SUPABASE_ANON_KEY;
  const UA = { "User-Agent": "StockSaathi-OpsRobot/1" };
  const out = [];
  const step = async (name, what, fn) => {
    const t0 = deps.now();
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, why: `threw ${short(e?.message || e)}` }; }
    out.push({ step: name, ok: r.ok ? 1 : 0, ms: Math.max(0, deps.now() - t0), why: r.ok ? null : short(r.why), what: what || null });
    return r;
  };

  // The status pages of the services we depend on, read on the main run.
  let status = await kvGet(env, "outside");
  if (!retry) {
    try { status = await readStatus(deps); await kvPut(env, "outside", status, now).run(); } catch {}
  }

  // 1. Sign-up: the page loads and the sign-up service answers. No account is made.
  await step("register", "/register", async () => {
    const p = await deps.http(`${SITE}/register`, { headers: UA });
    if (p.status !== 200) return { ok: false, why: `page ${said(p)}` };
    const s = await deps.http(`${SB}/auth/v1/settings`, { headers: { apikey: key } });
    if (s.status !== 200 || !s.json || s.json.external?.email !== true) return { ok: false, why: `sign-up service ${said(s)}` };
    return { ok: true };
  });

  // 2. Log in.
  let token = null;
  await step("login", null, async () => {
    const r = await deps.http(`${SB}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ email: env.ROBOT_EMAIL, password: env.ROBOT_PASSWORD }),
    });
    token = typeof r.json?.access_token === "string" ? r.json.access_token : null;
    return token ? { ok: true } : { ok: false, why: said(r) };
  });
  const asUser = token ? { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${token}` } : null;
  const call = (fn, body) => deps.http(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers: asUser, body: JSON.stringify(body || {}) });

  // 3. The portfolio, as the signed-in page reads it.
  if (asUser) await step("portfolio", null, async () => {
    const p = await deps.http(`${SB}/rest/v1/portfolios?select=cash_paise&limit=1`, { headers: asUser });
    if (p.status !== 200 || !Array.isArray(p.json) || !p.json.length) return { ok: false, why: `cash ${said(p)}` };
    const h = await deps.http(`${SB}/rest/v1/holdings?select=symbol,qty&limit=20`, { headers: asUser });
    if (h.status !== 200 || !Array.isArray(h.json)) return { ok: false, why: `holdings ${said(h)}` };
    return { ok: true };
  });

  // 4. One of the main pages, a different one each run.
  await step("page", pagePath, async () => {
    const p = await deps.http(`${SITE}${pagePath}`, { headers: UA });
    return p.status >= 200 && p.status < 400 ? { ok: true } : { ok: false, why: said(p) };
  });

  // 5. A live price, a different stock each run.
  let price = null;
  await step("prices", sym, async () => {
    const q = await deps.http(`${SITE}/api/live-quote?symbols=${sym}`, { headers: UA });
    const p = Number(q.json?.quotes?.[sym]?.price);
    if (q.status !== 200 || !(p > 0)) return { ok: false, why: said(q) };
    price = p;
    return { ok: true };
  });

  // 6. A small paper order: a buy 3% under the price, cancelled at once, so
  // no trade is ever recorded for it.
  if (asUser && price) {
    await step("order", sym, async () => {
      const placed = await call("place_limit_order", { p_symbol: sym, p_side: "BUY", p_qty: 1, p_limit_price_paise: Math.round(price * 97), p_order_type: "LIMIT" });
      const id = placed.json?.order_id || placed.json?.id;
      if (placed.status !== 200 || placed.json?.ok === false || !id) return { ok: false, why: `place ${said(placed)}` };
      const gone = await call("cancel_limit_order", { p_order_id: id });
      if (gone.status !== 200 || gone.json?.ok === false) return { ok: false, why: `cancel ${said(gone)}` };
      return { ok: true };
    });
    // Once an hour while the market is open: one real paper buy and sell.
    const hour = Math.floor(now / HOUR);
    if (marketOpen(now, isNseTradingDay) && R.tradeHour !== hour && !retry) {
      R.tradeHour = hour;
      await step("trade", sym, async () => {
        for (const side of ["BUY", "SELL"]) {
          const t = await call("apply_trade", { p_symbol: sym, p_side: side, p_qty: 1, p_price_paise: Math.round(price * 100), p_idempotency_key: `robot-${minute}-${side}`, p_bias_flags: null });
          if (t.status !== 200 || t.json?.ok === false || t.json?.error) return { ok: false, why: `${side.toLowerCase()} ${said(t)}` };
          R.tr++;
        }
        return { ok: true };
      });
    }
  }

  // 7. Saathi, once an hour only (each question costs AI money).
  if (askSaathi) {
    const q = QUESTIONS[Math.floor(now / HOUR) % QUESTIONS.length];
    await step("saathi", `q${QUESTIONS.indexOf(q)}`, async () => {
      const r = await deps.http(`${SITE}/api/chat`, {
        method: "POST", timeoutMs: 25000,
        headers: { "Content-Type": "application/json", Origin: SITE, "X-Saathi-Feature": "ops-robot", ...UA },
        body: JSON.stringify({ messages: [{ role: "user", content: q }], profile: "fast", max_tokens: 80, stream: false }),
      });
      const text = r.json?.choices?.[0]?.message?.content;
      return r.status === 200 && typeof text === "string" && text.trim().length >= 2 ? { ok: true } : { ok: false, why: said(r) };
    });
  }

  // Once a day after the market has closed: the test portfolio starts again.
  const today = istDay(now);
  if (asUser && R.resetDay !== today && istHour(now) >= 16) {
    R.resetDay = today;
    try { const r = await call("reset_my_portfolio", {}); R.reset = { at: now, ok: r.status === 200 && r.json?.ok !== false }; } catch { R.reset = { at: now, ok: false }; }
  }

  // ---- the books ----
  const t = minute * MIN;
  const set = out.map((s) => env.DB.prepare("INSERT OR REPLACE INTO robot_run (t, step, ok, ms, why, what) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(t, s.step, s.ok, s.ms, s.why, s.what));

  // ---- judging: a step that fails in two runs in a row becomes an issue ----
  const items = [], back = [];
  for (const s of out) {
    if (s.ok) {
      R.passed[s.step] = 1; R.streak[s.step] = 0;
      if (R.open[s.step]) { back.push(s.step); delete R.open[s.step]; }
      continue;
    }
    R.streak[s.step] = (R.streak[s.step] || 0) + 1;
    // A step that has never once passed cannot have broken: it is logged
    // (see /status), not raised. This also covers the robot's own first day.
    if (!R.passed[s.step] || R.streak[s.step] < 2) continue;
    const sig = `robot|${s.step}`;
    const service = blameOf({ sig, route: ROUTE[s.step] }, { why: s.why }, status, now);
    const sample = { t: now, step: s.step, why: s.why, ms: s.ms, tried_with: s.what, runs_failed_in_a_row: R.streak[s.step] };
    items.push({
      d: { sig, src: "robot", kind: "pulse", route: ROUTE[s.step], title: TITLE[s.step], trusted: 1, severity: service ? "medium" : "high", outside: service || undefined },
      n: 1, who: new Set(), first: sample, last: sample,
    });
    R.open[s.step] = R.open[s.step] || now;
  }
  R.last = { at: now, retry, ok: out.filter((s) => s.ok).map((s) => s.step), fail: out.filter((s) => !s.ok).map((s) => s.step), why: Object.fromEntries(out.filter((s) => !s.ok).map((s) => [s.step, s.why])) };
  set.push(kvPut(env, "robot", R, now));
  await env.DB.batch(set);
  if (items.length) await record(env, deps, items, {});
  for (const name of back) {
    await sendOrQueue(env, deps, "ops_issue_note", { fp: await fingerprint(`robot|${name}`), event: "recovered", note: `The robot's ${name} step works again.` });
  }
  return { ok: true, steps: out.map((s) => ({ step: s.step, ok: !!s.ok, ms: s.ms, why: s.why })), raised: items.length, recovered: back };
}

// Is the robot's journey clean for one area of the product since `since`?
// Used before a fix is called "held": errors going quiet is not enough if the
// robot still cannot get through.
//   rows: [{ t, ok }] of that area's steps, any order
export function robotClean(rows) {
  const runs = new Map();
  for (const r of rows || []) runs.set(r.t, (runs.get(r.t) ?? true) && !!r.ok);
  const order = [...runs.keys()].sort((a, b) => b - a);
  if (!order.length) return { known: false, clean: true, runs: 0 };
  if (order.length < 2) return { known: true, clean: false, runs: order.length, why: "the robot has run only once since the fix" };
  const lastThree = order.slice(0, 3);
  const failing = lastThree.filter((k) => !runs.get(k)).length;
  return failing ? { known: true, clean: false, runs: order.length, why: `the robot's journey failed in ${failing} of its last ${lastThree.length} runs` } : { known: true, clean: true, runs: order.length };
}

export async function robotSince(env, area, since) {
  const steps = Object.entries(STEP_AREA).filter(([, a]) => a === area).map(([s]) => s);
  if (!steps.length) return { known: false, clean: true, runs: 0 };
  const marks = steps.map((_, i) => `?${i + 2}`).join(",");
  const r = await env.DB.prepare(`SELECT t, ok FROM robot_run WHERE t > ?1 AND step IN (${marks}) ORDER BY t DESC LIMIT 60`).bind(since, ...steps).all();
  return robotClean(r.results || []);
}

// For /status and the daily brief: three states, never a guess.
export async function robotView(env, now) {
  const R = (await kvGet(env, "robot")) || null;
  if (!R?.last) return { state: "unknown", why: "the robot has not run yet" };
  const age = now - R.last.at;
  const day = await env.DB.prepare("SELECT COUNT(DISTINCT t) runs, COUNT(DISTINCT CASE WHEN ok = 0 THEN t END) bad FROM robot_run WHERE t >= ?1").bind(now - DAY).first();
  const never = Object.keys(STEP_AREA).filter((s) => !R.passed?.[s]);
  return {
    state: age > 30 * MIN ? "unknown" : R.last.fail.length ? "bad" : "ok",
    why: age > 30 * MIN ? `no robot run for ${Math.round(age / MIN)} minutes` : undefined,
    last_at: R.last.at, age_min: Math.round(age / MIN), passed: R.last.ok, failed: R.last.fail, failed_why: R.last.why,
    open: Object.keys(R.open || {}), never_passed_yet: never,
    runs_24h: day?.runs || 0, runs_with_failure_24h: day?.bad || 0, paper_trades_made: R.tr || 0, last_reset: R.reset || null,
  };
}

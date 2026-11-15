// Senses that read numbers instead of errors:
//   - sign-up truth: the site's own count of form submits against the
//     accounts the database really created and confirmed;
//   - funnels by source and returning users, each against its own history;
//   - every new build watched for 15 minutes and through the next market open.
// The judging functions are pure; the small runners below them do the reads.

import { kvGet, kvPut } from "./core.js";
import { baseline, watchWindow, marketOpen } from "./rules.js";
import { blameOf } from "./outside.js";
import { nextOpen, prevOpen } from "./calendar.js";
import { isNseTradingDay } from "../../../js/data/nseCalendar.js";

const MIN = 60_000, DAY = 86400_000;

// ---------- sign-up truth ----------

// f30 / f60: { view, start, submit, error, otp } counted by the site in the
// last 30 / 60 minutes. db: what ops_senses() returned. First-guess limits
// from 14 days of data (about 1.6 form submits and 1.8 e-mail accounts an hour).
export function signupTruth(f30, f60, db) {
  const out = [];
  if (!db || db.ok === false) return out;
  const stuck = (w, f, made, severity) => ({
    sig: "vital|signups|stuck", severity,
    title: "People are sending the sign-up form but no account is being created",
    sample: { window_min: w, form_submits: f.submit || 0, form_errors_shown: f.error || 0, register_page_views: f.view || 0, accounts_created: made },
  });
  if ((f60?.submit || 0) >= 8 && db.email_created_60 === 0) out.push(stuck(60, f60, 0, "critical"));
  else if ((f30?.submit || 0) >= 7 && db.email_created_30 === 0) out.push(stuck(30, f30, 0, "high"));
  if (db.email_created_60 >= 8 && db.confirmed_60 === 0) {
    out.push({
      sig: "vital|signups|unconfirmed", severity: "critical",
      title: "New accounts are not being confirmed: the code e-mail may not be arriving",
      sample: { window_min: 60, email_accounts_created: db.email_created_60, confirmed: 0, code_entries_seen: f60?.otp || 0 },
    });
  }
  return out;
}

export async function flowSums(env, now, minutes) {
  const r = await env.DB.prepare("SELECT k, SUM(n) n FROM flow WHERE bucket >= ?1 GROUP BY k").bind(Math.floor((now - minutes * MIN) / 600_000)).all();
  return Object.fromEntries((r.results || []).map((x) => [x.k, x.n]));
}

export async function signupCheck(env, deps, now) {
  const r = await deps.rpc("ops_senses", {});
  if (!r.ok || !r.data?.ok) return [];
  const [f30, f60, status] = [await flowSums(env, now, 30), await flowSums(env, now, 60), await kvGet(env, "outside")];
  return signupTruth(f30, f60, r.data).map((f) => {
    const outside = blameOf({ sig: f.sig }, f.sample, status, now);
    return { ...f, kind: "vital", sample: { t: now, ...f.sample }, outside: outside || undefined, severity: outside ? "medium" : f.severity };
  });
}

// ---------- funnels by source ----------

export const SOURCE_NAME = { chatgpt: "ChatGPT", ai_other: "other AI assistants", google: "Google", search_other: "other search engines", social: "social media", direct: "direct visits", other: "other sites" };
const STEP_WORD = { register: "open the sign-up page", account: "create an account", trade: "make a first trade" };
const RATE = {
  register: (d) => (d.v > 0 ? d.r / d.v : null),
  account: (d) => (d.v > 0 ? d.a / d.v : null),
  trade: (d) => (d.a >= 5 ? d.t / d.a : null),
};
const tooLow = (value, base, part) => base.med > 0 && value < base.med - Math.max(4 * base.mad, part * base.med);

// rows: [{ day, src, v, r, a, t }] (visitors, reached register, made an
// account, traded within 48 hours). Each source is judged against its own
// last 28 days. Three states: ok, bad, unknown (too little to say).
export function judgeFunnel(rows) {
  const by = new Map();
  for (const r of rows || []) { if (!by.has(r.src)) by.set(r.src, []); by.get(r.src).push(r); }
  const out = [];
  for (const [src, list] of by) {
    list.sort((a, b) => (a.day < b.day ? -1 : 1));
    const last = list[list.length - 1];
    const from = Date.parse(last.day) - 28 * DAY;
    const hist = list.slice(0, -1).filter((d) => Date.parse(d.day) >= from && d.v >= 30);
    for (const step of Object.keys(RATE)) {
      const value = RATE[step](last);
      const xs = hist.map(RATE[step]).filter((x) => Number.isFinite(x));
      const base = xs.length >= 7 ? baseline(xs) : null;
      const row = { src, step, day: last.day, visitors: last.v, value, usual: base ? base.med : null, days: xs.length };
      if (last.v < 30 || value == null) out.push({ ...row, state: "unknown", why: "too few visitors that day" });
      else if (!base) out.push({ ...row, state: "unknown", why: `only ${xs.length} earlier day(s) to compare with, 7 needed` });
      else out.push({ ...row, state: tooLow(value, base, 0.5) ? "bad" : "ok" });
    }
  }
  return out;
}

// weeks: [{ week, n, n1, d1, n7, d7, n30, d30 }]. nK = accounts old enough to
// be counted for day K, dK = how many of them came back that day.
export function judgeReturning(weeks) {
  const list = [...(weeks || [])].sort((a, b) => (a.week < b.week ? -1 : 1));
  const out = [];
  for (const k of [1, 7, 30]) {
    const full = list.filter((w) => w.n >= 30 && w[`n${k}`] >= 0.9 * w.n);
    const last = full[full.length - 1];
    if (!last) { out.push({ k, state: "unknown", why: "no sign-up week is old enough yet" }); continue; }
    const value = last[`d${k}`] / last[`n${k}`];
    const xs = full.slice(0, -1).map((w) => w[`d${k}`] / w[`n${k}`]);
    const base = baseline(xs);
    const row = { k, week: last.week, n: last[`n${k}`], value, usual: base ? base.med : null, weeks: xs.length };
    if (!base) out.push({ ...row, state: "unknown", why: `only ${xs.length} earlier week(s) to compare with, 3 needed` });
    else out.push({ ...row, state: tooLow(value, base, 0.4) ? "bad" : "ok" });
  }
  return out;
}

const pc = (x) => (Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : "?");

// Once a night. A funnel step has to be bad two days running before it
// becomes an issue; returning users are judged once a week.
export async function nightlySenses(env, deps, now) {
  const r = await deps.rpc("ops_senses", { full: true });
  if (!r.ok || !r.data?.ok) return [];
  const prev = (await kvGet(env, "senses")) || {};
  const funnel = judgeFunnel(r.data.funnel || []);
  const returning = judgeReturning(r.data.returning || []);
  const bad = {}, found = [];
  for (const f of funnel) {
    if (f.state !== "bad") continue;
    const key = `${f.src}|${f.step}`, was = prev.bad?.[key];
    bad[key] = was && was.day === f.day ? was : { day: f.day, n: (was?.n || 0) + 1 };
    if (bad[key].n < 2 || (was && was.day === f.day)) continue;
    found.push({
      kind: "vital", sig: `vital|signups|funnel|${key}`, severity: "medium",
      title: `Fewer visitors from ${SOURCE_NAME[f.src] || f.src} ${STEP_WORD[f.step]} than usual, two days running`,
      sample: { t: now, day: f.day, source: f.src, step: f.step, share: pc(f.value), usual_share: pc(f.usual), visitors_that_day: f.visitors, days_compared: f.days },
    });
  }
  const weekly = new Date(now).getUTCDay() === 0;
  if (weekly) for (const f of returning) {
    if (f.state !== "bad") continue;
    found.push({
      kind: "vital", sig: `vital|returning|d${f.k}`, severity: "low",
      title: `Fewer new users came back on day ${f.k} than usual`,
      sample: { t: now, signup_week: f.week, came_back: pc(f.value), usual: pc(f.usual), accounts_counted: f.n, weeks_compared: f.weeks },
    });
  }
  await kvPut(env, "senses", { at: now, funnel, returning, bad }, now).run();
  return found;
}

// ---------- every build is watched ----------

export async function windowStats(env, from, to) {
  const p = await env.DB.prepare("SELECT AVG(site_ms) sm, AVG(db_ms) dm, COUNT(*) n, COALESCE(SUM(json_extract(d, '$.tr')), 0) tr FROM pulse WHERE t >= ?1 AND t < ?2 AND site = 1 AND db = 1").bind(from, to).first();
  const e = await env.DB.prepare("SELECT COALESCE(SUM(CAST(v AS INTEGER)), 0) n FROM kv WHERE k >= ?1 AND k < ?2")
    .bind(`m:${Math.floor(from / MIN)}`, `m:${Math.floor(to / MIN)}`).first();
  const mins = Math.max((to - from) / MIN, 1);
  return { errRate: (e?.n || 0) / mins, siteMs: p?.sm || 0, dbMs: p?.dm || 0, n: p?.n || 0, trades: p?.tr || 0 };
}

// Robot steps that worked before `from` and failed at least twice since.
async function robotBroke(env, from, to) {
  const r = await env.DB.prepare("SELECT step, COUNT(*) n FROM robot_run WHERE t >= ?1 AND t < ?2 AND ok = 0 GROUP BY step HAVING COUNT(*) >= 2").bind(from, to).all();
  const out = [];
  for (const x of r.results || []) {
    const before = await env.DB.prepare("SELECT ok FROM robot_run WHERE step = ?1 AND t < ?2 ORDER BY t DESC LIMIT 1").bind(x.step, from).first();
    if (before?.ok === 1) out.push(x.step);
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

// st.dep: [{ sha, at, stage: window | open, open? }], filled when a new build
// first reports in. cur: { down } from this minute's checks.
export async function deployWatch(env, st, now, cur) {
  const found = [];
  if (!(st.dep || []).length) return found;
  for (const dep of st.dep) {
    if (dep.stage !== "window") continue;
    const age = now - dep.at;
    if (age < 3 * MIN) continue;
    const b = await windowStats(env, dep.at, now), a = await windowStats(env, dep.at - 10 * MIN, dep.at);
    b.newCrashes = (await env.DB.prepare("SELECT COUNT(*) n FROM sig WHERE kind = 'exc' AND first_seen >= ?1 AND hits >= 3").bind(dep.at).first())?.n || 0;
    b.down = !!cur.down;
    const worse = watchWindow(a, b);
    const broke = await robotBroke(env, dep.at, now + MIN);
    if (broke.length) worse.push(`the robot's ${broke.join(" and ")} step stopped working`);
    if (worse.length) {
      found.push({
        kind: "pulse", sig: "pulse|deploy_regress", severity: "high",
        title: "The site got worse right after a new build went live",
        sample: { t: now, suspect_commit: dep.sha, first_seen_live: iso(dep.at), minutes_after: Math.round(age / MIN), what_got_worse: worse },
      });
      dep.stage = "done";
    } else if (age >= 15 * MIN) {
      // Went live while the market was closed: trading has not been tried on
      // it yet, so it is looked at again half an hour into the next open.
      dep.open = marketOpen(dep.at, isNseTradingDay) ? null : nextOpen(dep.at);
      dep.stage = dep.open ? "open" : "done";
    }
  }
  const due = st.dep.filter((d) => d.stage === "open" && now >= d.open + 30 * MIN);
  if (due.length) {
    const open = due[0].open, before = prevOpen(open);
    const b = await windowStats(env, open, open + 30 * MIN);
    const a = before ? await windowStats(env, before, before + 30 * MIN) : null;
    if (a && a.n >= 20 && b.n >= 20) {
      const worse = watchWindow(a, { ...b, newCrashes: 0, down: false });
      if (a.trades >= 10 && b.trades < 0.3 * a.trades) worse.push(`trades in the first 30 minutes ${a.trades} -> ${b.trades}`);
      const broke = await robotBroke(env, open, open + 30 * MIN);
      if (broke.length) worse.push(`the robot's ${broke.join(" and ")} step stopped working`);
      if (worse.length) {
        found.push({
          kind: "pulse", sig: "pulse|deploy_open_regress", severity: "high",
          title: "The first market open after a new build is worse than the one before",
          sample: { t: now, suspect_commits: due.map((d) => d.sha), market_open: iso(open), compared_with_open: iso(before), what_got_worse: worse },
        });
      }
    }
    for (const d of due) d.stage = "done";
  }
  st.dep = st.dep.filter((d) => d.stage !== "done").slice(-6);
  return found;
}

// Called when a new build is first seen serving traffic.
export function noteDeploy(st, sha, at, now) {
  st.dep ||= [];
  if (now - at > 15 * MIN) return;
  if (st.dep.some((d) => Math.abs(d.at - at) < 3 * MIN && (d.sha.startsWith(sha) || sha.startsWith(d.sha)))) return;
  st.dep.push({ sha, at, stage: "window" });
}

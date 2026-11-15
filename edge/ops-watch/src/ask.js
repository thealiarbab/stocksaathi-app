// The Ask box: one question from the owner, answered by the site's AI from
// the agent's memory (cards, lessons, skills) and this minute's live numbers.
//
// It lives on the signed page (page.js), so the link is the key and it runs
// out after 48 hours. Asking never starts the agent and never changes
// anything. The model call is made by the site (/api/ai?op=ops-ask), which
// records it in the AI usage ledger like every other call.

import { sign } from "./brief.js";
import { gateSummary, loadGate } from "./gaterun.js";
import { usageLine, istClock } from "./gate.js";
import { robotView } from "./robot.js";
import { reflexView } from "./reflex.js";
import { dayInfo } from "./calendar.js";
import { kvGet } from "./core.js";

const HOUR = 3600_000, DAY = 86400_000, IST = 330 * 60_000;
// Not an issue: the fixed name of the Ask page inside a signed link.
export const ASK_ID = "a5c00000000000000a5c";
const PER_DAY = 30;

export async function askLink(env, origin, now) {
  if (!origin) return null;
  const e = now + 48 * HOUR;
  return `${origin}/p?i=${ASK_ID}&e=${e}&k=${await sign(env, ASK_ID, e)}`;
}

// What is true right now, small enough to hand to the model.
export async function liveNumbers(env, deps) {
  const now = deps.now();
  const last = await env.DB.prepare("SELECT t, site, site_ms, api, api_ms, db, db_ms FROM pulse ORDER BY t DESC LIMIT 1").first();
  const up = await env.DB.prepare("SELECT COUNT(*) n, SUM(site) site, SUM(api) api, SUM(db) db FROM pulse WHERE t >= ?1").bind(now - DAY).first();
  const g = await gateSummary(env, deps);
  const rows = await loadGate(env, now);
  const h1 = Math.floor(now / HOUR), h0 = Math.floor((Math.floor((now + IST) / DAY) * DAY - IST) / HOUR);
  const vit = await env.DB.prepare("SELECT vital, SUM(v) s FROM vital_hour WHERE vital IN ('signups', 'trades', 'views') AND hour >= ?1 AND hour < ?2 GROUP BY vital").bind(h0, h1).all();
  const notes = await env.DB.prepare("SELECT at, kind, ref, text FROM note ORDER BY at DESC LIMIT 6").all();
  const robot = await robotView(env, now).catch(() => null);
  return {
    time: istClock(now), calendar: dayInfo(now).line,
    last_check: last ? { seconds_ago: Math.round((now - last.t) / 1000), website_ok: !!last.site, api_ok: !!last.api, database_ok: !!last.db, website_ms: last.site_ms, api_ms: last.api_ms, database_ms: last.db_ms } : null,
    checks_24h: up ? { total: up.n, website_ok: up.site, api_ok: up.api, database_ok: up.db } : null,
    today_so_far: Object.fromEntries((vit.results || []).map((x) => [x.vital, Math.round(x.s)])),
    claude_limits_percent_already_used: usageLine({ known: g.weekly != null, weekly: g.weekly, five: g.five, age: (g.reading_age_min || 0) * 60_000, fresh: (g.reading_age_min || 0) < 36 * 60, weeklyReset: now }, now).replace(/ \(resets[^)]*\)/, ""),
    waking_the_agent: g.paused ? "switched off" : "on",
    agent_starts_today: g.wakes_today, with_agent_now: g.with_agent, waiting_for_owner: g.waiting_count,
    last_agent_start: g.last_log ? { at: istClock(g.last_log.at), mode: g.last_log.mode, issues: g.last_log.ids, started: g.last_log.ok } : null,
    open_issues: rows.slice(0, 20).map((r) => ({ issue: r.id, area: r.area, band: r.band, people_today: r.people, times_today: r.hits, opened: istClock(r.opened), last_seen: istClock(r.lastSeen),
      judge_says: r.reason, with_agent: r.status === "fixing" || r.status === "fix_live", outside_cause: r.outside || undefined, title: String(r.title || "").slice(0, 90) })),
    open_issue_count: rows.length,
    robot: robot ? { state: robot.state, failing: robot.failed || [], runs_24h: robot.runs_24h } : null,
    outside_services: await kvGet(env, "outside"),
    reflexes: await reflexView(env, now, 3),
    self_tuning_and_weekly_score: await kvGet(env, "growth"),
    recent_work_notes: (notes.results || []).map((n) => ({ at: istClock(n.at), ref: n.ref, text: String(n.text).slice(0, 200) })),
  };
}

export async function ask(env, deps, q) {
  const now = deps.now();
  q = String(q || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (q.length < 3) return { ok: false, why: "Type a question first." };
  const dayStart = Math.floor((now + IST) / DAY) * DAY - IST;
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM ask WHERE at >= ?1").bind(dayStart).first();
  if ((n?.n || 0) >= PER_DAY) return { ok: false, why: `That is ${PER_DAY} questions today, the daily cap (each one is a paid AI call). It resets at midnight.` };
  const live = await liveNumbers(env, deps);
  const r = await deps.http(`${env.SITE_URL}/api/ai?op=ops-ask`, {
    method: "POST", timeoutMs: 25000,
    headers: { Authorization: `Bearer ${env.OPS_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q, live }),
  });
  const ok = r.status === 200 && typeof r.json?.answer === "string" && r.json.answer.trim().length > 0;
  const a = ok ? r.json.answer.trim().slice(0, 4000) : null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ask (at, q, a, ok, ms) VALUES (?1, ?2, ?3, ?4, ?5)").bind(now, q, a, ok ? 1 : 0, r.ms || 0),
    env.DB.prepare("DELETE FROM ask WHERE at < ?1").bind(now - 60 * DAY),
  ]);
  if (!ok) {
    const e = r.json?.error;
    return { ok: false, why: e === "slow" || r.status === 504 ? "The site's AI took too long this time. Nothing was changed. Ask again: the second try is usually faster."
      : r.status === 503 || e === "model_failed" ? "The site's AI is busy or switched to saved answers right now. Try again in a few minutes."
        : `The site's AI did not answer (${r.status || "no reply"}). Nothing was changed. Try again in a minute.` };
  }
  return { ok: true, answer: a, used_memory: !!r.json.memory };
}

export async function askPage(req, env, deps, p, html, esc) {
  const now = deps.now();
  const hidden = `<input type="hidden" name="i" value="${esc(p.get("i"))}"><input type="hidden" name="e" value="${esc(p.get("e"))}"><input type="hidden" name="k" value="${esc(p.get("k"))}">`;
  const form = (q = "") => `<div class="card"><div class="t">Ask about the site or the agent</div>
<div class="m">Answered by the site's AI from the agent's memory and this minute's numbers. Asking changes nothing and does not start the agent.</div>
<form method="post" action="/p" style="display:block">${hidden}<textarea name="q" rows="3" maxlength="500" required style="width:100%;box-sizing:border-box;font:inherit;padding:10px;margin-top:10px;border-radius:8px;border:1px solid #9aa4ae;background:transparent;color:inherit">${esc(q)}</textarea><button>Ask</button></form>
<div class="m">Examples: What is open right now? What did the agent do today? Have we seen a slow site at market open before, and what fixed it?</div></div>`;
  let top = "";
  if (req.method === "POST") {
    const q = p.get("q") || "";
    const r = await ask(env, deps, q);
    top = r.ok
      ? `<div class="card"><div class="m">You asked: ${esc(q.slice(0, 500))}</div><div class="t" style="font-weight:400;white-space:pre-wrap;margin-top:8px">${esc(r.answer)}</div>${r.used_memory ? "" : `<div class="m">The agent's memory could not be read for this answer; it used live numbers only.</div>`}</div>`
      : `<div class="card"><div class="t">${esc(r.why)}</div></div>`;
  }
  const old = await env.DB.prepare("SELECT at, q, a FROM ask WHERE ok = 1 ORDER BY id DESC LIMIT ?1").bind(req.method === "POST" ? 6 : 5).all();
  const past = (old.results || []).slice(req.method === "POST" && top.includes("You asked") ? 1 : 0, 6)
    .map((x) => `<div class="card"><div class="m">${esc(istClock(x.at))}: ${esc(x.q)}</div><div style="white-space:pre-wrap;margin-top:8px">${esc(x.a)}</div></div>`).join("");
  return html(200, `${top}${form()}${past ? `<h1 style="margin-top:24px">Earlier answers</h1>${past}` : ""}`);
}

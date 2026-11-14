// The daily brief (21:00 IST) and the signed links it carries. Built from the
// collector's own storage only, so it costs nothing and still goes out when
// the main database is down.
//
// Links never point at the admin panel (its address is private). They point
// at a small page on the collector itself, proven by a signature that runs
// out after 48 hours.

import { usageLine, istClock } from "./gate.js";
import { istDay } from "./rules.js";

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000, IST = 330 * MIN;
const LINK_LIFE = 48 * HOUR;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sign(env, i, e) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.OPS_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`page1|${i}|${e}`))).slice(0, 40);
}

export async function linkFor(env, origin, fp, now) {
  if (!origin) return null;
  const e = now + LINK_LIFE;
  return `${origin}/p?i=${fp}&e=${e}&k=${await sign(env, fp, e)}`;
}

export async function checkLink(env, i, e, k, now) {
  if (!env.OPS_SECRET || typeof i !== "string" || !/^[0-9a-f]{20}$/.test(i) || typeof k !== "string" || k.length !== 40) return false;
  const exp = Number(e);
  if (!Number.isFinite(exp) || exp < now || exp > now + LINK_LIFE + HOUR) return false;
  const want = await sign(env, i, exp);
  let x = 0;
  for (let n = 0; n < 40; n++) x |= want.charCodeAt(n) ^ k.charCodeAt(n);
  return x === 0;
}

// 21:00 IST = 15:30 UTC. A missed minute is caught up until midnight IST.
export function briefDue(now) {
  const d = new Date(now);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 15 * 60 + 30 && m < 18 * 60 + 30;
}

const WAITS = new Set(["tight", "cap", "blind_cap", "five", "nowake", "limit_full"]);
const NEEDS = new Set(["needs_you", "max_wakes"]);
const AREA = { signup: "sign-up", core: "site/API/database", trading: "trading", saathi: "Saathi", other: "other" };
const name = (g) => (g.id ? `#${g.id}` : "(no number yet)");
const line = (g) => `${name(g)} [${AREA[g.area] || g.area}, ${g.band}] ${String(g.title || "").slice(0, 110)}`;
const n0 = (x) => Math.round(x || 0).toLocaleString("en-IN");
const share = (ok, n) => (n ? `${(Math.floor((ok / n) * 1000) / 10).toFixed(1)}%` : "no checks");

export async function buildBrief(env, deps, { rows, usage, paused, log, origin }) {
  const now = deps.now();
  const dayStart = Math.floor((now + IST) / DAY) * DAY - IST;
  const out = [];
  const date = new Date(now + IST);
  out.push(`StockSaathi daily brief, ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()]} ${istClock(now).replace(/ \d\d:\d\d IST$/, "")}`);

  const up = await env.DB.prepare("SELECT COUNT(*) n, SUM(site) site, SUM(api) api, SUM(db) db FROM pulse WHERE t >= ?1").bind(now - DAY).first();
  out.push(`Last 24 hours, one check a minute: website ${share(up?.site, up?.n)}, API ${share(up?.api, up?.n)}, database ${share(up?.db, up?.n)}.`);

  const h0 = Math.floor(dayStart / HOUR), h1 = Math.floor(now / HOUR);
  const sum = async (from, to) => {
    const r = await env.DB.prepare("SELECT vital, SUM(v) s, COUNT(*) n FROM vital_hour WHERE vital IN ('signups', 'trades', 'views') AND hour >= ?1 AND hour < ?2 GROUP BY vital").bind(from, to).all();
    return Object.fromEntries((r.results || []).map((x) => [x.vital, x]));
  };
  const today = await sum(h0, h1), week = await sum(h0 - 168, h1 - 168), yest = await sum(h0 - 24, h1 - 24);
  // Compared with the same hours a week ago; until a week of numbers exists,
  // with the same hours yesterday.
  const cmp = (k, word) => `${word} ${today[k] ? n0(today[k].s) : "?"}${week[k]?.n ? ` (${n0(week[k].s)} a week ago)` : yest[k]?.n ? ` (${n0(yest[k].s)} yesterday by this time)` : ""}`;
  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  out.push(`Today so far: ${cmp("signups", "sign-ups")}, ${cmp("trades", "trades")}, ${cmp("views", "page activity")}.${weekend ? " It is the weekend: the market is closed, so almost no trades is normal." : ""}`);

  const opened = await env.DB.prepare(
    "SELECT g.fp, g.area, g.state, g.why, g.reason, g.status, s.issue_id id, s.title FROM gate g JOIN sig s ON s.fp = g.fp WHERE g.opened >= ?1 ORDER BY g.opened LIMIT 15",
  ).bind(dayStart).all();
  const band = new Map(rows.map((g) => [g.fp, g.band]));
  const openedRows = opened.results || [];
  out.push(openedRows.length
    ? `New today: ${openedRows.length}\n${openedRows.map((g) => `  ${line({ ...g, band: band.get(g.fp) || "closed" })}\n      ${g.state === "closed" ? `closed (${g.status || "done"})` : g.reason || g.state}`).join("\n")}`
    : "New today: nothing.");

  const fixed = await env.DB.prepare("SELECT issue_id id, title FROM sig WHERE state = 'fixed' AND fixed_at >= ?1 ORDER BY fixed_at LIMIT 12").bind(dayStart).all();
  if ((fixed.results || []).length) out.push(`Fixed today: ${fixed.results.length}\n${fixed.results.map((g) => `  ${name(g)} ${String(g.title || "").slice(0, 110)}`).join("\n")}`);

  const waiting = rows.filter((g) => (g.state === "brief" || g.state === "hold") && WAITS.has(g.why));
  if (waiting.length) {
    const items = [];
    for (const g of waiting.slice(0, 12)) {
      const url = await linkFor(env, origin, g.fp, now);
      items.push(`  ${line(g)}\n      ${g.reason}${url ? `\n      Decide: ${url}` : ""}`);
    }
    out.push(`Waiting for your OK: ${waiting.length}\n${items.join("\n")}${origin ? "\n  (Links work for 48 hours.)" : ""}`);
  } else out.push("Waiting for your OK: nothing.");

  const needs = rows.filter((g) => NEEDS.has(g.why) || g.status === "needs_owner" || g.status === "needs_pc");
  if (needs.length) out.push(`Needs you: ${needs.length}\n${needs.slice(0, 12).map((g) => `  ${line(g)}\n      ${g.reason || "see the Issues tab"}`).join("\n")}`);

  const busy = rows.filter((g) => g.status === "fixing" || g.status === "fix_live" || (g.state === "woken" && !NEEDS.has(g.why)));
  if (busy.length) out.push(`With the agent: ${busy.length}\n${busy.slice(0, 12).map((g) => `  ${line(g)}\n      ${g.status === "fixing" ? "being fixed" : g.status === "fix_live" ? "fix is live, being watched" : g.pickedAt ? "looked at, left open" : "started, not picked up yet"}`).join("\n")}`);

  const queued = rows.filter((g) => g.state === "brief" && g.why === "queued").length;
  if (queued) out.push(`Queued for the next batch of small fixes: ${queued}.`);

  const quiet = rows.filter((g) => g.state === "brief" && (g.why === "stopped" || g.why === "backlog" || g.why === "snoozed")).length;
  if (quiet) out.push(`Quiet and left alone: ${quiet} (stopped by themselves, or older than the watcher).`);

  const runs = (log || []).filter((w) => w.at >= dayStart);
  out.push(runs.length
    ? `Agent starts today: ${runs.length}\n${runs.map((w) => `  ${istClock(w.at).slice(-9)} ${w.mode}: ${w.ids?.length ? w.ids.map((x) => (typeof x === "number" ? `#${x}` : x)).join(", ") : "test"}${w.ok === false ? ` (refused: ${w.why})` : w.ok === null ? " (no answer from the start call)" : ""}`).join("\n")}`
    : "Agent starts today: none.");
  out.push(`Claude limits: ${usageLine(usage, now)}.`);
  const held = rows.filter((g) => g.why === "paused").length;
  if (paused) out.push(`Note: waking the agent is switched off, so nothing is fixed automatically.${held ? ` ${held} issue(s) would have gone to the agent by now.` : ""}`);
  return { title: `StockSaathi daily brief: ${openedRows.length} new, ${waiting.length} waiting${needs.length ? `, ${needs.length} need you` : ""}`, body: out.join("\n\n") };
}

export async function sendBrief(env, deps, ctx) {
  const b = await buildBrief(env, deps, ctx);
  return deps.mail(b.title, b.body, { force: true });
}

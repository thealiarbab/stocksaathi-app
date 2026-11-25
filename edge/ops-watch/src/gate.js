// The judge at the door. Decides, for every open issue, whether the agent is
// woken now, later, or not at all. Pure: no storage, no network, no clock of
// its own. Everything here is unit-tested row by row.
//
// Order of importance set by the owner: sign-up and login first, then the
// site/API/database and trading (same level), then Saathi. A real break in
// any of the four is "serious" and wakes the agent whatever the plan limits
// say. Everything else waits 30 minutes and is then weighed against how much
// of the plan is left.

const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;

export const FOUR = new Set(["signup", "core", "trading", "saathi"]);
// Kinds that mean "it does not work", as opposed to slow or a user's own typo.
const FAIL = new Set(["exc", "http", "timeout", "error", "api5", "net", "cron_failed", "cron_failed_minutely", "cron_missed", "pulse", "vital"]);

const RE_SIGNUP = /(^|[\s/])(register|signup|sign-up|login|onboarding|reset-password|verify)(\b|$)|auth\/v(\d+|n)\b|auth-login-hint|send-email|accounts\.google|gsi\b/;
const RE_SAATHI = /\/api\/chat|(^|[\s/])chat(\b|$)|coach|chat_threads|chat_projects|op=(report-card|explain)/;
const RE_TRADING = /match-orders|limit_orders|limit-orders|place_limit_order|live-quote|quote|portfolio|holdings|transactions|snapshot|order|history|fundamentals|(^|[\s/])(stock|stocks|markets|mf)(\b|\/|$)/;
const RE_TRADING_JOB = /order|snapshot|eod|nav|quote|match/;

// The journey robot's steps (see robot.js).
const ROBOT_AREA = { register: "signup", login: "signup", portfolio: "trading", prices: "trading", order: "trading", trade: "trading", saathi: "saathi", page: "core" };
const OUTSIDE = { yahoo: "Yahoo Finance", google_ai: "Google AI", supabase: "Supabase", vercel: "Vercel", resend: "Resend" };

// Which part of the product a signature belongs to.
export function areaOf({ sig = "", kind = "", route = "" } = {}) {
  const s = String(sig), r = String(route || "").toLowerCase();
  if (s.startsWith("robot|")) return ROBOT_AREA[s.split("|")[1]] || "core";
  if (s.startsWith("pulse|")) return /^pulse\|(canary_|baseline_review)/.test(s) ? "other" : "core";
  if (s.startsWith("db|")) return "core";
  if (s.startsWith("vital|")) {
    const v = s.split("|")[1];
    return v === "signups" ? "signup" : v === "trades" ? "trading" : v === "returning" ? "other" : "core";
  }
  if (s.startsWith("cron|")) return RE_TRADING_JOB.test(s.split("|")[1]?.toLowerCase() || "") ? "trading" : "other";
  if (r === "/api/health") return "core";
  if (RE_SIGNUP.test(r)) return "signup";
  if (RE_SAATHI.test(r)) return "saathi";
  if (RE_TRADING.test(r)) return "trading";
  return "other";
}

// serious: one of the four is really broken. middle: not clearly one of the
// four, but many people are hitting it or it is growing; also a first crash
// or a drifting number inside the four, which deserves a look, not an alarm.
// small: the rest.
//   x: { area, sev, kind, trusted, people, hits, openPeople, openHits }
export function bandOf(x) {
  const four = FOUR.has(x.area), fail = FAIL.has(x.kind);
  const p = x.people || 0, h = x.hits || 0;
  if (x.sev === "critical") return "serious";
  if (four && fail) {
    // Outage checks and failed jobs, reported by the watcher itself: no
    // second opinion needed. What browsers report (often a phone on a bad
    // network) needs enough different people instead.
    if (x.trusted && x.sev === "high" && x.kind !== "vital" && x.kind !== "exc") return "serious";
    // One crash for one person is a look; a repeat is a break.
    if (x.kind === "exc" && (h >= 3 || p >= 2)) return "serious";
    if (p >= (x.area === "signup" ? 3 : 5)) return "serious";
    // A key API failing all day. Exactly one caller is one client in a loop.
    if (x.trusted && h >= 25 && p !== 1) return "serious";
  }
  // "Only slow" is small by the owner's definition, however often it happens.
  if ((x.kind === "slow" || x.kind === "apislow") && x.sev !== "high") return "small";
  const grew = p - (x.openPeople || 0) >= 5 || (h - (x.openHits || 0) >= 20 && h >= 2 * Math.max(x.openHits || 0, 1));
  if (p >= 10 || grew) return "middle";
  if (four && fail && x.trusted && x.sev === "high") return "middle";
  return "small";
}

// The plan's week ends Friday 19:30 IST = 14:00 UTC.
export function nextWeeklyReset(now) {
  const d = new Date(now);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14, 0, 0) + ((5 - d.getUTCDay() + 7) % 7) * DAY;
  if (t <= now) t += 7 * DAY;
  return t;
}

// What one agent run is assumed to cost, in points of each limit, until real
// readings say otherwise.
export const EST = { five: 4, weekly: 0.7 };

// Best current guess of the plan meter: the last posted reading plus the
// agent's own runs since then. `fresh` = a reading from the last 36 hours;
// without one the owner is assumed to be away from Claude.
//   u: { weekly, five, weekly_reset, five_reset, at, src } | null,  log: [{ at, ok }]
export function usageNow(u, log, now) {
  if (!u || !Number.isFinite(u.at) || !Number.isFinite(u.weekly)) {
    return { known: false, fresh: false, weekly: null, five: null, weeklyReset: nextWeeklyReset(now), fiveReset: null, age: null, src: null };
  }
  const runs = (t) => (log || []).filter((w) => w.at > t && w.ok !== false).length;
  const clamp = (x) => Math.max(0, Math.min(100, Math.round(x * 10) / 10));
  const age = now - u.at;
  let weeklyReset = Number.isFinite(u.weekly_reset) && u.weekly_reset > u.at ? u.weekly_reset : nextWeeklyReset(u.at);
  let fiveReset = Number.isFinite(u.five_reset) && u.five_reset > u.at ? u.five_reset : null;
  let weekly, five;
  if (now >= weeklyReset) { weekly = runs(weeklyReset) * EST.weekly; weeklyReset = nextWeeklyReset(now); }
  else weekly = u.weekly + runs(u.at) * EST.weekly;
  if (fiveReset && now >= fiveReset) { five = runs(fiveReset) * EST.five; fiveReset = null; }
  else if (!fiveReset && age > 5 * HOUR) five = runs(now - 5 * HOUR) * EST.five;
  else five = (Number.isFinite(u.five) ? u.five : 0) + runs(u.at) * EST.five;
  return { known: true, fresh: age <= 36 * HOUR, weekly: clamp(weekly), five: clamp(five), weeklyReset, fiveReset, age, src: u.src || null };
}

const WAITING = new Set(["tight", "cap", "blind_cap", "five", "queued", "paused", "nowake", "owner_busy"]);
// How long after the owner's last prompt the agent leaves the limit to him.
// 10 minutes since 25 Nov 2026 (was 45): the owner moved to a larger plan, so
// the shared limit no longer needs that much room.
export const OWNER_QUIET = 10 * 60 * 1000;
const QUIET_MIN = OWNER_QUIET / 60000;

const pct = (x) => `${Math.round(x)}%`;
const daysText = (d) => (d >= 1 ? `${Math.round(d * 10) / 10} day(s)` : `${Math.max(1, Math.round(d * 24))} hour(s)`);

// One issue, one decision.
//   g: { state, band, status, opened, lastSeen, people, hits, wakes, wokenAt, wakePeople, wakeHits,
//        pickedAt, naggedAt, approvedAt, again, reason }
//   c: { now, usage (from usageNow), lastWakeAt, lastSeriousWakeAt, lastSmallWakeAt, wakesToday, blindToday }
// Returns { act, why, reason, next, mode?, warn?, alert? } where act is one of
//   wake   start the agent for it            join   a wake for the same incident just went out
//   wait   look again at `next`              brief  no wake; listed in the daily brief
//   hold   waits for a limit to reset        idle   nothing to do now
//   nag    woken but nobody picked it up: tell the owner once
export function decide(g, c) {
  const now = c.now, u = c.usage;
  const out = (act, why, reason, next, extra) => ({ act, why, reason, next, ...extra });
  const fiveKnown = u.known && u.fresh && Number.isFinite(u.five);
  const fiveBack = u.fiveReset && u.fiveReset > now ? u.fiveReset : now + HOUR;
  const recent = u.known && u.age != null && u.age <= 6 * HOUR;

  if (g.status === "fixing" || g.status === "fix_live") return out("idle", "working", "the agent is on it", now + 30 * MIN);
  if (g.status === "needs_owner" || g.status === "needs_pc") return out("brief", "needs_you", "it cannot go further without you", now + 6 * HOUR);

  // The cause is an outside service: nothing of ours to change, so the agent
  // is not started and the owner reads it in the brief. If it is still
  // happening two hours later and nobody has looked, it gets one look: maybe
  // we can route around it. The owner's OK always starts it.
  let outsideLong = false;
  if (g.outside && !g.approvedAt && g.state !== "woken") {
    const who = OUTSIDE[g.outside] || g.outside;
    outsideLong = now - g.lastSeen < 20 * MIN && now - g.opened >= 2 * HOUR && (g.wakes || 0) === 0;
    if (!outsideLong) return out("brief", "outside", `the cause is at ${who}, not in our code: nothing of ours to change`, now + 30 * MIN);
  }
  // A low trading number on a day the market is closed is the calendar, not a fault.
  if (c.tradingDay === false && g.area === "trading" && g.kind === "vital" && g.sev !== "critical" && !g.approvedAt) {
    return out("brief", "market_closed", "the market is closed today: a low trading number is expected", now + 6 * HOUR);
  }

  // Serious means serious now. Something that broke and has been quiet for
  // half an hour is worth a look, not an alarm; quiet for six hours, it is
  // history for the brief.
  const quiet = now - g.lastSeen;
  const band = g.band === "serious" && quiet >= 30 * MIN ? "middle" : g.band;
  const serious = band === "serious";
  let skipWait = !!g.approvedAt, recheck = false;

  if (g.state === "woken" && g.wokenAt) {
    const since = now - g.wokenAt;
    if (!g.pickedAt && since < 15 * MIN) return out("idle", "sent", g.reason || "woken", g.wokenAt + 15 * MIN);
    if (!g.pickedAt && !g.naggedAt) return out("nag", "unpicked", "woken, but nothing picked it up in 15 minutes", serious ? g.wokenAt + 45 * MIN : now + HOUR);
    const live = quiet < 20 * MIN;
    recheck = !!g.again && now >= g.again;
    const doubled = g.people >= 2 * Math.max(g.wakePeople || 0, 1) && g.people - (g.wakePeople || 0) >= 3;
    const stillBroken = serious && live && since >= 45 * MIN;
    const grew = since >= 6 * HOUR && live && g.hits >= 1.5 * Math.max(g.wakeHits || 0, 1) && g.hits - (g.wakeHits || 0) >= 5;
    // Started for it, but an hour later nothing has claimed it: that run died
    // (most often on a full limit). It goes back in the queue, not into limbo.
    const lost = !g.pickedAt && since >= HOUR;
    if (!(recheck || g.approvedAt || doubled || stillBroken || grew || lost)) return out("idle", "woken", g.reason || "woken", now + 30 * MIN);
    if ((g.wakes || 0) >= 3 && !recheck && !g.approvedAt) return out("brief", "max_wakes", "woken 3 times and still open: it needs you", now + 6 * HOUR);
    skipWait = true;
  }

  if (serious && !outsideLong) {
    // Owner's rule (15 Nov): while he is working in Claude nothing starts,
    // serious or not. He gets the popup and the mail and decides himself;
    // his OK on the issue still starts it.
    const quietAt = (c.ownerActiveAt || 0) + OWNER_QUIET;
    if (!g.approvedAt && now < quietAt) return out("hold", "owner_busy", `serious, but you are working in Claude right now: it starts when you have been quiet for ${QUIET_MIN} minutes, or when you approve it`, quietAt);
    // Only a reading from the last few hours may hold back a serious wake.
    if (recent && Number.isFinite(u.five) && u.five >= 98) return out("hold", "limit_full", "serious, but the 5-hour limit is full", fiveBack, { alert: true });
    if (recent && u.weekly >= 99) return out("hold", "limit_full", "serious, but the weekly limit is used up", Math.min(u.weeklyReset, now + 6 * HOUR), { alert: true });
    const ago = c.lastSeriousWakeAt ? now - c.lastSeriousWakeAt : Infinity;
    if (ago < 20 * MIN && g.state !== "woken") return out("join", "joined", `same incident as the wake sent ${Math.max(1, Math.round(ago / MIN))} min ago`, now + 15 * MIN, { mode: "fix" });
    return out("wake", "serious", "serious: woken at once", now + 15 * MIN, { mode: "fix", warn: u.known && u.fresh && u.weekly >= 85 });
  }

  const gapUntil = c.lastWakeAt ? c.lastWakeAt + 10 * MIN : 0;
  const start = (mode, why, reason, capped = true) => {
    // The owner's own Claude sessions and the agent share one limit. While he
    // is working, nothing that is not serious starts; his OK still does.
    const busyUntil = (c.ownerActiveAt || 0) + OWNER_QUIET;
    if (mode !== "approved" && now < busyUntil) return out("hold", "owner_busy", `you are working in Claude right now: waits until you have been quiet for ${QUIET_MIN} minutes`, busyUntil);
    if (fiveKnown && u.five >= 95) return out("hold", "five", `5-hour limit at ${pct(u.five)}: waits for its reset`, fiveBack);
    if (capped && (c.wakesToday || 0) >= 6) return out("brief", "cap", "6 agent runs today already: waits for tomorrow or your OK", now + HOUR);
    if (now < gapUntil) return out("wait", "gap", "another run started less than 10 minutes ago", gapUntil);
    return out("wake", why, reason, now + 15 * MIN, { mode });
  };

  if (outsideLong) return start("look", "outside_long", `the cause is at ${OUTSIDE[g.outside] || g.outside}, but it has gone on for 2 hours: the agent checks whether we can work around it`);
  if (recheck) return start("recheck", "again", "the agent asked to look again now");
  if (g.approvedAt) return start("approved", "approved", "you approved it", false);
  if (!serious && g.band === "serious" && quiet >= 6 * HOUR) return out("brief", "stopped", "stopped by itself", now + HOUR);
  if (!skipWait && now - g.opened < 30 * MIN) return out("wait", "counting", "counting for 30 minutes before deciding", Math.min(g.opened + 30 * MIN, now + MIN));
  if (band === "middle") {
    if (quiet >= 6 * HOUR) return out("brief", "stopped", "stopped by itself", now + HOUR);
    return start("look", "middle", g.band === "serious" ? "it looked serious and has been quiet since: the agent takes a look"
      : "many people or a first break in a key area: the agent takes a look");
  }

  // Small. Friday's last hours use what is left of the week on the waiting list.
  const friday = u.known && u.fresh && u.weeklyReset - now < 6 * HOUR && u.weekly < 95;
  // "Still happening" = seen in the last 20 minutes. Something already
  // waiting for a limit keeps its place for six hours, so it does not drop
  // off the owner's list between two occurrences.
  const liveFor = friday ? DAY : WAITING.has(g.why) ? 6 * HOUR : 20 * MIN;
  // A real error (not mere slowness) that nobody has ever looked at is a bug
  // waiting for its next victim: it gets one look even after it went quiet.
  const unlooked = !/slow/.test(g.kind || "") && (g.wakes || 0) === 0 && now - g.opened < 7 * DAY && ((g.totalPeople || 0) >= 5 || (g.totalHits || 0) >= 20);
  if (quiet >= liveFor && !unlooked) return out("brief", "stopped", "stopped by itself", now + HOUR);
  // Small work goes in batches (the runner takes five at a time), not as a
  // stream of sessions.
  if (c.lastSeriousWakeAt && now < c.lastSeriousWakeAt + HOUR) return out("brief", "queued", "an incident is being handled: small fixes wait an hour", c.lastSeriousWakeAt + HOUR);
  if (c.lastSmallWakeAt && now < c.lastSmallWakeAt + 2 * HOUR) return out("brief", "queued", "small fixes run in batches, at most every 2 hours", c.lastSmallWakeAt + 2 * HOUR);
  // The 5-hour hold for small work is the one in start(): 95% (was 85% here until 25 Nov 2026).
  if (!u.known || !u.fresh) {
    if ((c.blindToday || 0) >= 3) return out("brief", "blind_cap", "no limit reading for 36 hours and 3 small fixes already today", now + HOUR);
    return start("small", "blind", "no limit reading for 36 hours: assuming you are away");
  }
  if (u.weekly < 70) return start("small", "roomy", `weekly limit at ${pct(u.weekly)}`);
  const days = Math.max((u.weeklyReset - now) / DAY, 1 / 24);
  const perDay = (100 - u.weekly) / days;
  if (perDay >= 5 && u.weekly < 95) return start("small", "enough_left", `weekly at ${pct(u.weekly)} with ${daysText(days)} left: ${Math.round(perDay)}% a day stays free`);
  return out("brief", "tight", `weekly limit tight (${pct(u.weekly)}, ${daysText(days)} left): waits for your OK or the Friday reset`, now + HOUR);
}

const IST = 330 * MIN;
export const istClock = (ms) => {
  const d = new Date(ms + IST);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} IST`;
};

export function usageLine(u, now) {
  if (!u.known) return "no reading posted yet";
  const five = Number.isFinite(u.five) ? `, 5-hour ${pct(u.five)}` : "";
  const age = u.age < HOUR ? `${Math.max(1, Math.round(u.age / MIN))} min` : `${Math.round(u.age / HOUR)} h`;
  return `weekly ${pct(u.weekly)} (resets ${istClock(u.weeklyReset)}, ${daysText((u.weeklyReset - now) / DAY)} left)${five}; reading ${age} old${u.fresh ? "" : " (too old to trust)"}`;
}

// What the agent is told when it is started. Numbers and fixed words only:
// issue titles come from error text anyone can cause, so they never go in.
//   rows: [{ id, fp, area, band, sev, mode, people, hits, opened, lastSeen }]
export function wakeText({ now, rows, nearby = [], more = 0, usage, dbOk = true, drill = false, test = false, market = null }) {
  const name = (r) => (r.id ? `#${r.id}` : `fp:${r.fp}`);
  const ago = (t) => { const m = Math.max(0, Math.round((now - t) / MIN)); return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`; };
  const lines = ["OPS WAKE v1", `sent: ${new Date(now).toISOString()} (${istClock(now)})`];
  if (test) lines.push("test: yes. This is a wiring test. Read the queue, change nothing, write one line saying the wake arrived, stop.");
  if (drill) lines.push("drill: yes. The collector is running an outage drill it started itself; confirm and stop.");
  for (const r of rows) {
    lines.push(`issue ${name(r)}: mode=${r.mode} area=${r.area} band=${r.band} severity=${r.sev}${r.outside && OUTSIDE[r.outside] ? ` outside_cause=${r.outside}` : ""} people_today=${r.people} hits_today=${r.hits} opened=${ago(r.opened)} ago last_seen=${ago(r.lastSeen)} ago`);
  }
  if (more > 0) lines.push(`and ${more} more small issue(s) wait in the queue for a later run.`);
  if (nearby.length) lines.push(`opened in the same 20 minutes, possibly the same cause: ${nearby.map(name).join(", ")}`);
  lines.push(`limits: ${usageLine(usage, now)}`);
  if (market) lines.push(`market: ${market}`);
  if (usage.known && usage.fresh && usage.weekly >= 85) lines.push("note: weekly use is above 85%. Fix what is serious; leave anything optional for the brief.");
  if (!dbOk) lines.push("note: the collector could not reach the main database this minute.");
  lines.push("modes: fix = serious, act now. look = judge first, fix only if worth it. small = small fix allowed by the limits. approved = the owner said go. recheck = you asked to look again.");
  return lines.join("\n");
}

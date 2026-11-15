// Pure decisions. No storage, no network: everything here is unit-tested.

// How much of one signature must be seen in a day before it becomes an issue.
// A server crash counts on its first hit; things a browser reports need
// several different people, because the browser endpoint is public.
export const OPEN_AT = {
  exc: { hits: 1 },
  http: { hits: 3 },
  timeout: { hits: 3 },
  slow: { hits: 10 },
  error: { people: 3 },
  api5: { people: 5 },
  api4: { people: 15 },
  apislow: { people: 15 },
  form: { people: 15 },
  cron_failed: { hits: 1 },
  cron_failed_minutely: { hits: 3 },
  cron_missed: { hits: 1 },
  net: { hits: 3 },
  pulse: { hits: 1 },
  vital: { hits: 1 },
};

// Kinds that only build a picture of "normal" during the first day instead of
// opening one issue each (they exist already and would arrive as a flood).
export const LEARN_KINDS = new Set(["api4", "apislow", "form", "slow"]);

const SEVERITY = { exc: "high", http: "medium", timeout: "medium", slow: "low", error: "medium", api5: "high", api4: "low", apislow: "low", form: "low", cron_failed: "high", cron_failed_minutely: "high", cron_missed: "high", net: "medium", pulse: "critical", vital: "high" };
export const severityOf = (kind) => SEVERITY[kind] || "medium";

export function crossed(kind, day) {
  const t = OPEN_AT[kind] || { hits: 3 };
  if (t.hits && day.hits >= t.hits) return true;
  if (t.people && day.people >= t.people) return true;
  return false;
}

// What one batch of occurrences means for a signature.
//   sig: stored row (state, peak_day, spike_day, alert_people, fixed_at, fix_deploy)
//   day: today's totals after this batch { hits, people }
//   ctx: { now, today, learning, deploy }
export function decide(sig, day, ctx) {
  const state = sig.state;
  if (state === "alias" || state === "canary") return { action: "none" };

  if (state === "watch") {
    if (!crossed(sig.kind, day)) return { action: "none" };
    if (ctx.learning && LEARN_KINDS.has(sig.kind)) return { action: "baseline" };
    return { action: "open" };
  }

  if (state === "fixed") {
    // Reports still arriving from the old build right after a fix went live
    // are not a comeback.
    if (sig.fixed_at && ctx.now - sig.fixed_at < 5 * 60_000) return { action: "none" };
    if (sig.fix_deploy && ctx.deploy && ctx.deploy !== sig.fix_deploy && ctx.now - sig.fixed_at < 60 * 60_000) return { action: "none" };
    return { action: "regress" };
  }

  // Known and not being worked on as new: open, fixing, fix_live, baseline,
  // ignored, muted. Each of these still reacts to a surge.
  const peak = Math.max(sig.peak_day || 0, 0);
  const surge = sig.spike_day !== ctx.today && day.hits >= 20 && peak > 0 && day.hits > 3 * peak;
  if (state === "ignored" || state === "muted") {
    // A mute stops being trusted when the thing it hides grows tenfold.
    if (sig.spike_day !== ctx.today && day.hits >= 30 && peak > 0 && day.hits >= 10 * peak) return { action: "unmute" };
    return { action: "none" };
  }
  if (state === "baseline") {
    if (surge) return { action: "open", spike: true };
    return { action: "none" };
  }
  if (surge) return { action: "spike" };
  if (state === "open" && day.people >= 10 && day.people >= 5 * Math.max(sig.alert_people || 1, 1)) return { action: "spread" };
  return { action: "none" };
}

// A browser measures its own connection as well as our server. "Slow in
// browsers" and "fails to load in browsers" are therefore the visitor's
// problem unless something we measure ourselves agrees. An answer with a 5xx
// status is the server speaking and is never treated this way.
export function visitorSide(sig) {
  if (sig.src !== "browser") return null;
  if (sig.kind === "apislow") return "slow";
  if (sig.kind === "api5" && /\|network$/.test(sig.sig || "")) return "network";
  return null;
}

// ev: { serverHits, badMinutes } from the last hour of our own measurements.
// Failing to load for 30 different people in a day is not one bad connection.
export function serverAgrees(side, day, ev) {
  if ((ev.serverHits || 0) > 0 || (ev.badMinutes || 0) >= 3) return true;
  return side === "network" && (day.people || 0) >= 30;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Usual value and usual spread, robust to a few wild hours.
export function baseline(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 3) return null;
  const med = median(xs);
  const mad = median(xs.map((v) => Math.abs(v - med))) * 1.4826;
  return { med, mad, n: xs.length };
}

// dir: "low" means a drop is the problem (sign-ups, trades), "high" means a
// rise is (answer time, failed share).
export function farOff(value, base, dir, floor = 0) {
  if (!base || !Number.isFinite(value)) return false;
  if (dir === "low") {
    if (base.med < Math.max(floor, 5)) return false;
    return value < base.med - Math.max(4 * base.mad, 0.6 * base.med);
  }
  return value > base.med + Math.max(4 * base.mad, base.med, floor);
}

// "Nothing at all for a while" test. With `expected` events normally arriving
// in the window, seeing zero by chance has probability e^-expected:
// 7 expected -> under 0.1%.
export function silentTooLong(observed, expected, need = 7) {
  return observed === 0 && expected >= need;
}

// Fix verification. A fix "held" only when enough time AND enough traffic has
// passed that the old problem would certainly have shown again.
//   before: { hits, firstSeen, lastSeen, activity }  (activity = site events in that span)
//   since:  { ms, hits, activity }
export function fixVerdict(before, since) {
  if (since.hits > 0) return { verdict: "no_effect", why: `seen again ${since.hits} time(s) after the change` };
  const span = Math.max(before.lastSeen - before.firstSeen, 60_000);
  const gap = Math.min(span / Math.max(before.hits - 1, 1), 14 * 86400_000);
  const needMs = Math.max(24 * 3600_000, 10 * gap);
  if (since.ms < needMs) return { verdict: null, why: `quiet so far; needs ${Math.ceil((needMs - since.ms) / 3600_000)} more hour(s)` };
  if (before.activity > 0 && Number.isFinite(since.activity)) {
    const expected = (before.hits / before.activity) * since.activity;
    if (expected < 5) return { verdict: null, why: `quiet, but too little traffic since to be sure (${expected.toFixed(1)} repeats expected, need 5)` };
    return { verdict: "held", why: `quiet for ${Math.round(since.ms / 3600_000)} h; ${expected.toFixed(0)} repeats would have been expected at the old rate` };
  }
  return { verdict: "held", why: `quiet for ${Math.round(since.ms / 3600_000)} h (traffic numbers missing, judged on time alone)` };
}

// Right after a change goes live: did the site get worse?
//   a = 10 minutes before, b = minutes since: { errRate, siteMs, dbMs, newCrashes }
export function watchWindow(a, b) {
  const worse = [];
  if (b.newCrashes > 0) worse.push(`${b.newCrashes} new server crash signature(s)`);
  if (b.errRate > Math.max(3 * a.errRate, a.errRate + 2)) worse.push(`server errors per minute ${a.errRate.toFixed(1)} -> ${b.errRate.toFixed(1)}`);
  if (a.siteMs > 0 && b.siteMs > Math.max(2.5 * a.siteMs, a.siteMs + 1500)) worse.push(`site answer time ${Math.round(a.siteMs)} -> ${Math.round(b.siteMs)} ms`);
  if (a.dbMs > 0 && b.dbMs > Math.max(2.5 * a.dbMs, a.dbMs + 1500)) worse.push(`database answer time ${Math.round(a.dbMs)} -> ${Math.round(b.dbMs)} ms`);
  if (b.down) worse.push("site or database stopped answering");
  return worse;
}

const IST = 330 * 60_000;
export const istDay = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
export const istHour = (ms) => new Date(ms + IST).getUTCHours();
export const istDow = (ms) => new Date(ms + IST).getUTCDay();
export const hourOfWeek = (ms) => istDow(ms) * 24 + istHour(ms);
export function marketOpen(ms, isTradingDay) {
  const d = new Date(ms + IST);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  return isTradingDay(istDay(ms), wd) && mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

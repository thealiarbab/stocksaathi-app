// =============================================================================
// REPORT CARD, THE WEEKLY CARD (28 Nov 2026). Pure: no DOM, no network, only
// the score core. The page, the server (api/ai.js op report-card-week) and the
// Node tests run these same lines.
//
// What is here:
//   plating per part   bronze / silver / gold / platinum from cut points set
//                      PER PART on real data. One rule for all six misled:
//                      Discipline read A+ for 82% of students and Learning D
//                      for 70%, because the parts do not spread alike.
//   a letter that holds  going up happens at the cut point; going down only
//                      once the score is 3 marks under it. Measured: 34% of
//                      students saw more than one letter inside 5 days from
//                      prices alone.
//   profit, smoothed   Results is scored on the middle value of the last five
//                      days, so one sharp day does not move the grade.
//   the week           what moved since the last saved card, the road to the
//                      next letter, and the five story screens.
// =============================================================================

import { GRADES, gradeFor, istWeekStart } from "./reportCardCore.js";

export const PART_KEYS = ["discipline", "results", "research", "diversification", "learning", "market"];
export const PLATINGS = ["bronze", "silver", "gold", "platinum"];

// [silver from, gold from, platinum from]. Set 28 Nov 2026 from the marks of
// the 1,372 accounts with 5+ trades, aiming near a third bronze, a third
// silver, a quarter gold and under a tenth platinum in every part. Where a
// number has a plain meaning it sits on it: Results 50 is breaking even, vs
// Nifty 50 is level with the index. Fixed numbers, never a live curve.
export const PLATING_CUTS = {
  discipline:      [78, 93, 100],
  results:         [50, 66, 94],
  research:        [25, 50, 75],
  diversification: [45, 68, 91],
  learning:        [25, 45, 75],
  market:          [40, 50, 60],
};
// A clean record of a handful of trades is "not checked much yet", not the
// top plating: 41% of students sit on 100 for Discipline.
export const DISCIPLINE_PLATINUM_TRADES = 20;

export function partPlating(key, score, detail = null) {
  const c = PLATING_CUTS[key];
  if (!c || !Number.isFinite(score)) return null;
  let i = score >= c[2] ? 3 : score >= c[1] ? 2 : score >= c[0] ? 1 : 0;
  if (i === 3 && key === "discipline" && !(Number(detail?.trades) >= DISCIPLINE_PLATINUM_TRADES)) i = 2;
  return PLATINGS[i];
}

/** What the next plating of a part needs: { plating, at, left } or null at the top. */
export function nextPlating(key, score, detail = null) {
  const now = partPlating(key, score, detail);
  const i = PLATINGS.indexOf(now);
  if (i < 0 || i >= 3) return null;
  const at = PLATING_CUTS[key][i];
  const needsTrades = key === "discipline" && i === 2 && score >= at;
  return { plating: PLATINGS[i + 1], at, left: Math.max(0, at - score), needsTrades };
}

// The whole card's plating follows the letter. D is a plain, unplated card.
export const CARD_PLATING = { "A+": "platinum", A: "gold", "B+": "silver", B: "bronze", C: "bronze", D: "plain" };
export const cardPlating = (grade) => CARD_PLATING[grade] || "plain";

// ---- A letter that holds ------------------------------------------------------
export const HOLD_MARKS = 3; // on the marks shown (was 2 on the unstretched mark: about the same distance)
const gi = (g) => GRADES.findIndex((x) => x.grade === g);

/** The letter to show for `score`, given the letter on the last saved card. */
export function stickyGrade(score, prevGrade) {
  if (!Number.isFinite(score)) return null;
  const raw = gradeFor(score);
  const p = gi(prevGrade);
  if (p < 0 || gi(raw) <= p) return raw;                 // no history, the same letter, or a better one
  return score >= GRADES[p].min - HOLD_MARKS ? prevGrade : raw;
}

// ---- Profit, smoothed -----------------------------------------------------------
export const SMOOTH_DAYS = 5;
const iso = (ms) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * The middle value of profit over the last five days: today's live figure and
 * up to four saved days before it. A saved day's profit is today's profit
 * shifted by how the saved account value differed (virtual money has no
 * deposits, so a change in value is a change in profit).
 * curve: [["YYYY-MM-DD", totalValuePaise]] oldest first. Falls back to livePl.
 */
export function smoothedPl(livePl, liveValuePaise, curve, now = Date.now()) {
  if (!Number.isFinite(livePl) || !(liveValuePaise > 0) || !Array.isArray(curve)) return livePl;
  const today = iso(now), from = iso(now - 10 * 86400_000);
  const past = curve.filter((r) => Array.isArray(r) && r[0] < today && r[0] >= from && Number(r[1]) > 0).slice(-(SMOOTH_DAYS - 1));
  if (past.length < 2) return livePl;
  const vals = past.map((r) => livePl + (Number(r[1]) - liveValuePaise)).concat(livePl).sort((a, b) => a - b);
  const m = vals.length >> 1;
  return Math.round(vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2);
}

// ---- The week -------------------------------------------------------------------
/** Monday of the IST week that holds `ms`, as "YYYY-MM-DD". */
export const weekStartIso = (ms = Date.now()) => istWeekStart(ms);

/** { discipline: 80, results: null, ... } from a scored card. */
export function partsOf(rc) {
  const out = {};
  for (const k of PART_KEYS) {
    const p = rc?.pillars?.[k];
    out[k] = p?.state === "scored" && Number.isFinite(p.score) ? p.score : null;
  }
  return out;
}

export const MOVE_MARKS = 3;      // a part that moved less than this "held"
/** Parts that moved 3 marks or more since `prev`, biggest move first. */
export function changesSince(prev, now) {
  const out = [];
  for (const k of PART_KEYS) {
    const a = prev?.[k], b = now?.[k];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.abs(b - a) >= MOVE_MARKS) out.push({ key: k, was: a, now: b, by: b - a });
  }
  return out.sort((x, y) => Math.abs(y.by) - Math.abs(x.by));
}
export const dirOf = (was, now) => (!Number.isFinite(was) || !Number.isFinite(now) ? "flat" : now - was >= MOVE_MARKS ? "up" : was - now >= MOVE_MARKS ? "down" : "flat");

/**
 * Saved weeks (oldest first) as the row of small cards: the last `keep`
 * before this week, then this week live. Each: { week, score, grade, plating, now }.
 */
export function weekRow(saved, live, thisWeek = weekStartIso(), keep = 3) {
  const past = (saved || []).filter((w) => w && w.week < thisWeek && Number.isFinite(w.score) && w.grade).slice(-keep)
    .map((w) => ({ week: w.week, score: w.score, grade: w.grade, plating: cardPlating(w.grade), now: false }));
  if (live && Number.isFinite(live.score) && live.grade) past.push({ week: thisWeek, score: live.score, grade: live.grade, plating: cardPlating(live.grade), now: true });
  return past;
}
/** The best part of a saved card (vs Nifty left out), from its saved marks; null when none is scored. */
export function bestPart(parts) {
  let best = null;
  for (const k of PART_KEYS) {
    if (k === "market" || !Number.isFinite(parts?.[k])) continue;
    if (best == null || parts[k] > parts[best]) best = k;
  }
  return best;
}
/** The last saved card before this week, or null. */
export const lastWeek = (saved, thisWeek = weekStartIso()) => (saved || []).filter((w) => w && w.week < thisWeek && Number.isFinite(w.score)).slice(-1)[0] || null;

/**
 * The road: every letter from the top down, each marked
 * far | next | here | done, with the week it was first reached when known.
 */
export function road(score, grade, saved = []) {
  const here = gi(grade);
  if (here < 0) return [];
  const firstAt = {};
  for (const w of saved || []) if (w?.grade && !(w.grade in firstAt)) firstAt[w.grade] = w.week;
  return GRADES.slice(0, GRADES.length - 1).map((g, i) => ({
    grade: g.grade, at: g.min, plating: cardPlating(g.grade),
    state: i === here ? "here" : i === here - 1 ? "next" : i < here ? "far" : "done",
    left: Math.max(0, g.min - score), since: firstAt[g.grade] || null,
  })).concat(here === GRADES.length - 1 ? [{ grade: "D", at: 0, plating: "plain", state: "here", left: 0, since: firstAt.D || null }] : []);
}

/** Marks to the next letter up, or null at A+. */
export function nextGrade(score, grade) {
  const i = gi(grade);
  if (i <= 0) return null;
  const g = GRADES[i - 1];
  return { grade: g.grade, at: g.min, left: Math.max(1, g.min - score), plating: cardPlating(g.grade) };
}

/** The part to put on the card and in the story: best and lowest of the scored parts (vs Nifty left out). */
export function standouts(rc) {
  const ps = PART_KEYS.filter((k) => k !== "market").map((k) => rc?.pillars?.[k]).filter((p) => p?.state === "scored");
  if (!ps.length) return { best: null, low: null };
  const best = ps.slice().sort((a, b) => b.score - a.score)[0];
  const low = ps.slice().sort((a, b) => a.score - b.score)[0];
  return { best, low: low.key === best.key ? null : low };
}

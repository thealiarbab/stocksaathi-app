// The market calendar, as the watcher needs it: is today a trading day, why
// not, and when the market opens next. Uses the site's own holiday list, so
// the watcher and the site can never disagree about a holiday.

import { isNseTradingDay, nseHolidayName } from "../../../js/data/nseCalendar.js";

const MIN = 60_000, DAY = 86400_000, IST = 330 * MIN;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const OPEN_MIN = 9 * 60 + 15, CLOSE_MIN = 15 * 60 + 30;

const ymd = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const wd = (ms) => WD[new Date(ms + IST).getUTCDay()];
// Midnight IST of the day `ms` falls in, as a UTC timestamp.
const dayStart = (ms) => Math.floor((ms + IST) / DAY) * DAY - IST;
const trading = (ms) => isNseTradingDay(ymd(ms), wd(ms));

// First market open at or after `now` (09:15 IST of the next trading day).
export function nextOpen(now) {
  for (let i = 0, d = dayStart(now); i < 12; i++, d += DAY) {
    const open = d + OPEN_MIN * MIN;
    if (trading(d) && open >= now) return open;
  }
  return null;
}

// The last market open strictly before `before`.
export function prevOpen(before) {
  for (let i = 0, d = dayStart(before); i < 12; i++, d -= DAY) {
    const open = d + OPEN_MIN * MIN;
    if (trading(d) && open < before) return open;
  }
  return null;
}

const clock = (ms) => {
  const d = new Date(ms + IST);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} IST`;
};

export function dayInfo(now) {
  const day = ymd(now), weekday = wd(now);
  const isTrading = isNseTradingDay(day, weekday);
  const weekend = weekday === "Sat" || weekday === "Sun";
  const holiday = nseHolidayName(day) || null;
  const d = new Date(now + IST);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const open = isTrading && mins >= OPEN_MIN && mins <= CLOSE_MIN;
  const next = open ? null : nextOpen(now);
  const line = open ? "the market is open"
    : isTrading && mins < OPEN_MIN ? `trading day, the market opens at 09:15 IST`
    : isTrading ? `trading day, the market closed at 15:30 IST${next ? `; next open ${clock(next)}` : ""}`
    : `the market is closed today (${holiday || (weekend ? "weekend" : "holiday")})${next ? `; next open ${clock(next)}` : ""}`;
  return { day, weekday, trading: isTrading, weekend, holiday, open, nextOpen: next, line };
}

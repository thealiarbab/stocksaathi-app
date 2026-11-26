// EXPECTED NSE cash-market holidays for 2027: estimates, NOT the official list.
// NSE publishes next year's list by circular in December. Until then this is
// what the coach uses to answer "is <date> in 2027 a holiday?" with a
// likely answer instead of "I don't know".
//
// Kept OUT of nseCalendar.js on purpose: handlers/match-orders.py reads every
// `"YYYY-MM-DD":` line in that file as a real holiday, and the market badge
// and order matcher must only ever follow NSE's official dates.
//
// Sources (26 Nov 2026): choiceindia.com tentative 2027 list and
// portfoliotrackr.com 2027 estimates; weekday closures only. When the NSE
// circular is out, move the official dates into nseCalendar.js and delete
// this file.
export const NSE_EXPECTED_2027 = Object.freeze([
  ["2027-01-26", "Republic Day"],
  ["2027-03-10", "Id-ul-Fitr (Ramzan Eid)"],
  ["2027-03-22", "Holi"],
  ["2027-03-26", "Good Friday"],
  ["2027-04-14", "Dr. Baba Saheb Ambedkar Jayanti"],
  ["2027-04-15", "Shri Ram Navami"],
  ["2027-04-19", "Shri Mahavir Jayanti"],
  ["2027-05-17", "Bakri Id"],
  ["2027-06-15", "Muharram (15 or 16 June; sources differ)"],
  ["2027-10-29", "Diwali Laxmi Pujan (usually a short evening Muhurat session)"],
]);

export function formatNseExpected2027() {
  return NSE_EXPECTED_2027.map(([d, n]) => `${d}: ${n}`).join("; ");
}

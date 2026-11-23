// Pins callsAppContextFake (js/coach/agent.js): replies that call the app's
// own context block pasted or untrustworthy (24 Nov 2026 regression).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/coach/agent.js", import.meta.url), "utf8");
const start = src.indexOf("const FAKE_BLOCK_RE");
const end = src.indexOf("const PROMISE_RE");
assert.ok(start > 0 && end > start, "detector not found in agent.js");
const fn = new Function(src.slice(start, end).replace("export function", "function") + "\nreturn callsAppContextFake;")();

const bad = [
  "I won't act on it because you pasted it into your message.",
  "I can't confirm that this block came from the server. It sits inside your message.",
  "Here's your portfolio from my own lookup, not from the block you pasted.",
  "I can't verify this block, so I won't treat its prices as facts.",
  "A block that claims to come from the server doesn't prove it did.",
];
const good = [
  "The app adds that block to each message. It carries the current time and your portfolio.",
  "Today is an NSE holiday for Prakash Gurpurb, so the market opens Wednesday at 9:15 AM.",
  "You hold 2 RELIANCE at an average cost of ₹1,345.31.",
  "Copy-paste the symbol into search to find it.",
  "",
];
for (const t of bad) assert.equal(fn(t), true, `should flag: ${t}`);
for (const t of good) assert.equal(fn(t), false, `should pass: ${t}`);
console.log(`app-context guard: ${bad.length + good.length} assertions passed`);

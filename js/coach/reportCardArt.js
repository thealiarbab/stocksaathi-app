// =============================================================================
// REPORT CARD ART (28 Nov 2026): the card, the small card and the grade seal,
// as SVG text. Pure, so the page, the share picture and the tests use the same
// drawing.
//
// Built the way an achievement pin is built (js/achievements/pins.js), the
// style the owner approved: the outline drawn twice (once lower in the
// plating's dark colour = the side wall, once in the plating), then flat
// enamel. Rules, do not break them:
//   - a gradient exists only where there is metal (the plating);
//   - every other surface is ONE flat colour from the pin palette;
//   - depth is the solid side wall, never a blur, a glow or a drop shadow.
// The card's plating follows the letter (reportCardWeek.js CARD_PLATING).
// =============================================================================

import { pinSvg, pinDefs } from "../achievements/pins.js";

export const C = { navy: "#1C2340", cream: "#FFF4DC", mint: "#1FD1A1", pink: "#FF7EB6", mari: "#FFC93C", indigo: "#5367FF", deep: "#0F5A46", plum: "#4B2A7A", lilac: "#AEB6D9" };
// Plating: light, mid, dark (dark is the side wall). "plain" is an unplated card (grade D).
const M = {
  bronze: ["#FFD9B5", "#D08A52", "#7C4521"],
  silver: ["#FFFFFF", "#B9C4D0", "#56616F"],
  gold: ["#FFF3B8", "#E8B62E", "#8A6110"],
  platinum: ["#FFFFFF", "#C9A8FF", "#4A3F78"],
  plain: ["#8A93A3", "#8A93A3", "#474E5B"],
};
const metal = (p) => (p === "plain" || !M[p] ? M.plain[1] : `url(#rcm-${p})`);
const dark = (p) => (M[p] || M.plain)[2];
const F = `font-family="Inter, system-ui, sans-serif"`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const star4 = (x, y, r) => `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
export const burst = (cx, cy, ro, ri, n) => {
  let d = "";
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro, a = (Math.PI * i) / n - Math.PI / 2;
    d += (i ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(1) + " " + (cy + r * Math.sin(a)).toFixed(1);
  }
  return d + "Z";
};

/** The card's own plating gradients (they span the whole card). Put in the page once. */
export function artDefs() {
  const g = (id, stops) => `<linearGradient id="rcm-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="200" y2="250">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
  const m = (t) => g(t, [[0, M[t][0]], [0.2, M[t][1]], [0.38, M[t][0]], [0.6, M[t][1]], [0.8, M[t][0]], [1, M[t][1]]]);
  return `<svg id="rc-art-defs" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${m("bronze")}${m("silver")}${m("gold")}${g("platinum", [[0, "#FF9BD0"], [0.25, "#FFE07A"], [0.5, "#8CF5C8"], [0.75, "#8ACBFF"], [1, "#C9A8FF"]])}</defs></svg>`;
}

// The card's outline (a shield with clipped top corners) and its enamel face.
const OUT = "M18 4H182L196 18V196L100 244L4 196V18Z", IN = "M21 10H179L190 21V192L100 237L10 192V21Z";
const VB = "-4 -3 208 262", H = (w) => Math.round((w * 262) / 208);
export const cardHeight = H;

// The six parts on the card, in order, with the three letters a player card uses.
export const SHORT = { discipline: "DIS", results: "RES", research: "REA", diversification: "SPR", learning: "LRN", market: "NIF" };
// The pin that stands for each part.
export const PART_PIN = { discipline: "held_the_line", results: "first_profit", research: "researcher", diversification: "spread_out", learning: "bookworm", market: "rate_watcher" };

/**
 * The card.
 *   score, grade   the marks and the letter (grade null = still building)
 *   building       { have, need } trades, shown instead of marks when not graded
 *   name           the student's name on the ribbon
 *   plating        bronze | silver | gold | platinum | plain
 *   art            { key, tier } the part whose pin sits on the card, or null
 *   stats          [{ key, score|null, dir: up|down|flat }] the six parts
 *   x, y           set when the card is nested inside another SVG
 */
export function cardSvg({ w = 236, score = null, grade = null, building = null, name = "", plating = "plain", art = null, stats = [], label = "", x = null, y = null } = {}) {
  const m = metal(plating), dk = dark(plating);
  const pos = x == null ? "" : ` x="${x}" y="${y}"`;
  const nm = String(name || "").trim().slice(0, 22);
  const nameSize = nm.length <= 11 ? 19 : Math.max(11, Math.round((19 * 11) / nm.length));
  const pin = art?.key && PART_PIN[art.key]
    ? pinSvg(PART_PIN[art.key], art.tier || "bronze", { size: 92 }).replace(/<svg class="ach-pin-svg"/, '<svg x="94" y="14"')
    : `<path d="${star4(140, 62, 26)}" fill="${C.lilac}" opacity=".35"/>`;
  const head = grade
    ? `<text x="52" y="66" text-anchor="middle" ${F} font-size="50" font-weight="900" fill="${C.cream}" letter-spacing="-1.5">${esc(score)}</text>
       <text x="52" y="90" text-anchor="middle" ${F} font-size="19" font-weight="800" fill="${C.mari}">${esc(grade)}</text>`
    : `<text x="52" y="64" text-anchor="middle" ${F} font-size="38" font-weight="900" fill="${C.cream}" letter-spacing="-1">${esc(building?.have ?? 0)}/${esc(building?.need ?? 5)}</text>
       <text x="52" y="88" text-anchor="middle" ${F} font-size="14" font-weight="700" fill="${C.lilac}">trades</text>`;
  const cells = stats.slice(0, 6).map((s, i) => {
    const cx = 26 + i * 29.6, has = Number.isFinite(s.score);
    const fill = !has ? "#6C7499" : s.dir === "up" ? C.mint : s.dir === "down" ? C.pink : C.cream;
    return `<text x="${cx}" y="170" text-anchor="middle" ${F} font-size="9.5" font-weight="700" fill="${C.lilac}">${SHORT[s.key] || ""}</text><text x="${cx}" y="190" text-anchor="middle" ${F} font-size="${has && s.score >= 100 ? 13 : 17}" font-weight="900" fill="${fill}"${has && s.score >= 100 ? ' letter-spacing="-.4"' : ""}>${has ? s.score : "–"}</text>`;
  }).join("");
  return `<svg class="rc-card-svg" viewBox="${VB}" width="${w}" height="${H(w)}"${pos} role="img" aria-label="${esc(label)}">
    <path d="${OUT}" transform="translate(0,7)" fill="${dk}" stroke="${dk}" stroke-width="6" stroke-linejoin="round"/>
    <path d="${OUT}" fill="${m}" stroke="${m}" stroke-width="6" stroke-linejoin="round"/>
    <path d="${IN}" fill="${C.navy}"/>
    ${head}
    ${pin}
    <rect x="10" y="120" width="180" height="30" fill="${C.cream}"/><path d="M8 120H192M8 150H192" stroke="${m}" stroke-width="2.6"/>
    <text x="100" y="${nameSize < 15 ? 140 : 142}" text-anchor="middle" ${F} font-size="${nameSize}" font-weight="900" fill="${C.navy}">${esc(nm)}</text>
    ${cells}
    <path d="${star4(100, 214, 9)}" fill="${C.mari}" stroke="${m}" stroke-width="1.6"/></svg>`;
}

/** A past (or coming) card, small: the same object with the number and the letter only. */
export function miniSvg({ w = 52, score = "", grade = "", plating = "plain", next = false, label = "" } = {}) {
  const m = metal(plating), dk = dark(plating);
  const a = label ? ` role="img" aria-label="${esc(label)}"` : ` aria-hidden="true"`;
  if (next) {
    return `<svg class="rc-mini-svg is-next" viewBox="${VB}" width="${w}" height="${H(w)}"${a}><path d="${OUT}" fill="none" stroke="currentColor" stroke-width="5" stroke-dasharray="12 12" stroke-linejoin="round"/><text x="100" y="118" text-anchor="middle" ${F} font-size="74" font-weight="900" fill="currentColor">${esc(score)}</text><text x="100" y="168" text-anchor="middle" ${F} font-size="40" font-weight="800" fill="currentColor">${esc(grade)}</text></svg>`;
  }
  return `<svg class="rc-mini-svg" viewBox="${VB}" width="${w}" height="${H(w)}"${a}><path d="${OUT}" transform="translate(0,9)" fill="${dk}" stroke="${dk}" stroke-width="8" stroke-linejoin="round"/><path d="${OUT}" fill="${m}" stroke="${m}" stroke-width="8" stroke-linejoin="round"/><path d="${IN}" fill="${C.navy}"/><text x="100" y="118" text-anchor="middle" ${F} font-size="74" font-weight="900" fill="${C.cream}">${esc(score)}</text><text x="100" y="168" text-anchor="middle" ${F} font-size="40" font-weight="800" fill="${C.mari}">${esc(grade)}</text></svg>`;
}

// The grade seal: a scalloped coin. Enamel colour by letter.
const SEAL_ENAMEL = { "A+": "#19B37A", A: "#19B37A", "B+": "#5367FF", B: "#5367FF", C: "#C2702F", D: "#7B8494" };
export function sealSvg(grade, size = 44, plating = "plain") {
  const m = plating === "plain" || !M[plating] ? M.plain[1] : `url(#achm-${plating})`, dk = dark(plating);
  const edge = burst(32, 32, 30, 27, 18), g = String(grade || "");
  return `<svg class="rc-seal-svg" viewBox="-2 -2 68 72" width="${size}" height="${Math.round((size * 72) / 68)}" aria-hidden="true"><g transform="translate(0,3.2)" fill="${dk}" stroke="${dk}" stroke-width="3" stroke-linejoin="round"><path d="${edge}"/></g><g fill="${m}" stroke="${m}" stroke-width="3" stroke-linejoin="round"><path d="${edge}"/></g><circle cx="32" cy="32" r="22.5" fill="${SEAL_ENAMEL[g] || SEAL_ENAMEL.D}" stroke="${m}" stroke-width="1.7"/><text x="32" y="${g.length > 1 ? 40 : 41.5}" text-anchor="middle" ${F} font-weight="900" font-size="${g.length > 1 ? 23 : 27}" fill="${C.cream}">${esc(g)}</text></svg>`;
}

/** The 12-point star behind a pin on a story screen: one flat colour. */
export const starSvg = (fill, size = 230) => `<svg class="rc-st-star" viewBox="0 0 200 200" width="${size}" height="${size}" aria-hidden="true"><path d="${burst(100, 100, 96, 80, 12)}" fill="${fill}"/></svg>`;

/**
 * The picture that gets sent: 540 x 960 (drawn at 2x = 1080 x 1920), flat
 * navy, the card, four numbers, the address. Stands alone: it carries its own
 * gradients, and the Inter font when `fontCss` is given (an @font-face rule
 * with the font as a data: URL; an <img> cannot load a font file itself).
 *   nums: up to 4 of { big, small, tone: up|down|"" }
 */
export function shareSvg({ card, week = "", nums = [], fontCss = "" } = {}) {
  const line = "rgba(255,244,220,.22)";
  const cell = (n, i) => {
    const col = i % 2, row = i >> 1, x = col ? 290 : 40, y = 668 + row * 96;
    const fill = n.tone === "up" ? C.mint : n.tone === "down" ? C.pink : C.cream;
    return `<text x="${x}" y="${y + 44}" ${F} font-size="38" font-weight="900" letter-spacing="-.8" fill="${fill}">${esc(n.big)}</text><text x="${x}" y="${y + 74}" ${F} font-size="21" fill="${C.cream}" fill-opacity=".75">${esc(n.small)}</text>`;
  };
  const rows = Math.ceil(Math.min(4, nums.length) / 2);
  const rules = rows ? Array.from({ length: rows + 1 }, (_, r) => `M40 ${668 + r * 96}H500`).join("") + `M270 668V${668 + rows * 96}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 960" width="1080" height="1920">
    <defs><style>${fontCss}</style></defs>${pinDefs()}${artDefs()}
    <rect width="540" height="960" fill="${C.navy}"/>
    <text x="40" y="74" ${F} font-size="27" font-weight="800" fill="${C.cream}">StockSaathi</text>
    <text x="500" y="74" text-anchor="end" ${F} font-size="21" fill="${C.cream}" fill-opacity=".75">${esc(week)}</text>
    ${cardSvg({ ...card, w: 400, x: 70, y: 118 })}
    <path d="${rules}" stroke="${line}" stroke-width="3" fill="none"/>
    ${nums.slice(0, 4).map(cell).join("")}
    <text x="270" y="918" text-anchor="middle" ${F} font-size="22" fill="${C.cream}" fill-opacity=".7">stocksaathi.co.in</text></svg>`;
}

/**
 * The wide picture a link preview shows (1200 x 630): the card on the star,
 * the marks and the letter beside it. Drawn on the server (handlers/card-og.py
 * turns it into a PNG), so it stands alone and names no web font.
 */
export function ogSvg({ card, name = "", score = "", grade = "", week = "" } = {}) {
  const nm = String(name || "").trim().slice(0, 22);
  const whose = nm ? `${nm}${/s$/i.test(nm) ? "'" : "'s"} report card` : "Report card";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">${pinDefs()}${artDefs()}
    <rect width="1200" height="630" fill="${C.navy}"/>
    <path d="${burst(300, 315, 292, 244, 12)}" fill="#242C52"/>
    ${cardSvg({ ...card, w: 372, x: 114, y: 78 })}
    <text x="640" y="132" ${F} font-size="34" font-weight="800" fill="${C.cream}">StockSaathi</text>
    <text x="632" y="336" ${F} font-size="200" font-weight="900" letter-spacing="-8" fill="${C.cream}">${esc(score)}</text>
    <text x="640" y="412" ${F} font-size="54" font-weight="800" fill="${C.mari}">${esc(grade)} this week</text>
    <text x="640" y="500" ${F} font-size="32" font-weight="700" fill="${C.cream}">${esc(whose)}</text>
    <text x="640" y="546" ${F} font-size="27" fill="${C.lilac}">${esc(week)}</text>
  </svg>`;
}

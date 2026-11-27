// =============================================================================
// ACHIEVEMENTS — the pins. One hand-drawn enamel pin per achievement family,
// as SVG strings on a 64-unit grid. No imports and no browser APIs, so the
// contact sheet and Node can use this file as it is.
//
// How a pin is built (the rules a pin maker works to):
//   1. side wall  the outline shapes again, 3.2 units lower, in the plating's
//                 dark colour: the pin's thickness, with no blur filter
//   2. metal      the outline shapes filled and stroked with the plating
//   3. enamel     flat colour cells, each inside a thin metal line
//   4. plate      a small tab that prints the tier's target (30, 5%)
// `sil` is the list of closed shapes that make the outline (1 and 2); `art`
// is everything drawn on top (3). The subject always breaks out of the
// backplate somewhere, so every pin has its own outline.
//
// Backplate by group: milestone circle, habit shield, learning hexagon,
// coming back rounded square, market calendar 12-point star.
// Tier = plating: bronze, silver, gold, platinum (rainbow).
//
// AI-drafted seasonal achievements have no drawing of their own:
// eventPinSvg() builds one from parts (star in the event's colours, a centre
// picked by what the pin asks for, the event's date on a ribbon).
// =============================================================================

const C = {
  mint: "#1FD1A1", green: "#19B37A", deep: "#0F5A46", saff: "#FF8A2A", mari: "#FFC93C",
  cream: "#FFF4DC", red: "#F2554A", pink: "#FF7EB6", indigo: "#5367FF", navy: "#1C2340",
  sky: "#8FD8FF", chai: "#C2702F", wood: "#F3C77A", plum: "#4B2A7A", steel: "#C9D2DC",
};
// Plating: light, mid, dark (dark is the side wall).
const M = {
  bronze: ["#FFD9B5", "#D08A52", "#7C4521"],
  silver: ["#FFFFFF", "#B9C4D0", "#56616F"],
  gold: ["#FFF3B8", "#E8B62E", "#8A6110"],
  platinum: ["#FFFFFF", "#C9A8FF", "#4A3F78"],
};
export const PLATINGS = Object.keys(M);
const FONT = `font-family="Inter, system-ui, sans-serif" font-weight="900" stroke="none"`;

/** The four plating gradients. Put this in the page once (ui.js ensureStyle). */
export function pinDefs() {
  const g = (id, stops) => `<linearGradient id="achm-${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="64">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
  const metal = (t) => g(t, [[0, M[t][0]], [0.36, M[t][1]], [0.55, M[t][0]], [1, M[t][1]]]);
  return `<svg id="ach-pin-defs" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${metal("bronze")}${metal("silver")}${metal("gold")}${g("platinum", [[0, "#FF9BD0"], [0.25, "#FFE07A"], [0.5, "#8CF5C8"], [0.75, "#8ACBFF"], [1, "#C9A8FF"]])}</defs></svg>`;
}

// ---- drawing helpers --------------------------------------------------------
const burst = (cx, cy, ro, ri, n) => {
  let d = "";
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro, a = (Math.PI * i) / n - Math.PI / 2;
    d += (i ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(1) + " " + (cy + r * Math.sin(a)).toFixed(1);
  }
  return d + "Z";
};
const star4 = (x, y, r) => `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
const flat = (c) => ` fill="${c}" stroke="none"`;
// A coloured line with a metal line under it.
const ln = (d, c, w = 3.4, under = w + 3) => `<path d="${d}" fill="none" stroke-width="${under}"/><path d="${d}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
// A plain ink line (no metal): details, ticks, rain.
const ink = (d, c, w = 1.6, extra = "") => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}"${extra}/>`;
const txt = (x, y, s, size, fill) => `<text x="${x}" y="${y}" text-anchor="middle" ${FONT} font-size="${size}" fill="${fill}">${s}</text>`;
const el = (rx, ry, cx, cy, rot, a = "") => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})"${a}/>`;

const STAR = burst(32, 34, 27, 22, 12);
const bp = {
  circle: (a = "") => `<circle cx="32" cy="33" r="25"${a}/>`,
  shield: (a = "") => `<path d="M32 5L53 11Q55 11.6 55 14V31Q55 48 32 58Q9 48 9 31V14Q9 11.6 11 11Z"${a}/>`,
  hex: (a = "") => `<path d="M32 5L54 17.5V43.5L32 56L10 43.5V17.5Z"${a}/>`,
  sq: (a = "") => `<rect x="8" y="9" width="48" height="48" rx="14"${a}/>`,
  star: (a = "") => `<path d="${STAR}"${a}/>`,
};
const GROUP = {
  milestone: ["circle", C.mint], habit: ["shield", C.indigo], learning: ["hex", C.navy],
  streak: ["sq", C.pink], season: ["star", C.plum],
};

// Shapes used by more than one layer of the same pin.
const FLAME = "M32 3C39 12 42 19 37.5 26C35 29.5 29 29.5 26.5 26C22 19 25 12 32 3Z";
const BOWL = "M10 35H54C54 47 44 56 32 56C20 56 10 47 10 35Z";
const GL = "M14 16H32L29.5 50Q29.3 52 27.3 52H18.7Q16.7 52 16.5 50Z";
const GR = "M32 16H50L47.5 50Q47.3 52 45.3 52H36.7Q34.7 52 34.5 50Z";
const SHOE = "M5 47V31Q5 26 10 26H19Q22 26 24.5 28.5L33 37Q35.5 39.5 41 40L53 41.5Q61 43 61 49Q61 53 57 53H9Q5 53 5 49Z";
const MANGO = "M30 14C42 11 53 22 50 37C48 48 39 55 29 53C18 51 12 41 15 30C17 22 22 16 30 14Z";
const LEAF = "M33 13Q40 0 54 4Q50 15 33 13Z";
const TAG = "M32 4L49 17V52Q49 56 45 56H19Q15 56 15 52V17Z";
const ARROW = "M40 21L51 10L47.5 6.5H60.5V19.5L57 16L46 27Z";
const PAGE_L = "M5 40Q19 35 32 41V57Q19 52 5 56Z", PAGE_R = "M59 40Q45 35 32 41V57Q45 52 59 56Z";
const PAGE_LINES = "M11 45.5Q19 43 26 46M11 50Q19 47.5 26 50.5M38 46Q45 43 53 45.5M38 50.5Q45 47.5 53 50";
const BIG_FLAME = "M32 2C42 13 47 22 41.5 31C38 36.5 26 36.5 22.5 31C17 22 22 13 32 2Z";
const MOON = "M38 6A19 19 0 1 0 52 36A15 15 0 0 1 38 6Z";
const CANOPY = "M4 33A28 28 0 0 1 60 33Q53 27.5 46 33Q39 27.5 32 33Q25 27.5 18 33Q11 27.5 4 33Z";
const BELL = "M32 9C22.5 9 18.5 18 18.5 29V40L12.5 47H51.5L45.5 40V29C45.5 18 41.5 9 32 9Z";
const STAIRS = "M12 50V42H22V34H32V26H43V50Z";
const BOTTLE = "M25 30H39V35L44 41V53Q44 57 40 57H24Q20 57 20 53V41L25 35Z";
const star5 = (cx, cy, ro, ri) => burst(cx, cy, ro, ri, 5);

// ---- the pins ---------------------------------------------------------------
// plate: where the number tab sits, [x, y] of a 22 x 12.5 tab, or null.
const PIN = {
  // ------------------------------------------------------------ milestones
  first_steps: {
    plate: null,
    sil: bp.circle() + `<path d="${SHOE}"/>`,
    art: bp.circle(flat(C.mint)) + ln("M15 23L24 14L31 20L43 10", C.cream, 2.6, 5.4) + `<circle cx="43" cy="10" r="3.3" fill="${C.cream}"/>`
      + `<path d="M5 47V31Q5 26 10 26H19Q22 26 24.5 28.5L33 37Q35.5 39.5 41 40L53 41.5Q60 42.8 61 47Z" fill="#fff"/>`
      + `<path d="M5 47H61V49Q61 53 57 53H9Q5 53 5 49Z" fill="${C.cream}"/>`
      + `<path d="M47 40.8L53 41.5Q60 42.8 61 47H44Q44 43 47 40.8Z" fill="${C.saff}"/>`
      + `<path d="M5 47V31Q5 26 10 26H13.5V47Z" fill="${C.indigo}"/>`
      + `<path d="M19.5 34L24 30M23.5 37.5L28 33.5M27.5 41L32 37" fill="none"/>`,
  },
  first_profit: {
    plate: null,
    sil: bp.circle() + `<path d="${ARROW}"/>`,
    art: bp.circle(flat(C.mint)) + `<circle cx="30" cy="36" r="17" fill="${C.mari}"/><circle cx="30" cy="36" r="12.5" fill="#FFE08A" stroke-width="1.2"/>`
      + ink("M24.5 29.5H36M24.5 34H36M25 29.5C32.5 29.5 32.5 38.5 25 38.5L33.5 46", "#8A5A00", 2.4)
      + `<path d="${ARROW}" fill="${C.green}"/>`,
  },
  your_price: {
    plate: [38, 47],
    sil: bp.circle() + `<path d="${TAG}" transform="rotate(-16 32 32)"/>`,
    art: bp.circle(flat(C.mint)) + `<g transform="rotate(-16 32 32)"><path d="${TAG}" fill="${C.cream}"/>`
      + `<circle cx="32" cy="15" r="3.2" fill="${C.mint}" stroke-width="1.3"/><circle cx="32" cy="37" r="12" fill="${C.red}"/><circle cx="32" cy="37" r="7.5" fill="${C.cream}" stroke-width="1.3"/><circle cx="32" cy="37" r="3.2" fill="${C.red}" stroke-width="1.2"/></g>`,
  },
  fund_first: {
    plate: null,
    sil: bp.circle() + `<rect x="5" y="31" width="54" height="7.5" rx="3.7"/><path d="M9 38H55L49.5 54Q49 57 46 57H18Q15 57 14.5 54Z"/>`,
    art: bp.circle(flat(C.mint)) + `<circle cx="21" cy="24" r="8.5" fill="${C.red}"/><circle cx="45.5" cy="25" r="8" fill="${C.green}"/><circle cx="33.5" cy="19" r="9.5" fill="${C.saff}"/>`
      + `<path d="M33.5 9.5Q38 5 42 8Q38 12 33.5 9.5Z" fill="${C.green}" stroke-width="1.1"/>`
      + `<path d="M9 38H55L49.5 54Q49 57 46 57H18Q15 57 14.5 54Z" fill="${C.wood}"/>`
      + ink("M11.5 44H52.5M13.5 50H50.5M22 38V57M32 38V57M42 38V57", C.chai, 1.2)
      + `<rect x="5" y="31" width="54" height="7.5" rx="3.7" fill="${C.chai}"/>`,
  },
  day_one: {
    // A school bag on the first day.
    plate: null,
    sil: bp.circle() + `<path d="M26 16V9Q26 3.5 32 3.5Q38 3.5 38 9V16" fill="none"/><rect x="12" y="13" width="40" height="45" rx="12"/><path d="${star4(55, 11, 7)}"/>`,
    art: bp.circle(flat(C.mint)) + `<rect x="12" y="13" width="40" height="45" rx="12" fill="${C.saff}"/><path d="M12 30V25Q12 13 24 13H40Q52 13 52 25V30Z" fill="${C.red}"/>`
      + ink("M21 25L27 20L32 24L42 17", C.cream, 2.4) + `<rect x="19" y="36" width="26" height="16" rx="5" fill="${C.mari}"/>` + ink("M24 41.5H40", C.chai, 1.6)
      + `<rect x="30" y="40" width="4" height="6" rx="2" fill="${C.cream}" stroke-width="1.1"/><path d="${star4(55, 11, 7)}" fill="${C.mari}"/>`,
  },
  first_week: {
    // A sand timer: a week of waiting.
    plate: null,
    sil: bp.circle() + `<rect x="13" y="4" width="38" height="7.5" rx="3.5"/><rect x="13" y="54" width="38" height="7.5" rx="3.5"/><path d="M18 11H46Q46 24 35 32Q46 40 46 54H18Q18 40 29 32Q18 24 18 11Z"/>`,
    art: bp.circle(flat(C.mint)) + `<path d="M18 11H46Q46 24 35 32Q46 40 46 54H18Q18 40 29 32Q18 24 18 11Z" fill="#EAF7FF"/>`
      + `<path d="M23.5 19H40.5Q38.5 25 33.5 29.5H30.5Q25.5 25 23.5 19Z"${flat(C.mari)}/><path d="M20.5 53Q21.5 44.5 32 42Q42.5 44.5 43.5 53Z"${flat(C.mari)}/>` + ink("M32 30V42", C.mari, 1.8)
      + ink("M22 15Q23 20 26 23", "#fff", 1.6, ` opacity=".8"`) + `<rect x="13" y="4" width="38" height="7.5" rx="3.5" fill="${C.chai}"/><rect x="13" y="54" width="38" height="7.5" rx="3.5" fill="${C.chai}"/>`,
  },
  first_report_card: {
    // A clipboard with the report card's hexagon on it.
    plate: null,
    sil: bp.circle() + `<rect x="14" y="9" width="36" height="50" rx="5"/><rect x="24" y="3" width="16" height="11" rx="3.5"/>`,
    art: bp.circle(flat(C.mint)) + `<rect x="14" y="9" width="36" height="50" rx="5" fill="${C.chai}"/><rect x="18" y="15" width="28" height="40" rx="2" fill="${C.cream}" stroke-width="1.2"/>`
      + ink("M23 21H35", "#B9B09A", 1.5) + `<path d="M32 26L42 31.8V43.2L32 49L22 43.2V31.8Z" fill="#fff" stroke="#9AA3B5" stroke-width="1.2"/>`
      + `<path d="M32 29.5L39.5 33.5L37.5 42.5L32 45L25.5 41L27 33Z" fill="${C.mint}" stroke="${C.deep}" stroke-width="1.3"/>`
      + `<rect x="24" y="3" width="16" height="11" rx="3.5" fill="${C.steel}"/><circle cx="32" cy="7.5" r="1.8"${flat(C.navy)}/>`,
  },
  campus_tour: {
    // A folded map with a marker: looked around the whole place.
    plate: [3, 47],
    sil: bp.circle() + `<path d="M7 21L24 14L40 21L57 14V50L40 57L24 50L7 57Z"/><path d="M46 5C52.5 5 57 9.6 57 15.5C57 23 46 33 46 33C46 33 35 23 35 15.5C35 9.6 39.5 5 46 5Z"/>`,
    art: bp.circle(flat(C.mint)) + `<path d="M7 21L24 14V50L7 57Z" fill="${C.cream}"/><path d="M24 14L40 21V57L24 50Z" fill="#DDF3FF"/><path d="M40 21L57 14V50L40 57Z" fill="${C.cream}"/>`
      + ink("M12 47Q17 37 24 40T35 35", C.red, 2, ` stroke-dasharray="3.2 2.6"`) + ink("M44 46H52M44 41H50", "#C9BFA5", 1.4)
      + `<path d="M46 5C52.5 5 57 9.6 57 15.5C57 23 46 33 46 33C46 33 35 23 35 15.5C35 9.6 39.5 5 46 5Z" fill="${C.red}"/><circle cx="46" cy="15.5" r="4" fill="${C.cream}" stroke-width="1.2"/>`,
  },
  in_the_green: {
    // A hot-air balloon: up, and staying up.
    plate: [21, 52],
    sil: bp.circle() + `<path d="M32 2C43 2 49 9.5 49 18C49 26.5 40.5 31 37 36H27C23.5 31 15 26.5 15 18C15 9.5 21 2 32 2Z"/><rect x="25.5" y="41" width="13" height="9.5" rx="2.5"/>`,
    art: bp.circle(flat(C.mint)) + `<circle cx="12.5" cy="40" r="2.2"${flat(C.cream)}/><circle cx="51" cy="43" r="1.8"${flat(C.cream)}/><circle cx="53.5" cy="30" r="1.4"${flat(C.cream)}/>`
      + `<path d="M32 2C43 2 49 9.5 49 18C49 26.5 40.5 31 37 36H27C23.5 31 15 26.5 15 18C15 9.5 21 2 32 2Z" fill="${C.green}"/>`
      + `<path d="M32 2C37.5 8 38 25 35 36H29C26 25 26.5 8 32 2Z" fill="${C.cream}" stroke-width="1.2"/>` + ink("M19.5 12Q21.5 8 25 6", "#fff", 2, ` opacity=".7"`)
      + `<path d="M27.5 36L27 41M36.5 36L37 41" fill="none" stroke-width="1.2"/><rect x="25.5" y="41" width="13" height="9.5" rx="2.5" fill="${C.wood}"/>` + ink("M26 45.5H38", C.chai, 1.2),
  },
  // ------------------------------------------------------------ coming back
  old_friend: {
    plate: [21, 51],
    sil: bp.sq() + `<path d="${GL}" transform="rotate(14 23 34)"/><path d="${GR}" transform="rotate(-14 41 34)"/><path d="${star4(32, 7, 7)}"/>`,
    art: bp.sq(flat(C.pink))
      + [[GL, "rotate(14 23 34)", 0], [GR, "rotate(-14 41 34)", 18]].map(([g, t, dx]) => `<g transform="${t}"><path d="${g}" fill="#EAF7FF"/>`
        + `<path d="M${14.6 + dx} 24H${31.4 + dx}L${29.5 + dx} 50Q${29.3 + dx} 52 ${27.3 + dx} 52H${18.7 + dx}Q${16.7 + dx} 52 ${16.5 + dx} 50Z" fill="${C.chai}"/>`
        + `<path d="M${14.4 + dx} 21.5H${31.6 + dx}L${31.4 + dx} 24H${14.6 + dx}Z" fill="${C.cream}" stroke="none"/>`
        + ink(`M${20 + dx} 28V47M${26 + dx} 28V47`, "#E7A566", 1.3) + `</g>`).join("")
      + `<path d="${star4(32, 7, 7)}" fill="${C.mari}"/>`,
  },
  regular: {
    plate: [3, 46],
    sil: bp.sq() + `<path d="M25 22L18 1H23.5L30 22Z"/><path d="M34 22L40.5 1H46L39 22Z"/><rect x="16" y="20" width="32" height="36" rx="5"/><circle cx="47" cy="51" r="8"/>`,
    art: bp.sq(flat(C.pink)) + `<path d="M25 22L18 1H23.5L30 22Z" fill="${C.indigo}"/><path d="M34 22L40.5 1H46L39 22Z" fill="${C.indigo}"/>`
      + `<rect x="16" y="20" width="32" height="36" rx="5" fill="${C.cream}"/><path d="M16 30V25Q16 20 21 20H43Q48 20 48 25V30Z" fill="${C.mint}"/>`
      + `<rect x="28" y="23.5" width="8" height="2.6" rx="1.3"${flat(C.navy)}/><circle cx="25.5" cy="40" r="5" fill="${C.sky}"/>`
      + ink("M34 37.5H43M34 42.5H41", "#9AA3B5", 1.5)
      + `<circle cx="47" cy="51" r="8" fill="${C.green}"/>` + ink("M43 51L46 54L51.5 48", "#fff", 2.3),
  },
  learning_streak: {
    plate: [21, 53],
    sil: bp.sq() + `<path d="${BIG_FLAME}"/><path d="${PAGE_L}"/><path d="${PAGE_R}"/>`,
    art: bp.sq(flat(C.pink)) + `<path d="${BIG_FLAME}" fill="${C.saff}"/>`
      + `<path d="M32 15C37.5 21 39.5 26 37 30.5C35.3 33 28.7 33 27 30.5C24.5 26 26.5 21 32 15Z" fill="${C.mari}" stroke-width="1.1"/>`
      + `<path d="${PAGE_L}" fill="${C.cream}"/><path d="${PAGE_R}" fill="${C.cream}"/>` + ink(PAGE_LINES, "#C9BFA5", 1.2),
  },
  weekly_regular: {
    plate: [21, 53],
    sil: bp.sq() + `<rect x="4" y="29" width="56" height="20" rx="7"/>`,
    art: bp.sq(flat(C.pink)) + ln("M21 17L28.5 24.5L44 7", C.green, 4, 7.2) + `<rect x="4" y="29" width="56" height="20" rx="7" fill="${C.cream}"/>`
      + [11.5, 18.3, 25.2, 32, 38.8, 45.7, 52.5].map((x, i) => `<circle cx="${x}" cy="39" r="2.7"${flat(i === 4 ? "#C9BFA5" : C.green)}/>`).join(""),
  },
  weekend_scholar: {
    plate: [34, 49],
    sil: bp.sq() + `<circle cx="47" cy="15" r="12"/><rect x="11" y="22" width="34" height="34" rx="5" transform="rotate(-6 28 39)"/>`,
    art: bp.sq(flat(C.pink)) + ink("M58.5 4.5L56.5 6.5M62.5 15H60M33.5 3.5L35.5 5.5M47 0V2", C.mari, 2.2) + `<circle cx="47" cy="15" r="12" fill="${C.mari}"/>`
      + `<g transform="rotate(-6 28 39)"><rect x="11" y="22" width="34" height="34" rx="5" fill="${C.cream}"/><path d="M11 32V27Q11 22 16 22H40Q45 22 45 27V32Z" fill="${C.red}"/>`
      + `<rect x="18" y="18.5" width="4" height="8" rx="2" fill="#fff" stroke-width="1.2"/><rect x="34" y="18.5" width="4" height="8" rx="2" fill="#fff" stroke-width="1.2"/>`
      + txt(28, 49, "Sun", 12, C.navy) + `</g>`,
  },
  // ------------------------------------------------------------ good habits
  long_termer: {
    plate: [36, 47],
    sil: bp.shield() + `<circle cx="20" cy="21" r="11.5"/><circle cx="33" cy="14" r="12.5"/><circle cx="46" cy="22" r="11"/><circle cx="32" cy="27" r="12"/><path d="M27 30H37L40 55H24Z"/>`,
    art: bp.shield(flat(C.indigo)) + `<path d="M27 30H37L40 55H24Z" fill="${C.chai}"/>` + ink("M16 31V44M48 31V42M43.5 36V48M20.5 33V40", C.chai, 2)
      + `<circle cx="20" cy="21" r="11.5"${flat(C.green)}/><circle cx="33" cy="14" r="12.5"${flat(C.green)}/><circle cx="46" cy="22" r="11"${flat(C.green)}/><circle cx="32" cy="27" r="12"${flat(C.green)}/>`
      + `<circle cx="27" cy="12" r="3"${flat("#5ED3A0")}/><circle cx="41" cy="18" r="2.4"${flat("#5ED3A0")}/><circle cx="18" cy="22" r="2.2"${flat("#5ED3A0")}/>`,
  },
  held_the_line: {
    plate: [5, 42],
    sil: bp.shield() + `<circle cx="50" cy="16" r="7.5"/><g transform="rotate(-24 31 34)"><rect x="24.5" y="26" width="13" height="28" rx="4"/><rect x="28.5" y="8" width="5" height="20" rx="2.5"/></g>`,
    art: bp.shield(flat(C.indigo)) + `<g transform="rotate(-24 31 34)"><rect x="28.5" y="8" width="5" height="20" rx="2.5" fill="${C.saff}"/><path d="M28.5 13.5H33.5M28.5 18.5H33.5" fill="none" stroke-width="1.1"/>`
      + `<rect x="24.5" y="26" width="13" height="28" rx="4" fill="${C.wood}"/><path d="M31 31V50" fill="none"/></g>`
      + `<circle cx="50" cy="16" r="7.5" fill="${C.red}"/>` + ink("M45 12.5Q50 16 50.5 22.5", C.cream, 1.4) + ink("M58 6L61 2.5M61 12L64 10.5", C.red, 2.2),
  },
  comeback: {
    plate: [33, 47],
    sil: bp.shield() + `<path d="M48 3H61V16Z"/>`,
    art: bp.shield(flat(C.indigo)) + ink("M30 12V14.5M17.5 27H15M19.8 16.8L21.6 18.6M40.2 16.8L38.4 18.6", C.mari, 2) + `<circle cx="30" cy="27" r="9.5" fill="${C.mari}"/>`
      + ln("M10 24L26 47", C.red, 3.6) + ln("M26 47L37 37L55 9", C.green, 3.6) + `<path d="M48 3H61V16Z" fill="${C.green}"/>`,
  },
  spread_out: {
    plate: [21, 54],
    sil: bp.shield() + `<circle cx="32" cy="34" r="25.5"/>`,
    art: bp.shield(flat(C.indigo)) + `<circle cx="32" cy="34" r="25.5" fill="${C.steel}"/><circle cx="32" cy="34" r="20.5" fill="#EEF2F6" stroke-width="1.2"/>`
      + `<circle cx="21" cy="25" r="6.6" fill="${C.mari}"/><circle cx="40" cy="22.5" r="6.6" fill="${C.green}"/><circle cx="46" cy="38" r="6.6" fill="${C.red}"/><circle cx="19" cy="41" r="6.6" fill="${C.cream}"/>`
      + `<circle cx="32" cy="43" r="8" fill="${C.wood}"/><circle cx="30" cy="41" r="1.1"${flat(C.chai)}/><circle cx="34.5" cy="44.5" r="1.1"${flat(C.chai)}/><circle cx="29.5" cy="46" r="0.9"${flat(C.chai)}/>`,
  },
  balanced_basket: {
    plate: null,
    sil: bp.shield() + `<path d="M3 37H25Q23.5 47 14 47Q4.5 47 3 37Z"/><path d="M39 37H61Q59.5 47 50 47Q40.5 47 39 37Z"/><circle cx="32" cy="10" r="4"/>`,
    art: bp.shield(flat(C.indigo)) + `<path d="M32 13V50M12 20H52" fill="none" stroke-width="3"/><path d="M12 20L5 37M12 20L23 37M52 20L41 37M52 20L59 37" fill="none" stroke-width="1.3"/>`
      + `<path d="M23 55H41L38 49H26Z" fill="${C.mari}"/><circle cx="14" cy="33.5" r="4" fill="${C.mint}"/><circle cx="50" cy="33.5" r="4" fill="${C.pink}"/>`
      + `<path d="M3 37H25Q23.5 47 14 47Q4.5 47 3 37Z" fill="${C.mari}"/><path d="M39 37H61Q59.5 47 50 47Q40.5 47 39 37Z" fill="${C.mari}"/><circle cx="32" cy="10" r="4" fill="${C.red}"/>`,
  },
  fund_patience: {
    plate: [3, 44],
    sil: bp.shield() + `<path d="${BOTTLE}"/>` + el(8, 5.5, 21, 20, -30) + el(8, 5.5, 41, 12, 25) + el(7.5, 5, 51, 26, -20),
    art: bp.shield(flat(C.indigo)) + ink("M32 31C32 23 27 22 24 20.5M32 27C33 19 37 15.5 40 13.5M33 29C38 29 44 27.5 49 26.5", C.green, 2.2)
      + el(8, 5.5, 21, 20, -30, ` fill="${C.green}"`) + el(8, 5.5, 41, 12, 25, ` fill="${C.green}"`) + el(7.5, 5, 51, 26, -20, ` fill="${C.green}"`)
      + `<path d="${BOTTLE}" fill="#EAF7FF"/><path d="M20.8 45H43.2V53Q43.2 56.2 40 56.2H24Q20.8 56.2 20.8 53Z"${flat(C.sky)}/>` + ink("M30 45V52M34 45V50", C.green, 1.3),
  },
  sip_spirit: {
    plate: [21, 54],
    sil: bp.shield() + `<circle cx="32" cy="39" r="17.5"/><rect x="24" y="17" width="16" height="8" rx="4"/><circle cx="32" cy="7" r="6.5"/>`,
    art: bp.shield(flat(C.indigo)) + `<circle cx="32" cy="7" r="6.5" fill="${C.mari}"/><circle cx="32" cy="7" r="3" fill="#FFE08A" stroke-width="1"/>`
      + `<circle cx="32" cy="39" r="17.5" fill="${C.saff}"/><rect x="24" y="17" width="16" height="8" rx="4" fill="${C.chai}"/><rect x="27.5" y="19.7" width="9" height="2.6" rx="1.3"${flat(C.navy)}/>`
      + ink("M17 38.5L21 34.5L25 38.5L28.5 34.5L32 38.5L35.5 34.5L39 38.5L43 34.5L47 38.5", C.cream, 1.8)
      + `<circle cx="24" cy="46" r="1.5"${flat(C.cream)}/><circle cx="32" cy="48" r="1.5"${flat(C.cream)}/><circle cx="40" cy="46" r="1.5"${flat(C.cream)}/>`,
  },
  patient_profit: {
    plate: [21, 53],
    sil: bp.shield() + `<path d="${MANGO}"/><path d="${LEAF}"/>`,
    art: bp.shield(flat(C.indigo)) + `<path d="M31 15V10" fill="none" stroke-width="2.6"/><path d="${LEAF}" fill="${C.green}"/><path d="M36 11.5Q43 6 51 5.2" fill="none" stroke-width="1.1"/>`
      + `<path d="${MANGO}" fill="${C.mari}"/><path d="M15.2 31C13 41 19 51 29 53C23 47 19 40 19.5 31Z"${flat(C.saff)}/>` + ink("M21 23Q24 18.5 28.5 17.5", "#fff", 2.2, ` opacity=".75"`)
      + `<rect x="20" y="27" width="11.5" height="8.5" rx="3.3" fill="${C.navy}"/><rect x="35.5" y="26" width="11.5" height="8.5" rx="3.3" fill="${C.navy}"/><path d="M31.5 30.8L35.5 30.2" fill="none"/>`
      + ink("M22.5 32.5L25.2 29.8M38 31.5L40.7 28.8", "#fff", 1.2) + ink("M28 41.5Q33 46 38.8 40.5", "#7A3E00", 1.9),
  },
  sleep_on_it: {
    plate: [21, 54],
    sil: bp.shield() + `<path d="${MOON}"/><rect x="8" y="43" width="48" height="13" rx="6.5"/>`,
    art: bp.shield(flat(C.indigo)) + `<rect x="8" y="43" width="48" height="13" rx="6.5" fill="${C.cream}"/>` + ink("M14 49.5H50", C.pink, 2)
      + `<path d="${MOON}" fill="${C.mari}"/>` + ink("M23.5 25Q26.5 28 29.5 25", "#7A4A00", 1.7) + ink("M25.5 33Q28.5 35.2 31.5 33", "#7A4A00", 1.5)
      + ink("M45 14H51L45 21H51", C.cream, 2) + ink("M54 3H59L54 9H59", C.cream, 1.8),
  },
  homework: {
    plate: [3, 45],
    sil: bp.shield() + `<rect x="15" y="11" width="34" height="44" rx="4" transform="rotate(-7 32 33)"/><path d="${star5(49, 12, 10, 4.6)}"/>`,
    art: bp.shield(flat(C.indigo)) + `<g transform="rotate(-7 32 33)"><rect x="15" y="11" width="34" height="44" rx="4" fill="${C.cream}"/><path d="M15 15Q15 11 19 11H22V55H19Q15 55 15 51Z" fill="${C.pink}"/>`
      + ink("M27 21H44M27 27H44M27 33H39", C.sky, 1.5) + ink("M26 43L31.5 49L44 35", C.red, 3.4) + `</g><path d="${star5(49, 12, 10, 4.6)}" fill="${C.mari}"/>`,
  },
  calm_hands: {
    plate: [21, 53],
    sil: bp.shield() + `<path d="M4 36H60L49 51H15Z"/><path d="M32 9L47 36H17Z"/>`,
    art: bp.shield(flat(C.indigo)) + ink("M22 55Q27 53 32 55T42 55", C.sky, 2) + `<path d="M32 9L47 36H17Z" fill="#fff"/><path d="M32 9V36" fill="none" stroke-width="1.2"/>`
      + `<path d="M4 36H60L49 51H15Z" fill="${C.cream}"/><path d="M22 36L27 51M42 36L37 51" fill="none" stroke-width="1.1"/>`,
  },
  steady_improver: {
    plate: null,
    sil: bp.shield() + `<path d="${STAIRS}"/><rect x="36.8" y="3" width="2.8" height="24" rx="1.4"/><path d="M39.6 4L55 10L39.6 16Z"/>`,
    art: bp.shield(flat(C.indigo)) + `<rect x="36.8" y="3" width="2.8" height="24" rx="1.4" fill="${C.mari}" stroke-width="1"/><path d="M39.6 4L55 10L39.6 16Z" fill="${C.red}"/>`
      + `<path d="${STAIRS}" fill="${C.cream}"/>` + ink("M22 42V50M32 34V50", "#C9BFA5", 1.2),
  },
  set_and_wait: {
    plate: [3, 44],
    sil: bp.shield() + `<rect x="30.3" y="0" width="3.4" height="16" rx="1.7"/><circle cx="32" cy="26" r="12.5"/>`,
    art: bp.shield(flat(C.indigo)) + `<rect x="30.3" y="0" width="3.4" height="16" rx="1.7" fill="${C.mari}" stroke-width="1"/>`
      + `<path d="M19.5 26A12.5 12.5 0 0 1 44.5 26Z" fill="${C.red}"/><path d="M19.5 26A12.5 12.5 0 0 0 44.5 26Z" fill="#fff"/>`
      + `<path d="M10.5 33Q15.9 29 21.3 33T32 33T42.7 33T53.5 33Q53 47 32 56.5Q11 47 10.5 33Z" fill="${C.sky}" stroke-width="1.2"/>`
      + `<path d="M32 38.5V43" fill="none" stroke-width="1.2"/><path d="M32 41.5L38.5 46V54H25.5V46Z" fill="${C.cream}"/><circle cx="32" cy="46" r="1.3"${flat(C.navy)}/>` + ink("M28.5 50.5H35.5", C.red, 1.6),
  },
  red_day_calm: {
    plate: [36, 45],
    sil: bp.shield() + `<path d="${CANOPY}"/><circle cx="32" cy="5.5" r="3"/>`,
    art: bp.shield(flat(C.indigo)) + ink("M14 2.5L12 7.5M50 2.5L48 7.5M58.5 13L57 17.5M7 13L5.5 17.5M6.5 40L5 44.5M58 40L56.5 44.5", C.red, 2.4)
      + `<path d="M32 33V50Q32 55.5 26.5 55.5" fill="none" stroke-width="3"/><path d="${CANOPY}" fill="${C.mint}"/><path d="M32 5L18 33M32 5L46 33M32 5V33" fill="none" stroke-width="1.1"/><circle cx="32" cy="5.5" r="3" fill="${C.mari}"/>`,
  },
  // ------------------------------------------------------------ learning
  time_traveller: {
    plate: [21, 53],
    sil: bp.hex() + `<rect x="28.5" y="0.5" width="7" height="8" rx="2.5"/><path d="M49 33.5H60L54.5 25Z"/>`,
    art: bp.hex(flat(C.navy)) + `<rect x="28.5" y="0.5" width="7" height="8" rx="2.5" fill="${C.mari}"/>` + ln("M47.9 16.1A22.5 22.5 0 1 0 54.5 32", C.mari, 3, 5.6)
      + `<path d="M49 33.5H60L54.5 25Z" fill="${C.mari}"/><circle cx="32" cy="32" r="16.5" fill="${C.cream}"/><path d="M32 18.5V21M32 43V45.5M18.5 32H21M43 32H45.5" fill="none" stroke-width="1.2"/>`
      + ink("M32 32V22.5M32 32L25.5 35.5", C.navy, 2.4) + `<circle cx="32" cy="32" r="1.9"${flat(C.red)}/>`,
  },
  curious_mind: {
    plate: [38, 45],
    sil: bp.hex() + `<circle cx="49" cy="13" r="10.5"/><rect x="24" y="36" width="13" height="24" rx="5"/><rect x="20" y="15" width="21" height="25" rx="9"/>` + el(4.5, 6.5, 19, 33, -25),
    art: bp.hex(flat(C.navy)) + `<rect x="24" y="36" width="13" height="24" rx="5" fill="${C.mint}"/>` + el(4.5, 6.5, 19, 33, -25, ` fill="${C.mari}"`)
      + `<rect x="20" y="15" width="21" height="25" rx="9" fill="${C.mari}"/><path d="M25.3 16.5V27M30.5 15.5V27M35.7 16.5V27" fill="none" stroke-width="1.2"/>`
      + `<path d="M42 20L37.5 25.5L45.5 22.5Z" fill="${C.pink}"/><circle cx="49" cy="13" r="10.5" fill="${C.pink}"/>` + txt(49, 18.2, "?", 15, "#fff"),
  },
  bookworm: {
    plate: [21, 53],
    sil: bp.hex() + `<path d="${PAGE_L}"/><path d="${PAGE_R}"/><circle cx="39" cy="14" r="9.5"/>`,
    art: bp.hex(flat(C.navy)) + ln("M30 44C21 36 23 25 34 20", "#7BD88F", 9, 12) + `<path d="${PAGE_L}" fill="${C.cream}"/><path d="${PAGE_R}" fill="${C.cream}"/>` + ink(PAGE_LINES, "#C9BFA5", 1.2)
      + `<circle cx="39" cy="14" r="9.5" fill="#7BD88F"/><circle cx="35.5" cy="12.5" r="3.6" fill="#fff" stroke="${C.navy}" stroke-width="1.3"/><circle cx="43.5" cy="12.5" r="3.6" fill="#fff" stroke="${C.navy}" stroke-width="1.3"/>`
      + `<circle cx="36" cy="12.8" r="1.1"${flat(C.navy)}/><circle cx="44" cy="12.8" r="1.1"${flat(C.navy)}/>` + ink("M36 18.6Q39.5 21 43 18.6", "#1F6B3A", 1.4),
  },
  researcher: {
    plate: [8, 45],
    sil: bp.hex() + `<rect x="46.25" y="44.5" width="7.5" height="17" rx="3.7" transform="rotate(-45 50 53)"/>`,
    art: bp.hex(flat(C.navy)) + `<path d="M20 21V45M30 15V41" fill="none"/><rect x="16.5" y="27" width="7" height="11" rx="1" fill="${C.mint}"/><rect x="26.5" y="19" width="7" height="13" rx="1" fill="${C.red}"/>`
      + `<circle cx="39" cy="36" r="10.5" fill="${C.sky}" stroke-width="3"/><path d="M39 28V45" fill="none"/><rect x="35" y="31" width="8" height="10" rx="1" fill="${C.mint}"/>`
      + ink("M32 32a8 8 0 0 1 5-4", "#fff", 1.8) + `<rect x="48" y="47" width="4" height="12" rx="2" transform="rotate(-45 50 53)"${flat(C.saff)}/>`,
  },
  news_hound: {
    plate: [21, 53],
    sil: bp.hex() + `<rect x="9" y="12" width="46" height="40" rx="3.5" transform="rotate(-7 32 32)"/>`,
    art: bp.hex(flat(C.navy)) + `<g transform="rotate(-7 32 32)"><rect x="9" y="12" width="46" height="40" rx="3.5" fill="${C.cream}"/><rect x="13" y="16" width="38" height="6.5" rx="1.5"${flat(C.navy)}/>`
      + `<rect x="13" y="26.5" width="20" height="15" rx="1.5" fill="${C.sky}" stroke-width="1.2"/>` + ink("M15.5 37.5L20 32.5L24 35.5L30.5 29", C.green, 2.2)
      + ink("M37 28H51M37 32.5H51M37 37H48M13 45.5H51M13 49H44", "#B9B09A", 1.5) + `</g>`,
  },
  on_my_radar: {
    plate: [21, 53],
    sil: bp.hex() + `<path d="${star4(54, 9, 7)}"/>`,
    art: bp.hex(flat(C.navy)) + `<circle cx="31" cy="32" r="20" fill="${C.deep}"/><path d="M31 32V12A20 20 0 0 1 48.3 22Z"${flat(C.mint)} opacity=".6"/>`
      + `<circle cx="31" cy="32" r="13" fill="none" stroke-width="1"/><circle cx="31" cy="32" r="6" fill="none" stroke-width="1"/><path d="M31 12V52M11 32H51" fill="none" stroke-width=".9"/>`
      + `<circle cx="40" cy="25" r="3.3" fill="${C.pink}" stroke-width="1.2"/><circle cx="22" cy="40" r="1.8"${flat(C.mint)}/><path d="${star4(54, 9, 7)}" fill="${C.mari}"/>`,
  },
  chart_reader: {
    plate: [21, 55],
    sil: bp.hex() + `<circle cx="21" cy="44" r="10.5"/><circle cx="43" cy="44" r="10.5"/>`,
    art: bp.hex(flat(C.navy)) + `<rect x="12" y="11" width="40" height="27" rx="4" fill="${C.cream}"/>` + ink("M16.5 31L24 23L30 28L40 17L47.5 22", C.green, 2.6)
      + `<path d="M30 42Q32 39.5 34 42" fill="none" stroke-width="2.4"/><circle cx="21" cy="44" r="10.5" fill="${C.sky}" stroke-width="3"/><circle cx="43" cy="44" r="10.5" fill="${C.sky}" stroke-width="3"/>`
      + ink("M15 42a7 7 0 0 1 4.5-4.5M37 42a7 7 0 0 1 4.5-4.5", "#fff", 1.7),
  },
  sector_scholar: {
    plate: [21, 54],
    sil: bp.hex() + `<circle cx="32" cy="6" r="5"/><circle cx="32" cy="33" r="20.5"/>`,
    art: bp.hex(flat(C.navy)) + `<circle cx="32" cy="6" r="5" fill="${C.mari}"/><circle cx="32" cy="6" r="1.8"${flat(C.navy)}/><circle cx="32" cy="33" r="20.5" fill="${C.cream}" stroke-width="3"/>`
      + `<path d="M32 15.5V19M32 47V50.5M14.5 33H18M46 33H49.5" fill="none" stroke-width="1.3"/><g transform="rotate(32 32 33)"><path d="M32 18L37.5 33H26.5Z" fill="${C.red}" stroke-width="1.2"/><path d="M32 48L37.5 33H26.5Z" fill="${C.sky}" stroke-width="1.2"/></g><circle cx="32" cy="33" r="2.3"${flat(C.navy)}/>`,
  },
  asked_why: {
    plate: [38, 45],
    sil: bp.hex() + `<circle cx="32" cy="25" r="17"/><rect x="24.5" y="40" width="15" height="11" rx="2.5"/><rect x="28" y="50" width="8" height="5.5" rx="2.5"/>`,
    art: bp.hex(flat(C.navy)) + ink("M11 10L14.5 13.5M53 10L49.5 13.5M32 0V3", C.mari, 2.4) + `<rect x="28" y="50" width="8" height="5.5" rx="2.5" fill="${C.chai}"/><rect x="24.5" y="40" width="15" height="11" rx="2.5" fill="${C.steel}"/>`
      + `<path d="M24.5 44H39.5M24.5 47.5H39.5" fill="none" stroke-width="1.1"/><circle cx="32" cy="25" r="17" fill="${C.mari}"/>` + ink("M21.5 20Q23.5 14.5 28.5 12.5", "#fff", 2.2, ` opacity=".8"`) + txt(32, 32.5, "?", 21, C.navy),
  },
  // ------------------------------------------------------------ market calendar
  results_reader: {
    plate: [3, 47],
    sil: bp.star() + `<rect x="15" y="9" width="34" height="46" rx="4"/><circle cx="48" cy="13" r="9"/>`,
    art: bp.star(flat(C.plum)) + `<rect x="15" y="9" width="34" height="46" rx="4" fill="${C.cream}"/>` + ink("M20 16H34M20 20.5H30", "#B9B09A", 1.5)
      + `<rect x="20" y="38" width="6" height="11" rx="1" fill="${C.mint}" stroke-width="1.2"/><rect x="29" y="31" width="6" height="18" rx="1" fill="${C.indigo}" stroke-width="1.2"/><rect x="38" y="25" width="6" height="24" rx="1" fill="${C.saff}" stroke-width="1.2"/>`
      + ink("M18.5 50H45.5", C.navy, 1.4) + `<circle cx="48" cy="13" r="9" fill="${C.red}"/>` + txt(48, 17.4, "A", 12, "#fff"),
  },
  budget_buff: {
    plate: [21, 53],
    sil: bp.star() + `<rect x="12" y="18" width="40" height="36" rx="6"/>` + el(7, 5, 25, 11.5, -20) + el(7, 5, 39, 11.5, 20) + `<circle cx="32" cy="14" r="3.6"/>`,
    art: bp.star(flat(C.plum)) + `<rect x="12" y="18" width="40" height="36" rx="6" fill="${C.red}"/><path d="M12 25Q12 18 18 18H46Q52 18 52 25L32 39Z" fill="#D43D33"/>`
      + ink("M16.5 49H47.5", "#FFB3AD", 1.3, ` stroke-dasharray="2.4 2.4"`) + `<circle cx="32" cy="40" r="6" fill="${C.mari}"/><circle cx="32" cy="40" r="2.6" fill="#FFE08A" stroke-width="1"/>`
      + el(7, 5, 25, 11.5, -20, ` fill="${C.mari}"`) + el(7, 5, 39, 11.5, 20, ` fill="${C.mari}"`) + `<circle cx="32" cy="14" r="3.6" fill="${C.saff}"/>`,
  },
  rate_watcher: {
    plate: [21, 52],
    sil: bp.star() + `<path d="M7 45A25 25 0 0 1 57 45Z"/>`,
    art: bp.star(flat(C.plum)) + `<path d="M7 45A25 25 0 0 1 57 45Z" fill="${C.cream}"/>`
      + ink("M15 44A17 17 0 0 1 23.5 29.3", C.green, 5, ` stroke-linecap="butt"`) + ink("M23.5 29.3A17 17 0 0 1 40.5 29.3", C.mari, 5, ` stroke-linecap="butt"`) + ink("M40.5 29.3A17 17 0 0 1 49 44", C.red, 5, ` stroke-linecap="butt"`)
      + ink("M32 44L42.5 27.5", C.navy, 2.8) + `<circle cx="32" cy="44" r="3.6"${flat(C.navy)}/>` + txt(32, 58, "%", 11, C.cream),
  },
  diwali_holder: {
    plate: [21, 53],
    sil: bp.star() + `<path d="${FLAME}"/><path d="${BOWL}"/>`,
    art: bp.star(flat(C.plum)) + `<path d="${star4(16, 21, 3.6)}"${flat(C.cream)}/><path d="${star4(49, 22, 3)}"${flat(C.cream)}/>`
      + `<path d="${BOWL}" fill="${C.saff}"/><ellipse cx="32" cy="35" rx="22" ry="4.6" fill="#FFE08A"/><path d="M14.5 44Q32 53 49.5 44" fill="none"/>`
      + `<circle cx="22" cy="50" r="1.6"${flat(C.cream)}/><circle cx="32" cy="52.2" r="1.6"${flat(C.cream)}/><circle cx="42" cy="50" r="1.6"${flat(C.cream)}/><path d="M32 28V34" fill="none"/>`
      + `<path d="${FLAME}" fill="${C.mari}"/><path d="M32 13C36 18 37.5 22 35 25.5C33.6 27.4 30.4 27.4 29 25.5C26.5 22 28 18 32 13Z" fill="#FF6B3D" stroke-width="1.1"/>`,
  },
  muhurat: {
    plate: null,
    sil: bp.star() + `<path d="${BELL}"/><circle cx="32" cy="6.5" r="4"/><circle cx="32" cy="51" r="4.5"/><path d="${star4(54, 12, 8)}"/>`,
    art: bp.star(flat(C.plum)) + `<circle cx="32" cy="6.5" r="4" fill="${C.saff}"/><circle cx="32" cy="51" r="4.5" fill="${C.saff}"/><path d="${BELL}" fill="${C.mari}"/><path d="M18.5 37H45.5" fill="none" stroke-width="1.2"/>`
      + ink("M24 18Q26.5 14 30 12.8", "#fff", 2.2, ` opacity=".75"`) + `<path d="M49.5 27L53 16" fill="none" stroke-width="1.6"/><path d="${star4(54, 12, 8)}" fill="${C.cream}"/>`
      + `<circle cx="59" cy="24" r="1.3"${flat(C.cream)}/><circle cx="46" cy="5" r="1.2"${flat(C.cream)}/>`,
  },
  month_end_review: {
    plate: [21, 54],
    sil: bp.star() + `<rect x="15" y="15" width="34" height="36" rx="6"/><rect x="22" y="8" width="5.5" height="12" rx="2.7"/><rect x="36.5" y="8" width="5.5" height="12" rx="2.7"/>`,
    art: bp.star(flat(C.plum)) + `<rect x="15" y="15" width="34" height="36" rx="6" fill="${C.cream}"/><path d="M15 27V21Q15 15 21 15H43Q49 15 49 21V27Z" fill="${C.red}"/>`
      + `<rect x="22" y="8" width="5.5" height="12" rx="2.7" fill="#fff"/><rect x="36.5" y="8" width="5.5" height="12" rx="2.7" fill="#fff"/>` + ln("M23 38.5L29.5 45L41.5 32.5", C.green, 3.2, 6.4),
  },
  quarter_reflection: {
    // A pie with one quarter pulled out: three months of a year.
    plate: [21, 54],
    sil: bp.star() + `<circle cx="30" cy="36" r="19"/><path d="M36 30V9A21 21 0 0 1 57 30Z"/>`,
    art: bp.star(flat(C.plum)) + `<circle cx="30" cy="36" r="19" fill="#2E1A52"/><path d="M30 36H49A19 19 0 0 1 30 55Z" fill="${C.mari}"/>`
      + `<path d="M30 36V55A19 19 0 0 1 11 36Z" fill="${C.pink}"/><path d="M30 36H11A19 19 0 0 1 30 17Z" fill="${C.mint}"/>`
      + `<path d="M36 30V9A21 21 0 0 1 57 30Z" fill="${C.sky}"/>` + ink("M40.5 25.5V17.5M40.5 25.5H48.5", "#fff", 1.6, ` opacity=".8"`),
  },
  fresh_start: {
    plate: null,
    sil: bp.star() + `<rect x="13" y="10" width="34" height="45" rx="4" transform="rotate(-5 30 32)"/><rect x="46" y="14" width="8" height="40" rx="2.5" transform="rotate(18 50 34)"/>`,
    art: bp.star(flat(C.plum)) + `<g transform="rotate(-5 30 32)"><rect x="13" y="10" width="34" height="45" rx="4" fill="#D9A066"/><rect x="19" y="18" width="22" height="14" rx="2" fill="${C.cream}" stroke="${C.red}" stroke-width="1.3"/>`
      + ink("M22 23H38M22 27.5H33", C.sky, 1.4) + `</g><g transform="rotate(18 50 34)"><path d="M46 48H54L50 56Z" fill="${C.wood}"/><path d="M48.7 53.4H51.3L50 56Z"${flat(C.navy)}/>`
      + `<rect x="46" y="20" width="8" height="28" fill="${C.mari}"/><rect x="46" y="14" width="8" height="7" rx="2.5" fill="${C.pink}"/><rect x="46" y="20" width="8" height="3"${flat(C.steel)}/></g>`,
  },
  // ------------------------------------------------------------ festivals
  new_year: {
    // A tear-off calendar on 1 January.
    plate: null,
    sil: bp.star() + `<rect x="13" y="15" width="38" height="41" rx="6"/><rect x="21" y="9" width="5.5" height="12" rx="2.7"/><rect x="37.5" y="9" width="5.5" height="12" rx="2.7"/><path d="${star4(54, 9, 8)}"/><path d="${star4(9, 14, 5)}"/>`,
    art: bp.star(flat(C.plum)) + `<rect x="13" y="15" width="38" height="41" rx="6" fill="${C.cream}"/><path d="M13 29V21Q13 15 19 15H45Q51 15 51 21V29Z" fill="${C.saff}"/>`
      + txt(32, 26.4, "JAN", 7.4, "#fff") + txt(32, 51, "1", 23, C.navy)
      + `<rect x="21" y="9" width="5.5" height="12" rx="2.7" fill="#fff"/><rect x="37.5" y="9" width="5.5" height="12" rx="2.7" fill="#fff"/>`
      + `<path d="${star4(54, 9, 8)}" fill="${C.mari}"/><path d="${star4(9, 14, 5)}" fill="${C.pink}"/>`,
  },
  republic_day: {
    // India Gate under a band of saffron, white and green.
    plate: null,
    sil: bp.star() + `<path d="M8 20Q32 -2 56 20" fill="none" stroke-width="12.5"/><path d="M17 32H47V58H17Z"/><rect x="14" y="27" width="36" height="6.5" rx="2"/><rect x="24" y="21.5" width="16" height="6.5" rx="2"/>`,
    art: bp.star(flat(C.plum)) + `<path d="M8 20Q32 -2 56 20" fill="none" stroke-width="12.5"/>`
      + ink("M6.5 17Q32 -6 57.5 17", C.saff, 3.1) + ink("M8 20Q32 -2 56 20", "#fff", 3.1) + ink("M9.5 23Q32 2 54.5 23", C.green, 3.1)
      + `<path d="M17 32H47V58H17Z" fill="${C.wood}"/><path d="M26 58V45.5Q26 39 32 39Q38 39 38 45.5V58Z" fill="${C.plum}"/>`
      + ink("M21.5 37V54M42.5 37V54", C.chai, 1.3) + `<rect x="14" y="27" width="36" height="6.5" rx="2" fill="${C.cream}"/><rect x="24" y="21.5" width="16" height="6.5" rx="2" fill="${C.wood}"/>`,
  },
  eid: {
    // The crescent and star, over an Eidi envelope.
    plate: null,
    sil: bp.star() + `<path d="M37 1A19 19 0 1 0 51 31A15 15 0 0 1 37 1Z"/><rect x="29" y="38" width="30" height="20" rx="3.5" transform="rotate(-8 44 48)"/>`,
    art: bp.star(flat(C.plum)) + `<path d="M37 1A19 19 0 1 0 51 31A15 15 0 0 1 37 1Z" fill="${C.mari}"/><path d="${star5(43, 17, 7.5, 3.3)}" fill="${C.cream}" stroke-width="1.2"/>`
      + `<g transform="rotate(-8 44 48)"><rect x="29" y="38" width="30" height="20" rx="3.5" fill="${C.green}"/><path d="M29 41.5L44 50L59 41.5" fill="none" stroke-width="1.3"/><circle cx="44" cy="50" r="4" fill="${C.mari}" stroke-width="1.2"/></g>`,
  },
  holi: {
    // A pichkari and a burst of colour.
    plate: null,
    sil: bp.star() + `<g transform="rotate(-32 30 38)"><rect x="12" y="32" width="32" height="12" rx="3.5"/><rect x="44" y="35" width="8" height="6" rx="2"/><rect x="2" y="36.2" width="11" height="3.6" rx="1.8"/><rect x="-1" y="31" width="5" height="14" rx="2.5"/></g><circle cx="52" cy="13" r="8"/><circle cx="40" cy="7" r="4.5"/><circle cx="59" cy="27" r="4.5"/>`,
    art: bp.star(flat(C.plum)) + `<circle cx="52" cy="13" r="8" fill="${C.pink}"/><circle cx="40" cy="7" r="4.5" fill="${C.mint}"/><circle cx="59" cy="27" r="4.5" fill="${C.sky}"/>`
      + `<circle cx="21" cy="14" r="2.6"${flat(C.mari)}/><circle cx="29" cy="20" r="1.8"${flat(C.pink)}/><circle cx="46" cy="50" r="2.4"${flat(C.mint)}/><circle cx="51" cy="42" r="1.7"${flat(C.saff)}/>`
      + `<g transform="rotate(-32 30 38)"><rect x="2" y="36.2" width="11" height="3.6" rx="1.8" fill="${C.steel}" stroke-width="1.1"/><rect x="-1" y="31" width="5" height="14" rx="2.5" fill="${C.red}"/>`
      + `<rect x="12" y="32" width="32" height="12" rx="3.5" fill="${C.mari}"/><rect x="16" y="32" width="6" height="12" fill="${C.saff}" stroke-width="1.1"/><rect x="44" y="35" width="8" height="6" rx="2" fill="${C.saff}"/></g>`,
  },
  independence_day: {
    // A kite in three bands, the way roofs fill with them on 15 August.
    plate: null,
    sil: bp.star() + `<path d="M34 2L57 25L34 52L11 25Z" transform="rotate(14 34 28)"/>`,
    art: bp.star(flat(C.plum)) + ink("M27.5 51Q22 54 25 58T19 64", C.cream, 1.7)
      + `<g transform="rotate(14 34 28)"><path d="M34 2L49 17H19Z" fill="${C.saff}"/><path d="M19 17H49L57 25L50.2 33H17.8L11 25Z" fill="#fff"/><path d="M17.8 33H50.2L34 52Z" fill="${C.green}"/>`
      + `<path d="M34 2V52" fill="none" stroke-width="1.1"/><path d="M11 25Q34 15 57 25" fill="none" stroke-width="1.1"/></g>`
      + `<path d="M22 54.5L27 57.5L23 60Z" fill="${C.mari}" stroke-width="1"/><path d="M27.5 59L22 62L26.5 64.5Z" fill="${C.pink}" stroke-width="1"/>`,
  },
  ganesh_chaturthi: {
    // A modak on a leaf, with a marigold.
    plate: null,
    sil: bp.star() + `<ellipse cx="32" cy="52" rx="27" ry="6.5"/><path d="M32 3C34 13 49 20 49 35C49 46 42 52 32 52C22 52 15 46 15 35C15 20 30 13 32 3Z"/><circle cx="52" cy="44" r="7"/>`,
    art: bp.star(flat(C.plum)) + `<ellipse cx="32" cy="52" rx="27" ry="6.5" fill="${C.green}"/>` + ink("M8 52H56", "#5ED3A0", 1.2)
      + `<path d="M32 3C34 13 49 20 49 35C49 46 42 52 32 52C22 52 15 46 15 35C15 20 30 13 32 3Z" fill="${C.cream}"/>`
      + ink("M32 6C31 20 25 34 23 49M32 6C33 20 39 34 41 49M32 8V51M31.5 9C27 20 19.5 30 18 41M32.5 9C37 20 44.5 30 46 41", "#E2C58F", 1.4)
      + `<circle cx="52" cy="44" r="7" fill="${C.saff}"/><circle cx="52" cy="44" r="3.4" fill="${C.mari}" stroke-width="1.1"/>`,
  },
  dussehra: {
    // A bow and an arrow let fly.
    plate: null,
    sil: bp.star() + `<g transform="rotate(-38 32 33)"><path d="M20 6Q54 33 20 60" fill="none" stroke-width="7.4"/><path d="M50 25.5L64 33L50 40.5Z"/><path d="M3 27L11 33L3 39Z"/></g>`,
    art: bp.star(flat(C.plum)) + `<g transform="rotate(-38 32 33)">` + ink("M20 6V60", C.cream, 1.5) + ln("M20 6Q54 33 20 60", C.saff, 4.2, 7.4)
      + ln("M7 33H52", C.cream, 2.6, 5.4) + `<path d="M50 25.5L64 33L50 40.5Z" fill="${C.red}"/><path d="M3 27L11 33L3 39Z" fill="${C.mint}"/>`
      + ink("M33.5 19L35.5 22.5M33.5 47L35.5 43.5", C.mari, 2.4) + `</g>`,
  },
  dhanteras: {
    // Coins counted under a marigold toran.
    plate: null,
    sil: bp.star() + `<path d="M5 12Q32 30 59 12" fill="none" stroke-width="9"/><rect x="16" y="33" width="30" height="25" rx="6"/><ellipse cx="31" cy="34" rx="15" ry="6"/><circle cx="51" cy="50" r="8.5"/>`,
    art: bp.star(flat(C.plum))
      + `<path d="M20 21L23.5 30L27 22.5Z" fill="${C.green}" stroke-width="1"/><path d="M28.5 23L32 32L35.5 23Z" fill="${C.green}" stroke-width="1"/><path d="M37 22.5L40.5 30L44 21Z" fill="${C.green}" stroke-width="1"/>`
      + [[7, 13.3, 0], [13.5, 16.8, 1], [20.5, 19.4, 0], [28, 20.8, 1], [36, 20.8, 0], [43.5, 19.4, 1], [50.5, 16.8, 0], [57, 13.3, 1]].map(([x, y, k]) => `<circle cx="${x}" cy="${y}" r="3.9" fill="${k ? C.mari : C.saff}" stroke-width="1.1"/>`).join("")
      + `<rect x="16" y="33" width="30" height="25" rx="6" fill="${C.mari}"/>` + ink("M16.5 42.5Q31 48 45.5 42.5M16.5 50Q31 55.5 45.5 50", "#B8860B", 1.3)
      + `<ellipse cx="31" cy="34" rx="15" ry="6" fill="#FFE08A"/>` + ink("M26 34H36", "#B8860B", 1.5)
      + `<circle cx="51" cy="50" r="8.5" fill="${C.mari}"/><circle cx="51" cy="50" r="5" fill="#FFE08A" stroke-width="1.1"/>`,
  },
  christmas: {
    // A tree with a star on top.
    plate: null,
    sil: bp.star() + `<path d="M32 7L42 21H38L47 34H42L52 49H12L22 34H17L26 21H22Z"/><rect x="27.5" y="48" width="9" height="10" rx="2"/><path d="${star5(32, 7, 8, 3.6)}"/>`,
    art: bp.star(flat(C.plum)) + `<rect x="27.5" y="48" width="9" height="10" rx="2" fill="${C.chai}"/><path d="M32 7L42 21H38L47 34H42L52 49H12L22 34H17L26 21H22Z" fill="${C.green}"/>`
      + ink("M24.5 26Q32 30 40 25.5M19.5 40Q32 46 45 39.5", C.cream, 1.5)
      + `<circle cx="30" cy="20" r="2.3" fill="${C.red}" stroke-width="1"/><circle cx="36" cy="33" r="2.5" fill="${C.mari}" stroke-width="1"/><circle cx="25" cy="34.5" r="2.2" fill="${C.sky}" stroke-width="1"/><circle cx="40" cy="45" r="2.5" fill="${C.red}" stroke-width="1"/><circle cx="23" cy="45.5" r="2.3" fill="${C.pink}" stroke-width="1"/>`
      + `<path d="${star5(32, 7, 8, 3.6)}" fill="${C.mari}"/>`,
  },
  // ------------------------------------------------------------ calendar pins that follow the user
  ipo_watcher: {
    // An entry ticket: a company's first week on the exchange.
    plate: [3, 47],
    sil: bp.star() + `<rect x="4" y="20" width="56" height="27" rx="5" transform="rotate(-9 32 33)"/><path d="${star4(52, 9, 7.5)}"/>`,
    art: bp.star(flat(C.plum)) + `<g transform="rotate(-9 32 33)"><rect x="4" y="20" width="56" height="27" rx="5" fill="${C.cream}"/><path d="M45 20H55Q60 20 60 25V42Q60 47 55 47H45Z" fill="${C.saff}"/>`
      + ink("M45 22.5V44.5", C.navy, 1.3, ` stroke-dasharray="2.2 2.2"`) + txt(25, 39, "IPO", 14.5, C.navy) + `<path d="${star5(52.5, 33.5, 5, 2.2)}" fill="#fff" stroke-width="1"/></g>`
      + `<path d="${star4(52, 9, 7.5)}" fill="${C.mari}"/>`,
  },
  market_birthday: {
    // A cupcake whose candles are a green and a red candlestick.
    plate: [3, 46],
    sil: bp.star() + `<path d="M13 41Q13 31 23 30.5Q25 24 32 24Q39 24 41 30.5Q51 31 51 41Z"/><path d="M17 41H47L43 58H21Z"/><rect x="22.5" y="11" width="6" height="16" rx="1.5"/><rect x="35.5" y="15" width="6" height="12" rx="1.5"/>`
      + `<path d="M25.5 1C28 4 28.5 6.5 25.5 9C22.5 6.5 23 4 25.5 1Z"/><path d="M38.5 5C41 8 41.5 10.5 38.5 13C35.5 10.5 36 8 38.5 5Z"/>`,
    art: bp.star(flat(C.plum)) + `<path d="M25.5 8V30M38.5 12V30" fill="none" stroke-width="1.3"/><rect x="22.5" y="11" width="6" height="16" rx="1.5" fill="${C.green}"/><rect x="35.5" y="15" width="6" height="12" rx="1.5" fill="${C.red}"/>`
      + `<path d="M25.5 1C28 4 28.5 6.5 25.5 9C22.5 6.5 23 4 25.5 1Z" fill="${C.mari}" stroke-width="1.1"/><path d="M38.5 5C41 8 41.5 10.5 38.5 13C35.5 10.5 36 8 38.5 5Z" fill="${C.mari}" stroke-width="1.1"/>`
      + `<path d="M17 41H47L43 58H21Z" fill="${C.wood}"/>` + ink("M24 41L25.5 58M32 41V58M40 41L38.5 58", C.chai, 1.2)
      + `<path d="M13 41Q13 31 23 30.5Q25 24 32 24Q39 24 41 30.5Q51 31 51 41Z" fill="${C.pink}"/>`
      + `<circle cx="22" cy="36" r="1.3"${flat("#fff")}/><circle cx="30" cy="31" r="1.3"${flat(C.mari)}/><circle cx="38" cy="35.5" r="1.3"${flat("#fff")}/><circle cx="44" cy="37" r="1.3"${flat(C.mari)}/><circle cx="29" cy="37.5" r="1.3"${flat(C.sky)}/>`,
  },
};

// ---- limited editions: built from parts --------------------------------------
// Colour of the star by the kind of market event.
const EVENT_COLOUR = {
  rbi_policy: "#0E7C86", budget: "#C2362F", results_season: "#2F5BEA", diwali: C.plum,
  month_end: "#3B4763", quarter_end: "#3B4763", fy_start: "#0E9F7A", other: "#D9488B",
};
// A festival (a market event of kind "other" with a tag) has its own colour.
const FESTIVAL_COLOUR = {
  new_year: "#3D4FD6", republic_day: "#D2691E", independence_day: "#D2691E", holi: "#D9488B", eid: "#0E8F6A",
  ganesh_chaturthi: "#C2571A", dussehra: "#B8410F", dhanteras: "#8A6110", christmas: "#B3261E",
};
// The centre drawing, by what the pin asks the user to do.
const MOTIF = {
  book: `<path d="M13 22Q23 18 32 23V42Q23 38 13 41Z" fill="${C.cream}"/><path d="M51 22Q41 18 32 23V42Q41 38 51 41Z" fill="${C.cream}"/>` + ink("M18 27Q23 25 28 27.5M18 32Q23 30 28 32.5M36 27.5Q41 25 46 27M36 32.5Q41 30 46 32", "#C9BFA5", 1.2),
  magnifier: `<rect x="40" y="33" width="6" height="14" rx="3" transform="rotate(-45 43 40)" fill="${C.saff}"/><circle cx="29" cy="27" r="11" fill="${C.sky}" stroke-width="3"/>` + ink("M22.5 24a7 7 0 0 1 4.5-4.5", "#fff", 1.8),
  anchor: `<circle cx="32" cy="15" r="3.6" fill="${C.plum}" stroke-width="2.6"/>` + ln("M32 19V42M25 25H39M19 33Q20 43 32 43Q44 43 45 33", C.cream, 3, 5.8),
  ticks: `<rect x="16" y="15" width="32" height="28" rx="5" fill="${C.cream}"/><path d="M16 24V20Q16 15 21 15H43Q48 15 48 20V24Z" fill="${C.red}"/>` + ln("M23.5 33L29.5 39L40.5 28", C.green, 2.8, 5.6),
  sheet: `<rect x="18" y="11" width="28" height="33" rx="3.5" fill="${C.cream}"/><rect x="22.5" y="30" width="5" height="9" rx="1" fill="${C.mint}" stroke-width="1.1"/><rect x="29.5" y="24" width="5" height="15" rx="1" fill="${C.indigo}" stroke-width="1.1"/><rect x="36.5" y="18" width="5" height="21" rx="1" fill="${C.saff}" stroke-width="1.1"/>`,
  bubble: `<path d="M24 38L20 46L31 39Z" fill="${C.pink}"/><rect x="14" y="13" width="36" height="27" rx="11" fill="${C.pink}"/>` + txt(32, 33.5, "?", 20, "#fff"),
  rewind: ln("M43.3 16.7A16 16 0 1 0 48 28", C.mari, 2.8, 5.2) + `<path d="M43.5 29.5H52.5L48 22Z" fill="${C.mari}"/><circle cx="32" cy="28" r="11" fill="${C.cream}"/>` + ink("M32 28V21.5M32 28L27.5 30.5", C.navy, 2.2),
  news: `<rect x="15" y="12" width="34" height="31" rx="3" fill="${C.cream}"/><rect x="18.5" y="15.5" width="27" height="5.5" rx="1.2"${flat(C.navy)}/><rect x="18.5" y="24.5" width="13" height="11" rx="1.2" fill="${C.sky}" stroke-width="1.1"/>` + ink("M35 26H45.5M35 30H45.5M35 34H42M18.5 39.5H45.5", "#B9B09A", 1.4),
};
const NEED_ORDER = [["held_through", "anchor"], ["report_views", "sheet"], ["review_views", "sheet"], ["replays", "rewind"], ["questions", "bubble"], ["news_reads", "news"], ["stock_views", "magnifier"], ["learn_actions", "book"], ["visit_days", "ticks"]];
export function motifFor(need) {
  for (const [k, m] of NEED_ORDER) if (need && Number(need[k]) > 0) return m;
  return "ticks";
}
const RIBBON = "M4 44H60L55.5 50.5L60 57H4L8.5 50.5Z";

function frame(sil, art, tier, { size, plate, plateAt, label }) {
  const t = M[tier] ? tier : "gold";
  const m = `url(#achm-${t})`, dk = M[t][2];
  const tab = plate != null && plate !== "" && plateAt ? `<rect x="${plateAt[0]}" y="${plateAt[1]}" width="22" height="12.5" rx="5"/>` : "";
  const g = `stroke-linejoin="round" stroke-linecap="round"`;
  return `<svg class="ach-pin-svg" viewBox="-2 -2 68 72" width="${size}" height="${Math.round((size * 72) / 68)}" ${label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`} focusable="false">`
    + `<g transform="translate(0,3.2)" fill="${dk}" stroke="${dk}" stroke-width="3.4" ${g}>${sil}${tab}</g>`
    + `<g fill="${m}" stroke="${m}" stroke-width="3.4" ${g}>${sil}${tab}</g>`
    + `<g stroke="${m}" stroke-width="1.7" ${g}>${art}</g>`
    + (tab ? `<rect x="${plateAt[0]}" y="${plateAt[1]}" width="22" height="12.5" rx="5" fill="${C.navy}"/>${txt(plateAt[0] + 11, plateAt[1] + 9.6, plate, String(plate).length > 3 ? 7.6 : 9.2, C.cream)}` : "")
    + `</svg>`;
}

/** True when this family has its own drawing. */
export const hasPin = (family) => Object.prototype.hasOwnProperty.call(PIN, family);
export const pinFamilies = () => Object.keys(PIN);

/**
 * One pin. tier: bronze | silver | gold | platinum. plate: the text for the
 * number tab ("30", "5%"), or null for none. category picks the backplate for
 * a family that has no drawing yet (a plain plate with a sparkle).
 */
export function pinSvg(family, tier = "gold", { size = 60, plate = null, category = "milestone", label = "" } = {}) {
  const p = PIN[family];
  if (p) return frame(p.sil, p.art, tier, { size, plate, plateAt: p.plate, label });
  const [shape, colour] = GROUP[category] || GROUP.milestone;
  return frame(bp[shape](), bp[shape](flat(colour)) + `<path d="${star4(32, 32, 13)}" fill="${C.mari}"/>`, tier, { size, plate, plateAt: [21, 53], label });
}

/**
 * A limited-edition pin for an AI-drafted seasonal achievement.
 * kind: the market event's kind (tag: which festival, if it is one); need: what the pin asks for (the rule's
 * `need`); stamp: the short date printed on the ribbon ("4 Dec 26").
 */
export function eventPinSvg({ kind = "other", tag = null, need = null, stamp = "" } = {}, tier = "bronze", { size = 60, label = "" } = {}) {
  const colour = FESTIVAL_COLOUR[tag] || EVENT_COLOUR[kind] || EVENT_COLOUR.other;
  const s = String(stamp || "").slice(0, 10);
  const sil = bp.star() + (s ? `<path d="${RIBBON}"/>` : "");
  const art = bp.star(flat(colour)) + (kind === "diwali" ? `<path d="${star4(14, 22, 3.2)}"${flat(C.mari)}/><path d="${star4(50, 22, 3.2)}"${flat(C.mari)}/>` : "")
    + MOTIF[motifFor(need)] + (s ? `<path d="${RIBBON}" fill="${C.cream}"/>${txt(32, 53.6, s, s.length > 8 ? 6.6 : 7.6, C.navy)}` : "");
  return frame(sil, art, tier, { size, plate: null, plateAt: null, label });
}

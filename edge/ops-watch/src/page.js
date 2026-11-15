// The small page behind a signed link in a mail: shows one waiting issue and
// lets the owner say "go ahead" or "not now" from a phone.
//
// Opening the link (GET) only shows. Mail scanners and link previews open
// every link in a message, so nothing may ever happen on a GET: the answer is
// a button, sent as a POST that carries the same signature.

import { checkLink } from "./brief.js";
import { answer } from "./gaterun.js";
import { istClock } from "./gate.js";
import { istDay } from "./rules.js";
import { ASK_ID, askPage } from "./ask.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const AREA = { signup: "Sign-up and login", core: "Site, API or database", trading: "Trading", saathi: "Saathi", other: "Other" };

function html(status, body) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>StockSaathi ops</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#14171a}main{max-width:560px;margin:0 auto;padding:24px 16px}h1{font-size:18px;margin:0 0 4px}
.card{background:#fff;border:1px solid #dfe3e8;border-radius:10px;padding:16px;margin:16px 0}.t{font-weight:600;overflow-wrap:anywhere}.m{color:#59636e;font-size:14px;margin-top:8px}
form{display:inline}button{font:inherit;font-weight:600;padding:12px 18px;border-radius:8px;border:1px solid #14171a;background:#14171a;color:#fff;margin:6px 8px 0 0}button.q{background:#fff;color:#14171a}
@media(prefers-color-scheme:dark){body{background:#101214;color:#e8eaed}.card{background:#191c1f;border-color:#2c3136}.m{color:#9aa4ae}button{background:#e8eaed;color:#101214;border-color:#e8eaed}button.q{background:transparent;color:#e8eaed}}</style></head>
<body><main><h1>StockSaathi ops</h1>${body}</main></body></html>`,
    { status, headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
      "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    } },
  );
}

export async function page(req, env, deps) {
  const url = new URL(req.url);
  let p = url.searchParams;
  if (req.method === "POST") {
    try { p = new URLSearchParams((await req.text()).slice(0, 6000)); } catch { return new Response(null, { status: 404 }); }
  } else if (req.method !== "GET") return new Response(null, { status: 404 });
  const i = p.get("i") || "", e = p.get("e") || "", k = p.get("k") || "";
  const now = deps.now();
  if (!(await checkLink(env, i, e, k, now))) {
    return html(404, `<div class="card"><div class="t">This link no longer works.</div><div class="m">Links in the daily brief run out after 48 hours. The next brief has fresh ones.</div></div>`);
  }
  // The Ask box has a fixed name instead of an issue's.
  if (i === ASK_ID) return askPage(req, env, deps, p, html, esc);
  const g = await env.DB.prepare(
    `SELECT g.fp, g.area, g.state, g.reason, g.opened, s.issue_id id, s.title, s.last_seen, COALESCE(d.hits, 0) hits, COALESCE(d.people, 0) people
       FROM gate g JOIN sig s ON s.fp = g.fp LEFT JOIN sig_day d ON d.fp = g.fp AND d.day = ?2 WHERE g.fp = ?1`,
  ).bind(i, istDay(now)).first();
  if (!g) return html(404, `<div class="card"><div class="t">That issue is not on the list any more.</div></div>`);

  const head = `<div class="card"><div class="t">${g.id ? `#${esc(g.id)} ` : ""}${esc(String(g.title || "").slice(0, 200))}</div>
<div class="m">${esc(AREA[g.area] || g.area)}. Today: ${esc(g.hits)} time(s), ${esc(g.people)} people. First seen ${esc(istClock(g.opened))}, last ${esc(istClock(g.last_seen))}.</div>
<div class="m">${esc(g.reason || "")}</div></div>`;

  if (req.method === "POST") {
    const action = p.get("a") === "later" ? "later" : "approve";
    const r = await answer(env, deps, { fp: i, action });
    const said = !r.ok ? (r.why === "already_closed" ? "This one is already closed. Nothing to do." : "That did not work. Try the next brief.")
      : action === "approve" ? "Done. The agent is started for it within a minute or two." : "Left alone. It comes back in a brief after 7 days if it is still there.";
    return html(200, `${head}<div class="card"><div class="t">${esc(said)}</div></div>`);
  }
  if (g.state === "closed") return html(200, `${head}<div class="card"><div class="t">This one is already closed.</div></div>`);
  if (g.state === "woken") return html(200, `${head}<div class="card"><div class="t">The agent has already been started for this.</div></div>`);
  const hidden = `<input type="hidden" name="i" value="${esc(i)}"><input type="hidden" name="e" value="${esc(e)}"><input type="hidden" name="k" value="${esc(k)}">`;
  return html(200, `${head}<div class="card"><div class="m">It is small, so it is waiting to save your Claude limit.</div>
<form method="post" action="/p">${hidden}<input type="hidden" name="a" value="approve"><button>Fix it now</button></form>
<form method="post" action="/p">${hidden}<input type="hidden" name="a" value="later"><button class="q">Not now</button></form></div>`);
}

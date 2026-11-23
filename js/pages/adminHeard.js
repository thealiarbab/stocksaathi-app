// =============================================================================
// ADMIN · HEARD FROM — the two switches for the "How did you hear about
// StockSaathi?" card (heard_settings, 2026-11-22b), and the answers so far.
//
//   Card (popup_mode)        off | admin_only | live. Until live, everyone
//                            but admin accounts keeps the old dropdown.
//   One-time ask (backfill)  off | admin_only | live. Any onboarded account
//                            with no answer yet (no age limit since 23 Nov):
//                            asked once on their next /portfolio visit.
//
// Data: /api/ai?op=admin-heard → admin_heard_overview(); buttons go to
// op=admin-heard-set → admin_heard_set(). Preview the card on any page with
// ?heard_debug=1 (or ?heard_debug=backfill) while signed in as an admin.
// =============================================================================

import { escapeHtml } from "./adminCharts.js";

const e = escapeHtml;
const MODES = [["off", "Off"], ["admin_only", "Admins only"], ["live", "Everyone"]];
const st = { data: null, busy: false };

export function renderHeardTab(host, { adminGet, adminPost }) {
  host.innerHTML = `<div class="hd-root"><div class="muted text-sm">Loading…</div></div>`;
  const root = host.querySelector(".hd-root");
  const load = async () => {
    try { st.data = await adminGet("/api/ai?op=admin-heard"); }
    catch (err) { root.innerHTML = `<div style="color:var(--negative)">${e(err.message || err)}</div>`; return; }
    paint(root);
  };
  root.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-k]");
    if (!b || st.busy || b.disabled) return;
    const key = b.dataset.k, val = b.dataset.v;
    if (val === "live" && !confirm(key === "popup_mode"
      ? "Show the new card to EVERY account and remove the old dropdown?"
      : "Ask every account with no answer, once, on their next portfolio visit?")) return;
    st.busy = true;
    try { st.data = await adminPost("/api/ai?op=admin-heard-set", { [key]: val }); }
    catch (err) { alert(String(err.message || err)); }
    st.busy = false;
    paint(root);
  });
  load();
}

function seg(key, cur) {
  return `<div class="flex gap-2 wrap">${MODES.map(([v, l]) => `
    <button type="button" class="btn btn-sm ${cur === v ? "btn-primary" : "btn-outline"}" data-k="${key}" data-v="${v}" ${cur === v ? "disabled" : ""}>${l}</button>`).join("")}
  </div>`;
}

function paint(root) {
  const d = st.data || {};
  const s = d.settings || {};
  const ans = Object.entries(d.answers_14d || {}).sort((a, b) => b[1] - a[1]);
  const total = ans.reduce((n, [, c]) => n + c, 0) || 1;
  root.innerHTML = `
    <div class="card" style="padding:var(--sp-5);display:grid;gap:var(--sp-5);max-width:760px">
      <div>
        <h3 style="margin:0 0 4px">"How did you hear" card</h3>
        <p class="muted text-sm" style="margin:0 0 10px">Replaces the dropdown on the onboarding Profile step. Admins only = accounts where is_admin().</p>
        ${seg("popup_mode", s.popup_mode)}
      </div>
      <div>
        <h3 style="margin:0 0 4px">One-time ask for recent accounts</h3>
        <p class="muted text-sm" style="margin:0 0 10px">Any account with no answer, however old: asked once on the next /portfolio visit, then never again.
          Eligible now: <strong>${e(d.backfill_eligible ?? "–")}</strong> · already asked: <strong>${e(d.backfill_shown ?? "–")}</strong></p>
        ${seg("backfill_mode", s.backfill_mode)}
      </div>
      <div>
        <h3 style="margin:0 0 4px">Preview</h3>
        <p class="muted text-sm" style="margin:0 0 10px">Opens the card on the site as you'd see it (your admin account must be signed in on this browser). Dry run is on by default, so nothing is saved.</p>
        <div class="flex gap-2 wrap">
          <a class="btn btn-sm btn-primary" href="/portfolio?heard_debug=1" target="_blank" rel="noopener">Preview onboarding card</a>
          <a class="btn btn-sm btn-outline" href="/portfolio?heard_debug=backfill" target="_blank" rel="noopener">Preview one-time ask</a>
          <a class="btn btn-sm btn-ghost" href="/portfolio?whatsnew=preview" target="_blank" rel="noopener">Compare: What's new card</a>
        </div>
      </div>
      <div>
        <h3 style="margin:0 0 8px">Answers, accounts onboarded in the last 14 days</h3>
        <div style="display:grid;gap:4px">${ans.map(([k, c]) => `
          <div class="flex gap-2 text-sm" style="align-items:center">
            <span style="width:120px">${e(k)}</span>
            <span style="flex:1;height:8px;border-radius:4px;background:var(--bg-soft);overflow:hidden"><span style="display:block;height:100%;width:${(c / total * 100).toFixed(1)}%;background:${k === "none" ? "var(--border-strong)" : "var(--brand)"}"></span></span>
            <span style="width:48px;text-align:right">${e(c)}</span>
          </div>`).join("")}</div>
      </div>
      <div class="dim text-xs">Last changed ${e(s.updated_at ? new Date(s.updated_at).toLocaleString("en-IN") : "–")}</div>
    </div>`;
}

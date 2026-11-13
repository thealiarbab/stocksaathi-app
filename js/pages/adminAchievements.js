// =============================================================================
// ADMIN · ACHIEVEMENTS — the approval queue for AI-drafted seasonal
// achievements, the market calendar they hang on, earned-by counts and the
// rollout switch.
//
// Data: /api/ai?op=admin-achievements → admin_ach_overview(). Buttons go to
// op=admin-achievements-set → admin_ach_set(). "Draft now" calls op=ach-draft
// (one model call through callLlm, recorded in llm_usage). "Count for
// everyone" runs admin_ach_dry_run(): what the first pass would award to
// every user, written nowhere. See AGENTS.md, "Achievements".
// =============================================================================

import { escapeHtml } from "./adminCharts.js";

const e = escapeHtml;
const st = { data: null, dry: null, busy: false, show: "drafts" };
const KINDS = ["results_season", "budget", "rbi_policy", "diwali", "month_end", "quarter_end", "fy_start", "other"];
const TIER = ["", "Bronze", "Silver", "Gold", "Platinum"];

export function renderAchievementsTab(host, { adminGet, adminPost }) {
  ensureStyle();
  host.innerHTML = `<div class="ac-root"><div class="muted text-sm">Loading…</div></div>`;
  const root = host.querySelector(".ac-root");
  const ctx = { adminGet, adminPost };
  ctx.load = async () => {
    try { st.data = await adminGet("/api/ai?op=admin-achievements"); }
    catch (err) { root.innerHTML = `<div style="color:var(--negative)">${e(err.message || err)}</div>`; return; }
    paint(root, ctx);
  };
  ctx.act = async (body, okMsg) => {
    if (st.busy) return;
    st.busy = true;
    try {
      const r = await adminPost("/api/ai?op=admin-achievements-set", body);
      if (r && r.ok === false) alert(r.why || "Not done.");
      else if (okMsg) flash(root, okMsg);
    } catch (err) { alert(String(err.message || err)); }
    st.busy = false;
    await ctx.load();
  };
  ctx.load();
}

function ruleText(r) {
  if (!r) return "";
  const need = Object.entries(r.need || {}).map(([k, v]) => `${k} ≥ ${v}`).join(", ");
  const pad = r.pad && (r.pad[0] || r.pad[1]) ? `, window −${r.pad[0]}/+${r.pad[1]} days` : "";
  return `${r.event_id ? "event #" + r.event_id : r.event_kind}: ${need}${pad}`;
}

function paint(root, ctx) {
  const d = st.data || {};
  const s = d.settings || {};
  const defs = d.defs || [];
  const drafts = defs.filter((x) => x.status === "draft");
  const live = defs.filter((x) => x.status === "active");
  const retired = defs.filter((x) => x.status === "retired");
  const events = d.events || [];
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const dry = st.dry?.per || null;

  root.innerHTML = `
    <div class="ac-top">
      <div>
        <h2 style="margin:0">Achievements</h2>
        <div class="dim text-sm">${live.length} live · ${drafts.length} waiting for you · ${d.users_with_any ?? 0} users have at least one ·
          last sweep ${s.last_sweep ? e(new Date(s.last_sweep).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })) : "never"}</div>
      </div>
      <div class="ac-actions">
        <label class="ac-switch"><input type="checkbox" data-act="auto" ${s.auto_draft ? "checked" : ""}> AI drafts before each event</label>
        <button class="btn btn-sm ${s.rollout === "all" ? "btn-ghost" : "btn-primary"}" data-act="rollout">${s.rollout === "all" ? "Live for everyone · switch back to owners only" : "Owners only · roll out to everyone"}</button>
        <button class="btn btn-ghost btn-sm" data-act="dry">${st.busy ? "…" : "Count for everyone (dry run)"}</button>
        <button class="btn btn-ghost btn-sm" data-act="reload">↻</button>
      </div>
    </div>

    <div class="ac-seg">${[["drafts", `Waiting for you (${drafts.length})`], ["live", `Live (${live.length})`], ["events", `Market calendar (${events.length})`], ["retired", `Retired (${retired.length})`]]
      .map(([k, l]) => `<button data-show="${k}" class="${st.show === k ? "on" : ""}">${l}</button>`).join("")}</div>

    ${st.show === "drafts" ? `
      <div class="ac-card">
        ${drafts.length ? drafts.map((x) => `
          <div class="ac-draft">
            <div class="ac-draft-head"><span class="ac-emoji">${e(x.emoji)}</span><b>${e(x.name_en)}</b> <span class="dim">/ ${e(x.name_hi)}</span> <span class="ac-tier">${TIER[x.tier]}</span></div>
            <div class="ac-two">
              <div><div class="dim text-xs">English</div><p>${e(x.desc_en)}</p><p class="dim">${e(x.why_en)}</p></div>
              <div><div class="dim text-xs">Hinglish</div><p>${e(x.desc_hi)}</p><p class="dim">${e(x.why_hi)}</p></div>
            </div>
            <div class="dim text-xs">Rule: ${e(ruleText(x.rule))} · ${e(x.draft_note || "")}</div>
            <div class="ac-actions" style="margin-top:8px">
              <button class="btn btn-primary btn-sm" data-approve="${e(x.code)}">Approve, make it live</button>
              <button class="btn btn-ghost btn-sm" data-reject="${e(x.code)}">Reject</button>
            </div>
          </div>`).join("") : `<div class="muted text-sm">Nothing waiting. Drafts arrive before each event in the market calendar${s.auto_draft ? "" : " once 'AI drafts before each event' is switched on"}, or use "Draft now" on an event.</div>`}
      </div>` : ""}

    ${st.show === "live" || st.show === "retired" ? `
      <div class="ac-card ac-table">
        <div class="ac-tr ac-th"><span>Achievement</span><span>Rule</span><span>Earned by</span>${dry ? "<span>Would earn (everyone)</span>" : ""}<span></span></div>
        ${(st.show === "live" ? live : retired).map((x) => `
          <div class="ac-tr">
            <span>${e(x.emoji)} <b>${e(x.name_en)}</b> <span class="dim">${x.tier > 1 || x.code.endsWith("_bronze") ? TIER[x.tier] : ""}</span><br><span class="dim text-xs">${e(x.desc_en)}</span></span>
            <span class="text-xs">${x.metric === "season" ? e(ruleText(x.rule)) + ` ×${x.threshold}` : `${e(x.metric)} ≥ ${x.threshold}`}</span>
            <span class="tabular">${x.earned}${x.seeded ? ` <span class="dim">(+${x.seeded} preview)</span>` : ""}</span>
            ${dry ? `<span class="tabular">${dry[x.code] || 0}</span>` : ""}
            <span>${x.status === "active" ? `<button class="btn btn-ghost btn-sm" data-retire="${e(x.code)}">Retire</button>` : `<button class="btn btn-ghost btn-sm" data-restore="${e(x.code)}">Restore</button>`}</span>
          </div>`).join("")}
      </div>` : ""}

    ${st.show === "events" ? `
      <div class="ac-card">
        <div class="ac-table">
          <div class="ac-tr ac-th ac-ev"><span>Event</span><span>Kind</span><span>Dates</span><span>AI drafts</span><span></span></div>
          ${events.map((v) => `
            <div class="ac-tr ac-ev ${v.ends_on < today ? "ac-past" : ""}">
              <span><b>${e(v.name)}</b>${v.note ? `<br><span class="dim text-xs">${e(v.note)}</span>` : ""}</span>
              <span class="text-xs">${e(v.kind)}</span>
              <span class="tabular text-xs">${e(v.starts_on)}${v.ends_on !== v.starts_on ? " → " + e(v.ends_on) : ""}</span>
              <span class="text-xs">${v.drafted_at ? "drafted" : v.drafts_requested_at ? "asked" : "—"}</span>
              <span>${v.kind !== "month_end" && v.ends_on >= today ? `<button class="btn btn-ghost btn-sm" data-draft="${v.id}">Draft now</button>` : ""}</span>
            </div>`).join("")}
        </div>
        <form class="ac-add">
          <b>Add a date</b> <span class="dim text-xs">(next year's Budget, RBI meetings, Diwali; seasonal achievements of that kind pick it up)</span>
          <div class="ac-add-row">
            <select name="kind">${KINDS.map((k) => `<option>${k}</option>`).join("")}</select>
            <input name="name" placeholder="Name, e.g. Union Budget 2028" required maxlength="80">
            <input name="starts_on" type="date" required>
            <input name="ends_on" type="date" title="End (optional)">
            <input name="note" placeholder="Note (optional)">
            <button class="btn btn-primary btn-sm" type="submit">Add</button>
          </div>
        </form>
      </div>` : ""}`;

  wire(root, ctx);
}

function wire(root, ctx) {
  root.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => { st.show = b.dataset.show; paint(root, ctx); }));
  root.querySelector('[data-act="reload"]')?.addEventListener("click", () => ctx.load());
  root.querySelector('[data-act="auto"]')?.addEventListener("change", (ev) => ctx.act({ action: "auto_draft", on: ev.target.checked }, ev.target.checked ? "AI drafting on." : "AI drafting off."));
  root.querySelector('[data-act="rollout"]')?.addEventListener("click", () => {
    const toAll = st.data?.settings?.rollout !== "all";
    if (toAll && !confirm("Award achievements to EVERY user? The next nightly pass (after 02:30 IST) gives everyone what they already qualify for, with one summary notification each. The toasts and list in the app also need the isOwner() checks lifted (js/app.js, js/pages/reportCard.js).")) return;
    ctx.act({ action: "rollout", rollout: toAll ? "all" : "owner" }, toAll ? "Rolled out to everyone." : "Back to owners only.");
  });
  root.querySelector('[data-act="dry"]')?.addEventListener("click", async (ev) => {
    ev.target.textContent = "Counting… (up to a minute)";
    try { st.dry = await ctx.adminGet("/api/ai?op=admin-achievements-dry-run"); st.show = "live"; }
    catch (err) { alert(String(err.message || err)); }
    paint(root, ctx);
    if (st.dry) flash(root, `Dry run: ${st.dry.users_with_any} of ${st.dry.users} users would earn at least one (most for one user: ${st.dry.max_per_user}).`);
  });
  root.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", () => ctx.act({ action: "approve", code: b.dataset.approve }, "Approved. Live from the next sweep.")));
  root.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", () => {
    const note = prompt("Why not? (optional, helps the next draft)") ?? "";
    ctx.act({ action: "reject", code: b.dataset.reject, note }, "Rejected.");
  }));
  root.querySelectorAll("[data-retire]").forEach((b) => b.addEventListener("click", () => {
    if (confirm("Retire it? Nobody new earns it; people who have it keep it.")) ctx.act({ action: "retire", code: b.dataset.retire }, "Retired.");
  }));
  root.querySelectorAll("[data-restore]").forEach((b) => b.addEventListener("click", () => ctx.act({ action: "restore", code: b.dataset.restore }, "Restored.")));
  root.querySelectorAll("[data-draft]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Drafting…";
    try {
      const r = await ctx.adminPost("/api/ai?op=ach-draft", { event_id: Number(b.dataset.draft) });
      flash(root, r?.ok ? `${r.inserted} draft(s) for ${r.event}${r.rejected?.length ? `, ${r.rejected.length} refused by the checks` : ""}.` : (r?.error || "No drafts."));
      st.show = "drafts";
    } catch (err) { alert(String(err.message || err)); }
    ctx.load();
  }));
  root.querySelector(".ac-add")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const event = Object.fromEntries([...f.entries()].filter(([, v]) => v !== ""));
    ctx.act({ action: "add_event", event }, "Date added.");
  });
}

function flash(root, msg) {
  const n = document.createElement("div");
  n.className = "ac-flash";
  n.textContent = msg;
  root.prepend(n);
  setTimeout(() => n.remove(), 7000);
}

function ensureStyle() {
  if (document.getElementById("admin-ach-style")) return;
  const s = document.createElement("style");
  s.id = "admin-ach-style";
  s.textContent = `
.ac-root { display: flex; flex-direction: column; gap: 12px; }
.ac-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.ac-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ac-switch { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; }
.ac-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; flex-wrap: wrap; align-self: flex-start; }
.ac-seg button { background: none; border: 0; padding: 5px 10px; color: var(--text-dim, inherit); cursor: pointer; font: inherit; font-size: 13px; }
.ac-seg button.on { background: var(--surface-2, rgba(127,127,127,.15)); color: var(--text, inherit); font-weight: 600; }
.ac-card { border: 1px solid var(--border); border-radius: 4px; padding: 12px; background: var(--surface, transparent); }
.ac-draft { padding: 10px 0; border-bottom: 1px solid var(--divider); }
.ac-draft:last-child { border-bottom: 0; }
.ac-draft-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.ac-emoji { font-size: 20px; }
.ac-tier { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--bg-soft); }
.ac-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 6px 0; }
.ac-two p { margin: 2px 0; font-size: 13px; }
.ac-table { display: flex; flex-direction: column; }
.ac-tr { display: grid; grid-template-columns: 2.2fr 1.6fr .8fr .9fr .7fr; gap: 10px; padding: 7px 4px; border-bottom: 1px solid var(--divider); align-items: center; font-size: 13px; }
.ac-tr.ac-ev { grid-template-columns: 2fr 1fr 1.2fr .8fr .8fr; }
.ac-th { font-weight: 600; color: var(--text-dim, inherit); }
.ac-past { opacity: .55; }
.ac-add { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.ac-add-row { display: flex; gap: 6px; flex-wrap: wrap; }
.ac-add-row input, .ac-add-row select { padding: 5px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; }
.ac-flash { padding: 8px 12px; border-radius: 4px; background: var(--brand-soft); color: var(--text); font-size: 13px; }
@media (max-width: 700px) { .ac-two { grid-template-columns: 1fr; } .ac-tr, .ac-tr.ac-ev { grid-template-columns: 1fr 1fr; } }
`;
  document.head.appendChild(s);
}

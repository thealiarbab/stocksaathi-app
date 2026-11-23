// =============================================================================
// Admin: Coach quality tab. admin_coach_quality() (migration 2026-10-24b).
// Per IST day: questions, thumbs, regenerate/edit taps, which model answered,
// failures, cut-off replies and first-token time. Haiku leads from ~20 Oct.
// =============================================================================
import { mountThemedSelect } from "../components/themedSelect.js";

const st = { days: 30 };

// ---- Replay test set (coach/replay.js) --------------------------------------
// Runs in this browser as the signed-in admin: the same model, lookups and
// system prompt a student's /chat turn uses.
const rp = { brief: "student", running: false, done: 0, total: 0, results: [], ctrl: null, at: null };

function replayCardHtml() {
  return `<div class="card" id="cq-replay" style="margin-bottom:var(--sp-3);">
      <div class="card-head">
        <h3>Replay test set</h3>
        <div class="flex gap-2" style="align-items:center;flex-wrap:wrap">
          <span id="cq-rp-brief" aria-label="Which brief to test"></span>
          <button class="btn btn-primary btn-sm" data-rp-run>${rp.running ? "Stop" : "Run the set"}</button>
        </div>
      </div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-3) 0;">
        Real questions Saathi got wrong, asked again with the exact prompt a student's chat sends, before any reply checker.
        Run it before and after every change to the coach. One run makes about 20 live AI calls and takes two to four minutes.
      </p>
      <div id="cq-rp-out">${replayResultsHtml()}</div>
    </div>`;
}

function replayResultsHtml() {
  if (!rp.results.length && !rp.running) return `<div class="muted text-sm">Not run yet in this tab.</div>`;
  const pass = rp.results.filter((r) => r.ok).length;
  const head = rp.running
    ? `Running ${rp.done + 1} of ${rp.total}…`
    : `${pass} of ${rp.results.length} passed on the ${rp.brief === "lean" ? "short brief" : "long rulebook"}${rp.at ? `, ${rp.at}` : ""}`;
  const rows = rp.results.map((r) => {
    const turns = r.turns.map((t) => `
        <div style="margin:10px 0 0;padding-top:10px;border-top:1px solid var(--border)">
          <div class="text-sm"><b>You:</b> ${esc(t.say)}</div>
          <div class="text-sm" style="margin-top:4px;white-space:pre-wrap"><b>Saathi</b> <span class="muted">(${ms(t.ms)}${t.tools.length ? `, ${esc(t.tools.join(", "))}` : ", no lookups"}${t.card ? `, ${esc(t.card)} card` : ""})</span>: ${esc(t.reply.length > 700 ? t.reply.slice(0, 700) + "…" : t.reply)}</div>
          <ul class="text-sm" style="margin:6px 0 0;padding-left:18px">${t.checks.map((k) => `<li style="color:${k.ok ? "var(--text-muted)" : "var(--negative)"}">${k.ok ? "Pass" : "FAIL"}: ${esc(k.name)}${k.detail ? ` (${esc(k.detail)})` : ""}</li>`).join("")}</ul>
        </div>`).join("");
    return `<details class="admin-coach-row" data-rp-case="${esc(r.id)}" data-rp-ok="${r.ok ? 1 : 0}"${r.ok ? "" : " open"}>
        <summary><span style="color:${r.ok ? "var(--positive)" : "var(--negative)"};font-weight:700">${r.ok ? "Pass" : "FAIL"}</span> · ${esc(r.title)} <span class="muted">· ${ms(r.ms)} · ${r.lookups} lookup${r.lookups === 1 ? "" : "s"}</span></summary>
        <div class="muted text-sm" style="margin-top:6px">${esc(r.from)}</div>${turns}
      </details>`;
  }).join("");
  return `<div class="text-sm" id="cq-rp-head" style="font-weight:600;margin-bottom:8px">${esc(head)}</div>${rows}`;
}

function wireReplay(host) {
  const card = host.querySelector("#cq-replay");
  if (!card) return;
  const repaint = () => {
    const out = card.querySelector("#cq-rp-out");
    if (out) out.innerHTML = replayResultsHtml();
    const btn = card.querySelector("[data-rp-run]");
    if (btn) btn.textContent = rp.running ? "Stop" : "Run the set";
  };
  mountThemedSelect(card.querySelector("#cq-rp-brief"), {
    value: rp.brief, title: "Brief to test",
    options: [
      { value: "student", label: "Long rulebook" },
      { value: "lean", label: "Short brief" },
    ],
    onChange: (v) => { if (!rp.running) rp.brief = v; },
  });
  card.querySelector("[data-rp-run]")?.addEventListener("click", async () => {
    if (rp.running) { rp.ctrl?.abort(); return; }
    rp.running = true; rp.results = []; rp.done = 0; rp.ctrl = new AbortController(); rp.at = null;
    repaint();
    try {
      const { runReplay, REPLAY_CASES } = await import("../coach/replay.js");
      rp.total = REPLAY_CASES.length;
      repaint();
      await runReplay({
        lean: rp.brief === "lean", signal: rp.ctrl.signal,
        onCase: (res, i) => { rp.results.push(res); rp.done = i + 1; repaint(); },
      });
    } catch (e) {
      rp.results.push({ id: "error", title: "The run stopped", from: String(e?.message || e), ok: false, ms: 0, lookups: 0, turns: [] });
    }
    rp.running = false;
    rp.at = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    repaint();
  });
}

const esc = (s) => { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; };
const n = (v) => (v == null ? "–" : Number(v).toLocaleString("en-IN"));
const ms = (v) => (v == null ? "–" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : v + " ms");
const rate = (a, b) => (b ? `${Math.round((1000 * a) / b) / 10}%` : "–");

export async function renderCoachQualityTab(host, { adminGet }) {
  host.innerHTML = `<div class="muted">Loading coach quality…</div>`;
  let d;
  try { d = await adminGet(`/api/ai?op=admin-coach-quality&days=${st.days}`); }
  catch (e) { host.innerHTML = `<div style="color:var(--negative);">${esc(e.message)}</div>`; return; }
  const days = d.days || [];
  const sum = (k) => days.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const asked = sum("asked_chat_page") + sum("asked_side_panel");

  host.innerHTML = `
    ${replayCardHtml()}
    <div class="card" style="margin-bottom:var(--sp-3);">
      <div class="card-head">
        <h3>Coach quality</h3>
        <div class="flex gap-2">${[7, 30, 90].map((v) => `<button class="btn btn-ghost btn-sm ${st.days === v ? "active-btn" : ""}" data-cq="${v}">${v} days</button>`).join("")}</div>
      </div>
      <p class="muted text-sm" style="margin:0 0 var(--sp-3) 0;">
        Thumbs are rare (${n(sum("up") + sum("down"))} in this window), so the regenerate and edit rates are the better signal: a student who taps
        regenerate or rewrites the question did not get what they wanted. Tap tracking started 24 Oct; model and failure columns 23 Oct; Haiku leads since ~20 Oct.
      </p>
      <div class="sg-tiles">
        <div class="stat-tile sg-tile"><div class="l">Questions</div><div class="v tabular">${n(asked)}</div></div>
        <div class="stat-tile sg-tile"><div class="l">Regenerate rate</div><div class="v tabular">${rate(sum("regenerate"), asked)}</div><div class="sg-sub">${n(sum("regenerate"))} taps</div></div>
        <div class="stat-tile sg-tile"><div class="l">Edit rate</div><div class="v tabular">${rate(sum("edit"), asked)}</div><div class="sg-sub">${n(sum("edit"))} edits</div></div>
        <div class="stat-tile sg-tile"><div class="l">Thumbs</div><div class="v tabular">👍 ${n(sum("up"))} · 👎 ${n(sum("down"))}</div></div>
        <div class="stat-tile sg-tile"><div class="l">Answered by Gemini (fallback)</div><div class="v tabular">${rate(sum("answered_gemini"), sum("answered_gemini") + sum("answered_haiku"))}</div></div>
        <div class="stat-tile sg-tile"><div class="l">Failed attempts</div><div class="v tabular">${n(sum("failed_attempts"))}</div><div class="sg-sub">${n(sum("refusals"))} refusals · ${n(sum("cut_off"))} cut off</div></div>
      </div>
    </div>
    <div class="card" style="margin-bottom:var(--sp-3);"><div class="card-head"><h3>By day (IST)</h3></div>
      <div class="admin-table-wrap" style="max-height:520px;overflow:auto"><table class="admin-table">
        <thead><tr><th>Day</th><th style="text-align:right">Questions (/chat · pop-up)</th><th style="text-align:right">Askers</th><th style="text-align:right">Regen</th><th style="text-align:right">Edit</th>
          <th style="text-align:right">👍 / 👎</th><th style="text-align:right">Haiku / Gemini</th><th style="text-align:right">Failed</th><th style="text-align:right">First token p50 / p90</th></tr></thead>
        <tbody>${days.map((x) => `<tr><td>${esc(x.day)}</td>
          <td class="tabular" style="text-align:right">${n(x.asked_chat_page)} · ${n(x.asked_side_panel)}</td>
          <td class="tabular" style="text-align:right">${n(x.askers)}</td>
          <td class="tabular" style="text-align:right">${n(x.regenerate)}</td>
          <td class="tabular" style="text-align:right">${n(x.edit)}</td>
          <td class="tabular" style="text-align:right">${n(x.up)} / ${n(x.down)}</td>
          <td class="tabular" style="text-align:right">${n(x.answered_haiku)} / ${n(x.answered_gemini)}</td>
          <td class="tabular" style="text-align:right">${n(x.failed_attempts)}</td>
          <td class="tabular" style="text-align:right">${ms(x.p50_first_token_ms)} / ${ms(x.p90_first_token_ms)}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">No data.</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="card"><div class="card-head"><h3>Recent 👎 answers</h3></div>
      ${(d.recent_down || []).map((r) => `<details class="admin-coach-row"><summary>${esc(new Date(r.created_at).toLocaleString("en-IN"))} · ${r.pop_up ? "pop-up" : "/chat"}${r.reason ? ` · ${esc(r.reason)}` : ""}</summary><pre class="admin-coach-payload">${esc(r.reply)}</pre></details>`).join("") || '<div class="muted text-sm">None in this window.</div>'}
    </div>`;
  wireReplay(host);
  host.querySelectorAll("[data-cq]").forEach((b) => b.addEventListener("click", () => { st.days = Number(b.dataset.cq); renderCoachQualityTab(host, { adminGet }); }));
}

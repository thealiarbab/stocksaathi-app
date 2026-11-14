// =============================================================================
// ops-embed — makes the vectors the ops agent's memory is searched by.
//
// Called by the database through pg_net when memory text changes (migration
// 2026-11-15a) and by scripts/ops-memory-import.mjs. Body: { op: "sweep" }.
// Bearer = the Vault secret ops_embed_secret, or the collector's secret; the
// database decides (ops_embed_auth), nothing is set in the dashboard.
//
// The model is gte-small (384 numbers per text). It runs inside the Supabase
// edge runtime: no outside service and no cost per call.
// One call does a small, bounded piece of work, because an edge function gets
// about two seconds of CPU: it asks the database which texts have no vector
// or a stale one (ops_embed_pull), embeds about 1,200 characters' worth (one
// long text or several short ones, each cut to 800 characters) and stores
// them (ops_embed_push). If more are waiting it calls itself once more, so a
// backlog drains by itself. Safe to call at any time.
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (provided by the platform).
// =============================================================================

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// deno-lint-ignore no-explicit-any
const model = new (globalThis as any).Supabase.ai.Session("gte-small");

async function rpc(name: string, body: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function embed(text: string): Promise<number[] | null> {
  for (const t of [text, text.slice(0, 300)]) {
    try {
      const e = await model.run(t, { mean_pool: true, normalize: true });
      const a = Array.from(e as ArrayLike<number>);
      if (a.length === 384 && a.every((x) => Number.isFinite(x))) return a;
    } catch { /* try the shorter text once */ }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false });
  const auth = req.headers.get("authorization") || "";
  const secret = auth.replace(/^Bearer\s+/i, "");
  try {
    if (secret.length < 32 || !(await rpc("ops_embed_auth", { p_secret: secret }))) return json(401, { ok: false });
    // deno-lint-ignore no-explicit-any
    const b: any = await req.json().catch(() => ({}));
    // skip: lets several callers work side by side without taking the same rows.
    const skip = Math.min(Math.max(parseInt(b?.skip) || 0, 0), 40);
    const budget = Math.min(Math.max(parseInt(b?.chars) || 1200, 200), 2400);
    const pull = await rpc("ops_embed_pull", { p_n: skip + 8 });
    const rows = (pull.rows || []).slice(skip);
    let remaining = pull.remaining || 0, used = 0, failed = 0;
    const out = [];
    for (const r of rows) {
      const text = String(r.x || "").slice(0, 800);
      if (out.length && used + text.length > budget) break;
      used += text.length;
      const e = await embed(text);
      if (e) out.push({ t: r.t, id: r.id, h: r.h, e }); else failed++;
    }
    const done = out.length ? await rpc("ops_embed_push", { p: out }) : 0;
    remaining = Math.max(remaining - done, 0);
    if (done && remaining && b?.chain !== false) {
      const again = fetch(`${SB_URL}/functions/v1/ops-embed`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ op: "sweep" }),
      }).catch(() => {});
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(again);
    }
    return json(200, { ok: true, done, failed, remaining });
  } catch (e) {
    return json(500, { ok: false, error: String((e as Error)?.message || e).slice(0, 200) });
  }
});

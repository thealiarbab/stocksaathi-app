// Print the SQL that seeds public.achievement_defs from the catalogue in
// js/achievements/core.js (the one source of names, tiers, thresholds and
// copy). Re-running it is safe: copy and thresholds are updated in place,
// status (active / retired) is left as the owner set it.
//
//   node scripts/achievements-seed.mjs > /tmp/seed.sql
//
// Paste the output into a new migration when the catalogue changes.
import { buildDefs } from "../js/achievements/core.js";

const q = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const rows = buildDefs().map((d) => `  (${[
  q(d.code), q(d.family), d.tier, d.tiers, q(d.category), q(d.emoji),
  q(d.name_en), q(d.name_hi), q(d.desc_en), q(d.desc_hi), q(d.why_en), q(d.why_hi),
  q(d.metric), d.threshold, d.rule ? `${q(JSON.stringify(d.rule))}::jsonb` : "null", d.sort,
].join(", ")})`);

process.stdout.write(`insert into public.achievement_defs
  (code, family, tier, tiers, category, emoji, name_en, name_hi, desc_en, desc_hi, why_en, why_hi, metric, threshold, rule, sort)
values
${rows.join(",\n")}
on conflict (code) do update set
  family = excluded.family, tier = excluded.tier, tiers = excluded.tiers, category = excluded.category,
  emoji = excluded.emoji, name_en = excluded.name_en, name_hi = excluded.name_hi,
  desc_en = excluded.desc_en, desc_hi = excluded.desc_hi, why_en = excluded.why_en, why_hi = excluded.why_hi,
  metric = excluded.metric, threshold = excluded.threshold, rule = excluded.rule, sort = excluded.sort,
  updated_at = now();
`);

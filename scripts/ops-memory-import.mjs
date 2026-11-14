#!/usr/bin/env node
// Fills the ops agent's memory from history. Uses no AI model: it reads
//   - the fix commits on main (this repo),
//   - the session notes (--notes <folder of .md files>),
//   - the audit documents (--audits <folder>, plus docs/*FIXES*.md here),
// removes anything personal (e-mail addresses, keys, ids), and sends the
// text to the database as "raw" items (ops_raw_import). The edge function
// ops-embed then makes them searchable by meaning.
//
//   node scripts/ops-memory-import.mjs                 what would be sent (counts only)
//   node scripts/ops-memory-import.mjs --push          send, then compare both sides
//   node scripts/ops-memory-import.mjs --embed         make the vectors, until none wait
//   node scripts/ops-memory-import.mjs --stats         what the database holds
//
// Needs SUPABASE_URL and SUPABASE_ANON_KEY (.env here), and the collector's
// secret in OPS_SECRET or in the file named by OPS_SECRET_FILE.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const md5 = (s) => createHash("md5").update(s).digest("hex");

// ---- nothing personal leaves this PC (same rules as _ops_scrub in the database) ----
export function scrub(t) {
  return String(t || "")
    .replace(/((?:password|passwd|pw|secret|api[_ -]?key|bearer)["'`]?\s*[:=]\s*["'`]?|(?:password|passwd|pw|secret)\s+[`"'])([^\s"'`,;)]{6,})/gi, "$1[secret]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{4,})?/g, "[token]")
    .replace(/\b(sk|pk|rk|gsk|sbp|ghp|gho|ghs|whsec)_[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}|\bxox[abp]-[A-Za-z0-9-]{20,}|\bAIza[A-Za-z0-9_-]{30,}/g, "[token]")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "[id]")
    .replace(/\b[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b/g, "[ip]")
    .replace(/(\+91[ -]?)?\b[6-9][0-9]{9}\b/g, "[phone]")
    .replace(/(?<![A-Za-z0-9_])[A-Za-z0-9_-]{48,}(?![A-Za-z0-9_])/g, "[token]");
}

// ---- which part of the product a text is about (same words as edge/ops-watch/src/gate.js) ----
const AREAS = [
  ["core", /database|postgres|supabase|outage|whole site|site down|vercel|deploy|statement timeout|disk|memory|egress|\bcron|service worker|\bsw\b|cache_name|bundle/g],
  ["signup", /register|sign-?up|login|log in|onboarding|reset-password|\botp\b|verify|google sign|auth\b|send-email/g],
  ["trading", /match-orders|limit[_ -]orders?|live-quote|quote|portfolio|holdings|transactions|snapshot|\borders?\b|\bfill|history|fundamentals|\bnav\b|\bmf\b|mutual fund|price/g],
  ["saathi", /\/api\/chat|\bchat\b|coach|saathi|chat_threads|report[- ]card|explain|gemini|haiku|llm/g],
];
export function areaOfText(text) {
  const s = String(text || "").toLowerCase();
  let best = "other", top = 0;
  for (const [name, re] of AREAS) {
    const n = (s.match(re) || []).length;
    if (n > top) { top = n; best = name; }
  }
  return best;
}

const SERIOUS = /outage|site down|whole site|deadlock|timeout|data loss|lost|corrupt|security|leak|\borders?\b|\bfill|sign-?up|login|register|\botp\b|money|cash|price|crash|502|500/i;
const FIXISH = /\b(fix|fixes|fixed|bug|hotfix|revert|broken|crash|timeout|deadlock|outage|regress\w*|fail\w*|wrong|leak|stuck|stale|missing|502|500|404)\b/i;

// Splits long text on blank lines into pieces of at most `max` characters.
function pieces(text, max = 1800) {
  const out = [];
  let cur = "";
  for (const para of String(text).split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > max) { out.push(cur); cur = ""; }
    if (p.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

function commits() {
  let raw;
  try {
    raw = execFileSync("git", ["log", "main", "--no-merges", "--format=%x1e%H%x1f%aI%x1f%s%x1f%b%x1f", "--name-only"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { console.error("git log failed:", String(e.message).slice(0, 200)); return []; }
  const out = [];
  for (const rec of raw.split("\x1e")) {
    const [hash, at, subject, body, rest] = rec.split("\x1f");
    if (!hash || !subject) continue;
    if (!FIXISH.test(`${subject}\n${body || ""}`)) continue;
    const files = String(rest || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const text = scrub(`${subject}\n\n${(body || "").trim()}`).trim();
    let w = 1 + (text.length > 300 ? 1 : 0) + (text.length > 800 ? 1 : 0);
    if (SERIOUS.test(subject)) w += 2;
    if (files.some((f) => /^(api|handlers|supabase|edge)\//.test(f))) w += 1;
    out.push({
      kind: "commit", ref: hash.slice(0, 10), title: scrub(subject).slice(0, 300),
      body: `${text.slice(0, 3500)}${files.length ? `\n\nFiles: ${files.slice(0, 15).join(", ")}` : ""}`,
      area: areaOfText(`${subject} ${files.join(" ")}`), files: files.slice(0, 15), at, weight: w,
    });
  }
  return out;
}

// Notes that are private, hold secrets, or are about how a work session
// behaves rather than about the site.
const SKIP_NOTE = /keystore|google_quota_comms|google_sales_comms|never_cc_foxman|instagram|linkedin|kotlin|^memory\.md$|usage_checkpoint|never_save_claude_tokens|autocompact|dont_ask_just_continue|stay_in_own_lane|worktree_junction|stop_means_scoped|check_commits_before/i;

function notes(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md") && !SKIP_NOTE.test(n)).sort()) {
    const src = readFileSync(join(dir, f), "utf8");
    const fm = src.match(/^---\n([\s\S]*?)\n---\n?/);
    const head = fm ? fm[1] : "";
    const desc = (head.match(/^description:\s*"?(.*?)"?\s*$/m) || [])[1] || f.replace(/\.md$/, "").replace(/_/g, " ");
    const modified = (head.match(/modified:\s*(\S+)/) || [])[1] || null;
    const dated = (f.match(/(20\d\d)_(\d\d)(?:_(\d\d))?/) || []);
    const at = dated[1] ? `${dated[1]}-${dated[2]}-${dated[3] || "01"}T12:00:00+05:30` : modified;
    const kind = f.startsWith("feedback_") ? "rule" : "note";
    const body = scrub(fm ? src.slice(fm[0].length) : src).trim();
    const parts = body.length <= 2500 ? [body] : pieces(body);
    parts.forEach((p, i) => {
      if (p.length < 40) return;
      let w = kind === "rule" ? 2 : 4;
      if (kind === "note" && /outage|root cause|deadlock|timeout|restart|regress|broke|bug|fix/i.test(p)) w += 2;
      if (i === 0) w += 1;
      out.push({
        kind, ref: parts.length > 1 ? `${f}#${i + 1}` : f,
        title: scrub(desc).slice(0, 240) + (parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""),
        body: p, area: areaOfText(`${desc} ${p}`), files: [], at, weight: w,
      });
    });
  }
  return out;
}

function audits(dir) {
  const files = [];
  if (dir && existsSync(dir)) {
    for (const n of ["SITE_ISSUES_2026-10-13.md", "COACH_AUDIT_2026-10-13.md", "STOCKSAATHI_SIGNUP_DROP_REPORT.md"]) {
      if (existsSync(join(dir, n))) files.push(join(dir, n));
    }
  }
  const docs = join(ROOT, "docs");
  if (existsSync(docs)) for (const n of readdirSync(docs).filter((x) => /FIXES|OVERHAUL/.test(x) && x.endsWith(".md")).sort()) files.push(join(docs, n));
  const out = [];
  for (const path of files) {
    const f = basename(path);
    const at = (f.match(/(20\d\d-\d\d-\d\d)/) || [])[1];
    const sections = readFileSync(path, "utf8").split(/\n(?=#{1,3} )/);
    let n = 0;
    for (const sec of sections) {
      const heading = (sec.match(/^#{1,3} +(.+)/) || [])[1] || f;
      for (const p of pieces(scrub(sec.replace(/^#{1,3} +.+\n?/, "")).trim(), 2200)) {
        if (p.length < 80) continue;
        n++;
        out.push({
          kind: "audit", ref: `${f}#${n}`, title: `${f.replace(/\.md$/, "")}: ${scrub(heading).slice(0, 200)}`,
          body: p, area: areaOfText(`${heading} ${p}`), files: [], at: at ? `${at}T12:00:00+05:30` : null, weight: 3,
        });
      }
    }
  }
  return out;
}

// ---- talking to the database ----
function env() {
  const e = { ...process.env };
  const file = join(ROOT, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && e[m[1]] == null) e[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const secret = e.OPS_SECRET || (e.OPS_SECRET_FILE && existsSync(e.OPS_SECRET_FILE) ? readFileSync(e.OPS_SECRET_FILE, "utf8").trim() : "");
  if (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY || !secret) {
    console.error("Needs SUPABASE_URL, SUPABASE_ANON_KEY and OPS_SECRET (or OPS_SECRET_FILE).");
    process.exit(2);
  }
  return { url: e.SUPABASE_URL.replace(/\/$/, ""), anon: e.SUPABASE_ANON_KEY, secret };
}
async function rpc(c, name, p) {
  const r = await fetch(`${c.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: c.anon, Authorization: `Bearer ${c.anon}` },
    body: JSON.stringify({ p_secret: c.secret, p }),
  });
  if (!r.ok) throw new Error(`${name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function main() {
  if (flag("stats")) { console.log(JSON.stringify(await rpc(env(), "ops_raw_stats", {}), null, 1)); return; }
  if (flag("embed")) {
    // One call embeds a small piece (an edge function gets about two seconds
    // of CPU), so six callers work side by side, each skipping a different
    // number of waiting rows.
    const c = env();
    const sweep = async (skip) => {
      const r = await fetch(`${c.url}/functions/v1/ops-embed`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.secret}` },
        body: JSON.stringify({ op: "sweep", skip, chain: false }),
      });
      const j = await r.json().catch(() => ({}));
      return r.ok && j.ok ? j : { ok: false, status: r.status };
    };
    let total = 0, remaining = Infinity, bad = 0;
    const worker = async (slot) => {
      while (remaining > 0 && bad < 30) {
        const j = await sweep(remaining > 40 ? slot * 4 : 0);
        if (!j.ok) { bad++; continue; }
        total += j.done; remaining = j.remaining;
        if (!j.done && remaining > 0) { if (slot) return; bad++; }
      }
    };
    const timer = setInterval(() => console.log(`vectors made: ${total}, still waiting: ${remaining}`), 30000);
    await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
    clearInterval(timer);
    console.log(`vectors made: ${total}, still waiting: ${remaining === Infinity ? "unknown" : remaining}${bad ? `, failed calls: ${bad}` : ""}`);
    if (remaining > 0) process.exit(1);
    return;
  }

  const items = [...commits(), ...notes(opt("notes")), ...audits(opt("audits"))];
  const seen = new Set();
  const rows = items.filter((x) => { const k = `${x.kind}|${x.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const byKind = {};
  for (const x of rows) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
  const fingerprint = md5(rows.map((x) => md5(`${x.kind}|${x.ref}`)).sort().join(","));
  console.log(JSON.stringify({ items: rows.length, by_kind: byKind, characters: rows.reduce((n, x) => n + x.body.length, 0), fingerprint }));
  if (!flag("push")) { console.log("Dry run. Add --push to send."); return; }

  const c = env();
  let written = 0, scrubbedThere = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const r = await rpc(c, "ops_raw_import", rows.slice(i, i + 40));
    if (!r.ok) { console.error("refused (wrong secret?)"); process.exit(1); }
    written += r.written; scrubbedThere += r.scrubbed_here;
  }
  const s = await rpc(c, "ops_raw_stats", {});
  console.log(JSON.stringify({ sent: rows.length, written, scrubbed_by_database: scrubbedThere, database_count: s.count, database_fingerprint: s.fingerprint,
    same: s.fingerprint === fingerprint && s.count === rows.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
}

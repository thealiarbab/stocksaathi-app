// Fails when a native <select> or <datalist> appears in site code.
// Owner's rule (24 Nov 2026): every list uses the site's pick sheet
// (js/components/pickSheet.js, or mountThemedSelect for an inline trigger),
// never the browser's own menu.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SKIP = new Set(["node_modules", "assets", ".git", "api-backup", "android", "seo-reports", "docs"]);
const hits = [];
function walk(dir, depth = 0) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (depth < 6 && (depth > 0 || ["js", "partials", "pages"].includes(name) || false)) walk(p, depth + 1); continue; }
    if (!/\.(js|mjs|html)$/.test(name)) continue;
    const text = readFileSync(p, "utf8");
    text.split("\n").forEach((line, i) => {
      if (/<(select|datalist)[\s>]/i.test(line)) hits.push(`${relative(root, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
}
walk(join(root, "js"), 1);
for (const d of ["partials"]) { try { walk(join(root, d), 1); } catch {} }
for (const f of readdirSync(root)) if (f.endsWith(".html")) {
  readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => {
    if (/<(select|datalist)[\s>]/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
if (hits.length) {
  console.error("Native select/datalist found. Use openPickSheet / mountThemedSelect instead:\n" + hits.join("\n"));
  process.exit(1);
}
console.log("no native select: ok");

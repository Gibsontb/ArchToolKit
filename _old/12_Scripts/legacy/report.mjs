// scripts/report.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readInputArgOrEnv() {
  // Priority:
  // 1) ATK_INPUT env var (JSON string)
  // 2) first CLI arg: a JSON file path (recommended on Windows)
  // 3) second CLI arg: raw JSON (best effort)
  const env = (process.env.ATK_INPUT || "").trim();
  if (env) return env;

  const arg1 = (process.argv[2] || "").trim();
  if (arg1 && fs.existsSync(path.resolve(repoRoot, arg1))) {
    return fs.readFileSync(path.resolve(repoRoot, arg1), "utf8").trim();
  }

  const arg2 = (process.argv.slice(2).join(" ") || "").trim();
  return arg2 || "{}";
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    console.error("❌ report.mjs: Invalid JSON input");
    console.error("Received:", raw);
    console.error("Use: npm run report -- input.json");
    console.error("Or: $env:ATK_INPUT=(Get-Content input.json -Raw); npm run report");
    process.exit(1);
  }
}

function runDecideResolve(inputObj) {
  const scriptAbs = path.join(repoRoot, "scripts", "decide-resolve.mjs");

  // We pass via env to avoid PowerShell/npm quoting issues.
  const env = { ...process.env, ATK_INPUT: JSON.stringify(inputObj) };

  const r = spawnSync(process.execPath, [scriptAbs], { encoding: "utf8", env });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status || 1);
  }

  try {
    return JSON.parse(r.stdout);
  } catch {
    console.error("❌ report.mjs: decide-resolve output was not JSON");
    console.error(r.stdout);
    process.exit(1);
  }
}

function mdEscape(s) {
  return String(s ?? "").replace(/\r/g, "").trim();
}

function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nowIso() {
  return new Date().toISOString();
}

function makeMarkdown(res) {
  const inp = res.input || {};
  const dec = res.decision || {};
  const svc = res.services || {};

  const top = dec.top_patterns || [];
  const req = dec.required_capabilities || [];
  const pref = dec.preferred_capabilities || [];
  const resolved = svc.resolved_services || [];
  const details = svc.details || [];

  const lines = [];

  lines.push(`# ATK Decision Report`);
  lines.push(``);
  lines.push(`- Generated: **${nowIso()}**`);
  lines.push(`- Cloud target: **${mdEscape(inp.cloud)}**`);
  lines.push(``);

  lines.push(`## Inputs`);
  lines.push(`- Data classification: ${mdEscape((inp.data_classification || []).join(", ") || "—")}`);
  lines.push(`- Internet exposed: ${inp.internet_exposed ? "Yes" : "No"}`);
  lines.push(`- RTO minutes: ${Number.isFinite(inp.rto_minutes) ? inp.rto_minutes : "—"}`);
  lines.push(``);

  lines.push(`## Recommended patterns (top ${top.length})`);
  if (!top.length) {
    lines.push(`- (none)`);
  } else {
    for (const p of top) {
      lines.push(`### ${mdEscape(p.name)}  \`(${mdEscape(p.pattern_id)})\``);
      lines.push(mdEscape(p.used_for || ""));
      if (p.reasons && p.reasons.length) {
        lines.push(``);
        lines.push(`**Why it was recommended:**`);
        for (const r of p.reasons) lines.push(`- ${mdEscape(r)}`);
      }
      lines.push(``);
    }
  }

  lines.push(`## Required capabilities (${req.length})`);
  if (req.length) {
    for (const c of req) lines.push(`- \`${mdEscape(c)}\``);
  } else {
    lines.push(`- (none)`);
  }
  lines.push(``);

  lines.push(`## Preferred capabilities (${pref.length})`);
  if (pref.length) {
    for (const c of pref) lines.push(`- \`${mdEscape(c)}\``);
  } else {
    lines.push(`- (none)`);
  }
  lines.push(``);

  lines.push(`## Resolved cloud services for ${mdEscape(svc.cloud)} (${resolved.length})`);
  if (resolved.length) {
    for (const s of resolved) lines.push(`- ${mdEscape(s)}`);
  } else {
    lines.push(`- (none resolved — check master matrix mappings)`);
  }
  lines.push(``);

  lines.push(`## Capability-to-service detail`);
  if (!details.length) {
    lines.push(`- (none)`);
  } else {
    for (const d of details) {
      lines.push(`### ${mdEscape(d.capability_name)}  \`(${mdEscape(d.capability_id)})\``);
      if (d.used_for) lines.push(mdEscape(d.used_for));
      const sv = d.services || [];
      if (!sv.length) {
        lines.push(`- Services: **(none mapped)**`);
      } else {
        lines.push(`- Services:`);
        for (const s of sv) lines.push(`  - ${mdEscape(s)}`);
      }
      lines.push(``);
    }
  }

  return lines.join("\n");
}

function makeHtmlFromMarkdownish(title, mdText) {
  // Simple HTML wrapper; keep it robust and dependency-free.
  const escaped = htmlEscape(mdText);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.4; margin: 24px; max-width: 980px; }
    pre { white-space: pre-wrap; word-wrap: break-word; background: #f6f8fa; padding: 16px; border-radius: 8px; }
    h1,h2,h3 { margin-top: 1.2em; }
  </style>
</head>
<body>
  <h1>${htmlEscape(title)}</h1>
  <pre>${escaped}</pre>
</body>
</html>`;
}

function main() {
  const raw = readInputArgOrEnv();
  const inputObj = safeJsonParse(raw);

  // Defaults (so reports always work even if input.json is minimal)
  inputObj.cloud = (inputObj.cloud || "aws").toLowerCase();

  const res = runDecideResolve(inputObj);

  const distDir = path.join(repoRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const stamp = nowIso().replace(/[:.]/g, "-");
  const mdPath = path.join(distDir, `ATK-Decision-Report-${inputObj.cloud}-${stamp}.md`);
  const htmlPath = path.join(distDir, `ATK-Decision-Report-${inputObj.cloud}-${stamp}.html`);

  const md = makeMarkdown(res);
  fs.writeFileSync(mdPath, md, "utf8");

  const html = makeHtmlFromMarkdownish("ATK Decision Report", md);
  fs.writeFileSync(htmlPath, html, "utf8");

  console.log("✅ Report generated:");
  console.log(" -", mdPath);
  console.log(" -", htmlPath);
}

main();

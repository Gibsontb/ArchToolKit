// scripts/report-all.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readInput() {
  // Best: npm run report:all -- input.json
  const arg1 = (process.argv[2] || "").trim();
  if (arg1 && fs.existsSync(path.resolve(repoRoot, arg1))) {
    return JSON.parse(fs.readFileSync(path.resolve(repoRoot, arg1), "utf8"));
  }

  // Or: $env:ATK_INPUT=(Get-Content input.json -Raw); npm run report:all
  const env = (process.env.ATK_INPUT || "").trim();
  if (env) return JSON.parse(env);

  return {};
}

function runDr(inputObj) {
  const drAbs = path.join(repoRoot, "scripts", "decide-resolve.mjs");
  const env = { ...process.env, ATK_INPUT: JSON.stringify(inputObj) };
  const r = spawnSync(process.execPath, [drAbs], { encoding: "utf8", env });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status || 1);
  }
  return JSON.parse(r.stdout);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function mdEscape(s) {
  return String(s ?? "").replace(/\r/g, "").trim();
}

function makeGaps(details) {
  // Gap = capability has no mapped services for target cloud
  const gaps = [];
  for (const d of details || []) {
    const sv = d.services || [];
    if (!sv.length) {
      gaps.push({
        capability_id: d.capability_id,
        capability_name: d.capability_name,
        domain: d.domain
      });
    }
  }
  return gaps;
}

function renderOneCloudSection(res) {
  const inp = res.input || {};
  const dec = res.decision || {};
  const svc = res.services || {};

  const top = dec.top_patterns || [];
  const req = dec.required_capabilities || [];
  const pref = dec.preferred_capabilities || [];
  const resolved = svc.resolved_services || [];
  const details = svc.details || [];
  const gaps = makeGaps(details);

  const lines = [];
  lines.push(`## Cloud: ${mdEscape(inp.cloud)}`);
  lines.push(``);
  lines.push(`### Recommended patterns`);
  if (!top.length) lines.push(`- (none)`);
  for (const p of top) {
    lines.push(`- **${mdEscape(p.name)}** \`(${mdEscape(p.pattern_id)})\``);
    if (p.reasons?.length) {
      for (const r of p.reasons) lines.push(`  - Why: ${mdEscape(r)}`);
    }
  }
  lines.push(``);

  lines.push(`### Required capabilities (${req.length})`);
  if (!req.length) lines.push(`- (none)`);
  for (const c of req) lines.push(`- \`${mdEscape(c)}\``);
  lines.push(``);

  lines.push(`### Preferred capabilities (${pref.length})`);
  if (!pref.length) lines.push(`- (none)`);
  for (const c of pref) lines.push(`- \`${mdEscape(c)}\``);
  lines.push(``);

  lines.push(`### Resolved services (${resolved.length})`);
  if (!resolved.length) lines.push(`- (none resolved)`);
  for (const s of resolved) lines.push(`- ${mdEscape(s)}`);
  lines.push(``);

  lines.push(`### Gaps (capabilities with no mapped services) (${gaps.length})`);
  if (!gaps.length) {
    lines.push(`- None ✅`);
  } else {
    for (const g of gaps) {
      lines.push(`- **${mdEscape(g.capability_name)}** \`(${mdEscape(g.capability_id)})\` — Domain: ${mdEscape(g.domain)}`);
    }
  }
  lines.push(``);

  return lines.join("\n");
}

function main() {
  const baseInput = readInput();

  // Defaults
  const data_classification = baseInput.data_classification || [];
  const internet_exposed = Boolean(baseInput.internet_exposed);
  const rto_minutes = Number.isFinite(baseInput.rto_minutes) ? baseInput.rto_minutes : Number(baseInput.rto_minutes);

  const clouds = ["aws", "azure", "gcp", "oci"];

  const distDir = path.join(repoRoot, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const stamp = nowStamp();
  const outPath = path.join(distDir, `ATK-Decision-Report-ALL-${stamp}.md`);

  const lines = [];
  lines.push(`# ATK Decision Report (All Clouds)`);
  lines.push(``);
  lines.push(`- Generated: **${new Date().toISOString()}**`);
  lines.push(``);
  lines.push(`## Inputs`);
  lines.push(`- Data classification: ${mdEscape(data_classification.join(", ") || "—")}`);
  lines.push(`- Internet exposed: ${internet_exposed ? "Yes" : "No"}`);
  lines.push(`- RTO minutes: ${Number.isFinite(rto_minutes) ? rto_minutes : "—"}`);
  lines.push(``);

  // Run for each cloud and append section
  for (const cloud of clouds) {
    const inputObj = { cloud, data_classification, internet_exposed, rto_minutes };
    const res = runDr(inputObj);
    lines.push(renderOneCloudSection(res));
  }

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log("✅ Multi-cloud report generated:");
  console.log(" -", outPath);
}

main();

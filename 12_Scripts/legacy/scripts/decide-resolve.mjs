// scripts/decide-resolve.mjs
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function runNode(scriptRel, argJson) {
  const scriptAbs = path.join(repoRoot, scriptRel);
  const r = spawnSync(process.execPath, [scriptAbs, argJson], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status || 1);
  }
  return JSON.parse(r.stdout);
}

// Usage:
// npm run dr -- "{""cloud"":""aws"",""data_classification"":[""CJIS""],""internet_exposed"":true,""rto_minutes"":30}"
const raw = (process.env.ATK_INPUT || process.argv.slice(2).join(" ")).trim() || "{}";
let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  console.error("❌ Invalid JSON input");
  console.error("Received:", raw);
  console.error("Tip (PowerShell): wrap JSON in single quotes");
  process.exit(1);
}
const cloud = (input.cloud || "aws").toLowerCase();
const decideInput = {
  data_classification: input.data_classification || [],
  internet_exposed: Boolean(input.internet_exposed),
  rto_minutes: Number(input.rto_minutes)
};

// 1) Decide
const decision = runNode("scripts/decide.mjs", JSON.stringify(decideInput));

// 2) Resolve required capabilities to services for chosen cloud
const resolveInput = {
  cloud,
  capability_ids: decision.required_capabilities
};
const resolution = runNode("scripts/resolve.mjs", JSON.stringify(resolveInput));

// 3) Output combined
const combined = {
  input: { ...decideInput, cloud },
  decision: {
    required_capabilities: decision.required_capabilities,
    preferred_capabilities: decision.preferred_capabilities,
    top_patterns: decision.top_patterns
  },
  services: {
    cloud: resolution.cloud,
    resolved_services: resolution.resolved_services,
    details: resolution.details
  }
};

console.log(JSON.stringify(combined, null, 2));

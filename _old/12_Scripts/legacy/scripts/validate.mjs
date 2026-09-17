// scripts/validate.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const masterPath = path.join(repoRoot, "data", "master", "master-matrix.json");

function fail(msg) {
  console.error("❌ VALIDATION FAILED:", msg);
  process.exit(1);
}

if (!fs.existsSync(masterPath)) {
  fail(`Missing master matrix at: ${masterPath}`);
}

let master;
try {
  master = JSON.parse(fs.readFileSync(masterPath, "utf8"));
} catch (e) {
  fail(`master-matrix.json is not valid JSON: ${e.message}`);
}

if (!master || typeof master !== "object") fail("master-matrix.json must be a JSON object");
if (!master.catalog_version) fail("master.catalog_version is required");
if (!Array.isArray(master.rows)) fail("master.rows must be an array");

const providerIds = ["aws", "azure", "gcp", "oci"];

const capIdSet = new Set();
for (let i = 0; i < master.rows.length; i++) {
  const row = master.rows[i];
  const rowHint = `rows[${i}] (${row?.capability_name || "unknown"})`;

  if (!row || typeof row !== "object") fail(`${rowHint} must be an object`);
  if (!row.domain) fail(`${rowHint} missing domain`);
  if (!row.capability_name) fail(`${rowHint} missing capability_name`);
  if (!row.capability_id) fail(`${rowHint} missing capability_id`);

  if (capIdSet.has(row.capability_id)) {
    fail(`${rowHint} duplicate capability_id: ${row.capability_id}`);
  }
  capIdSet.add(row.capability_id);

  if (!row.providers || typeof row.providers !== "object") {
    fail(`${rowHint} missing providers object`);
  }

  for (const pid of providerIds) {
    const v = row.providers[pid];
    if (v === undefined) fail(`${rowHint} missing providers.${pid} (use [] if none)`);
    if (!Array.isArray(v)) fail(`${rowHint} providers.${pid} must be an array`);
    for (const s of v) {
      if (typeof s !== "string" || !s.trim()) {
        fail(`${rowHint} providers.${pid} contains a non-string/blank entry`);
      }
    }
  }
}

console.log(`✅ Validation passed (${master.rows.length} rows, version ${master.catalog_version})`);

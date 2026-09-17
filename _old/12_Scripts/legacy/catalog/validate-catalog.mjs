// scripts/catalog/validate-catalog.mjs
// Validates normalized inventories if they exist. Skips providers that aren't refreshed.

import path from "path";
import fs from "fs";
import { readJson } from "./common.mjs";

const ROOT = path.resolve(process.cwd());
const IN_DIR = path.join(ROOT, "data/imports/provider-inventory");

function mustContain(provider, needles) {
  const fp = path.join(IN_DIR, `${provider}.normalized.json`);
  if (!fs.existsSync(fp)) {
    console.warn(`[validate] ${provider}: missing normalized inventory (skip) -> ${fp}`);
    return { provider, skipped: true, reason: "missing_normalized" };
  }
  const data = readJson(fp);
  if (data && data.skipped) {
    console.warn(`[validate] ${provider}: inventory marked skipped (${data.reason || "unknown"})`);
    return { provider, skipped: true, reason: data.reason || "skipped_flag" };
  }
  const services = (data.services || []).map(s => String(s.name || "").toLowerCase());
  if (!services.length) {
    console.warn(`[validate] ${provider}: 0 services (skip checks)`);
    return { provider, skipped: true, reason: "empty" };
  }

  const miss = [];
  for (const n of needles) {
    const hit = services.some(x => x.includes(String(n).toLowerCase()));
    if (!hit) miss.push(n);
  }
  if (miss.length) throw new Error(`[validate] ${provider} missing expected: ${miss.join(", ")}`);

  console.log(`[validate] ${provider} ok (${needles.length} checks)`);
  return { provider, ok: true };
}

function main() {
  const results = [];
  results.push(mustContain("aws", ["s3", "ec2", "iam"]));
  results.push(mustContain("azure", ["microsoft.compute", "microsoft.storage", "microsoft.authorization"]));
  results.push(mustContain("gcp", ["compute", "storage", "iam"]));

  const ociFp = path.join(IN_DIR, "oci.normalized.json");
  if (fs.existsSync(ociFp)) {
    results.push(mustContain("oci", ["object", "compute", "identity"]));
  } else {
    console.warn("[validate] oci.normalized.json not present (skip)");
  }

  const ok = results.filter(r => r && r.ok).length;
  const skipped = results.filter(r => r && r.skipped).length;
  console.log(`[validate] summary: ok=${ok}, skipped=${skipped}`);
}

try { main(); } catch (err) {
  console.error(err.message || err);
  process.exit(1);
}

// scripts/catalog/refresh-all.mjs
// NO-LOGIN / BEST-EFFORT refresh runner.
// Runs each provider refresh and continues even if one fails.

import { run } from "./common.mjs";

function tryRun(label, cmd) {
  try {
    console.log(`[catalog] ${label}...`);
    run(cmd, { shell: true });
    return { label, ok: true };
  } catch (e) {
    const msg = (e && (e.stderr || e.message)) ? String(e.stderr || e.message) : String(e);
    console.warn(`[catalog] ${label} skipped (non-fatal): ${msg.trim()}`);
    return { label, ok: false, error: msg.trim() };
  }
}

function main() {
  const results = [];
  results.push(tryRun("refresh-aws", "node scripts/catalog/refresh-aws.mjs"));
  results.push(tryRun("refresh-azure", "node scripts/catalog/refresh-azure.mjs"));
  results.push(tryRun("refresh-gcp", "node scripts/catalog/refresh-gcp.mjs"));
  results.push(tryRun("refresh-oci", "node scripts/catalog/refresh-oci.mjs"));

  results.push(tryRun("validate", "node scripts/catalog/validate-catalog.mjs"));
  // Build CCSM (Cloud Canonical Service Model) index + classified inventories (no-login)
  results.push(tryRun("classify", "node scripts/catalog/classify-services.mjs"));
  results.push(tryRun("build-ccsm", "node scripts/catalog/build-ccsm.mjs"));
  results.push(tryRun("build", "node scripts/catalog/build-provider-js.mjs"));

  const ok = results.filter(r => r.ok).map(r => r.label);
  const bad = results.filter(r => !r.ok).map(r => r.label);

  console.log("");
  console.log("[catalog] done.");
  console.log(`[catalog] ok: ${ok.length ? ok.join(", ") : "(none)"}`);
  console.log(`[catalog] skipped: ${bad.length ? bad.join(", ") : "(none)"}`);

  process.exit(0);
}

main();

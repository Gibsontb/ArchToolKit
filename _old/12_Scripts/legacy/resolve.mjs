// scripts/resolve.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const masterPath = path.join(repoRoot, "data", "master", "master-matrix.json");

// Usage:
// node scripts/resolve.mjs '{"capability_ids":["security.key_management","security.audit_logging"],"cloud":"aws"}'
// cloud can be: aws | azure | gcp | oci
const input = JSON.parse(process.argv[2] || "{}");
const cloud = (input.cloud || "aws").toLowerCase();
const capabilityIds = new Set(input.capability_ids || []);

if (!["aws", "azure", "gcp", "oci"].includes(cloud)) {
  console.error("❌ Invalid cloud. Use one of: aws, azure, gcp, oci");
  process.exit(1);
}

const master = JSON.parse(fs.readFileSync(masterPath, "utf8"));

const hits = [];
const services = new Set();

for (const row of master.rows || []) {
  if (!capabilityIds.has(row.capability_id)) continue;

  const list = (row.providers?.[cloud] || []);
  for (const svc of list) services.add(svc);

  hits.push({
    capability_id: row.capability_id,
    capability_name: row.capability_name,
    domain: row.domain,
    used_for: row.used_for || "",
    services: list
  });
}

const result = {
  cloud,
  requested_capability_ids: [...capabilityIds],
  resolved_services: [...services].sort(),
  details: hits
};

console.log(JSON.stringify(result, null, 2));

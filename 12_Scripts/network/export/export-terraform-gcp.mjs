import fs from "fs";
import path from "path";
const input = JSON.parse(fs.readFileSync(path.resolve("11_DataModels/data/network/provider-design.gcp.json"), "utf8"));
const outDir = path.resolve("10_Artifacts/network/gcp");
fs.mkdirSync(outDir, { recursive: true });
let tf = "# GCP network design\n\n";
for (const env of input.environments) {
  const v = env.environment.replace(/[^a-zA-Z0-9_]/g, "_");
  tf += `resource "google_compute_network" "${v}" {\n  name = "${env.environment}-vpc"\n  auto_create_subnetworks = false\n}\n\n`;
}
fs.writeFileSync(path.join(outDir, "main.tf"), tf);
console.log("Wrote GCP Terraform");

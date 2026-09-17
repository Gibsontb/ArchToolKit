import fs from "fs";
import path from "path";
const input = JSON.parse(fs.readFileSync(path.resolve("11_DataModels/data/network/provider-design.oci.json"), "utf8"));
const outDir = path.resolve("10_Artifacts/network/oci");
fs.mkdirSync(outDir, { recursive: true });
let tf = "# OCI network design\n\n";
for (const env of input.environments) {
  const v = env.environment.replace(/[^a-zA-Z0-9_]/g, "_");
  tf += `resource "oci_core_vcn" "${v}" {\n  cidr_block = "${env.top_level_network.cidr}"\n  compartment_id = var.compartment_id\n  display_name = "${env.environment}-vcn"\n}\n\n`;
}
fs.writeFileSync(path.join(outDir, "main.tf"), tf);
console.log("Wrote OCI Terraform");

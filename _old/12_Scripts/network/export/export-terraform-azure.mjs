import fs from "fs";
import path from "path";
const input = JSON.parse(fs.readFileSync(path.resolve("11_DataModels/data/network/provider-design.azure.json"), "utf8"));
const outDir = path.resolve("10_Artifacts/network/azure");
fs.mkdirSync(outDir, { recursive: true });
let tf = "# Azure network design\n\n";
for (const env of input.environments) {
  const v = env.environment.replace(/[^a-zA-Z0-9_]/g, "_");
  tf += `resource "azurerm_virtual_network" "${v}" {\n  address_space = ["${env.top_level_network.cidr}"]\n  location = "eastus"\n  resource_group_name = "rg-network"\n}\n\n`;
}
fs.writeFileSync(path.join(outDir, "main.tf"), tf);
console.log("Wrote Azure Terraform");

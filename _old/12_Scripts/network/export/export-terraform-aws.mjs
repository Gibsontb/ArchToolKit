import fs from "fs";
import path from "path";
const input = JSON.parse(fs.readFileSync(path.resolve("11_DataModels/data/network/provider-design.aws.json"), "utf8"));
const outDir = path.resolve("10_Artifacts/network/aws");
fs.mkdirSync(outDir, { recursive: true });
let tf = "# AWS network design\n\n";
for (const env of input.environments) {
  const v = env.environment.replace(/[^a-zA-Z0-9_]/g, "_");
  tf += `resource "aws_vpc" "${v}" {\n  cidr_block = "${env.top_level_network.cidr}"\n}\n\n`;
  for (const seg of env.topology.segments) {
    for (const sub of seg.subnets || []) {
      const n = sub.name.replace(/[^a-zA-Z0-9_]/g, "_");
      tf += `resource "aws_subnet" "${n}" {\n  vpc_id = aws_vpc.${v}.id\n  cidr_block = "${sub.cidr}"\n}\n\n`;
    }
  }
}
fs.writeFileSync(path.join(outDir, "main.tf"), tf);
console.log("Wrote AWS Terraform");

import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const stack = JSON.parse(fs.readFileSync(path.join(dir, "aws-stack.output.json"), "utf8"));
const outDir = path.resolve("10_Artifacts/network/aws");
fs.mkdirSync(outDir, { recursive: true });

let tf = `# AWS Full Network Stack Terraform Starter\n\n`;

for (const env of stack.environments) {
  const vpcName = env.vpc.name.replace(/[^a-zA-Z0-9_]/g, "_");

  tf += `resource "aws_vpc" "${vpcName}" {\n`;
  tf += `  cidr_block = "${env.vpc.cidr}"\n`;
  tf += `  tags = { Name = "${env.vpc.name}" }\n`;
  tf += `}\n\n`;

  tf += `resource "aws_internet_gateway" "${vpcName}_igw" {\n`;
  tf += `  vpc_id = aws_vpc.${vpcName}.id\n`;
  tf += `  tags = { Name = "${env.internet_gateway.name}" }\n`;
  tf += `}\n\n`;

  const allSubnets = [
    ...env.subnets.public,
    ...env.subnets.app,
    ...env.subnets.db,
    ...env.subnets.management,
    ...env.subnets.shared,
    ...env.subnets.inspection
  ];

  for (const s of allSubnets) {
    const subnetName = s.name.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `resource "aws_subnet" "${subnetName}" {\n`;
    tf += `  vpc_id                  = aws_vpc.${vpcName}.id\n`;
    tf += `  cidr_block              = "${s.cidr}"\n`;
    tf += `  availability_zone       = "${stack.region}${s.az.replace("az", "")}"\n`;
    tf += `  tags = { Name = "${s.name}" }\n`;
    tf += `}\n\n`;
  }

  env.nat_gateways.forEach((nat, idx) => {
    const natName = nat.name.replace(/[^a-zA-Z0-9_]/g, "_");
    const pubSubnet = env.subnets.public[idx];
    if (pubSubnet) {
      const pubName = pubSubnet.name.replace(/[^a-zA-Z0-9_]/g, "_");
      tf += `resource "aws_eip" "${natName}_eip" {\n  domain = "vpc"\n}\n\n`;
      tf += `resource "aws_nat_gateway" "${natName}" {\n`;
      tf += `  allocation_id = aws_eip.${natName}_eip.id\n`;
      tf += `  subnet_id     = aws_subnet.${pubName}.id\n`;
      tf += `  tags = { Name = "${nat.name}" }\n`;
      tf += `}\n\n`;
    }
  });

  if (env.transit_gateway) {
    const tgwName = env.transit_gateway.name.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `resource "aws_ec2_transit_gateway" "${tgwName}" {\n`;
    tf += `  description = "${env.transit_gateway.name}"\n`;
    tf += `}\n\n`;
  }
}

fs.writeFileSync(path.join(outDir, "main.full.tf"), tf);
console.log("Wrote 10_Artifacts/network/aws/main.full.tf");

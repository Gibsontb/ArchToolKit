import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const graph = JSON.parse(fs.readFileSync(path.join(dir, "aws-network-graph.output.json"), "utf8"));
const outDir = path.resolve("10_Artifacts/network/aws");
fs.mkdirSync(outDir, { recursive: true });

let tf = `# AWS Network Graph Terraform Starter\n\n`;

for (const env of graph.environments) {
  const nodes = env.graph.nodes;
  const byType = (type) => nodes.filter(n => n.type === type);

  for (const vpc of byType("aws_vpc")) {
    const id = vpc.id.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `resource "aws_vpc" "${id}" {\n  cidr_block = "${vpc.cidr}"\n  tags = { Name = "${vpc.name}" }\n}\n\n`;
  }
  for (const igw of byType("aws_internet_gateway")) {
    const id = igw.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const edge = env.graph.edges.find(e => e.from === igw.id && e.relation === "attached_to");
    const vpcId = edge ? edge.to.replace(/[^a-zA-Z0-9_]/g, "_") : "";
    tf += `resource "aws_internet_gateway" "${id}" {\n  vpc_id = aws_vpc.${vpcId}.id\n}\n\n`;
  }
  for (const subnet of byType("aws_subnet")) {
    const id = subnet.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const edge = env.graph.edges.find(e => e.from === subnet.id && e.relation === "belongs_to");
    const vpcId = edge ? edge.to.replace(/[^a-zA-Z0-9_]/g, "_") : "";
    tf += `resource "aws_subnet" "${id}" {\n`;
    tf += `  vpc_id            = aws_vpc.${vpcId}.id\n`;
    tf += `  cidr_block        = "${subnet.cidr}"\n`;
    tf += `  availability_zone = "${subnet.availability_zone}"\n`;
    tf += `}\n\n`;
  }
  for (const nat of byType("aws_nat_gateway")) {
    const id = nat.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const subnetId = nat.subnet_id.replace(/[^a-zA-Z0-9_]/g, "_");
    const eipId = nat.eip_id.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `resource "aws_eip" "${eipId}" { domain = "vpc" }\n\n`;
    tf += `resource "aws_nat_gateway" "${id}" {\n  allocation_id = aws_eip.${eipId}.id\n  subnet_id = aws_subnet.${subnetId}.id\n}\n\n`;
  }
  for (const tgw of byType("aws_ec2_transit_gateway")) {
    const id = tgw.id.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `resource "aws_ec2_transit_gateway" "${id}" {}\n\n`;
  }
  for (const fw of byType("aws_network_firewall")) {
    const id = fw.id.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `# aws_networkfirewall_firewall "${id}" with subnet mappings\n\n`;
  }
  for (const sg of byType("aws_security_group")) {
    const id = sg.id.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `# aws_security_group "${id}" modeled from graph rules\n\n`;
  }
  for (const lb of byType("aws_lb")) {
    const id = lb.id.replace(/[^a-zA-Z0-9_]/g, "_");
    tf += `# aws_lb "${id}" (${lb.lb_type}) with subnet mappings\n\n`;
  }
}

fs.writeFileSync(path.join(outDir, "network-graph.full.tf"), tf);
console.log("Wrote 10_Artifacts/network/aws/network-graph.full.tf");

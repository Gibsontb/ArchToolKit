import fs from "node:fs";
import path from "node:path";

function die(msg) { console.error("❌ " + msg); process.exit(1); }
function toRel(p) { return path.relative(process.cwd(), p).replace(/\\/g, "/"); }
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { die(`Invalid JSON: ${toRel(p)}\n${e.message}`); }
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeFile(p, s) { ensureDir(path.dirname(p)); fs.writeFileSync(p, s, "utf8"); console.log("📝 wrote:", toRel(p)); }
function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { inPath: null, outDir: null };
  const inIdx = args.indexOf("--in"); if (inIdx !== -1 && args[inIdx + 1]) out.inPath = args[inIdx + 1];
  const outIdx = args.indexOf("--outdir"); if (outIdx !== -1 && args[outIdx + 1]) out.outDir = args[outIdx + 1];
  if (!out.inPath && args[0] && !args[0].startsWith("-")) out.inPath = args[0];
  if (!out.outDir && args[1] && !args[1].startsWith("-")) out.outDir = args[1];
  return out;
}

function main() {
  const { inPath: inArg, outDir: outArg } = parseArgs(process.argv);
  if (!inArg) die("Usage: npm run export:tf:aws -- <enriched.json> [infra/aws/<export>]");
  const repoRoot = process.cwd();
  const inPath = path.resolve(repoRoot, inArg);
  if (!fs.existsSync(inPath)) die(`Input file not found: ${toRel(inPath)}`);

  const enriched = readJson(inPath);
  const exportName = enriched?.meta?.export_name || "manual";
  const target = enriched?.inputs?.target || {};
  const region = target.region || "us-east-1";
  const prefix = target.naming_prefix || exportName;

  const vpcs = enriched?.network?.vpcs || [];
  if (!Array.isArray(vpcs) || !vpcs.length) die("Enriched report has no network.vpcs. Run dc:enrich first.");

  const outDir = outArg ? path.resolve(repoRoot, outArg) : path.resolve(repoRoot, "infra", "aws", exportName);
  ensureDir(outDir);

  console.log("✅ input:", toRel(inPath));
  console.log("✅ output dir:", toRel(outDir));

  const tfvars = {
    region,
    naming_prefix: prefix,
    max_azs: 2,
    vpcs: vpcs.map((v) => ({
      name: v.name,
      cidr: v.cidr || "",
      subnets: (v.subnets || []).map((s) => ({
        name: s.name,
        cidr: s.cidr || "",
        role: (s.role || "private").toLowerCase()
      }))
    }))
  };

  const readme = `# ATK AWS Terraform Export (${exportName})

Generated from: ${toRel(inPath)}

Creates:
- VPC, subnets (round-robin AZs), IGW
- Public RT (0.0.0.0/0 -> IGW)
- NAT per AZ **if** you have public subnets in that AZ
- Private RT per AZ (0.0.0.0/0 -> NAT) **only where NAT exists**
- Isolated RT (no default route)

Before plan/apply: fill empty CIDRs in terraform.tfvars.json.
`;

  const variablesTf = `variable "region" { type = string }
variable "naming_prefix" { type = string }
variable "max_azs" { type = number default = 2 }
variable "vpcs" {
  type = list(object({
    name = string
    cidr = string
    subnets = list(object({
      name = string
      cidr = string
      role = string
    }))
  }))
}
`;

  const mainTf = `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0.0" }
  }
}

provider "aws" { region = var.region }

data "aws_availability_zones" "available" { state = "available" }

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.max_azs)

  subnets_flat = flatten([
    for v in var.vpcs : [
      for idx, s in v.subnets : {
        vpc_name = v.name
        name     = s.name
        cidr     = s.cidr
        role     = lower(s.role)
        az       = local.azs[idx % length(local.azs)]
      }
    ]
  ])

  public_subnets   = [for s in local.subnets_flat : s if s.role == "public"]
  private_subnets  = [for s in local.subnets_flat : s if s.role == "private"]
  isolated_subnets = [for s in local.subnets_flat : s if s.role == "isolated"]

  public_subnet_by_vpc_az = {
    for key in distinct([for s in local.public_subnets : "\${s.vpc_name}::\${s.az}"]) :
    key => element([for s in local.public_subnets : s if "\${s.vpc_name}::\${s.az}" == key], 0)
  }

  private_subnets_by_vpc_az = {
    for key in distinct([for s in local.private_subnets : "\${s.vpc_name}::\${s.az}"]) :
    key => [for s in local.private_subnets : s if "\${s.vpc_name}::\${s.az}" == key]
  }
}

resource "aws_vpc" "vpc" {
  for_each = { for v in var.vpcs : v.name => v }
  cidr_block = each.value.cidr
  enable_dns_support = true
  enable_dns_hostnames = true
  tags = { Name = "\${var.naming_prefix}-\${each.key}" }
}

resource "aws_internet_gateway" "igw" {
  for_each = aws_vpc.vpc
  vpc_id = each.value.id
  tags = { Name = "\${var.naming_prefix}-\${each.key}-igw" }
}

resource "aws_subnet" "subnet" {
  for_each = { for s in local.subnets_flat : "\${s.vpc_name}::\${s.name}" => s }
  vpc_id = aws_vpc.vpc[each.value.vpc_name].id
  cidr_block = each.value.cidr
  availability_zone = each.value.az
  map_public_ip_on_launch = each.value.role == "public"
  tags = { Name="\${var.naming_prefix}-\${each.value.vpc_name}-\${each.value.name}", Role=each.value.role, AZ=each.value.az }
}

resource "aws_route_table" "public" {
  for_each = aws_vpc.vpc
  vpc_id = each.value.id
  tags = { Name = "\${var.naming_prefix}-\${each.key}-rt-public" }
}

resource "aws_route" "public_default" {
  for_each = aws_route_table.public
  route_table_id = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.igw[each.key].id
}

resource "aws_route_table_association" "public_assoc" {
  for_each = { for s in local.public_subnets : "\${s.vpc_name}::\${s.name}" => s }
  subnet_id = aws_subnet.subnet["\${each.value.vpc_name}::\${each.value.name}"].id
  route_table_id = aws_route_table.public[each.value.vpc_name].id
}

resource "aws_eip" "nat_eip" {
  for_each = local.public_subnet_by_vpc_az
  domain = "vpc"
  tags = { Name = "\${var.naming_prefix}-\${each.value.vpc_name}-\${each.value.az}-nat-eip" }
}

resource "aws_nat_gateway" "nat" {
  for_each = local.public_subnet_by_vpc_az
  allocation_id = aws_eip.nat_eip[each.key].id
  subnet_id = aws_subnet.subnet["\${each.value.vpc_name}::\${each.value.name}"].id
  tags = { Name = "\${var.naming_prefix}-\${each.value.vpc_name}-\${each.value.az}-nat" }
  depends_on = [aws_internet_gateway.igw]
}

resource "aws_route_table" "private" {
  for_each = local.private_subnets_by_vpc_az
  vpc_id = aws_vpc.vpc[split("::", each.key)[0]].id
  tags = { Name = "\${var.naming_prefix}-\${split("::", each.key)[0]}-\${split("::", each.key)[1]}-rt-private" }
}

# Only create default routes where a NAT exists for that (vpc,az)
resource "aws_route" "private_default" {
  for_each = {
    for k, rt in aws_route_table.private :
    k => rt if contains(keys(aws_nat_gateway.nat), k)
  }
  route_table_id = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = aws_nat_gateway.nat[each.key].id
}

resource "aws_route_table_association" "private_assoc" {
  for_each = { for s in local.private_subnets : "\${s.vpc_name}::\${s.name}" => s }
  subnet_id = aws_subnet.subnet["\${each.value.vpc_name}::\${each.value.name}"].id
  route_table_id = aws_route_table.private["\${each.value.vpc_name}::\${each.value.az}"].id
}

resource "aws_route_table" "isolated" {
  for_each = aws_vpc.vpc
  vpc_id = each.value.id
  tags = { Name = "\${var.naming_prefix}-\${each.key}-rt-isolated" }
}

resource "aws_route_table_association" "isolated_assoc" {
  for_each = { for s in local.isolated_subnets : "\${s.vpc_name}::\${s.name}" => s }
  subnet_id = aws_subnet.subnet["\${each.value.vpc_name}::\${each.value.name}"].id
  route_table_id = aws_route_table.isolated[each.value.vpc_name].id
}
`;

  writeFile(path.join(outDir, "README.md"), readme);
  writeFile(path.join(outDir, "variables.tf"), variablesTf);
  writeFile(path.join(outDir, "main.tf"), mainTf);
  writeFile(path.join(outDir, "terraform.tfvars.json"), JSON.stringify(tfvars, null, 2));

  console.log("✅ Export complete.");
}

main();

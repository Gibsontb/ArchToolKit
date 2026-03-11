import fs from "node:fs";
import path from "node:path";

function die(msg){ console.error("❌ "+msg); process.exit(1); }
function toRel(p){ return path.relative(process.cwd(), p).replace(/\\/g,"/"); }
function readJson(p){ try{ return JSON.parse(fs.readFileSync(p,"utf8")); } catch(e){ die(`Invalid JSON: ${toRel(p)}\n${e.message}`);} }
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function writeFile(p,s){ ensureDir(path.dirname(p)); fs.writeFileSync(p,s,"utf8"); console.log("📝 wrote:", toRel(p)); }
function parseArgs(argv){
  const args=argv.slice(2); const out={inPath:null,outDir:null};
  const inIdx=args.indexOf("--in"); if(inIdx!==-1&&args[inIdx+1]) out.inPath=args[inIdx+1];
  const outIdx=args.indexOf("--outdir"); if(outIdx!==-1&&args[outIdx+1]) out.outDir=args[outIdx+1];
  if(!out.inPath&&args[0]&&!args[0].startsWith("-")) out.inPath=args[0];
  if(!out.outDir&&args[1]&&!args[1].startsWith("-")) out.outDir=args[1];
  return out;
}

function main(){
  const {inPath:inArg,outDir:outArg}=parseArgs(process.argv);
  if(!inArg) die("Usage: npm run export:tf:oci -- <enriched.json> [infra/oci/<export>]");
  const repoRoot=process.cwd();
  const inPath=path.resolve(repoRoot,inArg);
  if(!fs.existsSync(inPath)) die(`Input file not found: ${toRel(inPath)}`);

  const enriched=readJson(inPath);
  const exportName=enriched?.meta?.export_name||"manual";
  const target=enriched?.inputs?.target||{};
  const region=target.region||"us-ashburn-1";
  const prefix=target.naming_prefix||exportName;

  const vpcs=enriched?.network?.vpcs||[];
  if(!Array.isArray(vpcs)||!vpcs.length) die("Enriched report has no network.vpcs. Run dc:enrich first.");

  const outDir=outArg?path.resolve(repoRoot,outArg):path.resolve(repoRoot,"infra","oci",exportName);
  ensureDir(outDir);

  console.log("✅ input:", toRel(inPath));
  console.log("✅ output dir:", toRel(outDir));

  const tfvars={
    region,
    naming_prefix: prefix,
    tenancy_ocid: "CHANGE_ME",
    user_ocid: "CHANGE_ME",
    fingerprint: "CHANGE_ME",
    private_key_path: "CHANGE_ME",
    compartment_ocid: "CHANGE_ME",
    vcns: vpcs.map(v=>({
      name: v.name,
      cidr: v.cidr||"",
      subnets: (v.subnets||[]).map(s=>({
        name: s.name,
        cidr: s.cidr||"",
        role: (s.role||"private").toLowerCase()
      }))
    }))
  };

  const variablesTf=`variable "region" { type = string }
variable "naming_prefix" { type = string }

variable "tenancy_ocid" { type = string }
variable "user_ocid" { type = string }
variable "fingerprint" { type = string }
variable "private_key_path" { type = string }
variable "compartment_ocid" { type = string }

variable "vcns" {
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

  const mainTf=`terraform {
  required_version = ">= 1.5.0"
  required_providers {
    oci = { source = "oracle/oci", version = ">= 5.0.0" }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

locals {
  vcns = var.vcns

  subnets_flat = flatten([
    for v in local.vcns : [
      for s in v.subnets : {
        vcn_name = v.name
        name     = s.name
        cidr     = s.cidr
        role     = lower(s.role)
      }
    ]
  ])

  public_subnets  = [for s in local.subnets_flat : s if s.role == "public"]
  private_subnets = [for s in local.subnets_flat : s if s.role == "private"]
}

resource "oci_core_vcn" "vcn" {
  for_each       = { for v in local.vcns : v.name => v }
  compartment_id = var.compartment_ocid
  display_name   = "\${var.naming_prefix}-\${each.key}"
  cidr_blocks    = [each.value.cidr]
  dns_label      = substr(replace(lower("\${var.naming_prefix}\${each.key}"), "/[^a-z0-9]/", ""), 0, 15)
}

resource "oci_core_internet_gateway" "igw" {
  for_each       = { for v in local.vcns : v.name => v if length([for s in local.public_subnets : s if s.vcn_name == v.name]) > 0 }
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "\${var.naming_prefix}-\${each.key}-igw"
  enabled        = true
}

resource "oci_core_nat_gateway" "nat" {
  for_each       = { for v in local.vcns : v.name => v if length([for s in local.private_subnets : s if s.vcn_name == v.name]) > 0 }
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "\${var.naming_prefix}-\${each.key}-nat"
}

resource "oci_core_route_table" "rt_public" {
  for_each       = oci_core_internet_gateway.igw
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "\${var.naming_prefix}-\${each.key}-rt-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = each.value.id
  }
}

resource "oci_core_route_table" "rt_private" {
  for_each       = oci_core_nat_gateway.nat
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "\${var.naming_prefix}-\${each.key}-rt-private"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = each.value.id
  }
}

resource "oci_core_subnet" "subnet" {
  for_each = { for s in local.subnets_flat : "\${s.vcn_name}::\${s.name}" => s }

  compartment_id      = var.compartment_ocid
  vcn_id              = oci_core_vcn.vcn[each.value.vcn_name].id
  cidr_block          = each.value.cidr
  display_name        = "\${var.naming_prefix}-\${replace(each.key, \"::\", \"-\")}"
  prohibit_public_ip_on_vnic = each.value.role != "public"

  route_table_id = each.value.role == "public"
    ? try(oci_core_route_table.rt_public[each.value.vcn_name].id, null)
    : try(oci_core_route_table.rt_private[each.value.vcn_name].id, null)
}
`;

  const readme=`# ATK OCI Terraform Export (${exportName})

Generated from: ${toRel(inPath)}

Creates:
- VCN(s) + subnets
- Internet Gateway + public route table (only if public subnets exist)
- NAT Gateway + private route table (only if private subnets exist)

Before plan/apply:
- set tenancy/user/fingerprint/private_key_path/compartment_ocid in terraform.tfvars.json
- fill empty CIDRs in terraform.tfvars.json
`;

  writeFile(path.join(outDir,"README.md"), readme);
  writeFile(path.join(outDir,"variables.tf"), variablesTf);
  writeFile(path.join(outDir,"main.tf"), mainTf);
  writeFile(path.join(outDir,"terraform.tfvars.json"), JSON.stringify(tfvars,null,2));
  console.log("✅ Export complete.");
}

main();

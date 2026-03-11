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
  if(!inArg) die("Usage: npm run export:tf:gcp -- <enriched.json> [infra/gcp/<export>]");
  const repoRoot=process.cwd();
  const inPath=path.resolve(repoRoot,inArg);
  if(!fs.existsSync(inPath)) die(`Input file not found: ${toRel(inPath)}`);

  const enriched=readJson(inPath);
  const exportName=enriched?.meta?.export_name||"manual";
  const target=enriched?.inputs?.target||{};
  const region=target.region||"us-east1";
  const prefix=target.naming_prefix||exportName;

  const vpcs=enriched?.network?.vpcs||[];
  if(!Array.isArray(vpcs)||!vpcs.length) die("Enriched report has no network.vpcs. Run dc:enrich first.");

  const outDir=outArg?path.resolve(repoRoot,outArg):path.resolve(repoRoot,"infra","gcp",exportName);
  ensureDir(outDir);

  console.log("✅ input:", toRel(inPath));
  console.log("✅ output dir:", toRel(outDir));

  const tfvars={
    project_id: "CHANGE_ME",
    region,
    naming_prefix: prefix,
    networks: vpcs.map(v=>({
      name: v.name,
      subnets: (v.subnets||[]).map(s=>({
        name: s.name,
        cidr: s.cidr||"",
        role: (s.role||"private").toLowerCase()
      }))
    }))
  };

  const variablesTf=`variable "project_id" { type = string }
variable "region" { type = string }
variable "naming_prefix" { type = string }

variable "networks" {
  type = list(object({
    name = string
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
    google = { source = "hashicorp/google", version = ">= 5.0.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  networks = var.networks

  subnets_flat = flatten([
    for n in local.networks : [
      for s in n.subnets : {
        net_name = n.name
        name     = s.name
        cidr     = s.cidr
        role     = lower(s.role)
      }
    ]
  ])

  private_subnets = [for s in local.subnets_flat : s if s.role == "private"]
}

resource "google_compute_network" "vpc" {
  for_each                = { for n in local.networks : n.name => n }
  name                    = "\${var.naming_prefix}-\${each.key}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  for_each = { for s in local.subnets_flat : "\${s.net_name}::\${s.name}" => s }

  name          = each.value.name
  ip_cidr_range = each.value.cidr
  region        = var.region
  network       = google_compute_network.vpc[each.value.net_name].id
}

# Cloud Router/NAT for private subnets (one per network if any private exists)
resource "google_compute_router" "router" {
  for_each = {
    for n in local.networks :
    n.name => n if length([for s in local.private_subnets : s if s.net_name == n.name]) > 0
  }
  name    = "\${var.naming_prefix}-\${each.key}-router"
  region  = var.region
  network = google_compute_network.vpc[each.key].id
}

resource "google_compute_router_nat" "nat" {
  for_each = google_compute_router.router

  name                               = "\${var.naming_prefix}-\${each.key}-nat"
  router                             = each.value.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  dynamic "subnetwork" {
    for_each = { for s in local.private_subnets : "\${s.net_name}::\${s.name}" => s if s.net_name == each.key }
    content {
      name                    = google_compute_subnetwork.subnet[subnetwork.key].id
      source_ip_ranges_to_nat  = ["ALL_IP_RANGES"]
    }
  }
}

# Baseline firewall: no inbound rules created (GCP default denies ingress unless rules exist)
`;

  const readme=`# ATK GCP Terraform Export (${exportName})

Generated from: ${toRel(inPath)}

Creates:
- VPC network(s) (custom mode)
- Subnets in var.region
- Cloud Router + Cloud NAT for private subnets (only if private subnets exist)

Before plan/apply:
- set project_id in terraform.tfvars.json
- fill empty CIDRs in terraform.tfvars.json
`;

  writeFile(path.join(outDir,"README.md"), readme);
  writeFile(path.join(outDir,"variables.tf"), variablesTf);
  writeFile(path.join(outDir,"main.tf"), mainTf);
  writeFile(path.join(outDir,"terraform.tfvars.json"), JSON.stringify(tfvars,null,2));
  console.log("✅ Export complete.");
}

main();

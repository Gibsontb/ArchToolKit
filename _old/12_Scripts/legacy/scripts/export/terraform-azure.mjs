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
  if(!inArg) die("Usage: npm run export:tf:azure -- <enriched.json> [infra/azure/<export>]");
  const repoRoot=process.cwd();
  const inPath=path.resolve(repoRoot,inArg);
  if(!fs.existsSync(inPath)) die(`Input file not found: ${toRel(inPath)}`);

  const enriched=readJson(inPath);
  const exportName=enriched?.meta?.export_name||"manual";
  const target=enriched?.inputs?.target||{};
  const location=target.location||target.region||"eastus";
  const prefix=target.naming_prefix||exportName;

  const vpcs=enriched?.network?.vpcs||[];
  if(!Array.isArray(vpcs)||!vpcs.length) die("Enriched report has no network.vpcs. Run dc:enrich first.");

  const outDir=outArg?path.resolve(repoRoot,outArg):path.resolve(repoRoot,"infra","azure",exportName);
  ensureDir(outDir);

  console.log("✅ input:", toRel(inPath));
  console.log("✅ output dir:", toRel(outDir));

  const tfvars={
    location,
    naming_prefix: prefix,
    vnets: vpcs.map(v=>({
      name: v.name,
      cidr: v.cidr||"",
      subnets: (v.subnets||[]).map(s=>({
        name: s.name,
        cidr: s.cidr||"",
        role: (s.role||"private").toLowerCase()
      }))
    }))
  };

  const variablesTf=`variable "location" { type = string }
variable "naming_prefix" { type = string }

variable "vnets" {
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
    azurerm = { source = "hashicorp/azurerm", version = ">= 3.0.0" }
  }
}

provider "azurerm" { features {} }

locals {
  vnets = var.vnets

  subnets_flat = flatten([
    for v in local.vnets : [
      for s in v.subnets : {
        vnet_name = v.name
        name      = s.name
        cidr      = s.cidr
        role      = lower(s.role)
      }
    ]
  ])

  private_subnets = [for s in local.subnets_flat : s if s.role == "private"]
}

resource "azurerm_resource_group" "rg" {
  name     = "\${var.naming_prefix}-rg"
  location = var.location
}

resource "azurerm_virtual_network" "vnet" {
  for_each            = { for v in local.vnets : v.name => v }
  name                = "\${var.naming_prefix}-\${each.key}"
  address_space       = [each.value.cidr]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet" "subnet" {
  for_each = { for s in local.subnets_flat : "\${s.vnet_name}::\${s.name}" => s }

  name                 = each.value.name
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet[each.value.vnet_name].name
  address_prefixes     = [each.value.cidr]
}

# Baseline NSG per subnet role
resource "azurerm_network_security_group" "nsg" {
  for_each            = { for s in local.subnets_flat : "\${s.vnet_name}::\${s.name}" => s }
  name                = "\${var.naming_prefix}-\${replace(each.key, \"::\", \"-\")}-nsg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet_network_security_group_association" "nsg_assoc" {
  for_each = azurerm_network_security_group.nsg
  subnet_id                 = azurerm_subnet.subnet[each.key].id
  network_security_group_id = each.value.id
}

# Optional: NAT Gateway for private subnets (one per deployment)
resource "azurerm_public_ip" "nat_pip" {
  count               = length(local.private_subnets) > 0 ? 1 : 0
  name                = "\${var.naming_prefix}-nat-pip"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_nat_gateway" "nat" {
  count               = length(local.private_subnets) > 0 ? 1 : 0
  name                = "\${var.naming_prefix}-nat"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "Standard"
}

resource "azurerm_nat_gateway_public_ip_association" "nat_ip_assoc" {
  count                = length(local.private_subnets) > 0 ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.nat[0].id
  public_ip_address_id = azurerm_public_ip.nat_pip[0].id
}

resource "azurerm_subnet_nat_gateway_association" "nat_assoc" {
  for_each = { for s in local.private_subnets : "\${s.vnet_name}::\${s.name}" => s }
  subnet_id      = azurerm_subnet.subnet[each.key].id
  nat_gateway_id = azurerm_nat_gateway.nat[0].id
}
`;

  const readme = `# ATK Azure Terraform Export (${exportName})

Generated from: ${toRel(inPath)}

Creates:
- Resource group
- VNet(s) (from network.vpcs)
- Subnets
- NSG per subnet (associated)
- NAT Gateway + Public IP (only if there are private subnets), attached to private subnets

Before plan/apply: fill empty CIDRs in terraform.tfvars.json.
`;

  writeFile(path.join(outDir,"README.md"), readme);
  writeFile(path.join(outDir,"variables.tf"), variablesTf);
  writeFile(path.join(outDir,"main.tf"), mainTf);
  writeFile(path.join(outDir,"terraform.tfvars.json"), JSON.stringify(tfvars,null,2));
  console.log("✅ Export complete.");
}

main();

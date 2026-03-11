#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { readJson, writeJson, toRel, die } from "./_util.mjs";

function isNum(x){ return typeof x==="number" && Number.isFinite(x); }
function ceilTo(x, step){ if(!isNum(x)||x<=0) return x; return Math.ceil(x/step)*step; }

function sizeWorkload(vm){
  const baseVcpu = isNum(vm.vcpus) ? vm.vcpus : 2;
  const baseRam = isNum(vm.ram_gb) ? vm.ram_gb : 4;
  const u = vm.utilization || null;

  let recVcpu = baseVcpu;
  let recRam = baseRam;

  if (u && (isNum(u.cpu_max_pct) || isNum(u.cpu_avg_pct))) recVcpu = Math.max(2, Math.ceil(baseVcpu*1.25));
  else recVcpu = Math.max(2, baseVcpu);

  if (u && (isNum(u.ram_avg_pct) || isNum(u.ram_active_gb))) recRam = Math.max(4, ceilTo(baseRam*1.25, 1));
  else recRam = Math.max(4, ceilTo(baseRam, 1));

  return { vcpus: recVcpu, ram_gb: recRam };
}

function awsRecommendInstance(vcpus, ramGb, policy){
  const wantMemoryHeavy = ramGb / Math.max(1, vcpus) >= 6;
  const wantComputeHeavy = ramGb / Math.max(1, vcpus) <= 2;
  let family = "m7i";
  if (wantMemoryHeavy) family = "r7i";
  else if (wantComputeHeavy) family = "c7i";

  const sizes = [
    { v: 2, s: "large" },
    { v: 4, s: "xlarge" },
    { v: 8, s: "2xlarge" },
    { v: 16, s: "4xlarge" },
    { v: 32, s: "8xlarge" },
    { v: 48, s: "12xlarge" },
    { v: 64, s: "16xlarge" }
  ];
  let chosen = sizes[sizes.length-1].s;
  for (const r of sizes) { if (vcpus <= r.v) { chosen = r.s; break; } }
  const notes = [];
  if (policy.internet_exposed) notes.push("internet_exposed: prefer ALB/WAF; keep instances private by default.");
  if (Array.isArray(policy.data_classification) && policy.data_classification.includes("CJIS")) notes.push("CJIS: enforce encryption and restricted IAM; validate region/compliance.");
  if (isNum(policy.rto_minutes) && policy.rto_minutes <= 60) notes.push("Tight RTO: plan Multi-AZ + backups/replication.");

  return { instance: `${family}.${chosen}`, family, notes };
}

function synthesizeNetwork(segments, ov){
  const segMap = ov?.network_overrides?.segment_map || {};
  const prefix = ov?.target?.naming_prefix || "atk";
  const defaultVpc = `${prefix}-primary`;
  const vpcsByName = new Map();
  const warnings = [];

  for (const s of segments) {
    const o = segMap[s.segment_id] || {};
    const vpcName = o.target_vpc || defaultVpc;
    if (!vpcsByName.has(vpcName)) vpcsByName.set(vpcName, { name: vpcName, cidr: null, subnets: [] });

    const cidr = o.cidr || s.cidr || null;
    const role = (o.target_subnet_role || s.zone || "private").toString().toLowerCase();
    if (!cidr) warnings.push(`Missing CIDR for segment '${s.name}' (${s.segment_id}). Set overrides.network_overrides.segment_map.${s.segment_id}.cidr`);

    vpcsByName.get(vpcName).subnets.push({
      name: o.rename || s.name,
      cidr,
      role: ["public","private","isolated"].includes(role) ? role : "private",
      source_segment_id: s.segment_id,
      vlan_id: s.vlan_id ?? null
    });
  }

  return { vpcs: Array.from(vpcsByName.values()), warnings };
}

const args = process.argv.slice(2).filter(Boolean);
if (!args.length) die("Usage: npm run dc:enrich -- <dc-import.json> [data/overrides/dc-overrides.json]");
const inPath = path.resolve(process.cwd(), args[0]);
const dc = readJson(inPath);

const ovPath = args[1] ? path.resolve(process.cwd(), args[1]) : null;
const ov = ovPath && fs.existsSync(ovPath) ? readJson(ovPath) : {};

const exportName = dc?.meta?.export_name || path.basename(path.dirname(inPath)) || "dc";
const policy = ov?.policy_overrides || {};
const target = ov?.target || { cloud: "aws", region: "us-east-1", naming_prefix: exportName };

const net = synthesizeNetwork(dc?.network?.segments || [], ov);

const workloads = (dc?.compute?.vms || []).map(vm => {
  const sizing = sizeWorkload(vm);
  return {
    name: vm.name,
    source_vm_id: vm.vm_id,
    sizing,
    recommendation: { aws: awsRecommendInstance(sizing.vcpus, sizing.ram_gb, policy) },
    networks: vm.networks || [],
    datastores: vm.datastores || [],
    utilization: vm.utilization || null
  };
});

const enriched = {
  meta: { generated_time: new Date().toISOString(), version: "dc-enrich/0.1.0", export_name: exportName },
  inputs: { target, policy },
  network: { vpcs: net.vpcs },
  compute: { workloads },
  explain: { warnings: net.warnings }
};

const outPath = path.resolve(process.cwd(), "reports", exportName, `enriched.${Date.now()}.json`);
writeJson(outPath, enriched);
console.log("✅ Wrote enriched report:", toRel(outPath));

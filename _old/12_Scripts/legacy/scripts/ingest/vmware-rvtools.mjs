#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readCsv } from "./_csv.mjs";

function die(msg){ console.error("❌ " + msg); process.exit(1); }
function toRel(p){ return path.relative(process.cwd(), p).replace(/\\/g,"/"); }
function normKey(s){ return (s??"").toString().trim().toLowerCase(); }

function findCol(row, candidates){
  const keys = Object.keys(row||{});
  const map = new Map(keys.map(k=>[normKey(k), k]));
  for (const c of candidates) if (map.has(c)) return map.get(c);
  for (const c of candidates) for (const k of keys) if (normKey(k).includes(c)) return k;
  return null;
}
function pick(row, candidates, def=""){
  const col = findCol(row, candidates);
  if (!col) return def;
  return (row[col]??"").toString().trim();
}
function toInt(x, def=0){
  const n = parseInt(String(x).replace(/[^\d-]/g,""),10);
  return Number.isFinite(n)?n:def;
}
function toNum(x, def=0){
  const s=String(x).trim(); if(!s) return def;
  const n=Number(s.replace(/,/g,"").replace(/[^\d.\-]/g,""));
  return Number.isFinite(n)?n:def;
}
function mbToGb(mb){ const n=toNum(mb,0); return n? n/1024 : 0; }

function findFileCI(dir, name){
  const wanted = name.toLowerCase();
  for (const f of fs.readdirSync(dir)) {
    if (f.toLowerCase()===wanted) return path.join(dir,f);
  }
  return null;
}

const args = process.argv.slice(2).filter(Boolean);
if (!args[0]) die("Usage: npm run ingest:rvtools -- data/raw/vmware/rvtools/<exportName>");
const rawFolder = path.resolve(process.cwd(), args[0]);
if (!fs.existsSync(rawFolder) || !fs.statSync(rawFolder).isDirectory()) die("Raw folder not found: " + toRel(rawFolder));
const exportName = args[1] || path.basename(rawFolder);

const vInfoPath = findFileCI(rawFolder, "vInfo.csv");
const vHostPath = findFileCI(rawFolder, "vHost.csv");
const vDatastorePath = findFileCI(rawFolder, "vDatastore.csv");
const vNetworkPath = findFileCI(rawFolder, "vNetwork.csv");

const vInfo = vInfoPath ? readCsv(vInfoPath) : [];
const vHost = vHostPath ? readCsv(vHostPath) : [];
const vDatastore = vDatastorePath ? readCsv(vDatastorePath) : [];
const vNetwork = vNetworkPath ? readCsv(vNetworkPath) : [];

const clusterNameToId = new Map();
const hostNameToId = new Map();
const datastoreNameToId = new Map();
const segmentNameToId = new Map();

function getOrMakeId(map, prefix, name){
  const key=(name??"").trim();
  if(!key) return null;
  if(!map.has(key)) map.set(key, `${prefix}-${String(map.size+1).padStart(3,"0")}`);
  return map.get(key);
}

const segments=[];
for (const row of vNetwork) {
  const name = pick(row, ["portgroup","network","network name","name"]);
  if(!name) continue;
  const vlanRaw = pick(row, ["vlan","vlan id","vlanid"]);
  const vlan = vlanRaw ? toInt(vlanRaw, null) : null;
  const sw = pick(row, ["vswitch","dvswitch","switch","switch name"], "") || null;
  const mtuRaw = pick(row, ["mtu"], "");
  const mtu = mtuRaw ? toInt(mtuRaw, null) : null;
  const segment_id = getOrMakeId(segmentNameToId, "seg", name);
  segments.push({ segment_id, name, vlan_id: vlan, switch_name: sw, mtu, cidr: null, gateway: null, zone: null });
}

const datastores=[];
for (const row of vDatastore) {
  const name = pick(row, ["datastore","datastore name","name"]);
  if(!name) continue;
  const type = pick(row, ["type"], "unknown") || "unknown";
  const capMB = pick(row, ["capacity mb","capacity"], "");
  const capGB = pick(row, ["capacity gb"], "");
  const freeMB = pick(row, ["free mb","free"], "");
  const freeGB = pick(row, ["free gb"], "");
  const usedMB = pick(row, ["used mb","used"], "");
  const usedGB = pick(row, ["used gb"], "");
  let capacity_gb = capGB ? toNum(capGB,0) : (capMB ? mbToGb(capMB) : 0);
  let used_gb = usedGB ? toNum(usedGB,0) : (usedMB ? mbToGb(usedMB) : 0);
  if(!used_gb && capacity_gb) {
    const free_gb = freeGB ? toNum(freeGB,0) : (freeMB ? mbToGb(freeMB) : 0);
    if (free_gb) used_gb = Math.max(0, capacity_gb - free_gb);
  }
  const datastore_id = getOrMakeId(datastoreNameToId,"ds",name);
  datastores.push({ datastore_id, name, type, capacity_gb: capacity_gb||null, used_gb: used_gb||null, tier: null, notes: null });
}

const hosts=[];
for (const row of vHost) {
  const name = pick(row, ["host","name","hostname"]);
  if(!name) continue;
  const clusterName = pick(row, ["cluster"], "");
  const cluster_id = clusterName ? getOrMakeId(clusterNameToId,"cl",clusterName) : "cl-unknown";
  const cpuModel = pick(row, ["cpu model","model"], "") || null;
  const sockets = toInt(pick(row, ["cpu sockets","sockets"], "0"), 0);
  const cores = toInt(pick(row, ["cpu cores","cores"], "0"), 0);
  const memMB = pick(row, ["memory mb","memory size","memory"], "");
  const memGB = pick(row, ["memory gb"], "");
  const ram_gb = memGB ? toNum(memGB,0) : mbToGb(memMB);
  const esxi = pick(row, ["esxi version","version"], "") || null;
  const host_id = getOrMakeId(hostNameToId,"esx",name);
  hosts.push({ host_id, name, cluster_id, cpu_sockets: sockets, cpu_cores: cores, cpu_model: cpuModel, ram_gb: ram_gb||0, esxi_version: esxi, power_state: null });
}

const clusters=[];
for (const [name,id] of clusterNameToId.entries()) clusters.push({ cluster_id: id, name, ha_enabled: null, drs_enabled: null, notes: null });
if(!clusters.length) clusters.push({ cluster_id: "cl-unknown", name:"UNKNOWN", ha_enabled:null, drs_enabled:null, notes:"No cluster data found" });

const vms=[];
for (const row of vInfo) {
  const name = pick(row, ["vm","name","vm name"]);
  if(!name) continue;
  const power = pick(row, ["powerstate","power state"], "") || null;
  const guest = pick(row, ["guest os","os"], "") || null;
  const vcpus = toInt(pick(row, ["num cpu","vcpu","cpus","cpu"], "0"), 0);
  const memMB = pick(row, ["memory","memory mb"], "");
  const memGB = pick(row, ["memory gb"], "");
  const ram_gb = memGB ? toNum(memGB,0) : mbToGb(memMB);
  const clusterName = pick(row, ["cluster"], "");
  const hostName = pick(row, ["host"], "");
  const cluster_id = clusterName ? getOrMakeId(clusterNameToId,"cl",clusterName) : "cl-unknown";
  const host_id = hostName ? getOrMakeId(hostNameToId,"esx",hostName) : null;

  const dsName = pick(row, ["datastore"], "");
  const ds_id = dsName ? getOrMakeId(datastoreNameToId,"ds",dsName) : null;

  const netName = pick(row, ["network 1","network","portgroup","network name"], "") || "";
  const seg_id = netName ? getOrMakeId(segmentNameToId,"seg",netName) : null;

  const vm_id = `vm-${String(vms.length+1).padStart(4,"0")}`;
  vms.push({ vm_id, name, power_state: power, guest_os: guest, vcpus, ram_gb, cluster_id, host_id, datastores: ds_id?[ds_id]:[], networks: seg_id?[seg_id]:[], disks:[], utilization:null, tags:{} });
}

// Ensure segments/datastores discovered from vInfo exist
for (const [name,id] of segmentNameToId.entries()) {
  if(!segments.some(s=>s.segment_id===id)) segments.push({ segment_id:id, name, vlan_id:null, switch_name:null, mtu:null, cidr:null, gateway:null, zone:null });
}
for (const [name,id] of datastoreNameToId.entries()) {
  if(!datastores.some(d=>d.datastore_id===id)) datastores.push({ datastore_id:id, name, type:"unknown", capacity_gb:null, used_gb:null, tier:null, notes:"Discovered from vInfo only" });
}

const normalized = {
  meta: { source:"rvtools", export_time:new Date().toISOString(), export_name: exportName, notes:`Imported from ${toRel(rawFolder)}`, version:"1.0.0" },
  compute: { clusters, hosts, vms },
  network: { segments },
  storage: { datastores }
};

const outDir = path.resolve(process.cwd(),"data","imports", exportName);
fs.mkdirSync(outDir,{recursive:true});
const outPath = path.join(outDir,"dc-import.normalized.json");
fs.writeFileSync(outPath, JSON.stringify(normalized,null,2),"utf8");
console.log("✅ Wrote normalized import:", toRel(outPath));

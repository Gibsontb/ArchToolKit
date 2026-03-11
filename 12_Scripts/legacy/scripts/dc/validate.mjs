#!/usr/bin/env node
import path from "node:path";
import { die, toRel, readJson, parseArgsPositional } from "./_util.mjs";

const args = parseArgsPositional(process.argv, "Usage: npm run dc:validate -- <path/to/dc-import.json>");
const inPath = path.resolve(process.cwd(), args[0]);
const dc = readJson(inPath);

function isNum(x){ return typeof x==="number" && Number.isFinite(x); }
function isInt(x){ return Number.isInteger(x) && x>=0; }

if (!dc.meta || !dc.compute || !dc.network || !dc.storage) die("Missing required top-level sections: meta/compute/network/storage");
if (!dc.meta.source || !dc.meta.export_time) die("meta.source and meta.export_time are required");

if (!Array.isArray(dc.compute.clusters)) die("compute.clusters must be an array");
if (!Array.isArray(dc.compute.hosts)) die("compute.hosts must be an array");
if (!Array.isArray(dc.compute.vms)) die("compute.vms must be an array");

for (const h of dc.compute.hosts) {
  if (!h.host_id || !h.name || !h.cluster_id) die("Each host requires host_id, name, cluster_id");
  if (!isInt(h.cpu_cores)) die(`Host cpu_cores must be int >= 0 (host ${h.name})`);
  if (!isNum(h.ram_gb)) die(`Host ram_gb must be number (host ${h.name})`);
}

for (const vm of dc.compute.vms) {
  if (!vm.vm_id || !vm.name) die("Each VM requires vm_id and name");
  if (!isInt(vm.vcpus)) die(`VM vcpus must be int >= 0 (vm ${vm.name})`);
  if (!isNum(vm.ram_gb)) die(`VM ram_gb must be number (vm ${vm.name})`);
  if (!Array.isArray(vm.networks)) die(`VM networks must be an array (vm ${vm.name})`);
  if (!Array.isArray(vm.disks)) die(`VM disks must be an array (vm ${vm.name})`);
}

if (!Array.isArray(dc.network.segments)) die("network.segments must be an array");
for (const s of dc.network.segments) {
  if (!s.segment_id || !s.name) die("Each segment requires segment_id and name");
  if (s.vlan_id !== undefined && s.vlan_id !== null && !isInt(s.vlan_id)) die(`segment vlan_id must be int or null (segment ${s.name})`);
}

if (!Array.isArray(dc.storage.datastores)) die("storage.datastores must be an array");
for (const ds of dc.storage.datastores) {
  if (!ds.datastore_id || !ds.name || !ds.type) die("Each datastore requires datastore_id, name, type");
  if (ds.capacity_gb !== undefined && ds.capacity_gb !== null && !isNum(ds.capacity_gb)) die(`capacity_gb must be number (${ds.name})`);
  if (ds.used_gb !== undefined && ds.used_gb !== null && !isNum(ds.used_gb)) die(`used_gb must be number (${ds.name})`);
}

console.log("✅ Datacenter import is valid:", toRel(inPath));

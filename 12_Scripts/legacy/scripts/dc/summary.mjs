#!/usr/bin/env node
import path from "node:path";
import { readJson, parseArgsPositional, toRel } from "./_util.mjs";

const args = parseArgsPositional(process.argv, "Usage: npm run dc:summary -- <path/to/dc-import.json>");
const inPath = path.resolve(process.cwd(), args[0]);
const dc = readJson(inPath);

const clusters = dc?.compute?.clusters?.length ?? 0;
const hosts = dc?.compute?.hosts?.length ?? 0;
const vms = dc?.compute?.vms?.length ?? 0;
const segments = dc?.network?.segments?.length ?? 0;
const datastores = dc?.storage?.datastores?.length ?? 0;

const totalVcpu = (dc?.compute?.vms || []).reduce((a,v)=>a+(Number(v.vcpus)||0),0);
const totalRamGb = (dc?.compute?.vms || []).reduce((a,v)=>a+(Number(v.ram_gb)||0),0);

const missingCidrs = (dc?.network?.segments || []).filter(s=>!s.cidr).length;

console.log("📌 Datacenter Summary:", toRel(inPath));
console.log("  Clusters:", clusters);
console.log("  Hosts:", hosts);
console.log("  VMs:", vms);
console.log("  Segments:", segments, `(missing CIDR: ${missingCidrs})`);
console.log("  Datastores:", datastores);
console.log("  VM totals: vCPU:", totalVcpu, "RAM(GB):", totalRamGb);

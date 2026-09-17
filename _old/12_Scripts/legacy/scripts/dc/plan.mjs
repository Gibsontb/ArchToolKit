#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { readJson, writeJson, toRel, die } from "./_util.mjs";

// Usage:
// npm run dc:plan -- <dc.json> [<overrides.json>]
const args = process.argv.slice(2).filter(Boolean);
if (!args.length) die("Usage: npm run dc:plan -- <dc-import.json> [data/overrides/dc-overrides.json]");

const inPath = path.resolve(process.cwd(), args[0]);
const dc = readJson(inPath);

const ovPath = args[1] ? path.resolve(process.cwd(), args[1]) : null;
const ov = ovPath && fs.existsSync(ovPath) ? readJson(ovPath) : {};

const exportName = dc?.meta?.export_name || path.basename(path.dirname(inPath)) || "dc";
const policy = ov?.policy_overrides || {};
const target = ov?.target || { cloud: "aws", region: "us-east-1" };

const plan = {
  meta: { generated_time: new Date().toISOString(), version: "dc-plan/0.1.0", export_name: exportName },
  inputs: { target, policy },
  network: { segments: dc.network.segments || [] },
  compute: { vms: dc.compute.vms || [] },
  storage: { datastores: dc.storage.datastores || [] }
};

const outPath = path.resolve(process.cwd(), "reports", exportName, `cloud-plan.${Date.now()}.json`);
writeJson(outPath, plan);
console.log("✅ Wrote plan:", toRel(outPath));

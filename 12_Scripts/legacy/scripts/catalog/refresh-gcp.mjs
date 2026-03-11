// scripts/catalog/refresh-gcp.mjs
// NO-LOGIN GCP inventory builder.
// Uses public Google APIs Discovery directory (no gcloud, no auth).

import path from "path";
import { ts, writeJson, normalizeName, fetchJson } from "./common.mjs";

const ROOT = path.resolve(process.cwd());
const RAW = path.join(ROOT, "data/raw/provider-inventory/gcp.available-services.json");
const OUT = path.join(ROOT, "data/imports/provider-inventory/gcp.normalized.json");

const DISCOVERY_URL = process.env.GCP_DISCOVERY_URL || "https://www.googleapis.com/discovery/v1/apis?preferred=true";

function toRecords(dirJson){
  const items = Array.isArray(dirJson?.items) ? dirJson.items : [];
  return items.map(it=>{
    const name = normalizeName(it.name || "");
    const version = normalizeName(it.version || "");
    const id = normalizeName((name && version) ? `${name}:${version}` : (name || version));
    const title = normalizeName(it.title || it.description || id);
    return {
      provider:"gcp",
      serviceId:id,
      name:title||id,
      aliases:[],
      source:{ type:"google_discovery_directory", url: DISCOVERY_URL },
      raw: it
    };
  }).filter(x=>x.serviceId);
}

async function main(){
  const dirJson = await fetchJson(DISCOVERY_URL);
  writeJson(RAW, { pulledAt: ts(), source:"discovery", url: DISCOVERY_URL, ...dirJson });
  const records = toRecords(dirJson);
  writeJson(OUT, { pulledAt: ts(), provider:"gcp", count: records.length, services: records });
  console.log(`[gcp] services=${records.length} (public, no login)`);
}

main().catch(err=>{ console.error(err); process.exit(1); });

// scripts/catalog/refresh-azure.mjs
// NO-LOGIN Azure inventory builder.
// Uses public Microsoft Learn reference (no az CLI, no login).

import path from "path";
import fs from "fs";
import { ts, writeJson, normalizeName, readJson } from "./common.mjs";

const ROOT = path.resolve(process.cwd());
const RAW = path.join(ROOT, "data/raw/provider-inventory/azure.providers.public.json");
const OUT = path.join(ROOT, "data/imports/provider-inventory/azure.normalized.json");

const MSLEARN_URL = process.env.AZURE_PROVIDERS_URL ||
  "https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-services-resource-providers";

async function fetchText(url){
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

function extractNamespaces(html){
  const re = /Microsoft\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*/g;
  const matches = html.match(re) || [];
  const uniq = Array.from(new Set(matches.map(s=>normalizeName(s)))).filter(Boolean);
  uniq.sort((a,b)=>a.localeCompare(b));
  return uniq;
}

function toRecords(namespaces){
  return (namespaces||[]).map(ns => ({
    provider: "azure",
    serviceId: ns,
    name: ns,
    aliases: [],
    source: { type: "mslearn_public_reference", url: MSLEARN_URL },
    raw: { namespace: ns }
  }));
}

async function main(){
  try{
    const html = await fetchText(MSLEARN_URL);
    const namespaces = extractNamespaces(html);
    if(!namespaces.length) throw new Error("No Microsoft.* namespaces found in MS Learn HTML.");

    writeJson(RAW, { pulledAt: ts(), url: MSLEARN_URL, namespaces });
    const records = toRecords(namespaces);
    writeJson(OUT, { pulledAt: ts(), provider: "azure", count: records.length, services: records });

    console.log(`[azure] namespaces=${records.length} (public, no login)`);
    return;
  }catch(e){
    const msg = String(e?.message || e);
    console.warn(`[azure] public fetch failed: ${msg}`);

    if(fs.existsSync(RAW)){
      const cached = readJson(RAW);
      const namespaces = cached.namespaces || [];
      const records = toRecords(namespaces);
      writeJson(OUT, { pulledAt: ts(), provider: "azure", count: records.length, services: records, cached:true });
      console.warn(`[azure] used cached namespaces=${records.length}`);
      return;
    }

    writeJson(OUT, { pulledAt: ts(), provider:"azure", count:0, services:[], skipped:true, reason:"public_fetch_failed_no_cache" });
    console.warn("[azure] wrote empty normalized inventory (no cache).");
  }
}

main().catch(err=>{ console.error(err); process.exit(1); });

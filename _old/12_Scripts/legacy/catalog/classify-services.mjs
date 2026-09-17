// scripts/catalog/classify-services.mjs
//
// Reads provider normalized inventories and classifies services into CCSM categories.
//
// Inputs:
//   data/imports/provider-inventory/<provider>.normalized.json
// Outputs:
//   data/imports/provider-inventory/<provider>.classified.json

import fs from "fs";
import path from "path";
import { readJson, writeJson, ts, normalizeName } from "./common.mjs";

const ROOT = path.resolve(process.cwd());
const TAXONOMY_FP = path.join(ROOT, "data/taxonomy/ccsm-enterprise-taxonomy.json");
const PROVIDERS = ["aws","azure","gcp","oci"];

function loadTaxonomy(){
  if(!fs.existsSync(TAXONOMY_FP)) throw new Error(`Missing taxonomy file: ${TAXONOMY_FP}`);
  const tax = readJson(TAXONOMY_FP);
  const cats = Array.isArray(tax.categories) ? tax.categories : [];
  const compiled = cats.map(c => ({
    id: c.id,
    name: c.name,
    keywords: (c.keywords || []).map(k => String(k).toLowerCase()),
  }));
  return { ...tax, categories: compiled };
}

function scoreCategory(text, cat){
  if(!cat.keywords.length) return { score: 0, hits: [] };
  let score = 0;
  const hits = [];
  const lower = text.toLowerCase();

  for(const kw of cat.keywords){
    if(!kw) continue;
    if(lower.includes(kw)){
      score += (kw.length >= 6 ? 3 : 2);
      hits.push(kw);
    }
  }

  const tokens = new Set(lower.split(/[^a-z0-9]+/g).filter(Boolean));
  for(const kw of cat.keywords){
    const token = kw.replace(/[^a-z0-9]+/g,"");
    if(token && tokens.has(token)){
      score += 1;
      hits.push(`token:${kw}`);
    }
  }

  return { score, hits: Array.from(new Set(hits)).slice(0,10) };
}

function classifyService(svc, taxonomy){
  const name = normalizeName(svc.name || svc.serviceId || "");
  const id = normalizeName(svc.serviceId || name || "");
  const aliases = Array.isArray(svc.aliases) ? svc.aliases : [];
  const corpus = [name, id, ...aliases].filter(Boolean).join(" | ");

  let best = { id:"unknown", name:"Unclassified", score:0, hits:[] };
  for(const cat of taxonomy.categories){
    if(cat.id === "unknown") continue;
    const r = scoreCategory(corpus, cat);
    if(r.score > best.score){
      best = { id: cat.id, name: cat.name, score: r.score, hits: r.hits };
    }
  }

  const confidence = best.score ? Math.max(0.15, Math.min(0.99, best.score / 12)) : 0.10;

  return {
    categoryId: best.score ? best.id : "unknown",
    categoryName: best.score ? best.name : "Unclassified",
    confidence,
    matched: best.hits
  };
}

function classifyProvider(provider, taxonomy){
  const inFp = path.join(ROOT, "data/imports/provider-inventory", `${provider}.normalized.json`);
  const outFp = path.join(ROOT, "data/imports/provider-inventory", `${provider}.classified.json`);

  if(!fs.existsSync(inFp)){
    writeJson(outFp, { pulledAt: ts(), provider, count: 0, services: [], skipped:true, reason:"missing_normalized" });
    console.warn(`[classify] ${provider}: missing normalized inventory (wrote empty classified)`);
    return { provider, ok:false, skipped:true };
  }

  const data = readJson(inFp);
  const services = Array.isArray(data.services) ? data.services : [];

  const classified = services.map(s => ({ ...s, classification: classifyService(s, taxonomy) }));

  const counts = {};
  for(const s of classified){
    const k = s.classification?.categoryId || "unknown";
    counts[k] = (counts[k] || 0) + 1;
  }

  writeJson(outFp, {
    pulledAt: ts(),
    provider,
    taxonomy: { file: "data/taxonomy/ccsm-enterprise-taxonomy.json", version: taxonomy.meta?.version || "unknown" },
    count: classified.length,
    categoryCounts: counts,
    services: classified
  });

  console.log(`[classify] ${provider}: services=${classified.length}`);
  return { provider, ok:true };
}

function main(){
  const taxonomy = loadTaxonomy();
  const results = PROVIDERS.map(p => classifyProvider(p, taxonomy));
  const ok = results.filter(r => r.ok).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`[classify] done. ok=${ok}, skipped=${skipped}`);
}

main();

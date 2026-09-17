// scripts/catalog/refresh-oci.mjs
// NO-LOGIN OCI inventory builder (public scrape + cache).
// Scrapes public OCI docs/marketing pages for likely service names.
// Falls back to cached scrape, then to data/raw/provider-inventory/oci.manual.json.

import path from "path";
import fs from "fs";
import { ts, writeJson, readJson, normalizeName } from "./common.mjs";

const ROOT = path.resolve(process.cwd());
const RAW_SCRAPE = path.join(ROOT, "data/raw/provider-inventory/oci.services.public.json");
const RAW_MANUAL = path.join(ROOT, "data/raw/provider-inventory/oci.manual.json");
const OUT = path.join(ROOT, "data/imports/provider-inventory/oci.normalized.json");

const CANDIDATE_URLS = [
  "https://docs.oracle.com/en-us/iaas/api/",
  "https://docs.oracle.com/en-us/iaas/Content/home.htm",
  "https://docs.oracle.com/en-us/iaas/Content/index.htm",
  "https://www.oracle.com/cloud/cloud-native/services/"
];

async function fetchText(url){
  const res = await fetch(url, { redirect: "follow" });
  if(!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

function stripTags(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&")
    .replace(/\s+/g," ")
    .trim();
}

function extractLikelyServiceNames(html){
  const names = new Set();

  const anchorRe = /<a[^>]*>([^<]{2,120})<\/a>/gi;
  let m;
  while((m = anchorRe.exec(html)) !== null){
    const t = normalizeName(m[1]).replace(/\s+/g," ").trim();
    if(!t) continue;
    if(t.length < 3 || t.length > 80) continue;
    if(/^(home|overview|getting started|documentation|api reference|reference|learn more|sign in|pricing)$/i.test(t)) continue;
    if(/[A-Za-z]/.test(t) && /[A-Z]/.test(t[0])) names.add(t);
  }

  const text = stripTags(html);
  const suffix = "(Service|Services|Cloud|Database|Storage|Compute|Networking|Network|Vault|Logging|Monitoring|Identity|Analytics|AI|Functions|Kubernetes|Registry|Gateway|Load Balancer|DNS|WAF)";
  const phraseRe = new RegExp(`\\b([A-Z][A-Za-z0-9+\\/\\-]*(?:\\s+[A-Z][A-Za-z0-9+\\/\\-]*){0,5}\\s+${suffix})\\b`, "g");
  while((m = phraseRe.exec(text)) !== null){
    const t = normalizeName(m[1]);
    if(t.length >= 6 && t.length <= 80) names.add(t);
  }

  const mustWords = ["Oracle","Cloud","Storage","Compute","Database","Vault","Identity","Networking","Kubernetes","Functions","Monitoring","Logging","WAF","DNS","Gateway","Registry","Load Balancer"];
  const keep = [ ...names ].filter(n => mustWords.some(w => n.includes(w)));
  keep.sort((a,b)=>a.localeCompare(b));
  return keep;
}

function normalizeServices(list, source){
  const services = (list||[]).map(name=>{
    const clean = normalizeName(name);
    const id = clean.toLowerCase()
      .replace(/\(.*?\)/g,"")
      .replace(/[^a-z0-9]+/g,"-")
      .replace(/^-+|-+$/g,"")
      .slice(0,80) || clean.toLowerCase();
    return { provider:"oci", serviceId:id, name:clean, aliases:[], source, raw:{ name:clean } };
  });

  const seen = new Set();
  const out = [];
  for(const s of services){
    if(!s.serviceId || seen.has(s.serviceId)) continue;
    seen.add(s.serviceId);
    out.push(s);
  }
  return out;
}

function loadManual(){
  if(!fs.existsSync(RAW_MANUAL)) return null;
  const raw = readJson(RAW_MANUAL);
  const list = Array.isArray(raw.services) ? raw.services : [];
  const records = list.map(s=>{
    const id = normalizeName(s.serviceId || s.id || s.name || "");
    const name = normalizeName(s.name || s.title || id);
    return { provider:"oci", serviceId:id, name, aliases:Array.isArray(s.aliases)?s.aliases:[], source:{type:"manual"}, raw:s };
  }).filter(x=>x.serviceId);
  return records;
}

async function scrape(){
  const perUrl = [];
  for(const url of CANDIDATE_URLS){
    try{
      const html = await fetchText(url);
      const names = extractLikelyServiceNames(html);
      perUrl.push({ url, ok:true, count:names.length, names });
    }catch(e){
      perUrl.push({ url, ok:false, error:String(e?.message||e) });
    }
  }
  const merged = new Set();
  for(const r of perUrl){
    if(r.ok) for(const n of (r.names||[])) merged.add(n);
  }
  const list = Array.from(merged);
  list.sort((a,b)=>a.localeCompare(b));
  return { perUrl, list };
}

async function main(){
  try{
    const s = await scrape();
    writeJson(RAW_SCRAPE, { pulledAt: ts(), strategy:"public_scrape", candidates:CANDIDATE_URLS, results:s.perUrl, services:s.list });

    if(s.list.length >= 20){
      const records = normalizeServices(s.list, { type:"public_scrape", candidates:CANDIDATE_URLS });
      writeJson(OUT, { pulledAt: ts(), provider:"oci", count: records.length, services: records });
      console.log(`[oci] services=${records.length} (public, no login)`);
      return;
    } else {
      console.warn(`[oci] public scrape returned only ${s.list.length} items; falling back...`);
    }
  }catch(e){
    console.warn(`[oci] public scrape failed: ${String(e?.message||e)}`);
  }

  if(fs.existsSync(RAW_SCRAPE)){
    const cached = readJson(RAW_SCRAPE);
    const list = cached.services || [];
    if(Array.isArray(list) && list.length){
      const records = normalizeServices(list, { type:"cached_public_scrape", cachedAt: cached.pulledAt });
      writeJson(OUT, { pulledAt: ts(), provider:"oci", count: records.length, services: records, cached:true });
      console.warn(`[oci] used cached public scrape services=${records.length}`);
      return;
    }
  }

  const manual = loadManual();
  if(manual && manual.length){
    writeJson(OUT, { pulledAt: ts(), provider:"oci", count: manual.length, services: manual, fallback:"manual" });
    console.warn(`[oci] used manual services=${manual.length}`);
    return;
  }

  writeJson(OUT, { pulledAt: ts(), provider:"oci", count:0, services:[], skipped:true, reason:"no_public_or_manual_source" });
  console.warn("[oci] wrote empty inventory (no public/manual).");
}

main().catch(err=>{ console.error(err); process.exit(1); });

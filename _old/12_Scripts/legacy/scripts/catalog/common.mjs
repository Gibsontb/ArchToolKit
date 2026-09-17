import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export function ts(){ return new Date().toISOString(); }
export function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
export function readJson(fp){ return JSON.parse(fs.readFileSync(fp,"utf-8")); }
export function writeJson(fp,obj){ ensureDir(path.dirname(fp)); fs.writeFileSync(fp, JSON.stringify(obj,null,2)+"\n","utf-8"); }
export function writeText(fp,txt){ ensureDir(path.dirname(fp)); fs.writeFileSync(fp,txt,"utf-8"); }
export function exists(fp){ return fs.existsSync(fp); }

export function run(cmd, opts={}){
  return execSync(cmd,{ stdio:["ignore","pipe","pipe"], encoding:"utf-8", ...opts }).trim();
}

export async function fetchJson(url){
  const res = await fetch(url,{ redirect:"follow" });
  if(!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.json();
}

export function normalizeName(s){ return String(s||"").trim(); }
export function uniq(arr){ return Array.from(new Set((arr||[]).filter(Boolean))); }

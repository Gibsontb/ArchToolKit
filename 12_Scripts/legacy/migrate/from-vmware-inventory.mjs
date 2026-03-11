import fs from "node:fs";
import path from "node:path";
const lower = (x)=>String(x??"").trim().toLowerCase();
function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf-8")); }
function ensureDir(p){ fs.mkdirSync(p, { recursive:true }); }
function die(msg){ console.error("❌ " + msg); process.exit(1); }

const APP_KEYS = ["application","app","service","system","product","workload"];
const OWNER_KEYS = ["owner","business owner","it owner","team","department","custodian"];
const CMP_KEYS = ["compliance","regulatory","regs","frameworks"];

function pick(obj, candidates){
  if(!obj) return "";
  const keys = Object.keys(obj);
  const map = new Map(keys.map(k=>[lower(k), k]));
  for(const c of candidates){ if(map.has(c)) return String(obj[map.get(c)]??"").trim(); }
  for(const c of candidates){
    for(const k of keys){ if(lower(k).includes(c)) return String(obj[k]??"").trim(); }
  }
  return "";
}
function splitList(s){ return String(s||"").split(/[;,]/).map(x=>x.trim()).filter(Boolean); }

function buildFolderMap(inv){
  const m = new Map();
  for(const f of (inv.folders||[])){
    const id = String(f.id||f.folderId||"");
    const name = String(f.name||f.path||"").trim();
    if(id && name) m.set(id, name);
  }
  return m;
}

function guessAppName(vm, folderMap){
  const ca = vm.customAttributes || {};
  const fromAttr = pick(ca, APP_KEYS);
  if(fromAttr) return fromAttr;
  const fid = String(vm.folderId||"");
  const fname = folderMap.get(fid) || "";
  if(fname) return fname.split("/").pop().trim();
  return "";
}

function summarize(appName, vms){
  const sample = vms[0] || {};
  const ca = sample.customAttributes || {};

  const osCounts = new Map();
  for(const vm of vms){
    const os = (vm.os && (vm.os.fullName||vm.os.guestId)) || "";
    if(!os) continue;
    osCounts.set(os, (osCounts.get(os)||0)+1);
  }
  let osRuntime = "";
  for(const [k,v] of osCounts.entries()){
    if(!osRuntime || v > (osCounts.get(osRuntime)||0)) osRuntime = k;
  }

  let dataSizeGb = 0;
  const nets = new Set();
  for(const vm of vms){
    for(const d of (vm.disks||[])) dataSizeGb += Number(d.sizeGB||0);
    for(const n of (vm.nics||[])){
      const nn = String(n.networkName||"").trim();
      if(nn) nets.add(nn);
    }
  }

  const name = appName || `VM: ${sample.name||"Unnamed"}`;
  const compliance = splitList(pick(ca, CMP_KEYS));

  return { name, owner: pick(ca, OWNER_KEYS) || "", criticality:"", rtoHours:null, rpoHours:null, primaryStack:"", osRuntime, database:"", vendor:"", identity:"", integrationCount:nets.size, dataSizeGb:Math.round(dataSizeGb), compliance, dataSovereigntyRequired:false, architecturePattern:"VM-based", notes:`Derived from ${vms.length} VM(s) in VMware inventory`, flags:{}, ratings:{} };
}

function buildPortfolio(inv){
  const folderMap = buildFolderMap(inv);
  const groups = new Map();
  for(const vm of (inv.vms||[])){
    const an = guessAppName(vm, folderMap);
    const key = an ? ("app:"+an) : ("vm:"+(vm.name||vm.id||"unknown"));
    if(!groups.has(key)) groups.set(key, { name: an, vms: [] });
    groups.get(key).vms.push(vm);
  }
  const portfolio = [];
  for(const g of groups.values()) portfolio.push(summarize(g.name, g.vms));
  portfolio.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  return portfolio;
}

const argv = process.argv.slice(2);
if(argv.length < 1) die("Usage: node scripts/migrate/from-vmware-inventory.mjs <inventory.json> [--out <path>]");

const invPath = argv[0];
let outPath = null;
for(let i=1;i<argv.length;i++){ if(argv[i] === "--out") outPath = argv[++i]; }

const invFull = path.isAbsolute(invPath) ? invPath : path.join(process.cwd(), invPath);
if(!fs.existsSync(invFull)) die("Not found: " + invFull);
const inv = readJson(invFull);
const portfolio = buildPortfolio(inv);

const result = { generatedAt: new Date().toISOString(), source: invFull, portfolio };
if(!outPath) outPath = path.join("data","migrate","generated","portfolio.from-vmware.json");
const outFull = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
ensureDir(path.dirname(outFull));
fs.writeFileSync(outFull, JSON.stringify(result, null, 2), "utf-8");
console.log("✅ Wrote:", outFull);

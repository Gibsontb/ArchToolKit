import fs from "node:fs";
import path from "node:path";
import { evaluatePortfolio, loadComplianceMap } from "./engine.mjs";

function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf-8")); }
function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

function toCsv(items){
  const header = ["wave","route","targetCloud","readinessScore","risk","name","owner","criticality","rtoHours","rpoHours","integrationCount","dataSizeGb","primaryStack","osRuntime","database","vendor","identity","compliance","dataSovereigntyRequired","notes"];
  const lines = [header.join(",")];
  const esc = (v) => { const s = String(v ?? ""); return /[,"\n\r]/.test(s) ? ('"' + s.replace(/"/g,'""') + '"') : s; };
  for (const x of items){
    const a = x.application || {}; const r = x.results || {};
    lines.push([r.wave,r.route,r.targetCloud,r.readinessScore,r.risk,a.name,a.owner,a.criticality,a.rtoHours,a.rpoHours,a.integrationCount,a.dataSizeGb,a.primaryStack,a.osRuntime,a.database,a.vendor,a.identity,(a.compliance||[]).join(";"),a.dataSovereigntyRequired?"true":"false",a.notes].map(esc).join(","));
  }
  return lines.join("\n");
}

const argv = process.argv.slice(2);
const inputPath = argv[0] || process.env.ATK_INPUT || "input.json";
const root = process.cwd();
const inputFull = path.isAbsolute(inputPath) ? inputPath : path.join(root, inputPath);

const input = readJson(inputFull);
const portfolio = input.portfolio || [];
const waveMode = (input.migration && input.migration.wave_mode) || "default";

const cmap = loadComplianceMap(root);
const items = evaluatePortfolio(portfolio, { waveMode, complianceMap: cmap });

const outDir = path.join(root, "web", "generated", "migration");
ensureDir(outDir);

fs.writeFileSync(path.join(outDir, "migration-portfolio.json"), JSON.stringify({ generatedAt:new Date().toISOString(), items }, null, 2), "utf-8");
fs.writeFileSync(path.join(outDir, "migration-portfolio.csv"), toCsv(items), "utf-8");

console.log("Wrote:");
console.log(" - web/generated/migration/migration-portfolio.json");
console.log(" - web/generated/migration/migration-portfolio.csv");

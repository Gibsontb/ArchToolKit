import fs from "node:fs";
import path from "node:path";
const lower = (x)=>String(x??"").trim().toLowerCase();

export function loadComplianceMap(root=process.cwd()){
  const p = path.join(root, "data", "migrate", "compliance-map.json");
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

export function normalizeCompliance(list, cmap){
  const raw = Array.isArray(list) ? list : String(list||"").split(/[;,]/);
  const cleaned = raw.map(x=>lower(x).replace(/\s+/g,"_")).filter(Boolean);
  const out = new Set(cleaned);

  const aliases = (cmap && cmap.aliases) || {};
  for (const v of Array.from(out)){
    if (aliases[v]) { out.delete(v); out.add(aliases[v]); }
  }

  if (out.has("fedramp_low") || out.has("fedramp_moderate") || out.has("fedramp_high")) out.add("commercial");

  const rules = (cmap && cmap.rules) || {};
  for (const v of Array.from(out)){
    const r = rules[v];
    if (r && Array.isArray(r.adds)) r.adds.forEach(x=>out.add(lower(x)));
  }

  return Array.from(out);
}

export function computeReadinessScore(ratings){
  const r = ratings || {};
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const n = (v) => clamp(Number(v || 3), 1, 5);
  const inv = (x) => 6 - x;

  const score =
    (n(r.cloudCompatibility) * 20) +
    (inv(n(r.technicalDebt)) * 20) +
    (n(r.architectureModularity) * 15) +
    (inv(n(r.complianceComplexity)) * 15) +
    (inv(n(r.vendorLockRisk)) * 10) +
    (inv(n(r.refactorEffort)) * 20);

  return Math.round((score / 500) * 100);
}

export function classifyCourse(app){
  const a = app || {};
  const flags = a.flags || {};
  if (flags.noLongerUsed || flags.isObsolete) return { route:"Retire", rationale:"Obsolete or no longer used." };
  if (flags.mustStayOnPrem || flags.hardwareBound || flags.mainframeBound) return { route:"Retain", rationale:"Must remain on-prem due to constraint." };
  if (flags.vendorSaaSAvailable) return { route:"Repurchase", rationale:"SaaS replacement available." };

  const readiness = Number(a.readinessScore ?? computeReadinessScore(a.ratings));
  const integrations = Number(a.integrationCount || 0);
  const arch = lower(a.architecturePattern || "");

  if (readiness >= 70 && integrations <= 10 && (arch.includes("micro") || arch.includes("event") || arch.includes("soa")))
    return { route:"Replatform", rationale:"High readiness; suitable for managed services." };
  if (readiness >= 60 && integrations <= 15) return { route:"Rehost", rationale:"Good readiness; lift-and-shift feasible." };
  if (readiness < 40 || integrations > 25) return { route:"Refactor", rationale:"Low readiness or high coupling; modernization required." };
  return { route:"Replatform", rationale:"Moderate readiness; prefer platform improvements." };
}

export function targetCloud(app){
  const a = app || {};
  const standard = lower(a.enterpriseStandardCloud || "");
  if (["aws","azure","gcp","oci"].includes(standard)) return { cloud:standard.toUpperCase(), rationale:"Enterprise standard cloud preference." };

  const stack = lower(a.primaryStack || "");
  if (stack.includes(".net") || stack.includes("windows") || stack.includes("sharepoint") || stack.includes("dynamics"))
    return { cloud:"AZURE", rationale:"Microsoft-aligned stack." };
  if (stack.includes("java") || stack.includes("data") || stack.includes("kafka"))
    return { cloud:"GCP", rationale:"Data/Java ecosystem fit." };
  return { cloud:"AWS", rationale:"Default cloud selection." };
}

export function riskBadge(app, complianceNorm){
  let points = 0;
  const crit = String(app.criticality || "").trim();
  if (crit.toLowerCase().includes("mission")) points += 3;
  else if (crit === "High") points += 2;
  else if (crit === "Medium") points += 1;

  const rto = Number(app.rtoHours || 0);
  const rpo = Number(app.rpoHours || 0);
  if (rto && rto <= 4) points += 2; else if (rto && rto <= 24) points += 1;
  if (rpo && rpo <= 1) points += 2; else if (rpo && rpo <= 4) points += 1;

  const ic = Number(app.integrationCount || 0);
  if (ic >= 20) points += 2; else if (ic >= 10) points += 1;

  const cmp = (complianceNorm || []).map(lower);
  if (cmp.some(x=>["fedramp_low","fedramp_moderate","fedramp_high","itar","cjis"].includes(x))) points += 2;
  else if (cmp.length) points += 1;

  if (points >= 8) return { label:"High" };
  if (points >= 5) return { label:"Medium" };
  return { label:"Low" };
}

export function wavePlan(route, readiness, risk, mode="default"){
  if (route === "Retain") return { wave:"Blocked", rationale:"Constraint blocks migration." };
  if (route === "Retire" || route === "Repurchase") return { wave:"Wave 1", rationale:"Quick outcome reduces footprint early." };

  const riskScore = (risk === "High") ? 3 : (risk === "Medium" ? 2 : 1);

  if (mode === "fast"){
    if ((route === "Rehost" || route === "Replatform") && riskScore <= 2) return { wave:"Wave 1", rationale:"Fast exit mode." };
  }
  if (mode === "modernize"){
    if (route === "Refactor" && riskScore <= 2 && readiness >= 70) return { wave:"Wave 1", rationale:"Modernize-first mode." };
  }

  if (riskScore === 1 && readiness >= 55) return { wave:"Wave 1", rationale:"Low risk + ready." };
  if (riskScore <= 2 && readiness >= 40) return { wave:"Wave 2", rationale:"Core migration band." };
  return { wave:"Wave 3", rationale:"High risk and/or heavy modernization." };
}

export function evaluatePortfolio(portfolio, opts={}){
  const waveMode = opts.waveMode || "default";
  const cmap = opts.complianceMap || null;
  const items = Array.isArray(portfolio) ? portfolio : [];
  return items.map((app)=>{
    const a = { ...app };
    const complianceNorm = normalizeCompliance(a.compliance || [], cmap);
    a.compliance = complianceNorm;
    a.readinessScore = Number(a.readinessScore ?? computeReadinessScore(a.ratings));

    const course = classifyCourse(a);
    const cloud = targetCloud(a);
    const risk = riskBadge(a, complianceNorm);
    const wave = wavePlan(course.route, a.readinessScore, risk.label, waveMode);

    return { application: a, results: { readinessScore:a.readinessScore, route:course.route, routeRationale:course.rationale, targetCloud:cloud.cloud, cloudRationale:cloud.rationale, risk:risk.label, wave:wave.wave, waveRationale:wave.rationale } };
  });
}

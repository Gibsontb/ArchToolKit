// scripts/decide.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const capPath = path.join(repoRoot, "data", "decision", "capabilities.json");
const patPath = path.join(repoRoot, "data", "decision", "patterns.json");
const rulePath = path.join(repoRoot, "data", "decision", "rules.json");

const caps = JSON.parse(fs.readFileSync(capPath, "utf8"));
const patterns = JSON.parse(fs.readFileSync(patPath, "utf8"));
const rules = JSON.parse(fs.readFileSync(rulePath, "utf8"));

const knownCaps = new Set((caps.capabilities || []).map((c) => c.capability_id));

function capExists(id) {
  return knownCaps.has(id);
}

function matchWhen(when, input) {
  if (!when) return true;

  if (when.internet_exposed_is !== undefined) {
    if (Boolean(input.internet_exposed) !== Boolean(when.internet_exposed_is)) return false;
  }

  if (when.rto_minutes_lte !== undefined) {
    const rto = Number(input.rto_minutes);
    if (!Number.isFinite(rto) || rto > Number(when.rto_minutes_lte)) return false;
  }

  if (when.data_classification_any_of) {
    const set = new Set([...(input.data_classification || [])].map(String));
    const ok = when.data_classification_any_of.some((x) => set.has(String(x)));
    if (!ok) return false;
  }

  return true;
}

function scorePattern(pattern, requiredCaps, preferredCaps) {
  // Hard gate: if pattern requires caps not in requiredCaps, it can still be chosen,
  // but it will score lower unless those caps are present in required or preferred.
  let score = 0;

  for (const c of pattern.requires_capabilities || []) {
    if (requiredCaps.has(c)) score += 20;
    else if (preferredCaps.has(c)) score += 10;
    else score -= 5;
  }
  for (const c of pattern.nice_to_have_capabilities || []) {
    if (requiredCaps.has(c)) score += 5;
    else if (preferredCaps.has(c)) score += 3;
  }
  return score;
}

// Read inputs from CLI JSON: node scripts/decide.mjs '{"data_classification":["CJIS"],"internet_exposed":true,"rto_minutes":30}'
const arg = process.argv[2] || "{}";
const input = JSON.parse(arg);

const requiredCaps = new Set();
const preferredCaps = new Set();
const preferredPatterns = new Map(); // pattern_id -> {scoreBoost, reasons[]}

for (const r of rules.rules || []) {
  if (!matchWhen(r.when, input)) continue;

  for (const c of r.require_capabilities || []) if (capExists(c)) requiredCaps.add(c);
  for (const c of r.prefer_capabilities || []) if (capExists(c)) preferredCaps.add(c);

  for (const pid of r.prefer_patterns || []) {
    const cur = preferredPatterns.get(pid) || { boost: 0, reasons: [] };
    cur.boost += Number(r.weight || 0);
    cur.reasons.push(r.reason || r.rule_id);
    preferredPatterns.set(pid, cur);
  }
}

// Score patterns
const scored = [];
for (const p of patterns.patterns || []) {
  const base = scorePattern(p, requiredCaps, preferredCaps);
  const boost = preferredPatterns.get(p.pattern_id)?.boost || 0;
  const reasons = preferredPatterns.get(p.pattern_id)?.reasons || [];
  scored.push({
    pattern_id: p.pattern_id,
    name: p.name,
    score: base + boost,
    used_for: p.used_for,
    reasons
  });
}

scored.sort((a, b) => b.score - a.score);

const result = {
  input,
  required_capabilities: [...requiredCaps],
  preferred_capabilities: [...preferredCaps],
  top_patterns: scored.slice(0, 5)
};

console.log(JSON.stringify(result, null, 2));

import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "normalized-input.json"), "utf8"));
const addressPlan = JSON.parse(fs.readFileSync(path.join(dir, "address-plan.output.json"), "utf8"));
const patterns = JSON.parse(fs.readFileSync(path.join(dir, "topology-patterns.json"), "utf8"));
const outFile = path.join(dir, "logical-topology.output.json");

const strategy = input.requirements.network_strategy || "hub_spoke";

function buildTopology(strategy, env) {
  const sharedHub = {
    name: `${env.environment}-hub`,
    role: strategy.includes("hub") ? "hub" : "core",
    cidr: env.cidr
  };

  const spokes = env.tiers.map(t => ({
    name: `${env.environment}-${t.tier}`,
    role: "segment",
    cidr: t.cidr,
    subnets: t.subnets
  }));

  const routing = strategy === "flat"
    ? { model: "east-west shared", domains: ["flat"] }
    : strategy === "segmented"
    ? { model: "segmented route domains", domains: env.tiers.map(t => t.tier) }
    : strategy === "transit_hub"
    ? { model: "central transit routing", domains: ["hub", ...env.tiers.map(t => t.tier)] }
    : strategy === "inspection_hub"
    ? { model: "inspection hub routing", domains: ["inspection", ...env.tiers.map(t => t.tier)] }
    : { model: "hub and spoke", domains: ["hub", ...env.tiers.map(t => t.tier)] };

  return {
    environment: env.environment,
    strategy,
    pattern: patterns.patterns.find(p => p.name === strategy) || null,
    core: sharedHub,
    segments: spokes,
    routing
  };
}

const topology = {
  strategy,
  environments: addressPlan.environments.map(env => buildTopology(strategy, env))
};

fs.writeFileSync(outFile, JSON.stringify(topology, null, 2));
console.log(`Wrote ${outFile}`);

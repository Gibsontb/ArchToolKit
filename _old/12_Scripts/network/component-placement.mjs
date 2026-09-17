import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "normalized-input.json"), "utf8"));
const addressPlan = JSON.parse(fs.readFileSync(path.join(dir, "address-plan.output.json"), "utf8"));
const topology = JSON.parse(fs.readFileSync(path.join(dir, "logical-topology.output.json"), "utf8"));
const catalog = JSON.parse(fs.readFileSync(path.join(dir, "component-catalog.json"), "utf8"));
const outFile = path.join(dir, "components.output.json");

function componentsForEnv(env) {
  const comps = [];
  comps.push({ type: "internet_gateway", placement: `${env.environment}-public-edge`, required: true });
  comps.push({ type: "nat_gateway", placement: `${env.environment}-egress`, required: true, scale: input.requirements.high_availability ? "per_unit" : "shared" });
  comps.push({ type: "hybrid_gateway", placement: `${env.environment}-edge`, required: (input.requirements.hybrid_connectivity || []).length > 0 });
  comps.push({ type: "transit_router", placement: `${env.environment}-hub`, required: ["hub_spoke","transit_hub","inspection_hub"].includes(input.requirements.network_strategy) });
  comps.push({ type: "firewall", placement: input.requirements.centralized_firewall ? `${env.environment}-inspection-hub` : `${env.environment}-distributed`, required: true });
  comps.push({ type: "edge_lb", placement: `${env.environment}-public-tier`, required: !!input.requirements.edge_required });
  comps.push({ type: "internal_lb", placement: `${env.environment}-app-tier`, required: true });
  comps.push({ type: "dns_resolver", placement: `${env.environment}-shared-services`, required: true });
  comps.push({ type: "bastion", placement: `${env.environment}-management-tier`, required: true });
  comps.push({ type: "cache", placement: `${env.environment}-shared-cache`, required: !!input.requirements.cache_required });
  return comps;
}

const out = {
  catalog: catalog.logical_components,
  environments: addressPlan.environments.map(env => ({
    environment: env.environment,
    components: componentsForEnv(env)
  }))
};

fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`Wrote ${outFile}`);

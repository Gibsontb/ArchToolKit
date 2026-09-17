import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const webGenDir = path.resolve("13_Web/static/generated");

const input = JSON.parse(fs.readFileSync(path.join(dir, "normalized-input.json"), "utf8"));
const addressPlan = JSON.parse(fs.readFileSync(path.join(dir, "address-plan.output.json"), "utf8"));
const topology = JSON.parse(fs.readFileSync(path.join(dir, "logical-topology.output.json"), "utf8"));
const components = JSON.parse(fs.readFileSync(path.join(dir, "components.output.json"), "utf8"));

function loadProvider(name) {
  return JSON.parse(fs.readFileSync(path.join(dir, "provider-terminology", `${name}.json`), "utf8"));
}
function loadCatalog(provider) {
  const f = path.join(webGenDir, `${provider}.services.generated.json`);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function findServiceSuggestions(provider, logicalType, catalog) {
  if (!catalog || !Array.isArray(catalog.services)) return [];
  const targets = {
    firewall: ["firewall", "network firewall", "security", "waf"],
    edge_lb: ["load balancer", "alb", "nlb", "gateway", "front door", "cdn"],
    cache: ["cache", "redis", "cdn"],
    dns_resolver: ["dns", "resolver"],
    hybrid_gateway: ["vpn", "interconnect", "direct connect", "expressroute", "fastconnect", "router"],
    transit_router: ["transit", "router", "route", "virtual wan", "drg"]
  };
  const terms = targets[logicalType] || [logicalType.replace(/_/g, " ")];
  const matches = catalog.services.filter(s => {
    const hay = `${s.name || ""} ${s.category || ""} ${s.capability_name || ""}`.toLowerCase();
    return terms.some(t => hay.includes(t));
  }).slice(0, 6);
  return matches.map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    capability_name: s.capability_name
  }));
}
function behavior(name) {
  if (name === "aws") return {
    routing_model: "route_tables",
    gateway_layout: "igw + nat_gateway + transit_gateway",
    inspection: "distributed or centralized via network firewall",
    addressing_notes: "VPC per environment; subnets per AZ"
  };
  if (name === "azure") return {
    routing_model: "udr",
    gateway_layout: "vpn/expressroute gateway + azure firewall",
    inspection: "centralized hub firewall",
    addressing_notes: "VNet per environment; subnets with NSGs"
  };
  if (name === "gcp") return {
    routing_model: "global_routes",
    gateway_layout: "cloud_router + cloud_nat + cloud_vpn/interconnect",
    inspection: "firewall rule policy",
    addressing_notes: "Global VPC with regional subnets"
  };
  return {
    routing_model: "route_tables_per_subnet",
    gateway_layout: "drg + igw + nat_gateway",
    inspection: "nsg/security_lists with optional firewall",
    addressing_notes: "VCN per environment with subnet route tables"
  };
}

for (const provider of input.requirements.clouds || ["aws"]) {
  const terms = loadProvider(provider);
  const catalog = loadCatalog(provider);
  const out = {
    provider,
    terms,
    behavior: behavior(provider),
    catalog_enrichment_enabled: !!catalog,
    environments: addressPlan.environments.map(env => {
      const topo = topology.environments.find(t => t.environment === env.environment);
      const comp = components.environments.find(c => c.environment === env.environment);
      return {
        environment: env.environment,
        top_level_network: {
          type: terms.network_term,
          name: `${env.environment}-${terms.network_term}`,
          cidr: env.cidr,
          ip_range_start: env.ip_range_start,
          ip_range_end: env.ip_range_end,
          usable_host_count: env.usable_host_count
        },
        availability_design: {
          unit_term: terms.availability_term,
          count: input.requirements.availability_units
        },
        route_design: {
          route_component: terms.route_term,
          model: behavior(provider).routing_model
        },
        topology: topo,
        address_plan: env,
        components: (comp?.components || []).map(c => ({
          logical_type: c.type,
          provider_component: c.type === "transit_router" ? terms.router_term
            : c.type === "hybrid_gateway" ? terms.hybrid_term
            : c.type === "firewall" ? terms.firewall_term
            : c.type === "edge_lb" ? terms.edge_term
            : c.type === "cache" ? terms.cache_term
            : c.type === "internet_gateway" ? terms.edge_term
            : c.type === "dns_resolver" ? "dns"
            : c.type,
          placement: c.placement,
          required: c.required,
          suggested_services: findServiceSuggestions(provider, c.type, catalog)
        }))
      };
    })
  };
  fs.writeFileSync(path.join(dir, `provider-design.${provider}.json`), JSON.stringify(out, null, 2));
  console.log(`Wrote provider-design.${provider}.json`);
}

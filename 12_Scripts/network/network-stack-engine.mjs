import fs from "fs";
import path from "path";
import { suggestServices } from "./catalog-adapter.mjs";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "normalized-input.json"), "utf8"));
const addressPlan = JSON.parse(fs.readFileSync(path.join(dir, "address-plan.output.json"), "utf8"));
const outFile = path.join(dir, "network-stack.output.json");

function providerTerms(provider) {
  if (provider === "aws") return { topNetwork:"VPC", subnet:"Subnet", route:"Route Table", router:"Transit Gateway", firewall:"AWS Network Firewall", hybrid:"VPN / Direct Connect", igw:"Internet Gateway", nat:"NAT Gateway", edge:"ALB / NLB", dns:"Route 53 Resolver" };
  if (provider === "azure") return { topNetwork:"Virtual Network", subnet:"Subnet", route:"UDR", router:"Virtual WAN / Route Server", firewall:"Azure Firewall / NSG", hybrid:"VPN Gateway / ExpressRoute", igw:"Public IP / Front Door", nat:"NAT Gateway", edge:"Application Gateway / Front Door", dns:"Azure DNS / Private DNS" };
  if (provider === "gcp") return { topNetwork:"VPC Network", subnet:"Subnetwork", route:"Route", router:"Cloud Router", firewall:"Firewall Rules", hybrid:"Cloud VPN / Interconnect", igw:"Default Internet Route / External LB", nat:"Cloud NAT", edge:"External LB / Global LB", dns:"Cloud DNS" };
  return { topNetwork:"VCN", subnet:"Subnet", route:"Route Table", router:"DRG", firewall:"OCI Network Firewall / NSG / Security Lists", hybrid:"IPSec / FastConnect", igw:"Internet Gateway", nat:"NAT Gateway", edge:"Load Balancer", dns:"Private DNS" };
}

const provider = input.requirements.cloud_family || (input.requirements.clouds || ["aws"])[0];
const region = (input.requirements.regions || [""])[0];
const topologyType = input.requirements.network_strategy || "hub_spoke";
const availabilityUnits = input.requirements.availability_units || 2;
const terms = providerTerms(provider);

function buildEnvironmentStack(env) {
  const routes = [];
  const subnets = [];
  for (const tier of env.tiers) {
    for (const s of tier.subnets) {
      subnets.push({
        name: s.name,
        type: terms.subnet,
        tier: tier.tier,
        cidr: s.cidr,
        network_address: s.network_address,
        gateway: s.gateway,
        usable_range_start: s.usable_range_start,
        usable_range_end: s.usable_range_end,
        broadcast: s.broadcast,
        usable_host_count: s.usable_host_count
      });
      routes.push({
        name: `${s.name}-routes`,
        type: terms.route,
        tier: tier.tier,
        attached_subnet: s.name,
        default_next_hop: tier.tier === "public" ? terms.igw : terms.nat
      });
    }
  }

  return {
    environment: env.environment,
    region,
    topology: topologyType,
    subnets,
    routes,
    components: {
      top_level_network: { name: `${env.environment}-${terms.topNetwork.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, type: terms.topNetwork, cidr: env.cidr },
      internet_gateway: { type: terms.igw, required: true },
      nat_gateways: Array.from({ length: availabilityUnits }, (_, i) => ({ name: `${env.environment}-nat-${i+1}`, type: terms.nat })),
      transit_router: { type: terms.router, required: ["hub_spoke","transit_hub","inspection_hub","virtual_wan","global_vpc"].includes(topologyType) },
      firewalls: [{ name: `${env.environment}-firewall`, type: terms.firewall, mode: "centralized" }],
      hybrid_connectivity: { type: terms.hybrid, modes: input.requirements.hybrid_connectivity || [] },
      edge: { type: terms.edge, tier: "public" },
      dns: { type: terms.dns, required: true },
      bastion: { type: "Bastion / Jump Host", tier: "management" },
      cache: input.requirements.cache_required ? { type: "Cache Tier", tier: "shared" } : null
    },
    service_suggestions: {
      internet_gateway: suggestServices(provider, "internet_gateway"),
      nat_gateway: suggestServices(provider, "nat_gateway"),
      transit_router: suggestServices(provider, "transit_router"),
      firewall: suggestServices(provider, "firewall"),
      edge_lb: suggestServices(provider, "edge_lb"),
      internal_lb: suggestServices(provider, "internal_lb"),
      dns: suggestServices(provider, "dns"),
      hybrid: suggestServices(provider, "hybrid"),
      cache: suggestServices(provider, "cache")
    }
  };
}

const output = {
  provider,
  region,
  topology: topologyType,
  generated_at: new Date().toISOString(),
  environments: addressPlan.environments.map(buildEnvironmentStack)
};

fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`Wrote ${outFile}`);

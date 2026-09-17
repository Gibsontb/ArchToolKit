import fs from "fs";
import path from "path";

const networkDir = path.resolve("11_DataModels/data/network");
const inputFile = path.join(networkDir, "normalized-input.json");

const logicalOutFile = path.join(networkDir, "logical-design.output.json");
const providerOut = {
  aws: path.join(networkDir, "provider-design.aws.json"),
  azure: path.join(networkDir, "provider-design.azure.json"),
  gcp: path.join(networkDir, "provider-design.gcp.json"),
  oci: path.join(networkDir, "provider-design.oci.json")
};

const providerMapFiles = {
  aws: path.resolve("12_Scripts/network/providers/aws/network-map.json"),
  azure: path.resolve("12_Scripts/network/providers/azure/network-map.json"),
  gcp: path.resolve("12_Scripts/network/providers/gcp/network-map.json"),
  oci: path.resolve("12_Scripts/network/providers/oci/network-map.json")
};

const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));

function ipToInt(ip) {
  return ip.split(".").reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0;
}
function parseCidr(cidr) {
  const [ip, prefix] = cidr.split("/");
  return { ip, prefix: Number(prefix) };
}
function cidrRange(cidr) {
  const { ip, prefix } = parseCidr(cidr);
  const base = ipToInt(ip);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const start = base & mask;
  const size = 2 ** (32 - prefix);
  const end = start + size - 1;
  return { start, end };
}
function overlaps(cidrA, cidrB) {
  const a = cidrRange(cidrA);
  const b = cidrRange(cidrB);
  return a.start <= b.end && b.start <= a.end;
}
function tierFromType(type) {
  const t = (type || "").toLowerCase();
  if (t === "dmz" || t === "web") return "public";
  if (t === "database") return "db";
  if (t === "management") return "management";
  if (t === "shared") return "shared";
  return "app";
}
function tierOctetBase(tier) {
  if (tier === "public") return 0;
  if (tier === "app") return 10;
  if (tier === "db") return 20;
  if (tier === "management") return 30;
  if (tier === "shared") return 40;
  return 50;
}
function vpcCidrForEnv(idx) {
  return `10.${100 + idx * 10}.0.0/16`;
}
function buildSegments(vpcCidr, azCount, sourceNetworks, envName) {
  const [a,b] = vpcCidr.split("/")[0].split(".").map(Number);
  const tiers = Array.from(new Set(sourceNetworks.map(n => tierFromType(n.type))));
  const segments = [];

  for (const tier of tiers) {
    for (let az = 1; az <= azCount; az++) {
      const third = tierOctetBase(tier) + (az - 1);
      segments.push({
        name: `${envName}-${tier}-az${az}`,
        cidr: `${a}.${b}.${third}.0/24`,
        tier,
        az: `az${az}`,
        route_domain: tier === "public" ? "internet" : (tier === "management" ? "admin" : "private")
      });
    }
  }
  return segments;
}
function validateNetworks(networks) {
  const conflicts = [];
  for (let i = 0; i < networks.length; i++) {
    for (let j = i + 1; j < networks.length; j++) {
      const a = networks[i], b = networks[j];
      if (a.cidr && b.cidr && overlaps(a.cidr, b.cidr)) {
        conflicts.push({ type: "overlap", a: a.name, b: b.name, cidr_a: a.cidr, cidr_b: b.cidr });
      }
    }
  }
  return conflicts;
}
function hybridComponents(req) {
  const items = [];
  if ((req.hybrid_connectivity || []).includes("vpn")) items.push("vpn");
  if ((req.hybrid_connectivity || []).includes("dedicated_link")) items.push("dedicated_link");
  return items;
}
function applyProviderBehavior(cloud) {
  if (cloud === "aws") {
    return {
      routing_model: "route_tables",
      segmentation: "subnets",
      firewall_model: "sg+nacl+optional_network_firewall",
      nat_strategy: "nat_gateway_per_az",
      connectivity: "igw+nat+vpn_or_direct_connect",
      topology_bias: "vpc_per_environment"
    };
  }
  if (cloud === "azure") {
    return {
      routing_model: "udr",
      segmentation: "subnets",
      firewall_model: "nsg+azure_firewall",
      nat_strategy: "centralized_nat_gateway",
      connectivity: "vpn_gateway_or_expressroute",
      topology_bias: "hub_spoke_vnet"
    };
  }
  if (cloud === "gcp") {
    return {
      routing_model: "global_routes",
      segmentation: "regional_subnets",
      firewall_model: "firewall_rules",
      nat_strategy: "cloud_nat",
      connectivity: "cloud_vpn_or_interconnect",
      topology_bias: "global_vpc_regional_subnets"
    };
  }
  if (cloud === "oci") {
    return {
      routing_model: "route_tables_per_subnet",
      segmentation: "subnets",
      firewall_model: "nsg+security_lists+optional_network_firewall",
      nat_strategy: "nat_gateway",
      connectivity: "drg+ipsec_or_fastconnect",
      topology_bias: "vcn_with_drg"
    };
  }
  return {};
}

const sourceNetworks = input.on_prem?.networks || [];
const req = input.requirements || {};
const conflicts = validateNetworks(sourceNetworks);

const logicalDesign = {
  design_name: "network-infrastructure-design-v2.1",
  source: input.source,
  requirements: req,
  validation: {
    has_conflicts: conflicts.length > 0,
    conflicts
  },
  topology: {
    strategy: req.network_strategy || "hub_spoke",
    centralized_firewall: !!req.centralized_firewall,
    inspection_required: !!req.inspection_required,
    hybrid_connectivity: hybridComponents(req)
  },
  environments: (req.environments || ["prod"]).map((env, idx) => {
    const logicalNetworkCidr = vpcCidrForEnv(idx);
    const segments = buildSegments(logicalNetworkCidr, req.availability_zones || 2, sourceNetworks, env);

    return {
      environment: env,
      logical_network: {
        cidr: logicalNetworkCidr,
        segments
      },
      components: {
        internet_gateway: segments.some(s => s.tier === "public"),
        nat: segments.some(s => s.tier !== "public"),
        firewall: !!req.centralized_firewall,
        hybrid_gateway: hybridComponents(req).length > 0,
        dns: true
      }
    };
  })
};

fs.writeFileSync(logicalOutFile, JSON.stringify(logicalDesign, null, 2));

for (const cloud of req.clouds || ["aws"]) {
  const mapping = JSON.parse(fs.readFileSync(providerMapFiles[cloud], "utf8"));
  const behavior = applyProviderBehavior(cloud);

  const providerDesign = {
    provider: cloud,
    mapping,
    behavior,
    generated_from: logicalOutFile,
    environments: logicalDesign.environments.map(env => ({
      environment: env.environment,
      top_level_network: {
        type: mapping.logical_network,
        cidr: env.logical_network.cidr
      },
      architecture: {
        strategy: logicalDesign.topology.strategy === "hub_spoke" ? {
          hub: mapping.hub,
          spoke: mapping.spoke
        } : {
          network: mapping.logical_network
        },
        behavior,
        segments: env.logical_network.segments.map(s => ({
          provider_component: mapping.subnet,
          name: s.name,
          cidr: s.cidr,
          tier: s.tier,
          az: s.az,
          route_domain: s.route_domain
        })),
        internet_gateway: env.components.internet_gateway ? mapping.internet_gateway : null,
        nat: env.components.nat ? mapping.nat : null,
        firewall: env.components.firewall ? mapping.firewall : null,
        hybrid_gateway: env.components.hybrid_gateway ? mapping.hybrid_gateway : null,
        routing: mapping.routing,
        dns: mapping.dns
      }
    }))
  };

  fs.writeFileSync(providerOut[cloud], JSON.stringify(providerDesign, null, 2));
}

console.log(`Wrote logical design: ${logicalOutFile}`);
for (const cloud of req.clouds || ["aws"]) {
  console.log(`Wrote provider design: ${providerOut[cloud]}`);
}

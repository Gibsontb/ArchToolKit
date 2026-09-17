import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "manual-input.aws.json"), "utf8"));
const plan = JSON.parse(fs.readFileSync(path.join(dir, "aws-address-plan.output.json"), "utf8"));
const outFile = path.join(dir, "aws-stack.output.json");

const req = input.requirements;

function routeTableName(env, tier) {
  return `${env}-${tier}-rt`;
}

function buildStack(env) {
  const publicSubnets = env.tiers.find(t => t.tier === "public")?.subnets || [];
  const appSubnets = env.tiers.find(t => t.tier === "app")?.subnets || [];
  const dbSubnets = env.tiers.find(t => t.tier === "db")?.subnets || [];
  const mgmtSubnets = env.tiers.find(t => t.tier === "management")?.subnets || [];
  const sharedSubnets = env.tiers.find(t => t.tier === "shared")?.subnets || [];
  const inspectionSubnets = env.tiers.find(t => t.tier === "inspection")?.subnets || [];

  const routeTables = [
    {
      name: routeTableName(env.environment, "public"),
      type: "Route Table",
      routes: [{ destination: "0.0.0.0/0", next_hop: "Internet Gateway" }]
    },
    {
      name: routeTableName(env.environment, "app"),
      type: "Route Table",
      routes: [{ destination: "0.0.0.0/0", next_hop: req.centralized_firewall ? "Inspection Route" : "NAT Gateway" }]
    },
    {
      name: routeTableName(env.environment, "db"),
      type: "Route Table",
      routes: [{ destination: "0.0.0.0/0", next_hop: req.centralized_firewall ? "Inspection Route" : "NAT Gateway" }]
    }
  ];

  if (mgmtSubnets.length) {
    routeTables.push({
      name: routeTableName(env.environment, "management"),
      type: "Route Table",
      routes: [{ destination: "0.0.0.0/0", next_hop: req.centralized_firewall ? "Inspection Route" : "NAT Gateway" }]
    });
  }
  if (sharedSubnets.length) {
    routeTables.push({
      name: routeTableName(env.environment, "shared"),
      type: "Route Table",
      routes: [{ destination: "0.0.0.0/0", next_hop: req.centralized_firewall ? "Inspection Route" : "NAT Gateway" }]
    });
  }
  if (inspectionSubnets.length) {
    routeTables.push({
      name: routeTableName(env.environment, "inspection"),
      type: "Route Table",
      routes: [{ destination: "0.0.0.0/0", next_hop: "Internet Gateway" }]
    });
  }

  return {
    environment: env.environment,
    region: input.region,
    vpc: {
      name: `${env.environment}-vpc`,
      type: "VPC",
      cidr: env.cidr,
      network_address: env.network_address,
      gateway: env.gateway,
      usable_range_start: env.usable_range_start,
      usable_range_end: env.usable_range_end
    },
    subnets: {
      public: publicSubnets,
      app: appSubnets,
      db: dbSubnets,
      management: mgmtSubnets,
      shared: sharedSubnets,
      inspection: inspectionSubnets
    },
    route_tables: routeTables,
    internet_gateway: {
      name: `${env.environment}-igw`,
      type: "Internet Gateway",
      attached_to: `${env.environment}-vpc`
    },
    nat_gateways: publicSubnets.map((s, idx) => ({
      name: `${env.environment}-nat-az${idx + 1}`,
      type: "NAT Gateway",
      subnet: s.name,
      eip_required: true
    })),
    transit_gateway: req.transit_gateway_required ? {
      name: `${env.environment}-tgw`,
      type: "Transit Gateway"
    } : null,
    network_firewall: req.centralized_firewall ? {
      name: `${env.environment}-network-firewall`,
      type: "AWS Network Firewall",
      subnets: inspectionSubnets.map(s => s.name)
    } : null,
    security_controls: {
      security_groups: true,
      nacls: true
    },
    edge: req.edge_load_balancer ? {
      alb: { name: `${env.environment}-alb`, type: "Application Load Balancer", subnets: publicSubnets.map(s => s.name) },
      nlb: { name: `${env.environment}-nlb`, type: "Network Load Balancer", subnets: publicSubnets.map(s => s.name) }
    } : null,
    dns: {
      type: "Route 53 Resolver",
      private_dns: true
    },
    hybrid: (req.hybrid_connectivity || []).length ? {
      type: "VPN / Direct Connect",
      modes: req.hybrid_connectivity
    } : null
  };
}

const stack = {
  provider: "aws",
  region: input.region,
  topology: input.topology,
  environments: plan.environments.map(buildStack)
};

fs.writeFileSync(outFile, JSON.stringify(stack, null, 2));
console.log(`Wrote ${outFile}`);

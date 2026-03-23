import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "manual-input.aws.json"), "utf8"));
const plan = JSON.parse(fs.readFileSync(path.join(dir, "aws-address-plan.output.json"), "utf8"));
const outFile = path.join(dir, "aws-network-graph.output.json");

function makeId(...parts) {
  return parts.join("-").replace(/[^a-zA-Z0-9-]/g, "-");
}

function buildEnv(env) {
  const envName = env.environment;
  const nodes = [];
  const edges = [];
  const flows = [];

  const vpcId = makeId("vpc", envName, "001");
  nodes.push({ id: vpcId, type: "aws_vpc", name: `${envName}-vpc`, cidr: env.cidr, region: input.region });

  const igwId = makeId("igw", envName, "001");
  nodes.push({ id: igwId, type: "aws_internet_gateway", name: `${envName}-igw`, attached_vpc: vpcId });
  edges.push({ from: igwId, to: vpcId, relation: "attached_to" });

  let tgwId = null;
  if (input.requirements.transit_gateway_required) {
    tgwId = makeId("tgw", envName, "001");
    nodes.push({ id: tgwId, type: "aws_ec2_transit_gateway", name: `${envName}-tgw` });
    const attachId = makeId("tgw-attach", envName, "vpc");
    nodes.push({ id: attachId, type: "aws_ec2_transit_gateway_vpc_attachment", name: `${envName}-tgw-attach`, transit_gateway_id: tgwId, vpc_id: vpcId });
    edges.push({ from: attachId, to: tgwId, relation: "attached_to" });
    edges.push({ from: attachId, to: vpcId, relation: "attached_to" });
  }

  const allSubnets = [];
  for (const tier of env.tiers) {
    for (const s of tier.subnets) {
      const subnetObj = {
        id: s.id,
        type: "aws_subnet",
        name: s.name,
        vpc_id: vpcId,
        availability_zone: s.az,
        tier: s.tier,
        cidr: s.cidr,
        network_address: s.network_address,
        gateway: s.gateway,
        usable_range_start: s.usable_range_start,
        usable_range_end: s.usable_range_end,
        broadcast: s.broadcast,
        usable_host_count: s.usable_host_count
      };
      nodes.push(subnetObj);
      edges.push({ from: s.id, to: vpcId, relation: "belongs_to" });
      allSubnets.push(subnetObj);
    }
  }

  const publicSubnets = allSubnets.filter(s => s.tier === "public");
  const appSubnets = allSubnets.filter(s => s.tier === "app");
  const dbSubnets = allSubnets.filter(s => s.tier === "db");
  const mgmtSubnets = allSubnets.filter(s => s.tier === "management");
  const sharedSubnets = allSubnets.filter(s => s.tier === "shared");
  const inspectionSubnets = allSubnets.filter(s => s.tier === "inspection");

  const natIds = [];
  publicSubnets.forEach((pub, idx) => {
    const eipId = makeId("eip", envName, `az${idx+1}`);
    const natId = makeId("nat", envName, `az${idx+1}`);
    natIds.push(natId);
    nodes.push({ id: eipId, type: "aws_eip", name: `${envName}-eip-az${idx+1}` });
    nodes.push({ id: natId, type: "aws_nat_gateway", name: `${envName}-nat-az${idx+1}`, subnet_id: pub.id, eip_id: eipId });
    edges.push({ from: natId, to: pub.id, relation: "placed_in" });
    edges.push({ from: natId, to: eipId, relation: "uses" });
  });

  const rtDefs = [
    ["public", publicSubnets, igwId],
    ["app", appSubnets, input.requirements.centralized_firewall ? "firewall-endpoint" : "nat"],
    ["db", dbSubnets, input.requirements.centralized_firewall ? "firewall-endpoint" : "nat"],
    ["management", mgmtSubnets, input.requirements.centralized_firewall ? "firewall-endpoint" : "nat"],
    ["shared", sharedSubnets, input.requirements.centralized_firewall ? "firewall-endpoint" : "nat"],
    ["inspection", inspectionSubnets, igwId]
  ];

  for (const [tier, subnets, nextHop] of rtDefs) {
    if (!subnets.length) continue;
    const rtId = makeId("rt", envName, tier);
    const routes = [];
    if (tier === "public" || tier === "inspection") {
      routes.push({ destination: "0.0.0.0/0", target: igwId });
    } else if (nextHop === "nat" && natIds.length) {
      subnets.forEach((s, idx) => routes.push({ destination: "0.0.0.0/0", target: natIds[idx % natIds.length], subnet: s.id }));
    } else if (nextHop === "firewall-endpoint") {
      routes.push({ destination: "0.0.0.0/0", target: "firewall-endpoint" });
    }
    nodes.push({ id: rtId, type: "aws_route_table", name: `${envName}-${tier}-rt`, vpc_id: vpcId, routes });
    edges.push({ from: rtId, to: vpcId, relation: "belongs_to" });

    subnets.forEach(s => {
      const assocId = makeId("rt-assoc", s.id);
      nodes.push({ id: assocId, type: "aws_route_table_association", subnet_id: s.id, route_table_id: rtId });
      edges.push({ from: assocId, to: s.id, relation: "associates" });
      edges.push({ from: assocId, to: rtId, relation: "associates" });
    });
  }

  let firewallId = null;
  if (input.requirements.centralized_firewall && inspectionSubnets.length) {
    firewallId = makeId("anfw", envName, "001");
    nodes.push({ id: firewallId, type: "aws_network_firewall", name: `${envName}-network-firewall`, inspection_subnet_ids: inspectionSubnets.map(s => s.id), policy: { inspection: "east-west + north-south" } });
    inspectionSubnets.forEach(s => edges.push({ from: firewallId, to: s.id, relation: "attached_to_inspection_subnet" }));
  }

  const sgAlbId = makeId("sg", envName, "alb");
  const sgAppId = makeId("sg", envName, "app");
  const sgDbId = makeId("sg", envName, "db");
  nodes.push({ id: sgAlbId, type: "aws_security_group", name: `${envName}-sg-alb`, rules: [{ source: "0.0.0.0/0", port: 443, protocol: "tcp" }] });
  nodes.push({ id: sgAppId, type: "aws_security_group", name: `${envName}-sg-app`, rules: [{ source_sg: sgAlbId, port: 443, protocol: "tcp" }] });
  nodes.push({ id: sgDbId, type: "aws_security_group", name: `${envName}-sg-db`, rules: [{ source_sg: sgAppId, port: 5432, protocol: "tcp" }] });

  const naclPublicId = makeId("nacl", envName, "public");
  nodes.push({ id: naclPublicId, type: "aws_network_acl", name: `${envName}-nacl-public`, tier: "public" });
  publicSubnets.forEach(s => edges.push({ from: naclPublicId, to: s.id, relation: "applies_to" }));

  if (input.requirements.edge_load_balancer && publicSubnets.length) {
    const albId = makeId("alb", envName, "001");
    const nlbId = makeId("nlb", envName, "001");
    nodes.push({ id: albId, type: "aws_lb", lb_type: "application", name: `${envName}-alb`, subnet_ids: publicSubnets.map(s => s.id), security_group_id: sgAlbId });
    nodes.push({ id: nlbId, type: "aws_lb", lb_type: "network", name: `${envName}-nlb`, subnet_ids: publicSubnets.map(s => s.id) });
    publicSubnets.forEach(s => {
      edges.push({ from: albId, to: s.id, relation: "placed_in" });
      edges.push({ from: nlbId, to: s.id, relation: "placed_in" });
    });
  }

  nodes.push({ id: makeId("r53r", envName, "001"), type: "aws_route53_resolver", name: `${envName}-resolver`, mode: "private_dns" });

  if ((input.requirements.hybrid_connectivity || []).length) {
    const vpnId = makeId("vpn", envName, "001");
    nodes.push({ id: vpnId, type: "aws_vpn_connection", name: `${envName}-vpn`, transit_gateway_id: tgwId });
    if (tgwId) edges.push({ from: vpnId, to: tgwId, relation: "attached_to" });
  }

  flows.push({ id: makeId("flow", envName, "ingress"), name: `${envName} ingress`, path: ["Internet", igwId, "ALB", "app-subnets", "db-subnets"] });
  flows.push({ id: makeId("flow", envName, "egress"), name: `${envName} egress`, path: ["app-subnets", firewallId || natIds[0] || "nat", igwId, "Internet"] });
  if (tgwId) flows.push({ id: makeId("flow", envName, "hybrid"), name: `${envName} hybrid`, path: ["On-Prem", "VPN/DirectConnect", tgwId, vpcId] });

  return { environment: envName, graph: { nodes, edges, flows } };
}

const output = {
  provider: "aws",
  region: input.region,
  topology: input.topology,
  environments: plan.environments.map(buildEnv)
};

fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`Wrote ${outFile}`);

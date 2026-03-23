const networkList = document.getElementById("networkList");
const ipPreview = document.getElementById("ipPreview");
const graphPreview = document.getElementById("graphPreview");
const jsonOutput = document.getElementById("jsonOutput");
const networks = [];

function ipToInt(ip) { return ip.split(".").reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0; }
function intToIp(intVal) { return [(intVal>>>24)&255, (intVal>>>16)&255, (intVal>>>8)&255, intVal&255].join("."); }
function subnetDetails(cidr) {
  const [ip, maskStr] = cidr.split("/");
  const mask = Number(maskStr);
  const base = ipToInt(ip);
  const hostBits = 32 - mask;
  const size = Math.pow(2, hostBits);
  const network = base;
  const broadcast = base + size - 1;
  return {
    network_address: intToIp(network),
    gateway: size > 4 ? intToIp(network + 1) : null,
    usable_range_start: size > 4 ? intToIp(network + 2) : null,
    usable_range_end: size > 4 ? intToIp(broadcast - 1) : null,
    broadcast: intToIp(broadcast),
    usable_host_count: size > 4 ? Math.max(0, size - 3) : Math.max(0, size - 2)
  };
}
function renderNetworks() {
  networkList.innerHTML = "";
  if (!networks.length) {
    networkList.innerHTML = '<div class="list-item">No on-prem networks yet.</div>';
    return;
  }
  networks.forEach(n => {
    const d = subnetDetails(n.cidr);
    const row = document.createElement("div");
    row.className = "list-item";
    row.textContent = `${n.name} | ${n.cidr} | ${n.type} | ${d.network_address} | gw ${d.gateway || "-"} | ${d.usable_range_start || "-"} - ${d.usable_range_end || "-"} | ${d.usable_host_count} hosts`;
    networkList.appendChild(row);
  });
}
function buildPlan() {
  const envs = document.getElementById("environments").value.split(",").map(x => x.trim()).filter(Boolean);
  const envPrefix = Number(document.getElementById("envPrefix").value || 16);
  const subnetPrefix = Number(document.getElementById("subnetPrefix").value || 24);
  const azCount = Number(document.getElementById("azCount").value || 2);
  const tierDefs = [
    { tier: "public", third: 0 },
    { tier: "app", third: 16 },
    { tier: "db", third: 32 },
    { tier: "management", third: 48 },
    { tier: "shared", third: 64 },
    ...(document.getElementById("centralFirewall").checked ? [{ tier: "inspection", third: 80 }] : [])
  ];
  return envs.map((env, idx) => {
    const second = 100 + idx * 10;
    const envCidr = `10.${second}.0.0/${envPrefix}`;
    return {
      environment: env,
      cidr: envCidr,
      ...subnetDetails(envCidr),
      tiers: tierDefs.map(td => ({
        tier: td.tier,
        cidr: `10.${second}.${td.third}.0/20`,
        ...subnetDetails(`10.${second}.${td.third}.0/20`),
        subnets: Array.from({ length: azCount }, (_, i) => {
          const third = td.third + i;
          const cidr = `10.${second}.${third}.0/${subnetPrefix}`;
          return { id: `subnet-${env}-${td.tier}-az${i+1}`, name: `${env}-${td.tier}-az${i+1}`, az: `${document.getElementById("regionSelect").value}${String.fromCharCode(97+i)}`, tier: td.tier, cidr, ...subnetDetails(cidr) };
        })
      }))
    };
  });
}
function renderPlan() {
  const plan = buildPlan();
  ipPreview.textContent = JSON.stringify(plan, null, 2);
  renderGraph(plan);
}
function renderGraph(plan) {
  const topology = document.getElementById("topologySelect").value;
  const region = document.getElementById("regionSelect").value;
  const tgwRequired = document.getElementById("tgwRequired").checked;
  const hybridRequired = document.getElementById("hybridRequired").checked;
  const edgeRequired = document.getElementById("edgeRequired").checked;
  const centralFirewall = document.getElementById("centralFirewall").checked;
  const azCount = Number(document.getElementById("azCount").value || 2);

  const preview = {
    provider: "aws",
    region,
    topology,
    environments: plan.map(env => ({
      environment: env.environment,
      nodes: [
        { type: "aws_vpc", id: `vpc-${env.environment}-001`, cidr: env.cidr },
        { type: "aws_internet_gateway", id: `igw-${env.environment}-001` },
        ...(tgwRequired ? [{ type: "aws_ec2_transit_gateway", id: `tgw-${env.environment}-001` }, { type: "aws_ec2_transit_gateway_vpc_attachment", id: `tgw-attach-${env.environment}-vpc` }] : []),
        ...(centralFirewall ? [{ type: "aws_network_firewall", id: `anfw-${env.environment}-001` }] : []),
        { type: "aws_security_group", id: `sg-${env.environment}-alb` },
        { type: "aws_security_group", id: `sg-${env.environment}-app` },
        { type: "aws_security_group", id: `sg-${env.environment}-db` },
        { type: "aws_network_acl", id: `nacl-${env.environment}-public` },
        ...(edgeRequired ? [{ type: "aws_lb", lb_type: "application", id: `alb-${env.environment}-001` }, { type: "aws_lb", lb_type: "network", id: `nlb-${env.environment}-001` }] : []),
        { type: "aws_route53_resolver", id: `r53r-${env.environment}-001` },
        ...(hybridRequired ? [{ type: "aws_vpn_connection", id: `vpn-${env.environment}-001` }] : []),
        ...Array.from({ length: azCount }, (_, i) => ({ type: "aws_nat_gateway", id: `nat-${env.environment}-az${i+1}` })),
        ...env.tiers.flatMap(t => t.subnets.map(s => ({ type: "aws_subnet", id: s.id, tier: s.tier, cidr: s.cidr, gateway: s.gateway })))
      ],
      flows: [
        { name: "ingress", path: ["Internet", `igw-${env.environment}-001`, `alb-${env.environment}-001`, "app-subnets", "db-subnets"] },
        { name: "egress", path: ["app-subnets", centralFirewall ? `anfw-${env.environment}-001` : `nat-${env.environment}-az1`, `igw-${env.environment}-001`, "Internet"] },
        ...(hybridRequired ? [{ name: "hybrid", path: ["On-Prem", `vpn-${env.environment}-001`, `tgw-${env.environment}-001`, `vpc-${env.environment}-001`] }] : [])
      ]
    }))
  };
  graphPreview.textContent = JSON.stringify(preview, null, 2);
}
function collect() {
  return {
    provider: "aws",
    region: document.getElementById("regionSelect").value,
    topology: document.getElementById("topologySelect").value,
    requirements: {
      environments: document.getElementById("environments").value.split(",").map(x => x.trim()).filter(Boolean),
      availability_zones: Number(document.getElementById("azCount").value || 2),
      root_cidr: document.getElementById("rootCidr").value.trim(),
      environment_prefix: Number(document.getElementById("envPrefix").value || 16),
      subnet_prefix: Number(document.getElementById("subnetPrefix").value || 24),
      centralized_firewall: document.getElementById("centralFirewall").checked,
      transit_gateway_required: document.getElementById("tgwRequired").checked,
      hybrid_connectivity: document.getElementById("hybridRequired").checked ? ["vpn"] : [],
      edge_load_balancer: document.getElementById("edgeRequired").checked,
      internal_load_balancer: true,
      shared_services_required: true,
      management_required: true
    },
    on_prem: { networks: networks.slice() }
  };
}
document.getElementById("addNetwork").addEventListener("click", function () {
  const name = document.getElementById("netName").value.trim();
  const cidr = document.getElementById("netCidr").value.trim();
  if (!name || !cidr) return;
  networks.push({ name, cidr, type: document.getElementById("netType").value, internet_exposed: document.getElementById("netInternet").checked });
  document.getElementById("netName").value = "";
  document.getElementById("netCidr").value = "";
  renderNetworks();
});
document.getElementById("generateJson").addEventListener("click", function () {
  jsonOutput.value = JSON.stringify(collect(), null, 2);
  renderPlan();
});
["rootCidr","envPrefix","subnetPrefix","environments","azCount","topologySelect","regionSelect","centralFirewall","tgwRequired","hybridRequired","edgeRequired"].forEach(id => {
  document.getElementById(id).addEventListener("input", renderPlan);
  document.getElementById(id).addEventListener("change", renderPlan);
});
renderNetworks();
renderPlan();

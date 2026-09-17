import fs from "fs";
import path from "path";

const inputCsv = process.argv[2];
if (!inputCsv) {
  console.error("Usage: node vcenter-network.mjs <csv-file>");
  process.exit(1);
}

const outDir = path.resolve("11_DataModels/data/network");
const outFile = path.join(outDir, "vcenter-raw.json");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(",").map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = cols[i] ?? "");
    return obj;
  });
}

function inferType(name = "") {
  const n = name.toLowerCase();
  if (n.includes("db")) return "database";
  if (n.includes("mgmt") || n.includes("admin")) return "management";
  if (n.includes("dmz") || n.includes("web") || n.includes("public")) return "dmz";
  if (n.includes("shared")) return "shared";
  return "application";
}

function inferCidrFromIp(ip = "") {
  if (!ip || !ip.includes(".")) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

const csvText = fs.readFileSync(inputCsv, "utf8");
const rows = parseCsv(csvText);

const networkMap = new Map();
const vmNetworkMap = [];

for (const row of rows) {
  const networkName = row["Network"] || row["Port Group"] || row["PortGroup"] || row["PG"] || "unknown";
  const vlan = row["VLAN"] || row["VLAN ID"] || row["VLANID"] || "";
  const ip = row["IP Address"] || row["IPAddress"] || row["IP"] || "";
  const vm = row["VM"] || row["VM Name"] || row["VMName"] || row["Name"] || "";

  if (!networkMap.has(networkName)) {
    networkMap.set(networkName, {
      name: networkName,
      vlan_id: vlan ? Number(vlan) || vlan : null,
      cidr: inferCidrFromIp(ip),
      type: inferType(networkName),
      internet_exposed: /dmz|public|web/i.test(networkName),
      compliance_zone: /db|restricted/i.test(networkName) ? "restricted" : (/mgmt|admin/i.test(networkName) ? "admin" : "internal")
    });
  } else {
    const existing = networkMap.get(networkName);
    if (!existing.cidr && ip) existing.cidr = inferCidrFromIp(ip);
  }

  if (vm) {
    vmNetworkMap.push({
      vm,
      network: networkName,
      ip_address: ip || null
    });
  }
}

const cidrBlocks = Array.from(new Set(Array.from(networkMap.values()).map(n => n.cidr).filter(Boolean)));

const result = {
  source: "vcenter",
  requirements: {
    clouds: ["aws", "azure", "gcp", "oci"],
    environments: ["prod"],
    regions: ["primary"],
    availability_units: 2,
    network_strategy: "hub_spoke",
    high_availability: true,
    multi_region: false,
    hybrid_connectivity: ["vpn"],
    centralized_firewall: true,
    inspection_required: true,
    edge_required: true,
    cache_required: false,
    shared_services_required: true
  },
  on_prem: {
    root_cidrs: cidrBlocks,
    networks: Array.from(networkMap.values())
  },
  vm_network_map: vmNetworkMap
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`Wrote ${outFile}`);

import fs from "fs";
import path from "path";

const mode = process.argv[2] || "manual";
const dir = path.resolve("11_DataModels/data/network");
const manualFile = path.join(dir, "manual-input.json");
const vcenterFile = path.join(dir, "vcenter-raw.json");
const outFile = path.join(dir, "normalized-input.json");

function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function uniqNetworks(arr) {
  const seen = new Set();
  const out = [];
  for (const n of arr || []) {
    const key = `${n.name}|${n.cidr}|${n.type}|${n.compliance_zone || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: n.name,
      cidr: n.cidr,
      type: n.type || "application",
      internet_exposed: !!n.internet_exposed,
      compliance_zone: n.compliance_zone || "internal",
      vlan_id: n.vlan_id ?? null
    });
  }
  return out;
}

const raw = mode === "vcenter" ? load(vcenterFile) : load(manualFile);
const out = {
  source: raw.source || mode,
  requirements: {
    clouds: raw.requirements?.clouds || ["aws"],
    environments: raw.requirements?.environments || ["prod"],
    regions: raw.requirements?.regions || ["primary"],
    availability_units: raw.requirements?.availability_units || 2,
    network_strategy: raw.requirements?.network_strategy || "hub_spoke",
    high_availability: !!raw.requirements?.high_availability,
    multi_region: !!raw.requirements?.multi_region,
    hybrid_connectivity: raw.requirements?.hybrid_connectivity || ["vpn"],
    centralized_firewall: !!raw.requirements?.centralized_firewall,
    inspection_required: !!raw.requirements?.inspection_required,
    edge_required: !!raw.requirements?.edge_required,
    cache_required: !!raw.requirements?.cache_required,
    shared_services_required: !!raw.requirements?.shared_services_required
  },
  on_prem: {
    root_cidrs: raw.on_prem?.root_cidrs || [],
    networks: uniqNetworks(raw.on_prem?.networks || [])
  },
  vm_network_map: raw.vm_network_map || []
};

fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`Wrote ${outFile}`);

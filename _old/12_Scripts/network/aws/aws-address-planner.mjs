import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "manual-input.aws.json"), "utf8"));
const outFile = path.join(dir, "aws-address-plan.output.json");

function ipToInt(ip) {
  return ip.split(".").reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0;
}
function intToIp(intVal) {
  return [(intVal >>> 24) & 255, (intVal >>> 16) & 255, (intVal >>> 8) & 255, intVal & 255].join(".");
}
function subnetDetails(cidr) {
  const [ip, maskStr] = cidr.split("/");
  const mask = Number(maskStr);
  const base = ipToInt(ip);
  const hostBits = 32 - mask;
  const size = 2 ** hostBits;
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

const req = input.requirements;
const envs = req.environments || ["prod"];
const azCount = req.availability_zones || 2;
const envPrefix = req.environment_prefix || 16;
const subnetPrefix = req.subnet_prefix || 24;
const tierDefs = [
  { tier: "public", third: 0 },
  { tier: "app", third: 16 },
  { tier: "db", third: 32 },
  { tier: "management", third: 48 },
  { tier: "shared", third: 64 },
  { tier: "inspection", third: 80 }
];

const plan = {
  provider: "aws",
  region: input.region,
  environments: envs.map((env, idx) => {
    const second = 100 + idx * 10;
    const envCidr = `10.${second}.0.0/${envPrefix}`;
    const envObj = { environment: env, cidr: envCidr, ...subnetDetails(envCidr), tiers: [] };

    for (const td of tierDefs) {
      if (td.tier === "shared" && !req.shared_services_required) continue;
      if (td.tier === "management" && !req.management_required) continue;
      if (td.tier === "inspection" && !req.centralized_firewall) continue;

      const tierCidr = `10.${second}.${td.third}.0/20`;
      const tierObj = { tier: td.tier, cidr: tierCidr, ...subnetDetails(tierCidr), subnets: [] };

      for (let az = 1; az <= azCount; az++) {
        const third = td.third + (az - 1);
        const subnetCidr = `10.${second}.${third}.0/${subnetPrefix}`;
        tierObj.subnets.push({
          id: `subnet-${env}-${td.tier}-az${az}`,
          name: `${env}-${td.tier}-az${az}`,
          az: `${input.region}${String.fromCharCode(96 + az)}`,
          tier: td.tier,
          cidr: subnetCidr,
          ...subnetDetails(subnetCidr)
        });
      }
      envObj.tiers.push(tierObj);
    }
    return envObj;
  })
};

fs.writeFileSync(outFile, JSON.stringify(plan, null, 2));
console.log(`Wrote ${outFile}`);

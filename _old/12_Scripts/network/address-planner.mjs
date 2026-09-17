import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const input = JSON.parse(fs.readFileSync(path.join(dir, "normalized-input.json"), "utf8"));
const outFile = path.join(dir, "address-plan.output.json");

function ipToInt(ip) {
  return ip.split(".").reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0;
}
function intToIp(intVal) {
  return [
    (intVal >>> 24) & 255,
    (intVal >>> 16) & 255,
    (intVal >>> 8) & 255,
    intVal & 255
  ].join(".");
}
function subnetDetails(cidr) {
  const [ip, maskStr] = cidr.split("/");
  const mask = Number(maskStr);
  const base = ipToInt(ip);
  const hostBits = 32 - mask;
  const size = 2 ** hostBits;
  const network = base;
  const broadcast = base + size - 1;

  const gateway = size > 4 ? network + 1 : null;
  const usableStart = size > 4 ? network + 2 : null;
  const usableEnd = size > 4 ? broadcast - 1 : null;
  const usableHostCount = size > 4 ? Math.max(0, size - 3) : Math.max(0, size - 2);

  return {
    network_address: intToIp(network),
    gateway: gateway !== null ? intToIp(gateway) : null,
    usable_range_start: usableStart !== null ? intToIp(usableStart) : null,
    usable_range_end: usableEnd !== null ? intToIp(usableEnd) : null,
    broadcast: intToIp(broadcast),
    usable_host_count: usableHostCount,
    reserved_ips: [
      intToIp(network),
      ...(gateway !== null ? [intToIp(gateway)] : []),
      intToIp(broadcast)
    ]
  };
}
function tierBase(tier) {
  if (tier === "public") return 0;
  if (tier === "app") return 16;
  if (tier === "db") return 32;
  if (tier === "management") return 48;
  if (tier === "shared") return 64;
  return 80;
}
function tierFromType(type) {
  const t = (type || "").toLowerCase();
  if (t === "dmz" || t === "web") return "public";
  if (t === "database") return "db";
  if (t === "management") return "management";
  if (t === "shared") return "shared";
  return "app";
}
function envBaseSecondOctet(idx) {
  return 100 + (idx * 10);
}

const envs = input.requirements.environments || ["prod"];
const au = input.requirements.availability_units || 2;
const envPrefix = input.requirements.environment_prefix || 16;
const subnetPrefix = input.requirements.subnet_prefix || 24;
const rootCidr = input.requirements.root_cidr || "10.0.0.0/8";
const tiers = Array.from(new Set((input.on_prem.networks || []).map(n => tierFromType(n.type))));

const addressPlan = {
  clouds: input.requirements.clouds,
  root_range: rootCidr,
  reserved_ranges: [
    "10.90.0.0/16",
    "10.91.0.0/16"
  ],
  environments: envs.map((env, idx) => {
    const second = envBaseSecondOctet(idx);
    const envCidr = `10.${second}.0.0/${envPrefix}`;
    const envDetails = subnetDetails(envCidr);

    const tierObjects = tiers.map(tier => {
      const tierCidr = `10.${second}.${tierBase(tier)}.0/20`;
      const tierDetails = subnetDetails(tierCidr);

      const subnets = [];
      for (let i = 0; i < au; i++) {
        const third = tierBase(tier) + i;
        const subnetCidr = `10.${second}.${third}.0/${subnetPrefix}`;
        const details = subnetDetails(subnetCidr);
        subnets.push({
          name: `${env}-${tier}-unit${i+1}`,
          cidr: subnetCidr,
          ...details
        });
      }

      return {
        tier,
        cidr: tierCidr,
        ...tierDetails,
        subnets
      };
    });

    return {
      environment: env,
      cidr: envCidr,
      ...envDetails,
      tiers: tierObjects
    };
  })
};

fs.writeFileSync(outFile, JSON.stringify(addressPlan, null, 2));
console.log(`Wrote ${outFile}`);

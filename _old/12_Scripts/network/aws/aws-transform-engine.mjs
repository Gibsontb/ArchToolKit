import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const stack = JSON.parse(fs.readFileSync(path.join(dir, "aws-stack.output.json"), "utf8"));
const outFile = path.join(dir, "aws-transformed-design.output.json");

const transformed = {
  provider: "aws",
  region: stack.region,
  topology: stack.topology,
  transformed_environments: stack.environments.map(env => ({
    environment: env.environment,
    target_network: env.vpc,
    network_components: {
      internet_gateway: env.internet_gateway,
      nat_gateways: env.nat_gateways,
      transit_gateway: env.transit_gateway,
      network_firewall: env.network_firewall,
      security_controls: env.security_controls,
      edge: env.edge,
      dns: env.dns,
      hybrid: env.hybrid
    },
    route_tables: env.route_tables,
    subnet_groups: env.subnets
  }))
};

fs.writeFileSync(outFile, JSON.stringify(transformed, null, 2));
console.log(`Wrote ${outFile}`);

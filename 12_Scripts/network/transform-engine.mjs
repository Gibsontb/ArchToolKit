import fs from "fs";
import path from "path";

const dir = path.resolve("11_DataModels/data/network");
const stack = JSON.parse(fs.readFileSync(path.join(dir, "network-stack.output.json"), "utf8"));
const outFile = path.join(dir, "transformed-design.output.json");

const output = {
  provider: stack.provider,
  region: stack.region,
  topology: stack.topology,
  transformed_environments: stack.environments.map(env => ({
    environment: env.environment,
    target_network: env.components.top_level_network,
    subnets: env.subnets,
    routes: env.routes,
    stack_components: env.components,
    service_suggestions: env.service_suggestions
  }))
};

fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`Wrote ${outFile}`);

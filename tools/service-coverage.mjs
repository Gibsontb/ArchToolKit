/** Report actual service wiring. Coverage is not feature completeness or deployment verification.
 * node tools/service-coverage.mjs aws [output.json]
 */
import { writeFileSync } from 'node:fs';
import { addServicesFor } from '../src/cloud/add-service-catalog.ts';

const platform = process.argv[2] ?? 'aws';
const rows = addServicesFor(platform);
if (!rows.length) throw new Error('No service catalog for platform ' + platform);
const services = rows.map(row => {
  const dedicated = row.terraform.filter(build => build.id.startsWith('aws_service_'));
  return {
    id: row.id, name: row.name, category: row.category,
    ...(row.availability ? { availability: row.availability } : {}),
    ...(row.setupAliasOf ? { setupAliasOf: row.setupAliasOf } : {}),
    ...(row.runtimeApi ? { runtimeApi: row.runtimeApi } : {}),
    coverage: row.availability?.status === 'retired' ? 'retired' : dedicated.length ? 'dedicated-setup-path' : row.terraform.length || row.ansible.length ? 'existing-builds' : row.native.length ? 'native-resource-types' : row.runtimeApi ? 'runtime-api' : 'unmapped',
    dedicatedPaths: dedicated.map(build => ({ id: build.id, description: build.description })),
    terraformBuilds: row.terraform.map(build => build.id), ansibleBuilds: row.ansible.map(build => build.id), nativeTypes: row.native,
  };
});
const counts = Object.fromEntries(['dedicated-setup-path', 'existing-builds', 'native-resource-types', 'runtime-api', 'retired', 'unmapped'].map(status => [status, services.filter(row => row.coverage === status).length]));
const uniqueDedicatedPaths = new Set(services.flatMap(row => row.dedicatedPaths.map(build => build.id))).size;
const setupAliases = services.filter(row => row.setupAliasOf).length;
const report = { platform, meaning: 'Wiring coverage only. Catalog aliases may share the same workflow; uniqueDedicatedPaths counts each build ID once. Dedicated paths can cover a subset of product features. Existing builds and native types require individual review. No live deployment or authorization is implied.', catalogEntries: services.length, uniqueDedicatedPaths, setupAliases, counts, services };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ platform, catalogEntries: services.length, uniqueDedicatedPaths, setupAliases, counts }, null, 2));

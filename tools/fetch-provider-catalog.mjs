#!/usr/bin/env node
/**
 * Refresh the Terraform resource catalog from the Terraform Registry.
 *
 * The kit needs to know which resources each provider actually has — to validate
 * a resource type before emitting it, and to let someone search for one. That
 * list is far too large to maintain by hand (around 5,000 resources and 4,000
 * data sources across the six providers) and changes with every provider
 * release, so it is fetched rather than written.
 *
 * Run it whenever provider versions move:
 *
 *   npm run catalog:update
 *
 * It writes src/terraform/catalog-data.ts, which is committed so the toolkit
 * still works air-gapped. The generated file records the version each list came
 * from and the date it was fetched, so the catalog can say how old it is instead
 * of quietly pretending to be current.
 *
 * Needs network access to registry.terraform.io. Nothing else.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'terraform', 'catalog-data.ts');

/** Registry source address per target, matching src/terraform/providers.ts. */
const SOURCES = {
  aws: 'hashicorp/aws',
  azure: 'hashicorp/azurerm',
  google: 'hashicorp/google',
  oci: 'oracle/oci',
  vsphere: 'vmware/vsphere',
  vcf: 'vmware/vcf',
};

/** The prefix every resource of a provider carries. */
const PREFIX = { aws: 'aws_', azure: 'azurerm_', google: 'google_', oci: 'oci_', vsphere: 'vsphere_', vcf: 'vcf_' };

/**
 * Registry slugs are inconsistent: usually the name without the provider
 * prefix, but occasionally with it. Normalise to the bare form either way.
 */
function normalise(target, slug) {
  const prefix = PREFIX[target];
  const full = slug.startsWith(prefix) ? slug : prefix + slug;
  return full.slice(prefix.length);
}

async function fetchProvider(target, source) {
  const response = await fetch(`https://registry.terraform.io/v1/providers/${source}`);
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const body = await response.json();
  const docs = body.docs ?? [];
  const pick = (category) =>
    [...new Set(docs.filter((d) => d.category === category).map((d) => normalise(target, d.slug)))].sort();
  return { version: body.version, source, resources: pick('resources'), dataSources: pick('data-sources') };
}

const results = {};
let failures = 0;
for (const [target, source] of Object.entries(SOURCES)) {
  try {
    process.stdout.write(`${source} … `);
    const entry = await fetchProvider(target, source);
    results[target] = entry;
    console.log(`${entry.version}: ${entry.resources.length} resources, ${entry.dataSources.length} data sources`);
  } catch (err) {
    failures += 1;
    console.log(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (Object.keys(results).length === 0) {
  console.error('\nNothing was fetched; the existing catalog was left alone.');
  process.exit(1);
}

/**
 * Keep providers that failed this run but succeeded a previous one.
 *
 * Writing only what was fetched would mean one transient network error quietly
 * removed a provider from the catalog, and the kit would then report its
 * resources as uncatalogued with nothing to explain why. Recovering the previous
 * entries is worth the small amount of parsing.
 */
function existingEntries() {
  let previous;
  try {
    previous = readFileSync(OUT, 'utf8');
  } catch {
    return {};
  }
  const found = {};
  // The generated file is written with JSON.stringify, so every value is
  // double-quoted. An earlier version of this pattern matched single quotes and
  // therefore never recovered anything — the exact failure it exists to prevent.
  const pattern =
    /(\w+):\s*\{\s*source:\s*"([^"]*)",\s*version:\s*"([^"]*)",\s*resources:\s*"([^"]*)",\s*dataSources:\s*"([^"]*)",/g;
  for (const m of previous.matchAll(pattern)) {
    found[m[1]] = {
      source: m[2],
      version: m[3],
      resources: m[4] ? m[4].split(',') : [],
      dataSources: m[5] ? m[5].split(',') : [],
    };
  }
  return found;
}

const kept = [];
if (failures > 0) {
  const previous = existingEntries();
  for (const [target, entry] of Object.entries(previous)) {
    if (!results[target]) {
      results[target] = entry;
      kept.push(target);
    }
  }
}

const body = Object.entries(results)
  .map(([target, entry]) => {
    const lines = [
      `  ${target}: {`,
      `    source: ${JSON.stringify(entry.source)},`,
      `    version: ${JSON.stringify(entry.version)},`,
      `    resources: ${JSON.stringify(entry.resources.join(','))},`,
      `    dataSources: ${JSON.stringify(entry.dataSources.join(','))},`,
      '  },',
    ];
    return lines.join('\n');
  })
  .join('\n');

const file = `/**
 * Terraform resource catalog — GENERATED, do not edit by hand.
 *
 * Written by tools/fetch-provider-catalog.mjs from the Terraform Registry.
 * Refresh with: npm run catalog:update
 *
 * Names are stored without their provider prefix and comma-joined, which keeps
 * this file a fraction of the size of the equivalent array literal.
 */

export interface CatalogEntryData {
  readonly source: string;
  readonly version: string;
  /** Comma-joined resource names, without the provider prefix. */
  readonly resources: string;
  /** Comma-joined data source names, without the provider prefix. */
  readonly dataSources: string;
}

/** When this file was generated, ISO date. */
export const CATALOG_FETCHED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};

export const CATALOG_DATA: Readonly<Record<string, CatalogEntryData>> = {
${body}
};
`;

writeFileSync(OUT, file);
const totals = Object.values(results).reduce(
  (acc, e) => ({ r: acc.r + e.resources.length, d: acc.d + e.dataSources.length }),
  { r: 0, d: 0 },
);
console.log(`\nWrote ${OUT}`);
console.log(`${totals.r} resources and ${totals.d} data sources across ${Object.keys(results).length} providers.`);
if (failures > 0) {
  console.log(`${failures} provider(s) could not be fetched.`);
  if (kept.length > 0) {
    console.log(`Kept the previous entries for: ${kept.join(', ')}.`);
  }
}

#!/usr/bin/env node
/**
 * Refresh the Ansible module catalog from Ansible Galaxy.
 *
 * The kit needs to know which modules each collection actually has — to check a
 * module name before writing it into a playbook, and to let someone search for
 * one. That is roughly four thousand modules across the eleven collections, it
 * changes with every release, and transcribing it would be wrong within a month.
 * So it is fetched rather than written.
 *
 *   npm run ansible:update      (or double-click update-ansible-catalog.bat)
 *
 * It writes src/ansible/catalog-data.ts, which is committed so the toolkit still
 * works air-gapped. The generated file records the version each list came from
 * and the date it was fetched, so the catalog can report its own age rather than
 * quietly pretending to be current.
 *
 * Galaxy has no endpoint that lists a collection's modules. What it does have is
 * the file manifest for a published version, and every module is a file under
 * plugins/modules/. That manifest is what this reads.
 *
 * Needs network access to galaxy.ansible.com. Nothing else.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'ansible', 'catalog-data.ts');
const API = 'https://galaxy.ansible.com/api/v3/plugin/ansible/content/published/collections/index';

/**
 * Collections to fetch, matching src/ansible/collections.ts.
 *
 * ansible.builtin is deliberately absent: it ships inside ansible-core and is
 * not published to Galaxy, so asking for it returns a 404.
 */
const COLLECTIONS = [
  'vmware.vmware',
  'vmware.vmware_rest',
  'community.vmware',
  'amazon.aws',
  'community.aws',
  'azure.azcollection',
  'google.cloud',
  'oracle.oci',
  'ansible.posix',
  'ansible.windows',
  'community.general',
  'microsoft.ad',
];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

/**
 * Module names for a collection's newest published version.
 *
 * Files under plugins/modules/ are the modules. Three extensions count, not
 * one: a Python module is `.py`, but a Windows module is a PowerShell `.ps1`
 * with a `.yml` sidecar carrying its documentation. Counting only `.py` made
 * ansible.windows look five modules smaller than it is and microsoft.ad look
 * like it had one — which then reported real modules as not existing.
 *
 * Anything starting with an underscore is a deprecated alias that Galaxy still
 * ships, and `__init__` is packaging rather than a module; neither should be
 * offered as something to write into a playbook.
 */
async function fetchCollection(fqcn) {
  const [namespace, name] = fqcn.split('.');
  const index = await getJson(`${API}/${namespace}/${name}/`);
  const version = index.highest_version?.version;
  if (!version) throw new Error(`${fqcn}: Galaxy reported no published version`);

  const detail = await getJson(`${API}/${namespace}/${name}/versions/${version}/`);
  const files = detail.files?.files ?? [];
  const PREFIX = 'plugins/modules/';
  const modules = [
    ...new Set(
      files
        .map((f) => String(f.name ?? ''))
        .filter((n) => n.startsWith(PREFIX) && /\.(py|ps1|yml)$/.test(n))
        // A Windows module is a .ps1 and a .yml with the same name, so the
        // extension comes off and the set deduplicates the pair.
        .map((n) => n.slice(PREFIX.length).replace(/\.(py|ps1|yml)$/, ''))
        .filter((n) => n && !n.startsWith('_') && n !== '__init__'),
    ),
  ].sort();

  return { version, modules };
}

const results = {};
let failures = 0;
for (const fqcn of COLLECTIONS) {
  try {
    process.stdout.write(`${fqcn} … `);
    const entry = await fetchCollection(fqcn);
    results[fqcn] = entry;
    console.log(`${entry.version}: ${entry.modules.length} modules`);
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
 * Keep collections that failed this run but succeeded a previous one.
 *
 * Writing only what was fetched would mean one transient network error quietly
 * removed a collection from the catalog, and the kit would then report its
 * modules as uncatalogued with nothing to explain why.
 */
function existingEntries() {
  let previous;
  try {
    previous = readFileSync(OUT, 'utf8');
  } catch {
    return {};
  }
  const found = {};
  // The generated file is written with JSON.stringify, so keys and values are
  // double-quoted. Matching single quotes here would silently never recover
  // anything, which is the failure this whole function exists to prevent.
  const pattern = /"([\w.]+)":\s*\{\s*"version":\s*"([^"]*)",\s*"modules":\s*"([^"]*)"/g;
  for (const m of previous.matchAll(pattern)) {
    found[m[1]] = { version: m[2], modules: m[3] ? m[3].split(',') : [] };
  }
  return found;
}

const kept = [];
if (failures > 0) {
  const previous = existingEntries();
  for (const [fqcn, entry] of Object.entries(previous)) {
    if (!results[fqcn]) {
      results[fqcn] = entry;
      kept.push(fqcn);
    }
  }
}

const body = Object.entries(results)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([fqcn, entry]) =>
    [
      `  ${JSON.stringify(fqcn)}: {`,
      `    "version": ${JSON.stringify(entry.version)},`,
      `    "modules": ${JSON.stringify(entry.modules.join(','))},`,
      '  },',
    ].join('\n'),
  )
  .join('\n');

const file = `/**
 * Ansible module catalog — GENERATED, do not edit by hand.
 *
 * Written by tools/fetch-ansible-catalog.mjs from Ansible Galaxy.
 * Refresh with: npm run ansible:update
 *
 * Module names are stored without their collection prefix and comma-joined,
 * which keeps this file a fraction of the size of the equivalent array literal.
 */

export interface AnsibleCatalogEntryData {
  /** Collection version the module list was taken from. */
  readonly version: string;
  /** Comma-joined module names, without the collection prefix. */
  readonly modules: string;
}

/** When this file was generated, ISO date. */
export const ANSIBLE_CATALOG_FETCHED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};

export const ANSIBLE_CATALOG_DATA: Readonly<Record<string, AnsibleCatalogEntryData>> = {
${body}
};
`;

writeFileSync(OUT, file);
const total = Object.values(results).reduce((n, e) => n + e.modules.length, 0);
console.log(`\nWrote ${OUT}`);
console.log(`${total} modules across ${Object.keys(results).length} collections.`);
if (failures > 0) {
  console.log(`${failures} collection(s) could not be fetched.`);
  if (kept.length > 0) console.log(`Kept the previous entries for: ${kept.join(', ')}.`);
}

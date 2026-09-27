#!/usr/bin/env node
/**
 * Build the cloud service catalog for one cloud: every service the provider
 * lists, under its official name and category, with the Terraform resources,
 * CloudFormation types (AWS) or ARM types (Azure) that build it.
 *
 *   node tools/fetch-service-catalog.mjs --cloud aws|azure|google|oci
 *
 * Each cloud writes its own file, src/cloud/service-catalog-<cloud>.ts, so a
 * refresh of one never rewrites another. src/cloud/service-catalog.ts reads
 * the four as one catalog. The files are committed so the toolkit still works
 * air-gapped.
 *
 * Where the services come from (all public, no credentials):
 *
 *   AWS     the AWS documentation home page's product list (names, categories,
 *           one-line descriptions), the Price List offer index (every offer
 *           code; its official name is read from the first few KB of each
 *           offer file with an HTTP Range request, not the whole file), and
 *           botocore's service models (serviceFullName, abbreviation and id of
 *           every API, read the same way from GitHub at one pinned commit).
 *   Azure   Microsoft Learn's "Resource providers for Azure services" table
 *           (namespace, service and category), and the Azure Retail Prices
 *           API (serviceName and serviceFamily; only the distinct names are
 *           needed, so it is queried with exclusion filters, not paged).
 *   Google  the Google Cloud Services Summary (the official list of services,
 *           by category, with descriptions), and the Google APIs Discovery
 *           directory, filtered to APIs documented on cloud.google.com. The
 *           Cloud Billing Catalog API would also do, but it needs a key.
 *   OCI     Oracle's public price-list API (serviceCategory per product).
 *
 * How services are merged and matched, with no guessing:
 *
 *  - Names are compared after lower-casing, dropping punctuation and the
 *    provider's brand prefix ("Amazon ", "AWS ", "Azure ", "Google Cloud ",
 *    "OCI "…). A trailing "(ECS)" or "(formerly Cloud Composer)" is an alias.
 *  - A record from a later source joins the service from an earlier source
 *    whose name it equals. If it equals two, it joins neither.
 *  - A Terraform registry subcategory (hashicorp/aws, hashicorp/azurerm,
 *    hashicorp/google, oracle/oci, at the versions in
 *    src/terraform/catalog-data.ts) belongs to a service when its name, or the
 *    name or abbreviation in its parentheses, equals exactly one service's name
 *    (first) or identifier (botocore id, docs slug, offer code, API name,
 *    ARM namespace; second). Otherwise it is kept as a service of its own,
 *    sourced from the registry and flagged as not in the provider's list, and
 *    reported in `unmatched` with the reason.
 *  - CloudFormation types (AWS::RDS::DBInstance) are matched by their namespace
 *    the same way. ARM types (Microsoft.Sql/servers) by the Learn table first:
 *    a namespace it gives to exactly one service goes to that service; one it
 *    shares between several is reported, not split.
 *  - CloudFormation and ARM types are read from the Data Editor's own schema
 *    indexes (src/editor/*-schema-index.ts), so the catalog never names a type
 *    the editor cannot check.
 *
 * The output is sorted and has no machine paths. It records every source URL,
 * whether it was read, and the fetch date.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'src', 'cloud');

const CLOUDS = ['aws', 'azure', 'google', 'oci'];
const arg = (() => {
  const i = process.argv.indexOf('--cloud');
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith('--cloud='));
  return eq ? eq.slice('--cloud='.length) : undefined;
})();
if (!arg || !CLOUDS.includes(arg)) {
  console.error(`Usage: node tools/fetch-service-catalog.mjs --cloud ${CLOUDS.join('|')}`);
  process.exit(1);
}
const CLOUD = arg;
const TODAY = new Date().toISOString().slice(0, 10);

/** Terraform provider per cloud, as keyed in src/terraform/catalog-data.ts. */
const TF = {
  aws: { key: 'aws', prefix: 'aws_' },
  azure: { key: 'azure', prefix: 'azurerm_' },
  google: { key: 'google', prefix: 'google_' },
  oci: { key: 'oci', prefix: 'oci_' },
};

/** Brand prefixes dropped before names are compared, longest first. */
const BRANDS = {
  aws: ['Amazon Web Services ', 'Amazon ', 'AWS '],
  azure: ['Microsoft Azure ', 'Azure ', 'Microsoft '],
  google: ['Google Cloud Platform ', 'Google Cloud ', 'Google ', 'Cloud '],
  oci: ['Oracle Cloud Infrastructure ', 'OCI ', 'Oracle '],
};

/** The common categories, in display order. */
const CATEGORIES = [
  'compute', 'containers', 'serverless', 'storage', 'database', 'networking',
  'security-identity', 'management-governance', 'monitoring', 'analytics', 'ai-ml',
  'integration-messaging', 'migration', 'developer-tools', 'end-user-computing', 'iot', 'other',
];

/**
 * Each provider's own grouping → the common category. Keys are normalised
 * (see norm()). A provider category not listed here is 'other' and is
 * reported in `unmappedCategories`, so a new one is noticed, not hidden.
 */
const CATEGORY_MAP = {
  aws: {
    analytics: 'analytics',
    applicationintegration: 'integration-messaging',
    awsmanagementconsole: 'management-governance',
    blockchain: 'other',
    businessapplications: 'other',
    cloudfinancialmanagement: 'management-governance',
    compute: 'compute',
    computehpc: 'compute',
    containers: 'containers',
    cryptographyandpki: 'security-identity',
    customerenablementservices: 'other',
    database: 'database',
    developertools: 'developer-tools',
    endusercomputing: 'end-user-computing',
    frontendwebandmobile: 'developer-tools',
    gamedevelopment: 'other',
    internetofthingsiot: 'iot',
    machinelearning: 'ai-ml',
    managementandgovernance: 'management-governance',
    marketplace: 'other',
    mediaservices: 'other',
    migrationandtransfer: 'migration',
    networkingandcontentdelivery: 'networking',
    partnercentral: 'other',
    quantumcomputing: 'compute',
    satellite: 'other',
    securityidentityandcompliance: 'security-identity',
    serverless: 'serverless',
    storage: 'storage',
  },
  azure: {
    // Learn's resource-provider table headings, without "resource providers".
    aiandmachinelearning: 'ai-ml',
    analytics: 'analytics',
    blockchain: 'other',
    compute: 'compute',
    container: 'containers',
    core: 'management-governance',
    database: 'database',
    developertools: 'developer-tools',
    devops: 'developer-tools',
    hybrid: 'management-governance',
    identity: 'security-identity',
    integration: 'integration-messaging',
    iot: 'iot',
    management: 'management-governance',
    migration: 'migration',
    monitoring: 'monitoring',
    network: 'networking',
    security: 'security-identity',
    storage: 'storage',
    web: 'serverless',
    '5gandspace': 'networking',
    // Retail Prices serviceFamily.
    aimachinelearning: 'ai-ml',
    azurearc: 'management-governance',
    azurecommunicationservices: 'integration-messaging',
    azurestack: 'compute',
    containers: 'containers',
    databases: 'database',
    gaming: 'other',
    internetofthings: 'iot',
    managementandgovernance: 'management-governance',
    microsoftsyntex: 'other',
    mixedreality: 'other',
    networking: 'networking',
    other: 'other',
    powerplatform: 'other',
    quantumcomputing: 'compute',
    telecommunications: 'networking',
    windowsvirtualdesktop: 'end-user-computing',
    microsoftfabric: 'analytics',
    dynamics: 'other',
    azuresecurity: 'security-identity',
    data: 'analytics',
    microsoft365copilot: 'other',
    windows365: 'end-user-computing',
  },
  google: {
    compute: 'compute',
    storage: 'storage',
    databases: 'database',
    networking: 'networking',
    operations: 'monitoring',
    developertools: 'developer-tools',
    dataanalytics: 'analytics',
    aimlservices: 'ai-ml',
    apimanagement: 'integration-messaging',
    containerservices: 'containers',
    googlemanagedmulticloudservices: 'management-governance',
    baremetal: 'compute',
    migration: 'migration',
    securityandidentity: 'security-identity',
    googledistributedcloud: 'compute',
    databoundarybypartners: 'security-identity',
    userprotectionservices: 'security-identity',
    serverlesscomputing: 'serverless',
    managementtools: 'management-governance',
    healthcareandlifesciences: 'other',
    mediaandgaming: 'other',
    googlecloudplatformpremiumsoftware: 'other',
    googlecloudplatformsoftware: 'other',
    secopsservicessummary: 'security-identity',
  },
  oci: {
    // The part of serviceCategory before " - ", or the whole of it.
    analytics: 'analytics',
    applicationdevelopment: 'developer-tools',
    applicationintegration: 'integration-messaging',
    compute: 'compute',
    dataintegration: 'integration-messaging',
    datamanagement: 'analytics',
    database: 'database',
    integration: 'integration-messaging',
    mediaservices: 'other',
    networking: 'networking',
    observability: 'monitoring',
    security: 'security-identity',
    storage: 'storage',
    ocimarketplace: 'other',
    ocigenerativeai: 'ai-ml',
    generativeai: 'ai-ml',
  },
};

// ------------------------------------------------------------------ http ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = { 'User-Agent': 'archtoolkit-fetch-service-catalog' };

/**
 * GET with the same patience as the other fetchers: a 429 (or 403 from
 * GitHub's rate limit, or a 5xx) waits as long as the server asks, or backs
 * off, and a network error is retried a few times.
 */
async function get(url, { as = 'json', headers = {} } = {}) {
  const all = { ...UA, ...(TOKEN && url.includes('api.github.com') ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers };
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { headers: all });
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok || res.status === 206) return as === 'json' ? res.json() : res.text();
    if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 8) {
      const asked = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      let wait = Number.isFinite(asked) && asked > 0 ? asked * 1000 : 2000 * 2 ** Math.min(attempt, 5);
      if (res.headers.get('x-ratelimit-remaining') === '0' && reset) wait = Math.max(wait, reset * 1000 - Date.now() + 1000);
      if (wait > 10 * 60_000) throw new Error(`${url}: rate limited for ${Math.round(wait / 60000)} minutes; set GITHUB_TOKEN and retry.`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

/** Run `fn` over `items`, `width` at a time. */
async function pool(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ----------------------------------------------------------------- names ---

/** Lower-case, & as "and", letters and digits only. */
function norm(text) {
  return String(text ?? '').toLowerCase().replace(/&amp;|&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function decode(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBrand(name) {
  let out = String(name).trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const brand of BRANDS[CLOUD]) {
      if (out.length > brand.length && out.toLowerCase().startsWith(brand.toLowerCase())) {
        out = out.slice(brand.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** A name compared as itself and without its brand. */
function forms(name) {
  const out = new Set();
  if (!name) return out;
  const a = norm(name);
  const b = norm(stripBrand(name));
  if (a) out.add(a);
  if (b) out.add(b);
  return out;
}

const TRAILING_PAREN = /^(.*\S)\s*\(([^()]+)\)\s*$/;

/**
 * The names a service answers to, in two strengths. Primary: the name, and the
 * name without a trailing "(…)". Alias: what the parentheses hold ("ECS",
 * "formerly Cloud Composer" as "Cloud Composer").
 */
function nameForms(name) {
  const primary = forms(name);
  const alias = new Set();
  const m = TRAILING_PAREN.exec(String(name));
  if (m) {
    forms(m[1]).forEach((f) => primary.add(f));
    forms(m[2].replace(/^(formerly|previously)\s+(known as\s+)?/i, '')).forEach((f) => alias.add(f));
  }
  return { primary, alias };
}

function slug(text) {
  return String(text).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
}

function sentence(text, max = 240) {
  const t = decode(text);
  if (!t) return undefined;
  const first = /^(.+?[.!?])(\s|$)/.exec(t);
  let out = first && first[1].length >= 20 ? first[1] : t;
  if (out.length > max) out = `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return out;
}

const PREVIEW = /\b(preview|beta)\b/i;
const GOVERNMENT = /\b(govcloud|government|gov|dod|sovereign|secret|top secret|classified)\b/i;

// ------------------------------------------------------ local toolkit data ---

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Terraform resources and version per provider, from the committed catalog. */
function terraformCatalog() {
  const text = read('src/terraform/catalog-data.ts');
  const re = /(\w+):\s*\{\s*source:\s*"([^"]*)",\s*version:\s*"([^"]*)",\s*resources:\s*"([^"]*)",/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== TF[CLOUD].key) continue;
    return { source: m[2], version: m[3], resources: new Set(m[4].split(',').filter(Boolean).map((r) => TF[CLOUD].prefix + r)) };
  }
  throw new Error(`src/terraform/catalog-data.ts has no "${TF[CLOUD].key}" entry`);
}

/** A `JSON.parse("…")` literal inside a generated .ts file. */
function embeddedJson(rel, constant) {
  const text = read(rel);
  const at = text.indexOf(`${constant}`);
  const open = text.indexOf('JSON.parse(', at);
  if (at < 0 || open < 0) throw new Error(`${rel}: no ${constant} JSON`);
  let i = open + 'JSON.parse('.length;
  const quote = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
  return JSON.parse(JSON.parse(text.slice(i, j + 1)));
}

/** Registry subcategory per resource from the committed schema index (fallback). */
function schemaIndexSections() {
  const index = embeddedJson('src/terraform/cloud-schema-index.ts', 'CLOUD_SCHEMA_INDEX');
  const key = { aws: 'aws', azure: 'azurerm', google: 'google', oci: 'oci' }[CLOUD];
  const entry = index[key];
  const out = new Map();
  for (const [type, value] of Object.entries(entry?.resources ?? {})) out.set(type, value[1] || null);
  return { version: entry?.version, sections: out };
}

function cloudFormationTypes() {
  const text = read('src/editor/cloudformation-schema-index.ts');
  return [...text.matchAll(/^\s*"([A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+)":/gm)].map((m) => m[1]);
}

function armTypes() {
  const index = embeddedJson('src/editor/arm-schema-index.ts', 'ARM_SCHEMA_INDEX');
  const out = new Map();
  for (const [ns, types] of Object.entries(index.types)) {
    out.set(ns, Object.keys(types).filter((t) => !t.includes('/')).map((t) => `${ns}/${t}`));
  }
  return out;
}

// ----------------------------------------------------------- the registry ---

/** Subcategory of every resource doc of the provider version the catalog is at. */
async function registrySubcategories(source, version) {
  const body = await get(`https://registry.terraform.io/v2/providers/${source}?include=provider-versions`);
  const match = (body.included ?? []).find((v) => v.attributes?.version === version);
  if (!match) throw new Error(`${source} ${version}: no such version in the registry`);
  const out = new Map();
  for (let page = 1; ; page += 1) {
    const docs = await get(
      `https://registry.terraform.io/v2/provider-docs?filter[provider-version]=${match.id}&filter[category]=resources&filter[language]=hcl&page[size]=100&page[number]=${page}`,
    );
    for (const d of docs.data ?? []) {
      const s = d.attributes.slug;
      const type = s.startsWith(TF[CLOUD].prefix) ? s : TF[CLOUD].prefix + s;
      out.set(type, d.attributes.subcategory || null);
    }
    if ((docs.data ?? []).length < 100) break;
  }
  return out;
}

// ---------------------------------------------------------------- sources ---

const SOURCES = [];
function source(id, name, url, fn) {
  return fn().then(
    (value) => {
      SOURCES.push({ id, name, url, status: 'ok', ...(value?.note ? { note: value.note } : {}) });
      return value;
    },
    (err) => {
      SOURCES.push({ id, name, url, status: 'failed', note: err instanceof Error ? err.message : String(err) });
      console.log(`  ${name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    },
  );
}

/**
 * A record is one entry of one source list:
 *   { source, name, category?, description?, ids?: string[], parent?, code? }
 * `ids` are identifiers (not names) used only for the second matching tier.
 */

// --- AWS ---

const AWS_DOCS = 'https://docs.aws.amazon.com/en_us/main-landing-page.xml';
const AWS_PRICE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json';
const BOTOCORE = 'boto/botocore';

async function awsDocs() {
  const xml = await get(AWS_DOCS, { as: 'text' });
  const records = [];
  const skipCards = new Set(['featured-content', 'DocsCategory-decisionguides', 'DocsCategory-generalreference', 'sdks']);
  for (const card of xml.matchAll(/<list-card id="([^"]+)">\s*<title>([\s\S]*?)<\/title>([\s\S]*?)<\/list-card>/g)) {
    if (skipCards.has(card[1]) || !card[1].startsWith('DocsCategory-')) continue;
    const category = decode(card[2]);
    for (const item of card[3].matchAll(/<list-card-item([^>]*)>\s*<title>([\s\S]*?)<\/title>(?:\s*<abstract>([\s\S]*?)<\/abstract>)?/g)) {
      const href = /href="([^"]*)"/.exec(item[1])?.[1] ?? '';
      if (href.includes('/decision-guides/')) continue; // "Choosing an AWS … service" guides
      const name = decode(item[2]);
      const docSlug = /^\/([^/?#]+)/.exec(href)?.[1];
      records.push({ source: 'aws-docs', name, category, description: item[3] ? sentence(item[3]) : undefined, ids: [], mergeIds: docSlug ? [docSlug] : [] });
    }
  }
  if (records.length < 100) throw new Error(`only ${records.length} services parsed; the page layout may have changed`);
  // A service listed under several headings takes the first one, except that
  // "Serverless" is a cross-listing (S3, DynamoDB, API Gateway are there as
  // well as under their own heading), so another heading wins over it.
  const cats = new Map();
  for (const r of records) {
    if (!cats.has(r.name)) cats.set(r.name, []);
    cats.get(r.name).push(r.category);
  }
  for (const r of records) {
    const list = cats.get(r.name);
    r.category = list.find((c) => norm(c) !== 'serverless') ?? list[0];
  }
  return { records };
}

async function awsPriceList() {
  const index = await get(AWS_PRICE);
  const codes = Object.keys(index.offers ?? {}).sort();
  let unnamed = 0;
  const records = await pool(codes, 8, async (code) => {
    const url = `https://pricing.us-east-1.amazonaws.com${index.offers[code].currentVersionUrl}`;
    let name = null;
    // The official name is each product's `servicename` attribute; the first
    // product is near the top, so a few KB is enough (EC2's whole file is GBs).
    for (const bytes of [16_000, 128_000]) {
      try {
        const head = await get(url, { as: 'text', headers: { Range: `bytes=0-${bytes}` } });
        name = /"servicename"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? null;
        if (name) break;
      } catch {
        break;
      }
    }
    if (!name) unnamed += 1;
    const bare = code.replace(/^(Amazon|AWS)/, '');
    return { source: 'aws-price-list', name: name ?? code, code, nameFromCode: !name, ids: [bare] };
  });
  return { records, note: unnamed ? `${unnamed} offer(s) carry no servicename; their offer code is used as the name` : undefined };
}

async function awsBotocore() {
  const commit = await get(`https://api.github.com/repos/${BOTOCORE}/commits/develop`);
  const sha = commit.sha;
  const dataDir = (await get(`https://api.github.com/repos/${BOTOCORE}/contents/botocore?ref=${sha}`)).find((e) => e.name === 'data');
  const tree = await get(`https://api.github.com/repos/${BOTOCORE}/git/trees/${dataDir.sha}?recursive=1`);
  const latest = new Map();
  for (const e of tree.tree ?? []) {
    const m = /^([^/]+)\/([^/]+)\/service-2\.json$/.exec(e.path);
    if (!m) continue;
    if (!latest.has(m[1]) || latest.get(m[1]) < m[2]) latest.set(m[1], m[2]);
  }
  const services = [...latest.keys()].sort();
  const records = await pool(services, 8, async (svc) => {
    const url = `https://raw.githubusercontent.com/${BOTOCORE}/${sha}/botocore/data/${svc}/${latest.get(svc)}/service-2.json`;
    const head = await get(url, { as: 'text', headers: { Range: 'bytes=0-4000' } });
    const field = (k) => new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`).exec(head)?.[1];
    const fullName = field('serviceFullName') ?? svc;
    const abbreviation = field('serviceAbbreviation');
    const serviceId = field('serviceId');
    return {
      source: 'botocore',
      name: fullName,
      abbreviation,
      ids: [svc, svc.replace(/-/g, ''), serviceId].filter(Boolean),
      code: svc,
    };
  });
  return { records, commit: sha, note: `commit ${sha}` };
}

// --- Azure ---

const AZURE_LEARN = 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/azure-services-resource-providers';
const AZURE_PRICES = 'https://prices.azure.com/api/retail/prices';

async function azureLearn() {
  const html = await get(AZURE_LEARN, { as: 'text' });
  const records = [];
  /** namespace (lower case) → service names */
  const namespaces = new Map();
  let category = '';
  for (const m of html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>|<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
    if (m[1]) {
      category = decode(m[1]).replace(/\s*resource providers$/i, '');
      continue;
    }
    const ns = decode(m[2]).replace(/\s+-\s+.*$/, '').trim();
    if (!/^[A-Za-z0-9]+(\.[A-Za-z0-9]+)+$/.test(ns)) continue;
    // One service per line; a line of links ("A and B") is one service per
    // link; a "Note:" that follows is commentary, not a service.
    const cell = m[3].split(/<strong>\s*Note\b/i)[0];
    const names = cell
      .split(/<br\s*\/?>/i)
      .flatMap((line) => {
        const links = [...line.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((a) => decode(a[1]));
        return links.length ? links : [decode(line)];
      })
      .filter(Boolean);
    for (const name of names) records.push({ source: 'azure-learn', name, category, namespace: ns });
    namespaces.set(ns.toLowerCase(), names);
  }
  if (records.length < 100) throw new Error(`only ${records.length} rows parsed; the page layout may have changed`);
  // A namespace is an identifier of its service only when it has one service.
  for (const r of records) {
    const names = namespaces.get(r.namespace.toLowerCase());
    r.ids = [r.namespace, r.namespace.replace(/^Microsoft\./i, '')];
    r.sharedNamespace = names.length > 1;
  }
  return { records, namespaces };
}

async function azurePrices() {
  const base = `${AZURE_PRICES}?api-version=2023-01-01-preview&$filter=`;
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  const starts = (p) => `startswith(serviceName, ${quote(p)})`;
  let requests = 0;
  const q = (clauses) => {
    requests += 1;
    return get(base + encodeURIComponent(clauses.join(' and ')));
  };
  /*
   * The API has no "distinct", and paging every price is hundreds of requests
   * of 1,000 items. So the names are found by asking, per first letter, for
   * any price whose service is not one already seen; each answer names at
   * least one new service, and an empty answer means none is left. The API
   * refuses a filter of more than about 20 clauses, so a prefix with more
   * services than that is split by its next character. Names are expected to
   * start with a letter or digit and to use letters, digits, spaces and common
   * punctuation (ALPHABET; not the apostrophe, which the API's filter parser
   * rejects); a name with any other character would be missed.
   */
  const MAX_EXCLUDED = 15;
  const byName = new Map(); // serviceName → Map(family → count)
  const note = (items) => {
    const fresh = [];
    for (const it of items) {
      if (!it.serviceName) continue;
      if (!byName.has(it.serviceName)) {
        byName.set(it.serviceName, new Map());
        fresh.push(it.serviceName);
      }
      const counts = byName.get(it.serviceName);
      if (it.serviceFamily) counts.set(it.serviceFamily, (counts.get(it.serviceFamily) ?? 0) + 1);
    }
    return fresh;
  };
  /** Every service name matching `clauses`, or null when there are more than MAX_EXCLUDED. */
  async function drain(clauses) {
    const known = new Set();
    for (;;) {
      if (known.size > MAX_EXCLUDED) return null;
      const page = await q([...clauses, ...[...known].map((n) => `serviceName ne ${quote(n)}`)]);
      const items = page.Items ?? [];
      if (items.length === 0) return known;
      note(items);
      const names = new Set(items.map((i) => i.serviceName).filter(Boolean));
      const fresh = [...names].filter((n) => !known.has(n));
      if (fresh.length === 0) throw new Error(`the Retail Prices API ignored an exclusion filter (${clauses.join(' and ')})`);
      fresh.forEach((n) => known.add(n));
    }
  }
  const ALPHABET = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -._()&+/,@:"];
  async function explore(prefix) {
    if (await drain([starts(prefix)])) return;
    // Too many under this prefix: the name that is the prefix itself, then
    // one level down for every character a name can go on with. A character
    // no name has costs one small empty answer.
    await drain([`serviceName eq ${quote(prefix)}`]);
    for (const c of ALPHABET) await explore(prefix + c);
  }
  await pool(ALPHABET.filter((c) => /[A-Za-z0-9]/.test(c)), 4, (c) => explore(c));
  const records = [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, counts]) => {
    // A name billed under more than one family takes the one most of its prices were seen in.
    const family = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    return { source: 'azure-retail-prices', name, category: family, ids: [] };
  });
  return { records, note: `${records.length} distinct service names from ${requests} filtered queries (names starting with a letter or digit)` };
}

// --- Google Cloud ---

const GOOGLE_SUMMARY = 'https://cloud.google.com/terms/services';
const GOOGLE_DISCOVERY = 'https://www.googleapis.com/discovery/v1/apis?preferred=true';

async function googleSummary() {
  const html = await get(GOOGLE_SUMMARY, { as: 'text' });
  const records = [];
  const heads = [...html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)];
  for (let h = 0; h < heads.length; h += 1) {
    const category = decode(heads[h][1]);
    if (/services summary$/i.test(category) && !/secops/i.test(category)) continue;
    const body = html.slice(heads[h].index, h + 1 < heads.length ? heads[h + 1].index : undefined);
    let parent;
    for (const m of body.matchAll(/<(p|li)[^>]*>([\s\S]*?)<\/\1>/g)) {
      const inner = m[2];
      const b = /^\s*<b>([\s\S]*?)<\/b>\s*(?::|<b>\s*:\s*<\/b>)?([\s\S]*)$/.exec(inner);
      if (!b) continue;
      // "*" marks services not for resale; it is not part of the name.
      const name = decode(b[1]).replace(/^\*+|\*+$/g, '').replace(/[:.]$/, '').trim();
      if (!name || name.length > 140) continue;
      const rest = decode(b[2]).replace(/^[:.\s]+/, '');
      // A bold line with nothing after it is a sub-heading ("AI Solutions"), not a service.
      if (!rest) continue;
      if (m[1] === 'p') parent = name;
      records.push({
        source: 'google-services-summary',
        name,
        category,
        description: rest ? sentence(rest) : undefined,
        ...(m[1] === 'li' && parent ? { parent } : {}),
        ids: [],
      });
    }
  }
  if (records.length < 100) throw new Error(`only ${records.length} services parsed; the page layout may have changed`);
  // One service listed under two headings is one service; the first heading wins.
  const seen = new Set();
  return { records: records.filter((r) => (seen.has(r.name) ? false : (seen.add(r.name), true))) };
}

async function googleDiscovery() {
  const body = await get(GOOGLE_DISCOVERY);
  const records = (body.items ?? [])
    .filter((i) => /^https?:\/\/cloud\.google\.com\//.test(i.documentationLink ?? ''))
    .map((i) => ({
      source: 'google-discovery',
      name: i.title,
      alsoNames: [i.title.replace(/\s+API$/, '')],
      description: sentence(i.description),
      ids: [i.name],
      code: i.id,
    }));
  return { records, note: `${records.length} of ${(body.items ?? []).length} APIs are documented on cloud.google.com` };
}

// --- OCI ---

const OCI_PRICES = 'https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/';
/** The OCI API reference's own list of APIs: name → service key (core, objectstorage, adm…). */
const OCI_APIS = 'https://docs.oracle.com/iaas/tools/service_names_mapping.json';
const OCI_API_SPECS = 'https://docs.oracle.com/en-us/iaas/api/specs/index.json';

async function ociPrices() {
  const body = await get(OCI_PRICES);
  const byCategory = new Map();
  for (const item of body.items ?? []) {
    if (!item.serviceCategory) continue;
    byCategory.set(item.serviceCategory, (byCategory.get(item.serviceCategory) ?? 0) + 1);
  }
  // serviceCategory is "Group - Service" (Storage - Object Storage), or
  // "Service - Group" (Cloud Guard - Security), or just the service. A part
  // that is one of Oracle's groups is the category; the rest is a name.
  const groups = CATEGORY_MAP.oci;
  const records = [...byCategory.keys()].sort().map((sc) => {
    const parts = sc.split(/\s+-\s+/);
    let group = null;
    let rest = parts;
    if (parts.length > 1 && groups[norm(parts[0])]) [group, rest] = [parts[0], parts.slice(1)];
    else if (parts.length > 1 && groups[norm(parts[parts.length - 1])]) [group, rest] = [parts[parts.length - 1], parts.slice(0, -1)];
    const alias = parts.length > 1 && rest.length ? rest.join(' - ') : null;
    return { source: 'oci-price-list', name: sc, category: group, alsoNames: alias ? [alias] : [], ids: [] };
  });
  return { records, note: `${(body.items ?? []).length} price-list products in ${records.length} service categories` };
}

async function ociApis() {
  const body = await get(OCI_APIS);
  // Descriptions, by API title, from the same reference's spec index; only a
  // nicety, so the list stands without it.
  const described = new Map();
  let note;
  try {
    const specs = await get(OCI_API_SPECS);
    for (const v of Object.values(specs)) if (v?.toc_title && v.description) described.set(v.toc_title, v.description.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
  } catch (err) {
    note = `descriptions not read: ${err.message}`;
  }
  const records = Object.entries(body)
    .filter(([name, id]) => typeof id === 'string' && name)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, id]) => ({
      source: 'oci-api-reference',
      name,
      alsoNames: [name.replace(/\s+APIs?$/, '')],
      description: described.has(name) ? sentence(described.get(name)) : undefined,
      ids: [id],
      code: id,
    }));
  if (records.length < 50) throw new Error(`only ${records.length} APIs listed`);
  return { records, note };
}

// ---------------------------------------------------------------- merging ---

/**
 * A record's names and identifiers:
 *   primary  its name (and the name without a trailing "(…)"), and alsoNames
 *            (the same name as another list writes it: "Compute Engine API"
 *            as "Compute Engine")
 *   alias    what trailing parentheses hold, and the abbreviation a list gives
 *   ids      identifiers used for matching and merging (botocore service,
 *            price-list offer code without its brand, API name, namespace)
 *   mergeIds identifiers used only to merge lists (the AWS docs URL path)
 */
function recordKeys(r) {
  const { primary, alias } = nameForms(r.name);
  const whole = forms(r.name);
  for (const n of r.alsoNames ?? []) {
    forms(n).forEach((x) => whole.add(x));
    const f = nameForms(n);
    f.primary.forEach((x) => primary.add(x));
    f.alias.forEach((x) => alias.add(x));
  }
  if (r.abbreviation) {
    const f = nameForms(r.abbreviation);
    [...f.primary, ...f.alias].forEach((x) => alias.add(x));
  }
  const ids = new Set((r.sharedNamespace ? [] : r.ids ?? []).map(norm).filter(Boolean));
  const mergeIds = new Set((r.mergeIds ?? []).map(norm).filter(Boolean));
  return { whole, primary, alias, ids, mergeIds };
}

/**
 * Services are built from the records in source order. A record joins an
 * existing service when exactly one answers, trying in turn: the same exact
 * name; a primary name; any name; an identifier. When none answers, or more
 * than one at the first step that finds any, it starts a service of its own.
 * Past the exact-name step, a record never joins a service that already holds
 * a differently named record of its own list: the list says they differ.
 */
function mergeRecords(records) {
  const services = [];
  const index = { exact: new Map(), primary: new Map(), any: new Map(), id: new Map() };
  const put = (map, k, s) => {
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(s);
  };
  for (const r of records) {
    const keys = recordKeys(r);
    const eligible = (s) => !s.records.some((x) => x.source === r.source) || s.records.some((x) => x.source === r.source && x.name === r.name);
    const lookup = (map, ks, any = false) => {
      const hits = new Set();
      for (const k of ks) for (const s of map.get(k) ?? []) if (any || eligible(s)) hits.add(s);
      return [...hits];
    };
    let target = null;
    for (const [map, ks, any] of [
      [index.exact, [norm(r.name)], true],
      [index.primary, keys.primary],
      [index.any, [...keys.primary, ...keys.alias]],
      [index.id, [...keys.ids, ...keys.mergeIds]],
    ]) {
      const hits = lookup(map, ks, any);
      if (hits.length === 1) target = hits[0];
      if (hits.length > 0) break;
    }
    if (!target) {
      target = { records: [], whole: new Set(), primary: new Set(), alias: new Set(), ids: new Set() };
      services.push(target);
    }
    target.records.push(r);
    put(index.exact, norm(r.name), target);
    keys.whole.forEach((k) => target.whole.add(k));
    for (const k of keys.primary) {
      target.primary.add(k);
      put(index.primary, k, target);
      put(index.any, k, target);
    }
    for (const k of keys.alias) {
      target.alias.add(k);
      put(index.any, k, target);
    }
    for (const k of keys.ids) {
      target.ids.add(k);
      put(index.id, k, target);
    }
    for (const k of keys.mergeIds) put(index.id, k, target);
  }
  return services;
}

/** Name form / identifier → the services that answer to it, per strength. */
function keyIndex(services) {
  const whole = new Map();
  const primary = new Map();
  const alias = new Map();
  const ids = new Map();
  const put = (map, k, s) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(s);
  };
  for (const s of services) {
    for (const f of s.whole) put(whole, f, s);
    for (const f of s.primary) put(primary, f, s);
    for (const f of s.alias) put(alias, f, s);
    for (const f of s.ids) put(ids, f, s);
    // A namespace shared by several services still points at all of them, so
    // a match on it is reported as ambiguous rather than missed.
    for (const r of s.records) if (r.sharedNamespace) for (const id of r.ids) put(ids, norm(id), s);
  }
  return { whole, primary, alias, ids };
}

/**
 * The one service a registry subcategory or namespace names. `groups` are
 * candidate names in order of precedence: the name itself first, then what
 * its parentheses hold. Within a group: whole names, then names without a
 * trailing "(…)", then aliases, then identifiers. The first step that finds anything decides: one service is a
 * match; more than one is ambiguous, and is reported, not picked from.
 */
function matchService(index, groups) {
  for (const candidates of groups) {
    const keys = new Set(candidates.flatMap((c) => [...forms(c)]));
    for (const [tier, map] of [['name', index.whole], ['name', index.primary], ['alias', index.alias], ['identifier', index.ids]]) {
      const hits = new Set();
      for (const k of keys) for (const s of map.get(k) ?? []) hits.add(s);
      if (hits.size === 1) return { service: [...hits][0], tier };
      if (hits.size > 1) return { ambiguous: [...hits], tier };
    }
  }
  return null;
}

/**
 * The names a registry subcategory can be read as, in precedence: itself,
 * "X" of "X (Y)", "Cloud (Stackdriver) Logging" without its aside, and each
 * without a trailing version or "API" ("Cloud Build v2"); then "Y". The
 * registry writes "Name (qualifier)", so the name decides when both match.
 */
function subcategoryCandidates(sub) {
  const first = new Set([sub]);
  const second = new Set();
  const m = TRAILING_PAREN.exec(sub);
  if (m) {
    first.add(m[1]);
    second.add(m[2]);
  }
  const aside = /^(.*\S)\s*\([^()]+\)\s*(\S.*)$/.exec(sub);
  if (aside) first.add(`${aside[1]} ${aside[2]}`);
  for (const set of [first, second]) {
    for (const x of [...set]) {
      const bare = x.replace(/(\s+API)?(\s+v\d+)?(\s+API)?\s*$/i, '').trim();
      if (bare && bare !== x) set.add(bare);
    }
  }
  return [[...first], [...second]];
}

// ------------------------------------------------------------------- main ---

const LABEL = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI' }[CLOUD];
console.log(`Cloud service catalog: ${LABEL}`);

const primary = []; // record lists, in merge order
const official = new Set(); // sources that are the provider's own service list

if (CLOUD === 'aws') {
  const docs = await source('aws-docs', 'AWS documentation product list', AWS_DOCS, awsDocs);
  const price = await source('aws-price-list', 'AWS Price List offer index (names from each offer file)', AWS_PRICE, awsPriceList);
  const boto = await source('botocore', 'botocore service models (serviceFullName)', `https://github.com/${BOTOCORE}/tree/develop/botocore/data`, awsBotocore);
  if (boto?.commit) SOURCES.find((s) => s.id === 'botocore').url = `https://github.com/${BOTOCORE}/tree/${boto.commit}/botocore/data`;
  for (const x of [docs, price, boto]) if (x) primary.push(...x.records);
  official.add('aws-docs').add('aws-price-list');
} else if (CLOUD === 'azure') {
  const learn = await source('azure-learn', 'Microsoft Learn: resource providers for Azure services', AZURE_LEARN, azureLearn);
  const prices = await source('azure-retail-prices', 'Azure Retail Prices API (serviceName, serviceFamily)', AZURE_PRICES, azurePrices);
  for (const x of [learn, prices]) if (x) primary.push(...x.records);
  official.add('azure-learn').add('azure-retail-prices');
} else if (CLOUD === 'google') {
  const summary = await source('google-services-summary', 'Google Cloud Services Summary', GOOGLE_SUMMARY, googleSummary);
  const discovery = await source('google-discovery', 'Google APIs Discovery directory (cloud.google.com APIs)', GOOGLE_DISCOVERY, googleDiscovery);
  for (const x of [summary, discovery]) if (x) primary.push(...x.records);
  official.add('google-services-summary');
} else {
  const prices = await source('oci-price-list', 'Oracle Cloud price-list API (serviceCategory)', OCI_PRICES, ociPrices);
  const apis = await source('oci-api-reference', 'OCI API reference service list (API name, service key)', OCI_APIS, ociApis);
  for (const x of [prices, apis]) if (x) primary.push(...x.records);
  official.add('oci-price-list');
}

// A catalog built from part of the lists would quietly drop services, so a
// list that could not be read leaves the committed file as it is.
if (primary.length === 0 || SOURCES.some((s) => s.status === 'failed')) {
  console.error(`\nNot every service list could be read; src/cloud/service-catalog-${CLOUD}.ts was left as it is.`);
  process.exit(1);
}
/** Distinct names in the provider's own lists; each must survive as a service name or alias. */
const officialCount = new Set(primary.filter((r) => official.has(r.source)).map((r) => r.name)).size;

const groups = mergeRecords(primary);

// --- Terraform ---
const tf = terraformCatalog();
const registry = await source(
  'terraform-registry',
  `Terraform Registry docs subcategories (${tf.source} ${tf.version})`,
  `https://registry.terraform.io/providers/${tf.source}/${tf.version}/docs`,
  () => registrySubcategories(tf.source, tf.version).then((map) => ({ map })),
);
let subcategoryOf = registry?.map;
if (!subcategoryOf) SOURCES.find((s) => s.id === 'terraform-registry').status = 'unavailable';
if (!subcategoryOf) {
  const fallback = schemaIndexSections();
  subcategoryOf = fallback.sections;
  SOURCES.push({
    id: 'terraform-schema-index',
    name: `Registry subcategories as committed in src/terraform/cloud-schema-index.ts (${tf.source} ${fallback.version})`,
    url: `https://registry.terraform.io/providers/${tf.source}/${fallback.version}/docs`,
    status: 'ok',
    note: 'used because the registry could not be read',
  });
}

const unmatched = [];
const bySub = new Map(); // subcategory → resource types
const noSubcategory = [];
for (const type of [...tf.resources].sort()) {
  const sub = subcategoryOf.get(type);
  if (!subcategoryOf.has(type)) noSubcategory.push({ type, why: 'no registry documentation page' });
  else if (!sub || /^other$/i.test(sub)) noSubcategory.push({ type, why: sub ? 'registry subcategory "Other"' : 'no registry subcategory' });
  else {
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(type);
  }
}
const notInCatalog = [...subcategoryOf.keys()].filter((t) => !tf.resources.has(t)).length;

const index = keyIndex(groups);
const tfOf = new Map(); // group → Set(type)
const registryOnly = [];
for (const sub of [...bySub.keys()].sort()) {
  const types = bySub.get(sub);
  const m = matchService(index, subcategoryCandidates(sub));
  if (m?.service) {
    if (!tfOf.has(m.service)) tfOf.set(m.service, new Set());
    types.forEach((t) => tfOf.get(m.service).add(t));
    continue;
  }
  const reason = m?.ambiguous
    ? `ambiguous: its ${m.tier} matches ${m.ambiguous.length} services (${m.ambiguous.map(displayName).sort().join('; ')})`
    : "no service in the provider's list has this name or abbreviation";
  unmatched.push({ kind: 'terraform-subcategory', name: sub, reason, count: types.length });
  registryOnly.push({ sub, types, candidates: m?.ambiguous ?? [] });
}
if (noSubcategory.length) {
  const whys = new Map();
  for (const n of noSubcategory) whys.set(n.why, (whys.get(n.why) ?? 0) + 1);
  for (const [why, count] of [...whys.entries()].sort()) {
    unmatched.push({
      kind: 'terraform-resource',
      name: `(${why})`,
      reason: 'the registry does not say which service these resources belong to',
      count,
      items: noSubcategory.filter((n) => n.why === why).map((n) => n.type),
    });
  }
}

// --- CloudFormation ---
const cfnOf = new Map();
if (CLOUD === 'aws') {
  const byNs = new Map();
  for (const t of cloudFormationTypes()) {
    const ns = t.split('::').slice(0, 2).join('::');
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(t);
  }
  for (const ns of [...byNs.keys()].sort()) {
    const types = byNs.get(ns);
    const [vendor, svc] = ns.split('::');
    const m = vendor === 'AWS' ? matchService(index, [[svc]]) : null;
    if (m?.service) {
      if (!cfnOf.has(m.service)) cfnOf.set(m.service, new Set());
      types.forEach((t) => cfnOf.get(m.service).add(t));
    } else {
      unmatched.push({
        kind: 'cloudformation-namespace',
        name: ns,
        reason:
          vendor !== 'AWS'
            ? 'not an AWS:: namespace'
            : m?.ambiguous
              ? `ambiguous: its ${m.tier} matches ${m.ambiguous.length} services (${m.ambiguous.map(displayName).sort().join('; ')})`
              : 'no service in the list has this name or identifier',
        count: types.length,
      });
    }
  }
}

// --- ARM ---
const armOf = new Map();
if (CLOUD === 'azure') {
  const learnByNs = new Map();
  for (const g of groups) for (const r of g.records) if (r.namespace) {
    const k = r.namespace.toLowerCase();
    if (!learnByNs.has(k)) learnByNs.set(k, new Set());
    learnByNs.get(k).add(g);
  }
  for (const [ns, types] of [...armTypes().entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (types.length === 0) continue;
    const listed = learnByNs.get(ns.toLowerCase());
    let target = null;
    let reason = null;
    if (listed?.size === 1) target = [...listed][0];
    else if (listed && listed.size > 1) reason = `Microsoft Learn lists this namespace under ${listed.size} services (${[...listed].map(displayName).sort().join('; ')}); its types are not split by guesswork`;
    else {
      const m = matchService(index, [[ns.replace(/^Microsoft\./i, '')]]);
      if (m?.service) target = m.service;
      else reason = m?.ambiguous
        ? `ambiguous: its ${m.tier} matches ${m.ambiguous.length} services (${m.ambiguous.map(displayName).sort().join('; ')})`
        : 'not in the Microsoft Learn table, and no service has this name';
    }
    if (target) {
      if (!armOf.has(target)) armOf.set(target, new Set());
      types.forEach((t) => armOf.get(target).add(t));
    } else unmatched.push({ kind: 'arm-namespace', name: ns, reason, count: types.length });
  }
}

// --- the services ---

function displayName(g) {
  return g.records[0].name;
}

const unmappedCategories = new Set();
function commonCategory(providerCategory) {
  if (!providerCategory) return 'other';
  let key = norm(providerCategory);
  const map = CATEGORY_MAP[CLOUD];
  if (map[key]) return map[key];
  // OCI's "Compute - GPU": the group before the dash.
  const group = norm(String(providerCategory).split(/\s+-\s+/)[0]);
  if (map[group]) return map[group];
  unmappedCategories.add(providerCategory);
  return 'other';
}

const out = [];
const usedIds = new Set();
function uniqueId(base, extra) {
  let id = slug(base);
  if (usedIds.has(id) && extra) id = `${id}-${slug(extra)}`;
  for (let n = 2; usedIds.has(id); n += 1) id = `${slug(base)}-${n}`;
  usedIds.add(id);
  return id;
}

// Official names first, so their ids are the plain slugs.
const ordered = [...groups].sort((a, b) => {
  const oa = a.records.some((r) => official.has(r.source)) ? 0 : 1;
  const ob = b.records.some((r) => official.has(r.source)) ? 0 : 1;
  return oa - ob || displayName(a).localeCompare(displayName(b)) || a.records[0].source.localeCompare(b.records[0].source);
});
const idOf = new Map();
for (const g of ordered) idOf.set(g, uniqueId(displayName(g), g.records[0].code ?? g.records[0].source));

function build(g) {
  const name = displayName(g);
  const providerCategory = g.records.map((r) => r.category).find(Boolean) ?? null;
  const description = g.records.map((r) => r.description).find(Boolean);
  const terraform = [...(tfOf.get(g) ?? [])].sort();
  const cloudformation = [...(cfnOf.get(g) ?? [])].sort();
  const arm = [...(armOf.get(g) ?? [])].sort();
  // The namespace Microsoft Learn lists the service under, even when it shares
  // it with others and so has no ARM types of its own here.
  const namespaces = [...new Set(g.records.map((r) => r.namespace).filter(Boolean))].sort();
  const verified = g.records.some((r) => official.has(r.source));
  const names = [...new Set(g.records.map((r) => r.name))].filter((n) => n !== name).sort();
  const parent = g.records.find((r) => r.parent)?.parent;
  const preview = PREVIEW.test(name);
  const government = GOVERNMENT.test(name);
  const buildable = terraform.length ? 'terraform' : cloudformation.length || arm.length ? 'native' : 'none';
  const svc = {
    id: idOf.get(g),
    name,
    category: commonCategory(providerCategory),
    providerCategory,
    ...(description ? { description } : {}),
    terraform,
    ...(CLOUD === 'aws' ? { cloudformation } : {}),
    ...(CLOUD === 'azure' ? { arm } : {}),
    ...(namespaces.length ? { armNamespaces: namespaces } : {}),
    buildable,
    ...(buildable === 'none' && preview ? { reason: 'preview' } : {}),
    source: [...new Set(g.records.map((r) => r.source))].sort(),
    verified,
    ...(verified ? {} : { note: "not in the provider's service list; only in its API directory" }),
    ...(names.length ? { aka: names } : {}),
    ...(parent && parent !== name ? { parent } : {}),
    ...(preview ? { preview: true } : {}),
    ...(government ? { government: true } : {}),
  };
  return svc;
}

for (const g of ordered) out.push(build(g));

for (const r of registryOnly) {
  // A subcategory whose candidates all sit in one category takes it.
  const cats = new Set(r.candidates.map((g) => build(g).category));
  const category = cats.size === 1 ? [...cats][0] : 'other';
  out.push({
    id: uniqueId(r.sub, 'terraform'),
    name: r.sub,
    category,
    providerCategory: null,
    terraform: [...r.types].sort(),
    ...(CLOUD === 'aws' ? { cloudformation: [] } : {}),
    ...(CLOUD === 'azure' ? { arm: [] } : {}),
    buildable: 'terraform',
    source: ['terraform-registry'],
    verified: false,
    note: "not in the provider's service list; a Terraform registry subcategory",
  });
}

out.sort((a, b) => a.id.localeCompare(b.id));
unmatched.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
SOURCES.sort((a, b) => a.id.localeCompare(b.id));

// ------------------------------------------------------------------ write ---

const constant = `SERVICE_CATALOG_${CLOUD.toUpperCase()}`;
const summary = {
  services: out.length,
  officialListed: officialCount,
  withTerraform: out.filter((s) => s.terraform.length).length,
  withoutTerraform: out.filter((s) => !s.terraform.length).length,
  terraformResourcesMapped: out.reduce((n, s) => n + s.terraform.length, 0),
  terraformResourcesUnmapped: noSubcategory.length,
  registryOnlyServices: registryOnly.length,
  unmatchedSubcategories: unmatched.filter((u) => u.kind === 'terraform-subcategory').length,
  ...(CLOUD === 'aws' ? { cloudformationMapped: out.reduce((n, s) => n + s.cloudformation.length, 0) } : {}),
  ...(CLOUD === 'azure' ? { armMapped: out.reduce((n, s) => n + s.arm.length, 0) } : {}),
  registryDocsNotInCatalog: notInCatalog,
};

const lines = [];
lines.push(`/**`);
lines.push(` * ${LABEL} service catalog — GENERATED, do not edit by hand.`);
lines.push(` *`);
lines.push(` * Written by tools/fetch-service-catalog.mjs --cloud ${CLOUD}; read through`);
lines.push(` * ./service-catalog.ts. Refresh with update.bat, area L (Cloud services).`);
lines.push(` */`);
lines.push('');
lines.push(`import type { CloudCatalogData } from './service-catalog.ts';`);
lines.push('');
lines.push(`export const ${constant}: CloudCatalogData = {`);
lines.push(`  cloud: ${JSON.stringify(CLOUD)},`);
lines.push(`  fetched: ${JSON.stringify(TODAY)},`);
lines.push(`  terraform: ${JSON.stringify({ source: tf.source, version: tf.version })},`);
lines.push(`  sources: [`);
for (const s of SOURCES) lines.push(`    ${JSON.stringify(s)},`);
lines.push(`  ],`);
lines.push(`  summary: ${JSON.stringify(summary)},`);
lines.push(`  unmappedCategories: ${JSON.stringify([...unmappedCategories].sort())},`);
lines.push(`  unmatched: [`);
for (const u of unmatched) lines.push(`    ${JSON.stringify(u)},`);
lines.push(`  ],`);
lines.push(`  services: [`);
for (const s of out) lines.push(`    ${JSON.stringify(s)},`);
lines.push(`  ],`);
lines.push(`};`);
lines.push('');

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, `service-catalog-${CLOUD}.ts`);
writeFileSync(file, lines.join('\n'));

console.log(`  sources: ${SOURCES.map((s) => `${s.id} ${s.status}`).join(', ')}`);
console.log(`  ${summary.services} services (${officialCount} in the provider's own list)`);
console.log(`  ${summary.withTerraform} with Terraform resources, ${summary.withoutTerraform} without`);
console.log(`  ${summary.terraformResourcesMapped} Terraform resources mapped, ${summary.terraformResourcesUnmapped} with no subcategory`);
console.log(`  ${summary.unmatchedSubcategories} registry subcategories not in the provider's list (kept as services of their own)`);
if (summary.cloudformationMapped !== undefined) console.log(`  ${summary.cloudformationMapped} CloudFormation types mapped`);
if (summary.armMapped !== undefined) console.log(`  ${summary.armMapped} ARM types mapped`);
if (unmappedCategories.size) console.log(`  provider categories with no common category: ${[...unmappedCategories].sort().join('; ')}`);
console.log(`Wrote src/cloud/service-catalog-${CLOUD}.ts`);
if (SOURCES.some((s) => s.status === 'failed')) {
  console.log('Some sources failed (see above); what could be read was written.');
}

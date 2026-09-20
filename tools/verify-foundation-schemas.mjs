#!/usr/bin/env node
/**
 * Check the network foundations against each provider's published schema.
 *
 * The resource catalog answers "does this type exist". It does not answer "does
 * this type take this argument", and that is the failure that costs an
 * afternoon: a configuration that initialises, plans, and then rejects an
 * argument name that was right two major versions ago.
 *
 * So this runs the foundation emitters, parses the HCL they actually produce,
 * and checks every argument name against the resource's own documentation in
 * the Terraform Registry for the current provider version. Parsing our own
 * output rather than a hand-kept list is deliberate: a list would drift from the
 * emitters the first time one changed, and a check that drifts is worse than no
 * check.
 *
 *   npm run verify:schemas
 *
 * Needs network access to registry.terraform.io. Nothing else.
 *
 * Two kinds of result:
 *
 *   UNDOCUMENTED   An argument the kit emits that the documentation does not
 *                  list. These are errors, and the exit code reflects them.
 *   REVIEW         A required argument the kit does not emit at the top level.
 *                  Advisory only: the registry documentation flattens nested
 *                  block requirements into the same list, so a required
 *                  argument of an optional block shows up here too. Each one
 *                  needs a human glance rather than an automatic verdict.
 */

import { emitFoundation } from '../src/terraform/index.ts';
import { PROVIDERS } from '../src/terraform/providers.ts';

/** One plan, exercised on every cloud, chosen to make each emitter do its work. */
const PLAN = {
  name: 'verify',
  cidr: '10.20.0.0/16',
  subnets: [
    { name: 'public-1', cidr: '10.20.1.0/24', public: true },
    { name: 'private-1', cidr: '10.20.2.0/24' },
  ],
  region: 'us-east-1',
  allowedIngressCidrs: ['10.0.0.0/8'],
  allowedTcpPorts: [443],
  compartmentId: 'ocid1.compartment.oc1..verify',
  datacenter: 'dc-01',
  cluster: 'cluster-01',
};

/**
 * Argument names per resource type, read out of the emitted HCL.
 *
 * The emitted format is known, so brace tracking is enough. The one thing worth
 * getting right is that `tags = {` is a map value rather than a block: its keys
 * are data, not argument names, and counting them would produce noise on every
 * resource.
 */
function argumentsByResource(hcl) {
  const found = new Map();
  const stack = [];
  let current = null;

  for (const raw of hcl.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line === '}' || line === '}]') {
      stack.pop();
      if (stack.length === 0) current = null;
      continue;
    }

    const resource = /^(resource|data)\s+"([a-z0-9_]+)"\s+"[^"]*"\s*\{$/.exec(line);
    if (resource) {
      current = resource[2];
      if (!found.has(current)) found.set(current, new Set());
      stack.push('resource');
      continue;
    }

    const assignment = /^([a-z0-9_]+)\s*=/.exec(line);
    if (assignment) {
      if (current && stack[stack.length - 1] !== 'map') found.get(current).add(assignment[1]);
      // A value that opens a brace is a map or object, and its keys are data.
      if (/=\s*\{\s*$/.test(line)) stack.push('map');
      continue;
    }

    const block = /^([a-z0-9_]+)\s*\{$/.exec(line);
    if (block) {
      if (current) found.get(current).add(block[1]);
      stack.push('block');
      continue;
    }
  }
  return found;
}

/**
 * Argument names and required argument names from a registry document.
 *
 * Both documentation styles are handled: the classic `* \`name\` - (Required)`
 * list, and the tfplugindocs `### Required` section.
 */
function parseDoc(content) {
  const documented = new Set();
  const required = new Set();

  for (const line of content.split('\n')) {
    const match = /^\s*[-*]\s+`([a-z0-9_]+)`/.exec(line);
    if (!match) continue;
    documented.add(match[1]);
    if (/\(Required/i.test(line)) required.add(match[1]);
  }

  for (const section of content.split(/^###\s+/m)) {
    if (!/^Required/i.test(section)) continue;
    for (const line of section.split('\n')) {
      const match = /^\s*[-*]\s+`([a-z0-9_]+)`/.exec(line);
      if (match) required.add(match[1]);
    }
  }

  return { documented, required };
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function latestVersionId(source) {
  const body = await json(`https://registry.terraform.io/v2/providers/${source}?include=provider-versions`);
  const versions = (body.included ?? [])
    .map((v) => ({ id: v.id, version: v.attributes.version }))
    .sort((a, b) => Number(b.id) - Number(a.id));
  if (versions.length === 0) throw new Error(`${source}: no versions listed`);
  return versions[0];
}

async function docFor(versionId, type, prefix) {
  const slug = type.startsWith(prefix) ? type.slice(prefix.length) : type;
  const list = await json(
    `https://registry.terraform.io/v2/provider-docs?filter[provider-version]=${versionId}&filter[category]=resources&filter[slug]=${slug}`,
  );
  const id = list.data?.[0]?.id;
  if (!id) return null;
  const doc = await json(`https://registry.terraform.io/v2/provider-docs/${id}`);
  return doc.data?.attributes?.content ?? null;
}

let errors = 0;
let reviews = 0;

for (const provider of PROVIDERS) {
  // VCF is generated from a specification rather than a network foundation, so
  // there is nothing here to check.
  if (provider.target === 'vcf') continue;

  const out = emitFoundation(provider.target, PLAN);
  const hcl = Object.values(out.files).join('\n');
  const resources = argumentsByResource(hcl);
  if (resources.size === 0) {
    console.log(`${provider.source}: emitted nothing to check.`);
    continue;
  }

  let version;
  try {
    version = await latestVersionId(provider.source);
  } catch (err) {
    console.log(`${provider.source}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    errors += 1;
    continue;
  }

  console.log(`\n${provider.source} ${version.version}`);
  const prefix = provider.target === 'azure' ? 'azurerm_' : `${provider.target}_`;

  for (const [type, names] of [...resources].sort()) {
    let content;
    try {
      content = await docFor(version.id, type, prefix);
    } catch (err) {
      console.log(`  ${type}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      errors += 1;
      continue;
    }
    if (content === null) {
      console.log(`  ${type}: no documentation found`);
      errors += 1;
      continue;
    }

    const { documented, required } = parseDoc(content);
    const undocumented = [...names].filter((n) => !documented.has(n)).sort();
    const notEmitted = [...required].filter((n) => !names.has(n)).sort();

    if (undocumented.length > 0) {
      errors += undocumented.length;
      console.log(`  ${type}: UNDOCUMENTED ${undocumented.join(', ')}`);
    }
    if (notEmitted.length > 0) {
      reviews += 1;
      console.log(`  ${type}: REVIEW required-but-not-emitted ${notEmitted.join(', ')}`);
    }
    if (undocumented.length === 0 && notEmitted.length === 0) {
      console.log(`  ${type}: ok (${names.size} arguments)`);
    }
  }
}

console.log('');
if (errors === 0) {
  console.log('Every argument the foundations emit is documented for the current provider version.');
} else {
  console.log(`${errors} argument(s) could not be found in the provider documentation.`);
}
if (reviews > 0) {
  console.log(
    `${reviews} resource(s) have required arguments the foundation does not set at the top level.`,
  );
  console.log(
    'The registry flattens nested block requirements into the same list, so most of these are',
  );
  console.log('required arguments of optional blocks. Each needs a look rather than a verdict.');
}
process.exit(errors === 0 ? 0 : 1);

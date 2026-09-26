/**
 * The "From an application plan" Terraform blueprints (WP-17): the set the
 * planner and WP-19 / WP-22 look up, every build and dropdown variant, the
 * catalogue check on `emits`, credentials and footprints, the landing-zone
 * contract in both modes (shared: every item standalone in one stack;
 * included: after the landing zone and compute), and dual-stack.
 *
 * `terraform validate` over the same stacks runs outside Node (see the
 * package report); these checks need nothing but Node.
 */

import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../../../kit/blueprint.ts';
import { CATALOG_DATA } from '../../catalog-data.ts';
import { CLOUD_SCHEMA_INDEX } from '../../cloud-schema-index.ts';
import { VMWARE_SCHEMA_DATA } from '../../vmware-schema-data.ts';
import { buildStack, topLevelBlocks, type StackItem } from '../../stack.ts';
import { findTerraformBlueprint } from '../index.ts';
import { PATTERN_GROUP } from './common.ts';
import { PATTERN_TERRAFORM_BLUEPRINTS, patternBlueprintsFor } from './index.ts';

const ALL = PATTERN_TERRAFORM_BLUEPRINTS;
const byId = new Map(ALL.map((b) => [b.id, b]));
const lookup = (id: string): Blueprint | undefined => byId.get(id) ?? findTerraformBlueprint(id);
const CLOUDS = ['aws', 'azure', 'google', 'oci'] as const;
const PLATFORMS = [...CLOUDS, 'vsphere'] as const;

const build = (b: Blueprint, values: BlueprintValues = {}) => b.build({ ...defaultValues(b), ...values }, 'check');

function variants(b: Blueprint): BlueprintValues[] {
  const base = defaultValues(b);
  const out: BlueprintValues[] = [base];
  for (const input of b.inputs) {
    if (input.control !== 'select') continue;
    for (const o of input.options ?? []) if (String(o.value) !== String(base[input.id])) out.push({ ...base, [input.id]: o.value });
  }
  return out;
}

const tfText = (files: Readonly<Record<string, string>>) =>
  Object.entries(files)
    .filter(([n]) => n.endsWith('.tf'))
    .map(([, t]) => t)
    .join('\n');

const KNOWN = (() => {
  const known = new Set<string>();
  for (const [target, entry] of Object.entries(CATALOG_DATA)) {
    const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
    for (const n of entry.resources.split(',')) known.add(prefix + n);
  }
  for (const provider of Object.values({ ...VMWARE_SCHEMA_DATA, ...CLOUD_SCHEMA_INDEX } as Record<string, { resources: Record<string, unknown> }>)) {
    for (const type of Object.keys(provider.resources)) known.add(type);
  }
  return known;
})();

/** The ids other packages look up (WP-6 generate, WP-19, WP-22 netsec) or the addendum names. */
const EXPECTED = [
  ...PLATFORMS.flatMap((p) => [`${p}_app_context`, `${p}_app_ingress`, `${p}_app_containers`, `${p}_app_appliance`, `${p}_mig_governance`]),
  ...CLOUDS.flatMap((p) => [`${p}_app_monitoring`, `${p}_app_serverless`, `${p}_app_static_site`, `${p}_app_file_service`, `${p}_app_sap_certified`, `${p}_app_managed_cache`, `${p}_app_managed_kafka`]),
  ...['aws', 'azure', 'google'].flatMap((p) => [`${p}_app_paas_web`, `${p}_app_file_transfer`]),
  ...['aws', 'azure', 'oci'].flatMap((p) => [`${p}_app_vdi_service`, `${p}_app_managed_messaging`]),
  'aws_app_managed_search', 'oci_app_managed_search', 'aws_app_nosql', 'azure_app_nosql', 'azure_app_sap_acss',
];

describe('pattern blueprints: the set', () => {
  it('has every blueprint, once, under "From an application plan", each on its own platform', () => {
    const ids = ALL.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of EXPECTED) expect([id, ids.includes(id)]).toEqual([id, true]);
    for (const b of ALL) {
      expect([b.id, b.group]).toEqual([b.id, PATTERN_GROUP]);
      expect([b.id, PLATFORMS.some((p) => b.id.startsWith(`${p}_`))]).toEqual([b.id, true]);
    }
    for (const p of PLATFORMS) expect(patternBlueprintsFor(p).every((b) => b.id.startsWith(`${p}_`))).toBe(true);
  });

  it('uses the ids the generator derives from tier patterns (<p>_app_<tier_pattern>)', () => {
    for (const tp of ['paas-web', 'containers', 'serverless', 'static-site', 'file-service', 'vdi-service', 'sap-certified', 'managed-messaging', 'managed-kafka', 'managed-cache', 'managed-search', 'appliance']) {
      const id = `aws_app_${tp.replace(/[^a-z0-9]+/g, '_')}`;
      expect([id, byId.has(id)]).toEqual([id, true]);
    }
  });

  it('declares the inputs the planner writes', () => {
    for (const p of CLOUDS) {
      const ids = (id: string) => byId.get(id)?.inputs.map((i) => i.id) ?? [];
      for (const i of ['app', 'criticality', 'owner', 'landing_zone_source']) {
        expect([p, i, ids(`${p}_app_context`).includes(i), ids(`${p}_app_monitoring`).includes(i)]).toEqual([p, i, true, true]);
      }
      for (const i of ['frameworks', 'security_baseline', 'residency', 'sovereignty', 'landing_zone_source']) expect([p, i, ids(`${p}_mig_governance`).includes(i)]).toEqual([p, i, true]);
      for (const i of ['exposure', 'lb', 'tls', 'waf', 'members', 'fqdns', 'listener_port']) expect([p, i, ids(`${p}_app_ingress`).includes(i)]).toEqual([p, i, true]);
    }
  });
});

describe('pattern blueprints: every build', () => {
  it('builds with its defaults, with no error, into whole top-level blocks', () => {
    for (const b of ALL) {
      const out = build(b);
      expect([b.id, (out.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.message)]).toEqual([b.id, []]);
      for (const [name, text] of Object.entries(out.files)) {
        if (!name.endsWith('.tf')) continue;
        const kinds = new Set(['terraform', 'provider', 'variable', 'locals', 'resource', 'data', 'output', 'comment']);
        const blocks = topLevelBlocks(text);
        expect([b.id, blocks.filter((x) => !kinds.has(x.kind)).map((x) => x.kind)]).toEqual([b.id, []]);
        const strays = blocks.filter((x) => x.kind === 'comment' && x.text.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('#')));
        expect([b.id, strays.length]).toEqual([b.id, 0]);
      }
    }
  });

  it('builds every dropdown variant', () => {
    for (const b of ALL) for (const v of variants(b)) expect([b.id, Object.keys(b.build(v, 'check').files).length > 0]).toEqual([b.id, true]);
  });

  it('writes only catalogued resource types, each listed in emits (the base catalogue check)', () => {
    for (const b of ALL) {
      for (const t of b.emits) expect([b.id, t, KNOWN.has(t)]).toEqual([b.id, t, true]);
      const written = new Set<string>();
      for (const v of variants(b)) for (const m of tfText(b.build(v, 'check').files).matchAll(/^resource\s+"([a-z0-9_]+)"/gm)) written.add(m[1] as string);
      for (const t of written) expect([b.id, t, b.emits.includes(t)]).toEqual([b.id, t, true]);
    }
  });

  it('never writes a credential, and every credential variable is sensitive with no default', () => {
    const literal = /\b(\w*password|passwd|\w*secret|shared_key|preshared_key|\w*_psk|private_key|access_key|client_secret|auth_token)\s*=\s*"[^"$]+"/i;
    for (const b of ALL) {
      for (const v of variants(b)) {
        for (const [name, text] of Object.entries(b.build(v, 'check').files)) {
          expect([b.id, name, literal.exec(text)?.[0] ?? null]).toEqual([b.id, name, null]);
          expect([b.id, name, /CHANGEME|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(text)]).toEqual([b.id, name, false]);
        }
        for (const block of topLevelBlocks(tfText(b.build(v, 'check').files))) {
          const n = block.labels[0] ?? '';
          if (block.kind !== 'variable' || !/password|secret|token|private_key/.test(n)) continue;
          expect([b.id, n, /sensitive\s*=\s*true/.test(block.text), /^\s*default\s*=/m.test(block.text)]).toEqual([b.id, n, true, false]);
        }
      }
    }
  });

  it('leaves no footprint and uses VCF 9.1 names', () => {
    for (const b of ALL) {
      const text = Object.values(build(b).files).join('\n').replace(/"2012-10-17"/g, '');
      expect([b.id, /\b20\d\d-\d\d-\d\d\b/.test(text), /archtoolkit|generated by/i.test(text), /\b(Aria|vRealize|ESXi)\b/.test(text)]).toEqual([b.id, false, false, false]);
      expect([b.id, /\b(Aria|vRealize|ESXi)\b/.test(b.description ?? '')]).toEqual([b.id, false]);
    }
  });
});

describe('pattern blueprints: the landing-zone contract', () => {
  it('declares var.landing_zone standalone, and reads nothing of it in a stack', () => {
    for (const b of ALL) {
      if (!b.inputs.some((i) => i.id === 'landing_zone_source')) continue;
      const alone = tfText(build(b, { landing_zone_source: 'variables' }).files);
      const stacked = tfText(build(b, { landing_zone_source: 'stack' }).files);
      expect([b.id, /^variable "landing_zone"/m.test(alone)]).toEqual([b.id, true]);
      expect([b.id, /^variable "landing_zone"/m.test(stacked), /\bvar\.landing_zone\b/.test(stacked), /^provider "/m.test(stacked)]).toEqual([b.id, false, false, false]);
      if (!b.id.endsWith('_app_context')) expect([b.id, /\blocal\.landing_zone\b/.test(stacked)]).toEqual([b.id, true]);
    }
  });

  const stackOf = (p: string, mode: 'shared' | 'included') => {
    const items: StackItem[] = [];
    if (mode === 'included' && p !== 'vsphere') {
      items.push({ id: 'lz', blueprintId: `${p}_mig_landing_zone`, label: 'landing-zone', values: {} });
      items.push({ id: 'compute', blueprintId: `${p}_mig_compute`, label: 'compute', values: { landing_zone_source: 'stack' } });
    } else if (p !== 'vsphere') items.push({ id: 'compute', blueprintId: `${p}_mig_compute`, label: 'compute', values: { landing_zone_source: 'variables' } });
    for (const app of ['shop', 'crm']) {
      for (const b of patternBlueprintsFor(p as never)) {
        const values: Record<string, string> = { app };
        if (b.inputs.some((i) => i.id === 'landing_zone_source')) values.landing_zone_source = mode === 'included' ? 'stack' : 'variables';
        items.push({ id: `${app}:${b.id}`, blueprintId: b.id, label: `${app}-${b.id.replace(/^[a-z]+_/, '')}`, values });
      }
    }
    return buildStack(items, lookup, { target: (p === 'vsphere' ? 'vsphere' : p) as never, stackName: `${p}-${mode}`, requiredVersion: '>= 1.7.0' });
  };

  it('stacks two apps per platform in both modes with no tf.stack warning or error', () => {
    for (const p of PLATFORMS) {
      for (const mode of ['shared', 'included'] as const) {
        const stack = stackOf(p, mode);
        const bad = stack.findings.filter((f) => f.code.startsWith('tf.stack.') && f.severity !== 'info');
        expect([p, mode, bad.map((f) => `${f.code}: ${f.message}`)]).toEqual([p, mode, []]);
        const all = Object.entries(stack.files).filter(([n]) => n.endsWith('.tf')).map(([, t]) => t).join('\n');
        if (p !== 'vsphere') expect([p, mode, (all.match(/^variable "landing_zone"/gm) ?? []).length]).toEqual([p, mode, mode === 'shared' ? 1 : 0]);
        expect([p, mode, /app_tags_shop\s*=/.test(all), /app_tags_crm\s*=/.test(all)]).toEqual([p, mode, true, true]);
      }
    }
  });
});

describe('pattern blueprints: dual-stack', () => {
  const marker: Record<string, RegExp> = {
    aws_app_ingress: /ip_address_type\s*=\s*.*"dualstack"/,
    azure_app_ingress: /private_ip_address_version\s*=\s*"IPv6"|ip_version\s*=\s*"IPv6"/,
    google_app_ingress: /ip_version\s*=\s*"IPV6"/,
    oci_app_ingress: /ip_mode\s*=\s*.*"IPV6"/,
    vsphere_app_ingress: /ip6_address\s*\{/,
    aws_app_serverless: /ipv6_allowed_for_dual_stack/,
    aws_app_containers: /ip_family\s*=\s*.*"ipv6"/,
    azure_app_containers: /ip_versions\s*=\s*.*"IPv6"/,
    google_app_containers: /stack_type\s*=\s*.*"IPV4_IPV6"/,
    oci_app_containers: /ip_families\s*=\s*.*"IPv6"/,
    aws_app_file_service: /network_type\s*=\s*.*"DUAL"/,
    aws_app_static_site: /is_ipv6_enabled\s*=\s*true/,
    google_app_static_site: /ip_version\s*=\s*"IPV6"/,
    aws_app_managed_cache: /network_type\s*=\s*.*"dual_stack"/,
    aws_app_managed_search: /ip_address_type\s*=\s*.*"dualstack"/,
    aws_app_managed_kafka: /network_type\s*=\s*.*"DUAL"/,
    aws_app_sap_certified: /ipv6_address_count/,
    azure_app_sap_certified: /private_ip_address_version\s*=\s*"IPv6"/,
    google_app_sap_certified: /"IPV4_IPV6"/,
    oci_app_sap_certified: /assign_ipv6ip/,
    aws_app_appliance: /ipv6_address_count/,
    oci_app_appliance: /assign_ipv6ip/,
  };
  it('sets the IPv6 / dual-stack attribute where the service has one', () => {
    for (const [id, re] of Object.entries(marker)) {
      const b = byId.get(id) as Blueprint;
      const text = variants(b).map((v) => tfText(b.build(v, 'check').files)).join('\n');
      expect([id, re.test(text)]).toEqual([id, true]);
    }
  });
});

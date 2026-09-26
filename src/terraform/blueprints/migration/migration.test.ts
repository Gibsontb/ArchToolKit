/**
 * The "From a migration plan" blueprints: they build, they parse, they stack,
 * they keep credentials out of files, and they are dual-stack.
 *
 * `terraform validate` itself runs in tools/validate-terraform-blueprints.mjs
 * (`--only _mig_`), which needs the Terraform CLI; these are the checks that
 * need nothing but Node.
 */

import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../../../kit/blueprint.ts';
import { CATALOG_DATA } from '../../catalog-data.ts';
import { CLOUD_SCHEMA_INDEX } from '../../cloud-schema-index.ts';
import { VMWARE_SCHEMA_DATA } from '../../vmware-schema-data.ts';
import { buildStack, topLevelBlocks, type StackItem } from '../../stack.ts';
import { TERRAFORM_BLUEPRINTS, findTerraformBlueprint } from '../index.ts';
import {
  MIGRATION_GROUP,
  carve,
  landingZoneKeys,
  parseGrid,
  parseImageRef,
  renderImageRef,
  ulaFor,
  type ImageRef,
} from './common.ts';

const MIGRATION = TERRAFORM_BLUEPRINTS.flatMap((g) => g.blueprints.filter((b) => b.group === MIGRATION_GROUP).map((b) => ({ target: g.target, blueprint: b })));
const CLOUDS = ['aws', 'azure', 'google', 'oci'] as const;

/** The ids the design (2.7.2, 2.7.3) names, which the planner composes. */
const EXPECTED_IDS = [
  ...CLOUDS.flatMap((c) => ['landing_zone', 'connectivity', 'compute', 'databases', 'backup', 'monitoring'].map((s) => `${c}_mig_${s}`)),
  ...['aws', 'azure', 'google'].flatMap((c) => [`${c}_mig_identity`, `${c}_mig_oracle_database`]),
  'vsphere_mig_vms',
  'azure_mig_avs',
  'google_mig_gcve',
  'oci_mig_ocvs',
];

const build = (b: Blueprint, values: BlueprintValues = {}) => b.build({ ...defaultValues(b), ...values }, 'check');

/** Defaults, then every other choice of every dropdown, one at a time: every branch a planner can take. */
function variants(b: Blueprint): BlueprintValues[] {
  const base = defaultValues(b);
  const out: BlueprintValues[] = [base];
  for (const input of b.inputs) {
    if (input.control !== 'select' || input.id === 'region') continue;
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

describe('migration blueprints: the set', () => {
  it('has every blueprint the design names, under "From a migration plan"', () => {
    const ids = MIGRATION.map((m) => m.blueprint.id);
    for (const id of EXPECTED_IDS) expect([id, ids.includes(id)]).toEqual([id, true]);
  });

  it('finds each by id through findTerraformBlueprint', () => {
    for (const id of EXPECTED_IDS) expect([id, findTerraformBlueprint(id)?.id]).toEqual([id, id]);
    expect(findTerraformBlueprint('no_such_blueprint')).toBe(undefined);
  });

  it('sits each on its own platform', () => {
    for (const { target, blueprint } of MIGRATION) expect([blueprint.id, blueprint.id.startsWith(`${target}_`)]).toEqual([blueprint.id, true]);
  });

  it('gives every consumer the landing_zone_source input, defaulting to standalone', () => {
    for (const { blueprint } of MIGRATION) {
      if (/_landing_zone$|^vsphere_/.test(blueprint.id)) continue;
      const input = blueprint.inputs.find((i) => i.id === 'landing_zone_source');
      expect([blueprint.id, input?.default, (input?.options ?? []).map((o) => o.value)]).toEqual([blueprint.id, 'variables', ['stack', 'variables']]);
    }
  });

  it('declares the design\'s input ids', () => {
    const has = (id: string, inputs: readonly string[]) => {
      const b = findTerraformBlueprint(id);
      if (!b) return;
      const ids = b.inputs.map((i) => i.id);
      for (const input of inputs) expect([id, input, ids.includes(input)]).toEqual([id, input, true]);
    };
    for (const c of CLOUDS) {
      has(`${c}_mig_landing_zone`, ['prefix', 'region', 'networks', 'subnet_prefix', 'site_cidrs', 'bastion', 'log_retention_days', 'keys', 'scope']);
      has(`${c}_mig_connectivity`, ['sites', 'cloud_asn', 'landing_zone_source']);
      has(`${c}_mig_compute`, ['vms', 'ssh_public_key_var', 'landing_zone_source']);
      has(`${c}_mig_databases`, ['databases', 'landing_zone_source']);
      has(`${c}_mig_backup`, ['tiers', 'dr_region', 'landing_zone_source']);
      has(`${c}_mig_monitoring`, ['siem', 'retention_days']);
    }
    for (const c of ['aws', 'azure', 'google']) {
      has(`${c}_mig_identity`, ['strategy', 'domain', 'dns_forwarders', 'landing_zone_source']);
      has(`${c}_mig_oracle_database`, ['exadata_shape', 'compute_count', 'storage_count', 'vm_cluster_cores', 'databases', 'admin_password_var', 'create_databases']);
    }
    has('aws_mig_identity', ['edition']);
    has('azure_mig_identity', ['edition']);
    has('aws_mig_oracle_database', ['odb_network_cidr']);
    has('google_mig_oracle_database', ['odb_network_cidr']);
    has('aws_mig_compute', ['imdsv2']);
    has('azure_mig_compute', ['windows_admin_password_var']);
    has('azure_mig_databases', ['admin_group_object_id']);
    has('vsphere_mig_vms', ['vsphere_server', 'datacenter', 'cluster', 'datastore_or_policy', 'folder', 'vms', 'domain', 'dns_servers']);
  });

  it('writes its grids with the design\'s columns', () => {
    const hint = (id: string, input: string) => findTerraformBlueprint(id)?.inputs.find((i) => i.id === input)?.hint;
    for (const c of CLOUDS) {
      if (!findTerraformBlueprint(`${c}_mig_landing_zone`)) continue;
      expect(hint(`${c}_mig_landing_zone`, 'networks')).toBe('Network | Environments | IPv4 CIDR | IPv6 | Tiers | Zones');
      expect(hint(`${c}_mig_connectivity`, 'sites')).toBe('Site | VPN peer address | BGP ASN | On-prem CIDRs | Method | Circuit id or service key');
      expect(hint(`${c}_mig_compute`, 'vms')).toBe('Name | OS | Image | Size | Cores | Disks | Network | Tier | Zone | Licence | Backup | Method | App | Role | Env | Wave');
      expect(hint(`${c}_mig_databases`, 'databases')).toBe('Name | Service | Engine | Edition | Version | Class | Storage GiB | HA | Licence | Backup days | Network | App');
      expect(hint(`${c}_mig_backup`, 'tiers')).toBe('Tier | Frequency | Retention days | Copy to DR region | Immutable');
    }
    expect(hint('vsphere_mig_vms', 'vms')).toBe('Name | OS | Template | vCPU | RAM GiB | Disks | Port group | IPv4/prefix | IPv6/prefix | Gateway | Wave');
  });
});

describe('migration blueprints: every build', () => {
  it('builds with its defaults, and every .tf reads as whole top-level blocks', () => {
    for (const { blueprint } of MIGRATION) {
      const out = build(blueprint);
      const errors = (out.findings ?? []).filter((f) => f.severity === 'error');
      expect([blueprint.id, errors.map((f) => f.message)]).toEqual([blueprint.id, []]);
      for (const [name, text] of Object.entries(out.files)) {
        if (!name.endsWith('.tf')) continue;
        const blocks = topLevelBlocks(text);
        const strays = blocks.filter((b) => b.kind === 'comment' && b.text.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('#')));
        expect([blueprint.id, name, strays.map((b) => b.text.slice(0, 80))]).toEqual([blueprint.id, name, []]);
        const kinds = new Set(['terraform', 'provider', 'variable', 'locals', 'resource', 'data', 'output', 'import', 'comment']);
        expect([blueprint.id, name, blocks.filter((b) => !kinds.has(b.kind)).map((b) => b.kind)]).toEqual([blueprint.id, name, []]);
      }
    }
  });

  it('builds every dropdown variant without an exception', () => {
    for (const { blueprint } of MIGRATION) {
      for (const v of variants(blueprint)) {
        const out = blueprint.build(v, 'check');
        expect([blueprint.id, Object.keys(out.files).length > 0]).toEqual([blueprint.id, true]);
      }
    }
  });

  it('writes only resource types the provider catalog holds, and lists each in emits', () => {
    for (const { blueprint } of MIGRATION) {
      for (const e of blueprint.emits) expect([blueprint.id, e, KNOWN.has(e)]).toEqual([blueprint.id, e, true]);
      const written = new Set<string>();
      for (const v of variants(blueprint)) {
        for (const m of tfText(blueprint.build(v, 'check').files).matchAll(/^resource\s+"([a-z0-9_]+)"/gm)) written.add(m[1] as string);
      }
      for (const t of written) {
        expect([blueprint.id, t, KNOWN.has(t)]).toEqual([blueprint.id, t, true]);
        expect([blueprint.id, t, blueprint.emits.includes(t)]).toEqual([blueprint.id, t, true]);
      }
    }
  });

  it('never writes a credential: no password = "…", no CHANGEME, no literal key', () => {
    // A value, not a reference, where a credential goes: `*_password = "…"`, `shared_key = "…"`, `*_psk = "…"`.
    // (`password_wo_version = 1`, `secret_id = var.x` and `*_ocid` names are not credentials.)
    const literal = /\b(\w*password|passwd|\w*secret|shared_key|preshared_key|\w*_psk|private_key|access_key|client_secret)\s*=\s*"[^"$]+"/i;
    for (const { blueprint } of MIGRATION) {
      for (const v of variants(blueprint)) {
        for (const [name, text] of Object.entries(blueprint.build(v, 'check').files)) {
          expect([blueprint.id, name, /password\s*=\s*"/.test(text)]).toEqual([blueprint.id, name, false]);
          expect([blueprint.id, name, /CHANGEME/i.test(text)]).toEqual([blueprint.id, name, false]);
          expect([blueprint.id, name, /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(text)]).toEqual([blueprint.id, name, false]);
          const hit = name.endsWith('.tf') ? literal.exec(text) : null;
          expect([blueprint.id, name, hit?.[0] ?? null]).toEqual([blueprint.id, name, null]);
        }
      }
    }
  });

  it('marks every variable that holds a credential sensitive, with no default', () => {
    for (const { blueprint } of MIGRATION) {
      for (const v of variants(blueprint)) {
        for (const block of topLevelBlocks(tfText(blueprint.build(v, 'check').files))) {
          const name = block.labels[0] ?? '';
          if (block.kind !== 'variable' || !/password|psk|secret/.test(name) || /_(ocid|id|ids|version)$/.test(name)) continue;
          expect([blueprint.id, block.labels[0], /sensitive\s*=\s*true/.test(block.text), /^\s*default\s*=/m.test(block.text)]).toEqual([blueprint.id, block.labels[0], true, false]);
        }
      }
    }
  });

  it('writes nothing that dates or signs the output', () => {
    for (const { blueprint } of MIGRATION) {
      const text = Object.values(build(blueprint).files).join('\n');
      // IAM policy documents carry their language version, "2012-10-17"; that is not a date stamp.
      expect([blueprint.id, /\b20\d\d-\d\d-\d\d\b/.test(text.replace(/"2012-10-17"/g, '')), /archtoolkit/i.test(text)]).toEqual([blueprint.id, false, false]);
    }
  });
});

describe('migration blueprints: the landing-zone contract', () => {
  it('declares var.landing_zone standalone, and nothing of it in a stack', () => {
    for (const { blueprint } of MIGRATION) {
      if (!blueprint.inputs.some((i) => i.id === 'landing_zone_source')) continue;
      const alone = tfText(build(blueprint, { landing_zone_source: 'variables' }).files);
      const stacked = tfText(build(blueprint, { landing_zone_source: 'stack' }).files);
      expect([blueprint.id, /^variable "landing_zone"/m.test(alone)]).toEqual([blueprint.id, true]);
      expect([blueprint.id, /^variable "landing_zone"/m.test(stacked), /\bvar\.landing_zone\b/.test(stacked)]).toEqual([blueprint.id, false, false]);
      expect([blueprint.id, /\blocal\.landing_zone\b/.test(stacked)]).toEqual([blueprint.id, true]);
    }
  });

  it('writes local.landing_zone with every key of the contract', () => {
    for (const c of CLOUDS) {
      const b = findTerraformBlueprint(`${c}_mig_landing_zone`);
      if (!b) continue;
      const locals = topLevelBlocks(tfText(build(b).files)).find((x) => x.kind === 'locals' && /landing_zone\s*=/.test(x.text));
      expect([c, locals !== undefined]).toEqual([c, true]);
      for (const key of landingZoneKeys(c)) expect([c, key, new RegExp(`^\\s{4}${key}\\s*=`, 'm').test(locals?.text ?? '')]).toEqual([c, key, true]);
    }
  });

  it('is dual-stack when a network says IPv6 yes, on all four clouds', () => {
    const v6 = { networks: 'prod | prod | 10.40.0.0/16 | yes | web app db mgmt | 2' };
    const v4 = { networks: 'prod | prod | 10.40.0.0/16 | no | web app db mgmt | 2' };
    const marker: Record<string, RegExp> = {
      aws: /assign_generated_ipv6_cidr_block\s*=\s*true/,
      azure: /address_space\s*=\s*\["10\.40\.0\.0\/16", "fd[0-9a-f]{2}:[0-9a-f]{0,4}:[0-9a-f]{0,4}::\/48"\]/,
      google: /stack_type\s*=\s*"IPV4_IPV6"/,
      oci: /is_ipv6enabled\s*=\s*true/,
    };
    for (const c of CLOUDS) {
      const b = findTerraformBlueprint(`${c}_mig_landing_zone`);
      if (!b) continue;
      expect([c, (marker[c] as RegExp).test(tfText(build(b, v6).files))]).toEqual([c, true]);
      expect([c, (marker[c] as RegExp).test(tfText(build(b, v4).files))]).toEqual([c, false]);
    }
  });
});

describe('migration blueprints: stacked as the planner stacks them', () => {
  const stackFor = (c: string, parts: readonly string[], extra: Record<string, string> = {}) => {
    const items: StackItem[] = parts
      .map((p) => `${c}_mig_${p}`)
      .filter((id) => findTerraformBlueprint(id))
      .map((id) => ({ id, blueprintId: id, label: id.replace(/^[a-z]+_mig_/, '').replace(/_/g, '-'), values: { landing_zone_source: 'stack', ...extra } }));
    return { items, stack: buildStack(items, findTerraformBlueprint, { target: c as never, stackName: `${c}-test`, requiredVersion: '>= 1.7.0' }) };
  };

  it('landing zone + compute + databases + backup builds with no tf.stack warning, per cloud', () => {
    for (const c of CLOUDS) {
      const { items, stack } = stackFor(c, ['landing_zone', 'compute', 'databases', 'backup']);
      if (items.length < 4) continue;
      const warned = stack.findings.filter((f) => f.code.startsWith('tf.stack.') && f.severity !== 'info');
      expect([c, warned.map((f) => `${f.code}: ${f.message}`)]).toEqual([c, []]);
      expect([c, stack.findings.filter((f) => f.severity === 'error').map((f) => f.message)]).toEqual([c, []]);
      const all = Object.entries(stack.files).filter(([n]) => n.endsWith('.tf')).map(([, t]) => t).join('\n');
      expect([c, (all.match(/^\s{2}landing_zone\s*=/gm) ?? []).length]).toEqual([c, 1]);
      expect([c, (all.match(/^\s{2}mig_vms\s*=/gm) ?? []).length]).toEqual([c, 1]);
      expect([c, (stack.files['providers.tf'] ?? '').match(/^provider "/gm)?.length ?? 0]).toEqual([c, 1]);
    }
  });

  it('the whole platform stacks the same way', () => {
    for (const c of CLOUDS) {
      const { items, stack } = stackFor(c, ['landing_zone', 'identity', 'connectivity', 'compute', 'databases', 'oracle_database', 'backup', 'monitoring']);
      if (items.length < 6) continue;
      const warned = stack.findings.filter((f) => f.code.startsWith('tf.stack.') && f.severity !== 'info');
      expect([c, warned.map((f) => `${f.code}: ${f.message}`)]).toEqual([c, []]);
    }
  });

  it('adopts replicated VMs with a for_each import block, and applies with the map empty', () => {
    for (const c of CLOUDS) {
      const b = findTerraformBlueprint(`${c}_mig_compute`);
      if (!b) continue;
      const blocks = topLevelBlocks(tfText(build(b).files));
      const imports = blocks.filter((x) => x.kind === 'import');
      expect([c, imports.length > 0]).toEqual([c, true]);
      for (const i of imports) expect([c, /for_each\s*=\s*.*var\.cutover_instance_ids/.test(i.text), /\bto\s*=\s*\w+\.replicated\[each\.key\]/.test(i.text)]).toEqual([c, true, true]);
      const cutover = blocks.find((x) => x.kind === 'variable' && x.labels[0] === 'cutover_instance_ids');
      expect([c, /default\s*=\s*\{\}/.test(cutover?.text ?? '')]).toEqual([c, true]);
    }
    const { stack } = stackFor('aws', ['landing_zone', 'compute']);
    expect(stack.files['versions.tf']).toContain('required_version = ">= 1.7.0"');
  });
});

describe('migration blueprints: the shared pieces', () => {
  it('reads a grid the way the page writes it', () => {
    const rows = parseGrid('# a comment\nweb01 | win-2022 |  | m7i.large\n\napp01 | rhel-9 | ami:1:x | ', ['Name', 'OS', 'Image', 'Size']);
    expect(rows).toEqual([
      { Name: 'web01', OS: 'win-2022', Image: '', Size: 'm7i.large' },
      { Name: 'app01', OS: 'rhel-9', Image: 'ami:1:x', Size: '' },
    ]);
  });

  it('carves subnets in order, aligned to their size, and refuses what does not fit', () => {
    expect(carve('10.10.0.0/16', [22, 22, 22])).toEqual(['10.10.0.0/22', '10.10.4.0/22', '10.10.8.0/22']);
    expect(carve('10.10.0.0/24', [27, 26])).toEqual(['10.10.0.0/27', '10.10.0.64/26']);
    expect(carve('10.10.0.0/24', [25, 25, 25])).toBe(null);
  });

  it('round-trips every image key', () => {
    const refs: ImageRef[] = [
      { kind: 'aws-ssm', parameter: '/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base' },
      { kind: 'aws-ami-filter', owner: '309956199498', namePattern: 'RHEL-9.*_HVM-*' },
      { kind: 'azure-marketplace', publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server' },
      { kind: 'gcp-family', project: 'rhel-cloud', family: 'rhel-9' },
      { kind: 'oci-platform', operatingSystem: 'Oracle Linux', version: '9' },
      { kind: 'vsphere-template', template: 'tpl-rhel9' },
      { kind: 'custom', variable: 'image_db01' },
      { kind: 'replicated' },
    ];
    for (const r of refs) expect(parseImageRef(renderImageRef(r))).toEqual(r);
    expect(parseImageRef('')).toBe(null);
    expect(parseImageRef('nonsense')).toBe(null);
  });

  it('gives an Azure network the same ULA /48 every time', () => {
    expect(ulaFor('mig/prod')).toBe(ulaFor('mig/prod'));
    expect(ulaFor('mig/prod') === ulaFor('mig/nonprod')).toBe(false);
    expect(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/.test(ulaFor('mig/prod'))).toBe(true);
  });
});

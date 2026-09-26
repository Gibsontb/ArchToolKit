/**
 * The replication blueprints (WP-11c): aws_mig_replication,
 * google_mig_replication and oci_mig_replication. They build, write only
 * catalog types (and none of the ones that do not exist), keep credentials
 * out of files, stack with their landing zone, and write the outputs the
 * execution kit's scripts read.
 *
 * `terraform validate` runs outside the unit tests (the validate tool), as
 * for the other migration blueprints.
 */

import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../../../kit/blueprint.ts';
import { CATALOG_DATA } from '../../catalog-data.ts';
import { buildStack, topLevelBlocks, type StackItem } from '../../stack.ts';
import { findTerraformBlueprint } from '../index.ts';
import { MIGRATION_GROUP } from './common.ts';
import { dmsEngines, MIGRATION_REPLICATION_BLUEPRINTS } from './replication.ts';

const byId = (id: string): Blueprint => {
  const b = MIGRATION_REPLICATION_BLUEPRINTS.find((x) => x.id === id);
  if (!b) throw new Error(`no ${id}`);
  return b;
};
const build = (b: Blueprint, values: BlueprintValues = {}) => b.build({ ...defaultValues(b), ...values }, 'check');
const tf = (files: Readonly<Record<string, string>>) => Object.entries(files).filter(([n]) => n.endsWith('.tf')).map(([, t]) => t).join('\n');

function variants(b: Blueprint): BlueprintValues[] {
  const base = defaultValues(b);
  const out: BlueprintValues[] = [base, { ...base, landing_zone_source: 'stack' }, { ...base, dms_databases: 'none' }, { ...base, vms: '' }];
  for (const input of b.inputs) {
    if (input.control !== 'select') continue;
    for (const o of input.options ?? []) if (String(o.value) !== String(base[input.id])) out.push({ ...base, [input.id]: o.value });
  }
  if (b.id === 'oci_mig_replication') out.push({ ...base, vcenter: 'vc01.corp.example', inventory_id: 'ocid1.inventory.oc1..x', dms_databases: 'web crm' });
  if (b.id === 'google_mig_replication') out.push({ ...base, dms_peering_range: '10.40.255.0/29', sources: 'orders | pg01.corp.example | 5432 | orders | atk_mig' });
  return out;
}

const KNOWN = (() => {
  const known = new Set<string>();
  for (const [target, entry] of Object.entries(CATALOG_DATA)) {
    const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
    for (const n of entry.resources.split(',')) known.add(prefix + n);
  }
  return known;
})();

describe('replication blueprints: the set', () => {
  it('has one per cloud but Azure, under "From a migration plan", each on its platform', () => {
    expect(MIGRATION_REPLICATION_BLUEPRINTS.map((b) => b.id)).toEqual(['aws_mig_replication', 'google_mig_replication', 'oci_mig_replication']);
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) expect([b.id, b.group]).toEqual([b.id, MIGRATION_GROUP]);
  });

  it('declares the inputs the planner passes (vms, databases, landing_zone_source), defaulting to standalone', () => {
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) {
      const ids = b.inputs.map((i) => i.id);
      for (const id of ['vms', 'databases', 'landing_zone_source', 'dms_databases', 'plan_id']) expect([b.id, id, ids.includes(id)]).toEqual([b.id, id, true]);
      expect(b.inputs.find((i) => i.id === 'landing_zone_source')?.default).toBe('variables');
      expect(b.inputs.find((i) => i.id === 'vms')?.hint).toBe('Name | OS | Image | Size | Cores | Disks | Network | Tier | Zone | Licence | Backup | Method | App | Role | Env | Wave | Component');
      expect(b.inputs.find((i) => i.id === 'databases')?.hint).toBe('Name | Service | Engine | Edition | Version | Class | Storage GiB | HA | Licence | Backup days | Network | App');
    }
  });
});

describe('replication blueprints: every build', () => {
  it('builds every variant with no error, as whole top-level blocks', () => {
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) {
      for (const v of variants(b)) {
        const out = b.build(v, 'check');
        expect([b.id, (out.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.message)]).toEqual([b.id, []]);
        const kinds = new Set(['terraform', 'provider', 'variable', 'locals', 'resource', 'data', 'output', 'comment']);
        expect([b.id, topLevelBlocks(tf(out.files)).filter((x) => !kinds.has(x.kind)).map((x) => x.kind)]).toEqual([b.id, []]);
      }
    }
  });

  it('writes only catalog types, lists each in emits, and none of the types that do not exist', () => {
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) {
      for (const t of b.emits) expect([b.id, t, KNOWN.has(t)]).toEqual([b.id, t, true]);
      const written = new Set<string>();
      for (const v of variants(b)) {
        const text = tf(b.build(v, 'check').files);
        for (const m of text.matchAll(/^resource\s+"([a-z0-9_]+)"/gm)) written.add(m[1]!);
        expect([b.id, /aws_mgn_|google_vm_migration_|azurerm_migrate_/.test(text)]).toEqual([b.id, false]);
        expect([b.id, /"oci_database_migration"/.test(text)]).toEqual([b.id, false]);
      }
      for (const t of written) {
        expect([b.id, t, KNOWN.has(t)]).toEqual([b.id, t, true]);
        expect([b.id, t, b.emits.includes(t)]).toEqual([b.id, t, true]);
      }
      for (const t of b.emits) expect([b.id, t, written.has(t)]).toEqual([b.id, t, true]);
    }
  });

  it('never writes a credential, and every credential variable is sensitive with no default', () => {
    const literal = /\b(\w*password|passwd|\w*secret|shared_key|private_key|access_key|client_secret)\s*=\s*"[^"$]+"/i;
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) {
      for (const v of variants(b)) {
        const text = tf(b.build(v, 'check').files);
        expect([b.id, literal.exec(text)?.[0] ?? null]).toEqual([b.id, null]);
        expect([b.id, /aws_secretsmanager_secret_version/.test(text)]).toEqual([b.id, false]);
        for (const block of topLevelBlocks(text)) {
          const name = block.labels[0] ?? '';
          if (block.kind !== 'variable' || !/password|secret/.test(name) || /_(ocid|id|ids|version)$/.test(name)) continue;
          expect([b.id, name, /sensitive\s*=\s*true/.test(block.text), /^\s*default\s*=/m.test(block.text)]).toEqual([b.id, name, true, false]);
        }
      }
    }
  });

  it('declares var.landing_zone standalone, and reads local.landing_zone in a stack', () => {
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) {
      const alone = tf(build(b, { landing_zone_source: 'variables' }).files);
      const stacked = tf(build(b, { landing_zone_source: 'stack' }).files);
      expect([b.id, /^variable "landing_zone"/m.test(alone)]).toEqual([b.id, true]);
      expect([b.id, /\bvar\.landing_zone\b/.test(stacked), /\blocal\.landing_zone\b/.test(stacked)]).toEqual([b.id, false, true]);
    }
  });

  it('writes nothing that dates or signs the output', () => {
    for (const b of MIGRATION_REPLICATION_BLUEPRINTS) {
      const text = Object.values(build(b).files).join('\n').replace(/"2012-10-17"/g, '');
      expect([b.id, /\b20\d\d-\d\d-\d\d\b/.test(text), /archtoolkit|generated by/i.test(text)]).toEqual([b.id, false, false]);
    }
  });
});

/** An endpoint key in the DMS locals map. */
const endpoint = (text: string, key: string): boolean => new RegExp(`^\\s+${key} = \\{`, 'm').test(text);

describe('aws_mig_replication', () => {
  const b = byId('aws_mig_replication');
  const text = tf(build(b).files);

  it('makes the MGN pieces: the agent-install role with the managed policy, TCP 1500 from the sites (IPv4 and IPv6), 443 out', () => {
    expect(text).toContain('resource "aws_iam_role" "mgn_agent_install"');
    expect(text).toContain('max_session_duration = 3600');
    expect(text).toContain(':iam::aws:policy/AWSApplicationMigrationAgentInstallationPolicy');
    expect(/from_port\s+= 1500/.test(text)).toBe(true);
    expect(/cidr_ipv6\s+= strcontains\(each\.value, ":"\) \? each\.value : null/.test(text)).toBe(true);
    expect(/cidr_ipv6\s+= "::\/0"/.test(text)).toBe(true);
    expect(/for_each\s+= toset\(var\.landing_zone\.mgmt_cidrs\)/.test(text)).toBe(true);
    expect(/^output "mgn"/m.test(text)).toBe(true);
  });

  it('makes DMS: the required role names, a secret container per endpoint (no value), endpoints reading it', () => {
    expect(/name\s+= "dms-vpc-role"/.test(text)).toBe(true);
    expect(text).toContain('"dms-cloudwatch-logs-role"');
    expect(text).toContain('AmazonDMSVPCManagementRole');
    expect(text).toContain('secrets_manager_arn');
    expect(text).toContain('secrets_manager_access_role_arn');
    // auto: Oracle and PostgreSQL to RDS / Aurora, both ends
    for (const k of ['orders-source', 'orders-target', 'erp-source', 'ledger-target']) expect([k, endpoint(text, k)]).toEqual([k, true]);
    expect(/engine\s+= "aurora-postgresql"/.test(text)).toBe(true);
    const none = tf(build(b, { dms_account_roles: 'no' }).files);
    expect(none.includes('"dms-vpc-role"')).toBe(false);
    const only = tf(build(b, { dms_databases: 'orders' }).files);
    expect([endpoint(only, 'orders-source'), endpoint(only, 'erp-source')]).toEqual([true, false]);
    expect(tf(build(b, { dms_databases: 'none', vms: '' }).files).includes('resource "')).toBe(false);
  });

  it('maps RDS engines to DMS endpoint engines', () => {
    expect(dmsEngines('oracle-ee')).toEqual({ source: 'oracle', target: 'oracle', family: 'oracle' });
    expect(dmsEngines('aurora-mysql')).toEqual({ source: 'mysql', target: 'aurora', family: 'mysql' });
    expect(dmsEngines('db2-se')).toBe(null);
  });
});

describe('google_mig_replication', () => {
  const b = byId('google_mig_replication');
  const text = tf(build(b).files);

  it('enables the Migrate to VMs API, and makes a continuous DMS job per database with its profiles', () => {
    expect(/service\s+= "vmmigration\.googleapis\.com"/.test(text)).toBe(true);
    expect(text).toContain('datamigration.googleapis.com');
    expect((text.match(/resource "google_database_migration_service_migration_job"/g) ?? []).length).toBe(3);
    expect(/type\s+= "CONTINUOUS"/.test(text)).toBe(true);
    expect(text).toContain('alloydb_cluster_id');
    expect(text).toContain('cloud_sql_id');
    expect(text).toContain('variable "dms_orders_source_host"');
    expect(/^output "m2vm"/m.test(text)).toBe(true);
  });

  it('takes the source host from the sources grid, and a private connection when a range is given', () => {
    const t = tf(build(b, { dms_peering_range: '10.40.255.0/29', sources: 'orders | pg01.corp.example | 5433 | orders | atk_mig' }).files);
    expect(t).toContain('"pg01.corp.example"');
    expect(t).toContain('5433');
    expect(t.includes('variable "dms_orders_source_host"')).toBe(false);
    expect(t).toContain('resource "google_database_migration_service_private_connection" "dms"');
    expect(t).toContain('private_connectivity');
  });

  it('says SQL Server is not in Terraform', () => {
    const out = build(b, { databases: 'crm | google-cloudsql | SQLSERVER_2022_STANDARD | enterprise | 2022 | db-custom-4-15360 | 300 | regional | li | 7 | prod | crm' });
    expect(out.findings?.some((f) => f.code === 'tf.mig.gcp-dms-sqlserver')).toBe(true);
  });
});

describe('oci_mig_replication', () => {
  const b = byId('oci_mig_replication');
  const text = tf(build(b, { vcenter: 'vc01.corp.example' }).files);

  it('makes the Cloud Migrations objects: a migration per wave, a test and a cutover plan per wave, assets from the discovered inventory', () => {
    for (const t of ['oci_cloud_bridge_environment', 'oci_cloud_bridge_inventory', 'oci_cloud_bridge_asset_source', 'oci_cloud_bridge_discovery_schedule', 'oci_cloud_migrations_replication_schedule', 'oci_cloud_migrations_migration', 'oci_cloud_migrations_migration_asset', 'oci_cloud_migrations_migration_plan', 'oci_cloud_migrations_target_asset']) {
      expect([t, text.includes(`resource "${t}"`)]).toEqual([t, true]);
    }
    expect(text).toContain('toset(["1", "2"])');
    expect(text).toContain('"1/test"');
    expect(text).toContain('"2/cutover"');
    expect(text).toContain('variable "ocm_inventory_asset_ids"');
    expect(/default\s+= \{\}/.test(text)).toBe(true);
    expect(text).toContain('vcenter_endpoint');
    expect(text).toContain('"https://vc01.corp.example/sdk"');
    expect(text).toContain('secret_id = var.ocm_vcenter_discovery_secret_id');
    expect(/^output "ocm"/m.test(text)).toBe(true);
  });

  it('uses an existing inventory when given, and OCI Database Migration for MySQL to HeatWave (Oracle when named)', () => {
    const t = tf(build(b, { inventory_id: 'ocid1.inventory.oc1..x', dms_databases: 'web crm' }).files);
    expect(t.includes('resource "oci_cloud_bridge_inventory"')).toBe(false);
    expect(/technology_type\s+= "OCI_MYSQL"/.test(t)).toBe(true);
    expect(t).toContain('OCI_AUTONOMOUS_DATABASE');
    expect((t.match(/resource "oci_database_migration_migration"/g) ?? []).length).toBe(2);
    expect((text.match(/resource "oci_database_migration_migration"/g) ?? []).length).toBe(1);
  });
});

describe('replication blueprints: stacked with their landing zone', () => {
  const lookup = (id: string) => MIGRATION_REPLICATION_BLUEPRINTS.find((b) => b.id === id) ?? findTerraformBlueprint(id);
  for (const c of ['aws', 'google', 'oci'] as const) {
    it(`${c}: landing zone + replication builds with no tf.stack warning`, () => {
      const items: StackItem[] = [`${c}_mig_landing_zone`, `${c}_mig_replication`].map((id) => ({
        id, blueprintId: id, label: id.includes('landing') ? 'landing-zone' : 'replication', values: { landing_zone_source: 'stack', ...(c === 'oci' ? { vcenter: 'vc01.corp.example' } : {}) },
      }));
      const stack = buildStack(items, lookup, { target: c, stackName: `${c}-test`, requiredVersion: '>= 1.7.0' });
      const warned = stack.findings.filter((f) => f.code.startsWith('tf.stack.') && f.severity !== 'info');
      expect([c, warned.map((f) => `${f.code}: ${f.message}`)]).toEqual([c, []]);
      expect([c, stack.findings.filter((f) => f.severity === 'error').map((f) => f.message)]).toEqual([c, []]);
    });
  }
});

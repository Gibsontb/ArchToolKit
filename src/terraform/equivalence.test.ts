import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { CATALOG_DATA } from './catalog-data.ts';
import { ANSIBLE_CATALOG_DATA } from '../ansible/catalog-data.ts';
import { resourceSchema } from './schema-blueprints.ts';
import { MAPS } from './maps.ts';
import { resourcesIn } from './map.ts';
import { CAPABILITIES } from '../multicloud/services.ts';
import { MIGRATION_TERRAFORM_AWS } from './blueprints/migration/aws.ts';
import { MIGRATION_TERRAFORM_AZURE } from './blueprints/migration/azure.ts';
import { MIGRATION_TERRAFORM_GOOGLE } from './blueprints/migration/google.ts';
import { MIGRATION_TERRAFORM_OCI } from './blueprints/migration/oci.ts';
import { RELOCATE_AZURE, RELOCATE_GOOGLE, RELOCATE_OCI } from './blueprints/migration/relocate.ts';
import { MIGRATION_TERRAFORM_VSPHERE } from './blueprints/migration/vsphere.ts';
import {
  EQUIVALENCE_DOMAINS,
  EQUIVALENCE_PLATFORMS,
  EQUIVALENCE_ROWS,
  MODULE_EQUIVALENCE,
  UNMAPPED,
  blueprintIdFor,
  cellOf,
  equivalenceCoverage,
  equivalents,
  isNeutralModule,
  moduleFromBlueprintId,
  moduleRowOf,
  nearestRows,
  platformOfType,
  rowOf,
  rowsNaming,
  typesInRows,
  unmappedReason,
} from './equivalence.ts';

// ---------------------------------------------------------------- helpers ---

const CATALOG_KEY: Readonly<Record<string, string>> = {
  aws: 'aws', azurerm: 'azure', google: 'google', oci: 'oci',
  vsphere: 'vsphere', vcf: 'vcf', nsxt: 'nsxt', avi: 'avi', vra: 'vra', vcd: 'vcd',
};
const CATALOG = new Map(Object.entries(CATALOG_DATA).map(([k, v]) => [k, new Set(v.resources.split(','))]));

/** In catalog-data.ts as a resource (Google's shared IAM pages count, as catalog.ts has it). */
function inCatalog(type: string): boolean {
  const prefix = type.slice(0, type.indexOf('_'));
  const key = CATALOG_KEY[prefix];
  if (!key) return false;
  const bare = type.slice(prefix.length + 1);
  const set = CATALOG.get(key);
  if (!set) return false;
  if (set.has(bare)) return true;
  const iam = /^(.*_iam)_(member|binding|policy|audit_config)$/.exec(bare);
  return iam !== null && set.has(iam[1] as string);
}

type Block = { a?: readonly (readonly unknown[])[]; b?: readonly (readonly unknown[])[] };

/** Whether a dotted argument path exists in a type's schema. */
function pathExists(type: string, path: string): boolean {
  let block: Block | undefined = resourceSchema(type) as Block | undefined;
  if (!block) return false;
  const parts = path.split('.');
  for (const [i, part] of parts.entries()) {
    if (i === parts.length - 1) return (block?.a ?? []).some((a) => a[0] === part);
    const child: readonly unknown[] | undefined = (block?.b ?? []).find((b) => b[0] === part);
    if (!child) return false;
    block = child[4] as Block;
  }
  return false;
}

function allTypesOfRow(row: (typeof EQUIVALENCE_ROWS)[number]): string[] {
  const out: string[] = [];
  for (const cell of Object.values(row.per)) {
    if (!cell) continue;
    out.push(...cell.primary, ...(cell.supporting ?? []), ...(cell.alternatives ?? []).map((a) => a.type), ...Object.keys(cell.match ?? {}));
  }
  for (const map of row.attributes) for (const t of Object.values(map.per)) if (t) out.push(t.type);
  return out;
}

const EMITTED = [
  ...MIGRATION_TERRAFORM_AWS, ...MIGRATION_TERRAFORM_AZURE, ...MIGRATION_TERRAFORM_GOOGLE, ...MIGRATION_TERRAFORM_OCI,
  ...RELOCATE_AZURE, ...RELOCATE_GOOGLE, ...RELOCATE_OCI, ...MIGRATION_TERRAFORM_VSPHERE,
].flatMap((b) => b.emits);

const MAP_NAMES = MAPS.flatMap((m) => resourcesIn(m)).filter((n) => /^(aws|azurerm|azuread|google|oci)_[a-z0-9_]+$/.test(n));

// ------------------------------------------------------------------ tests ---

describe('equivalence map: shape', () => {
  it('has unique row ids in the known domains', () => {
    const ids = EQUIVALENCE_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of EQUIVALENCE_ROWS) expect([row.id, EQUIVALENCE_DOMAINS.includes(row.domain)]).toEqual([row.id, true]);
  });

  it('fills every platform cell, or says none with a reason', () => {
    const bad: string[] = [];
    for (const row of EQUIVALENCE_ROWS) {
      for (const p of EQUIVALENCE_PLATFORMS) {
        const cell = row.per[p];
        if (!cell) bad.push(`${row.id}/${p}: missing`);
        else if (cell.none !== undefined) {
          if (cell.none.trim().length < 10 || cell.primary.length > 0) bad.push(`${row.id}/${p}: none needs a reason and no types`);
        } else if (cell.primary.length === 0) bad.push(`${row.id}/${p}: empty without a reason`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps every type on its own platform\'s cell', () => {
    const bad: string[] = [];
    for (const row of EQUIVALENCE_ROWS) {
      for (const p of EQUIVALENCE_PLATFORMS) {
        const cell = row.per[p];
        if (!cell) continue;
        for (const t of [...cell.primary, ...(cell.supporting ?? []), ...(cell.alternatives ?? []).map((a) => a.type)]) {
          if (platformOfType(t) !== p) bad.push(`${row.id}/${p}: ${t}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('names every type that exists in the committed provider catalog', () => {
    const bad = [...new Set(EQUIVALENCE_ROWS.flatMap(allTypesOfRow))].filter((t) => !inCatalog(t));
    expect(bad).toEqual([]);
  });

  it('names every attribute path (and size companion) that exists in its type\'s schema', () => {
    const bad: string[] = [];
    for (const row of EQUIVALENCE_ROWS) {
      for (const map of row.attributes) {
        for (const [p, t] of Object.entries(map.per)) {
          if (!t) continue;
          const paths = [t.path, ...Object.values(t.companions ?? {})];
          for (const path of paths) if (!pathExists(t.type, path)) bad.push(`${row.id} ${map.concept} ${p}: ${t.type}.${path}`);
          const cell = row.per[p as keyof typeof row.per];
          const inCell = cell && (cell.primary.includes(t.type) || cell.supporting?.includes(t.type) || cell.alternatives?.some((a) => a.type === t.type));
          if (!inCell) bad.push(`${row.id} ${map.concept} ${p}: ${t.type} is not in the row's ${p} cell`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('routes a type shared by several rows by a condition, with at most one fallback row', () => {
    const bad: string[] = [];
    for (const type of typesInRows()) {
      const owning = rowsNaming(type).filter((r) => {
        const c = cellOf(r, type)?.cell;
        return c !== undefined && (c.primary.includes(type) || c.alternatives?.some((a) => a.type === type));
      });
      if (owning.length < 2) continue;
      const plain = owning.filter((r) => cellOf(r, type)?.cell.match?.[type] === undefined);
      if (plain.length > 1) bad.push(`${type}: ${plain.map((r) => r.id).join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('keeps UNMAPPED apart from the rows, each with a reason', () => {
    const inRows = new Set(typesInRows());
    expect(UNMAPPED.filter((u) => inRows.has(u.type)).map((u) => u.type)).toEqual([]);
    expect(UNMAPPED.filter((u) => u.reason.trim().length < 10).map((u) => u.type)).toEqual([]);
    expect(new Set(UNMAPPED.map((u) => u.type)).size).toBe(UNMAPPED.length);
  });

  it('links only to Terraform Map sections that exist', () => {
    const sections = new Map(MAPS.map((m) => [m.target, new Set(m.sections.map((s) => s.id))]));
    const bad: string[] = [];
    for (const row of EQUIVALENCE_ROWS) {
      for (const [p, id] of Object.entries(row.mapSection ?? {})) {
        if (!sections.get(p as never)?.has(id as string)) bad.push(`${row.id}: ${p}#${id}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('equivalence map: coverage', () => {
  const placed = (t: string): boolean => typesInRows().includes(t) || unmappedReason(t) !== undefined;

  it('places every type named in the four Terraform Maps in a row or in UNMAPPED', () => {
    expect([...new Set(MAP_NAMES)].filter((t) => !placed(t))).toEqual([]);
  });

  it('places every type a migration blueprint emits (WP-5) in a row or in UNMAPPED', () => {
    expect([...new Set(EMITTED)].filter((t) => !placed(t))).toEqual([]);
  });

  it('seeds every capability of multicloud/services.ts', () => {
    const missing: string[] = [];
    for (const cap of CAPABILITIES) for (const e of Object.values(cap.on)) if (e && !typesInRows().includes(e.terraformType)) missing.push(`${cap.capability}: ${e.terraformType}`);
    expect(missing).toEqual([]);
  });

  it('reports its coverage and gaps', () => {
    const c = equivalenceCoverage();
    expect(c.rows).toBe(EQUIVALENCE_ROWS.length);
    expect(c.rows).toBeGreaterThanOrEqual(50);
    expect(c.gaps.vmware.length).toBeGreaterThan(0);
    expect(c.gaps.vmware).toContain('storage.object');
    expect(c.gaps.oci).toContain('db.sqlserver.managed');
  });
});

describe('equivalence map: lookups', () => {
  it('routes aws_db_instance by engine and falls back to PostgreSQL', () => {
    expect(rowOf('aws_db_instance', { 'r.engine': 'postgres' })?.id).toBe('db.postgres.managed');
    expect(rowOf('aws_db_instance', { 'r.engine': 'mysql' })?.id).toBe('db.mysql.managed');
    expect(rowOf('aws_db_instance', { 'r.engine': 'sqlserver-se' })?.id).toBe('db.sqlserver.managed');
    expect(rowOf('aws_db_instance', { 'r.engine': 'oracle-ee' })?.id).toBe('db.oracle.managed');
    expect(rowOf('aws_db_instance')?.id).toBe('db.postgres.managed');
  });

  it('routes a private zone by its values', () => {
    expect(rowOf('aws_route53_zone')?.id).toBe('dns.zone.public');
    expect(rowOf('aws_route53_zone', { 'b.vpc': 'true' })?.id).toBe('dns.zone.private');
    expect(rowOf('google_dns_managed_zone', { 'r.visibility': 'private' })?.id).toBe('dns.zone.private');
  });

  it('prefers the row a type does the job in over one it only supports', () => {
    expect(rowOf('azurerm_key_vault')?.id).toBe('security.kms-key');
    expect(rowOf('aws_s3_bucket_versioning')?.id).toBe('storage.object');
  });

  it('gives equivalents across all five platforms, with the reason where there is none', () => {
    const eq = equivalents('aws_s3_bucket');
    expect(eq.azure).toEqual(['azurerm_storage_account', 'azurerm_storage_container']);
    expect(eq.google).toEqual(['google_storage_bucket']);
    expect(eq.oci).toEqual(['oci_objectstorage_bucket']);
    expect(typeof (eq.vmware as { none: string }).none).toBe('string');
    const unknown = equivalents('aws_glue_catalog_database');
    expect((unknown.azure as { none: string }).none).toBe(unmappedReason('aws_glue_catalog_database') as string);
  });

  it('offers the nearest same-domain rows for a gap', () => {
    const row = rowOf('aws_s3_bucket')!;
    const near = nearestRows(row, 'vmware').map((r) => r.id);
    expect(near).toContain('storage.block');
    expect(near.includes('storage.object')).toBe(false);
  });

  it('names blueprint ids as the Terraform page does', () => {
    expect(blueprintIdFor('aws_s3_bucket')).toBe('res_aws_s3_bucket');
    expect(blueprintIdFor('vsphere_virtual_machine')).toBe('vmw_vsphere_virtual_machine');
  });
});

describe('module equivalence', () => {
  const inAnsibleCatalog = (fqcn: string): boolean => {
    const [ns, coll, ...rest] = fqcn.split('.');
    const entry = ANSIBLE_CATALOG_DATA[`${ns}.${coll}`];
    return entry !== undefined && entry.modules.split(',').includes(rest.join('.'));
  };

  it('names only modules in the Ansible catalog, and every platform or a reason', () => {
    const bad: string[] = [];
    for (const row of MODULE_EQUIVALENCE) {
      for (const p of EQUIVALENCE_PLATFORMS) {
        const cell = row.per[p];
        if (!cell) bad.push(`${row.id}/${p}: missing`);
        else if ('module' in cell && !inAnsibleCatalog(cell.module)) bad.push(`${row.id}/${p}: ${cell.module}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('knows neutral modules and resolves blueprint ids', () => {
    expect(isNeutralModule('ansible.builtin.copy')).toBe(true);
    expect(isNeutralModule('amazon.aws.s3_object')).toBe(false);
    expect(moduleRowOf('amazon.aws.s3_object')?.id).toBe('object');
    expect(moduleFromBlueprintId('mod_amazon_aws_s3_object')).toBe('amazon.aws.s3_object');
    expect(moduleFromBlueprintId('mod_ansible_builtin_copy')).toBe('ansible.builtin.copy');
  });
});

import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '../testing/expect.ts';
import {
  SERVICE_CLOUDS,
  catalogFor,
  categories,
  resourcesFor,
  serviceById,
  serviceForResource,
  services,
  servicesByCategory,
  type ServiceCloud,
} from './service-catalog.ts';
import { CATALOG_DATA } from '../terraform/catalog-data.ts';
import { CFN_SCHEMA_INDEX } from '../editor/cloudformation-schema-index.ts';
import { ARM_SCHEMA_INDEX } from '../editor/arm-schema-index.ts';

const TF: Record<ServiceCloud, { key: string; prefix: string }> = {
  aws: { key: 'aws', prefix: 'aws_' },
  azure: { key: 'azure', prefix: 'azurerm_' },
  google: { key: 'google', prefix: 'google_' },
  oci: { key: 'oci', prefix: 'oci_' },
};

function terraformTypes(cloud: ServiceCloud): Set<string> {
  const entry = CATALOG_DATA[TF[cloud].key];
  return new Set((entry?.resources ?? '').split(',').filter(Boolean).map((r) => TF[cloud].prefix + r));
}

describe('the cloud service catalog', () => {
  for (const cloud of SERVICE_CLOUDS) {
    describe(cloud, () => {
      const data = catalogFor(cloud);

      it('has a non-trivial number of services', () => {
        expect(services(cloud).length).toBeGreaterThan(100);
      });

      it("keeps every service of the provider's own list", () => {
        // Merging joins the same service from two lists, so compare names:
        // every distinct official name must survive as a name or an alias.
        const names = new Set<string>();
        for (const s of services(cloud)) {
          names.add(s.name);
          for (const a of s.aka ?? []) names.add(a);
        }
        expect(data.summary.officialListed).toBeGreaterThan(50);
        expect(names.size).toBeGreaterThanOrEqual(data.summary.officialListed);
        expect(services(cloud).filter((s) => s.verified).length).toBeGreaterThan(50);
      });

      it('has no duplicate ids', () => {
        const ids = services(cloud).map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('gives every service a known category', () => {
        const known = new Set(categories().map((c) => c.id));
        for (const s of services(cloud)) {
          if (!known.has(s.category)) throw new Error(`${cloud}/${s.id}: category ${s.category}`);
        }
      });

      it('names only Terraform resources the catalog has', () => {
        const catalogued = terraformTypes(cloud);
        expect(catalogued.size).toBeGreaterThan(0);
        for (const s of services(cloud)) {
          for (const t of s.terraform) {
            if (!catalogued.has(t)) throw new Error(`${cloud}/${s.id}: ${t} is not in src/terraform/catalog-data.ts`);
          }
        }
      });

      it('names each Terraform resource once', () => {
        const seen = new Set<string>();
        for (const s of services(cloud)) {
          for (const t of s.terraform) {
            if (seen.has(t)) throw new Error(`${cloud}: ${t} is under two services`);
            seen.add(t);
          }
        }
      });

      it('accounts for every catalogued Terraform resource: mapped, or reported', () => {
        const placed = new Set<string>();
        for (const s of services(cloud)) s.terraform.forEach((t) => placed.add(t));
        for (const u of data.unmatched) if (u.kind === 'terraform-resource') (u.items ?? []).forEach((t) => placed.add(t));
        const missing = [...terraformTypes(cloud)].filter((t) => !placed.has(t));
        expect(missing).toEqual([]);
      });

      it('names only CloudFormation and ARM types the Data Editor has', () => {
        for (const s of services(cloud)) {
          for (const t of s.cloudformation ?? []) {
            if (!(t in CFN_SCHEMA_INDEX.types)) throw new Error(`${cloud}/${s.id}: ${t} is not in the CloudFormation schemas`);
          }
          for (const t of s.arm ?? []) {
            const slash = t.indexOf('/');
            const ns = t.slice(0, slash);
            const type = t.slice(slash + 1);
            if (!ARM_SCHEMA_INDEX.types[ns]?.[type]) throw new Error(`${cloud}/${s.id}: ${t} is not in the ARM schemas`);
          }
        }
      });

      it('reports what it could not match, rather than hiding it', () => {
        const subs = data.unmatched.filter((u) => u.kind === 'terraform-subcategory');
        expect(subs.length).toBe(data.summary.unmatchedSubcategories);
        for (const u of data.unmatched) {
          expect(u.reason.length).toBeGreaterThan(0);
          expect(u.count).toBeGreaterThan(0);
        }
        // An unmatched registry subcategory is still a service, flagged as such.
        for (const u of subs) {
          const s = services(cloud).find((x) => x.name === u.name && x.source.includes('terraform-registry'));
          if (!s) throw new Error(`${cloud}: unmatched subcategory "${u.name}" has no service`);
          expect(s.verified).toBe(false);
          expect(s.terraform.length).toBeGreaterThan(0);
        }
      });

      it('flags what cannot be built', () => {
        for (const s of services(cloud)) {
          const native = (s.cloudformation?.length ?? 0) + (s.arm?.length ?? 0);
          const expected = s.terraform.length ? 'terraform' : native ? 'native' : 'none';
          if (s.buildable !== expected) throw new Error(`${cloud}/${s.id}: buildable ${s.buildable}, expected ${expected}`);
        }
        expect(data.summary.withTerraform + data.summary.withoutTerraform).toBe(services(cloud).length);
      });

      it('records where it came from, when, and that every source was read', () => {
        expect(/^\d{4}-\d{2}-\d{2}$/.test(data.fetched)).toBe(true);
        expect(data.sources.length).toBeGreaterThan(1);
        for (const s of data.sources) {
          expect(/^https:\/\//.test(s.url)).toBe(true);
          expect(s.status === 'failed').toBe(false);
        }
      });

      it('carries no machine paths', () => {
        const text = readFileSync(fileURLToPath(new URL(`./service-catalog-${cloud}.ts`, import.meta.url)), 'utf8');
        expect(/[A-Za-z]:\\\\|\/Users\/|\/home\/|\\Users\\/.test(text)).toBe(false);
      });

      it('looks services up by id and by category', () => {
        const first = services(cloud)[0]!;
        expect(serviceById(cloud, first.id)?.name).toBe(first.name);
        const grouped = servicesByCategory(cloud);
        let total = 0;
        for (const list of grouped.values()) total += list.length;
        expect(total).toBe(services(cloud).length);
      });
    });
  }

  it('finds the service a resource belongs to', () => {
    const rds = serviceForResource('aws_db_instance');
    expect(rds?.cloud).toBe('aws');
    expect(rds?.service.name).toBe('Amazon Relational Database Service');
    expect(resourcesFor('aws', rds!.service.id).cloudformation).toContain('AWS::RDS::DBInstance');
    expect(serviceForResource('AWS::RDS::DBInstance')?.service.id).toBe(rds!.service.id);
    expect(serviceForResource('google_sql_database_instance')?.service.name).toBe('Cloud SQL');
    expect(serviceForResource('no_such_resource')).toBeUndefined();
    expect(resourcesFor('aws', 'no-such-service').terraform).toEqual([]);
  });

  it('has the common category set', () => {
    expect(categories().map((c) => c.id)).toEqual([
      'compute', 'containers', 'serverless', 'storage', 'database', 'networking',
      'security-identity', 'management-governance', 'monitoring', 'analytics', 'ai-ml',
      'integration-messaging', 'migration', 'developer-tools', 'end-user-computing', 'iot', 'other',
    ]);
  });
});

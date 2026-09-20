import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  catalogueFor,
  catalogued,
  notCatalogued,
  resourceTypes,
  dataSourceTypes,
  classifyType,
  searchCatalog,
  catalogTotals,
  catalogAgeDays,
  catalogFindings,
} from './catalog.ts';
import { emitResource } from './resource.ts';
import { CATALOG_FETCHED_AT } from './catalog-data.ts';

const codes = (findings: readonly { code: string }[]): string[] => findings.map((f) => f.code);

describe('the catalog', () => {
  it('knows the providers it was fetched for', () => {
    expect(catalogued().length > 0).toBe(true);
    for (const target of catalogued()) {
      expect(catalogueFor(target)).toBeDefined();
    }
  });

  it('restores the provider prefix onto stored names', () => {
    // Names are stored bare to keep the generated file small.
    expect(resourceTypes('vsphere')).toContain('vsphere_virtual_machine');
    expect(dataSourceTypes('vsphere')).toContain('vsphere_datacenter');
    expect(resourceTypes('vcf')).toContain('vcf_instance');
  });

  it('tells a resource from a data source', () => {
    expect(classifyType('vsphere', 'vsphere_virtual_machine')).toBe('resource');
    expect(classifyType('vsphere', 'vsphere_datastore')).toBe('data-source');
  });

  it('accepts a name with or without its prefix', () => {
    expect(classifyType('vcf', 'vcf_domain')).toBe('resource');
    expect(classifyType('vcf', 'domain')).toBe('resource');
  });

  it('rejects a name that does not exist', () => {
    expect(classifyType('vsphere', 'vsphere_not_a_thing')).toBe('unknown');
  });

  it('separates not knowing from knowing it is wrong', () => {
    // An uncatalogued provider must not make every resource look invalid.
    for (const target of notCatalogued()) {
      expect(classifyType(target, `${target}_anything`)).toBe('uncatalogued');
    }
  });
});

describe('searching the catalog', () => {
  it('finds a type by fragment', () => {
    const hits = searchCatalog('distributed', { targets: ['vsphere'] });
    expect(hits.length > 0).toBe(true);
    expect(hits.some((h) => h.type === 'vsphere_distributed_port_group')).toBe(true);
  });

  it('requires every term to match', () => {
    const hits = searchCatalog('virtual switch', { targets: ['vsphere'] });
    expect(hits.every((h) => /virtual/.test(h.type) && /switch/.test(h.type))).toBe(true);
  });

  it('labels each hit as a resource or a data source', () => {
    const hits = searchCatalog('datacenter', { targets: ['vsphere'] });
    expect(hits.some((h) => h.kind === 'resource')).toBe(true);
    expect(hits.some((h) => h.kind === 'data-source')).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(searchCatalog('   ')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(searchCatalog('a', { limit: 3 }).length <= 3).toBe(true);
  });
});

describe('the catalog reports its own trustworthiness', () => {
  it('counts what it holds', () => {
    const totals = catalogTotals();
    expect(totals.resources > 50).toBe(true);
    expect(totals.providers).toBe(catalogued().length);
  });

  it('names the providers it does not have', () => {
    // A seed catalog is honest about being partial rather than looking complete.
    const findings = catalogFindings();
    if (notCatalogued().length > 0) {
      expect(codes(findings)).toContain('terraform.catalog.incomplete');
    }
  });

  it('measures its own age', () => {
    expect(catalogAgeDays(new Date(`${CATALOG_FETCHED_AT}T00:00:00Z`))).toBe(0);
    const later = new Date(Date.parse(`${CATALOG_FETCHED_AT}T00:00:00Z`) + 100 * 86400000);
    expect(catalogAgeDays(later)).toBe(100);
  });

  it('says so once it is old', () => {
    const later = new Date(Date.parse(`${CATALOG_FETCHED_AT}T00:00:00Z`) + 200 * 86400000);
    expect(codes(catalogFindings(later))).toContain('terraform.catalog.stale');
  });

  it('is quiet about age while it is fresh', () => {
    const soon = new Date(Date.parse(`${CATALOG_FETCHED_AT}T00:00:00Z`) + 3 * 86400000);
    expect(codes(catalogFindings(soon))).not.toContain('terraform.catalog.stale');
  });
});

describe('emitting an arbitrary resource', () => {
  it('renders a resource block with the given arguments', () => {
    const { hcl } = emitResource({
      target: 'vsphere',
      type: 'vsphere_folder',
      name: 'workloads',
      arguments: {
        path: 'prod/workloads',
        type: 'vm',
        datacenter_id: { expression: 'data.vsphere_datacenter.this.id' },
      },
    });
    expect(hcl).toContain('resource "vsphere_folder" "workloads"');
    expect(hcl).toContain('path          = "prod/workloads"');
    expect(hcl).toContain('datacenter_id = data.vsphere_datacenter.this.id');
  });

  it('renders nested and repeated blocks', () => {
    const { hcl } = emitResource({
      target: 'vsphere',
      type: 'vsphere_distributed_port_group',
      arguments: {
        name: 'pg',
        vlan_range: { block: [{ min_vlan: 100, max_vlan: 199 }, { min_vlan: 300, max_vlan: 399 }] },
      },
    });
    expect(hcl.split('vlan_range {').length - 1).toBe(2);
    expect(hcl).toContain('min_vlan = 100');
    expect(hcl).toContain('max_vlan = 399');
  });

  it('emits a data block when asked', () => {
    const { hcl } = emitResource({
      target: 'vsphere',
      type: 'vsphere_datastore',
      dataSource: true,
      arguments: { name: 'ds01' },
    });
    expect(hcl).toContain('data "vsphere_datastore" "datastore"');
  });

  it('refuses a type the provider does not have', () => {
    const { findings } = emitResource({
      target: 'vsphere',
      type: 'vsphere_imaginary',
      arguments: { name: 'x' },
    });
    expect(codes(findings)).toContain('terraform.resource.unknown-type');
  });

  it('notices a data source asked for as a resource', () => {
    const { findings } = emitResource({
      target: 'vsphere',
      type: 'vsphere_datastore',
      arguments: { name: 'ds01' },
    });
    expect(codes(findings)).toContain('terraform.resource.kind-mismatch');
  });

  it('says it cannot vouch for argument names', () => {
    // The catalog knows which resources exist, not what each one accepts.
    const { findings } = emitResource({
      target: 'vsphere',
      type: 'vsphere_folder',
      arguments: { path: 'x', type: 'vm' },
    });
    expect(codes(findings)).toContain('terraform.resource.arguments-not-validated');
  });

  it('warns rather than failing for an uncatalogued provider', () => {
    const missing = notCatalogued();
    if (missing.length === 0) return;
    const { findings, hcl } = emitResource({
      target: missing[0] as 'aws',
      type: 'aws_s3_bucket',
      arguments: { bucket: 'example' },
    });
    expect(codes(findings)).toContain('terraform.resource.uncatalogued-provider');
    // It still emits: not knowing is not the same as knowing it is wrong.
    expect(hcl).toContain('resource "aws_s3_bucket"');
  });

  it('escapes values rather than trusting them', () => {
    const { hcl } = emitResource({
      target: 'vsphere',
      type: 'vsphere_folder',
      arguments: { path: 'a${b}c' },
    });
    expect(hcl).toContain('$${b}');
  });
});

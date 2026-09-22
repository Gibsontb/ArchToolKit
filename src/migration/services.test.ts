/**
 * The service recommendations.
 *
 * The rule that matters: the page must give a real answer with no catalog
 * loaded, and a catalog must sharpen that answer rather than replace it.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { capabilitiesFor, EMPTY_CATALOG, globalCatalog, recommendServices, type ServiceCatalog } from './services.ts';
import { EMPTY_APPLICATION, type Application } from './types.ts';

const app = (over: Partial<Application> = {}): Application => ({ ...EMPTY_APPLICATION, name: 'Test app', ...over });
const find = (list: ReturnType<typeof recommendServices>, capability: string) => list.find((r) => r.capability === capability);

describe('which capabilities a route needs', () => {
  it('always covers the landing zone', () => {
    for (const route of ['Rehost', 'Replatform', 'Refactor', 'Repurchase', 'Retain'] as const) {
      for (const base of ['iam', 'monitoring', 'secrets', 'networking']) {
        expect([route, base, capabilitiesFor(route).includes(base)]).toEqual([route, base, true]);
      }
    }
  });

  it('asks for VMs and disks on a rehost, and containers on a refactor', () => {
    expect(capabilitiesFor('Rehost').includes('computeVm')).toBe(true);
    expect(capabilitiesFor('Rehost').includes('serverless')).toBe(false);
    expect(capabilitiesFor('Refactor').includes('containers')).toBe(true);
    expect(capabilitiesFor('Refactor').includes('apiGateway')).toBe(true);
  });

  it('keeps a retirement down to where the data goes', () => {
    expect(capabilitiesFor('Retire')).toEqual(['objectStorage', 'backupArchive', 'iam']);
  });
});

describe('with no catalog loaded', () => {
  const recommended = recommendServices('aws', 'Rehost', app(), EMPTY_CATALOG);

  it('still names real services', () => {
    expect(find(recommended, 'computeVm')?.primary).toBe('EC2');
    expect(find(recommended, 'objectStorage')?.primary).toBe('S3');
    expect(recommended.every((r) => r.how === 'core')).toBe(true);
  });

  it('answers every capability the route asked for', () => {
    expect(recommended.map((r) => r.capability)).toEqual(capabilitiesFor('Rehost'));
  });

  it('carries a label a page can print', () => {
    expect(find(recommended, 'iam')?.label).toBe('Identity and access');
  });
});

describe('the database in the intake', () => {
  it('decides the managed database, per cloud', () => {
    expect(find(recommendServices('azure', 'Replatform', app({ database: 'Microsoft SQL Server 2019' })), 'managedDb')?.primary).toBe('Azure SQL Managed Instance');
    expect(find(recommendServices('aws', 'Replatform', app({ database: 'PostgreSQL 15' })), 'managedDb')?.primary).toBe('Aurora PostgreSQL');
    expect(find(recommendServices('oci', 'Replatform', app({ database: 'Oracle Database 19c' })), 'managedDb')?.primary).toBe('Autonomous Database');
  });

  it('falls back to the general answer for the cloud when the database says nothing', () => {
    expect(find(recommendServices('aws', 'Replatform', app({ database: '' })), 'managedDb')?.primary).toBe('RDS');
  });
});

describe('with a catalog loaded', () => {
  const catalog: ServiceCatalog = {
    services: () => ['Amazon EC2', 'Amazon S3', 'AWS Identity and Access Management', 'Amazon CloudWatch', 'Amazon VPC', 'Amazon Kinesis Data Streams'],
    byCategory: (_cloud, id) => (id === 'devops_ci_cd' ? ['Harness Pipelines'] : []),
    tagsFor: (_cloud, service) => (service === 'Amazon S3' ? ['fedramp_high'] : []),
  };

  it('uses the spelling the catalog itself uses for a service it knows', () => {
    expect(find(recommendServices('aws', 'Rehost', app(), catalog), 'computeVm')?.primary).toBe('Amazon EC2');
  });

  it('keeps the core pick when the catalog carries it under a longer name', () => {
    const eventing = find(recommendServices('aws', 'Refactor', app(), catalog), 'eventing');
    expect(eventing?.primary).toBe('Amazon Kinesis Data Streams');
    expect(eventing?.how).toBe('core');
  });

  it('falls back to the canonical category when the core names are not in the catalog at all', () => {
    const ciCd = find(recommendServices('aws', 'Refactor', app(), catalog), 'ciCd');
    expect(ciCd?.primary).toBe('Harness Pipelines');
    expect(ciCd?.how).toBe('catalog candidates');
  });

  it('puts a service authorised for the framework in scope first', () => {
    const regulated = find(recommendServices('aws', 'Rehost', app({ compliance: ['fedramp_high'] }), catalog), 'objectStorage');
    expect(regulated?.primary).toBe('Amazon S3');
  });
});

describe('the adapter for the catalogs the pages already load', () => {
  const CDK = {
    providers: {
      azure: {
        serviceCategories: {
          Compute: { services: [{ name: 'Azure Virtual Machines', tags: ['fedramp_high'] }] },
          Storage: { services: ['Azure Blob Storage'] },
        },
      },
    },
    ccsmIndex: { index: { storage_object: { providers: { azure: [{ name: 'Azure Blob Storage' }] } } } },
  };

  it('reads services, categories and compliance tags out of it', () => {
    const catalog = globalCatalog(CDK);
    expect(catalog.services('azure')).toEqual(['Azure Virtual Machines', 'Azure Blob Storage']);
    expect(catalog.byCategory?.('azure', 'storage_object')).toEqual(['Azure Blob Storage']);
    expect(catalog.tagsFor?.('azure', 'Azure Virtual Machines')).toEqual(['fedramp_high']);
  });

  it('answers empty for a cloud it has nothing for, rather than throwing', () => {
    const catalog = globalCatalog(CDK);
    expect(catalog.services('gcp')).toEqual([]);
    expect(globalCatalog(undefined).services('aws')).toEqual([]);
    expect(recommendServices('gcp', 'Rehost', app(), catalog).length > 0).toBe(true);
  });
});

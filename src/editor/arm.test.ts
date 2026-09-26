/**
 * ARM templates against Microsoft's published resource schemas: resource
 * types, apiVersions and, for the apiVersion the schema is for, properties.
 * The apiVersions used here are read from the index, so the tests hold after
 * `npm run editor:arm` refreshes the data.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import type { Finding } from '../core/findings.ts';
import type { Json } from './doc.ts';
import { azureArm } from './profiles/azure.ts';
import { choicesAt } from './profile.ts';
import { armType, armTypeSchema, loadArmType } from './arm-schema.ts';

const STORAGE = 'Microsoft.Storage/storageAccounts';
const VNET = 'Microsoft.Network/virtualNetworks';
const SUBNET = 'Microsoft.Network/virtualNetworks/subnets';

/** The apiVersion the type's property schema is for. */
const schemaVersion = (type: string): string => {
  const s = armTypeSchema(type);
  if (!s) throw new Error(`no schema for ${type}`);
  return s.apiVersion;
};

const template = (...resources: Json[]): Json => ({
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0',
  parameters: {
    location: { type: 'string', defaultValue: '[resourceGroup().location]' },
    kind: { type: 'string', defaultValue: 'StorageV2' },
  },
  resources,
});

const storage = (extra: Record<string, Json> = {}): Json => ({
  type: STORAGE,
  apiVersion: schemaVersion(STORAGE),
  name: 'stexample01',
  location: "[parameters('location')]",
  sku: { name: 'Standard_LRS' },
  kind: 'StorageV2',
  properties: { minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, allowBlobPublicAccess: false, accessTier: 'Hot' },
  ...extra,
});

const run = (doc: Json): Finding[] => azureArm.validate?.(doc) ?? [];
const codes = (fs: Finding[]) => fs.map((f) => f.code);
const notInfo = (fs: Finding[]) => fs.filter((f) => f.severity !== 'info').map((f) => `${f.severity} ${f.code} ${f.path}: ${f.message}`);

describe('ARM schema index', () => {
  it('lists types with their apiVersions, newest first, whatever the case', () => {
    const t = armType('microsoft.storage/STORAGEACCOUNTS');
    expect(t?.type).toBe(STORAGE);
    expect((t?.versions.length ?? 0) > 10).toBe(true);
    expect(t?.versions.includes('2023-05-01')).toBe(true);
    const sorted = [...(t?.versions ?? [])].map((v) => v.slice(0, 10));
    expect(sorted).toEqual([...sorted].sort().reverse());
  });

  it('prepare resolves (the chunk is read from disk in Node)', async () => {
    await loadArmType(SUBNET).catch(() => undefined);
    await azureArm.prepare?.(template(storage()));
    expect(armTypeSchema(STORAGE)?.type).toBe(STORAGE);
  });
});

describe('ARM templates against the schemas', () => {
  it('a storage account with an apiVersion that does not exist', () => {
    const f = run(template(storage({ apiVersion: '2023-05-02' })));
    const bad = f.find((x) => x.code === 'arm.resource.apiVersion-unknown');
    expect(bad?.severity).toBe('error');
    expect(bad?.path).toBe('resources[0].apiVersion');
    expect(bad?.message.includes(armType(STORAGE)?.versions[0] as string)).toBe(true);
  });

  it('a misspelt resource type, with a did-you-mean', () => {
    const f = run(template(storage({ type: 'Microsoft.Storage/storageAcounts' })));
    const bad = f.find((x) => x.code === 'arm.resource.type-unknown');
    expect(bad?.severity).toBe('error');
    expect(bad?.message.includes(`Did you mean ${STORAGE}?`)).toBe(true);
  });

  it('a correct template at the schema apiVersion has no findings', () => {
    const net = schemaVersion(VNET);
    const doc = template(storage(), {
      type: VNET,
      apiVersion: net,
      name: 'vnet-example',
      location: "[parameters('location')]",
      properties: { addressSpace: { addressPrefixes: ['10.0.0.0/16'] }, subnets: [{ name: 'app', properties: { addressPrefix: '10.0.0.0/24' } }] },
    });
    expect(notInfo(run(doc))).toEqual([]);
    expect(codes(run(doc)).includes('arm.resource.apiVersion-old')).toBe(false);
  });

  it('an older apiVersion that exists is only information', () => {
    const f = run(template(storage({ apiVersion: '2023-05-01' })));
    expect(f.filter((x) => x.severity !== 'info')).toEqual([]);
    expect(codes(f)).toEqual(['arm.resource.apiVersion-old']);
  });

  it('flags a bad enum value, an unknown field and a missing required field', () => {
    const f = run(
      template(
        storage({
          kind: 'StorageV3',
          properties: { minimumTlsVersion: 'TLS1_2', accessTeir: 'Hot', networkAcls: { bypass: 'Logging, AzureServices', ipRules: [] } },
        }),
      ),
    );
    const enumF = f.find((x) => x.code === 'arm.property.enum');
    expect([enumF?.path, enumF?.message.includes('Did you mean StorageV2?')]).toEqual(['resources[0].kind', true]);
    const unknown = f.find((x) => x.code === 'arm.property.unknown');
    expect([unknown?.severity, unknown?.path, unknown?.message.includes('Did you mean accessTier?')]).toEqual(['warning', 'resources[0].properties.accessTeir', true]);
    const req = f.find((x) => x.code === 'arm.property.required');
    expect([req?.path, req?.message.includes('defaultAction')]).toEqual(['resources[0].properties.networkAcls', true]);
    // bypass takes a comma-separated set of its values.
    expect(f.filter((x) => x.code === 'arm.property.enum').length).toBe(1);
  });

  it('does not check properties at an apiVersion other than the schema one', () => {
    const f = run(template(storage({ apiVersion: '2023-05-01', kind: 'StorageV3', properties: { madeUp: true } })));
    expect(f.filter((x) => x.severity !== 'info')).toEqual([]);
  });

  it('leaves expressions alone', () => {
    const f = run(
      template(
        storage({
          kind: "[parameters('kind')]",
          sku: "[json('{\"name\": \"Standard_LRS\"}')]",
          properties: { minimumTlsVersion: "[if(true(), 'TLS1_2', 'TLS1_1')]", accessTier: "[variables('tier')]", networkAcls: "[variables('acls')]" },
        }),
        { type: "[concat('Microsoft.Storage/', 'storageAccounts')]", apiVersion: "[variables('api')]", name: 'x' },
      ),
    );
    expect(f.filter((x) => x.code.startsWith('arm.property') || x.code.startsWith('arm.resource'))).toEqual([]);
  });

  it('recognises a subnet, nested short or written in full', () => {
    const net = schemaVersion(VNET);
    const sub = schemaVersion(SUBNET);
    const doc = template(
      {
        type: VNET,
        apiVersion: net,
        name: 'vnet-example',
        location: 'eastus',
        properties: { addressSpace: { addressPrefixes: ['10.0.0.0/16'] } },
        resources: [{ type: 'subnets', apiVersion: sub, name: 'app', dependsOn: ['vnet-example'], properties: { addressPrefix: '10.0.1.0/24' } }],
      },
      { type: SUBNET, apiVersion: sub, name: 'vnet-example/data', properties: { addressPrefix: '10.0.2.0/24' } },
    );
    expect(notInfo(run(doc))).toEqual([]);
    // Its schema is found: a misspelt field in a nested subnet is caught.
    const bad = template({
      type: VNET,
      apiVersion: net,
      name: 'vnet-example',
      location: 'eastus',
      properties: { addressSpace: { addressPrefixes: ['10.0.0.0/16'] } },
      resources: [{ type: 'subnets', apiVersion: sub, name: 'app', properties: { adressPrefix: '10.0.1.0/24' } }],
    });
    const f = run(bad).find((x) => x.code === 'arm.property.unknown');
    expect(f?.path).toBe('resources[0].resources[0].properties.adressPrefix');
    // And a nested subnet's apiVersion has its own dropdown.
    expect(choicesAt(azureArm, bad, ['resources', 0, 'resources', 0, 'apiVersion'])?.[0]).toBe(armType(SUBNET)?.versions[0]);
  });

  it('offers the apiVersions and the enums', () => {
    const doc = template(storage());
    expect(choicesAt(azureArm, doc, ['resources', 0, 'apiVersion'])).toEqual(armType(STORAGE)?.versions);
    expect(choicesAt(azureArm, doc, ['resources', 0, 'kind'])?.includes('StorageV2')).toBe(true);
    expect(choicesAt(azureArm, doc, ['resources', 0, 'properties', 'accessTier'])?.includes('Cool')).toBe(true);
    expect(choicesAt(azureArm, doc, ['resources', 0, 'sku', 'name'])?.includes('Standard_ZRS')).toBe(true);
  });
});

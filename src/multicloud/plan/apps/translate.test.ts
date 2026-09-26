import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import type { AppComponent, AppPlan, ConfigComponent, PatternComponent, ResourceComponent } from '../types.ts';
import {
  addressOf,
  leaveOut,
  previewTranslation,
  switchPlatform,
  translateComponent,
  translateVariant,
  variantFindings,
} from './translate.ts';

const res = (slug: string, type: string, values: Record<string, string>, name = slug): ResourceComponent => ({
  kind: 'resource',
  id: `c:shop:${slug}`,
  name,
  tier: 'app',
  type,
  blueprintId: type.startsWith('vsphere_') ? `vmw_${type}` : `res_${type}`,
  values,
});

const BUCKET = res('assets', 'aws_s3_bucket', { 'r.bucket': 'shop-assets', 'r.tags': 'app=shop\nOwner=Team' });
const VERSIONING = res('assets-versioning', 'aws_s3_bucket_versioning', {
  'r.bucket': 'aws_s3_bucket.assets.id',
  'b.versioning_configuration': 'true',
  'r.versioning_configuration.status': 'Enabled',
});
const VM = res('web', 'aws_instance', {
  'r.instance_type': 'm7i.xlarge',
  'r.subnet_id': 'local.landing_zone.subnet_ids["prod/web/a"]',
  'r.availability_zone': 'us-east-1b',
  'r.user_data': '#!/bin/sh\necho hi',
  'b.root_block_device': 'true',
  'r.root_block_device.volume_size': '64',
  'p.region': 'us-east-1',
});
const DB = res('orders', 'aws_db_instance', {
  'r.engine': 'postgres',
  'r.engine_version': '16',
  'r.instance_class': 'db.r7i.large',
  'r.allocated_storage': '200',
  'r.multi_az': 'true',
  'r.identifier': 'orders',
});
const GLUE = res('catalog', 'aws_glue_catalog_database', { 'r.name': 'sales' });
const PATTERN: PatternComponent = {
  kind: 'pattern', id: 'c:shop:front', name: 'front', tier: 'web', tierPattern: 'paas-web',
  servers: ['web01'], databases: [], settings: { users: '500' },
};
const COPY: ConfigComponent = {
  kind: 'config', id: 'c:shop:motd', name: 'motd', tier: 'app', blueprintId: 'mod_ansible_builtin_copy',
  values: { 'r.dest': '/etc/motd', 'r.content': 'hi' }, appliesTo: [], order: 1,
};
const UPLOAD: ConfigComponent = {
  kind: 'config', id: 'c:shop:upload', name: 'upload', tier: 'app', blueprintId: 'mod_amazon_aws_s3_object',
  values: { hosts: 'localhost', 'r.bucket': 'shop-assets', 'r.object': 'index.html', 'r.src': 'files/index.html', 'r.mode': 'put' },
  appliesTo: [], order: 2,
};

const AWS_VARIANT: readonly AppComponent[] = [BUCKET, VERSIONING, VM, DB, GLUE, PATTERN, COPY, UPLOAD];

const plan = (): AppPlan => ({
  app: 'app:shop', origin: 'migrate', status: 'draft', platform: 'aws',
  variants: { aws: AWS_VARIANT }, answers: {}, landingZone: 'shared',
});

describe('translate: switching restores', () => {
  it('AWS → Azure → AWS restores the original AWS variant exactly', () => {
    const before = JSON.parse(JSON.stringify(plan().variants.aws));
    const toAzure = switchPlatform(plan(), 'azure');
    expect(toAzure.created).toBe(true);
    expect(toAzure.plan.variants.azure !== undefined).toBe(true);
    const back = switchPlatform(toAzure.plan, 'aws');
    expect(back.created).toBe(false);
    expect(back.plan.platform).toBe('aws');
    expect(JSON.parse(JSON.stringify(back.plan.variants.aws))).toEqual(before);
    // and switching to Azure again selects the variant made the first time, unchanged
    const again = switchPlatform(back.plan, 'azure');
    expect(again.created).toBe(false);
    expect(again.plan.variants.azure).toEqual(toAzure.plan.variants.azure);
  });
});

describe('translate: nothing is dropped', () => {
  it('accounts for every source component on every platform', () => {
    for (const to of ['azure', 'google', 'oci', 'vmware'] as const) {
      const v = translateVariant(AWS_VARIANT, 'aws', to);
      expect(v.translations.length).toBe(AWS_VARIANT.length);
      for (const t of v.translations) {
        const kept = t.components.length > 0 || t.foldedInto !== undefined;
        expect([to, t.componentId, kept]).toEqual([to, t.componentId, true]);
      }
    }
  });

  it('keeps a component with no equivalent as an unresolved placeholder with an error', () => {
    const t = translateComponent(BUCKET, 'aws', 'vmware', { siblings: AWS_VARIANT });
    expect(t.outcome).toBe('no-equivalent');
    expect(t.components.length).toBe(1);
    expect(t.components[0]?.status).toBe('unresolved');
    expect((t.components[0] as ResourceComponent).type).toBe('aws_s3_bucket');
    expect((t.components[0] as ResourceComponent).values).toEqual(BUCKET.values);
    expect(t.findings.map((f) => f.code)).toEqual(['translate.no-equivalent']);
    expect((t.reason ?? '').length).toBeGreaterThan(10);
    expect(t.nearest ?? []).toContain('storage.block');
  });

  it('says "not in the equivalence map" (or the UNMAPPED reason) for a type in no row', () => {
    const t = translateComponent(GLUE, 'aws', 'azure');
    expect(t.outcome).toBe('no-equivalent');
    expect(t.components[0]?.id).toBe(GLUE.id);
    const odd = translateComponent(res('x', 'aws_amplify_app', { 'r.name': 'x' }), 'aws', 'azure');
    expect(odd.reason).toBe('not in the equivalence map');
  });

  it('blocks generation on the platform until the component is left out', () => {
    const switched = switchPlatform(plan(), 'vmware').plan;
    const errors = variantFindings(switched, 'vmware').filter((f) => f.severity === 'error');
    expect(errors.some((f) => f.path === BUCKET.id)).toBe(true);
    const accepted = leaveOut(switched, 'vmware', BUCKET.id);
    expect(variantFindings(accepted, 'vmware').some((f) => f.severity === 'error' && f.path === BUCKET.id)).toBe(false);
    expect(accepted.leftOut?.vmware).toEqual([BUCKET.id]);
  });
});

describe('translate: resources', () => {
  it('folds supporting S3 resources into the Azure storage account by concept', () => {
    const t = translateComponent(BUCKET, 'aws', 'azure', { siblings: AWS_VARIANT });
    expect(t.targetTypes.slice(0, 2)).toEqual(['azurerm_storage_account', 'azurerm_storage_container']);
    const account = t.components[0] as ResourceComponent;
    expect(account.id).toBe(BUCKET.id);
    expect(account.blueprintId).toBe('res_azurerm_storage_account');
    expect(account.values['r.name']).toBe('shop-assets');
    expect(account.values['r.blob_properties.versioning_enabled']).toBe('true');
    expect(account.values['b.blob_properties']).toBe('true');
    expect(account.values['r.tags']).toBe('app=shop\nOwner=Team');
    const folded = translateComponent(VERSIONING, 'aws', 'azure', { siblings: AWS_VARIANT });
    expect(folded.foldedInto).toBe(BUCKET.id);
    expect(folded.outcome).toBe('mapped');
    expect(folded.components).toEqual([]);
  });

  it('lower-cases tags into Google labels', () => {
    const t = translateComponent(BUCKET, 'aws', 'google', { siblings: AWS_VARIANT });
    const bucket = t.components[0] as ResourceComponent;
    expect(bucket.type).toBe('google_storage_bucket');
    expect(bucket.values['r.labels']).toBe('app=shop\nowner=team');
    expect(bucket.values['r.versioning.enabled']).toBe('true');
  });

  it('rightsizes a VM, carries the landing-zone subnet and the zone, and lists what it cannot carry', () => {
    const t = translateComponent(VM, 'aws', 'azure', { siblings: AWS_VARIANT });
    expect(t.outcome).toBe('partial');
    const [vm, nic] = t.components as ResourceComponent[];
    expect(vm?.type).toBe('azurerm_linux_virtual_machine');
    expect(vm?.values['r.size']).toBe('Standard_D4s_v5');
    expect(vm?.values['r.zone']).toBe('2');
    expect(vm?.values['r.os_disk.disk_size_gb']).toBe('64');
    expect(nic?.type).toBe('azurerm_network_interface');
    expect(nic?.values['r.ip_configuration.subnet_id']).toBe('local.landing_zone.subnet_ids["prod/web/a"]');
    // every uncarried argument is listed, with a reason; provider settings (p.*) are not arguments
    expect(t.dropped).toEqual([{ argument: 'user_data', value: '#!/bin/sh\necho hi', reason: 'no mapped attribute' }]);
    expect(t.findings.map((f) => f.code)).toEqual(['translate.partial']);
    expect(vm?.status).toBe('partial');
    expect(vm?.translatedFrom?.dropped.length).toBe(1);
  });

  it('writes a Windows guest as azurerm_windows_virtual_machine', () => {
    const t = translateComponent(VM, 'aws', 'azure', { os: 'windows' });
    expect((t.components[0] as ResourceComponent).type).toBe('azurerm_windows_virtual_machine');
  });

  it('sizes a VM on OCI Flex and on vSphere by numbers', () => {
    const oci = translateComponent(VM, 'aws', 'oci').components[0] as ResourceComponent;
    expect(oci.values['r.shape']).toBe('VM.Standard.E5.Flex');
    expect(oci.values['r.shape_config.ocpus']).toBe('2');
    expect(oci.values['r.shape_config.memory_in_gbs']).toBe('16');
    expect(oci.values['r.availability_domain']).toBe('local.landing_zone.zones[1]');
    const vmw = translateComponent(VM, 'aws', 'vmware').components[0] as ResourceComponent;
    expect(vmw.type).toBe('vsphere_virtual_machine');
    expect(vmw.blueprintId).toBe('vmw_vsphere_virtual_machine');
    expect(vmw.values['r.num_cpus']).toBe('4');
    expect(vmw.values['r.memory']).toBe(String(16 * 1024));
    // and back: vSphere numbers to an AWS type
    const back = translateComponent(res('web', 'vsphere_virtual_machine', { 'r.num_cpus': '4', 'r.memory': '16384' }), 'vmware', 'aws');
    expect((back.components[0] as ResourceComponent).values['r.instance_type']).toBe('m7i.xlarge');
  });

  it('refuses a literal subnet id, which belongs to the source platform', () => {
    const literal = res('web2', 'aws_instance', { 'r.subnet_id': 'subnet-0abc' });
    const t = translateComponent(literal, 'aws', 'google');
    expect(t.outcome).toBe('partial');
    expect(t.dropped[0]?.argument).toBe('subnet_id');
    expect(t.dropped[0]?.reason).toContain('landing-zone reference');
  });

  it('carries a database through the DB catalog and the class ladders', () => {
    const az = translateComponent(DB, 'aws', 'azure').components[0] as ResourceComponent;
    expect(az.type).toBe('azurerm_postgresql_flexible_server');
    expect(az.values['r.version']).toBe('16');
    expect(az.values['r.sku_name']).toBe('MO_Standard_E2ds_v5');
    expect(az.values['r.high_availability.mode']).toBe('ZoneRedundant');
    expect(az.values['r.name']).toBe('orders');
    const gcp = translateComponent(DB, 'aws', 'google');
    const sql = gcp.components[0] as ResourceComponent;
    expect(sql.values['r.database_version']).toBe('POSTGRES_16');
    // 16 GiB on 2 vCPU is past Cloud SQL's 6.5 GiB per vCPU, so the vCPU count rises to 4
    expect(sql.values['r.settings.tier']).toBe('db-custom-4-16384');
    expect(sql.values['r.settings.availability_type']).toBe('REGIONAL');
    expect(sql.values['r.settings.disk_size']).toBe('200');
    // `engine` says which row; it has no argument of its own on the target
    expect(gcp.dropped.map((d) => d.argument)).toEqual(['engine']);
    const oci = translateComponent(DB, 'aws', 'oci').components[0] as ResourceComponent;
    expect(oci.type).toBe('oci_psql_db_system');
    expect(oci.values['r.db_version']).toBe('16');
    expect(oci.values['r.instance_ocpu_count']).toBe('1');
  });

  it('routes SQL Server to no-equivalent on OCI, with the reason', () => {
    const t = translateComponent(res('erp', 'aws_db_instance', { 'r.engine': 'sqlserver-se' }), 'aws', 'oci');
    expect(t.outcome).toBe('no-equivalent');
    expect(t.reason).toContain('SQL Server');
  });

  it('rewrites a reference to another component to its translated address', () => {
    const logs = res('logs', 'aws_cloudwatch_log_group', { 'r.name': 'shop' });
    const key = res('key', 'aws_kms_key', {});
    const group = res('audit', 'aws_cloudwatch_log_group', { 'r.name': 'audit', 'r.kms_key_id': `${addressOf(key)}.arn` });
    const t = translateComponent(group, 'aws', 'azure', { siblings: [logs, key, group] });
    // kms_key_id has no Azure equivalent in the logs row, so it is listed rather than guessed
    expect(t.dropped.map((d) => d.argument)).toEqual(['kms_key_id']);
    const q = res('jobs', 'aws_sqs_queue', { 'r.name': 'jobs', 'r.kms_master_key_id': `${addressOf(key)}.id` });
    const oq = translateComponent(q, 'aws', 'oci', { siblings: [key, q] });
    expect((oq.components[0] as ResourceComponent).values['r.custom_encryption_key_id']).toBe('oci_kms_key.key.id');
  });
});

describe('translate: patterns and configuration', () => {
  it('keeps a pattern and carries its settings where the tier pattern has a service', () => {
    const t = translateComponent(PATTERN, 'aws', 'azure');
    expect(t.outcome).toBe('mapped');
    expect((t.components[0] as PatternComponent).settings).toEqual({ users: '500' });
  });

  it('proposes, not applies, the next best tier pattern where it has none', () => {
    const t = translateComponent(PATTERN, 'aws', 'oci');
    expect(t.outcome).toBe('no-equivalent');
    expect(t.proposal).toBe('containers');
    expect((t.components[0] as PatternComponent).tierPattern).toBe('paas-web');
  });

  it('carries OS-level modules unchanged and maps cloud modules and their options', () => {
    expect(translateComponent(COPY, 'aws', 'google').components[0]).toEqual(COPY);
    const t = translateComponent(UPLOAD, 'aws', 'azure');
    const c = t.components[0] as ConfigComponent;
    expect(c.blueprintId).toBe('mod_azure_azcollection_azure_rm_storageblob');
    expect(c.values['r.container']).toBe('shop-assets');
    expect(c.values['r.blob']).toBe('index.html');
    expect(c.values['hosts']).toBe('localhost');
    expect(t.outcome).toBe('partial');
    expect(t.dropped).toEqual([{ argument: 'mode', value: 'put', reason: 'no mapped option' }]);
    const none = translateComponent(UPLOAD, 'aws', 'vmware');
    expect(none.outcome).toBe('no-equivalent');
  });
});

describe('translate: compare preview', () => {
  it('previews every platform without creating a variant', () => {
    const p = plan();
    for (const to of ['azure', 'google', 'oci', 'vmware'] as const) {
      const v = previewTranslation(p.variants.aws ?? [], 'aws', to);
      expect(v.translations.length).toBe(AWS_VARIANT.length);
    }
    expect(Object.keys(p.variants)).toEqual(['aws']);
  });
});

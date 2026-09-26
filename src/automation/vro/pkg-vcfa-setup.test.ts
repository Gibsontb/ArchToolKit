/**
 * The VCF Automation blueprints as Orchestrator packages: the setup chain
 * (cloud account, zone, project, mappings, network and storage profiles,
 * content source, naming, property groups) and the catalogue side (cloud
 * template, ABX action, approval policy).
 *
 * For each: the package builds and parses, every script is ES5, the secrets
 * are SecureString with no value, IMPORT.md names the package and every
 * import/ file; and the workflow runs in the emulator against a fake VCF
 * Automation in another process — a dry run reads and writes nothing, an armed
 * run makes exactly the expected calls in order with the right bodies (ids
 * passed on, lookups filled in), the cap and the first failure stop it, what
 * exists is left alone, and no secret reaches a log.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { readPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';
import { stableId } from '../vcfa-import.ts';

const CURL = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

const TOKEN = 'vcfa-api-token-do-not-log';
const ACCESS = 'vcfa-access-do-not-log';
const VS_PW = 'vsphere-pw-do-not-log';
const NSX_PW = 'nsx-pw-do-not-log';
const CORE = 'vcf.automation.core.package';

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
}

function packageOf(files: Record<string, string>) {
  const packages = packagesIn(files);
  const dir = Object.keys(packages).find((d) => d !== CORE)!;
  const spec = readPackageSpec(packages[dir]!);
  return { dir, spec, workflow: spec.workflows[0]!.name, configKey: `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}` };
}

const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A list endpoint: the path, then its query (?apiVersion…, ?page… or &page… after a typeId filter). */
const list = (path: string, items: unknown[] = [], total = items.length): FakeRoute => ({ method: 'GET', path: `^${esc(path)}[?&]`, body: { content: items, totalElements: total } });
const get = (path: string, body: unknown): FakeRoute => ({ method: 'GET', path: `^${esc(path)}(\\?|$)`, body });
const post = (path: string, body: unknown, status = 200): FakeRoute => ({ method: 'POST', path: `^${esc(path)}(\\?apiVersion=[^&]*)?$`, status, body });
const AUTH: FakeRoute = { method: 'POST', path: '^/oauth/tenant/org1/token$', body: { access_token: ACCESS, token_type: 'bearer', expires_in: 3600 } };
const HOOK: FakeRoute = { method: 'POST', path: '^/hook$', body: {} };

const logText = (run: WorkflowRun) => run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
const isWrite = (r: FakeRequest) => r.method !== 'GET' && !/^\/(tm\/)?oauth\/|^\/hook$|\/blueprint-validation$/.test(r.path);
const writesOf = (requests: FakeRequest[]) => requests.filter(isWrite).map((r) => `${r.method} ${r.path.split('?')[0]}`);
const bodyOf = (requests: FakeRequest[], call: string, index = 0) => JSON.parse(requests.filter((r) => `${r.method} ${r.path.split('?')[0]}` === call)[index]!.body) as Record<string, any>;

const servers: FakeServer[] = [];
after(() => servers.forEach((s) => s.stop()));

async function runWith(files: Record<string, string>, routes: FakeRoute[], settings: Record<string, unknown>, inputs: Record<string, unknown> = {}) {
  const server = await startFakeServer([...routes, AUTH, HOOK]);
  servers.push(server);
  const { workflow, configKey } = packageOf(files);
  const host = `127.0.0.1:${server.port}`;
  const emulator = new VroEmulator(files, { config: { [configKey]: { vcfaHost: host, vcfaOrg: 'org1', vcfaApiToken: TOKEN, webhook: `https://${host}/hook`, ...settings } } });
  const result = emulator.runWorkflow(workflow, inputs);
  const requests = server.requests();
  // Never a secret in a log line, an output or an error.
  expect(/do-not-log/.test(logText(result))).toBe(false);
  return { result, requests, writes: writesOf(requests), host };
}

// ---------------------------------------------------------------------------
// The cases: each automation with what it reads, what exists, and what it must write.

interface Case {
  readonly id: string;
  readonly values?: BlueprintValues;
  readonly settings: Record<string, unknown>;
  /** Lookups, and the lists showing nothing there yet. */
  readonly routes: FakeRoute[];
  /** The lists showing everything there already (put in front of routes). */
  readonly existing: FakeRoute[];
  /** The expected writes, in order: "METHOD /path". */
  readonly writes: string[];
  readonly secrets: string[];
  readonly check: (requests: FakeRequest[], run: WorkflowRun) => void;
}

const templateFiles = build('vcfa_cloud_template');
const templateYaml = Object.entries(templateFiles).find(([p]) => p.endsWith('/blueprint.yaml'))![1];
const groupFiles = build('vcfa_property_group');
const groupYaml = Object.entries(groupFiles).find(([p]) => p.endsWith('/blueprint.yaml'))![1];
const abxFiles = build('vcfa_abx_action');
const abxScript = Object.entries(abxFiles).find(([p]) => /^import\/abx\/[^/]+\/[^/]+\.py$/.test(p))![1];
const SUBSCRIPTION_ID = stableId('subscription:Register in the CMDB');

const CASES: Case[] = [
  {
    id: 'vcfa_cloud_account',
    settings: { vspherePassword: VS_PW, nsxPassword: NSX_PW },
    routes: [
      list('/iaas/api/cloud-accounts-vsphere'),
      list('/iaas/api/cloud-accounts-nsx-t'),
      // The vSphere create answers with a request tracker, polled until FINISHED; the NSX one synchronously.
      post('/iaas/api/cloud-accounts-vsphere', { id: 'rt-1', status: 'INPROGRESS', selfLink: '/iaas/api/request-tracker/rt-1' }, 202),
      { method: 'GET', path: '^/iaas/api/request-tracker/rt-1$', responses: [{ body: { id: 'rt-1', status: 'INPROGRESS', selfLink: '/iaas/api/request-tracker/rt-1' } }, { body: { id: 'rt-1', status: 'FINISHED', resources: ['/iaas/api/cloud-accounts/ca-vs'], selfLink: '/iaas/api/request-tracker/rt-1' } }] },
      post('/iaas/api/cloud-accounts-nsx-t', { id: 'ca-nsx' }),
    ],
    existing: [list('/iaas/api/cloud-accounts-vsphere', [{ id: 'ca-vs', name: 'wld01-vcenter', hostName: 'wld01-vc.example.com' }]), list('/iaas/api/cloud-accounts-nsx-t', [{ id: 'ca-nsx', name: 'wld01-vcenter-nsx', hostName: 'wld01-nsx.example.com' }])],
    writes: ['POST /iaas/api/cloud-accounts-vsphere', 'POST /iaas/api/cloud-accounts-nsx-t'],
    secrets: ['vcfaApiToken', 'vspherePassword', 'nsxPassword'],
    check: (requests, run) => {
      const vs = bodyOf(requests, 'POST /iaas/api/cloud-accounts-vsphere');
      expect(vs.password).toBe(VS_PW);
      expect(vs.createDefaultZones).toBe(false);
      expect(vs.regions).toEqual([{ externalRegionId: 'Datacenter:datacenter-3', name: 'Datacenter' }]);
      expect(requests.filter((r) => r.path === '/iaas/api/request-tracker/rt-1').length).toBe(2);
      const nsx = bodyOf(requests, 'POST /iaas/api/cloud-accounts-nsx-t');
      expect(nsx.associatedCloudAccountIds).toEqual(['ca-vs']);
      expect(nsx.password).toBe(NSX_PW);
      expect(requests.filter((r) => r.method === 'POST' && r.path.startsWith('/iaas/')).every((r) => r.path.endsWith('?apiVersion=2021-07-15'))).toBe(true);
      expect(run.outputs.vsphereAccountId).toBe('ca-vs');
      expect(run.outputs.nsxAccountId).toBe('ca-nsx');
    },
  },
  {
    id: 'vcfa_cloud_zone',
    settings: { externalRegionId: 'Datacenter:datacenter-3' },
    routes: [list('/iaas/api/regions', [{ id: 'region-1', externalRegionId: 'Datacenter:datacenter-3' }, { id: 'region-2', externalRegionId: 'Datacenter:datacenter-9' }]), list('/iaas/api/zones'), post('/iaas/api/zones', { id: 'zone-1' })],
    existing: [list('/iaas/api/zones', [{ id: 'zone-1', name: 'dc1-general' }])],
    writes: ['POST /iaas/api/zones'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const zone = bodyOf(requests, 'POST /iaas/api/zones');
      expect(zone.regionId).toBe('region-1');
      expect(zone.tagsToMatch).toEqual([{ key: 'workload', value: 'general' }]);
      expect(run.outputs.zoneId).toBe('zone-1');
    },
  },
  {
    id: 'vcfa_project',
    settings: { zoneIds: 'zone-1, zone-2' },
    routes: [list('/iaas/api/projects'), post('/iaas/api/projects', { id: 'proj-1' })],
    existing: [list('/iaas/api/projects', [{ id: 'proj-1', name: 'finance-apps' }])],
    writes: ['POST /iaas/api/projects'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const project = bodyOf(requests, 'POST /iaas/api/projects');
      expect(project.zoneAssignmentConfigurations.map((z: { zoneId: string; priority: number }) => `${z.zoneId}@${z.priority}`)).toEqual(['zone-1@0', 'zone-2@1']);
      expect(project.zoneAssignmentConfigurations[1].memoryLimitMB).toBe(512 * 1024);
      expect(project.administrators).toEqual([{ email: 'vcfa-finance-admins@example.com', type: 'group' }]);
      expect(run.outputs.projectId).toBe('proj-1');
    },
  },
  {
    id: 'vcfa_mappings',
    settings: { regionId: 'region-1' },
    routes: [
      get('/iaas/api/regions/region-1', { id: 'region-1', externalRegionId: 'Datacenter:datacenter-3' }),
      list('/iaas/api/fabric-images', [
        { id: 'img-rhel', name: 'tpl-rhel9-hardened', externalRegionId: 'Datacenter:datacenter-3' },
        { id: 'img-rhel-elsewhere', name: 'tpl-rhel9-hardened', externalRegionId: 'Datacenter:datacenter-9' },
        { id: 'img-ubuntu', name: 'tpl-ubuntu-2404', externalRegionId: 'Datacenter:datacenter-3' },
        { id: 'img-win', name: 'tpl-win2022-std', externalRegionId: 'Datacenter:datacenter-3' },
      ]),
      list('/iaas/api/flavor-profiles'),
      list('/iaas/api/image-profiles'),
      post('/iaas/api/flavor-profiles', { id: 'fp-1' }),
      post('/iaas/api/image-profiles', { id: 'ip-1' }),
    ],
    // One profile per region: one for this region under another name counts.
    existing: [list('/iaas/api/flavor-profiles', [{ id: 'fp-0', name: 'someone-elses', regionId: 'region-1' }]), list('/iaas/api/image-profiles', [{ id: 'ip-0', name: 'dc1-standard-images', regionId: 'region-9' }])],
    writes: ['POST /iaas/api/flavor-profiles', 'POST /iaas/api/image-profiles'],
    secrets: ['vcfaApiToken'],
    check: (requests) => {
      const flavor = bodyOf(requests, 'POST /iaas/api/flavor-profiles');
      expect(flavor.regionId).toBe('region-1');
      expect(flavor.flavorMapping.medium).toEqual({ cpuCount: 2, memoryInMB: 8192 });
      const image = bodyOf(requests, 'POST /iaas/api/image-profiles');
      expect(image.regionId).toBe('region-1');
      expect(Object.fromEntries(Object.entries(image.imageMapping as Record<string, { id: string }>).map(([k, v]) => [k, v.id]))).toEqual({ rhel9: 'img-rhel', ubuntu24: 'img-ubuntu', win2022: 'img-win' });
    },
  },
  {
    id: 'vcfa_network_profile',
    settings: { regionId: 'region-1' },
    routes: [
      get('/iaas/api/regions/region-1', { id: 'region-1', externalRegionId: 'Datacenter:datacenter-3' }),
      list('/iaas/api/fabric-networks', [
        { id: 'fn-10', name: 'app-10', cidr: '10.20.10.0/24', externalRegionId: 'Datacenter:datacenter-3' },
        { id: 'fn-11', name: 'app-11', cidr: '10.20.11.0/24', externalRegionId: 'Datacenter:datacenter-3' },
        { id: 'fn-other', name: 'app-10-dr', cidr: '10.20.10.0/24', externalRegionId: 'Datacenter:datacenter-9' },
      ]),
      list('/iaas/api/network-ip-ranges'),
      list('/iaas/api/network-profiles'),
      post('/iaas/api/network-ip-ranges', { id: 'range-1' }),
      post('/iaas/api/network-profiles', { id: 'np-1' }),
    ],
    existing: [list('/iaas/api/network-ip-ranges', [{ id: 'range-1', name: 'dc1-app-networks-range' }]), list('/iaas/api/network-profiles', [{ id: 'np-1', name: 'dc1-app-networks' }])],
    writes: ['POST /iaas/api/network-ip-ranges', 'POST /iaas/api/network-profiles'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const range = bodyOf(requests, 'POST /iaas/api/network-ip-ranges');
      expect(range.fabricNetworkIds).toEqual(['fn-10']);
      expect(`${range.startIPAddress}-${range.endIPAddress}`).toBe('10.20.10.50-10.20.10.200');
      const profile = bodyOf(requests, 'POST /iaas/api/network-profiles');
      expect(profile.fabricNetworkIds).toEqual(['fn-10', 'fn-11']);
      expect(profile.regionId).toBe('region-1');
      expect(run.outputs.networkProfileId).toBe('np-1');
      expect(run.outputs.ipRangeId).toBe('range-1');
    },
  },
  {
    id: 'vcfa_storage_profile',
    settings: { regionId: 'region-1' },
    routes: [
      get('/iaas/api/regions/region-1', { id: 'region-1', externalRegionId: 'Datacenter:datacenter-3' }),
      list('/iaas/api/fabric-vsphere-storage-policies', [
        { id: 'sp-1', name: 'vSAN Default Storage Policy', externalRegionId: 'Datacenter:datacenter-3' },
        { id: 'sp-9', name: 'vSAN Default Storage Policy', externalRegionId: 'Datacenter:datacenter-9' },
      ]),
      list('/iaas/api/storage-profiles-vsphere'),
      post('/iaas/api/storage-profiles-vsphere', { id: 'stp-1' }),
    ],
    existing: [list('/iaas/api/storage-profiles-vsphere', [{ id: 'stp-1', name: 'dc1-vsan-standard', regionId: 'region-1', defaultItem: true }])],
    writes: ['POST /iaas/api/storage-profiles-vsphere'],
    secrets: ['vcfaApiToken'],
    check: (requests) => {
      const profile = bodyOf(requests, 'POST /iaas/api/storage-profiles-vsphere');
      expect(profile.storagePolicyId).toBe('sp-1');
      expect(profile.regionId).toBe('region-1');
      expect(profile.provisioningType).toBe('thin');
      expect(profile.defaultItem).toBe(true);
    },
  },
  {
    id: 'vcfa_catalog',
    settings: { sourceProjectId: 'proj-src', consumerProjectId: 'proj-use', integrationId: 'int-1' },
    routes: [
      list('/content/api/sources'),
      list('/catalog/api/admin/sources'),
      list('/policy/api/policies?typeId=com.vmware.policy.catalog.entitlement'),
      post('/content/api/sources', { id: 'git-1' }),
      post('/catalog/api/admin/sources', { id: 'cs-1' }),
      post('/policy/api/policies', { id: 'pol-1' }),
    ],
    existing: [
      list('/content/api/sources', [{ id: 'git-1', name: 'platform-templates-git' }]),
      list('/catalog/api/admin/sources', [{ id: 'cs-1', name: 'platform-templates' }]),
      list('/policy/api/policies?typeId=com.vmware.policy.catalog.entitlement', [{ id: 'pol-1', name: 'platform-templates — sharing' }]),
    ],
    writes: ['POST /content/api/sources', 'POST /catalog/api/admin/sources', 'POST /policy/api/policies'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const git = bodyOf(requests, 'POST /content/api/sources');
      expect(git.projectId).toBe('proj-src');
      expect(git.config.integrationId).toBe('int-1');
      expect(bodyOf(requests, 'POST /catalog/api/admin/sources').config).toEqual({ sourceProjectId: 'proj-src' });
      const sharing = bodyOf(requests, 'POST /policy/api/policies');
      expect(sharing.projectId).toBe('proj-use');
      expect(sharing.definition.entitledUsers[0].items).toEqual([{ id: 'cs-1', type: 'CATALOG_SOURCE_IDENTIFIER' }]);
      expect(sharing.definition.entitledUsers[0].principals).toEqual([{ type: 'GROUP', referenceId: 'vcfa-finance-users@example.com' }]);
      expect(run.outputs.sharingPolicyId).toBe('pol-1');
    },
  },
  {
    id: 'vcfa_naming',
    settings: {},
    routes: [list('/iaas/api/projects', [{ id: 'proj-1', name: 'a' }, { id: 'proj-2', name: 'b', orgId: 'org-uuid' }]), list('/iaas/api/naming'), post('/iaas/api/naming', { id: 'nm-1' })],
    existing: [list('/iaas/api/naming', [{ id: 'nm-1', name: 'standard-machine-names' }])],
    writes: ['POST /iaas/api/naming'],
    secrets: ['vcfaApiToken'],
    check: (requests) => {
      const naming = bodyOf(requests, 'POST /iaas/api/naming');
      expect(naming.projects).toEqual([{ defaultOrg: true, active: true, orgId: 'org-uuid' }]);
      expect(naming.templates[0].pattern).toBe('${project.name}-${resource.environment}-${###}');
      expect('counterScope' in naming.templates[0]).toBe(false);
    },
  },
  {
    id: 'vcfa_property_group',
    settings: { projectId: 'proj-1', importExample: true },
    routes: [
      list('/properties/api/property-groups'),
      post('/properties/api/property-groups', { id: 'pg-1' }),
      post('/blueprint/api/blueprint-validation', { valid: true, validationMessages: [] }),
      list('/blueprint/api/blueprints/bp-1/versions'),
      list('/blueprint/api/blueprints'),
      post('/blueprint/api/blueprints', { id: 'bp-1' }),
      post('/blueprint/api/blueprints/bp-1/versions', { id: 'bp-1', version: '1.0.0' }),
    ],
    existing: [
      list('/properties/api/property-groups', [{ id: 'pg-1', name: 'backupPolicy' }]),
      list('/blueprint/api/blueprints/bp-1/versions', [{ id: 'v', version: '1.0.0' }]),
      list('/blueprint/api/blueprints', [{ id: 'bp-1', name: 'backupPolicy property group example', projectId: 'proj-1' }]),
      get('/blueprint/api/blueprints/bp-1', { id: 'bp-1', content: groupYaml }),
    ],
    writes: ['POST /properties/api/property-groups', 'POST /blueprint/api/blueprints', 'POST /blueprint/api/blueprints/bp-1/versions'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const group = bodyOf(requests, 'POST /properties/api/property-groups');
      expect(group.type).toBe('CONSTANT');
      expect(group.properties.backupTier).toEqual({ type: 'string', const: 'silver' });
      const template = bodyOf(requests, 'POST /blueprint/api/blueprints');
      expect(template.content).toBe(groupYaml);
      expect(template.projectId).toBe('proj-1');
      expect(template.requestScopeOrg).toBe(false);
      expect(bodyOf(requests, 'POST /blueprint/api/blueprints/bp-1/versions').release).toBe(false);
      expect(run.outputs.exampleTemplateId).toBe('bp-1');
    },
  },
  {
    id: 'vcfa_cloud_template',
    settings: { projectId: 'proj-1', releaseTemplate: true },
    routes: [
      post('/blueprint/api/blueprint-validation', { valid: true, validationMessages: [] }),
      list('/blueprint/api/blueprints/bp-1/versions'),
      list('/blueprint/api/blueprints'),
      post('/blueprint/api/blueprints', { id: 'bp-1' }),
      post('/blueprint/api/blueprints/bp-1/versions', { id: 'bp-1', version: '1.0.0' }),
      list('/policy/api/policies?typeId=com.vmware.policy.deployment.lease'),
      post('/policy/api/policies', { id: 'lease-1' }),
    ],
    existing: [
      list('/blueprint/api/blueprints/bp-1/versions', [{ id: 'v', version: '1.0.0' }]),
      list('/blueprint/api/blueprints', [{ id: 'bp-1', name: 'Standard Linux server', projectId: 'proj-1' }]),
      get('/blueprint/api/blueprints/bp-1', { id: 'bp-1', content: templateYaml }),
      list('/policy/api/policies?typeId=com.vmware.policy.deployment.lease', [{ id: 'lease-1', name: 'Standard Linux server — lease', projectId: 'proj-1' }]),
    ],
    writes: ['POST /blueprint/api/blueprints', 'POST /blueprint/api/blueprints/bp-1/versions', 'POST /policy/api/policies'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const template = bodyOf(requests, 'POST /blueprint/api/blueprints');
      expect(template.name).toBe('Standard Linux server');
      expect(template.content).toBe(templateYaml);
      expect(bodyOf(requests, 'POST /blueprint/api/blueprints/bp-1/versions')).toEqual({ version: '1.0.0', description: template.description, changeLog: '', release: true });
      const lease = bodyOf(requests, 'POST /policy/api/policies');
      expect(lease.typeId).toBe('com.vmware.policy.deployment.lease');
      expect(lease.projectId).toBe('proj-1');
      expect(lease.definition).toEqual({ leaseGrace: 7, leaseTotalTermMax: 90, leaseTermMax: 90 });
      expect(run.outputs.templateId).toBe('bp-1');
      expect(run.outputs.leasePolicyId).toBe('lease-1');
    },
  },
  {
    id: 'vcfa_abx_action',
    settings: { projectId: 'proj-1' },
    routes: [
      get('/iaas/api/projects/proj-1', { id: 'proj-1', orgId: 'org-uuid' }),
      list('/abx/api/resources/actions'),
      list('/event-broker/api/subscriptions'),
      post('/abx/api/resources/actions', { id: 'act-1' }),
      // The event broker answers without a body: the id is the one the client chose.
      post('/event-broker/api/subscriptions', '', 201),
    ],
    existing: [
      list('/abx/api/resources/actions', [{ id: 'act-1', name: 'Register in the CMDB', projectId: 'proj-1' }]),
      get('/abx/api/resources/actions/act-1', { id: 'act-1', source: abxScript, runtime: 'python' }),
      list('/event-broker/api/subscriptions', [{ id: SUBSCRIPTION_ID, name: 'Register in the CMDB' }]),
    ],
    writes: ['POST /abx/api/resources/actions', 'POST /event-broker/api/subscriptions'],
    secrets: ['vcfaApiToken'],
    check: (requests, run) => {
      const action = bodyOf(requests, 'POST /abx/api/resources/actions');
      expect(action.orgId).toBe('org-uuid');
      expect(action.projectId).toBe('proj-1');
      expect(action.source).toBe(abxScript);
      expect(`${action.runtime} ${action.entrypoint} ${action.actionType} ${action.timeoutSeconds}`).toBe('python handler SCRIPT 30');
      const sub = bodyOf(requests, 'POST /event-broker/api/subscriptions');
      expect(sub.runnableId).toBe('act-1');
      expect(sub.id).toBe(SUBSCRIPTION_ID);
      expect(sub.disabled).toBe(false);
      expect(sub.eventTopicId).toBe('compute.provision.post');
      expect('criteria' in sub).toBe(false);
      expect(run.outputs.subscriptionId).toBe(SUBSCRIPTION_ID);
    },
  },
  {
    id: 'vcfa_approval_policy',
    settings: { projectId: 'proj-1', payloadOverrides: JSON.stringify({ 'approval-policy.json': { criteria: { matchExpression: [{ key: 'flavor', operator: 'eq', value: 'large' }] } } }) },
    routes: [list('/policy/api/policies?typeId=com.vmware.policy.approval'), post('/policy/api/policies', { id: 'ap-1' })],
    existing: [list('/policy/api/policies?typeId=com.vmware.policy.approval', [{ id: 'ap-1', name: 'Large deployments need approval', projectId: 'proj-1' }])],
    writes: ['POST /policy/api/policies'],
    secrets: ['vcfaApiToken'],
    check: (requests) => {
      const policy = bodyOf(requests, 'POST /policy/api/policies');
      expect(policy.typeId).toBe('com.vmware.policy.approval');
      expect(policy.projectId).toBe('proj-1');
      expect(policy.criteria).toEqual({ matchExpression: [{ key: 'flavor', operator: 'eq', value: 'large' }] });
      expect(policy.definition.approvers).toEqual(['GROUP:platform-leads@example.com']);
      expect(policy.definition.autoApprovalDecision).toBe('REJECT');
      expect('scopeCriteria' in policy).toBe(false);
    },
  },
];

// ---------------------------------------------------------------------------

describe('pkg vcfa-setup: every VCF Automation automation is an importable package', () => {
  for (const c of CASES) {
    it(`${c.id}: builds, parses, ES5, secrets empty, named in IMPORT.md`, () => {
      const files = build(c.id, c.values);
      const { dir, spec } = packageOf(files);
      expect(spec.name.startsWith('vcf.automation.vcfa.')).toBe(true);
      expect(spec.workflows.length).toBe(1);
      const problems: string[] = [];
      for (const pkg of Object.values(packagesIn(files)).map((p) => readPackageSpec(p))) {
        for (const a of pkg.actions) problems.push(...es5Problems(a.script, `${pkg.name}/${a.name}`));
        for (const w of pkg.workflows) {
          const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((x) => x[1]).join(''));
          expect(script.length).toBe(1);
          problems.push(...es5Problems(script[0]!, w.name));
        }
      }
      expect(problems).toEqual([]);
      const attributes = spec.configs[0]!.attributes;
      // Webhook URLs are SecureStrings too (a webhook's path can be its secret); vro.test.ts checks them for every automation.
      expect(attributes.filter((a) => a.type === 'SecureString' && a.name !== 'webhook').map((a) => a.name).sort()).toEqual([...c.secrets].sort());
      expect(attributes.filter((a) => a.type === 'SecureString').every((a) => a.value === undefined)).toBe(true);
      expect(attributes.find((a) => a.name === 'dryRun')?.value).toBe(false);
      expect(attributes.find((a) => a.name === 'cap')?.value).toBe(c.writes.length);
      for (const r of spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
      const md = files['IMPORT.md']!;
      expect(md.startsWith('# Importing this into VCF Automation')).toBe(true);
      expect(md.includes(`import/${dir}`)).toBe(true);
      expect(md.includes(`import/${CORE}`)).toBe(true);
      // Every import/ file is named, by its path, its folder or its file name.
      const unnamed = Object.keys(files).filter((p) => p.startsWith('import/') && !md.includes(p) && !md.includes(p.slice(0, p.lastIndexOf('/') + 1)) && !md.includes(p.split('/').pop()!));
      expect(unnamed).toEqual([]);
      // The fallback script reads its payloads beside it.
      if (files['scripts/apply.sh']) expect(files['scripts/apply.sh']!.includes('cd "$(dirname "$0")"')).toBe(true);
      for (const [p, body] of Object.entries(files)) if (p.endsWith('.json')) JSON.parse(body);
    });
  }
});

describe('pkg vcfa-setup: every workflow runs against a fake VCF Automation', { skip: !CURL }, () => {
  for (const c of CASES) {
    const files = build(c.id, c.values);
    const first = c.writes[0]!.split(' ');
    const failFirst: FakeRoute = { method: first[0]!, path: `^${esc(first[1]!)}(\\?|$)`, status: 500, body: { message: `refused for ${TOKEN}` } };

    it(`${c.id}: with the dryRun input set, it reads, plans every change, and writes nothing`, async () => {
      const { result, writes, requests } = await runWith(files, c.routes, c.settings, { dryRun: true });
      expect(result.error).toBe(null);
      expect(writes).toEqual([]);
      expect(requests.some((r) => r.method === 'GET')).toBe(true);
      expect(result.logs.filter((l) => l.message.startsWith('DRY RUN: would ')).length).toBe(c.writes.length);
      expect(result.logs.some((l) => l.message.startsWith('A live run would stop'))).toBe(false);
      for (const [name, value] of Object.entries(result.outputs)) if (name !== 'summary') expect(value).toBe('');
    });

    it(`${c.id}: the dryRun input keeps an armed configuration safe`, async () => {
      const { writes } = await runWith(files, c.routes, { ...c.settings, dryRun: false, cap: 10 }, { dryRun: true });
      expect(writes).toEqual([]);
    });

    it(`${c.id}: armed, it makes exactly the expected calls, in order, with the right bodies`, async () => {
      const { result, writes, requests } = await runWith(files, c.routes, { ...c.settings, dryRun: false });
      expect(result.error).toBe(null);
      expect(writes).toEqual(c.writes);
      expect(requests.filter((r) => !/^\/(tm\/)?oauth\//.test(r.path) && r.path !== '/hook').every((r) => r.headers.authorization === `Bearer ${ACCESS}`)).toBe(true);
      expect(requests[0]!.body).toBe(`grant_type=refresh_token&refresh_token=${TOKEN}`);
      c.check(requests, result);
      const summary = JSON.parse(String(result.outputs.summary)) as { changes: unknown[]; dryRun: boolean };
      expect(summary.dryRun).toBe(false);
      expect(summary.changes.length).toBe(c.writes.length);
      expect(requests.some((r) => r.path === '/hook')).toBe(true);
    });

    it(`${c.id}: leaves what exists alone`, async () => {
      const { result, writes } = await runWith(files, [...c.existing, ...c.routes], { ...c.settings, dryRun: false });
      expect(result.error).toBe(null);
      expect(writes).toEqual([]);
    });

    it(`${c.id}: stops at the cap, before the change that would exceed it`, async () => {
      const cap = c.writes.length - 1;
      const { result, writes } = await runWith(files, c.routes, { ...c.settings, dryRun: false, cap });
      expect(writes).toEqual(c.writes.slice(0, cap));
      expect(result.error ?? '').toContain(`Cap reached: ${cap} change(s) made, the cap is ${cap}`);
    });

    it(`${c.id}: stops at the first failure and says what failed`, async () => {
      const { result, writes } = await runWith(files, [failFirst, ...c.routes], { ...c.settings, dryRun: false });
      expect(writes).toEqual([c.writes[0]!]);
      expect(result.error ?? '').toContain('Stopped after 0 change(s)');
      expect(result.error ?? '').toContain('returned HTTP 500');
    });
  }
});

// ---------------------------------------------------------------------------
// What is particular to each.

describe('pkg vcfa-setup: the particular cases', { skip: !CURL }, () => {
  const zone = CASES.find((c) => c.id === 'vcfa_cloud_zone')!;
  const zoneFiles = build('vcfa_cloud_zone');

  it('login: falls back to /tm/oauth/tenant/<org>/token when /oauth answers 404', async () => {
    const { result, requests, writes } = await runWith(zoneFiles, [{ method: 'POST', path: '^/oauth/tenant/org1/token$', status: 404, body: { message: 'not here' } }, { method: 'POST', path: '^/tm/oauth/tenant/org1/token$', body: { access_token: ACCESS } }, ...zone.routes], { ...zone.settings, dryRun: false });
    expect(result.error).toBe(null);
    expect(requests.slice(0, 2).map((r) => r.path)).toEqual(['/oauth/tenant/org1/token', '/tm/oauth/tenant/org1/token']);
    expect(writes).toEqual(['POST /iaas/api/zones']);
  });

  it('refuses a placeholder: a dry run warns, a live run changes nothing', async () => {
    const dry = await runWith(zoneFiles, zone.routes, {}, { dryRun: true });
    expect(dry.result.error).toBe(null);
    expect(dry.result.logs.some((l) => l.level === 'warn' && l.message.includes('zone.json regionId: <REQUIRED'))).toBe(true);
    const live = await runWith(zoneFiles, zone.routes, { dryRun: false });
    expect(live.writes).toEqual([]);
    expect(live.result.error ?? '').toContain('Nothing was changed: 1 value(s) are still placeholders');
  });

  it('refuses a partial list and an ambiguous match', async () => {
    const partial = await runWith(zoneFiles, [{ method: 'GET', path: '^/iaas/api/zones\\?', responses: [{ body: { content: [{ id: 'z', name: 'other' }], totalElements: 5 } }, { body: { content: [], totalElements: 5 } }] }, ...zone.routes], { ...zone.settings, dryRun: false });
    expect(partial.writes).toEqual([]);
    expect(partial.result.error ?? '').toContain('Paging stopped at 1 of 5 items');
    const twice = await runWith(zoneFiles, [list('/iaas/api/zones', [{ id: 'z1', name: 'dc1-general' }, { id: 'z2', name: 'DC1-general' }]), ...zone.routes], { ...zone.settings, dryRun: false });
    expect(twice.writes).toEqual([]);
    expect(twice.result.error ?? '').toContain('refusing to guess');
  });

  it('refuses a list answer that is neither an array nor has a content array, rather than read it as empty (regression)', async () => {
    const odd = await runWith(zoneFiles, [{ method: 'GET', path: '^/iaas/api/zones\\?', body: { items: [{ id: 'zone-1', name: 'dc1-general' }] } }, ...zone.routes], { ...zone.settings, dryRun: false });
    expect(odd.writes).toEqual([]);
    expect(odd.result.error ?? '').toContain('GET /iaas/api/zones returned neither a list nor a content list');
    // A bare array is still the whole list.
    const bare = await runWith(zoneFiles, [{ method: 'GET', path: '^/iaas/api/zones\\?', body: [{ id: 'zone-1', name: 'dc1-general' }] }, ...zone.routes], { ...zone.settings, dryRun: false });
    expect(bare.result.error).toBe(null);
    expect(bare.writes).toEqual([]);
  });

  it('pages through the IaaS API with $top and $skip until totalElements', async () => {
    const page = (skip: number, items: unknown[]): FakeRoute => ({ method: 'GET', path: `^/iaas/api/zones\\?apiVersion=2021-07-15&\\$top=200&\\$skip=${skip}$`, body: { content: items, totalElements: 201 } });
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `z${i}`, name: `zone-${i}` }));
    const { result, writes, requests } = await runWith(zoneFiles, [page(0, many), page(200, [{ id: 'z-last', name: 'dc1-general' }]), ...zone.routes], { ...zone.settings, dryRun: false });
    expect(result.error).toBe(null);
    expect(requests.filter((r) => r.path.startsWith('/iaas/api/zones?')).length).toBe(2);
    expect(writes).toEqual([]);
  });

  it('cloud account: a vCenter already registered under another name is used, not added twice', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_cloud_account')!;
    const { result, writes, requests } = await runWith(build(c.id), [list('/iaas/api/cloud-accounts-vsphere', [{ id: 'ca-vcf', name: 'vcf-wld01', hostName: 'WLD01-VC.example.com' }]), ...c.routes], { ...c.settings, dryRun: false });
    expect(result.error).toBe(null);
    expect(writes).toEqual(['POST /iaas/api/cloud-accounts-nsx-t']);
    expect(bodyOf(requests, 'POST /iaas/api/cloud-accounts-nsx-t').associatedCloudAccountIds).toEqual(['ca-vcf']);
  });

  it('cloud account: no password means no change, and a failed request tracker stops the run', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_cloud_account')!;
    const files = build(c.id);
    const none = await runWith(files, c.routes, { dryRun: false });
    expect(none.writes).toEqual([]);
    expect(none.result.error ?? '').toContain('vsphere.json password: <REQUIRED — vspherePassword');
    const failed = await runWith(files, [{ method: 'GET', path: '^/iaas/api/request-tracker/rt-1$', body: { id: 'rt-1', status: 'FAILED', message: 'certificate not trusted', selfLink: '/iaas/api/request-tracker/rt-1' } }, ...c.routes], { ...c.settings, dryRun: false });
    expect(failed.writes).toEqual(['POST /iaas/api/cloud-accounts-vsphere']);
    expect(failed.result.error ?? '').toContain('failed: certificate not trusted');
  });

  it('cloud account: every datacenter needs the regions setting before it can be created', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_cloud_account')!;
    const files = build(c.id, { enable_all: true });
    const without = await runWith(files, c.routes, { ...c.settings, dryRun: false });
    expect(without.writes).toEqual([]);
    const withRegions = await runWith(files, c.routes, { ...c.settings, dryRun: false, regions: 'Datacenter:datacenter-3, Datacenter:datacenter-21' });
    expect(withRegions.result.error).toBe(null);
    expect(bodyOf(withRegions.requests, 'POST /iaas/api/cloud-accounts-vsphere').regions.map((r: { externalRegionId: string }) => r.externalRegionId)).toEqual(['Datacenter:datacenter-3', 'Datacenter:datacenter-21']);
  });

  it('mappings: an image not found exactly once in the region stops a live run', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_mappings')!;
    const { writes, result } = await runWith(build(c.id), [list('/iaas/api/fabric-images', [{ id: 'img-rhel', name: 'tpl-rhel9-hardened', externalRegionId: 'Datacenter:datacenter-3' }]), ...c.routes], { ...c.settings, dryRun: false });
    expect(writes).toEqual([]);
    expect(result.error ?? '').toContain('0 images named tpl-ubuntu-2404');
  });

  it('storage profile: warns about a second default in the region', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_storage_profile')!;
    const { result, writes } = await runWith(build(c.id), [list('/iaas/api/storage-profiles-vsphere', [{ id: 'old', name: 'legacy-default', regionId: 'region-1', defaultItem: true }]), ...c.routes], { ...c.settings, dryRun: false });
    expect(writes).toEqual(['POST /iaas/api/storage-profiles-vsphere']);
    expect(result.logs.some((l) => l.level === 'warn' && l.message.includes('"legacy-default" is already the default'))).toBe(true);
  });

  it('cloud template: a changed template updates the draft and adds the version; an invalid one changes nothing', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_cloud_template')!;
    const changed = await runWith(templateFiles, [list('/blueprint/api/blueprints', [{ id: 'bp-1', name: 'Standard Linux server', projectId: 'proj-1' }]), get('/blueprint/api/blueprints/bp-1', { id: 'bp-1', content: 'formatVersion: 1\n' }), { method: 'PUT', path: '^/blueprint/api/blueprints/bp-1$', body: { id: 'bp-1' } }, ...c.routes], { ...c.settings, dryRun: false });
    expect(changed.result.error).toBe(null);
    expect(changed.writes).toEqual(['PUT /blueprint/api/blueprints/bp-1', 'POST /blueprint/api/blueprints/bp-1/versions', 'POST /policy/api/policies']);
    expect(bodyOf(changed.requests, 'PUT /blueprint/api/blueprints/bp-1').content).toBe(templateYaml);
    const invalid = await runWith(templateFiles, [post('/blueprint/api/blueprint-validation', { valid: false, validationMessages: [{ type: 'ERROR', message: 'flavor is not an input' }] }), ...c.routes], { ...c.settings, dryRun: false });
    expect(invalid.writes).toEqual([]);
    expect(invalid.result.error ?? '').toContain('ERROR: flavor is not an input');
  });

  it('cloud template and ABX action: a live run without a project changes nothing', async () => {
    for (const id of ['vcfa_cloud_template', 'vcfa_abx_action']) {
      const c = CASES.find((x) => x.id === id)!;
      const { writes, result } = await runWith(build(id), c.routes, { dryRun: false });
      expect(writes).toEqual([]);
      expect(result.error ?? '').toContain('Set projectId');
    }
  });

  it('ABX action: a changed script is updated in place, with its id', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_abx_action')!;
    const { result, writes, requests } = await runWith(abxFiles, [list('/abx/api/resources/actions', [{ id: 'act-1', name: 'Register in the CMDB', projectId: 'proj-1' }]), get('/abx/api/resources/actions/act-1', { id: 'act-1', source: 'old', runtime: 'python' }), { method: 'PUT', path: '^/abx/api/resources/actions/act-1$', body: { id: 'act-1' } }, ...c.routes], { ...c.settings, dryRun: false });
    expect(result.error).toBe(null);
    expect(writes).toEqual(['PUT /abx/api/resources/actions/act-1', 'POST /event-broker/api/subscriptions']);
    const put = bodyOf(requests, 'PUT /abx/api/resources/actions/act-1');
    expect(put.id).toBe('act-1');
    expect(put.source).toBe(abxScript);
  });

  it('approval policy: the criteria placeholder is never sent', async () => {
    const c = CASES.find((x) => x.id === 'vcfa_approval_policy')!;
    const files = build(c.id);
    const dry = await runWith(files, c.routes, { projectId: 'proj-1' }, { dryRun: true });
    expect(dry.result.logs.filter((l) => l.level === 'warn' && l.message.includes('criteria.matchExpression.0')).length).toBe(2);
    const live = await runWith(files, c.routes, { projectId: 'proj-1', dryRun: false });
    expect(live.writes).toEqual([]);
    expect(live.result.error ?? '').toContain('Nothing was changed');
    // "Always" has no criteria to fill: it goes with the project alone.
    const always = await runWith(build(c.id, { when: 'always' }), c.routes, { projectId: 'proj-1', dryRun: false });
    expect(always.result.error).toBe(null);
    expect('criteria' in bodyOf(always.requests, 'POST /policy/api/policies')).toBe(false);
  });
});

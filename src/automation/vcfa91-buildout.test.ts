/**
 * The VCF Automation 9.1 build-out: the All Apps policies, provider
 * infrastructure policies, organization access, Avi load balancing, transit
 * gateway services, Live Recovery, VKS Velero and namespace objects, and the
 * deepened organization, VPC and security policy blueprints.
 *
 * For each: every variant the page can produce builds, its scripts parse as
 * bash, its JSON parses, its Orchestrator workflow is ES5, and the traps it
 * knows about are reported. Four of the workflows are then run in the
 * emulator against a fake server: what they write, what they leave alone, and
 * that no secret reaches a log line.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { readPackageSpec } from '../kit/vro-package.ts';
import { automationFor } from './blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../testing/fake-rest-server.ts';

const NEW = [
  'vcfa91_iaas_resource_policy',
  'vcfa91_infrastructure_policy',
  'vcfa91_org_users_roles',
  'vcfa91_avi_load_balancer',
  'vcfa91_transit_gateway',
  'vcfa91_live_recovery',
  'vcfa91_vks_velero',
  'vcfa91_namespace_object',
] as const;
const DEEPENED = ['vcfa91_organization', 'vcfa91_vpc', 'vcfa91_security_policy'] as const;

const has = (cmd: string): boolean => {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
};
const BASH = has('bash');
const CURL = has('curl');

function blueprintOf(id: string) {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return blueprint;
}
function build(id: string, overrides: BlueprintValues = {}) {
  const blueprint = blueprintOf(id);
  return blueprint.build({ ...defaultValues(blueprint), ...overrides }, id);
}
/** Every finding, info included (the page drops info; the automation keeps it). */
function codes(id: string, overrides: BlueprintValues = {}): string[] {
  const blueprint = blueprintOf(id);
  return (blueprint.automation({ ...defaultValues(blueprint), ...overrides }, id).findings ?? []).map((f) => f.code);
}
function variants(id: string): { label: string; values: BlueprintValues }[] {
  const blueprint = blueprintOf(id);
  const base = defaultValues(blueprint);
  const out = [{ label: 'defaults', values: base }];
  for (const input of blueprint.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
    if (input.control === 'toggle') out.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
  }
  return out;
}
function workflowScript(xml: string): string {
  const m = /<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/.exec(xml);
  return m ? [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join('') : '';
}
const all = (files: Readonly<Record<string, string>>) => Object.values(files).join('\n');

// ---------------------------------------------------------------------------

describe('vcfa91 build-out: every variant builds, parses and is ES5', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcfa91-'));
  let n = 0;
  for (const id of [...NEW, ...DEEPENED]) {
    it(`${id}: builds clean from its defaults, and every option builds`, () => {
      expect(hasErrors(build(id).findings ?? [])).toBe(false);
      const problems: string[] = [];
      for (const { label, values } of variants(id)) {
        const out = blueprintOf(id).build(values, id);
        if (!out.files['IMPORT.md']?.startsWith('# Importing this into VCF Automation')) problems.push(`${label}: no IMPORT.md`);
        if (!out.files['README.md']) problems.push(`${label}: no README`);
        for (const [file, body] of Object.entries(out.files)) {
          if (file.endsWith('.json')) {
            try {
              JSON.parse(body);
            } catch {
              problems.push(`${label}: ${file} is not JSON`);
            }
          }
          if (file.endsWith('.sh') && !file.startsWith('import/')) {
            if (!file.startsWith('scripts/')) problems.push(`${label}: ${file} is not under scripts/`);
            if (!body.startsWith('#!/usr/bin/env bash')) problems.push(`${label}: ${file} has no shebang`);
            if (!/--dry-run/.test(body) && !/Reads only/.test(body)) problems.push(`${label}: ${file} neither reads only nor has --dry-run`);
            if (BASH) {
              const path = join(dir, `${n++}.sh`).split('\\').join('/');
              writeFileSync(path, body);
              try {
                execFileSync('bash', ['-n', path], { stdio: 'pipe' });
              } catch (e) {
                problems.push(`${label}: ${file} does not parse: ${String((e as { stderr?: unknown }).stderr).slice(0, 200)}`);
              }
            }
          }
        }
        for (const [pkgDir, pkg] of Object.entries(packagesIn(out.files))) {
          if (pkgDir === 'vcf.automation.core.package') continue;
          const spec = readPackageSpec(pkg);
          problems.push(...es5Problems(workflowScript(spec.workflows[0]!.xml), `${id} ${label}`));
          for (const a of spec.configs[0]!.attributes) {
            if (a.type === 'SecureString' && a.value !== undefined) problems.push(`${label}: ${a.name} carries a value`);
            if (/token|password|secret|psk/i.test(a.name) && a.type !== 'SecureString') problems.push(`${label}: ${a.name} is not a SecureString`);
          }
          new VroEmulator(out.files);
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it('adds the new blueprints to the VCF Automation 9.1 group, each with its own id', () => {
    for (const id of NEW) expect(automationFor(id)?.platform).toBe('vcf-automation');
  });
});

// ---------------------------------------------------------------------------

describe('vcfa91 build-out: policies', () => {
  it('IaaS Resource: CEL rules for what is allowed, created through /policy/api with the type found by name', () => {
    const files = build('vcfa91_iaas_resource_policy').files;
    const body = JSON.parse(files['iaas-resource-policy.json']!) as { definition: { validationActions: string[]; validations: { expression: string }[] } };
    expect(body.definition.validationActions).toEqual(['Deny']);
    const expressions = body.definition.validations.map((v) => v.expression).join('\n');
    expect(expressions).toContain("object.spec.className in ['best-effort-small', 'best-effort-medium', 'best-effort-large']");
    expect(expressions).toContain('md.replicas <= 10');
    expect(expressions).toContain("int(object.spec.topology.version.split('.')[1]) >= 32");
    // Data Services and load balancers are not ticked, so their kinds are refused.
    expect(expressions).toContain("!(object.kind in ['PostgresCluster', 'MySQLCluster']) || (false)");
    expect(files['scripts/apply-policy.sh']).toContain('/policy/api/policyTypes');
    expect(files['scripts/apply-policy.sh']).toContain('PROJECT_ID');
    expect(files['iaas-resource-policy.vap.yaml']).toContain('kind: ValidatingAdmissionPolicyBinding');
  });

  it('IaaS Resource: flags a project scope with no project, a policy that allows nothing, and a trial enforcement', () => {
    expect(codes('vcfa91_iaas_resource_policy', { project: '' })).toContain('vcfa91.iaas.no-project');
    expect(codes('vcfa91_iaas_resource_policy', { services: '' })).toContain('vcfa91.iaas.nothing-allowed');
    expect(codes('vcfa91_iaas_resource_policy', { enforcement: 'Warn' })).toContain('vcfa91.iaas.not-deny');
    expect(codes('vcfa91_iaas_resource_policy', { min_k8s_minor: 27 })).toContain('vcfa91.iaas.old-k8s');
  });

  it('Infrastructure policy: compute policy by tag, provider policy, and Deployment Criteria only when optional', () => {
    const optional = build('vcfa91_infrastructure_policy').files;
    expect(JSON.parse(optional['compute-policy.json']!).capability).toBe('com.vmware.vcenter.compute.policies.capabilities.vm_host_affinity');
    expect(JSON.parse(optional['infrastructure-policy.json']!).enforcement).toBe('OPTIONAL');
    const criteria = JSON.parse(optional['deployment-criteria.json']!) as { definition: { criteria: { field: string; value: unknown }[] } };
    expect(criteria.definition.criteria.map((c) => c.field)).toEqual(['vmClass', 'label']);
    expect(criteria.definition.criteria[0]!.value).toEqual(['gpu-a100-small', 'gpu-a100-large']);
    expect(optional['scripts/create-compute-policy.sh']).toContain('list-tags-for-category');
    expect(optional['scripts/apply-infrastructure-policy.sh']).toContain('By hand: Provider portal');
    const mandatory = build('vcfa91_infrastructure_policy', { mandatory: true }).files;
    expect(mandatory['deployment-criteria.json']).toBe(undefined);
    expect(JSON.parse(mandatory['infrastructure-policy.json']!).enforcement).toBe('MANDATORY');
    const vmvm = build('vcfa91_infrastructure_policy', { capability: 'vm_vm_anti_affinity' }).files;
    expect('host_tag' in JSON.parse(vmvm['compute-policy.json']!)).toBe(false);
  });

  it('Infrastructure policy: catches bad tags, criteria and a mandatory affinity', () => {
    expect(codes('vcfa91_infrastructure_policy', { host_tag: 'gpu' })).toContain('vcfa91.infra.host-tag');
    expect(codes('vcfa91_infrastructure_policy', { criteria: 'colour | equals | blue' })).toContain('vcfa91.infra.criteria-field');
    expect(codes('vcfa91_infrastructure_policy', { criteria: '' })).toContain('vcfa91.infra.no-criteria');
    expect(codes('vcfa91_infrastructure_policy', { mandatory: true })).toContain('vcfa91.infra.mandatory-affinity');
    expect(codes('vcfa91_infrastructure_policy', { region_quotas: '' })).toContain('vcfa91.infra.no-quota');
  });
});

describe('vcfa91 build-out: organization access', () => {
  it('imports groups with their organization role and gives project roles as ProjectRoleBindings', () => {
    const files = build('vcfa91_org_users_roles').files;
    const access = JSON.parse(files['access.json']!) as { principals: { name: string; role: string }[]; bindings: { object: { metadata: { name: string; namespace: string }; roleRef: { name: string } } }[] };
    expect(access.principals.map((p) => `${p.name}:${p.role}`)).toEqual(['vcfa-team-a-admins:Organization Administrator', 'team-a-devs:Organization User', 'team-a-auditors:Organization Auditor']);
    expect(access.bindings.map((b) => `${b.object.metadata.name}@${b.object.metadata.namespace}:${b.object.roleRef.name}`)).toEqual(['cci:group:team-a-devs@web-shop:edit', 'cci:group:team-a-auditors@web-shop:view']);
    expect(files['project-role-bindings.k8s.yaml']).toContain('kind: ProjectRoleBinding');
    const custom = build('vcfa91_org_users_roles', { custom_role: true }).files;
    expect(custom['scripts/apply-org-access.sh']).toContain('/cloudapi/1.0.0/roles/${NEW_ID}/rights');
  });

  it('flags a wrong project role, no administrator group, and a custom role with no rights', () => {
    expect(codes('vcfa91_org_users_roles', { assignments: 'devs | group | Organization User | web | owner' })).toContain('vcfa91.access.project-role');
    expect(codes('vcfa91_org_users_roles', { assignments: 'devs | group | Organization User | web | edit' })).toContain('vcfa91.access.no-admin');
    expect(codes('vcfa91_org_users_roles', { custom_role: true, custom_rights: '' })).toContain('vcfa91.access.no-rights');
  });
});

describe('vcfa91 build-out: networking', () => {
  it('Avi: an L4 VirtualMachineService with an L4Rule health monitor, the quota checked first', () => {
    const files = build('vcfa91_avi_load_balancer').files;
    const yaml = files['web-lb.k8s.yaml']!;
    expect(yaml).toContain('kind: VirtualMachineService');
    expect(yaml).toContain('type: LoadBalancer');
    expect(yaml).toContain('kind: L4Rule');
    expect(yaml).toContain('ako.vmware.com/l4rule: web-lb-rule');
    expect(files['scripts/create-lb.sh']).toContain('services.loadbalancers');
  });

  it('Avi: an L7 Ingress with TLS and an HTTPRule; dual stack on a pod Service', () => {
    const l7 = build('vcfa91_avi_load_balancer', { layer: 'L7', health: 'System-HTTP' }).files['web-lb.k8s.yaml']!;
    expect(l7).toContain('kind: Ingress');
    expect(l7).toContain('secretName: shop-tls');
    expect(l7).toContain('kind: HTTPRule');
    const dual = build('vcfa91_avi_load_balancer', { backend: 'service', dual_stack: true }).files['web-lb.k8s.yaml']!;
    expect(dual).toContain('ipFamilyPolicy: RequireDualStack');
    expect(codes('vcfa91_avi_load_balancer', { selector: '' })).toContain('vcfa91.avi.no-selector');
    expect(codes('vcfa91_avi_load_balancer', { layer: 'L7', tls_secret: '' })).toContain('vcfa91.avi.no-tls');
    expect(codes('vcfa91_avi_load_balancer', { vip: '300.1.1.1' })).toContain('vcfa91.avi.vip');
  });

  it('Transit gateway: NAT rules, an IPsec VPN whose key is never written, and an external connection', () => {
    const out = build('vcfa91_transit_gateway', { external: true });
    const files = out.files;
    expect(JSON.parse(files['nsx/nat-dnat-2.json']!).service).toBe('/orgs/default/projects/team-a/infra/services/nat-tcp-443');
    const session = JSON.parse(files['nsx/ipsec-session.json']!) as Record<string, unknown>;
    expect(session.resource_type).toBe('PolicyBasedIPSecVpnSession');
    expect('psk' in session).toBe(false);
    expect(files['scripts/apply-tgw.sh']).toContain('IPSEC_PSK_FILE');
    expect(JSON.parse(files['nsx/attachment-provider-gw-01.json']!).connection_path).toBe('/infra/gateway-connections/provider-gw-01');
    expect(codes('vcfa91_transit_gateway', { nat_rules: 'SNAT | 2001:db8::/32 | any | 2001:db8::1 | any' })).toContain('vcfa91.tgw.nat-ipv6');
    expect(codes('vcfa91_transit_gateway', { nat_rules: 'MASQ | any | any | 1.2.3.4 | any' })).toContain('vcfa91.tgw.nat-action');
    expect(codes('vcfa91_transit_gateway', { ike_version: 'IKE_V1', ike_encryption: 'AES_GCM_256' })).toContain('vcfa91.tgw.gcm-v1');
    // IPv6 networks through the tunnel are accepted.
    expect(codes('vcfa91_transit_gateway', { local_cidrs: '2001:db8:10::/48', remote_cidrs: '2001:db8:20::/48' }).includes('vcfa91.tgw.vpn-cidr')).toBe(false);
  });

  it('VPC: several CIDRs in one block, reserved ranges, a VLAN connection, and IPv6 refused', () => {
    const files = build('vcfa91_vpc', { include_ip_block: true, ip_block_cidr: '203.0.113.0/24, 198.51.100.0/24', ip_block_ranges: '203.0.113.64-203.0.113.127' }).files;
    expect((files['ip-block.tf']!.match(/cidr_blocks \{/g) ?? []).length).toBe(2);
    expect(JSON.parse(files['nsx/ip-block-ranges.json']!).range_list).toEqual([{ start: '203.0.113.64', end: '203.0.113.127' }]);
    expect(files['scripts/ip-block-ranges.sh']).toContain('reserved_ips');
    expect(codes('vcfa91_vpc', { include_ip_block: true, ip_block_cidr: '203.0.113.0/24, 2001:db8::/48' })).toContain('vcfa91.vpc.ipv6');
    expect(codes('vcfa91_vpc', { include_ip_block: true, ip_block_reserved: '203.0.113.1-banana' })).toContain('vcfa91.vpc.range');
    const vlan = build('vcfa91_vpc', { connectivity: 'distributed-vlan', subnets: 'web: Public: 16', vlan_connection: true }).files;
    expect(JSON.parse(vlan['nsx/vlan-connection-vlan-120-external.json']!).vlan_ids).toEqual(['120']);
    expect(codes('vcfa91_vpc', { connectivity: 'distributed-vlan', subnets: 'web: Public: 16', vlan_connection: true, vlan_ids: '5000' })).toContain('vcfa91.vpc.vlan-id');
    expect(codes('vcfa91_vpc', { include_ip_block: true, ipam: 'infoblox' })).toContain('vcfa91.vpc.infoblox');
  });

  it('Security policy: allow, drop and reject, destinations and port ranges; the defaults unchanged', () => {
    const def = JSON.parse(Object.entries(build('vcfa91_security_policy').files).find(([p]) => p.endsWith('/policy.json'))![1]) as { object: { spec: { rules: { name: string; action: string }[] } } }[];
    expect(def[0]!.object.spec.rules.map((r) => `${r.name}:${r.action}`)).toEqual(['allow-tcp-443-1:Allow', 'allow-tcp-22-2:Allow', 'drop-other-inbound:Drop']);
    const files = build('vcfa91_security_policy', { rules: 'drop from 10.0.0.0/8 to app=db tcp/5432-5433\nreject from app=x any' }).files;
    const yaml = files['web-tier.k8s.yaml']!;
    expect(yaml).toContain('action: Drop');
    expect(yaml).toContain('action: Reject');
    expect(yaml).toContain('endPort: 5433');
    expect(yaml).toContain('destinations:');
  });

  it('Security policy: a gateway firewall on the transit gateway, by CIDR only', () => {
    const files = build('vcfa91_security_policy', { gateway_firewall: true }).files;
    const policy = JSON.parse(files['nsx/gateway-policy-web-tier.json']!) as { category: string; rules: { action: string; scope: string[] }[] };
    expect(policy.category).toBe('LocalGatewayRules');
    expect(policy.rules.map((r) => r.action)).toEqual(['ALLOW', 'ALLOW', 'DROP']);
    expect(policy.rules[0]!.scope).toEqual(['/orgs/default/projects/team-a/transit-gateways/default']);
    expect(files['scripts/apply-gateway-firewall.sh']).toContain('NSX_PASSWORD_FILE');
    expect(codes('vcfa91_security_policy', { gateway_firewall: true, gateway_rules: 'ALLOW | app=web | any | any' })).toContain('vcfa91.sp.gw-label');
    expect(codes('vcfa91_security_policy', { gateway_firewall: true, gateway_rules: 'ALLOW | any | any | any' })).toContain('vcfa91.sp.gw-any');
  });
});

describe('vcfa91 build-out: the organization, deepened', () => {
  it('writes identity as Terraform with the secret from TF_VAR_, never in a file', () => {
    const oidc = build('vcfa91_organization').files['identity.tf']!;
    expect(oidc).toContain('resource "vcfa_org_oidc"');
    expect(oidc).toContain('client_secret      = var.oidc_client_secret');
    const ldap = build('vcfa91_organization', { identity: 'ldap' }).files['identity.tf']!;
    expect(ldap).toContain('resource "vcfa_org_ldap"');
    expect(ldap).toContain('password                = var.ldap_bind_password');
    expect(build('vcfa91_organization', { identity: 'saml' }).files['identity.tf']).toBe(undefined);
    expect(codes('vcfa91_organization', { identity: 'saml' })).toContain('vcfa91.org.saml');
  });

  it('sets the 9.1 delegation and networking where the API answers, and prints the portal steps where not', () => {
    const files = build('vcfa91_organization').files;
    const settings = JSON.parse(files['org-91-settings.json']!) as { what: string }[];
    expect(settings.map((s) => s.what)).toEqual(['Avi load balancing, quota 10', 'vDefend delegation (distributed on, gateway on)', 'external connection internet', 'default private VPC and transit gateway IP blocks']);
    expect(files['scripts/apply-org-91.sh']).toContain('NO API on this release');
    expect(build('vcfa91_organization', { org_type: 'vm-apps' }).files['org-91-settings.json']).toBe(undefined);
    expect(codes('vcfa91_organization', { private_vpc_block: 'fd00::/48' })).toContain('vcfa91.org.private-ipv6');
    expect(codes('vcfa91_organization', { external_connections: 'internet | provider-gw-01 | region1-external\nbackup | provider-gw-02 | region1-backup' })).toContain('vcfa91.org.multi-external');
  });

  it('keeps the organization workflow and its body exactly as before', () => {
    const org = JSON.parse(build('vcfa91_organization').files['org.json']!);
    expect(org).toEqual({ name: 'team-a', displayName: 'Team A', description: '', isEnabled: true, canManageOrgs: false, isClassicTenant: false });
  });
});

describe('vcfa91 build-out: protection and namespace objects', () => {
  it('Live Recovery: replication spec, pairing and datastore lookups, protection group; flags too many copies', () => {
    const files = build('vcfa91_live_recovery').files;
    expect(JSON.parse(files['replication-spec.json']!)).toEqual({ rpo: 15, mpit_enabled: true, mpit_instances: 3, mpit_days: 5, network_compression_enabled: true, lwd_encryption_enabled: true, auto_replicate_new_disks: true, quiesce_enabled: false });
    const script = files['scripts/protect.sh']!;
    expect(script).toContain('/api/vcenter/resource-pool?names=');
    expect(script).toContain('protection-groups');
    expect(script.includes('x-dr-session: %s')).toBe(true);
    expect(build('vcfa91_live_recovery', { select_by: 'tag' }).files['scripts/protect.sh']).toContain('list-attached-objects');
    expect(codes('vcfa91_live_recovery', { mpit_instances: 6, mpit_days: 5 })).toContain('vcfa91.lr.mpit');
    expect(codes('vcfa91_live_recovery', { encryption: false })).toContain('vcfa91.lr.clear');
  });

  it('Velero: package values with no keys in them, a Schedule with retention, credentials from files', () => {
    const files = build('vcfa91_vks_velero').files;
    expect(files['velero-values.yaml']).toContain('existingSecret: velero-s3');
    expect(/aws_secret_access_key\s*=\s*\w/.test(files['velero-values.yaml']!)).toBe(false);
    expect(files['velero-schedule.k8s.yaml']).toContain('ttl: 720h0m0s');
    expect(files['velero-schedule.k8s.yaml']).toContain('defaultVolumesToFsBackup: true');
    expect(files['scripts/install-velero.sh']).toContain('S3_SECRET_KEY_FILE');
    expect(codes('vcfa91_vks_velero', { bucket: 'Bad_Bucket' })).toContain('vcfa91.velero.bucket');
    expect(codes('vcfa91_vks_velero', { s3_url: 'http://s3.example.com' })).toContain('vcfa91.velero.http');
    expect(codes('vcfa91_vks_velero', { volumes: 'none' })).toContain('vcfa91.velero.no-data');
  });

  it('Namespace objects: a PVC, a VM service, and a Secret with no value in any file', () => {
    expect(build('vcfa91_namespace_object').files['data-01.k8s.yaml']).toContain('storage: 50Gi');
    expect(build('vcfa91_namespace_object', { kind: 'vmservice' }).files['data-01.k8s.yaml']).toContain('kind: VirtualMachineService');
    const secret = build('vcfa91_namespace_object', { kind: 'secret' }).files;
    expect(secret['data-01.k8s.yaml']).toBe(undefined);
    expect(secret['scripts/create-secret.sh']).toContain('--from-file="password"="$SECRET_PASSWORD_FILE"');
    expect(codes('vcfa91_namespace_object', { access_mode: 'ReadWriteMany', volume_mode: 'Block' })).toContain('vcfa91.nsobj.rwx-block');
  });
});

// ---------------------------------------------------------------------------
// Four workflows, run against a fake server

const API_TOKEN = 'vcfa-api-token-do-not-log';
const ACCESS = 'access-jwt-do-not-log';
const NSX_PASSWORD = 'Nsx-Pa55-do-not-log';
const PSK = 'psk-value-do-not-log';
const DB_PASSWORD = 'Db-Pa55-do-not-log';
const LOGIN: FakeRoute[] = [
  { method: 'POST', path: '^/oauth/tenant/[^/]+/token$', body: { access_token: ACCESS, token_type: 'Bearer' } },
  { method: 'GET', path: '^/api/versions$', body: { versionInfo: [{ version: '40.0' }] } },
];
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const at = (method: string, path: string, body?: unknown, status?: number): FakeRoute => ({ method, path: `^${esc(path)}$`, body, ...(status ? { status } : {}) });
const logText = (run: WorkflowRun) => run.logs.map((l) => l.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');

function harness(id: string, overrides: BlueprintValues = {}) {
  const files = { ...build(id, overrides).files };
  const own = Object.entries(packagesIn(files)).filter(([d]) => d !== 'vcf.automation.core.package')[0]!;
  const spec = readPackageSpec(own[1]);
  const configKey = `${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}`;
  const servers: FakeServer[] = [];
  const run = async (routes: FakeRoute[], settings: (host: string) => Record<string, unknown>) => {
    const server = await startFakeServer([...LOGIN, ...routes]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const emulator = new VroEmulator(files, { config: { [configKey]: { vcfaHost: host, nsxHost: host, vcfaApiToken: API_TOKEN, ...settings(host) } } });
    const result = emulator.runWorkflow(spec.workflows[0]!.name, {});
    expect(/do-not-log/.test(logText(result))).toBe(false);
    const requests: FakeRequest[] = server.requests();
    const writes = requests.filter((r) => r.method !== 'GET' && !/^\/oauth\/|^\/api\/versions$/.test(r.path) && !/[?&]dryRun=All/.test(r.path)).map((r) => `${r.method} ${r.path}`);
    return { result, requests, writes };
  };
  return { run, stop: () => servers.forEach((s) => s.stop()) };
}

describe('vcfa91 build-out: workflows against a fake server', { skip: !CURL }, () => {
  const tgw = harness('vcfa91_transit_gateway', { nat_on: 'none' });
  const iaas = harness('vcfa91_iaas_resource_policy');
  const avi = harness('vcfa91_avi_load_balancer');
  const secret = harness('vcfa91_namespace_object', { kind: 'secret' });
  after(() => [tgw, iaas, avi, secret].forEach((h) => h.stop()));

  const TGW = '/policy/api/v1/orgs/default/projects/team-a';
  const SVC = `${TGW}/transit-gateways/default/ipsec-vpn-services/to-dc2-svc`;

  it('transit gateway: PATCHes only what is missing, and the pre-shared key only into the session', async () => {
    const routes = [
      at('GET', `${TGW}/infra/ipsec-vpn-ike-profiles/to-dc2-ike`, { id: 'to-dc2-ike' }),
      at('GET', SVC, {}, 404),
      at('GET', `${SVC}/local-endpoints/to-dc2-le`, {}, 404),
      at('GET', `${SVC}/sessions/to-dc2`, {}, 404),
      { method: 'PATCH', path: `^${esc(TGW)}/.*$`, body: {} },
    ];
    const run = await tgw.run(routes, () => ({ nsxUser: 'admin', nsxPassword: NSX_PASSWORD, ipsecPsk: PSK, dryRun: false, cap: 10 }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual([`PATCH ${SVC}`, `PATCH ${SVC}/local-endpoints/to-dc2-le`, `PATCH ${SVC}/sessions/to-dc2`]);
    const session = run.requests.find((r) => r.method === 'PATCH' && r.path.endsWith('/sessions/to-dc2'))!;
    expect(JSON.parse(session.body).psk).toBe(PSK);
    const service = run.requests.find((r) => r.method === 'PATCH' && r.path === SVC)!;
    expect('psk' in JSON.parse(service.body)).toBe(false);
    const dry = await tgw.run(routes, () => ({ nsxUser: 'admin', nsxPassword: NSX_PASSWORD, ipsecPsk: PSK, dryRun: true }));
    expect(dry.writes).toEqual([]);
  });

  it('IaaS Resource policy: the type found by name, the project id set, and none without a project id', async () => {
    const routes = [
      at('GET', '/policy/api/policyTypes?size=200', { content: [{ id: 'com.vmware.policy.approval', name: 'Approval' }, { id: 'x.iaas.resource.v2', name: 'IaaS Resource' }] }),
      at('GET', '/policy/api/policies?search=team-a-iaas-limits&size=200', { content: [] }),
      at('POST', '/policy/api/policies', { id: 'p-1' }),
    ];
    const run = await iaas.run(routes, () => ({ vcfaOrg: 'team-a', projectId: 'proj-1', dryRun: false }));
    expect(run.result.error).toBe(null);
    expect(run.writes).toEqual(['POST /policy/api/policies']);
    const body = JSON.parse(run.requests.find((r) => r.method === 'POST' && r.path === '/policy/api/policies')!.body) as { typeId: string; projectId: string };
    expect(body.typeId).toBe('x.iaas.resource.v2');
    expect(body.projectId).toBe('proj-1');
    const none = await iaas.run(routes, () => ({ vcfaOrg: 'team-a', dryRun: false }));
    expect(none.result.error ?? '').toContain('Set projectId');
    expect(none.writes).toEqual([]);
  });

  it('Avi: stops before creating anything when the load balancer quota is used up', async () => {
    const K = '/k8s';
    const NS = 'team-a-prod-q4m8z';
    const routes = [
      at('GET', `${K}/apis/vmoperator.vmware.com/v1alpha5`, { groupVersion: 'vmoperator.vmware.com/v1alpha5' }),
      at('GET', `${K}/apis/ako.vmware.com/v1alpha2`, { groupVersion: 'ako.vmware.com/v1alpha2' }),
      at('GET', `${K}/api/v1/namespaces/${NS}/resourcequotas`, { items: [{ metadata: { name: 'q' }, status: { hard: { 'services.loadbalancers': '2' }, used: { 'services.loadbalancers': '2' } } }] }),
      { method: 'POST', path: `^${esc(K)}/.*$`, body: {} },
    ];
    const run = await avi.run(routes, (host) => ({ vcfaOrg: 'team-a', kubeServer: `https://${host}${K}`, dryRun: false, cap: 5 }));
    expect(run.result.error ?? '').toContain('load balancer quota');
    expect(run.requests.filter((r) => r.method === 'POST' && r.path.startsWith(K))).toEqual([]);
  });

  it('Secret: values from the secretValues SecureString at run time, never logged', async () => {
    const K = '/k8s';
    const NS = 'team-a-dev-x7k2p';
    const routes = [at('GET', `${K}/api/v1/namespaces/${NS}/secrets/data-01`, {}, 404), { method: 'POST', path: `^${esc(`${K}/api/v1/namespaces/${NS}/secrets`)}$`, body: {} }];
    const run = await secret.run(routes, (host) => ({ vcfaOrg: 'team-a', kubeServer: `https://${host}${K}`, dryRun: false, cap: 1, secretValues: JSON.stringify({ username: 'app', password: DB_PASSWORD }) }));
    expect(run.result.error).toBe(null);
    const post = run.requests.find((r) => r.method === 'POST' && r.path.endsWith('/secrets'))!;
    expect(JSON.parse(post.body).stringData).toEqual({ username: 'app', password: DB_PASSWORD });
    const missing = await secret.run(routes, (host) => ({ vcfaOrg: 'team-a', kubeServer: `https://${host}${K}`, dryRun: false, cap: 1, secretValues: JSON.stringify({ username: 'app' }) }));
    expect(missing.result.error ?? '').toContain('no value for password');
    expect(missing.writes).toEqual([]);
  });
});

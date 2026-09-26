/**
 * VCF Automation VM Apps: cloud templates, policies and integrations.
 *
 * The cloud template is built resource by resource from a grid, so the checks
 * are about what the grid can get wrong — a reference to nothing, a loop, a
 * default outside its own enum, a public cloud type — and about the YAML being
 * the shape VCF Automation imports. The policies, integrations and onboarding
 * plan each build from defaults and from every choice, as packages whose
 * scripts are ES5, and never with a credential in a file.
 */

import { after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { readPackageSpec } from '../kit/vro-package.ts';
import { es5Problems, packagesIn, VroEmulator } from '../testing/vro-emulator.ts';
import { startFakeServer, type FakeRoute, type FakeServer } from '../testing/fake-rest-server.ts';
import { VCF_AUTOMATION_AUTOMATIONS } from './blueprints/vcf-automation.ts';
import { VCF_AUTOMATION_SETUP } from './blueprints/vcf-automation-setup.ts';
import { buildTemplate, cellsOf } from './blueprints/vcf-automation-template-model.ts';
import type { AutomationBlueprint } from './from-automation.ts';

const MINE: readonly AutomationBlueprint[] = [...VCF_AUTOMATION_SETUP, ...VCF_AUTOMATION_AUTOMATIONS];
const blueprint = (id: string): AutomationBlueprint => {
  const found = MINE.find((b) => b.id === id);
  if (!found) throw new Error(`no blueprint ${id}`);
  return found;
};
const build = (id: string, overrides: BlueprintValues = {}) => blueprint(id).build({ ...defaultValues(blueprint(id)), ...overrides }, 'x');
const codes = (id: string, overrides: BlueprintValues = {}) => (build(id, overrides).findings ?? []).map((f) => f.code);

/** Every variant the page can produce from one choice. */
function variants(b: AutomationBlueprint): BlueprintValues[] {
  const base = defaultValues(b);
  const out: BlueprintValues[] = [{ ...base }];
  for (const input of b.inputs) {
    if (input.control === 'select') for (const option of input.options ?? []) out.push({ ...base, [input.id]: option.value });
    if (input.control === 'toggle') out.push({ ...base, [input.id]: !base[input.id] });
  }
  return out;
}

const NEW_IDS = ['vcfa_cloud_template', 'vcfa_abx_action', 'vcfa_approval_policy', 'vcfa_lease_policy', 'vcfa_resource_quota', 'vcfa_integration', 'vcfa_onboarding', 'vcfa_project', 'vcfa_network_profile'];

describe('vm apps build-out: every blueprint, every choice', () => {
  it('has the new blueprints', () => {
    for (const id of ['vcfa_lease_policy', 'vcfa_resource_quota', 'vcfa_integration', 'vcfa_onboarding']) expect(MINE.some((b) => b.id === id)).toBe(true);
  });

  it('builds clean from defaults, with the contract filled in', () => {
    const problems: string[] = [];
    for (const b of MINE) {
      const out = b.build(defaultValues(b), b.id);
      if (hasErrors(out.findings ?? [])) problems.push(`${b.id}: ${(out.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}`);
      const a = b.automation(defaultValues(b), b.id);
      if (!a.trigger.detail || !a.scope.what || a.undo.length === 0 || a.told.length === 0) problems.push(`${b.id}: contract`);
      if (a.effect !== 'read' && (a.guardrails.length === 0 || a.dryRun.length === 0)) problems.push(`${b.id}: no guardrail or dry run`);
    }
    expect(problems).toEqual([]);
  });

  it('builds every select option and toggle, with ES5 packages and no credential in a file', () => {
    const literal = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    const problems: string[] = [];
    for (const id of NEW_IDS) {
      const b = blueprint(id);
      for (const values of variants(b)) {
        let files: Record<string, string>;
        try {
          files = { ...b.build(values, id).files };
        } catch (failure) {
          problems.push(`${id} ${JSON.stringify(values).slice(0, 120)}: threw ${String(failure)}`);
          continue;
        }
        for (const [path, body] of Object.entries(files)) for (const line of body.split('\n')) if (literal.test(line)) problems.push(`${id} ${path}: ${line.trim().slice(0, 80)}`);
        for (const [dir, pkg] of Object.entries(packagesIn(files))) {
          if (dir === 'vcf.automation.core.package') continue;
          const spec = readPackageSpec(pkg);
          for (const w of spec.workflows) {
            const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
            for (const s of script) problems.push(...es5Problems(s, `${id}/${w.name}`));
          }
          for (const r of spec.resources) if (r.name.endsWith('.json')) JSON.parse(r.content);
        }
        for (const [path, body] of Object.entries(files)) if (path.endsWith('.json')) JSON.parse(body);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the house rules in what it writes: 9.1 names, no footprint', () => {
    const problems: string[] = [];
    for (const id of NEW_IDS) {
      for (const values of variants(blueprint(id))) {
        for (const [path, body] of Object.entries(blueprint(id).build(values, id).files)) {
          if (path === 'README.md' || path.startsWith('import/vcf.automation.core.package/')) continue;
          // An 8.x name is allowed only on a line about the 8.x release (the shared import boilerplate says what else it works with).
          const lines = body.split('\n').filter((line) => !/\b8\.(x|1\d)\b/.test(line));
          for (const bad of [/Service Broker/, /\bAria\b/, /vRealize/, /\bESXi\b/, /archtoolkit/i, /Generated by/i]) if (lines.some((line) => bad.test(line))) problems.push(`${id} ${path}: ${bad}`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe('vm apps build-out: the cloud template grid', () => {
  const T = (resources: string, inputs = 'size | string | Size | small | enum=small,medium', cloudConfig = '') => buildTemplate({ title: 't', resources, inputs, cloudConfig });
  const machine = 'vm | Cloud.vSphere.Machine | image=rhel9; flavor=${input.size}; networks=net:static; constraints=env:dev | ';
  const network = 'net | Cloud.vSphere.Network | networkType=existing; constraints=net:app | ';

  it('splits a row only on a pipe with spaces round it', () => {
    expect(cellsOf('a | b|c | d')).toEqual(['a', 'b|c', 'd']);
    expect(cellsOf('a | b | ')).toEqual(['a', 'b', '']);
  });

  it('writes the default template with inputs, references and the owner inputs', () => {
    const yaml = build('vcfa_cloud_template').files['x.yaml']!;
    for (const text of ['formatVersion: 1', 'inputs:', '  size:', '    enum:', '    maximum: 500', 'type: Cloud.vSphere.Machine', 'network: "${resource.appnet.id}"', 'source: "${resource.data.id}"', 'assignment: static', '  owner:', 'cloudConfig: |']) expect(yaml.includes(text)).toBe(true);
    expect(codes('vcfa_cloud_template')).toEqual([]);
  });

  it('refuses a reference to a resource or an input that does not exist', () => {
    const codesOf = (m: ReturnType<typeof T>) => m.findings.map((f) => f.code);
    expect(codesOf(T(machine))).toContain('vcfa.template.missing-resource');
    expect(codesOf(T(`${machine}\n${network}`.replace('${input.size}', '${input.flavour}')))).toContain('vcfa.template.missing-input');
    expect(codesOf(T(`${machine}\n${network}`))).toEqual([]);
  });

  it('finds a dependency loop', () => {
    const loop = 'a | Custom.Thing | x=${resource.b.id} | \nb | Custom.Thing | y=1 | a';
    expect(T(loop, '').findings.map((f) => f.code)).toContain('vcfa.template.cycle');
    expect(T('a | Custom.Thing | x=${resource.b.id} | \nb | Custom.Thing | y=1 | ', '').findings.map((f) => f.code)).not.toContain('vcfa.template.cycle');
  });

  it('refuses public cloud types (deprecated in 9.1) and unknown ones', () => {
    const found = T('a | Cloud.AWS.EC2.Instance | x=1 | \nb | Cloud.Thing | x=1 | ', '').findings.map((f) => f.code);
    expect(found).toContain('vcfa.template.public-cloud');
    expect(found).toContain('vcfa.template.unknown-type');
    // An allocation helper the page has no list for is written as given, with a warning rather than a refusal.
    const alloc = T('z | Allocations.Storage | constraints=tier:gold | ', '');
    expect(alloc.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['warning:vcfa.template.unknown-type']);
    expect(alloc.yaml.includes('- tag: "tier:gold"')).toBe(true);
  });

  it('checks input defaults against enum, bounds and pattern, and a pattern may hold a |', () => {
    const f = (inputs: string) => T(`${machine}\n${network}`, inputs).findings.map((x) => x.code);
    expect(f('size | string | Size | large | enum=small,medium')).toContain('vcfa.template.bad-default');
    expect(f('size | string | Size | small | enum=small,medium\ncount | integer | N | 9 | min=1; max=4')).toContain('vcfa.template.bad-default');
    expect(f('size | string | Size | small | pattern=^(small|medium)$')).toEqual([]);
    const yaml = T(`${machine}\n${network}`, 'size | string | Size | small | pattern=^(small|medium)$').yaml;
    expect(yaml.includes('pattern: "^(small|medium)$"')).toBe(true);
    expect(f('size | string | Size | small | ')).toContain('vcfa.template.unbounded-input');
    expect(f('size | string | Size | small | enum=small,medium\ncount | integer | N | 1 | min=5; max=4')).toContain('vcfa.template.bad-bound');
  });

  it('writes every resource type, with the shorthands expanded', () => {
    const rows = [
      'web | Cloud.vSphere.Machine | image=rhel9; cpuCount=2; totalMemoryMB=4096; count=2; networks=app:static:v6; securityGroups=websg; remoteAccess=publicPrivateKey; username=ops; sshKey=${input.sshKey}; antiAffinity=role:web; bootDiskGb=60; storageConstraints=tier:gold | ',
      'data | Cloud.vSphere.Disk | capacityGb=100; persistent=true; provisioningType=eagerZeroedThick; SCSIController=SCSI_Controller_2; unitNumber=1 | ',
      'app | Cloud.NSX.Network | networkType=routed; networkCidr=2001:db8:10::/64; constraints=net:app | ',
      'gw | Cloud.NSX.Gateway | networks=app | ',
      'nat | Cloud.NSX.NAT | gateway=gw; natRules=TCP:8080>web:80 | ',
      'lb | Cloud.NSX.LoadBalancer | network=app; instances=web; routes=HTTPS:443>HTTPS:8443; healthCheck=HTTPS:8443:/health; type=SMALL | ',
      'websg | Cloud.SecurityGroup | securityGroupType=new; rules=https inbound Allow TCP 443 2001:db8::/32, out outbound Allow ANY ANY ANY | ',
      'cfg | Cloud.Ansible | host=web; account=ansible-prod; osType=linux; playbooks=/srv/site.yml; groups=web | ',
      'aap | Cloud.Ansible.Tower | host=web; account=aap; inventoryName=prod; jobTemplates=Harden | ',
      'zone | Allocations.CloudZone | accountType=vsphere | ',
      'thing | Custom.Backup | policy=gold; target=${resource.web.id} | ',
    ].join('\n');
    const model = T(rows, 'sshKey | string | SSH key | | pattern=^ssh-');
    expect(model.findings.filter((f) => f.severity === 'error').map((f) => `${f.code}: ${f.message}`)).toEqual([]);
    for (const text of ['assignIPv6Address: true', 'securityGroups:', 'authentication: publicPrivateKey', '- tag: "!role:web:hard"', 'bootDiskCapacityInGB: 60', 'persistent: true', 'networkCidr: "2001:db8:10::/64"', 'translatedInstance: "${resource.web.id}"', 'kind: NAT44', 'instancePort: "8443"', 'healthCheckConfiguration:', 'urlPath: "/health"', 'source: "2001:db8::/32"', 'destination: "ANY"', 'host: "${resource.web.*}"', 'provision:', '- name: "Harden"', 'policy: "gold"']) {
      if (!model.yaml.includes(text)) throw new Error(`missing ${text}`);
    }
    // web attaches nothing and has count 2: no disk warning; the disk is standalone.
    expect(model.findings.map((f) => f.code)).not.toContain('vcfa.template.disk-count');
  });

  it('checks each kind for what it cannot work without', () => {
    const f = (rows: string) => T(rows, '').findings.map((x) => x.code);
    expect(f('lb | Cloud.NSX.LoadBalancer | type=SMALL | ')).toEqual(['vcfa.template.lb-no-members', 'vcfa.template.lb-no-routes', 'vcfa.template.lb-no-network']);
    expect(f('sg | Cloud.SecurityGroup | securityGroupType=new | ')).toContain('vcfa.template.sg-no-rules');
    expect(f('sg | Cloud.SecurityGroup | securityGroupType=new; rules=https sideways Allow TCP 443 ANY | ')).toContain('vcfa.template.bad-value');
    expect(f('a | Cloud.Ansible | osType=linux | ')).toContain('vcfa.template.ansible-no-host');
    expect(f('vm | Cloud.vSphere.Machine | flavor=small | ')).toContain('vcfa.template.no-image');
    expect(f('d | Cloud.vSphere.Disk | capacityGb=lots | ')).toContain('vcfa.template.bad-value');
    expect(f('vm | Cloud.vSphere.Machine | image=x; flavor=small; remoteAccess=usernamePassword; password=hunter2 | ')).toContain('vcfa.template.literal-password');
  });

  it('points a template with no lease at the lease policy, and writes no lease payload', () => {
    const out = build('vcfa_cloud_template', { lease_days: 0 });
    expect((out.findings ?? []).find((f) => f.code === 'vcfa.template.no-lease')?.remediation ?? '').toContain('vcfa_lease_policy');
    expect(Object.keys(out.files).some((p) => p.includes('lease-policy'))).toBe(false);
  });

  it('passes the import YAML shape: name and version first, even indentation', () => {
    const yaml = Object.entries(build('vcfa_cloud_template', { version: '2.1.0' }).files).find(([p]) => p.endsWith('/blueprint.yaml'))![1];
    const keys = yaml.split('\n').filter((l) => /^[A-Za-z]/.test(l)).map((l) => l.split(':')[0]);
    expect(keys.slice(0, 2)).toEqual(['name', 'version']);
    expect(yaml.includes('version: 2.1.0')).toBe(true);
    expect(codes('vcfa_cloud_template', { version: 'v2' })).toContain('vcfa.template.bad-version');
  });
});

describe('vm apps build-out: extensibility', () => {
  const sub = (overrides: BlueprintValues = {}) => JSON.parse(build('vcfa_abx_action', overrides).files['x-subscription.json']!) as Record<string, any>;

  it('creates the subscription enabled, scoped to the project, with priority and timeout', () => {
    const s = sub();
    expect(s.disabled).toBe(false);
    expect(s.constraints).toEqual({ projectId: ['<REQUIRED — project id>'] });
    expect(s.priority).toBe(10);
    expect('criteria' in s).toBe(false);
    expect('constraints' in sub({ this_project_only: false })).toBe(false);
  });

  it('takes a condition, a recovery action and blocking by choice', () => {
    const s = sub({ condition: 'event.data.projectId == "p"', recovery_action: 'Clean up', blocking: 'blocking', subscription_timeout: 3 });
    expect(s.criteria).toBe('event.data.projectId == "p"');
    expect(s.recoverRunnableType).toBe('extensibility.abx');
    expect(s.blocking).toBe(true);
    expect(s.timeout).toBe(3);
  });

  it('refuses to block on a topic that cannot, and warns on an estate-wide blocking subscription', () => {
    expect(codes('vcfa_abx_action', { topic: 'deployment.request.post', blocking: 'blocking' })).toContain('vcfa.abx.not-blockable');
    expect(codes('vcfa_abx_action', { topic: 'compute.allocation.pre', this_project_only: false })).toContain('vcfa.abx.blocking-estate-wide');
    expect(codes('vcfa_abx_action', { topic: 'custom', custom_topic: 'not a topic' })).toContain('vcfa.abx.bad-topic');
  });

  it('writes a PowerShell action with its own apply script, memory and dependencies', () => {
    const files = build('vcfa_abx_action', { runtime: 'powershell', memory_mb: 512, dependencies: 'VMware.PowerCLI' }).files;
    expect(files['x.ps1']!.includes('function handler($context, $inputs)')).toBe(true);
    const action = JSON.parse(files['scripts/x-action.json']!) as Record<string, unknown>;
    expect(action.runtime).toBe('powershell');
    expect(action.memoryInMB).toBe(512);
    expect(action.dependencies).toBe('VMware.PowerCLI');
    expect(files['scripts/apply.sh']!.includes('--rawfile s')).toBe(true);
    expect(Object.keys(files).some((p) => p.startsWith('import/abx/'))).toBe(false);
  });

  it('creates secrets from the environment, never from a file', () => {
    const script = build('vcfa_abx_action').files['scripts/abx-constants.sh']!;
    expect(script.includes('CMDB_TOKEN:?set CMDB_TOKEN')).toBe(true);
    expect(script.includes('/abx/api/resources/action-secrets')).toBe(true);
    expect(codes('vcfa_abx_action', { constants: 'cmdbToken | secret | s3cr3t-value' })).toContain('vcfa.abx.secret-literal');
    const action = JSON.parse(Object.entries(build('vcfa_abx_action').files).find(([p]) => p.endsWith('/action.json'))![1]) as { inputs: Record<string, string> };
    expect(action.inputs).toEqual({ cmdbToken: 'secret:cmdbToken' });
  });
});

describe('vm apps build-out: policies', () => {
  const policyOf = (id: string, overrides: BlueprintValues = {}, file = 'x.json') => JSON.parse(build(id, overrides).files[`scripts/${file}`]!) as Record<string, any>;

  it('approval: organization scope, a second level, roles and custom criteria', () => {
    expect('projectId' in policyOf('vcfa_approval_policy', { scope: 'org' })).toBe(false);
    expect(codes('vcfa_approval_policy', { scope: 'org' })).toContain('vcfa.approval.org-wide');
    const files = build('vcfa_approval_policy', { level2_approvers: 'group:finance@example.com' }).files;
    expect((JSON.parse(files['scripts/x-level2.json']!) as { definition: { level: number; approvers: string[] } }).definition).toEqual(expect_level2());
    expect(policyOf('vcfa_approval_policy', { approvers_are: 'ROLE', approvers: 'project_administrator' }).definition.approverType).toBe('ROLE');
    const custom = policyOf('vcfa_approval_policy', { when: 'custom' });
    expect(custom.criteria.matchExpression[0].and.length).toBe(2);
    expect(policyOf('vcfa_approval_policy', { when: 'custom', criteria_join: 'any' }).criteria.matchExpression[0].or.length).toBe(2);
    expect(codes('vcfa_approval_policy', { when: 'custom', criteria: 'a | like | b' })).toContain('vcfa.policy.criteria-operator');
    expect(policyOf('vcfa_approval_policy', { approval_mode: 'ALL_OF' }).definition.approvalMode).toBe('ALL_OF');
  });

  it('lease: a standalone policy with total, grace, enforcement and criteria', () => {
    const p = policyOf('vcfa_lease_policy');
    expect(p.typeId).toBe('com.vmware.policy.deployment.lease');
    expect(p.definition).toEqual({ leaseTermMax: 30, leaseTotalTermMax: 90, leaseGrace: 7 });
    expect(p.enforcementType).toBe('HARD');
    expect('criteria' in p).toBe(false);
    const c = policyOf('vcfa_lease_policy', { applies_to: 'criteria', enforcement: 'SOFT', scope: 'org' });
    expect(c.criteria.matchExpression[0]).toEqual({ key: 'deployment.inputs.environment', operator: 'in', value: ['dev', 'test'] });
    expect(c.enforcementType).toBe('SOFT');
    expect('projectId' in c).toBe(false);
    expect(codes('vcfa_lease_policy', { max_lease_days: 120, max_total_days: 90 })).toContain('vcfa.lease.total-below-lease');
    expect(codes('vcfa_lease_policy', { grace_days: 0 })).toContain('vcfa.lease.no-grace');
  });

  it('quota and deployment limit: the type and level follow the choice', () => {
    const q = policyOf('vcfa_resource_quota');
    expect(q.typeId).toBe('com.vmware.policy.resource.quota');
    expect(q.definition.userLevel.limits.memory).toEqual({ value: 64, unit: 'GB' });
    expect(Object.keys(policyOf('vcfa_resource_quota', { level: 'project' }).definition)).toEqual(['projectLevel']);
    const l = policyOf('vcfa_resource_quota', { kind: 'limit' });
    expect(l.typeId).toBe('com.vmware.policy.deployment.limit');
    expect(l.definition.deploymentLimits.instances).toEqual({ value: 10 });
    expect(codes('vcfa_resource_quota', { cpu: 0, memory_gb: 0, storage_gb: 0, vm_count: 0 })).toContain('vcfa.quota.nothing');
    expect(codes('vcfa_resource_quota', { cpu: 0 })).toContain('vcfa.quota.partial');
  });
});

function expect_level2() {
  return { level: 2, approverType: 'USER', approvalMode: 'ANY_OF', approvers: ['GROUP:finance@example.com'], autoApprovalDecision: 'REJECT', autoApprovalExpiry: 2, actions: ['Deployment.Create'] };
}

describe('vm apps build-out: integrations, onboarding, projects and network profiles', () => {
  it('integration: Git repositories become content sources; the token never reaches a file', () => {
    const files = build('vcfa_integration').files;
    const integration = JSON.parse(files['scripts/x.json']!) as Record<string, any>;
    expect(integration.integrationType).toBe('com.gitlab.enterprise.onprem');
    expect(String(integration.privateKey).startsWith('<REQUIRED')).toBe(true);
    const source = JSON.parse(files['scripts/x-content-source-1.json']!) as Record<string, any>;
    expect(source.config).toEqual({ integrationId: '__INTEGRATION_ID__', repository: 'platform/vcfa-templates', branch: 'release', path: 'templates', contentType: 'blueprint' });
    expect(files['scripts/apply.sh']!.includes("jq '.privateKey = env.INTEGRATION_SECRET'")).toBe(true);
    expect(codes('vcfa_integration', { repos: 'finance-apps | platform/x | feature/y | t | blueprint' })).toContain('vcfa.integration.branch');
    expect(JSON.parse(build('vcfa_integration', { kind: 'github', endpoint: 'github.com' }).files['scripts/x.json']!).integrationType).toBe('com.github.saas');
  });

  it('integration: Infoblox, Ansible and Active Directory each carry their own properties', () => {
    const props = (kind: string, extra: BlueprintValues = {}) => (JSON.parse(build('vcfa_integration', { kind, ...extra }).files['scripts/x.json']!) as { integrationProperties: Record<string, unknown> }).integrationProperties;
    expect(props('infoblox')['Infoblox.IPAM.NetworkView']).toBe('default');
    expect(props('ansible').inventoryFile).toBe('/etc/ansible/hosts');
    expect(props('activedirectory', { endpoint: 'dc1.example.com' }).server).toBe('ldaps://dc1.example.com:636');
    expect(build('vcfa_integration', { kind: 'activedirectory' }).files['IMPORT.md']!.includes('relative DN OU=Finance')).toBe(true);
    expect(codes('vcfa_integration', { kind: 'activedirectory', endpoint: 'ldap://dc1.example.com' })).toContain('vcfa.integration.ldap-plain');
  });

  it('onboarding: a bad filter is refused and no filter is warned about', () => {
    expect(codes('vcfa_onboarding', { name_filter: '([' })).toContain('vcfa.onboarding.bad-filter');
    expect(codes('vcfa_onboarding', { name_filter: '', tag_filter: '' })).toContain('vcfa.onboarding.everything');
    const plan = JSON.parse(build('vcfa_onboarding', { template: 'existing' }).files['x-plan.json']!) as Record<string, unknown>;
    expect(plan.template).toBe('Standard Linux server');
  });

  it('project: viewers and supervisors', () => {
    const p = JSON.parse(build('vcfa_project', { viewers: 'audit@example.com', supervisors: 'leads@example.com' }).files['scripts/x.json']!) as Record<string, any>;
    expect(p.viewers).toEqual([{ email: 'audit@example.com', type: 'group' }]);
    expect(p.supervisors).toEqual([{ email: 'leads@example.com', type: 'group' }]);
    expect('supervisors' in (JSON.parse(build('vcfa_project').files['scripts/x.json']!) as object)).toBe(false);
  });

  it('network profile: load balancers, and external IPAM ranges assigned by script', () => {
    const p = JSON.parse(build('vcfa_network_profile', { load_balancers: 'lb-1' }).files['scripts/x.json']!) as Record<string, any>;
    expect(p.loadBalancerIds).toEqual(['lb-1']);
    const ext = build('vcfa_network_profile', { ipam: 'external' }).files;
    expect(ext['scripts/external-ranges.sh']!.includes('PATCH')).toBe(true);
    expect(ext['scripts/external-ranges.sh']!.includes('DRY_RUN=1')).toBe(true);
    expect(codes('vcfa_network_profile', { ipam: 'external', ipam_ranges: '' })).toContain('vcfa.network.no-external-ranges');
  });
});

// ---------------------------------------------------------------------------
// Two of the new workflows against a fake VCF Automation.

const CURL = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

describe('vm apps build-out: the new workflows run', { skip: !CURL }, () => {
  const servers: FakeServer[] = [];
  after(() => servers.forEach((s) => s.stop()));
  const TOKEN = 'vcfa-api-token-do-not-log';
  const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const list = (path: string, items: unknown[] = []): FakeRoute => ({ method: 'GET', path: `^${esc(path)}[?&]`, body: { content: items, totalElements: items.length } });
  const post = (path: string, body: unknown): FakeRoute => ({ method: 'POST', path: `^${esc(path)}(\\?apiVersion=[^&]*)?$`, body });

  async function run(files: Record<string, string>, routes: FakeRoute[], settings: Record<string, unknown>) {
    const server = await startFakeServer([...routes, { method: 'POST', path: '^/oauth/tenant/org1/token$', body: { access_token: 'a' } }, { method: 'POST', path: '^/hook$', body: {} }]);
    servers.push(server);
    const packages = packagesIn(files);
    const dir = Object.keys(packages).find((d) => d !== 'vcf.automation.core.package')!;
    const spec = readPackageSpec(packages[dir]!);
    const host = `127.0.0.1:${server.port}`;
    const emulator = new VroEmulator(files, { config: { [`${spec.configs[0]!.categoryPath}/${spec.configs[0]!.name}`]: { vcfaHost: host, vcfaOrg: 'org1', vcfaApiToken: TOKEN, webhook: `https://${host}/hook`, ...settings } } });
    const result = emulator.runWorkflow(spec.workflows[0]!.name, {});
    const writes = server.requests().filter((r) => r.method !== 'GET' && !/oauth|hook/.test(r.path));
    return { result, writes };
  }

  it('lease policy: creates it in the project', async () => {
    const { result, writes } = await run({ ...build('vcfa_lease_policy').files }, [list('/policy/api/policies?typeId=com.vmware.policy.deployment.lease'), post('/policy/api/policies', { id: 'lp-1' })], { projectId: 'proj-1', dryRun: false });
    expect(result.error).toBe(null);
    expect(writes.map((w) => `${w.method} ${w.path.split('?')[0]}`)).toEqual(['POST /policy/api/policies']);
    const body = JSON.parse(writes[0]!.body) as Record<string, unknown>;
    expect(body.projectId).toBe('proj-1');
    expect(result.outputs.policyId).toBe('lp-1');
  });

  it('integration: the secret from the configuration element, the content source in the named project', async () => {
    const { result, writes } = await run(
      { ...build('vcfa_integration').files },
      [list('/iaas/api/integrations'), list('/content/api/sources'), list('/iaas/api/projects', [{ id: 'proj-9', name: 'finance-apps' }]), post('/iaas/api/integrations', { id: 'int-1' }), post('/content/api/sources', { id: 'cs-1' })],
      { integrationSecret: 'git-token-do-not-log', dryRun: false },
    );
    expect(result.error).toBe(null);
    expect(writes.map((w) => `${w.method} ${w.path.split('?')[0]}`)).toEqual(['POST /iaas/api/integrations', 'POST /content/api/sources']);
    expect((JSON.parse(writes[0]!.body) as { privateKey: string }).privateKey).toBe('git-token-do-not-log');
    const source = JSON.parse(writes[1]!.body) as { projectId: string; config: { integrationId: string } };
    expect(source.projectId).toBe('proj-9');
    expect(source.config.integrationId).toBe('int-1');
    expect(/do-not-log/.test(result.logs.map((l) => l.message).join('\n'))).toBe(false);
  });
});

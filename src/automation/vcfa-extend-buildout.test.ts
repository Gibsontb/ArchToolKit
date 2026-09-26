/**
 * The VCF Automation extensibility build-out: VKS clusters in full, custom
 * forms, day-2 policies for either organization type, generic resource
 * actions, custom resources of any type, generic Orchestrator workflows with
 * subscriptions and schedules, Orchestrator endpoints and assets, and secrets.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { VCF_AUTOMATION_EXTEND } from './blueprints/vcf-automation-extend.ts';
import { parseFormFields, formDefinition } from './blueprints/vcf-automation-extend-forms.ts';
import { parsePools, yamlOf } from './blueprints/vcf-automation-extend-vks.ts';

function blueprint(id: string) {
  const found = VCF_AUTOMATION_EXTEND.find((b) => b.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}
function build(id: string, overrides: BlueprintValues = {}) {
  const b = blueprint(id);
  return b.build({ ...defaultValues(b), ...overrides }, id);
}
const codes = (out: ReturnType<typeof build>) => (out.findings ?? []).map((f) => f.code);
const file = (out: ReturnType<typeof build>, suffix: string) => Object.entries(out.files).find(([p]) => p.endsWith(suffix))?.[1] ?? '';
const all = (out: ReturnType<typeof build>) => Object.values(out.files).join('\n');
/** A resource carried inside the automation's own package. */
const resource = (out: ReturnType<typeof build>, name: string) => Object.entries(out.files).find(([p]) => !p.includes('vcf.automation.core.package') && p.includes('/resources/') && p.endsWith(`/${name}`))?.[1] ?? '';
const config = (out: ReturnType<typeof build>) => JSON.parse(Object.entries(out.files).find(([p]) => !p.includes('vcf.automation.core.package') && /\.package\/config\//.test(p))?.[1] ?? '{}') as { attributes: { name: string; type: string; value?: unknown }[] };

const NEW_IDS = ['vcfa_custom_form', 'vcfa_orchestrator_endpoint', 'vcfa_orchestrator_assets', 'vcfa_secrets'];

describe('vcfa extend build-out: every blueprint, every choice', () => {
  it('has the new blueprints beside the deepened ones', () => {
    const ids = VCF_AUTOMATION_EXTEND.map((b) => b.id);
    for (const id of [...NEW_IDS, 'vcfa_vks_cluster', 'vcfa_day2_policy', 'vcfa_resource_action', 'vcfa_custom_resource', 'vcfa_orchestrator_workflow', 'vcfa_orchestrator_action']) expect(ids.includes(id)).toBe(true);
  });

  it('builds clean from defaults, and builds with each select option and toggle flipped', () => {
    const problems: string[] = [];
    for (const b of VCF_AUTOMATION_EXTEND) {
      const base = defaultValues(b);
      const out = b.build(base, b.id);
      if (hasErrors(out.findings ?? [])) problems.push(`${b.id} defaults: ${codes(out).join(', ')}`);
      const variants: BlueprintValues[] = [];
      for (const input of b.inputs) {
        if (input.control === 'select') for (const o of input.options ?? []) variants.push({ ...base, [input.id]: o.value });
        if (input.control === 'toggle') variants.push({ ...base, [input.id]: !base[input.id] });
      }
      for (const v of variants) {
        try {
          const o = b.build(v, b.id);
          if (!o.files['README.md'] || !o.files['IMPORT.md']) problems.push(`${b.id} ${JSON.stringify(v)}: no README or IMPORT.md`);
        } catch (e) {
          problems.push(`${b.id} ${JSON.stringify(v)}: threw ${String(e)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the house rules in every generated file: VCF 9.1 names, no footprints, enabled', () => {
    const banned = /Service Broker|\bAria\b|vRealize|vROps|\bESXi\b|ArchToolKit|archtoolkit/;
    const problems: string[] = [];
    for (const b of VCF_AUTOMATION_EXTEND) {
      const base = defaultValues(b);
      const variants: BlueprintValues[] = [base];
      for (const input of b.inputs) {
        if (input.control === 'select') for (const o of input.options ?? []) variants.push({ ...base, [input.id]: o.value });
        if (input.control === 'toggle') variants.push({ ...base, [input.id]: !base[input.id] });
      }
      for (const v of variants) {
        for (const [path, body] of Object.entries(b.build(v, b.id).files)) {
          if (path.includes('vcf.automation.core.package') || path === 'IMPORT.md' || path === 'README.md') continue;
          const hit = banned.exec(body);
          if (hit) problems.push(`${b.id} ${path}: "${hit[0]}"`);
          if (/"status":\s*"DRAFT"|"disabled":\s*true/.test(body)) problems.push(`${b.id} ${path}: created disabled or draft`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe('vcfa extend build-out: vcfa_vks_cluster', () => {
  const POOLS = 'np-web | guaranteed-large | 2-6 | zone-a | tier=web | - | -\nnp-db | guaranteed-xlarge | 3 | zone-b | tier=db | dedicated=db:NoSchedule | ubuntu';

  it('writes each pool with its zone, labels, taints, OS and autoscaler range, and no replicas on an autoscaled one', () => {
    const out = build('vcfa_vks_cluster', { node_pools: POOLS, packages: 'cluster-autoscaler', package_repo: 'registry.example.com/vks-standard-packages:1.0' });
    const cluster = JSON.parse(resource(out, 'cluster.json'));
    const [web, db] = cluster.spec.topology.workers.machineDeployments;
    expect(web.failureDomain).toBe('zone-a');
    expect('replicas' in web).toBe(false);
    expect(web.metadata.annotations['cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size']).toBe('2');
    expect(web.metadata.annotations['cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size']).toBe('6');
    expect(db.replicas).toBe(3);
    expect(db.metadata.annotations['run.tanzu.vmware.com/resolve-os-image']).toBe('os-name=ubuntu');
    const node = db.variables.overrides.find((o: { name: string }) => o.name === 'node').value;
    expect(node.labels).toEqual({ tier: 'db' });
    expect(node.taints).toEqual([{ key: 'dedicated', value: 'db', effect: 'NoSchedule' }]);
    expect(codes(out).includes('vcfa.vks.autoscaler-no-package')).toBe(false);
  });

  it('names the documented variables on the older class, and adds volumes, proxy and trust', () => {
    const out = build('vcfa_vks_cluster', { cluster_class: 'tanzukubernetescluster', node_pools: POOLS, containerd_gb: 50, etcd_gb: 20, http_proxy: 'http://[2001:db8::10]:3128', no_proxy: '.example.com', trust_ca: true });
    const topology = JSON.parse(resource(out, 'cluster.json')).spec.topology;
    const names = topology.variables.map((v: { name: string }) => v.name);
    for (const n of ['vmClass', 'storageClass', 'defaultStorageClass', 'controlPlaneVolumes', 'proxy', 'trust']) expect(names.includes(n)).toBe(true);
    const proxy = topology.variables.find((v: { name: string }) => v.name === 'proxy').value;
    expect(proxy.httpProxy).toBe('http://[2001:db8::10]:3128');
    expect(proxy.noProxy.includes('192.168.0.0/16')).toBe(true);
    const overrides = topology.workers.machineDeployments[1].variables.overrides.map((o: { name: string }) => o.name);
    expect(overrides).toEqual(['vmClass', 'nodePoolLabels', 'nodePoolTaints', 'nodePoolVolumes']);
    expect(file(out, '-trusted-ca.k8s.yaml').includes('user-trusted-ca-secret')).toBe(true);
    expect(config(out).attributes.find((a) => a.name === 'cap')?.value).toBe(2);
  });

  it('writes the standard packages and the script that installs them in the cluster', () => {
    const out = build('vcfa_vks_cluster', { packages: 'cert-manager,contour,external-dns,fluent-bit,prometheus,velero', package_repo: 'registry.example.com/vks:1', velero_bucket: 'backups', velero_s3_url: 'https://s3.example.com', dns_zone: 'apps.example.com' });
    const yaml = file(out, '-packages.k8s.yaml');
    for (const ref of ['cert-manager.kubernetes.vmware.com', 'contour.kubernetes.vmware.com', 'external-dns.kubernetes.vmware.com', 'fluent-bit.kubernetes.vmware.com', 'prometheus.kubernetes.vmware.com', 'velero.kubernetes.vmware.com']) expect(yaml.includes(ref)).toBe(true);
    expect(yaml.includes('kind: PackageRepository')).toBe(true);
    const script = out.files['scripts/install-packages.sh'] ?? '';
    expect(script.includes('VELERO_CREDENTIALS_FILE')).toBe(true);
    expect(script.includes('--dry-run=server')).toBe(true);
    expect(hasErrors(out.findings ?? [])).toBe(false);
  });

  it('catches the traps: no autoscaler, no Velero target, Contour alone, a bad taint, a proxy with a password, one zone', () => {
    expect(codes(build('vcfa_vks_cluster', { node_pools: POOLS }))).toContain('vcfa.vks.autoscaler-no-package');
    expect(codes(build('vcfa_vks_cluster', { packages: 'velero' }))).toContain('vcfa.vks.velero-target');
    expect(codes(build('vcfa_vks_cluster', { packages: 'contour' }))).toContain('vcfa.vks.contour-needs-cert-manager');
    expect(codes(build('vcfa_vks_cluster', { node_pools: 'np-a | guaranteed-large | 3 | - | - | gpu:Sometimes | -' }))).toContain('vcfa.vks.bad-taint');
    expect(codes(build('vcfa_vks_cluster', { http_proxy: 'http://user:pw@proxy.example.com:3128' }))).toContain('vcfa.vks.proxy-credential');
    expect(codes(build('vcfa_vks_cluster', { node_pools: 'np-a | guaranteed-large | 3 | zone-a | - | - | -\nnp-b | guaranteed-large | 3 | zone-a | - | - | -' }))).toContain('vcfa.vks.one-zone');
    expect(codes(build('vcfa_vks_cluster', { node_pools: 'np-a | guaranteed-large | 6-2 | - | - | - | -' }))).toContain('vcfa.vks.autoscaler-range');
  });

  it('parses pools and writes YAML the template can carry', () => {
    const { pools, findings } = parsePools('np-a | best-effort-large | 1 | - | a=b, c=d | - | photon');
    expect(findings).toEqual([]);
    expect(pools[0]!.labels).toEqual([['a', 'b'], ['c', 'd']]);
    expect(yamlOf({ a: { b: ['x'], c: [{ d: 1, e: 'f g' }] } })).toEqual(['a:', '  b: ["x"]', '  c:', '    - d: 1', '      e: f g']);
  });
});

describe('vcfa extend build-out: vcfa_custom_form', () => {
  it('writes pages, dropdowns, an action value source and a condition, applied enabled', () => {
    const out = build('vcfa_custom_form');
    const body = JSON.parse(file(out, '-form.json'));
    expect([body.status, body.type, body.sourceType]).toEqual(['ON', 'requestForm', 'com.vmw.blueprint']);
    const form = JSON.parse(body.form);
    expect(form.layout.pages.map((p: { title: string }) => p.title)).toEqual(['General', 'Options']);
    expect(form.schema.size.valueList.map((v: { value: string }) => v.value)).toEqual(['small', 'medium', 'large']);
    expect(form.schema.backupJob.valueList).toEqual({ id: 'com.company.infra/listBackupJobs', type: 'scriptAction', parameters: [{ environment: 'environment' }] });
    const backupJob = form.layout.pages[1].sections.flatMap((s: { fields: unknown[] }) => s.fields).find((f: { id: string }) => f.id === 'backupJob');
    expect(backupJob.state.visible[0]).toEqual({ equals: { backup: 'true' }, value: true });
    expect(file(out, '-template-inputs.yaml').includes('enum: ["small", "medium", "large"]')).toBe(true);
  });

  it('targets a catalog workflow by its source type, found by name', () => {
    const out = build('vcfa_custom_form', { source: 'workflow' });
    expect(JSON.parse(file(out, '-form.json')).sourceType).toBe('com.vmw.vro.workflow');
    expect(all(out).includes('workflowIdByName')).toBe(true);
  });

  it('refuses fields that cannot work', () => {
    const { findings } = parseFormFields('a | A | string | yes | - | - | missing=1 | P\na | A | string | no | - | - | - | P\npw | Password | secret | no | hunter2 | - | - | P\nb | B | string | yes | - | - | a=x | P');
    const found = findings.map((f) => f.code);
    for (const code of ['vcfa.form.unknown-condition-field', 'vcfa.form.duplicate', 'vcfa.form.secret-default', 'vcfa.form.hidden-required']) expect(found).toContain(code);
    const def = formDefinition(parseFormFields('pw | Password | secret | yes | - | - | - | P').fields);
    expect((def.schema.pw as { type: { dataType: string } }).type.dataType).toBe('secureString');
  });
});

describe('vcfa extend build-out: vcfa_day2_policy', () => {
  it('scopes to the organization with no projectId, and narrows by criteria', () => {
    const out = build('vcfa_day2_policy', { scope: 'organization', criteria: 'catalogItemName | eq | Linux server\nownedBy | in | a@example.com, b@example.com', extra_authorities: 'GROUP:app-ops@example.com' });
    const policy = JSON.parse(file(out, 'vcfa-day2-policy.json'));
    expect('projectId' in policy).toBe(false);
    expect(policy.criteria.matchExpression[0].and.length).toBe(2);
    expect(policy.criteria.matchExpression[0].and[1].value).toEqual(['a@example.com', 'b@example.com']);
    expect(policy.definition.allowedActions[0].authorities).toEqual(['ROLE:member', 'GROUP:app-ops@example.com']);
    expect(codes(out)).toContain('vcfa.day2.org-wide');
    expect(codes(out).includes('vcfa.day2.no-project')).toBe(false);
  });

  it('logs in to an All Apps organization when chosen, and refuses a malformed authority or criterion', () => {
    const allApps = build('vcfa_day2_policy', { org_type: 'all-apps' });
    expect(all(allApps).includes('All Apps organization name')).toBe(true);
    expect(codes(build('vcfa_day2_policy', { extra_authorities: 'app-ops' }))).toContain('vcfa.day2.bad-authority');
    expect(codes(build('vcfa_day2_policy', { criteria: 'owner | like | x' }))).toContain('vcfa.day2.bad-criterion');
  });
});

describe('vcfa extend build-out: vcfa_resource_action, generic', () => {
  it('runs an existing workflow by name with bound inputs, a form and criteria, released', () => {
    const out = build('vcfa_resource_action', { operation: 'generic', resource_type: 'Cloud.NSX.Network', criteria: '${properties.networkType} | eq | routed' });
    const action = JSON.parse(file(out, 'vcfa-resource-action.json'));
    expect(action.resourceType).toBe('Cloud.NSX.Network');
    expect(action.status).toBe('RELEASED');
    expect(action.runnableItem.name).toBe('Restart application service');
    expect(action.runnableItem.inputParameters.map((p: { binding: { type: string } }) => p.binding.type)).toEqual(['resource', 'form']);
    expect(JSON.parse(action.formDefinition.form).schema.serviceName.label).toBe('Service');
    expect(action.criteria.matchExpression[0].key).toBe('${properties.networkType}');
    expect(Object.keys(out.files).some((p) => p.startsWith('import/orchestrator/'))).toBe(false);
    expect(all(out).includes('mod.workflowIdByName')).toBe(true);
  });

  it('finds an ABX action by name, and refuses a binding to a field the form lacks', () => {
    expect(all(build('vcfa_resource_action', { operation: 'generic', backed_by: 'abx' })).includes('mod.abxIdByName')).toBe(true);
    expect(codes(build('vcfa_resource_action', { operation: 'generic', input_bindings: 'x | string | form:nope' }))).toContain('vcfa.day2.unknown-form-field');
    expect(codes(build('vcfa_resource_action', { operation: 'generic', generic_effect: 'irreversible', require_approval: false }))).toContain('vcfa.day2.destructive-no-approval');
  });
});

describe('vcfa extend build-out: vcfa_custom_resource', () => {
  it('takes any Custom.* type with its own properties, existing runnables and day-2 actions', () => {
    const out = build('vcfa_custom_resource', { type_name: 'Custom.FirewallRule', properties: 'ruleName | string | Rule name | yes\nport | integer | Port | yes\nenabled | boolean | Enabled | no', runnables: 'existing', additional_actions: 'Disable | Disable firewall rule' });
    const type = JSON.parse(file(out, '-resource-type.json'));
    expect(type.resourceType).toBe('Custom.FirewallRule');
    expect(type.properties.required).toEqual(['ruleName', 'port']);
    expect(type.mainActions.create.name).toBe('Create Firewall Rule');
    expect(Object.keys(out.files).some((p) => p.startsWith('import/orchestrator/'))).toBe(false);
    expect(JSON.parse(file(out, '-extra-actions.json'))[0].runnableItem.name).toBe('Disable firewall rule');
    expect(all(out).includes('runnableNamed')).toBe(true);
  });

  it('refuses a malformed type name or a type with no properties', () => {
    expect(codes(build('vcfa_custom_resource', { type_name: 'FirewallRule', properties: 'a | string | A | yes' }))).toContain('vcfa.custom.bad-type-name');
    expect(codes(build('vcfa_custom_resource', { type_name: 'Custom.Nothing' }))).toContain('vcfa.custom.no-properties');
  });
});

describe('vcfa extend build-out: Orchestrator workflows and actions', () => {
  it('builds a custom workflow from rows, with a Python task, an enabled subscription and a schedule that acts', () => {
    const out = build('vcfa_orchestrator_workflow', {
      task: 'custom',
      inputs_rows: 'vmName | string | The VM\ncount | number | How many',
      outputs_rows: 'result | string | What it did',
      attributes_rows: 'allowList | string | app- | Prefixes\napiPassword | SecureString | - | The API password',
      language: 'python',
      subscribe: true,
      subscription_criteria: "event.data.projectName == 'A'",
      schedule: 'weekly',
      schedule_inputs: 'vmName | app-01\ncount | 2',
    });
    const attrs = config(out).attributes;
    expect(attrs.find((a) => a.name === 'apiPassword')?.type).toBe('SecureString');
    expect(attrs.find((a) => a.name === 'apiPassword')?.value).toBe(undefined);
    expect(file(out, '.py').includes('def handler(context, inputs):')).toBe(true);
    const sub = JSON.parse(file(out, '-subscription.json'));
    expect([sub.disabled, sub.runnableType, sub.criteria]).toEqual([false, 'extensibility.vro', "event.data.projectName == 'A'"]);
    const task = JSON.parse(file(out, '-schedule.json'));
    expect(task['recurrence-cycle']).toBe('every-weeks');
    expect(task['input-parameters'].find((p: { name: string }) => p.name === 'dryRun').value).toEqual({ boolean: { value: false } });
    expect(task['input-parameters'].find((p: { name: string }) => p.name === 'count').value).toEqual({ number: { value: 2 } });
    expect(hasErrors(out.findings ?? [])).toBe(false);
  });

  it('refuses a secret attribute that is not a SecureString, and flags an unscoped subscription', () => {
    expect(codes(build('vcfa_orchestrator_workflow', { task: 'custom', attributes_rows: 'dbPassword | string | x | y' }))).toContain('vcfa.vro.secret-not-secure');
    expect(codes(build('vcfa_orchestrator_workflow', { subscribe: true }))).toContain('vcfa.vro.subscription-unscoped');
  });

  it('returns label and value pairs when asked, with its own inputs', () => {
    const out = build('vcfa_orchestrator_action', { source: 'custom', return_type: 'Array/Properties', action_inputs: 'env | string | Environment' });
    const script = Object.entries(out.files).find(([p]) => p.endsWith('listOptions.js') && !p.startsWith('import/'))?.[1] ?? '';
    expect(script.includes('p.put("label"')).toBe(true);
    expect(script.includes('Input: env (string)')).toBe(true);
  });
});

describe('vcfa extend build-out: Orchestrator endpoints and assets', () => {
  it('adds each kind of endpoint through its library workflow, IPv6 bracketed', () => {
    for (const kind of ['rest', 'powershell', 'ssh', 'ad', 'sql']) {
      const out = build('vcfa_orchestrator_endpoint', { kind, host: '2001:db8::20' });
      const req = JSON.parse(file(out, '-endpoint.json'));
      expect(typeof req.workflow).toBe('string');
      expect(hasErrors(out.findings ?? [])).toBe(false);
    }
    const rest = JSON.parse(file(build('vcfa_orchestrator_endpoint', { host: '2001:db8::20' }), '-endpoint.json'));
    expect(rest.parameters.find((p: { name: string }) => p.name === 'url').value.string.value).toBe('https://[2001:db8::20]:443/api');
  });

  it('refuses credentials in clear', () => {
    expect(codes(build('vcfa_orchestrator_endpoint', { use_tls: false }))).toContain('vcfa.endpoint.cleartext');
    expect(codes(build('vcfa_orchestrator_endpoint', { kind: 'ad', use_tls: false }))).toContain('vcfa.endpoint.cleartext');
  });

  it('completes a configuration element, schedules a workflow, and moves a package keeping the undo', () => {
    const cfg = build('vcfa_orchestrator_assets');
    const element = JSON.parse(file(cfg, '-element.json'));
    expect(element.attributes.find((a: { key: string }) => a.key === 'dnsPassword').value).toBe(null);
    expect(codes(build('vcfa_orchestrator_assets', { attributes: 'apiToken | string | abc | x' }))).toContain('vcfa.config.secret-not-secure');
    const sched = build('vcfa_orchestrator_assets', { asset: 'schedule' });
    expect(JSON.parse(file(sched, '-task.json'))['recurrence-cycle']).toBe('every-days');
    const move = build('vcfa_orchestrator_assets', { asset: 'transfer' });
    const script = move.files['scripts/transfer-package.sh'] ?? '';
    expect(script.includes('target-before.package')).toBe(true);
    expect(script.includes('exportConfigSecureStringAttributeValues=false')).toBe(true);
  });
});

describe('vcfa extend build-out: secrets and action constants', () => {
  it('keeps secret values out of every file, and gives each its SecureString', () => {
    const out = build('vcfa_secrets');
    const names = config(out).attributes.filter((a) => a.type === 'SecureString').map((a) => a.name);
    expect(names.includes('value_dbAdminPassword')).toBe(true);
    expect(names.includes('value_ipamApiKey')).toBe(true);
    const entries = JSON.parse(file(out, '-entries.json'));
    expect(entries.find((e: { name: string }) => e.name === 'ipamBaseUrl').value).toBe('https://ipam.example.com');
    expect('value' in entries.find((e: { name: string }) => e.name === 'dbAdminPassword')).toBe(false);
    expect((out.files['scripts/apply-secrets.sh'] ?? '').includes('PROJECT_IDS_DBADMINPASSWORD')).toBe(true);
  });

  it('refuses a secret value on the page', () => {
    expect(codes(build('vcfa_secrets', { entries: 'x | secret | hunter2 | - | y' }))).toContain('vcfa.secret.value-on-page');
    expect(codes(build('vcfa_secrets', { entries: 'apiToken | constant | abc | - | y' }))).toContain('vcfa.secret.constant-looks-secret');
  });
});

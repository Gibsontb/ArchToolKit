/**
 * VCF Automation 9.1 governance for All Apps organizations: IaaS Resource
 * policies, provider Infrastructure policies (VM-host affinity) with the
 * tenant Deployment Criteria policy that selects VMs for them, and the users,
 * groups and roles of an organization and its projects.
 *
 * Sources: VCF Automation 9.1 what's new (All Apps policies: Approval, Day 2
 * Action, Lease, IaaS Resource, Deployment Criteria; provider infrastructure
 * policies, mandatory or optional); the VCF blog on 9.1 infrastructure policies
 * (2026-05-28); the vSphere Automation API (compute policies, tagging); the
 * Cloud Director /cloudapi role, right and group model VCF Automation inherits;
 * the Cloud Consumption Interface ProjectRoleBinding.
 *
 * The /policy/api type ids of the 9.1 All Apps policy types and the provider
 * infrastructure policy path are not in Broadcom's public API reference: the
 * scripts find the policy type by name at /policy/api/policyTypes and probe the
 * provider path, and say VERIFY — with the portal steps — when either is not
 * where these files look.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, type Automation } from '../automation.ts';
import { importMd, kubeStep, manualStep } from '../vcfa-import.ts';
import { packageNameOf, toPackage } from '../vro/to-package.ts';
import { POLICY_OUTPUTS, policyApplyLines, policyConfig, policyWorkflow, rowsOf, vcenterAuthLines, vcenterTagLines, type Vcfa91Kit, type Vcfa91KubeObject } from './vcf-automation-91-kit.ts';

// ---------------------------------------------------------------------------
// IaaS Resource policy

interface CelRule {
  readonly name: string;
  readonly kinds: readonly string[];
  readonly expression: string;
  readonly message: string;
}

/** The resource kinds an IaaS Resource policy can govern, by the service that serves them. */
const SERVICE_KINDS: Readonly<Record<string, { group: string; resources: readonly string[]; kinds: readonly string[]; label: string }>> = {
  'vm-service': { group: 'vmoperator.vmware.com', resources: ['virtualmachines'], kinds: ['VirtualMachine'], label: 'VM Service virtual machines' },
  vks: { group: 'cluster.x-k8s.io', resources: ['clusters'], kinds: ['Cluster'], label: 'VKS clusters' },
  volumes: { group: '', resources: ['persistentvolumeclaims'], kinds: ['PersistentVolumeClaim'], label: 'persistent volume claims' },
  'data-services': { group: 'databases.dataservices.vmware.com', resources: ['postgresclusters', 'mysqlclusters'], kinds: ['PostgresCluster', 'MySQLCluster'], label: 'Data Services databases' },
  'load-balancers': { group: 'vmoperator.vmware.com', resources: ['virtualmachineservices'], kinds: ['VirtualMachineService'], label: 'VM Service load balancers' },
};

const celList = (items: readonly string[]): string => `[${items.map((i) => `'${i.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;

function iaasPolicy(kit: Vcfa91Kit): AutomationBlueprint {
  const { PLATFORM, SRC, ALL_APPS, AREA, json, label, restScript, k8sYaml } = kit;
  return automationBlueprint({
    id: 'vcfa91_iaas_resource_policy',
    platform: PLATFORM,
    label: 'An IaaS Resource policy: which services, kinds, VM classes and VKS sizes a project may use',
    group: 'VCF Automation 9.1 — governance',
    description:
      'The All Apps IaaS Resource policy (Manage & Govern → Policies): scoped to the organization or one project, it limits which Supervisor services may be used (VM Service, VKS, volumes, Data Services, load balancers), the VM classes and storage classes allowed, VKS worker and control-plane counts and the lowest Kubernetes version, and labels every object must carry. Written as the CEL validations the policy enforces, created through /policy/api with the type found by name, and as the equivalent ValidatingAdmissionPolicy to read.',
    inputs: [
      { id: 'policy_name', label: 'Policy name', control: 'text', default: 'team-a-iaas-limits' },
      {
        id: 'scope',
        label: 'Applies to',
        control: 'select',
        options: [
          { value: 'organization', label: 'The whole organization' },
          { value: 'project', label: 'One project' },
        ],
        default: 'project',
      },
      { id: 'project', label: 'Project', control: 'text', default: 'web-shop', hint: 'Its id goes in PROJECT_ID (script) or projectId (workflow)', showWhen: { input: 'scope', equals: ['project'] } },
      {
        id: 'enforcement',
        label: 'Enforcement',
        control: 'select',
        options: [
          { value: 'Deny', label: 'Deny — the request is refused' },
          { value: 'Warn', label: 'Warn — allowed, with a warning to the requester' },
          { value: 'Audit', label: 'Audit — allowed, recorded in the audit log' },
        ],
        default: 'Deny',
      },
      {
        id: 'services',
        label: 'Services allowed',
        control: 'checklist',
        options: Object.entries(SERVICE_KINDS).map(([value, s]) => ({ value, label: s.label })),
        default: 'vm-service,vks,volumes',
        hint: 'Kinds of an unticked service are refused',
      },
      { id: 'vm_classes', label: 'VM classes allowed', control: 'text', default: 'best-effort-small, best-effort-medium, best-effort-large', hint: 'Comma separated; empty allows any the namespace has' },
      { id: 'storage_classes', label: 'Storage classes allowed', control: 'text', default: 'vsan-default-storage-policy', hint: 'Comma separated; empty allows any' },
      { id: 'max_workers', label: 'Most VKS workers per node pool', control: 'number', default: 10, min: 0, max: 1000, hint: '0: no limit' },
      {
        id: 'control_plane',
        label: 'VKS control plane',
        control: 'select',
        options: [
          { value: 'any', label: 'Any size' },
          { value: '1', label: 'One node only (development)' },
          { value: '3', label: 'Three nodes only (production)' },
          { value: '1,3', label: 'One or three' },
        ],
        default: '1,3',
      },
      { id: 'min_k8s_minor', label: 'Lowest Kubernetes minor version (1.x)', control: 'number', default: 32, min: 0, max: 99, hint: '0: no floor' },
      { id: 'required_labels', label: 'Labels every object must carry', control: 'text', default: 'cost-center', hint: 'Comma separated label keys; empty for none' },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policy = label(str(values, 'policy_name', 'iaas-policy'), 'iaas-policy');
      const project = str(values, 'scope', 'project') === 'project' ? str(values, 'project', '') : '';
      const enforcement = str(values, 'enforcement', 'Deny');
      // An empty tick list is a real answer (nothing allowed), so the default applies only when the input is absent.
      const services = listOf(values['services'] === undefined ? 'vm-service,vks,volumes' : String(values['services'])).filter((s) => s in SERVICE_KINDS);
      const vmClasses = listOf(str(values, 'vm_classes', ''));
      const storageClasses = listOf(str(values, 'storage_classes', ''));
      const maxWorkers = num(values, 'max_workers', 10);
      const cp = str(values, 'control_plane', '1,3');
      const minMinor = num(values, 'min_k8s_minor', 32);
      const required = listOf(str(values, 'required_labels', ''));
      void name;

      const findings: Finding[] = [];
      if (str(values, 'scope', 'project') === 'project' && !project) findings.push(error('vcfa91.iaas.no-project', 'A project-scoped policy needs the project.', { source: SRC }));
      if (services.length === 0) findings.push(warning('vcfa91.iaas.nothing-allowed', 'No service is ticked, so every VM, cluster, volume, database and load balancer request is refused.', { remediation: 'Tick at least the services the project is meant to use.', source: SRC }));
      if (enforcement !== 'Deny') findings.push(info('vcfa91.iaas.not-deny', `${enforcement} lets every request through; it is how to trial a policy, not how to hold a limit.`, { remediation: 'Run it as Warn or Audit for a week, read what it caught, then set Deny.', source: SRC }));
      if (services.includes('vks') && minMinor > 0 && minMinor < 30) findings.push(warning('vcfa91.iaas.old-k8s', `A floor of 1.${minMinor} admits Kubernetes versions VKS no longer supports.`, { source: SRC }));
      if (!services.includes('vks') && (maxWorkers > 0 || cp !== 'any')) findings.push(info('vcfa91.iaas.vks-unused', 'VKS limits are set but VKS is not allowed; the limits are written but never reached.', { source: SRC }));
      for (const c of [...vmClasses, ...storageClasses]) if (!kit.LABEL.test(c)) findings.push(warning('vcfa91.iaas.name', `"${c}" is not a Kubernetes name; no class can be called that.`, { source: SRC }));

      // The validations, in CEL, as the policy (and a ValidatingAdmissionPolicy) evaluates them.
      const rules: CelRule[] = [];
      for (const [id, s] of Object.entries(SERVICE_KINDS)) {
        if (!services.includes(id)) rules.push({ name: `no-${id}`, kinds: s.kinds, expression: 'false', message: `${s.label} are not allowed by policy ${policy}.` });
      }
      if (services.includes('vm-service') && vmClasses.length > 0) rules.push({ name: 'vm-class', kinds: ['VirtualMachine'], expression: `object.spec.className in ${celList(vmClasses)}`, message: `VM class must be one of ${vmClasses.join(', ')}.` });
      if (services.includes('vm-service') && storageClasses.length > 0) rules.push({ name: 'vm-storage-class', kinds: ['VirtualMachine'], expression: `!has(object.spec.storageClass) || object.spec.storageClass in ${celList(storageClasses)}`, message: `Storage class must be one of ${storageClasses.join(', ')}.` });
      if (services.includes('volumes') && storageClasses.length > 0) rules.push({ name: 'pvc-storage-class', kinds: ['PersistentVolumeClaim'], expression: `has(object.spec.storageClassName) && object.spec.storageClassName in ${celList(storageClasses)}`, message: `Storage class must be one of ${storageClasses.join(', ')}.` });
      if (services.includes('vks')) {
        if (maxWorkers > 0) rules.push({ name: 'vks-workers', kinds: ['Cluster'], expression: `!has(object.spec.topology.workers) || !has(object.spec.topology.workers.machineDeployments) || object.spec.topology.workers.machineDeployments.all(md, !has(md.replicas) || md.replicas <= ${maxWorkers})`, message: `At most ${maxWorkers} workers per node pool.` });
        if (cp !== 'any') rules.push({ name: 'vks-control-plane', kinds: ['Cluster'], expression: `has(object.spec.topology.controlPlane.replicas) && object.spec.topology.controlPlane.replicas in [${cp}]`, message: `The control plane is ${cp.replace(',', ' or ')} node(s).` });
        if (minMinor > 0) rules.push({ name: 'vks-version', kinds: ['Cluster'], expression: `int(object.spec.topology.version.split('.')[1]) >= ${minMinor}`, message: `Kubernetes 1.${minMinor} or later.` });
        if (vmClasses.length > 0) rules.push({ name: 'vks-vm-class', kinds: ['Cluster'], expression: `!has(object.spec.topology.variables) || object.spec.topology.variables.all(v, v.name != 'vmClass' || v.value in ${celList(vmClasses)})`, message: `Node VM class must be one of ${vmClasses.join(', ')}.` });
      }
      const governed = services.flatMap((s) => SERVICE_KINDS[s]!.kinds);
      for (const key of required) {
        if (governed.length > 0) rules.push({ name: `label-${label(key, 'label')}`, kinds: governed, expression: `has(object.metadata.labels) && '${key}' in object.metadata.labels`, message: `Every object carries the label ${key}.` });
      }
      if (rules.length === 0) findings.push(warning('vcfa91.iaas.empty', 'The policy has no rule: every service is allowed and nothing is limited.', { source: SRC }));

      const resourceRules = Object.values(SERVICE_KINDS).map((s) => ({ apiGroups: [s.group], apiVersions: ['*'], operations: ['CREATE', 'UPDATE'], resources: [...s.resources] }));
      const validations = rules.map((r) => ({
        expression: r.kinds.length === Object.values(SERVICE_KINDS).flatMap((s) => s.kinds).length ? r.expression : `!(object.kind in ${celList(r.kinds)}) || (${r.expression})`,
        message: r.message,
      }));
      const body = {
        name: policy,
        description: `IaaS Resource policy: ${services.length} service(s) allowed${project ? ` in project ${project}` : ' across the organization'}.`,
        typeId: 'com.vmware.policy.iaas.resource',
        enforcementType: enforcement === 'Deny' ? 'HARD' : 'SOFT',
        ...(project ? { projectId: '' } : {}),
        definition: {
          validationActions: [enforcement],
          matchConstraints: { resourceRules },
          validations,
        },
      };

      const vap = k8sYaml([
        {
          comment: [`What policy ${policy} enforces, as a ValidatingAdmissionPolicy. VCF Automation creates the`, 'equivalent in every namespace the policy covers; this file is the readable form, not a second copy to apply.'],
          object: { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: policy }, spec: { failurePolicy: 'Fail', matchConstraints: { resourceRules }, validations } },
        },
        {
          object: {
            apiVersion: 'admissionregistration.k8s.io/v1',
            kind: 'ValidatingAdmissionPolicyBinding',
            metadata: { name: policy },
            spec: { policyName: policy, validationActions: [enforcement], ...(project ? { matchResources: { namespaceSelector: { matchLabels: { 'infrastructure.cci.vmware.com/project': project } } } } : {}) },
          },
        },
      ]);

      const apply = restScript({
        purpose: `Create the IaaS Resource policy ${policy}${project ? ` for project ${project}` : ''}.`,
        scope: 'tenant',
        act: true,
        body: [
          'cd "$(dirname "$0")/.."',
          ...(project ? [': "${PROJECT_ID:?set PROJECT_ID to the id of project ' + project + ' (GET /project-service/api/projects, or the project URL in the interface)}"'] : []),
          ...policyApplyLines({ file: 'iaas-resource-policy.json', name: policy, typeName: 'iaas.?resource', typeId: 'com.vmware.policy.iaas.resource' }),
        ],
        undo: `DELETE /policy/api/policies/<id> of ${policy}; requests are no longer checked from that moment.`,
      });

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'iaaspolicy', policy),
        description: `Creates the All Apps IaaS Resource policy ${policy} in VCF Automation 9.1.`,
        categoryPath: `${AREA}/Policies/IaaS Resource/${policy}`,
        workflow: {
          name: `Create IaaS Resource policy ${policy}`,
          description: `Finds the IaaS Resource policy type at /policy/api/policyTypes (or takes policyTypeId), then creates the policy ${policy} (${enforcement}, ${rules.length} rule(s)) through /policy/api/policies unless a policy of that name and type exists. With the dryRun input set to true it reads and reports, and creates nothing.`,
          inputs: [kit.DRY_RUN_INPUT],
          outputs: POLICY_OUTPUTS,
          script: policyWorkflow(kit, 'policy.json'),
        },
        config: policyConfig(kit, `IaaS Resource policy ${policy}`, ''),
        resources: [{ name: 'policy.json', content: json({ typeName: 'iaas.?resource', typeId: 'com.vmware.policy.iaas.resource', ...(project ? { project } : {}), body }) }],
      });

      return {
        platform: PLATFORM,
        title: `IaaS Resource policy ${policy}`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: `Every create or update of a governed kind in ${project ? `project ${project}` : 'the organization'}: VCF Automation checks it before the Supervisor sees it.` },
        scope: {
          what: `${project ? `Namespaces of project ${project}` : 'Every namespace of the organization'}: ${Object.values(SERVICE_KINDS).map((s) => s.kinds.join('/')).join(', ')}.`,
          decidedBy: ['The policy scope (organization, or the project id given).', 'The kinds in matchConstraints, and each rule’s own kind check.', 'Other IaaS Resource policies on the same scope: every one that matches must pass.'],
          ifWrong: 'A Deny policy on the organization with a rule that is too tight refuses every new VM or cluster in every project, including the ones that fix an outage.',
        },
        guardrails: [
          { rule: 'Created only when no policy of that name and type exists; never updates one', because: 'A policy someone tuned in the interface is not overwritten by a rerun.' },
          { rule: enforcement === 'Deny' ? 'Deny: try it as Warn or Audit first' : `${enforcement}: requests are not refused`, because: 'A rule written wrongly in CEL refuses everything it matches; Warn shows what it would refuse.' },
          { rule: 'Objects that already exist are not changed by a new policy', because: 'Admission checks creates and updates; a running VM on a class now disallowed keeps running until someone edits it.' },
        ],
        dryRun: ['Run the workflow with dryRun true, or scripts/apply-policy.sh --dry-run: both find the type and report what they would create.', 'Or create it with enforcement Warn and read the warnings the requests get.'],
        undo: [`DELETE /policy/api/policies/<id>, or delete ${policy} under Manage & Govern → Policies.`],
        told: ['Requesters see the rule’s message on a refused or warned request.', 'The VCF Automation audit log (and the Kubernetes audit log for Audit enforcement).', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: ['An All Apps organization on VCF Automation 9.1, and an organization administrator’s API token.', ...(project ? [`The id of project ${project}.`] : [])],
        files: {
          ...pkg.files,
          'iaas-resource-policy.json': json(body),
          'iaas-resource-policy.vap.yaml': vap,
          'scripts/apply-policy.sh': apply,
          'IMPORT.md': importMd({
            subject: `The IaaS Resource policy ${policy}: an Orchestrator workflow and a script that create it through /policy/api, and the same rules as a ValidatingAdmissionPolicy to read.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              manualStep('Or: the script', [`\`VCFA_HOST=… VCFA_ORG=… VCFA_API_TOKEN_FILE=…${project ? ' PROJECT_ID=…' : ''} ./scripts/apply-policy.sh\` finds the policy type by name and creates the policy unless it exists; \`--dry-run\` only reads. POLICY_TYPE_ID overrides the type.`]),
              manualStep('If the policy type is not found', ['Create one IaaS Resource policy under Manage & Govern → Policies → IaaS Resource (any rule), then `GET /policy/api/policies` shows its typeId and the shape of its definition. Set POLICY_TYPE_ID (or policyTypeId) and compare the definition with iaas-resource-policy.json.']),
            ],
            auth: ['vcfa91'],
            verify: [
              'VERIFY: the typeId (com.vmware.policy.iaas.resource is a guess the scripts only fall back to) and the definition fields (validationActions, matchConstraints, validations). IaaS Resource policies are CEL validations on Supervisor objects; the field names here follow the Kubernetes ValidatingAdmissionPolicy they are enforced as.',
              'The CEL: kubectl apply the .vap.yaml on a test cluster with --dry-run=server to have the API server compile every expression.',
              'VERIFY: the namespace label infrastructure.cci.vmware.com/project in the binding (kubectl get ns --show-labels in a project namespace).',
            ],
          }),
        },
        notes: [
          '9.1 All Apps policies: Approval, Day 2 Action, Lease, IaaS Resource and Deployment Criteria. The first three are also on this page for VM Apps (/policy/api, as in 8.x).',
          'The VKS rules read the ClusterClass topology (spec.topology.workers.machineDeployments[].replicas, controlPlane.replicas, version, variables vmClass) of a cluster.x-k8s.io Cluster.',
          'Enforcement Deny, Warn and Audit are the Kubernetes validationActions. The policy checks creates and updates; delete is never refused.',
        ],
        findings,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Infrastructure policy (provider) and Deployment Criteria (organization)

const CAPABILITIES: Readonly<Record<string, { capability: string; label: string; hostTag: boolean }>> = {
  vm_host_affinity: { capability: 'com.vmware.vcenter.compute.policies.capabilities.vm_host_affinity', label: 'VM-host affinity: run only on the tagged hosts', hostTag: true },
  vm_host_anti_affinity: { capability: 'com.vmware.vcenter.compute.policies.capabilities.vm_host_anti_affinity', label: 'VM-host anti-affinity: never on the tagged hosts', hostTag: true },
  vm_vm_anti_affinity: { capability: 'com.vmware.vcenter.compute.policies.capabilities.vm_vm_anti_affinity', label: 'VM-VM anti-affinity: spread the tagged VMs over hosts', hostTag: false },
  vm_vm_affinity: { capability: 'com.vmware.vcenter.compute.policies.capabilities.vm_vm_affinity', label: 'VM-VM affinity: keep the tagged VMs together', hostTag: false },
};

const CRITERIA_FIELDS = ['vmClass', 'guestOS', 'label', 'image', 'namespace'];
const CRITERIA_OPS = ['equals', 'notEquals', 'in', 'startsWith', 'contains'];

function infrastructurePolicy(kit: Vcfa91Kit): AutomationBlueprint {
  const { PLATFORM, SRC, PROVIDER, ALL_APPS, AREA, json, label, restScript } = kit;
  return automationBlueprint({
    id: 'vcfa91_infrastructure_policy',
    platform: PLATFORM,
    label: 'A provider Infrastructure policy (VM-host affinity), and the Deployment Criteria that pick the VMs',
    group: 'VCF Automation 9.1 — governance',
    description:
      'VM placement the 9.1 way: a vSphere compute policy (VM-host affinity or anti-affinity against a host tag, or VM-VM rules) created in vCenter, a provider Infrastructure policy over it — mandatory for every VM in the region quotas named, or optional — and, for an optional one, the organization’s Deployment Criteria policy that says which VMs get it: by VM class, guest OS, label, image or namespace.',
    inputs: [
      { id: 'policy_name', label: 'Infrastructure policy', control: 'text', default: 'gpu-hosts' },
      {
        id: 'capability',
        label: 'Placement rule',
        control: 'select',
        options: Object.entries(CAPABILITIES).map(([value, c]) => ({ value, label: c.label })),
        default: 'vm_host_affinity',
      },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'host_tag', label: 'Host tag (Category:Tag)', control: 'text', default: 'Placement:gpu', hint: 'On the hosts, in vCenter', showWhen: { input: 'capability', equals: ['vm_host_affinity', 'vm_host_anti_affinity'] } },
      { id: 'vm_tag', label: 'VM tag (Category:Tag)', control: 'text', default: 'Placement:gpu-workload', hint: 'The tag the policy puts on the VMs it covers' },
      { id: 'mandatory', label: 'Mandatory for every VM in the quotas', control: 'toggle', default: false, hint: 'Off: optional, applied by Deployment Criteria' },
      { id: 'region_quotas', label: 'Region quotas it applies to', control: 'text', default: 'team-a-region1', hint: 'Comma separated' },
      { id: 'org', label: 'Organization (Deployment Criteria)', control: 'text', default: 'team-a', showWhen: { input: 'mandatory', equals: ['false'] } },
      { id: 'criteria_name', label: 'Deployment Criteria policy', control: 'text', default: 'gpu-workloads-on-gpu-hosts', showWhen: { input: 'mandatory', equals: ['false'] } },
      {
        id: 'criteria',
        label: 'Matching criteria',
        control: 'textarea',
        default: 'vmClass | in | gpu-a100-small, gpu-a100-large\nlabel | equals | workload=ai',
        hint: 'field | operator | value',
        help: `Field: ${CRITERIA_FIELDS.join(', ')}. Operator: ${CRITERIA_OPS.join(', ')}. Every row must match (AND).`,
        showWhen: { input: 'mandatory', equals: ['false'] },
      },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const policy = label(str(values, 'policy_name', 'placement'), 'placement');
      const capKey = str(values, 'capability', 'vm_host_affinity');
      const cap = CAPABILITIES[capKey] ?? CAPABILITIES['vm_host_affinity']!;
      const vcenter = str(values, 'vcenter', 'vcenter');
      const hostTag = cap.hostTag ? str(values, 'host_tag', '') : '';
      const vmTag = str(values, 'vm_tag', '');
      const mandatory = bool(values, 'mandatory', false);
      const quotas = listOf(str(values, 'region_quotas', ''));
      const org = str(values, 'org', 'team-a');
      const criteriaName = label(str(values, 'criteria_name', `${policy}-criteria`), 'criteria');
      void name;

      const findings: Finding[] = [];
      const tagOk = (t: string) => /^[^:]+:[^:]+$/.test(t);
      if (cap.hostTag && !tagOk(hostTag)) findings.push(error('vcfa91.infra.host-tag', `"${hostTag}" is not Category:Tag.`, { remediation: 'The host tag is how vCenter knows which hosts the rule means; it must exist on those hosts first.', source: SRC }));
      if (!tagOk(vmTag)) findings.push(error('vcfa91.infra.vm-tag', `"${vmTag}" is not Category:Tag.`, { source: SRC }));
      if (quotas.length === 0) findings.push(error('vcfa91.infra.no-quota', 'The policy is attached to no region quota, so it applies to nothing.', { source: SRC }));
      if (mandatory && capKey === 'vm_host_affinity') findings.push(warning('vcfa91.infra.mandatory-affinity', 'A mandatory VM-host affinity puts every VM of those quotas on the tagged hosts only.', { remediation: 'If those hosts are few, the quotas are only as large as they are; an outage of them stops every VM from starting elsewhere.', source: SRC }));

      const criteria = mandatory
        ? []
        : rowsOf(str(values, 'criteria', '')).map(({ cells, line }) => {
            const [field = '', op = '', value = ''] = cells;
            if (!CRITERIA_FIELDS.includes(field)) findings.push(error('vcfa91.infra.criteria-field', `"${field}" is not a criteria field (${CRITERIA_FIELDS.join(', ')}).`, { path: line, source: SRC }));
            if (!CRITERIA_OPS.includes(op)) findings.push(error('vcfa91.infra.criteria-op', `"${op}" is not an operator (${CRITERIA_OPS.join(', ')}).`, { path: line, source: SRC }));
            if (field === 'label' && !value.includes('=')) findings.push(error('vcfa91.infra.criteria-label', `A label criterion is key=value, not "${value}".`, { path: line, source: SRC }));
            return { field, operator: op, value: op === 'in' ? listOf(value) : value };
          });
      if (!mandatory && criteria.length === 0) findings.push(error('vcfa91.infra.no-criteria', 'An optional infrastructure policy applies only where Deployment Criteria select VMs, and none are given.', { source: SRC }));

      const computePolicy = { capability: cap.capability, name: policy, description: `${cap.label}. Infrastructure policy ${policy}.`, vm_tag: '<VM_TAG_ID>', ...(cap.hostTag ? { host_tag: '<HOST_TAG_ID>' } : {}) };
      const infraBody = {
        name: policy,
        description: `${cap.label} (vSphere compute policy ${policy}), ${mandatory ? 'mandatory' : 'optional'}.`,
        policyType: capKey.toUpperCase(),
        computePolicyName: policy,
        vmTag: vmTag,
        ...(cap.hostTag ? { hostTag } : {}),
        enforcement: mandatory ? 'MANDATORY' : 'OPTIONAL',
        regionQuotas: quotas.map((qn) => ({ name: qn })),
      };
      const criteriaBody = {
        name: criteriaName,
        description: `Places the matching VMs under infrastructure policy ${policy}.`,
        typeId: 'com.vmware.policy.deployment.criteria',
        enforcementType: 'HARD',
        definition: { infrastructurePolicy: policy, match: 'ALL', criteria },
      };

      const manual = `Provider portal → Infrastructure → Infrastructure Policies → New: name ${policy}, rule ${cap.label.split(':')[0]}, compute policy ${policy}, ${mandatory ? 'Mandatory' : 'Optional'}, region quotas ${quotas.join(', ')}.`;

      const vcScript = [
        '#!/usr/bin/env bash',
        `# Create the vSphere compute policy ${policy} (${capKey}) in vCenter ${vcenter}, unless one of that name exists.`,
        '#',
        '# Applies when run. With --dry-run this only reads and prints what it would send.',
        'set -euo pipefail',
        'cd "$(dirname "$0")/.."',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        `VCENTER_HOST="\${VCENTER_HOST:-${vcenter}}"`,
        'DRY_RUN=0',
        '[[ " $* " == *" --dry-run "* ]] && DRY_RUN=1',
        ...vcenterAuthLines(),
        ...vcenterTagLines(),
        '',
        `NAME=${JSON.stringify(policy)}`,
        "if vc GET /api/vcenter/compute/policies | jq -e --arg n \"$NAME\" '[.[] | select(.name == $n)] | length > 0' >/dev/null; then",
        '  echo "Exists, left as it is: compute policy ${NAME}"',
        '  exit 0',
        'fi',
        `VM_TAG_ID=$(tag_id ${JSON.stringify(vmTag)})`,
        ...(cap.hostTag ? [`HOST_TAG_ID=$(tag_id ${JSON.stringify(hostTag)})`] : ['HOST_TAG_ID=""']),
        "BODY=$(jq --arg v \"$VM_TAG_ID\" --arg h \"$HOST_TAG_ID\" '.vm_tag = $v | if has(\"host_tag\") then .host_tag = $h else . end' compute-policy.json)",
        'if (( DRY_RUN )); then echo "DRY RUN: would POST /api/vcenter/compute/policies:"; echo "$BODY"; exit 0; fi',
        'vc POST /api/vcenter/compute/policies --data "$BODY"',
        'echo',
        'echo "Created compute policy ${NAME}."',
        '',
        '# Undo: DELETE /api/vcenter/compute/policies/<policy> once no infrastructure policy uses it.',
        '',
      ].join('\n');

      const infraScript = restScript({
        purpose: `Create the provider infrastructure policy ${policy} (${mandatory ? 'mandatory' : 'optional'}) over compute policy ${policy}.`,
        scope: 'provider',
        act: true,
        checkVersion: true,
        body: [
          'cd "$(dirname "$0")/.."',
          `NAME=${JSON.stringify(policy)}`,
          '# VERIFY: the provider path. A 404 means this release keeps it elsewhere: the steps below are the portal route.',
          'if ! L=$(probe "/cloudapi/vcf/infrastructurePolicies?filter=name==${NAME}"); then',
          `  echo ${JSON.stringify(`Not created. By hand: ${manual}`)}`,
          '  exit 1',
          'fi',
          "if [[ \"$(jq --arg n \"$NAME\" '[.values[]? | select(.name == $n)] | length' <<<\"$L\")\" -gt 0 ]]; then",
          '  echo "Exists, left as it is: infrastructure policy ${NAME}"',
          'else',
          '  send POST /cloudapi/vcf/infrastructurePolicies infrastructure-policy.json',
          'fi',
        ],
        undo: `DELETE /cloudapi/vcf/infrastructurePolicies/<id>, or delete ${policy} in the provider portal; VMs already placed stay where they are.`,
      });

      const criteriaScript = restScript({
        purpose: `Create the Deployment Criteria policy ${criteriaName} in ${org}: matching VMs get infrastructure policy ${policy}.`,
        scope: 'tenant',
        act: true,
        body: ['cd "$(dirname "$0")/.."', ...policyApplyLines({ file: 'deployment-criteria.json', name: criteriaName, typeName: 'deployment.?criteria', typeId: 'com.vmware.policy.deployment.criteria' })],
        undo: `DELETE /policy/api/policies/<id> of ${criteriaName}; new VMs stop getting ${policy}.`,
      });

      const infraWorkflow = [
        kit.LOGIN_JS('provider'),
        kit.CLOUDAPI_JS,
        String.raw`var want = JSON.parse(core.resource(RESOURCE_PATH, "infrastructure-policy.json"));
var MANUAL = ${JSON.stringify(manual)};
var ctx = core.begin(settings, dryRun);
${kit.CLOUD_LOGIN_JS}
var list = cloudList("vcf/infrastructurePolicies?" + filterOf("name==" + want.name));
if (list === null) throw new Error("VERIFY: /cloudapi/vcf/infrastructurePolicies is not on this release; nothing was created. By hand: " + MANUAL);
var same = exactly(list, "name", want.name);
var policyId = "";
if (same.length > 0) {
  policyId = String(same[0].id);
  System.log("Exists, left as it is: infrastructure policy " + want.name + " (" + policyId + ")");
} else {
  policyId = core.act(ctx, "create " + want.enforcement + " infrastructure policy " + want.name + " for region quota(s) " + JSON.stringify(want.regionQuotas), function () {
    var r = cloudSend("POST", "vcf/infrastructurePolicies", want);
    return r.body && r.body.id ? String(r.body.id) : "";
  }) || "";
}
createdObjects = policyId;
summary = core.audit(ctx, { infrastructurePolicy: want.name, id: policyId });
core.notify(settings.webhook, summary);`,
      ].join('\n');

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'infrapolicy', policy),
        description: `Creates the provider infrastructure policy ${policy} in VCF Automation 9.1.`,
        categoryPath: `${AREA}/Policies/Infrastructure/${policy}`,
        workflow: {
          name: `Create infrastructure policy ${policy}`,
          description: `Provider work. Creates the ${mandatory ? 'mandatory' : 'optional'} infrastructure policy ${policy} over the vSphere compute policy of the same name, for region quota(s) ${quotas.join(', ')}, unless it exists. The compute policy itself is made in vCenter first (scripts/create-compute-policy.sh). With dryRun true it reads and reports only.`,
          inputs: [kit.DRY_RUN_INPUT],
          outputs: POLICY_OUTPUTS,
          script: infraWorkflow,
        },
        config: {
          name: 'Settings',
          description: 'Settings of the infrastructure policy workflow. Fill vcfaApiToken (a provider API token) after import; set dryRun to false only after a dry run.',
          attributes: [kit.VCFA_HOST_ATTR, kit.TOKEN_ATTR('a provider administrator'), kit.API_VERSION_ATTR, ...kit.GUARD_ATTRS(1), kit.WEBHOOK_ATTR],
        },
        resources: [{ name: 'infrastructure-policy.json', content: json(infraBody) }],
      });

      return {
        platform: PLATFORM,
        title: `Infrastructure policy ${policy} (${mandatory ? 'mandatory' : 'optional'})`,
        effect: 'reversible',
        trigger: { kind: 'request', detail: mandatory ? `Every VM placed in region quota(s) ${quotas.join(', ')}.` : `Every VM in ${org} that matches the Deployment Criteria of ${criteriaName}.` },
        scope: {
          what: `VMs ${mandatory ? `in ${quotas.join(', ')}` : `matched by ${criteria.length} criteria row(s) in ${org}`}, placed by ${cap.label.toLowerCase()}${hostTag ? ` (${hostTag})` : ''}.`,
          decidedBy: ['The region quotas the infrastructure policy is attached to.', mandatory ? 'Mandatory: every VM in them.' : 'Optional: the Deployment Criteria rows, all of which must match.', `The hosts carrying ${hostTag || 'the host tag'} in vCenter, which can change without anyone touching this policy.`],
          ifWrong: 'VMs pinned to too few hosts do not start when those hosts are down; VMs kept off hosts they need land nowhere and stay pending.',
        },
        guardrails: [
          { rule: 'Every object is created only when none of that name exists', because: 'A placement rule someone tuned is not overwritten by a rerun.' },
          { rule: 'The compute policy is looked up by tag names, and the script stops when a tag does not exist', because: 'A policy on a tag no host carries puts every VM it covers nowhere.' },
          { rule: mandatory ? 'Mandatory is a deliberate choice, flagged on the page' : 'Optional: only VMs the criteria match are affected', because: 'A mandatory VM-host rule turns a small host group into the capacity of the whole quota.' },
        ],
        dryRun: ['Each script takes --dry-run and only reads; the workflow with dryRun true reports what it would create.', `In vCenter, the compute policy's compliance view shows which VMs it would cover before VCF Automation attaches it.`],
        undo: [`Delete the Deployment Criteria policy ${criteriaName}, then the infrastructure policy ${policy}, then the compute policy in vCenter. VMs already placed are not moved back.`],
        told: ['vCenter tasks and events for the compute policy and its compliance.', 'VCF Automation provider events and the policy audit log.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: [`Hosts tagged ${hostTag || '(VM-VM rules need no host tag)'} and the tag ${vmTag} in vCenter.`, 'A provider API token; for Deployment Criteria, an organization administrator’s token of ' + org + '.', 'VCF Automation 9.1: infrastructure policies are new in 9.1.'],
        files: {
          ...pkg.files,
          'compute-policy.json': json(computePolicy),
          'infrastructure-policy.json': json(infraBody),
          ...(mandatory ? {} : { 'deployment-criteria.json': json(criteriaBody), 'scripts/apply-deployment-criteria.sh': criteriaScript }),
          'scripts/create-compute-policy.sh': vcScript,
          'scripts/apply-infrastructure-policy.sh': infraScript,
          'IMPORT.md': importMd({
            subject: `Infrastructure policy ${policy}: a vSphere compute policy made in vCenter, the provider infrastructure policy over it (an Orchestrator workflow or a script)${mandatory ? '' : `, and the Deployment Criteria policy ${criteriaName} of ${org}`}.`,
            orgs: `${PROVIDER}; ${ALL_APPS}`,
            steps: [
              manualStep('The compute policy, in vCenter', ['`VCENTER_USER=… VCENTER_PASSWORD_FILE=… ./scripts/create-compute-policy.sh` resolves the tags by name and creates the compute policy unless it exists; `--dry-run` prints the body.']),
              ...pkg.importSteps,
              manualStep('Or: the infrastructure policy by script', ['`VCFA_HOST=… VCFA_API_TOKEN_FILE=<provider token file> ./scripts/apply-infrastructure-policy.sh`; if the path answers 404 it says so and prints the portal steps.']),
              ...(mandatory ? [] : [manualStep('The Deployment Criteria policy (organization administrator)', [`\`VCFA_HOST=… VCFA_ORG=${org} VCFA_API_TOKEN_FILE=… ./scripts/apply-deployment-criteria.sh\` finds the Deployment Criteria type by name and creates ${criteriaName} unless it exists.`])]),
            ],
            auth: ['vcfa91'],
            verify: [
              'The compute policy (POST /api/vcenter/compute/policies with capability, name, description, vm_tag, host_tag) and tagging (list-tags-for-category) are the vSphere Automation API.',
              'VERIFY: /cloudapi/vcf/infrastructurePolicies and its body (policyType, computePolicyName, enforcement MANDATORY/OPTIONAL, regionQuotas). Infrastructure policies are new in VCF Automation 9.1 and not in the public API reference; the script probes the path and prints the portal steps when it is not there.',
              ...(mandatory ? [] : ['VERIFY: the Deployment Criteria typeId and definition (infrastructurePolicy, match, criteria[field, operator, value]); read one made in the interface with GET /policy/api/policies.']),
            ],
          }),
        },
        notes: [
          '9.1 infrastructure policies: the provider defines placement over vSphere compute policies and makes each mandatory (always applied in the region quotas named) or optional (applied where an organization’s Deployment Criteria policy matches).',
          'VM-host affinity is a hard rule in vSphere compute policies: DRS will not place a covered VM on a host without the tag.',
        ],
        findings,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Organization users, groups and roles

const ORG_ROLES = ['Organization Administrator', 'Organization Auditor', 'Organization User'];
const PROJECT_ROLES = ['admin', 'edit', 'view'];

function orgAccess(kit: Vcfa91Kit): AutomationBlueprint {
  const { PLATFORM, SRC, ALL_APPS, AREA, json, label, restScript, kubeScript, k8sYaml } = kit;
  return automationBlueprint({
    id: 'vcfa91_org_users_roles',
    platform: PLATFORM,
    label: 'Organization users, groups and roles, and who may do what in each project',
    group: 'VCF Automation 9.1 — access',
    description:
      'Access to an All Apps organization: identity-provider groups and users imported with an organization role (Organization Administrator, Auditor, User, or a custom role built from named rights), and project roles (admin, edit, view) given as ProjectRoleBindings in each project.',
    inputs: [
      { id: 'org', label: 'Organization', control: 'text', default: 'team-a' },
      {
        id: 'provider_type',
        label: 'Identity source',
        control: 'select',
        options: [
          { value: 'OAUTH', label: 'OIDC (VCF Identity Broker or another IdP)' },
          { value: 'INTEGRATED', label: 'LDAP / Active Directory' },
          { value: 'SAML', label: 'SAML' },
        ],
        default: 'OAUTH',
      },
      {
        id: 'assignments',
        label: 'Who',
        control: 'textarea',
        default: 'vcfa-team-a-admins | group | Organization Administrator | - | -\nteam-a-devs | group | Organization User | web-shop | edit\nteam-a-auditors | group | Organization Auditor | web-shop | view',
        hint: 'principal | group or user | organization role | project | project role',
        help: `Organization role: ${ORG_ROLES.join(', ')}, or the custom role below. Project role: ${PROJECT_ROLES.join(', ')}. "-" for no project.`,
      },
      { id: 'custom_role', label: 'Also create a custom role', control: 'toggle', default: false },
      { id: 'custom_role_name', label: 'Custom role name', control: 'text', default: 'Namespace Operator', showWhen: { input: 'custom_role', equals: ['true'] } },
      { id: 'custom_rights', label: 'Rights in it', control: 'textarea', default: 'Organization: View\nProject: View\nNamespace: View\nNamespace: Manage', hint: 'One right name per line, as GET /cloudapi/1.0.0/rights names it', showWhen: { input: 'custom_role', equals: ['true'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const org = str(values, 'org', 'team-a');
      const providerType = str(values, 'provider_type', 'OAUTH');
      const custom = bool(values, 'custom_role', false);
      const customName = str(values, 'custom_role_name', 'Custom Role');
      const rights = custom ? str(values, 'custom_rights', '').split('\n').map((r) => r.trim()).filter(Boolean) : [];
      void name;

      const findings: Finding[] = [];
      const rows = rowsOf(str(values, 'assignments', '')).map(({ cells, line }) => {
        const [principal = '', type = 'group', orgRole = '', project = '-', projectRole = '-'] = cells;
        const kind = type.toLowerCase() === 'user' ? 'user' : 'group';
        if (!['user', 'group'].includes(type.toLowerCase())) findings.push(error('vcfa91.access.type', `"${type}" is neither group nor user.`, { path: line, source: SRC }));
        if (!principal) findings.push(error('vcfa91.access.principal', 'A row has no principal.', { path: line, source: SRC }));
        if (orgRole && orgRole !== '-' && !ORG_ROLES.includes(orgRole) && !(custom && orgRole === customName)) {
          findings.push(warning('vcfa91.access.org-role', `"${orgRole}" is not a built-in organization role; the script stops if no role of that name exists.`, { remediation: `Built in: ${ORG_ROLES.join(', ')}. VERIFY the names with GET /cloudapi/1.0.0/roles.`, path: line, source: SRC }));
        }
        const hasProject = project !== '' && project !== '-';
        if (hasProject && !PROJECT_ROLES.includes(projectRole)) findings.push(error('vcfa91.access.project-role', `"${projectRole}" is not a project role (${PROJECT_ROLES.join(', ')}).`, { path: line, source: SRC }));
        if (hasProject && !kit.LABEL.test(project)) findings.push(error('vcfa91.access.project', `"${project}" is not a project name.`, { path: line, source: SRC }));
        return { principal, kind, orgRole: orgRole === '-' ? '' : orgRole, project: hasProject ? project : '', projectRole: hasProject ? projectRole : '' };
      });
      if (rows.length === 0) findings.push(error('vcfa91.access.none', 'No one is listed.', { source: SRC }));
      if (!rows.some((r) => r.orgRole === 'Organization Administrator')) findings.push(warning('vcfa91.access.no-admin', 'No group or user is an Organization Administrator here.', { remediation: 'Keep at least one administrator group that is not a person, or the organization is administered only by the provider.', source: SRC }));
      const users = rows.filter((r) => r.kind === 'user');
      if (users.length > 0) findings.push(info('vcfa91.access.users', `${users.length} individual user(s): access that leaves with the person is easier to manage as a group in the identity provider.`, { source: SRC }));
      if (custom && rights.length === 0) findings.push(error('vcfa91.access.no-rights', 'The custom role has no rights.', { source: SRC }));

      const principals = rows.filter((r) => r.orgRole).map((r) => ({ name: r.principal, type: r.kind, providerType, role: r.orgRole }));
      const bindings: Vcfa91KubeObject[] = rows
        .filter((r) => r.project)
        .map((r) => ({
          plural: 'projectrolebindings',
          object: {
            apiVersion: 'authorization.cci.vmware.com/v1alpha1',
            kind: 'ProjectRoleBinding',
            metadata: { name: `cci:${r.kind}:${r.principal}`, namespace: r.project },
            roleRef: { apiGroup: 'authorization.cci.vmware.com', kind: 'ProjectRole', name: r.projectRole },
            subjects: [{ kind: r.kind === 'user' ? 'User' : 'Group', name: r.principal }],
          },
        }));
      const access = { principals, customRole: custom ? { name: customName, description: `Custom role for ${org}.`, rights } : null, bindings };

      const orgScript = restScript({
        purpose: `Import groups and users into ${org} with their organization roles${custom ? `, after creating the custom role ${customName}` : ''}.`,
        scope: 'tenant',
        act: true,
        checkVersion: true,
        body: [
          'cd "$(dirname "$0")/.."',
          'role_id() {  # role_id NAME — the id of the one role of that name, or stop',
          '  local r',
          '  r=$(get "/cloudapi/1.0.0/roles?filter=name==$(jq -rn --arg n "$1" \'$n | @uri\')")',
          "  jq -r --arg n \"$1\" '[.values[]? | select(.name == $n) | .id][0] // empty' <<<\"$r\"",
          '}',
          ...(custom
            ? [
                `CUSTOM=${JSON.stringify(customName)}`,
                'if [[ -n "$(role_id "$CUSTOM")" ]]; then',
                '  echo "Exists, left as it is: role ${CUSTOM}"',
                'else',
                '  RIGHTS="[]"',
                "  while IFS= read -r right; do",
                '    R=$(get "/cloudapi/1.0.0/rights?filter=name==$(jq -rn --arg n "$right" \'$n | @uri\')")',
                "    RID=$(jq -r --arg n \"$right\" '[.values[]? | select(.name == $n) | .id][0] // empty' <<<\"$R\")",
                '    [[ -n "$RID" ]] || { echo "No right named \\"${right}\\" (GET /cloudapi/1.0.0/rights lists them); nothing was created." >&2; exit 1; }',
                "    RIGHTS=$(jq --arg n \"$right\" --arg i \"$RID\" '. + [{name: $n, id: $i}]' <<<\"$RIGHTS\")",
                "  done < <(jq -r '.customRole.rights[]' access.json)",
                '  if (( DRY_RUN )); then echo "DRY RUN: would create role ${CUSTOM} with $(jq length <<<"$RIGHTS") right(s)"; else',
                "    ROLE=$(jq -c '.customRole | {name, description}' access.json)",
                '    NEW=$(curl -sS -f -K <(auth_cfg) -X POST "https://${VCFA_HOST}/cloudapi/1.0.0/roles" -H "Accept: $(cloudapi_type)" -H "Content-Type: $(cloudapi_type)" --data-binary "$ROLE")',
                "    NEW_ID=$(jq -r .id <<<\"$NEW\")",
                "    jq -n --argjson v \"$RIGHTS\" '{values: $v}' | curl -sS -f -K <(auth_cfg) -X PUT \"https://${VCFA_HOST}/cloudapi/1.0.0/roles/${NEW_ID}/rights\" -H \"Accept: $(cloudapi_type)\" -H \"Content-Type: $(cloudapi_type)\" --data-binary @- >/dev/null",
                '    echo "Created role ${CUSTOM} (${NEW_ID})"',
                '  fi',
                'fi',
              ]
            : []),
          '',
          '# Each group or user: left as it is when it exists (its role is not changed), otherwise imported with its role.',
          "jq -c '.principals[]' access.json | while IFS= read -r P; do",
          "  NAME=$(jq -r .name <<<\"$P\"); TYPE=$(jq -r .type <<<\"$P\"); ROLE=$(jq -r .role <<<\"$P\")",
          '  if [[ "$TYPE" == user ]]; then COLL=users; FIELD=username; else COLL=groups; FIELD=name; fi',
          '  ENC=$(jq -rn --arg n "$NAME" \'$n | @uri\')',
          '  EX=$(probe "/cloudapi/1.0.0/${COLL}?filter=${FIELD}==${ENC}") || exit 1',
          "  if [[ \"$(jq --arg n \"$NAME\" --arg f \"$FIELD\" '[.values[]? | select(.[$f] == $n)] | length' <<<\"$EX\")\" -gt 0 ]]; then echo \"Exists, left as it is: ${TYPE} ${NAME}\"; continue; fi",
          '  RID=$(role_id "$ROLE")',
          '  if [[ -z "$RID" ]]; then',
          '    if (( DRY_RUN )); then RID="<id of ${ROLE}>"; else echo "No role named ${ROLE} in ${VCFA_ORG}; ${TYPE} ${NAME} not imported." >&2; exit 1; fi',
          '  fi',
          '  F=$(mktemp)',
          "  jq -n --arg n \"$NAME\" --arg f \"$FIELD\" --arg pt \"$(jq -r .providerType <<<\"$P\")\" --arg r \"$ROLE\" --arg i \"$RID\" '{($f): $n, providerType: $pt, roleEntityRefs: [{name: $r, id: $i}]} + (if $f == \"username\" then {enabled: true} else {} end)' > \"$F\"",
          '  send POST "/cloudapi/1.0.0/${COLL}" "$F"',
          '  rm -f "$F"',
          'done',
        ],
        undo: 'DELETE /cloudapi/1.0.0/groups/<id> (or users/<id>) removes the import and every role it held; the custom role: DELETE /cloudapi/1.0.0/roles/<id> once no one holds it.',
      });

      const bindingsYaml = bindings.length > 0 ? k8sYaml(bindings.map((b) => ({ comment: ['VERIFY: kubectl explain projectrolebinding (authorization.cci.vmware.com) in the organization context'], object: b.object }))) : '';

      const workflow = [
        kit.LOGIN_JS(null),
        kit.CLOUDAPI_JS,
        String.raw`var A = JSON.parse(core.resource(RESOURCE_PATH, "access.json"));
var ctx = core.begin(settings, dryRun);
${kit.CLOUD_LOGIN_JS}
function one(path, field, value, what) {
  var l = cloudList(path + "?" + filterOf(field + "==" + value));
  if (l === null) throw new Error("VERIFY: /cloudapi/" + path + " is not on this release; " + what + " was not handled.");
  var m = exactly(l, field, value);
  return m.length > 0 ? m[0] : null;
}
var done = [];
if (A.customRole) {
  if (one("1.0.0/roles", "name", A.customRole.name, "the custom role")) System.log("Exists, left as it is: role " + A.customRole.name);
  else {
    var refs = [];
    for (var r = 0; r < A.customRole.rights.length; r++) {
      var right = one("1.0.0/rights", "name", A.customRole.rights[r], "the right " + A.customRole.rights[r]);
      if (!right) throw new Error("No right named \"" + A.customRole.rights[r] + "\" (GET /cloudapi/1.0.0/rights lists them); nothing was created.");
      refs.push({ name: String(right.name), id: String(right.id) });
    }
    core.act(ctx, "create role " + A.customRole.name + " with " + refs.length + " right(s)", function () {
      var made = cloudSend("POST", "1.0.0/roles", { name: A.customRole.name, description: A.customRole.description }).body || {};
      if (!made.id) throw new Error("POST /cloudapi/1.0.0/roles returned no id.");
      cloudSend("PUT", "1.0.0/roles/" + encodeURIComponent(String(made.id)) + "/rights", { values: refs });
      return String(made.id);
    });
    if (!ctx.dryRun) done.push("role " + A.customRole.name);
  }
}
for (var i = 0; i < A.principals.length; i++) {
  var p = A.principals[i];
  var coll = p.type === "user" ? "users" : "groups";
  var field = p.type === "user" ? "username" : "name";
  if (one("1.0.0/" + coll, field, p.name, p.type + " " + p.name)) {
    System.log("Exists, left as it is: " + p.type + " " + p.name + " (its role is not changed here)");
    continue;
  }
  var role = one("1.0.0/roles", "name", p.role, "the role " + p.role);
  if (!role && !ctx.dryRun) throw new Error("No role named " + p.role + " in " + ORG + "; " + p.type + " " + p.name + " was not imported.");
  var body = { providerType: p.providerType, roleEntityRefs: [{ name: p.role, id: role ? String(role.id) : "" }] };
  body[field] = p.name;
  if (p.type === "user") body.enabled = true;
  (function (b, what) {
    core.act(ctx, "import " + what, function () { return cloudSend("POST", "1.0.0/" + coll, b).statusCode; });
  })(body, p.type + " " + p.name + " as " + p.role);
  if (!ctx.dryRun) done.push(p.type + " " + p.name);
}
if (A.bindings.length > 0) {
  var cci = "https://" + settings.vcfaHost + "/cci/kubernetes";
  for (var b = 0; b < A.bindings.length; b++) {
    var o = A.bindings[b].object;
    var path = cci + "/apis/authorization.cci.vmware.com/v1alpha1/namespaces/" + encodeURIComponent(o.metadata.namespace) + "/projectrolebindings";
    var ex = core.http("GET", path + "/" + encodeURIComponent(o.metadata.name), auth, null, { allow: [404], redact: SAFE.redact });
    if (ex.statusCode !== 404) {
      System.log("Exists, left as it is: " + o.metadata.name + " in project " + o.metadata.namespace);
      continue;
    }
    (function (url, obj) {
      if (ctx.dryRun) core.http("POST", url + "?dryRun=All", auth, obj, SAFE);
      core.act(ctx, "give " + obj.subjects[0].kind + " " + obj.subjects[0].name + " the " + obj.roleRef.name + " role in project " + obj.metadata.namespace, function () { return core.http("POST", url, auth, obj, SAFE).statusCode; });
    })(path, o);
    if (!ctx.dryRun) done.push(o.metadata.name + " in " + o.metadata.namespace);
  }
}
createdObjects = done.join(", ");
summary = core.audit(ctx, { organization: ORG, created: done });
core.notify(settings.webhook, summary);`,
      ].join('\n');

      const pkg = toPackage({
        packageName: packageNameOf('vcfa91', 'access', org),
        description: `Imports groups and users into the All Apps organization ${org} with their roles, and gives project roles.`,
        categoryPath: `${AREA}/Access/${org}`,
        workflow: {
          name: `Organization access for ${label(org, 'org')}`,
          description: `${custom ? `Creates the custom role ${customName} from ${rights.length} named right(s) unless it exists. ` : ''}Imports ${principals.length} group(s)/user(s) through /cloudapi/1.0.0 with their organization role, leaving any that exist as they are; then creates ${bindings.length} ProjectRoleBinding(s) through /cci/kubernetes unless they exist. With dryRun true it reads, server-side validates the bindings, and changes nothing.`,
          inputs: [kit.DRY_RUN_INPUT],
          outputs: kit.KUBE_OUTPUTS,
          script: workflow,
        },
        config: {
          name: 'Settings',
          description: 'Settings of the organization access workflow. Fill vcfaApiToken (an organization administrator’s API token) after import; set dryRun to false only after a dry run.',
          attributes: [kit.VCFA_HOST_ATTR, kit.ORG_ATTR(org), kit.TOKEN_ATTR('an organization administrator'), kit.API_VERSION_ATTR, ...kit.GUARD_ATTRS(Math.max(1, principals.length + bindings.length + (custom ? 1 : 0))), kit.WEBHOOK_ATTR],
        },
        resources: [{ name: 'access.json', content: json(access) }],
      });

      return {
        platform: PLATFORM,
        title: `Access to ${org}: ${principals.length} principal(s), ${bindings.length} project binding(s)`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'An organization administrator onboarding a team, or a joiner-mover-leaver process run from the identity provider’s groups.' },
        scope: {
          what: `Organization ${org}: ${principals.map((p) => `${p.name} (${p.role})`).join(', ') || 'no organization roles'}; ${bindings.map((b) => `${String((b.object as { subjects: { name: string }[] }).subjects[0]!.name)} → ${String((b.object as { roleRef: { name: string } }).roleRef.name)} in ${b.object.metadata.namespace}`).join(', ') || 'no project roles'}.`,
          decidedBy: ['Group membership in the identity provider: whoever is in the group has the role, including people added later.', 'The organization role named on each row.', 'The ProjectRoleBinding in each project.'],
          ifWrong: 'An administrator role on a broad group makes everyone in it an organization administrator — able to create namespaces, change quotas of projects and give access to others.',
        },
        guardrails: [
          { rule: 'A group or user that exists is left as it is; its role is never changed by a rerun', because: 'A role changed in the interface for a reason is not silently reverted.' },
          { rule: 'Roles and rights are looked up by exact name, and the run stops when one is missing', because: 'Importing a group with no role, or a role missing a right, grants something other than what was reviewed.' },
          { rule: 'Project bindings are created, not applied, and validated server-side first in a dry run', because: 'create refuses to replace a binding someone else made for the same principal.' },
        ],
        dryRun: ['scripts/apply-org-access.sh --dry-run and scripts/create-project-bindings.sh --dry-run only read and validate.', 'The workflow with dryRun true.'],
        undo: ['DELETE /cloudapi/1.0.0/groups/<id> or /users/<id>; kubectl delete projectrolebinding <name> -n <project>. Removing a group removes the access of everyone in it at their next login.'],
        told: ['VCF Automation organization events (who imported which group with which role).', 'The identity provider’s own group-change audit.', 'The workflow log (AUDIT lines), its summary output and the webhook when set.'],
        requires: [`${org} connected to its identity provider (${providerType === 'OAUTH' ? 'OIDC' : providerType === 'INTEGRATED' ? 'LDAP' : 'SAML'}) — see "A tenant organization".`, 'An organization administrator’s API token.', 'The projects named, already created.'],
        files: {
          ...pkg.files,
          'access.json': json(access),
          'scripts/apply-org-access.sh': orgScript,
          ...(bindings.length > 0
            ? {
                'project-role-bindings.k8s.yaml': bindingsYaml,
                'scripts/create-project-bindings.sh': kubeScript(`Give project roles in ${org}.`, ['# The organization context (vcf context use <name>), not a namespace one: ProjectRoleBindings live in the project.'], ['project-role-bindings.k8s.yaml'], 'kubectl delete -f project-role-bindings.k8s.yaml'),
              }
            : {}),
          'IMPORT.md': importMd({
            subject: `Access to the All Apps organization ${org}: an Orchestrator workflow, or two scripts — organization roles through /cloudapi, project roles as ProjectRoleBindings.`,
            orgs: ALL_APPS,
            steps: [
              ...pkg.importSteps,
              manualStep('Or: organization roles by script', [`\`VCFA_HOST=… VCFA_ORG=${org} VCFA_API_TOKEN_FILE=… ./scripts/apply-org-access.sh\`${custom ? ' creates the custom role first,' : ''} then imports each group or user that is not there yet; \`--dry-run\` only reads.`]),
              ...(bindings.length > 0 ? [kubeStep('Or: project roles with kubectl', 'scripts/create-project-bindings.sh', ['project-role-bindings.k8s.yaml'])] : []),
            ],
            auth: ['vcfa91', 'kube'],
            verify: [
              'Roles, rights, groups and users at /cloudapi/1.0.0 are the Cloud Director model VCF Automation is built on. VERIFY on 9.1: the built-in role names (GET /cloudapi/1.0.0/roles), the providerType values (OAUTH, INTEGRATED, SAML) and roleEntityRefs on a group.',
              'VERIFY: ProjectRoleBinding (authorization.cci.vmware.com/v1alpha1), the name form cci:group:<name> / cci:user:<name>, and roles admin, edit, view — the Cloud Consumption Interface shape; kubectl explain projectrolebinding in the organization context.',
            ],
          }),
        },
        notes: [
          'Groups are imported, not created: the group and its members live in the identity provider. Import the group before anyone in it logs in, or they arrive with no role.',
          'Project roles: admin manages the project and its members; edit creates and changes namespaces and their contents; view reads.',
        ],
        findings,
      };
    },
  });
}

export function vcfa91Govern(kit: Vcfa91Kit): AutomationBlueprint[] {
  return [iaasPolicy(kit), infrastructurePolicy(kit), orgAccess(kit)];
}

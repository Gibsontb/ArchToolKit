/**
 * VCF Operations: setting it up.
 *
 * Before any alert or automation means anything, VCF Operations has to be
 * collecting from the right places, able to tell somebody, and giving the right
 * people the right view. Three things, and each has a way of going wrong that
 * nobody notices until an incident: an account on an administrator's personal
 * login that stops when they leave, an outbound instance that has never sent a
 * message, a role granted on the whole estate because scoping it was fiddly.
 *
 * Every script here looks up the ids it needs by name (vcf-ops-setup-lib.ts),
 * reads secrets from the environment only, and applies when run.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { importMd } from '../vcfops-import.ts';
import { bareIpv6InUrl, isIpv6, opsScript, rowsOf, sh, type ScriptEnv } from './vcf-ops-setup-lib.ts';
import { VCF_OPS_SETUP_MORE } from './vcf-ops-setup-more.ts';

const PLATFORM = 'vcf-operations' as const;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// Accounts (adapter instances)
// ---------------------------------------------------------------------------

interface AccountKind {
  readonly label: string;
  readonly adapterKind: string;
  readonly credentialKind: string;
  /** The resource identifier that holds the host. */
  readonly hostId: string;
  readonly userField: string;
  readonly secretField: string;
  readonly secretEnv: string;
  /** Whether the keys above are confirmed or taken from the 8.x management pack. */
  readonly verify: boolean;
  readonly sees: string;
}

const ACCOUNT_KINDS: Readonly<Record<string, AccountKind>> = {
  vcenter: { label: 'vCenter', adapterKind: 'VMWARE', credentialKind: 'PRINCIPALCREDENTIAL', hostId: 'VCURL', userField: 'USER', secretField: 'PASSWORD', secretEnv: 'VCENTER_PASSWORD', verify: false, sees: 'every object in the vCenter that the account can see — clusters, ESX hosts, VMs, datastores, distributed switches' },
  vcf: { label: 'VCF instance (SDDC Manager)', adapterKind: 'VcfAdapter', credentialKind: 'VCF_CREDENTIAL', hostId: 'SDDC_MANAGER_HOST', userField: 'USERNAME', secretField: 'PASSWORD', secretEnv: 'SDDC_PASSWORD', verify: true, sees: 'the VCF instance and, if auto-onboarding is on, every workload domain’s vCenter, NSX and vSAN' },
  nsx: { label: 'NSX', adapterKind: 'NSXTAdapter', credentialKind: 'NSXTCREDENTIAL', hostId: 'NSXTHOST', userField: 'USERNAME', secretField: 'PASSWORD', secretEnv: 'NSX_PASSWORD', verify: true, sees: 'the NSX Manager cluster, transport nodes, gateways, segments and firewall' },
  vcfa: { label: 'VCF Automation', adapterKind: 'CASAdapter', credentialKind: 'CAS_CREDENTIAL', hostId: 'CAS_HOST', userField: 'USERNAME', secretField: 'PASSWORD', secretEnv: 'VCFA_PASSWORD', verify: true, sees: 'organizations, projects, deployments and their cost' },
  networks: { label: 'VCF Operations for Networks', adapterKind: 'NetworkInsightAdapter', credentialKind: 'NETWORK_INSIGHT_CREDENTIAL', hostId: 'NI_HOST', userField: 'USERNAME', secretField: 'PASSWORD', secretEnv: 'VCFNET_PASSWORD', verify: true, sees: 'flows, problems and network events from the Networks platform' },
  hcx: { label: 'HCX', adapterKind: 'HCXAdapter', credentialKind: 'HCX_CREDENTIAL', hostId: 'HCX_HOST', userField: 'USERNAME', secretField: 'PASSWORD', secretEnv: 'HCX_PASSWORD', verify: true, sees: 'HCX managers, service meshes and migrations' },
  kubernetes: { label: 'Kubernetes / VKS cluster', adapterKind: 'KubernetesAdapter', credentialKind: 'KUBERNETES_TOKEN', hostId: 'MASTER_URL', userField: 'USERNAME', secretField: 'TOKEN', secretEnv: 'K8S_TOKEN', verify: true, sees: 'namespaces, nodes, pods and containers of one cluster' },
  live_recovery: { label: 'VMware Live Recovery', adapterKind: 'SRMAdapter', credentialKind: 'SRM_CREDENTIAL', hostId: 'SRM_HOST', userField: 'USERNAME', secretField: 'PASSWORD', secretEnv: 'LIVE_RECOVERY_PASSWORD', verify: true, sees: 'protection groups, recovery plans and replication' },
  snmp: { label: 'SNMP network devices', adapterKind: 'NetworkDevicesAdapter', credentialKind: 'SNMP_V3_CREDENTIAL', hostId: 'DEVICE_HOSTS', userField: 'USERNAME', secretField: 'AUTH_PASSWORD', secretEnv: 'SNMP_AUTH_PASSWORD', verify: true, sees: 'switches and routers answering SNMP, their ports and neighbours' },
};

// ---------------------------------------------------------------------------
// Outbound instances
// ---------------------------------------------------------------------------

/** A config value filled from the environment (or a file named in it) at apply time. */
interface SecretField {
  readonly config: string;
  readonly env: string;
  readonly hint: string;
  /** The variable names a file whose contents are the value. */
  readonly file?: boolean;
}

const OUTBOUND_KINDS: readonly { value: string; label: string }[] = [
  { value: 'StandardEmailPlugin', label: 'Standard Email Plugin (SMTP)' },
  { value: 'WebhookPlugin', label: 'Webhook Notification Plugin' },
  { value: 'SlackPlugin', label: 'Slack Plugin' },
  { value: 'ServiceNowPlugin', label: 'Service-Now Notification Plugin' },
  { value: 'SNMPTrapPlugin', label: 'SNMP Trap Plugin' },
  { value: 'LogFilePlugin', label: 'Log File Plugin' },
];

function outboundScript(base: string, instance: string, pluginType: string, secrets: readonly SecretField[], headers: boolean): string {
  const injected = secrets.filter((secret) => secret.config !== '');
  const inject = injected.map((secret) =>
    secret.file
      ? `  | jq --rawfile v "\${${secret.env}:-/dev/null}" '(.configValues[] | select(.name == "${secret.config}") | .value) = $v'`
      : `  | jq '(.configValues[] | select(.name == "${secret.config}") | .value) = env.${secret.env}'`,
  );
  return opsScript({
    about: [
      `Create or update the outbound instance "${instance}" (${pluginType}) in VCF Operations,`,
      'then enable it: the API creates outbound instances disabled.',
      '',
      'Every secret comes from the environment at apply time and travels on stdin,',
      'so it is never in a file here or on a command line.',
      'Idempotent by name: an instance with this name already there is updated.',
    ],
    secrets: secrets.map((secret): ScriptEnv => ({ name: secret.env, hint: secret.hint })),
    body: [
      `NAME=${sh(instance)}`,
      `TYPE=${sh(pluginType)}`,
      '',
      '# 1. The plugin type has to exist on this instance, and its fields are compared',
      '#    with the ones in the payload, so a renamed field stops here, not at the Test button.',
      'TYPES=$(api GET alertplugins/types)',
      'if ! jq -e --arg t "$TYPE" \'[.. | objects | select(.pluginTypeId? == $t)] | length > 0\' <<<"$TYPES" >/dev/null; then',
      '  echo "This VCF Operations has no outbound plugin type ${TYPE}. The types it has:" >&2',
      '  jq -r \'[.. | objects | .pluginTypeId? // empty] | unique | .[]\' <<<"$TYPES" >&2',
      '  exit 1',
      'fi',
      'KNOWN=$(jq -c --arg t "$TYPE" \'[.. | objects | select(.pluginTypeId? == $t) | .. | objects | (.name? // .key? // empty) | strings] | unique\' <<<"$TYPES")',
      `UNKNOWN=$(jq -r --argjson k "$KNOWN" '[.configValues[].name] - $k | .[]' "$HERE/${base}.json")`,
      'if [[ "$(jq length <<<"$KNOWN")" -gt 1 && -n "$UNKNOWN" ]]; then',
      '  echo "VERIFY: fields in the payload that ${TYPE} does not declare on this release:" >&2',
      '  echo "$UNKNOWN" >&2',
      '  echo "Rename them to the declared ones (GET /suite-api/api/alertplugins/types), then run again." >&2',
      '  exit 1',
      'fi',
      '',
      '# 2. Create, or update the instance of the same name.',
      'EXISTING=$(api GET alertplugins | jq -r --arg n "$NAME" \'[(.notificationPluginInstances[]?, .pluginInstances[]?) | select(.name == $n) | .pluginId] | .[0] // empty\')',
      ...secrets.filter((secret) => !secret.file).map((secret) => `export ${secret.env}="\${${secret.env}:-<from ${secret.env}>}"`),
      `body() {`,
      `  jq --arg id "$EXISTING" 'if $id != "" then .pluginId = $id else . end' "$HERE/${base}.json" \\`,
      ...inject.map((line) => `${line} \\`),
      ...(headers
        ? ['  | jq \'(.configValues[] | select(.name == "customHeaders") | .value) |= (fromjson | map(if (.value | startswith("env:")) then .value = ($ENV[.value[4:]] // ("<from " + .value[4:] + ">")) else . end) | tojson)\'']
        : ['  | jq .']),
      '}',
      'if [[ -n "$EXISTING" ]]; then',
      '  body | send PUT alertplugins >/dev/null',
      '  ID="$EXISTING"',
      '  echo "Updated outbound instance ${ID}."',
      'else',
      '  ID=$(body | send POST alertplugins | jq -r \'.pluginId // .id // empty\')',
      '  [[ -n "$ID" ]] || { echo "POST alertplugins returned no id." >&2; exit 1; }',
      '  echo "Created outbound instance ${ID}."',
      'fi',
      '',
      '# 3. Enable it.',
      'if (( ! DRY_RUN )); then',
      '  api PUT "alertplugins/${ID}/enable/true" >/dev/null',
      '  echo "Enabled ${ID}. Press Test on it under Infrastructure Operations → Configurations → Outbound Settings, and check the message arrived."',
      'fi',
    ],
    undo: 'DELETE /suite-api/api/alertplugins/{id} — notification rules that use it stop sending, silently.',
  });
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

const ROLES: readonly { value: string; label: string }[] = [
  { value: 'ReadOnly', label: 'Read only' },
  { value: 'GeneralUser', label: 'General user' },
  { value: 'ContentAdmin', label: 'Content administrator' },
  { value: 'PowerUserMinusRemediation', label: 'Power user without remediation' },
  { value: 'PowerUser', label: 'Power user' },
  { value: 'AgentManager', label: 'Agent manager' },
  { value: 'Administrator', label: 'Administrator — see the finding' },
  { value: 'custom', label: 'A custom role, built from the permissions below' },
];

export const VCF_OPERATIONS_SETUP: readonly AutomationBlueprint[] = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_adapter_instance',
    platform: PLATFORM,
    label: 'Add an account: vCenter, VCF instance, NSX and the rest',
    group: 'Setup',
    description:
      'An integration account — vCenter, a VCF instance through SDDC Manager, NSX, VCF Automation, VCF Operations for Networks, HCX, a Kubernetes / VKS cluster, VMware Live Recovery or SNMP network devices — on a named collector group, with its credential created from the environment, its certificate checked and accepted, and collection started. Written with a service account in mind, because the commonest reason an estate goes quiet is an account running on somebody’s personal login.',
    inputs: [
      {
        id: 'kind',
        label: 'Account type',
        control: 'select',
        options: Object.entries(ACCOUNT_KINDS).map(([value, kind]) => ({ value, label: kind.label })),
        default: 'vcenter',
      },
      { id: 'vcenter', label: 'FQDN, VIP or address', control: 'text', default: 'vcenter01.example.com', hint: 'An FQDN survives re-addressing; an IPv6 address works too' },
      { id: 'account', label: 'Service account', control: 'text', default: 'svc-vcfops-collect@vsphere.local', hint: 'Read-only, plus the action rights if you will run actions' },
      { id: 'collector_group', label: 'Collector group', control: 'text', default: 'Site A collectors' },
      { id: 'actions', label: 'Enable actions', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['vcenter', 'vcf'] } },
      { id: 'vcf_onboard', label: 'Onboard every workload domain automatically', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['vcf'] } },
      { id: 'nsx_vip', label: 'NSX cluster VIP (not a node)', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['nsx'] } },
      { id: 'net_events', label: 'Import Networks problems as alerts', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['networks'] } },
      {
        id: 'k8s_auth',
        label: 'Kubernetes authentication',
        control: 'select',
        options: [
          { value: 'token', label: 'Service account token (K8S_TOKEN)' },
          { value: 'kubeconfig', label: 'Kubeconfig file (K8S_KUBECONFIG_FILE)' },
          { value: 'certificate', label: 'Client certificate (K8S_CLIENT_CERT_FILE, K8S_CLIENT_KEY_FILE)' },
        ],
        default: 'token',
        showWhen: { input: 'kind', equals: ['kubernetes'] },
      },
      { id: 'k8s_cadvisor', label: 'Collect container metrics through cAdvisor', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['kubernetes'] } },
      { id: 'cadvisor_port', label: 'cAdvisor port', control: 'number', default: 31194, min: 1, max: 65535, showWhen: { input: 'kind', equals: ['kubernetes'] } },
      {
        id: 'snmp_version',
        label: 'SNMP version',
        control: 'select',
        options: [
          { value: 'v3', label: 'SNMPv3 (user, auth and privacy)' },
          { value: 'v2c', label: 'SNMPv2c (community) — see the finding' },
        ],
        default: 'v3',
        showWhen: { input: 'kind', equals: ['snmp'] },
      },
      { id: 'devices', label: 'Devices', control: 'text', default: 'core-sw01.example.com, core-sw02.example.com', hint: 'Comma-separated names or addresses, IPv4 or IPv6', showWhen: { input: 'kind', equals: ['snmp'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const kindKey = str(values, 'kind', 'vcenter');
      const kind = ACCOUNT_KINDS[kindKey] ?? ACCOUNT_KINDS['vcenter']!;
      const host = str(values, 'vcenter', '');
      const account = str(values, 'account', '');
      const group = str(values, 'collector_group', '');
      const actions = (kindKey === 'vcenter' || kindKey === 'vcf') && bool(values, 'actions', true);
      const k8sAuth = str(values, 'k8s_auth', 'token');
      const snmpVersion = str(values, 'snmp_version', 'v3');
      const devices = listOf(str(values, 'devices', ''));
      const base = slugOf(name || host, 'adapter');

      const findings: Finding[] = [];
      if (/^administrator@|^root$|^admin(@|$)|^admin@local$/i.test(account)) {
        findings.push(
          error('vcfops.adapter.admin-account', `${account} is a built-in administrator.`, {
            remediation: 'Create a service account with read-only rights (and the action rights, if needed). An administrator credential in a monitoring tool is the widest credential in the estate held by the least-watched system.',
            source: SRC,
          }),
        );
      } else if (kindKey !== 'kubernetes' && !(kindKey === 'snmp' && snmpVersion === 'v2c') && !/svc|service|srv|collect|monitor/i.test(account)) {
        findings.push(
          warning('vcfops.adapter.personal', `${account} does not look like a service account.`, {
            remediation: 'When a person leaves, their account is disabled and collection stops. Nothing in VCF Operations alerts on that loudly.',
            source: SRC,
          }),
        );
      }
      if (!group.trim()) {
        findings.push(warning('vcfops.adapter.no-group', 'No collector group, so the account lands on whichever collector is chosen for it and cannot fail over.', { source: SRC }));
      }
      if (kindKey === 'snmp' && snmpVersion === 'v2c') {
        findings.push(warning('vcfops.adapter.snmp-v2c', 'SNMPv2c sends its community string in clear on every poll.', { remediation: 'Use SNMPv3 with authentication and privacy wherever the devices support it.', source: SRC }));
      }
      if (kindKey === 'nsx' && !bool(values, 'nsx_vip', true)) {
        findings.push(warning('vcfops.adapter.nsx-node', 'Pointing the NSX account at one manager node means collection stops when that node is down or upgraded.', { remediation: 'Use the cluster VIP or the load-balanced FQDN.', source: SRC }));
      }
      if (kindKey === 'vcenter' && /sddc|vcf/i.test(host)) {
        findings.push(info('vcfops.adapter.use-vcf', 'That looks like part of a VCF instance.', { remediation: 'A VCF instance account brings its vCenters, NSX and vSAN in one go and keeps them in step as domains are added.', source: SRC }));
      }
      if (isIpv6(host)) {
        findings.push(info('vcfops.adapter.ipv6', `${host} is an IPv6 address. It works, and the certificate has to name it; an FQDN survives re-addressing.`, { source: SRC }));
      }

      // Secrets: the one password every kind has, or the Kubernetes and SNMP variants.
      const secrets: { field: string; env: string; hint: string; file?: boolean }[] =
        kindKey === 'kubernetes'
          ? k8sAuth === 'kubeconfig'
            ? [{ field: 'KUBECONFIG', env: 'K8S_KUBECONFIG_FILE', hint: 'a kubeconfig file for a read-only service account, mode 600', file: true }]
            : k8sAuth === 'certificate'
              ? [
                  { field: 'CLIENT_CERT', env: 'K8S_CLIENT_CERT_FILE', hint: 'the client certificate PEM file', file: true },
                  { field: 'CLIENT_KEY', env: 'K8S_CLIENT_KEY_FILE', hint: 'the client key PEM file, mode 600', file: true },
                ]
              : [{ field: 'TOKEN', env: 'K8S_TOKEN', hint: 'a token of a read-only service account in the cluster' }]
          : kindKey === 'snmp'
            ? snmpVersion === 'v2c'
              ? [{ field: 'COMMUNITY', env: 'SNMP_COMMUNITY', hint: 'the read-only community string' }]
              : [
                  { field: 'AUTH_PASSWORD', env: 'SNMP_AUTH_PASSWORD', hint: 'the SNMPv3 authentication passphrase' },
                  { field: 'PRIVACY_PASSWORD', env: 'SNMP_PRIV_PASSWORD', hint: 'the SNMPv3 privacy passphrase' },
                ]
            : [{ field: kind.secretField, env: kind.secretEnv, hint: `the password of ${account}` }];
      const credentialKind = kindKey === 'kubernetes' ? (k8sAuth === 'kubeconfig' ? 'KUBERNETES_KUBECONFIG' : k8sAuth === 'certificate' ? 'KUBERNETES_CLIENT_CERT' : 'KUBERNETES_TOKEN') : kindKey === 'snmp' && snmpVersion === 'v2c' ? 'SNMP_V2C_CREDENTIAL' : kind.credentialKind;

      const credential = {
        name: `${host} — ${kindKey === 'kubernetes' || (kindKey === 'snmp' && snmpVersion === 'v2c') ? kind.label : account}`,
        adapterKindKey: kind.adapterKind,
        credentialKindKey: credentialKind,
        fields: [
          ...(kindKey === 'kubernetes' || (kindKey === 'snmp' && snmpVersion === 'v2c') ? [] : [{ name: kind.userField, value: account }]),
          ...secrets.map((secret) => ({ name: secret.field, value: `<from ${secret.env} at apply time>` })),
        ],
      };

      const identifiers: { name: string; value: string }[] = [
        { name: kind.hostId, value: kindKey === 'snmp' ? devices.join(',') : kindKey === 'kubernetes' && !/^https?:/i.test(host) ? `https://${isIpv6(host) && !host.startsWith('[') ? `[${host}]` : host}:6443` : host },
        ...(kindKey === 'vcenter' ? [{ name: 'AUTODISCOVERY', value: 'true' }, { name: 'PROCESSCHANGEEVENTS', value: 'true' }, { name: 'VM_LIMIT', value: '' }] : []),
        ...(kindKey === 'vcf' ? [{ name: 'AUTO_ONBOARD_DOMAINS', value: String(bool(values, 'vcf_onboard', true)) }] : []),
        ...(kindKey === 'networks' ? [{ name: 'IMPORT_EVENTS_AS_ALERTS', value: String(bool(values, 'net_events', true)) }] : []),
        ...(kindKey === 'kubernetes' ? [{ name: 'COLLECTOR_SERVICE', value: bool(values, 'k8s_cadvisor', true) ? 'CADVISOR' : 'NONE' }, { name: 'CADVISOR_PORT', value: String(num(values, 'cadvisor_port', 31194)) }] : []),
        ...(kindKey === 'snmp' ? [{ name: 'SNMP_VERSION', value: snmpVersion }] : []),
        ...(actions ? [{ name: 'ENABLE_ACTIONS', value: 'true' }] : []),
      ];
      const adapter = {
        name: host,
        description: `${kind.label} ${host}`,
        collectorGroupId: '<set by apply.sh from the collector group name>',
        adapterKindKey: kind.adapterKind,
        resourceIdentifiers: identifiers,
        credential: { id: '<set by apply.sh from the credential it creates>' },
      };

      const apply = opsScript({
        about: [
          `Add the ${kind.label} account ${host} to VCF Operations: check the adapter and`,
          'credential kinds exist here, create the credential from the environment, create',
          'the account on the collector group, check and accept its certificate, and start',
          'collection. EXPECTED_THUMBPRINT, if set, must match the certificate presented.',
        ],
        secrets: secrets.map((secret) => ({ name: secret.env, hint: secret.hint })),
        body: [
          `AK=${sh(kind.adapterKind)}`,
          `CK=${sh(credentialKind)}`,
          `NAME=${sh(host)}`,
          '',
          '# 1. The adapter kind and credential kind have to exist on this instance: a',
          '#    management pack that is not installed stops here, not in a stack trace.',
          'if ! api GET adapterkinds | jq -e --arg k "$AK" \'[.. | objects | select(.key? == $k)] | length > 0\' >/dev/null; then',
          '  echo "No adapter kind ${AK} here. Install or activate its integration first. The kinds this instance has:" >&2',
          '  api GET adapterkinds | jq -r \'[.. | objects | .key? // empty | strings] | unique | .[]\' >&2',
          '  exit 1',
          'fi',
          'CKINDS=$(api GET "adapterkinds/${AK}/credentialkinds")',
          'if ! jq -e --arg k "$CK" \'[.. | objects | select(.key? == $k)] | length > 0\' <<<"$CKINDS" >/dev/null; then',
          '  echo "VERIFY: ${AK} has no credential kind ${CK}. It has:" >&2',
          '  jq -r \'[.. | objects | select(.fields? != null) | .key] | .[]\' <<<"$CKINDS" >&2',
          `  echo "Set credentialKindKey in ${base}-credential.json to one of them, then run again." >&2`,
          '  exit 1',
          'fi',
          'if api GET "adapters?adapterKindKey=${AK}" | jq -e --arg n "$NAME" \'[.. | objects | select(.resourceKey?.name? == $n)] | length > 0\' >/dev/null; then',
          '  echo "An account named ${NAME} is already there. Nothing was changed." >&2',
          '  exit 1',
          'fi',
          `CG=$(collector_group_id ${sh(group || '<collector group>')})`,
          '',
          '# 2. The credential. Secrets go from the environment into jq and on stdin into',
          '#    curl, never onto a command line.',
          ...secrets.filter((secret) => !secret.file).map((secret) => `export ${secret.env}="\${${secret.env}:-}"`),
          `CRED_ID=$(jq . "$HERE/${base}-credential.json" \\`,
          ...secrets.map((secret) =>
            secret.file
              ? `  | jq --rawfile v "\${${secret.env}:-/dev/null}" '(.fields[] | select(.name == "${secret.field}") | .value) = $v' \\`
              : `  | jq '(.fields[] | select(.name == "${secret.field}") | .value) = env.${secret.env}' \\`,
          ),
          '  | send POST credentials | jq -r \'.id // empty\')',
          '[[ -n "$CRED_ID" ]] || { echo "POST credentials returned no id." >&2; exit 1; }',
          '',
          '# 3. The account, created stopped.',
          `ADAPTER=$(jq --arg c "$CRED_ID" --arg g "$CG" '.credential.id = $c | .collectorGroupId = $g' "$HERE/${base}-adapter.json" | send POST adapters)`,
          'ADAPTER_ID=$(jq -r \'.id // empty\' <<<"$ADAPTER")',
          '[[ -n "$ADAPTER_ID" ]] || { echo "POST adapters returned no id." >&2; exit 1; }',
          'echo "credential ${CRED_ID}, account ${ADAPTER_ID}"',
          '',
          '# 4. The certificate: shown, compared if EXPECTED_THUMBPRINT is set, then accepted',
          '#    by sending the account back with the certificate it presented (PATCH adapters).',
          'if (( ! DRY_RUN )); then',
          '  THUMBS=$(jq -r \'[(."adapter-certificates"[]?, .adapterCertificates[]?) | .thumbprint] | join(" ")\' <<<"$ADAPTER")',
          '  echo "Certificate thumbprint(s) presented: ${THUMBS:-none}"',
          '  if [[ -n "${EXPECTED_THUMBPRINT:-}" && " ${THUMBS^^} " != *" ${EXPECTED_THUMBPRINT^^} "* ]]; then',
          '    echo "The certificate is not the one expected (${EXPECTED_THUMBPRINT}). Account ${ADAPTER_ID} left stopped." >&2',
          '    exit 1',
          '  fi',
          '  [[ -n "$THUMBS" ]] && { echo "$ADAPTER" | send PATCH adapters >/dev/null; echo "Certificate accepted."; }',
          '  api PUT "adapters/${ADAPTER_ID}/monitoringstate/start" >/dev/null',
          '  echo "Collection started. Status in a few minutes: GET /suite-api/api/adapters/${ADAPTER_ID}"',
          'fi',
        ],
        undo: 'DELETE /suite-api/api/adapters/{id} (its objects and their history go with it — stop it instead, PUT …/monitoringstate/stop, if you may want the history), then DELETE /suite-api/api/credentials/{id}.',
      });

      return {
        platform: PLATFORM,
        title: `Collect from ${kind.label} ${host}${kindKey === 'kubernetes' ? '' : ` as ${account}`}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: `Applied once, when ${kind.label} ${host} is added to monitoring.` },
        scope: {
          what: `${kind.sees.charAt(0).toUpperCase()}${kind.sees.slice(1)}.`,
          decidedBy: [`The rights of the account in ${kind.label} — collection sees exactly what the account sees.`, `The collector group "${group}", which decides which collectors do the work.`],
          ifWrong: 'An account with too little visibility produces a monitoring gap that looks like an empty cluster; one with too much is a credential worth stealing.',
        },
        guardrails: [
          { rule: 'Secrets are read from the environment at apply time', because: 'A credential in a payload file is a credential in every copy of the repository.' },
          { rule: 'The certificate is shown, and checked against EXPECTED_THUMBPRINT when set, before it is accepted', because: 'Accepting it is the check that you are talking to the system you think you are.' },
          { rule: 'The adapter and credential kinds are checked on this instance first', because: 'A missing integration stops the script with the list of what is there, instead of a half-made account.' },
          ...(actions ? [{ rule: 'Actions enabled on purpose, with an account that has exactly the action rights', because: 'Actions run as this account. Its rights are the ceiling on anything automated in this kit.' }] : []),
        ],
        dryRun: ['Run apply.sh --dry-run: it checks the kinds, looks up the collector group and prints both bodies (without secrets) and changes nothing.'],
        undo: ['DELETE /suite-api/api/adapters/{id}. Its objects and their history are removed with it — stop it instead if you may want the history. Then DELETE /suite-api/api/credentials/{id}.'],
        told: ['Nobody. The self-check in this kit is what reports an account that stops collecting.'],
        requires: [
          `The account in ${kind.label}, with read-only rights${actions ? ' plus the privileges for the actions you will run' : ''}.`,
          `The collector group "${group}".`,
          ...(kind.verify ? [`The ${kind.label} integration installed and activated in VCF Operations (Administration → Integrations → Repository).`] : []),
        ],
        files: {
          [`${base}-credential.json`]: `${JSON.stringify(credential, null, 2)}\n`,
          [`${base}-adapter.json`]: `${JSON.stringify(adapter, null, 2)}\n`,
          'apply.sh': apply,
          'IMPORT.md': importMd({
            title: `the ${kind.label} account`,
            steps: [
              {
                heading: 'The credential, then the account',
                files: [`${base}-credential.json`, `${base}-adapter.json`, 'apply.sh'],
                how: [`${secrets.map((secret) => `${secret.env}=…`).join(' ')} ./apply.sh (add --dry-run first to preview) — POST /suite-api/api/credentials, POST /suite-api/api/adapters on the collector group, PATCH /suite-api/api/adapters to accept the certificate, PUT /suite-api/api/adapters/{id}/monitoringstate/start.`],
                verify: kind.verify ? [`${kind.adapterKind}, ${credentialKind} and the identifier names are the ${kind.label} integration’s as last published; apply.sh checks the adapter and credential kinds on your instance and stops with the real ones if they differ. Compare the identifiers with GET /suite-api/api/adapterkinds/${kind.adapterKind}/resourcekinds.`] : [],
              },
            ],
            intro: ['Integration accounts are not imported from a file: the interface exports them only inside a password-protected Content Management package, because they carry credentials. The REST API is the route.'],
          }),
        },
        notes: [
          'In VCF 9.1 the management domain’s vCenter and NSX usually arrive through the VCF instance account or fleet management. Use a single-product account for anything outside the fleet.',
          ...(actions ? ['VERIFY: ENABLE_ACTIONS is the identifier the vCenter account’s "Operational actions" switch writes on recent releases. If the account shows actions off after applying, turn them on under Administration → Integrations → Accounts → the account → Advanced settings.'] : []),
          ...(kindKey === 'kubernetes' ? ['A VKS cluster under a Supervisor is also discovered through its vCenter; add a Kubernetes account for the in-cluster objects (pods, containers) that vCenter does not see.'] : []),
          ...(kind.verify ? [`VERIFY: the keys for ${kind.label} (${kind.adapterKind}, ${kind.hostId}) are the management pack’s; apply.sh checks what it can and stops rather than guessing.`] : ['The resource identifier names (VCURL and the rest) are the VMware adapter’s. Check them against GET /suite-api/api/adapterkinds/VMWARE/resourcekinds on your version.']),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_outbound_plugin',
    platform: PLATFORM,
    label: 'An outbound instance: email, webhook, Slack, ServiceNow, SNMP or log file',
    group: 'Setup',
    description:
      'The instance notification rules send through — any of the six outbound plugins VCF Operations 9.1 has — created, or updated if one of the same name exists, and enabled. Secrets (SMTP password, webhook token or client secret, Slack URL, ServiceNow password, SNMP passphrases, proxy password) come from the environment. The script checks the plugin type and its fields on your instance before it sends anything.',
    inputs: [
      { id: 'kind', label: 'Plugin', control: 'select', options: OUTBOUND_KINDS, default: 'StandardEmailPlugin' },
      { id: 'instance_name', label: 'Instance name', control: 'text', default: 'Platform team mail relay' },
      // Email
      { id: 'smtp_host', label: 'SMTP server', control: 'text', default: 'smtp.example.com', hint: 'Name, IPv4 or IPv6', showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] } },
      { id: 'smtp_port', label: 'SMTP port', control: 'number', default: 587, min: 1, max: 65535, showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] } },
      {
        id: 'email_security',
        label: 'Connection security',
        control: 'select',
        options: [
          { value: 'STARTTLS', label: 'STARTTLS (587)' },
          { value: 'SSL', label: 'SSL/TLS (465)' },
          { value: 'NONE', label: 'None — see the finding' },
        ],
        default: 'STARTTLS',
        showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] },
      },
      { id: 'email_auth', label: 'Relay needs authentication (SMTP_PASSWORD)', control: 'toggle', default: true, showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] } },
      { id: 'email_user', label: 'SMTP user', control: 'text', default: 'svc-vcfops-mail', showWhen: { input: 'email_auth', equals: ['true'] } },
      { id: 'sender', label: 'Sender address', control: 'text', default: 'vcf-operations@example.com', showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] } },
      { id: 'sender_name', label: 'Sender name', control: 'text', default: 'VCF Operations', showWhen: { input: 'kind', equals: ['StandardEmailPlugin'] } },
      // Webhook
      { id: 'webhook_url', label: 'Webhook URL', control: 'text', default: 'https://hooks.example.com/vcf-operations', hint: 'IPv6 in brackets: https://[2001:db8::10]/hook', showWhen: { input: 'kind', equals: ['WebhookPlugin'] } },
      {
        id: 'webhook_auth',
        label: 'Authentication',
        control: 'select',
        options: [
          { value: 'BEARER', label: 'Bearer token (WEBHOOK_BEARER_TOKEN)' },
          { value: 'BASIC', label: 'Basic (user + WEBHOOK_PASSWORD)' },
          { value: 'OAUTH2', label: 'OAuth client credentials (client id + WEBHOOK_CLIENT_SECRET)' },
          { value: 'CERTIFICATE', label: 'Client certificate chain (WEBHOOK_CLIENT_CERT_FILE, WEBHOOK_CLIENT_KEY_FILE)' },
          { value: 'NONE', label: 'None — see the finding' },
        ],
        default: 'BEARER',
        showWhen: { input: 'kind', equals: ['WebhookPlugin'] },
      },
      { id: 'webhook_user', label: 'User or client id', control: 'text', default: 'vcf-operations', showWhen: { input: 'webhook_auth', equals: ['BASIC', 'OAUTH2'] } },
      { id: 'oauth_token_url', label: 'OAuth token URL', control: 'text', default: 'https://login.example.com/oauth2/token', showWhen: { input: 'webhook_auth', equals: ['OAUTH2'] } },
      { id: 'oauth_scope', label: 'OAuth scope', control: 'text', default: '', showWhen: { input: 'webhook_auth', equals: ['OAUTH2'] } },
      { id: 'headers', label: 'Custom headers', control: 'textarea', default: 'X-Source | vcf-operations', hint: 'Header | Value (env:NAME reads it from the environment)', showWhen: { input: 'kind', equals: ['WebhookPlugin'] } },
      { id: 'connections', label: 'Concurrent connections', control: 'number', default: 20, min: 1, max: 100, showWhen: { input: 'kind', equals: ['WebhookPlugin'] } },
      // Slack
      { id: 'slack_channel', label: 'Slack channel', control: 'text', default: '#vcf-alerts', hint: 'The incoming-webhook URL is read from SLACK_WEBHOOK_URL', showWhen: { input: 'kind', equals: ['SlackPlugin'] } },
      // ServiceNow
      { id: 'sn_instance', label: 'ServiceNow instance URL', control: 'text', default: 'https://example.service-now.com', showWhen: { input: 'kind', equals: ['ServiceNowPlugin'] } },
      { id: 'sn_user', label: 'ServiceNow user', control: 'text', default: 'svc-vcfops-snow', hint: 'Password from SERVICENOW_PASSWORD', showWhen: { input: 'kind', equals: ['ServiceNowPlugin'] } },
      // Proxy
      { id: 'proxy', label: 'Through a proxy', control: 'toggle', default: false, showWhen: { input: 'kind', equals: ['WebhookPlugin', 'SlackPlugin', 'ServiceNowPlugin'] } },
      { id: 'proxy_host', label: 'Proxy host', control: 'text', default: 'proxy.example.com', showWhen: { input: 'proxy', equals: ['true'] } },
      { id: 'proxy_port', label: 'Proxy port', control: 'number', default: 3128, min: 1, max: 65535, showWhen: { input: 'proxy', equals: ['true'] } },
      { id: 'proxy_user', label: 'Proxy user (empty for none)', control: 'text', default: '', hint: 'Password from PROXY_PASSWORD', showWhen: { input: 'proxy', equals: ['true'] } },
      // SNMP
      { id: 'snmp_host', label: 'Trap receiver', control: 'text', default: 'snmp-trap.example.com', hint: 'Name, IPv4 or IPv6', showWhen: { input: 'kind', equals: ['SNMPTrapPlugin'] } },
      { id: 'snmp_port', label: 'Trap port', control: 'number', default: 162, min: 1, max: 65535, showWhen: { input: 'kind', equals: ['SNMPTrapPlugin'] } },
      {
        id: 'snmp_version',
        label: 'SNMP version',
        control: 'select',
        options: [
          { value: 'v3', label: 'SNMPv3' },
          { value: 'v2c', label: 'SNMPv2c (SNMP_COMMUNITY) — see the finding' },
        ],
        default: 'v3',
        showWhen: { input: 'kind', equals: ['SNMPTrapPlugin'] },
      },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'vcfops-trap', showWhen: { input: 'snmp_version', equals: ['v3'] } },
      {
        id: 'snmp_level',
        label: 'Security level',
        control: 'select',
        options: [
          { value: 'authPriv', label: 'Authentication and privacy' },
          { value: 'authNoPriv', label: 'Authentication only' },
          { value: 'noAuthNoPriv', label: 'Neither — see the finding' },
        ],
        default: 'authPriv',
        showWhen: { input: 'snmp_version', equals: ['v3'] },
      },
      {
        id: 'snmp_auth',
        label: 'Authentication protocol',
        control: 'select',
        options: [
          { value: 'SHA-256', label: 'SHA-256' },
          { value: 'SHA-512', label: 'SHA-512' },
          { value: 'SHA-384', label: 'SHA-384' },
          { value: 'SHA-224', label: 'SHA-224' },
          { value: 'SHA', label: 'SHA-1' },
          { value: 'MD5', label: 'MD5 — see the finding' },
        ],
        default: 'SHA-256',
        showWhen: { input: 'snmp_version', equals: ['v3'] },
      },
      {
        id: 'snmp_priv',
        label: 'Privacy protocol',
        control: 'select',
        options: [
          { value: 'AES256', label: 'AES-256' },
          { value: 'AES192', label: 'AES-192' },
          { value: 'AES', label: 'AES-128' },
          { value: 'DES', label: 'DES — see the finding' },
        ],
        default: 'AES256',
        showWhen: { input: 'snmp_level', equals: ['authPriv'] },
      },
      // Log file
      { id: 'log_folder', label: 'Alert output folder', control: 'text', default: '/storage/log/vcops/alerts', hint: 'On the VCF Operations nodes; each alert is written to a file here', showWhen: { input: 'kind', equals: ['LogFilePlugin'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const kind = str(values, 'kind', 'StandardEmailPlugin');
      const instance = str(values, 'instance_name', 'Outbound');
      const base = slugOf(name || instance, 'outbound');
      const proxy = ['WebhookPlugin', 'SlackPlugin', 'ServiceNowPlugin'].includes(kind) && bool(values, 'proxy', false);
      const proxyUser = str(values, 'proxy_user', '');
      const findings: Finding[] = [];

      const config: { name: string; value: string }[] = [];
      const secrets: SecretField[] = [];
      let target = '';
      let encrypted = true;
      let headerRows: string[][] = [];
      const secret = (field: string, env: string, hint: string, file = false) => {
        config.push({ name: field, value: `<from ${env} at apply time>` });
        secrets.push({ config: field, env, hint, file });
      };

      if (kind === 'SyslogPlugin') {
        findings.push(error('vcfops.outbound.syslog-retired', 'The Syslog outbound plugin is retired in VCF Operations 9.1.', { remediation: 'Send alerts to syslog through log forwarding in Log Management (the log forwarding blueprint), or use the Log File or Webhook plugin.', source: SRC }));
      }

      if (kind === 'StandardEmailPlugin' || kind === 'SyslogPlugin') {
        const security = str(values, 'email_security', 'STARTTLS');
        const auth = bool(values, 'email_auth', true);
        target = `${str(values, 'smtp_host', '')}:${num(values, 'smtp_port', 587)}`;
        encrypted = security !== 'NONE';
        config.push(
          { name: 'SMTP_HOST', value: str(values, 'smtp_host', '') },
          { name: 'SMTP_PORT', value: String(num(values, 'smtp_port', 587)) },
          { name: 'IS_SECURE_CONNECTION', value: String(encrypted) },
          { name: 'SECURE_CONNECTION_TYPE', value: security === 'SSL' ? 'SSL' : security === 'STARTTLS' ? 'TLS' : 'NONE' },
          { name: 'IS_REQUIRES_AUTHENTICATION', value: String(auth) },
          { name: 'senderEmailAddress', value: str(values, 'sender', '') },
          { name: 'senderName', value: str(values, 'sender_name', 'VCF Operations') },
        );
        if (auth) {
          config.push({ name: 'USERNAME', value: str(values, 'email_user', '') });
          secret('PASSWORD', 'SMTP_PASSWORD', 'the password of the SMTP user');
        }
        if (auth && !encrypted) findings.push(error('vcfops.outbound.cleartext-login', 'The SMTP password would cross the network in clear.', { remediation: 'Use STARTTLS or SSL/TLS whenever the relay needs a login.', source: SRC }));
      } else if (kind === 'WebhookPlugin') {
        const url = str(values, 'webhook_url', '');
        const auth = str(values, 'webhook_auth', 'BEARER');
        target = url;
        encrypted = /^https:/i.test(url);
        config.push({ name: 'Url', value: url }, { name: 'ConnectionCount', value: String(num(values, 'connections', 20)) }, { name: 'AUTH_TYPE', value: auth });
        if (auth === 'BASIC') {
          config.push({ name: 'USERNAME', value: str(values, 'webhook_user', '') });
          secret('PASSWORD', 'WEBHOOK_PASSWORD', 'the webhook password');
        } else if (auth === 'BEARER') {
          secret('TOKEN', 'WEBHOOK_BEARER_TOKEN', 'the bearer token the receiver expects');
        } else if (auth === 'OAUTH2') {
          config.push({ name: 'CLIENT_ID', value: str(values, 'webhook_user', '') }, { name: 'TOKEN_URL', value: str(values, 'oauth_token_url', '') }, { name: 'SCOPE', value: str(values, 'oauth_scope', '') });
          secret('CLIENT_SECRET', 'WEBHOOK_CLIENT_SECRET', 'the OAuth client secret');
        } else if (auth === 'CERTIFICATE') {
          secret('CLIENT_CERTIFICATE', 'WEBHOOK_CLIENT_CERT_FILE', 'the client certificate chain PEM file', true);
          secret('CLIENT_PRIVATE_KEY', 'WEBHOOK_CLIENT_KEY_FILE', 'the client private key PEM file, mode 600', true);
        } else {
          findings.push(warning('vcfops.outbound.no-auth', 'The webhook has no authentication, so anybody who learns the URL can post alerts into it.', { remediation: 'Use a bearer token, OAuth client credentials or a client certificate.', source: SRC }));
        }
        headerRows = rowsOf(str(values, 'headers', ''));
        const headers = headerRows.filter((row) => row[0]).map((row) => ({ name: row[0] ?? '', value: row[1] ?? '' }));
        for (const header of headers) {
          if (/^(authorization|x-api-key|api-key|x-auth-token|x-.*(token|secret|key))$/i.test(header.name) && !header.value.startsWith('env:')) {
            findings.push(error('vcfops.outbound.header-secret', `The header ${header.name} carries a literal value.`, { remediation: `Write env:NAME as its value and set NAME in the environment when running apply.sh; the value is then never in a file.`, source: SRC }));
          }
        }
        if (headers.length > 0) config.push({ name: 'customHeaders', value: JSON.stringify(headers) });
        for (const header of headers) if (header.value.startsWith('env:')) secrets.push({ config: '', env: header.value.slice(4), hint: `the value of the ${header.name} header` });
        if (/[?&](token|key|secret|signature|sig|code)=/i.test(url)) {
          findings.push(error('vcfops.outbound.secret-in-url', 'The webhook URL carries a secret in its query string.', { remediation: 'It would be stored on the instance and exported with it. Use the authentication setting or a header read from the environment.', source: SRC }));
        }
        if (bareIpv6InUrl(url)) findings.push(error('vcfops.outbound.ipv6-url', `${url} has an IPv6 address without brackets.`, { remediation: 'Write it as https://[2001:db8::10]:443/path.', source: SRC }));
      } else if (kind === 'SlackPlugin') {
        target = `Slack ${str(values, 'slack_channel', '')}`;
        config.push({ name: 'CHANNEL', value: str(values, 'slack_channel', '') });
        secret('Url', 'SLACK_WEBHOOK_URL', 'the Slack incoming-webhook URL (it is itself the secret)');
      } else if (kind === 'ServiceNowPlugin') {
        const url = str(values, 'sn_instance', '');
        target = url;
        encrypted = /^https:/i.test(url);
        config.push({ name: 'INSTANCE_URL', value: url }, { name: 'USERNAME', value: str(values, 'sn_user', '') });
        secret('PASSWORD', 'SERVICENOW_PASSWORD', 'the password of the ServiceNow integration user');
        if (/^(admin|administrator)$/i.test(str(values, 'sn_user', ''))) findings.push(error('vcfops.outbound.sn-admin', 'The ServiceNow user is the instance administrator.', { remediation: 'Create an integration user with only the incident roles the plugin needs.', source: SRC }));
        if (bareIpv6InUrl(url)) findings.push(error('vcfops.outbound.ipv6-url', `${url} has an IPv6 address without brackets.`, { source: SRC }));
      } else if (kind === 'SNMPTrapPlugin') {
        const version = str(values, 'snmp_version', 'v3');
        const level = str(values, 'snmp_level', 'authPriv');
        const authProtocol = str(values, 'snmp_auth', 'SHA-256');
        const privProtocol = str(values, 'snmp_priv', 'AES256');
        target = `${str(values, 'snmp_host', '')}:${num(values, 'snmp_port', 162)}`;
        config.push({ name: 'destination_host', value: str(values, 'snmp_host', '') }, { name: 'port', value: String(num(values, 'snmp_port', 162)) }, { name: 'version', value: version });
        if (version === 'v2c') {
          encrypted = false;
          secret('community', 'SNMP_COMMUNITY', 'the trap community string');
        } else {
          encrypted = level === 'authPriv';
          config.push({ name: 'username', value: str(values, 'snmp_user', '') }, { name: 'security_level', value: level });
          if (level !== 'noAuthNoPriv') {
            config.push({ name: 'authentication_protocol', value: authProtocol });
            secret('authentication_password', 'SNMP_AUTH_PASSWORD', 'the SNMPv3 authentication passphrase');
          }
          if (level === 'authPriv') {
            config.push({ name: 'privacy_protocol', value: privProtocol });
            secret('privacy_password', 'SNMP_PRIV_PASSWORD', 'the SNMPv3 privacy passphrase');
          }
          if ((level !== 'noAuthNoPriv' && authProtocol === 'MD5') || (level === 'authPriv' && privProtocol === 'DES')) {
            findings.push(warning('vcfops.outbound.snmp-weak', 'MD5 and DES are broken; a captured trap can be read or forged.', { remediation: 'Use SHA-256 or better with AES-256.', source: SRC }));
          }
        }
        findings.push(warning('vcfops.outbound.snmp', 'SNMP traps are fire-and-forget: nothing confirms one arrived.', { remediation: 'Use SNMPv3, and prefer a webhook where the receiver can acknowledge.', source: SRC }));
      } else if (kind === 'LogFilePlugin') {
        target = str(values, 'log_folder', '');
        config.push({ name: 'alertOutputFolder', value: target });
        findings.push(info('vcfops.outbound.logfile-local', 'The Log File plugin writes on the VCF Operations nodes, where only log collection will read it.', { remediation: 'Collect the folder with log management, or pick a plugin that reaches a person.', source: SRC }));
      }

      if (proxy) {
        config.push({ name: 'PROXY_HOST', value: str(values, 'proxy_host', '') }, { name: 'PROXY_PORT', value: String(num(values, 'proxy_port', 3128)) });
        if (proxyUser) {
          config.push({ name: 'PROXY_USERNAME', value: proxyUser });
          secret('PROXY_PASSWORD', 'PROXY_PASSWORD', 'the proxy password');
        }
      }
      if (!encrypted && kind !== 'LogFilePlugin') {
        findings.push(warning('vcfops.outbound.cleartext', 'Alerts will leave VCF Operations unencrypted, and they name hosts, VMs and faults.', { source: SRC }));
      }

      const pluginType = kind === 'SyslogPlugin' ? 'StandardEmailPlugin' : kind;
      const label = OUTBOUND_KINDS.find((option) => option.value === pluginType)?.label ?? pluginType;
      const payload = { pluginTypeId: pluginType, name: instance, configValues: config };

      return {
        platform: PLATFORM,
        title: `${instance} — ${label} to ${target}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once. It sends only when a notification rule uses it.' },
        scope: {
          what: `Every notification rule that names "${instance}".`,
          decidedBy: ['The notification rules attached to it — the instance itself decides nothing about what is sent.'],
          ifWrong: 'Notifications go nowhere, silently. The rules look configured and the alerts look raised.',
        },
        guardrails: [
          { rule: 'Secrets come from the environment only', because: 'An outbound instance holds the keys to a mail relay, a ticketing system or a chat workspace.' },
          { rule: 'The plugin type and its field names are checked on the instance before sending', because: 'A field the release does not know is dropped quietly, and the instance looks right until it has to send.' },
          { rule: 'Tested before any rule depends on it', because: 'The Test button is the only moment anyone sees it fail.' },
          ...(encrypted ? [{ rule: 'Encrypted in transit', because: 'Alert text names systems and faults; it is reconnaissance for anyone on the path.' }] : []),
        ],
        dryRun: ['Run apply.sh --dry-run: it checks the type, prints the body with the secrets left as placeholders, and changes nothing. After applying, press Test on the instance and check the message actually arrived.'],
        undo: ['DELETE /suite-api/api/alertplugins/{id}. Rules that use it stop sending; they do not fail loudly.', 'Re-running apply.sh with the old values updates the instance of the same name back.'],
        told: ['Whoever the rules send to, through this instance.'],
        requires: [
          kind === 'StandardEmailPlugin' ? `Your relay ${target} to accept ${str(values, 'sender', '')} from the VCF Operations nodes.` : kind === 'LogFilePlugin' ? 'Nothing outside VCF Operations.' : `A route from the VCF Operations nodes (or the proxy) to ${target}.`,
          ...(secrets.length > 0 ? [`The environment when applying: ${[...new Set(secrets.map((s) => s.env))].join(', ')}.`] : []),
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(payload, null, 2)}\n`,
          'apply.sh': outboundScript(base, instance, pluginType, secrets, headerRows.length > 0),
          'IMPORT.md': importMd({
            title: 'the outbound instance',
            intro: ['Outbound settings are exported and imported by the interface only with a password (they can hold credentials), in a form that is not documented; the file here is the REST body, applied by apply.sh.'],
            steps: [
              {
                heading: 'The outbound instance',
                files: [`${base}.json`, 'apply.sh'],
                how: [`${[...new Set(secrets.map((s) => `${s.env}=…`))].join(' ')} ./apply.sh (add --dry-run first to preview) — GET /suite-api/api/alertplugins/types to check the type and fields, POST (or PUT, for an existing instance of the same name) /suite-api/api/alertplugins, then PUT /suite-api/api/alertplugins/{id}/enable/true.`],
                verify: pluginType === 'StandardEmailPlugin' ? [] : [`the config value names for ${label} are those of recent releases; apply.sh stops and lists any the instance does not declare.`],
              },
            ],
          }),
        },
        notes: [
          'VCF Operations 9.1 has six outbound plugins: Log File, Standard Email, SNMP Trap, Webhook Notification, Slack and Service-Now Notification. The Syslog plugin is retired; forward to syslog from Log Management instead.',
          'Created enabled: apply.sh enables it straight after creating it. Press Test in the interface to check a message arrives.',
          ...(kind === 'WebhookPlugin' ? ['VERIFY: on some releases custom headers are set on the webhook payload template rather than the instance. If apply.sh reports customHeaders as undeclared, move them to the payload template (vcfops_webhook_payload).'] : []),
          ...(kind === 'SlackPlugin' ? ['VERIFY: some releases take the Slack webhook URL and channel on the notification rule rather than the instance; the notification rule blueprint writes them there too.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_access',
    platform: PLATFORM,
    label: 'Give a team a role on part of the estate',
    group: 'Setup',
    description:
      'A directory group (from VCF SSO / the VCF Identity Broker, or LDAP / Active Directory) or a local user, with a built-in or custom role, scoped to custom groups or named objects. The script creates the custom role from the permission names you pick, looks up every id by name, and applies. Written against groups rather than people, and against a scope rather than the whole estate, because both are the shortcuts that get taken.',
    inputs: [
      {
        id: 'principal',
        label: 'Who',
        control: 'select',
        options: [
          { value: 'group', label: 'A directory group' },
          { value: 'user', label: 'A local user (password from LOCAL_USER_PASSWORD)' },
        ],
        default: 'group',
      },
      { id: 'group', label: 'Directory group', control: 'text', default: 'APP-Payments-Ops', showWhen: { input: 'principal', equals: ['group'] } },
      {
        id: 'source_type',
        label: 'Authentication source type',
        control: 'select',
        options: [
          { value: 'vidb', label: 'VCF SSO (VCF Identity Broker)' },
          { value: 'ldap', label: 'LDAP / Active Directory' },
        ],
        default: 'vidb',
        showWhen: { input: 'principal', equals: ['group'] },
      },
      { id: 'source', label: 'Authentication source name', control: 'text', default: 'VCF SSO', hint: 'As listed under Access Control → Authentication Sources', showWhen: { input: 'principal', equals: ['group'] } },
      { id: 'username', label: 'Local user name', control: 'text', default: 'payments-readonly', showWhen: { input: 'principal', equals: ['user'] } },
      { id: 'email', label: 'Email', control: 'text', default: 'payments-ops@example.com', showWhen: { input: 'principal', equals: ['user'] } },
      { id: 'role', label: 'Role', control: 'select', options: ROLES, default: 'ReadOnly' },
      { id: 'custom_role', label: 'Custom role name', control: 'text', default: 'Payments operator', showWhen: { input: 'role', equals: ['custom'] } },
      {
        id: 'permissions',
        label: 'Permissions in the custom role',
        control: 'textarea',
        default: 'Environment\nDashboards\nViews\nReports\nAlerts',
        hint: 'One per line: the permission names as the role editor shows them, or their keys. apply.sh matches each against GET /auth/privileges and stops on any it cannot find',
        showWhen: { input: 'role', equals: ['custom'] },
      },
      {
        id: 'scope_kind',
        label: 'Scope',
        control: 'select',
        options: [
          { value: 'groups', label: 'Custom groups' },
          { value: 'objects', label: 'Named objects (vCenter, cluster, datacenter …) and everything under them' },
          { value: 'tag', label: 'A tag — through a custom group with that tag rule' },
          { value: 'all', label: 'Every object — see the finding' },
        ],
        default: 'groups',
      },
      { id: 'scope_objects', label: 'On these', control: 'text', default: 'Payments VMs', hint: 'Comma-separated custom group or object names; for a tag, the name of the custom group built from it', showWhen: { input: 'scope_kind', notEquals: ['all'] } },
    ],
    automation: (values: BlueprintValues, name: string): Automation => {
      const principal = str(values, 'principal', 'group');
      const group = str(values, 'group', '');
      const source = str(values, 'source', '');
      const sourceType = str(values, 'source_type', 'vidb');
      const username = str(values, 'username', '');
      const email = str(values, 'email', '');
      const roleChoice = str(values, 'role', 'ReadOnly');
      const customRole = str(values, 'custom_role', 'Custom role');
      const role = roleChoice === 'custom' ? customRole : roleChoice;
      const permissions = str(values, 'permissions', '').split('\n').map((p) => p.trim()).filter(Boolean);
      const scopeKind = str(values, 'scope_kind', 'groups');
      const scope = scopeKind === 'all' ? [] : listOf(str(values, 'scope_objects', ''));
      const who = principal === 'user' ? username : group;
      const base = slugOf(name || `${who}-${role}`, 'access');

      const findings: Finding[] = [];
      if (roleChoice === 'Administrator') {
        findings.push(warning('vcfops.access.admin', 'Administrator includes managing accounts, credentials and every other user.', { remediation: 'Keep it to the platform team. Content administrator covers dashboards, alerts and policies.', source: SRC }));
      }
      if (scope.length === 0 && roleChoice !== 'ReadOnly') {
        findings.push(warning('vcfops.access.unscoped', `${role} on every object in the estate.`, { remediation: 'Scope it to the custom groups the team owns.', source: SRC }));
      }
      if (principal === 'group' && /^[a-z]+[._][a-z]+@/i.test(group)) {
        findings.push(warning('vcfops.access.person', `${group} looks like a person rather than a group.`, { remediation: 'Grant to groups. People move teams, and a grant to a person moves with them.', source: SRC }));
      }
      if (principal === 'user') {
        findings.push(warning('vcfops.access.local-user', 'A local user is not removed when somebody leaves, and has its own password to rotate.', { remediation: 'Use a directory group through VCF SSO where you can; keep local users for break-glass and service integrations.', source: SRC }));
      }
      if (roleChoice === 'custom' && permissions.length === 0) {
        findings.push(error('vcfops.access.empty-role', 'The custom role has no permissions.', { source: SRC }));
      }

      const spec = scopeKind === 'objects' ? 'vSphere Hosts and Clusters' : 'Custom Groups';
      const body = {
        ...(principal === 'group'
          ? { authSourceId: '<set by apply.sh from the source name>', name: group }
          : { username, firstName: username, lastName: '', emailAddress: email, enabled: true }),
        'role-permissions': [{ roleName: role, allowAllObjects: scope.length === 0, 'traversal-spec-instances': [] as unknown[] }],
      };
      const roleBody = roleChoice === 'custom' ? { name: customRole, displayName: customRole, description: `Custom role: ${permissions.join(', ')}`, 'privilege-keys': ['<set by apply.sh from the permission names>'] } : undefined;

      const apply = opsScript({
        about: [
          `Give ${principal === 'user' ? `the local user ${username}` : `the directory group ${group}`} the role ${role}${scope.length > 0 ? ` on ${scope.join(', ')}` : ' on every object'}.`,
          ...(roleChoice === 'custom' ? ['The custom role is created first (or updated, if it exists) from the permission names in permissions.txt.'] : []),
        ],
        secrets: principal === 'user' ? [{ name: 'LOCAL_USER_PASSWORD', hint: 'the initial password for the local user' }] : [],
        body: [
          ...(roleChoice === 'custom'
            ? [
                '# 1. The custom role: every permission name must match exactly one privilege.',
                'PRIVS=$(api GET auth/privileges)',
                'KEYS="[]"',
                'while IFS= read -r want; do',
                '  [[ -z "$want" ]] && continue',
                '  key=$(jq -r --arg w "$want" \'[(.privileges[]?, .["privilege"][]?) | select((.key | ascii_downcase) == ($w | ascii_downcase) or ((.name // .displayName // "") | ascii_downcase) == ($w | ascii_downcase)) | .key] | unique | if length == 1 then .[0] else empty end\' <<<"$PRIVS")',
                '  [[ -n "$key" ]] || { echo "No single permission called \\"${want}\\". Names like it:" >&2; jq -r --arg w "$want" \'[(.privileges[]?, .["privilege"][]?) | select(((.name // .displayName // "") + " " + .key) | ascii_downcase | contains($w | ascii_downcase)) | "  \\(.key)  \\(.name // .displayName // "")"] | .[:20][]\' <<<"$PRIVS" >&2; exit 1; }',
                '  KEYS=$(jq -c --arg k "$key" \'. + [$k]\' <<<"$KEYS")',
                'done < "$HERE/permissions.txt"',
                `ROLE_EXISTS=$(api GET auth/roles | jq -r --arg n ${sh(customRole)} '[(.userRoles[]?, ."user-roles"[]?) | select(.name == $n)] | length')`,
                `jq --argjson k "$KEYS" '."privilege-keys" = $k' "$HERE/${base}-role.json" | send "$([[ "$ROLE_EXISTS" != 0 ]] && echo PUT || echo POST)" auth/roles >/dev/null`,
                '',
              ]
            : []),
          '# 2. The scope: each name resolved to its id, under the traversal spec that holds it.',
          'SPECS=$(api GET auth/traversalspecs)',
          `SPEC=$(jq -c --arg n ${sh(spec)} '[(."traversal-spec"[]?, .traversalSpecs[]?) | select(.name == $n or (.name | test($n; "i")))] | .[0] // empty' <<<"$SPECS")`,
          'IDS="[]"',
          ...scope.map((object) => `IDS=$(jq -c --arg i "$(${scopeKind === 'objects' ? 'resource_id' : 'group_id'} ${sh(object)})" '. + [$i]' <<<"$IDS")`),
          ...(scope.length > 0
            ? [
                `[[ -n "$SPEC" ]] || { echo "No traversal spec named like \\"${spec}\\" (GET /suite-api/api/auth/traversalspecs)." >&2; exit 1; }`,
                'INSTANCE=$(jq -c --argjson ids "$IDS" \'{adapterKind: .adapterKindKey, resourceKind: .resourceKindKey, name: .name, resourceSelection: [{type: "PROPAGATE", resourceId: $ids}]}\' <<<"$SPEC")',
              ]
            : ['INSTANCE=null']),
          '',
          '# 3. The group or user, with its role and scope. An existing one is left alone.',
          ...(principal === 'group'
            ? [
                `SRC_ID=$(auth_source_id ${sh(source)})`,
                `if api GET "auth/usergroups?name=$(uri ${sh(group)})" | jq -e --arg n ${sh(group)} '[.. | objects | select(.name? == $n or .displayName? == $n)] | length > 0' >/dev/null; then`,
                `  echo "${group} is already imported; change its role under Access Control rather than importing it twice." >&2; exit 1`,
                'fi',
                `jq --arg s "$SRC_ID" --argjson t "$INSTANCE" '.authSourceId = $s | ."role-permissions"[0]."traversal-spec-instances" = (if $t == null then [] else [$t] end)' "$HERE/${base}.json" | send POST auth/usergroups | jq -r '.id // empty'`,
              ]
            : [
                'export LOCAL_USER_PASSWORD="${LOCAL_USER_PASSWORD:-<from LOCAL_USER_PASSWORD>}"',
                `jq --argjson t "$INSTANCE" '. + {password: env.LOCAL_USER_PASSWORD} | ."role-permissions"[0]."traversal-spec-instances" = (if $t == null then [] else [$t] end)' "$HERE/${base}.json" | send POST auth/users | jq -r '.id // empty'`,
              ]),
        ],
        undo: principal === 'group' ? 'DELETE /suite-api/api/auth/usergroups/{id}; members lose access at their next sign-in.' : 'DELETE /suite-api/api/auth/users/{id}.',
      });

      return {
        platform: PLATFORM,
        title: `${who} — ${role} on ${scope.join(', ') || 'the whole estate'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, as an access change.' },
        scope: {
          what: `${principal === 'user' ? `The local user ${username}` : `Members of ${group}`}, on ${scope.join(', ') || 'every object'}.`,
          decidedBy: [
            principal === 'user' ? `The local user ${username}, managed in VCF Operations.` : `Membership of ${group} in ${source} (${sourceType === 'vidb' ? 'VCF SSO through the VCF Identity Broker' : 'LDAP / Active Directory'}) — managed outside VCF Operations.`,
            `The role ${role}${roleChoice === 'custom' ? ` (${permissions.length} permissions)` : ''}.`,
            scope.length > 0 ? `The ${scopeKind === 'objects' ? 'objects' : 'custom groups'} ${scope.join(', ')} and everything under them.` : 'No scope: every object.',
          ],
          ifWrong: 'People see or change what they should not, and because membership is in the directory, the change that caused it is not in VCF Operations at all.',
        },
        guardrails: [
          ...(principal === 'group' ? [{ rule: 'Granted to a directory group', because: 'Leavers are removed from the directory once; nobody remembers every tool they had access to.' }] : [{ rule: 'The password comes from the environment', because: 'A local user’s password in a file is a login for anyone who reads it.' }]),
          ...(scope.length > 0 ? [{ rule: `Scoped to ${scope.join(', ')}`, because: 'A team that sees only its own objects gets dashboards that make sense to it.' }] : []),
          { rule: 'Every name is resolved to exactly one id, or the script stops', because: 'A scope that silently resolved to nothing would be granted on nothing — or, worse, on everything.' },
        ],
        dryRun: ['Run apply.sh --dry-run: it resolves the permissions, scope and source by name and prints the bodies. After applying, sign in as a member (or Access Control → the group → Objects) and check what is visible.'],
        undo: [principal === 'group' ? 'DELETE /suite-api/api/auth/usergroups/{id}. Members lose access at their next sign-in.' : 'DELETE /suite-api/api/auth/users/{id}.', ...(roleChoice === 'custom' ? ['DELETE /suite-api/api/auth/roles/{name} once nothing else uses the custom role.'] : [])],
        told: ['Nobody automatically. Record the grant with the access request that asked for it.'],
        requires: [
          principal === 'group' ? `The authentication source "${source}" configured, and ${group} present in it.` : 'LOCAL_USER_PASSWORD in the environment when applying.',
          scope.length > 0 ? `The ${scopeKind === 'objects' ? 'objects' : 'custom groups'} named in the scope${scopeKind === 'tag' ? ' (build the tag group with the custom group blueprint first)' : ''}.` : 'Nothing else.',
        ],
        files: {
          [`${base}.json`]: `${JSON.stringify(body, null, 2)}\n`,
          ...(roleBody ? { [`${base}-role.json`]: `${JSON.stringify(roleBody, null, 2)}\n`, 'permissions.txt': `${permissions.join('\n')}\n` } : {}),
          'apply.sh': apply,
          'IMPORT.md': importMd({
            title: 'the access grant',
            steps: [
              {
                heading: principal === 'group' ? 'The group, its role and scope' : 'The user, its role and scope',
                files: [`${base}.json`, ...(roleBody ? [`${base}-role.json`, 'permissions.txt'] : []), 'apply.sh'],
                how: [`${principal === 'user' ? 'LOCAL_USER_PASSWORD=… ' : ''}./apply.sh (add --dry-run first to preview) — ${roleBody ? 'POST or PUT /suite-api/api/auth/roles, then ' : ''}POST /suite-api/api/auth/${principal === 'group' ? 'usergroups' : 'users'} with the role and the traversal spec it resolves.`],
                verify: ['the role body field privilege-keys and the traversal-spec lookup by name are as the 8.x API reference documents them; apply.sh stops with what it found if either does not resolve.'],
              },
            ],
          }),
        },
        notes: [
          'VCF 9.1 signs in through VCF SSO (the VCF Identity Broker) or LDAP / Active Directory. Direct vCenter authentication as a source is removed in 9.1.',
          'Role names are the internal ones. GET /suite-api/api/auth/roles lists what your instance calls them, including any custom roles.',
          ...(scopeKind === 'tag' ? ['VCF Operations scopes access by objects and custom groups, not by tags directly: build a custom group with the tag rule (the custom group blueprint), and scope to that group.'] : []),
          'If the group already has access through another grant, check that before adding a second one here.',
        ],
        findings,
      };
    },
  }),

  ...VCF_OPS_SETUP_MORE,
];

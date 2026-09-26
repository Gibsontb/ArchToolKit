/**
 * VCF Operations for Networks: data sources, every kind the 9.1 API has.
 *
 * One blueprint, a kind select: vCenter (with VDS IPFIX and the Supervisor's
 * Antrea IPFIX), NSX (IPFIX and latency), every physical switch family, Cisco
 * ACI and UCS, HPE OneView and Virtual Connect, F5, Check Point, Panorama,
 * Fortinet, Kubernetes and OpenShift, HCX, VeloCloud, Infoblox, ServiceNow, the
 * generic switch (a file) and the common device (a DS pack). AWS and Azure are
 * deprecated in the API and not offered.
 *
 * Modes: add (validate first where the API can, skip what exists, add enabled,
 * then per-switch SNMP), bulk add from the CSV, enable, disable.
 */

import { bool, num, str, type BlueprintValues, type SelectOption } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { automationBlueprint, type AutomationBlueprint } from '../from-automation.ts';
import { listOf, slugOf, type Automation } from '../automation.ts';
import { importGuide, networksApi } from './vcf-networks-logs.ts';
import { API_REF, csvCell, envName, isIp, isIpv6, NET, NET_SRC, pipeRows, shq, SNMP_AUTH, SNMP_PRIV } from './vcf-networks-common.ts';

type Auth = 'password' | 'kubeconfig' | 'none' | 'servicenow';

interface Kind {
  readonly label: string;
  readonly group: string;
  /** Under /api/ni. */
  readonly path: string;
  readonly auth: Auth;
  /** Config polling interval fields (physical devices). */
  readonly polling?: boolean;
  /** /{id}/snmp-config exists; the path when it differs from `path`. */
  readonly snmp?: string;
  /** /{id}/enable and /disable, when the path differs from `path`. */
  readonly enablePath?: string;
  /** switch_type is required, from this set. */
  readonly models?: readonly string[];
  /** datasource_type in the Bulk add devices CSV. VERIFY against the dialog's sample. */
  readonly bulk?: string;
  /** Carries a certificate thumbprint in its body (UCS, OneView, Virtual Connect, ACI). */
  readonly thumbprint?: boolean;
  readonly flows?: boolean;
}

const CISCO_MODELS = ['CATALYST_3000', 'CATALYST_4500', 'CATALYST_6500', 'CATALYST9300', 'NEXUS_5K', 'NEXUS_6K', 'NEXUS_7K', 'NEXUS_9K', 'CISCOASRISR', 'CISCOASR1000', 'CISCOISR4000'];
const DELL_MODELS = ['FORCE_10_MXL_10', 'POWERCONNECT_8024', 'S4048', 'Z9100', 'S6000'];

/** Paths, bodies and enumerations from the API reference's Data Sources section. */
export const DS_KINDS: Readonly<Record<string, Kind>> = {
  vcenter: { label: 'vCenter', group: 'VCF', path: '/data-sources/vcenters', auth: 'password', flows: true },
  nsxt: { label: 'NSX Manager', group: 'VCF', path: '/data-sources/nsxt-managers', auth: 'password', flows: true },
  hcx: { label: 'HCX', group: 'VCF', path: '/data-sources/hcx-connectors', auth: 'password' },
  cisco: { label: 'Cisco Catalyst / Nexus / ISR', group: 'Switches and routers', path: '/data-sources/cisco-switches', auth: 'password', polling: true, snmp: '/data-sources/cisco-switches', models: CISCO_MODELS, bulk: 'CISCO_SWITCH' },
  'cisco-asrxr': { label: 'Cisco ASR / XR', group: 'Switches and routers', path: '/data-sources/cisco-asrxr-switches', auth: 'password', polling: true, snmp: '/data-sources/cisco-asr-xr-switches', enablePath: '/data-sources/cisco-asr-xr-switches', bulk: 'CISCO_ASR_XR' },
  arista: { label: 'Arista', group: 'Switches and routers', path: '/data-sources/arista-switches', auth: 'password', polling: true, snmp: '/data-sources/arista-switches', bulk: 'ARISTA_SWITCH' },
  juniper: { label: 'Juniper', group: 'Switches and routers', path: '/data-sources/juniper-switches', auth: 'password', polling: true, snmp: '/data-sources/juniper-switches', bulk: 'JUNIPER_SWITCH' },
  dell: { label: 'Dell (Force10 / PowerConnect / S / Z series)', group: 'Switches and routers', path: '/data-sources/dell-switches', auth: 'password', polling: true, snmp: '/data-sources/dell-switches', models: DELL_MODELS, bulk: 'DELL_SWITCH' },
  'dell-os10': { label: 'Dell OS10', group: 'Switches and routers', path: '/data-sources/dell-os10-switches', auth: 'password', polling: true, snmp: '/data-sources/dell-os10-switches', bulk: 'DELL_OS10_SWITCH' },
  hpe: { label: 'HPE (Aruba / Comware)', group: 'Switches and routers', path: '/data-sources/hpe-switches', auth: 'password', polling: true, snmp: '/data-sources/hpe-switches', bulk: 'HPE_SWITCH' },
  brocade: { label: 'Brocade', group: 'Switches and routers', path: '/data-sources/brocade-switches', auth: 'password', polling: true, snmp: '/data-sources/brocade-switches', bulk: 'BROCADE_SWITCH' },
  mellanox: { label: 'Mellanox', group: 'Switches and routers', path: '/data-sources/mellanox-switches', auth: 'password', polling: true, snmp: '/data-sources/mellanox-switches', bulk: 'MELLANOX_SWITCH' },
  huawei: { label: 'Huawei', group: 'Switches and routers', path: '/data-sources/huawei', auth: 'password', polling: true, snmp: '/data-sources/huawei', bulk: 'HUAWEI_SWITCH' },
  'cisco-aci': { label: 'Cisco ACI (APIC)', group: 'Fabric and compute', path: '/data-sources/cisco-aci', auth: 'password', polling: true, snmp: '/data-sources/cisco-aci', thumbprint: true },
  ucs: { label: 'Cisco UCS Manager', group: 'Fabric and compute', path: '/data-sources/ucs-managers', auth: 'password', polling: true, snmp: '/data-sources/ucs-managers', thumbprint: true, bulk: 'UCS_MANAGER' },
  hpov: { label: 'HPE OneView', group: 'Fabric and compute', path: '/data-sources/hpov-managers', auth: 'password', polling: true, thumbprint: true },
  hpvc: { label: 'HPE Virtual Connect', group: 'Fabric and compute', path: '/data-sources/hpvc-managers', auth: 'password', polling: true, thumbprint: true },
  f5: { label: 'F5 BIG-IP', group: 'Load balancers and firewalls', path: '/data-sources/f5-bigip', auth: 'password', polling: true, snmp: '/data-sources/f5-bigip', bulk: 'F5_BIGIP' },
  checkpoint: { label: 'Check Point', group: 'Load balancers and firewalls', path: '/data-sources/checkpoint-firewalls', auth: 'password', polling: true },
  panorama: { label: 'Palo Alto Panorama', group: 'Load balancers and firewalls', path: '/data-sources/panorama-firewalls', auth: 'password', polling: true },
  fortinet: { label: 'Fortinet FortiManager', group: 'Load balancers and firewalls', path: '/data-sources/fortinet-firewalls', auth: 'password', polling: true },
  kubernetes: { label: 'Kubernetes cluster', group: 'Containers', path: '/data-sources/kubernetes-clusters', auth: 'kubeconfig' },
  openshift: { label: 'OpenShift cluster', group: 'Containers', path: '/data-sources/openshift-clusters', auth: 'kubeconfig' },
  velocloud: { label: 'VeloCloud Orchestrator (SD-WAN)', group: 'WAN, IPAM and CMDB', path: '/data-sources/velocloud', auth: 'password' },
  infoblox: { label: 'Infoblox', group: 'WAN, IPAM and CMDB', path: '/data-sources/infoblox-managers', auth: 'password' },
  servicenow: { label: 'ServiceNow (CMDB)', group: 'WAN, IPAM and CMDB', path: '/data-sources/servicenow-instances', auth: 'servicenow' },
  generic: { label: 'Generic switch (from a file)', group: 'Anything else', path: '/data-sources/generic-switches', auth: 'none' },
  'common-device': { label: 'Common device (DS pack)', group: 'Anything else', path: '/data-sources/common-device', auth: 'password', polling: true, snmp: '/data-sources/common-device' },
};

const KIND_OPTIONS: SelectOption[] = Object.entries(DS_KINDS).map(([value, kind]) => ({ value, label: kind.label, group: kind.group }));
const SNMP_KINDS = Object.entries(DS_KINDS).filter(([, kind]) => kind.snmp).map(([id]) => id);
const POLLING_KINDS = Object.entries(DS_KINDS).filter(([, kind]) => kind.polling).map(([id]) => id);
const PASSWORD_KINDS = Object.entries(DS_KINDS).filter(([, kind]) => kind.auth === 'password' || kind.auth === 'servicenow').map(([id]) => id);
const BULK_KINDS = Object.entries(DS_KINDS).filter(([, kind]) => kind.bulk).map(([id]) => id);

const DEFAULT_ROWS = 'vcenter-mgmt.example.com | vcenter-mgmt | -\nvcenter-wld01.example.com | vcenter-wld01 | -';

export const VCFNET_DATA_SOURCES: AutomationBlueprint = automationBlueprint({
  id: 'vcfnet_data_sources',
  platform: NET,
  label: 'Add, enable or disable data sources (every kind)',
  group: 'Data sources',
  description:
    'Onboard what Networks collects from — vCenter, NSX, HCX, every physical switch family, ACI and UCS, HPE OneView and Virtual Connect, F5, Check Point, Panorama, Fortinet, Kubernetes, OpenShift, VeloCloud, Infoblox, ServiceNow, a generic switch or a common device — through a named collector, validated first, added enabled, with per-switch SNMP, and IPFIX and latency on for vCenter and NSX. Or bulk-add from the CSV, or enable or disable existing ones.',
  inputs: [
    { id: 'source_type', label: 'Kind', control: 'select', options: KIND_OPTIONS, default: 'vcenter' },
    {
      id: 'mode',
      label: 'Action',
      control: 'select',
      options: [
        { value: 'add', label: 'Add (validate, skip existing, add enabled)' },
        { value: 'bulk', label: 'Bulk add from the CSV (physical devices)' },
        { value: 'enable', label: 'Enable the listed sources' },
        { value: 'disable', label: 'Disable the listed sources' },
      ],
      default: 'add',
    },
    {
      id: 'sources',
      label: 'Sources',
      control: 'textarea',
      default: DEFAULT_ROWS,
      hint: 'Address | Nickname | Model (switch type for Cisco and Dell; - otherwise)',
      help: 'Address is an FQDN, an IPv4 or an IPv6 address (ServiceNow: the instance host; Kubernetes and OpenShift: a nickname only).',
    },
    { id: 'collector_id', label: 'Collector id', control: 'text', default: '', hint: 'From GET /api/ni/infra/nodes. Empty resolves it by name' },
    { id: 'collector_name', label: 'Collector name', control: 'text', default: 'vcfnet-collector01' },
    { id: 'username', label: 'Username', control: 'text', default: 'svc-vcfnet@vsphere.local', showWhen: { input: 'source_type', equals: PASSWORD_KINDS } },
    { id: 'ds_tags', label: 'Data source tags', control: 'text', default: '', hint: 'key=value, comma-separated', section: 'More' },
    { id: 'notes', label: 'Notes', control: 'text', default: 'Onboarded by automation', section: 'More' },
    // vCenter
    { id: 'ipfix', label: 'Enable IPFIX (flows)', control: 'toggle', default: true, showWhen: { input: 'source_type', equals: ['vcenter', 'nsxt'] } },
    { id: 'ipfix_dvs', label: 'IPFIX on these VDS only', control: 'text', default: '', hint: 'Comma-separated switch names. Empty: every VDS', showWhen: { input: 'source_type', equals: ['vcenter'] } },
    { id: 'antrea_ipfix', label: 'Supervisor (VKS) Antrea IPFIX', control: 'toggle', default: true, showWhen: { input: 'source_type', equals: ['vcenter'] } },
    // NSX
    { id: 'latency', label: 'Collect NSX latency', control: 'toggle', default: true, showWhen: { input: 'source_type', equals: ['nsxt'] } },
    {
      id: 'nsx_cred',
      label: 'NSX credential',
      control: 'select',
      options: [
        { value: 'USERNAME_PASSWORD', label: 'Username and password' },
        { value: 'CERTIFICATE', label: 'Principal identity certificate' },
      ],
      default: 'USERNAME_PASSWORD',
      showWhen: { input: 'source_type', equals: ['nsxt'] },
    },
    // Kubernetes / OpenShift
    { id: 'k8s_nsx', label: 'NSX Manager of the cluster', control: 'text', default: 'nsx-mgmt.example.com', hint: 'Its data source must exist; its id is the manager_id', showWhen: { input: 'source_type', equals: ['kubernetes', 'openshift'] } },
    // Common device / generic
    { id: 'pack_id', label: 'DS pack id', control: 'text', default: '', hint: 'From GET /data-sources/common-device/dspack', showWhen: { input: 'source_type', equals: ['common-device'] } },
    { id: 'pack_file', label: 'DS pack file to upload first', control: 'text', default: '', hint: 'Path on the machine that runs it. Empty: already uploaded', showWhen: { input: 'source_type', equals: ['common-device'] } },
    { id: 'generic_file', label: 'Generic switch file', control: 'text', default: 'generic-switch.zip', hint: 'The device data file the generic switch reads', showWhen: { input: 'source_type', equals: ['generic'] } },
    // Polling
    {
      id: 'polling_type',
      label: 'Config polling',
      control: 'select',
      options: [
        { value: 'PRESET', label: 'Preset interval' },
        { value: 'CUSTOM', label: 'Custom interval' },
        { value: 'SCHEDULED', label: 'Scheduled (UTC time, days)' },
      ],
      default: 'PRESET',
      showWhen: { input: 'source_type', equals: POLLING_KINDS },
    },
    { id: 'polling_minutes', label: 'Polling interval (minutes)', control: 'number', default: 10, min: 10, max: 10080, hint: 'Preset: 10, 15, 30, 60, 720, 1440, 4320, 7200, 10080', showWhen: { input: 'polling_type', equals: ['PRESET', 'CUSTOM'] } },
    { id: 'polling_time', label: 'Polling time (UTC)', control: 'text', default: '02:00', showWhen: { input: 'polling_type', equals: ['SCHEDULED'] } },
    { id: 'polling_days', label: 'Polling days', control: 'checklist', options: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d) => ({ value: d, label: d[0] + d.slice(1).toLowerCase() })), default: 'MONDAY,THURSDAY', showWhen: { input: 'polling_type', equals: ['SCHEDULED'] } },
    // SNMP per switch
    {
      id: 'snmp',
      label: 'Switch SNMP (interface counters)',
      control: 'select',
      options: [
        { value: 'v3', label: 'SNMP v3' },
        { value: 'v2c', label: 'SNMP v2c' },
        { value: 'off', label: 'Off' },
      ],
      default: 'v3',
      showWhen: { input: 'source_type', equals: SNMP_KINDS },
    },
    { id: 'snmp_user', label: 'SNMP v3 user', control: 'text', default: 'vcfnet-ro', showWhen: { input: 'snmp', equals: ['v3'] } },
    { id: 'snmp_context', label: 'SNMP v3 context', control: 'text', default: '', showWhen: { input: 'snmp', equals: ['v3'] } },
    { id: 'snmp_auth', label: 'SNMP v3 authentication', control: 'select', options: SNMP_AUTH, default: 'SHA', showWhen: { input: 'snmp', equals: ['v3'] } },
    { id: 'snmp_priv', label: 'SNMP v3 privacy', control: 'select', options: SNMP_PRIV, default: 'AES256', showWhen: { input: 'snmp', equals: ['v3'] } },
    { id: 'validate', label: 'Validate before adding', control: 'toggle', default: true, hint: 'vCenter has a validate call; others are validated by the add itself' },
  ],
  automation: (values: BlueprintValues, name: string): Automation => {
    const type = DS_KINDS[str(values, 'source_type', 'vcenter')] ? str(values, 'source_type', 'vcenter') : 'vcenter';
    const kind = DS_KINDS[type]!;
    const mode = str(values, 'mode', 'add');
    const collectorId = str(values, 'collector_id', '');
    const collectorName = str(values, 'collector_name', '');
    const user = str(values, 'username', '');
    const ipfix = bool(values, 'ipfix', true);
    const ipfixDvs = listOf(str(values, 'ipfix_dvs', ''));
    const antrea = bool(values, 'antrea_ipfix', true);
    const latency = bool(values, 'latency', true);
    const nsxCred = str(values, 'nsx_cred', 'USERNAME_PASSWORD');
    const snmp = kind.snmp ? str(values, 'snmp', 'v3') : 'off';
    const snmpAuth = str(values, 'snmp_auth', 'SHA');
    const snmpPriv = str(values, 'snmp_priv', 'AES256');
    const pollingType = str(values, 'polling_type', 'PRESET');
    const pollingMinutes = num(values, 'polling_minutes', 10);
    const validate = bool(values, 'validate', true);
    const tags = listOf(str(values, 'ds_tags', '')).map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? { tag_key: pair, tag_value: '' } : { tag_key: pair.slice(0, at).trim(), tag_value: pair.slice(at + 1).trim() };
    });
    const base = slugOf(name || `${type}-sources`, 'data-sources');

    const rows = pipeRows(str(values, 'sources', ''), 3).filter((row) => row[0]);
    const sources = rows.map(([address, nickname, model]) => {
      const addr = address!;
      const nick = nickname || addr.split('.')[0] || addr;
      return { address: addr, nickname: nick, model: model ?? '', envVar: envName('VCFNET_PW', addr), snmpVar: envName('VCFNET_SNMP', addr), kubeVar: envName('VCFNET_KUBECONFIG', addr) };
    });

    const findings: Finding[] = [];
    if (sources.length === 0) findings.push(error('vcfnet.ds.none', 'No sources are listed.', { source: NET_SRC }));
    if (!collectorId && !collectorName && mode !== 'enable' && mode !== 'disable') findings.push(error('vcfnet.ds.no-collector', 'No collector is named. Every data source is polled through a collector.', { source: NET_SRC }));
    if (kind.flows && !ipfix && mode === 'add') {
      findings.push(
        warning('vcfnet.ds.no-ipfix', `IPFIX is off, so these ${kind.label} sources give Networks topology and configuration, and no flows.`, {
          remediation: 'Application discovery, micro-segmentation planning and every flow check need IPFIX on the distributed switches (vCenter) or NSX.',
          source: NET_SRC,
        }),
      );
    }
    if (kind.auth === 'password' && /administrator@vsphere\.local|^admin$|^root$/i.test(user)) {
      findings.push(warning('vcfnet.ds.admin', `${user} is an administrator account. Networks needs read access (plus the IPFIX privilege on vCenter), not full admin.`, { source: NET_SRC }));
    }
    if (kind.models) {
      for (const source of sources) {
        if (!kind.models.includes(source.model)) {
          findings.push(error('vcfnet.ds.model', `${source.address}: model "${source.model || '(none)'}" is not a ${kind.label} switch_type. One of: ${kind.models.join(', ')}.`, { source: NET_SRC }));
        }
      }
    }
    if ((type === 'kubernetes' || type === 'openshift') && !str(values, 'k8s_nsx', '')) {
      findings.push(error('vcfnet.ds.k8s-manager', 'A Kubernetes or OpenShift data source needs the NSX Manager it runs on (manager_id).', { source: NET_SRC }));
    }
    if (type === 'common-device' && !str(values, 'pack_id', '')) findings.push(error('vcfnet.ds.pack', 'A common device needs its DS pack id.', { source: NET_SRC }));
    if (mode === 'bulk' && !kind.bulk) {
      findings.push(error('vcfnet.ds.bulk-kind', `Bulk add takes physical devices; ${kind.label} is added through the API one at a time. Choose Add.`, { source: NET_SRC }));
    }
    if (snmp === 'v2c') findings.push(warning('vcfnet.ds.snmp-v2c', 'SNMP v2c sends its community in clear text on every poll. Use v3 where the switch has it.', { source: NET_SRC }));
    if (snmp === 'v3' && (snmpAuth === 'MD5' || ['DES', '3DES', 'NO_PRIV'].includes(snmpPriv) || snmpAuth === 'NO_AUTH')) {
      findings.push(warning('vcfnet.ds.snmp-weak', `SNMP v3 with ${snmpAuth}/${snmpPriv} is weaker than it needs to be. SHA with AES is the norm.`, { source: NET_SRC }));
    }
    if (kind.polling && pollingType === 'PRESET' && ![10, 15, 30, 60, 720, 1440, 4320, 7200, 10080].includes(pollingMinutes)) {
      findings.push(error('vcfnet.ds.preset', `${pollingMinutes} minutes is not a preset interval (10, 15, 30 min, 1 h, 12 h, 1, 3, 5 or 7 days). Choose Custom for any other value.`, { source: NET_SRC }));
    }

    const polling = kind.polling
      ? pollingType === 'SCHEDULED'
        ? { config_polling_interval_type: 'SCHEDULED', scheduled_config_polling_time: str(values, 'polling_time', '02:00'), scheduled_config_polling_days: str(values, 'polling_days', 'MONDAY') }
        : { config_polling_interval_type: pollingType, config_polling_interval_in_min: String(pollingMinutes) }
      : {};

    const bodyFor = (source: (typeof sources)[number]): Record<string, unknown> => {
      const where = type === 'kubernetes' || type === 'openshift' || type === 'servicenow' ? {} : isIp(source.address) ? { ip: source.address } : { fqdn: source.address };
      const common = { ...where, nickname: source.nickname, enabled: true, notes: str(values, 'notes', 'Onboarded by automation') };
      const credentials = kind.auth === 'password' || kind.auth === 'servicenow' ? { credentials: { username: user } } : {};
      const tagField = tags.length > 0 && !['kubernetes', 'openshift', 'servicenow', 'hcx', 'infoblox', 'velocloud'].includes(type) ? { tags, enable_ds_associated_tags: true } : {};
      switch (type) {
        case 'vcenter':
          return {
            ...common,
            ...credentials,
            ...(ipfix ? { ipfix_request: ipfixDvs.length > 0 ? { enable_for_dvs: ipfixDvs.join(',') } : { enable_all: true } } : {}),
            antrea_ipfix_request: { default_supervisor_ipfix: antrea },
            ...tagField,
          };
        case 'nsxt':
          return { ...common, ...(nsxCred === 'CERTIFICATE' ? {} : credentials), cred_type: nsxCred, ipfix_enabled: ipfix, latency_enabled: latency, ...tagField };
        case 'kubernetes':
        case 'openshift':
          return { ...common, credentials: {} };
        case 'servicenow':
          return { ...common, instance_id: source.address, ...credentials };
        case 'generic':
          return { ...common, ...tagField };
        case 'common-device':
          return { ...common, ...credentials, ...polling, pack_id: str(values, 'pack_id', ''), ...tagField };
        default:
          return { ...common, ...credentials, ...polling, ...(kind.models ? { switch_type: source.model } : {}), ...tagField };
      }
    };

    const needsPassword = (mode === 'add' || mode === 'bulk') && (kind.auth === 'password' || kind.auth === 'servicenow') && !(type === 'nsxt' && nsxCred === 'CERTIFICATE');
    const needsSnmp = mode === 'add' && snmp !== 'off';
    const secretVars = [
      ...(needsPassword ? sources.map((source) => source.envVar) : []),
      ...(mode === 'add' && (type === 'kubernetes' || type === 'openshift') ? sources.map((source) => source.kubeVar) : []),
      ...(mode === 'add' && type === 'nsxt' && nsxCred === 'CERTIFICATE' ? ['VCFNET_NSX_CERT_FILE', 'VCFNET_NSX_KEY_FILE'] : []),
    ];
    const snmpVars = needsSnmp ? (snmp === 'v2c' ? ['VCFNET_SNMP_COMMUNITY'] : [...(snmpAuth !== 'NO_AUTH' ? ['VCFNET_SNMP_AUTH_PASSWORD'] : []), ...(snmpAuth !== 'NO_AUTH' && snmpPriv !== 'NO_PRIV' ? ['VCFNET_SNMP_PRIV_PASSWORD'] : [])]) : [];

    const snmpBody =
      snmp === 'v2c'
        ? { snmp_enabled: true, snmp_version: 'v2c', config_snmp_2c: {} }
        : { snmp_enabled: true, snmp_version: 'v3', config_snmp_3: { username: str(values, 'snmp_user', 'vcfnet-ro'), context_name: str(values, 'snmp_context', ''), authentication_type: snmpAuth, privacy_type: snmpPriv } };

    const enableBase = kind.enablePath ?? kind.path;
    const lookup = type === 'kubernetes' || type === 'openshift' ? '.nickname' : type === 'servicenow' ? '.instance_id' : 'ip-or-fqdn';

    const script: string[] = [
      '#!/usr/bin/env bash',
      `# ${mode === 'add' ? 'Add' : mode === 'bulk' ? 'Bulk-add' : mode === 'enable' ? 'Enable' : 'Disable'} ${sources.length} ${kind.label} data source(s) in VCF Operations for Networks.`,
      '#',
      '# Every secret comes from its own environment variable (named in sources.json)',
      '# and reaches curl through jq $ENV on stdin, never an argument. --dry-run',
      '# prints what it would send, with secrets left out, and changes nothing.',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      ...networksApi(),
      '',
      'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
      `KIND_PATH=${shq(kind.path)}`,
      '',
    ];

    const allVars = [...secretVars, ...snmpVars];
    if (allVars.length > 0) {
      script.push(
        'MISSING=()',
        `for v in ${allVars.join(' ')}; do if [[ -n "\${!v:-}" ]]; then export "$v"; elif (( ! DRY_RUN )); then MISSING+=("$v"); fi; done`,
        '(( ${#MISSING[@]} == 0 )) || { printf "Set from your vault: %s\\n" "${MISSING[@]}" >&2; exit 2; }',
        '',
      );
    }

    script.push(
      '# find_id ADDRESS: the entity id of the source of this kind at that address, or empty.',
      'find_id() {',
      '  local id',
      '  for id in $(ni GET "$KIND_PATH" | jq -r \'.results[]?.entity_id // empty\'); do',
      lookup === 'ip-or-fqdn'
        ? '    if ni GET "$KIND_PATH/$id" | jq -e --arg a "$1" \'((.fqdn // "") | ascii_downcase) == ($a | ascii_downcase) or ((.ip // "") | ascii_downcase) == ($a | ascii_downcase)\' >/dev/null; then echo "$id"; return 0; fi'
        : `    if ni GET "$KIND_PATH/$id" | jq -e --arg a "$1" '(${lookup} // "") == $a' >/dev/null; then echo "$id"; return 0; fi`,
      '  done',
      '}',
      '',
    );

    if (mode === 'enable' || mode === 'disable') {
      script.push(
        'FAILED=0',
        "while read -r ADDR; do",
        '  ID=$(find_id "$ADDR")',
        '  if [[ -z "$ID" ]]; then echo "not found: $ADDR" >&2; FAILED=1; continue; fi',
        `  if (( DRY_RUN )); then echo "DRY RUN: would POST ${enableBase}/$ID/${mode} ($ADDR)"; continue; fi`,
        `  ni POST "${enableBase}/$ID/${mode}" >/dev/null && echo "${mode}d $ADDR ($ID)"`,
        "done < <(jq -r '.[].address' sources.json)",
        'exit $FAILED',
        '',
      );
    } else {
      script.push(
        `PROXY=${shq(collectorId)}`,
        'if [[ -z "$PROXY" ]]; then',
        '  # The node list carries ids; each node is read to match its name.',
        "  for id in $(ni GET /infra/nodes | jq -r '.results[]? | .entity_id'); do",
        `    PROXY=$(ni GET "/infra/nodes/$id" | jq -r --arg n ${shq(collectorName)} --arg id "$id" 'select((.name // "") == $n) | .proxy_id // $id')`,
        '    [[ -n "$PROXY" ]] && break',
        '  done',
        `  [[ -n "$PROXY" ]] || { echo "No collector named ${collectorName.replace(/["$`\\]/g, '')}" >&2; exit 2; }`,
        'fi',
        'echo "collector ${PROXY}"',
        '',
      );
      if (mode === 'bulk') {
        script.push(
          '# Fill the password column from the environment into a private temporary',
          '# copy, upload it (POST /data-sources/bulk/add, multipart "attachment"),',
          '# delete it, then show the per-row result.',
          'umask 077',
          'FILLED=$(mktemp); trap \'rm -f "$FILLED"\' EXIT',
          'head -n1 import/bulk-add-devices.csv > "$FILLED"',
          'i=0',
          'while IFS= read -r line; do',
          "  VAR=$(jq -r --argjson i \"$i\" '.[$i].envVar' sources.json)",
          '  # Column 5 is the password; the CSV writes it empty. Quote it for CSV.',
          '  PW=$(jq -rn --arg v "$VAR" \'$ENV[$v] | "\\"" + gsub("\\""; "\\"\\"") + "\\""\')',
          '  awk -F, -v OFS=, -v pw="$PW" -v proxy="$PROXY" \'{ $5 = pw; if ($8 ~ /^<REQUIRED/) $8 = proxy; print }\' <<<"$line" >> "$FILLED"',
          '  i=$((i + 1))',
          'done < <(tail -n +2 import/bulk-add-devices.csv)',
          'if (( DRY_RUN )); then echo "DRY RUN: would upload $((i)) row(s) to /data-sources/bulk/add"; exit 0; fi',
          'REQ=$(ni_form POST /data-sources/bulk/add -F "attachment=@${FILLED};type=text/csv" | jq -r \'.request_id // .id // empty\')',
          'rm -f "$FILLED"',
          'echo "bulk request ${REQ}"',
          '[[ -n "$REQ" ]] && for n in 1 2 3 4 5 6 7 8 9 10 11 12; do',
          '  OUT=$(ni GET "/data-sources/bulk/view-details/${REQ}")',
          "  if jq -e '(.status // .request_status // \"\") | test(\"COMPLETE|SUCCESS|FAIL\"; \"i\")' <<<\"$OUT\" >/dev/null; then echo \"$OUT\" | jq .; break; fi",
          '  sleep 10',
          'done',
          'exit 0',
          '',
        );
      } else {
        if (type === 'kubernetes' || type === 'openshift') {
          script.push(
            '# The NSX Manager this cluster runs on is its manager_id.',
            `NSX_ADDR=${shq(str(values, 'k8s_nsx', ''))}`,
            'MANAGER=""',
            "for id in $(ni GET /data-sources/nsxt-managers | jq -r '.results[]?.entity_id // empty'); do",
            '  if ni GET "/data-sources/nsxt-managers/$id" | jq -e --arg a "$NSX_ADDR" \'(.fqdn // "") == $a or (.ip // "") == $a\' >/dev/null; then MANAGER="$id"; break; fi',
            'done',
            '[[ -n "$MANAGER" ]] || { echo "Add NSX Manager $NSX_ADDR as a data source first." >&2; exit 2; }',
            '',
          );
        }
        if (type === 'common-device' && str(values, 'pack_file', '')) {
          script.push(
            '# Upload the DS pack first (PUT /data-sources/common-device/dspack, multipart "file").',
            `PACK=${shq(str(values, 'pack_file', ''))}`,
            '[[ -f "$PACK" ]] || { echo "No DS pack at $PACK" >&2; exit 2; }',
            '(( DRY_RUN )) || ni_form PUT /data-sources/common-device/dspack -F "file=@${PACK}" >/dev/null',
            '',
          );
        }
        script.push(
          'ADDED=0; SKIPPED=0; FAILED=0',
          '(( DRY_RUN )) || : > created-ids.txt',
          'while read -r src; do',
          '  ADDR=$(jq -r .address <<<"$src"); NICK=$(jq -r .nickname <<<"$src")',
          '  if [[ -n "$(find_id "$([[ "$KIND_PATH" == *kubernetes* || "$KIND_PATH" == *openshift* ]] && echo "$NICK" || echo "$ADDR")")" ]]; then',
          '    echo "exists: $ADDR (left as it is)"; SKIPPED=$((SKIPPED + 1)); continue',
          '  fi',
          '  # The body from sources.json, plus the collector and the secret for this source.',
          '  BODY=$(jq --arg proxy "$PROXY" --arg pw "$(jq -r .envVar <<<"$src")" \'.body + {proxy_id: $proxy}',
          '    | if .credentials? and ($ENV[$pw] // "") != "" then .credentials.password = $ENV[$pw] else . end\' <<<"$src")',
        );
        if (type === 'kubernetes' || type === 'openshift') {
          script.push(
            '  KVAR=$(jq -r .kubeVar <<<"$src")',
            '  [[ -f "${!KVAR}" ]] || { echo "$KVAR must name the kubeconfig file for $NICK" >&2; FAILED=1; continue; }',
            '  BODY=$(jq --arg m "$MANAGER" --rawfile k "${!KVAR}" \'.manager_id = $m | .credentials.kubeconfig = $k\' <<<"$BODY")',
          );
        }
        if (type === 'nsxt' && nsxCred === 'CERTIFICATE') {
          script.push('  BODY=$(jq --rawfile c "$VCFNET_NSX_CERT_FILE" --rawfile k "$VCFNET_NSX_KEY_FILE" \'.client_certificate = $c | .client_private_key = $k\' <<<"$BODY")');
        }
        if (type === 'vcenter' && validate) {
          script.push(
            '  # Validate first: POST /data-sources/vcenters/validate with the same address, collector and credential.',
            '  if (( ! DRY_RUN )); then',
            '    if ! jq \'{ip, fqdn, proxy_id, credentials, ipfix_enabled: (.ipfix_request != null)} | with_entries(select(.value != null))\' <<<"$BODY" \\',
            '        | ni POST /data-sources/vcenters/validate --data @- >/dev/null; then',
            '      echo "validation failed: $ADDR (address, credential or certificate); not added" >&2; FAILED=1; continue',
            '    fi',
            '  fi',
          );
        }
        script.push(
          '  if (( DRY_RUN )); then',
          '    echo "DRY RUN: would POST $KIND_PATH:"; jq \'del(.credentials.password, .credentials.kubeconfig, .client_private_key)\' <<<"$BODY"',
          '    continue',
          '  fi',
          '  ID=$(ni POST "$KIND_PATH" --data @- <<<"$BODY" | jq -r \'.entity_id // empty\') || { echo "add failed: $ADDR" >&2; FAILED=1; continue; }',
          '  echo "added $ADDR ($ID)"; echo "$ID $ADDR" >> created-ids.txt; ADDED=$((ADDED + 1))',
        );
        if (needsSnmp) {
          script.push(
            '  # SNMP for this switch: its own secret when set, else the shared one.',
            '  SVAR=$(jq -r .snmpVar <<<"$src")',
            '  jq --arg sv "$SVAR" \'.snmp',
            snmp === 'v2c'
              ? '    | .config_snmp_2c.community_string = ($ENV[$sv] // $ENV.VCFNET_SNMP_COMMUNITY)\' snmp.json \\'
              : `    ${snmpAuth !== 'NO_AUTH' ? '| .config_snmp_3.authentication_password = $ENV.VCFNET_SNMP_AUTH_PASSWORD' : ''} ${snmpAuth !== 'NO_AUTH' && snmpPriv !== 'NO_PRIV' ? '| .config_snmp_3.privacy_password = $ENV.VCFNET_SNMP_PRIV_PASSWORD' : ''}' snmp.json \\`,
            `    | ni PUT "${kind.snmp}/$ID/snmp-config" --data @- >/dev/null && echo "  SNMP ${snmp} on" || { echo "  SNMP not set on $ADDR" >&2; FAILED=1; }`,
          );
        }
        if (type === 'generic') {
          script.push(
            `  ni_form PUT "/data-sources/generic-switches/$ID/data" -F ${shq(`file=@${str(values, 'generic_file', 'generic-switch.zip')}`)} >/dev/null \\`,
            '    && echo "  device file uploaded" || { echo "  device file not uploaded for $ADDR" >&2; FAILED=1; }',
          );
        }
        script.push(
          "done < <(jq -c '.[]' sources.json)",
          '',
          'echo "added ${ADDED}, already there ${SKIPPED}, failed ${FAILED}"',
          '(( DRY_RUN )) && echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
          '(( FAILED == 0 ))',
          '',
        );
      }
    }

    const sourcesJson = sources.map((source) => ({
      address: source.address,
      nickname: source.nickname,
      ...(kind.models ? { model: source.model } : {}),
      envVar: source.envVar,
      ...(needsSnmp ? { snmpVar: source.snmpVar } : {}),
      ...(type === 'kubernetes' || type === 'openshift' ? { kubeVar: source.kubeVar } : {}),
      body: bodyFor(source),
    }));

    const files: Record<string, string> = {
      [`${base}.sh`]: script.join('\n'),
      'sources.json': `${JSON.stringify(sourcesJson, null, 2)}\n`,
      ...(needsSnmp ? { 'snmp.json': `${JSON.stringify({ snmp: snmpBody }, null, 2)}\n` } : {}),
    };
    if (kind.bulk) {
      // Settings > Accounts and Data Sources > Bulk add devices takes this CSV.
      // The password column is left empty; the script fills a private copy.
      files['import/bulk-add-devices.csv'] = `${[
        'datasource_type,ip,fqdn,username,password,nickname,polling_interval_in_mins,collector_ip,notes',
        ...sources.map((source) =>
          [kind.bulk!, isIp(source.address) ? source.address : '', isIp(source.address) ? '' : source.address, user, '', source.nickname, String(pollingType === 'SCHEDULED' ? 10 : pollingMinutes), collectorId || '<REQUIRED — collector IP>', str(values, 'notes', '')].map(csvCell).join(','),
        ),
      ].join('\n')}\n`;
    }

    const verbs = mode === 'enable' ? 'Enable' : mode === 'disable' ? 'Disable' : mode === 'bulk' ? 'Bulk-add' : 'Add';
    files['IMPORT.md'] = importGuide({
      product: 'VCF Operations for Networks',
      intro:
        mode === 'enable' || mode === 'disable'
          ? `${base}.sh finds each listed ${kind.label} source by address and calls POST ${enableBase}/{id}/${mode}.`
          : `${base}.sh ${mode === 'bulk' ? 'uploads import/bulk-add-devices.csv to POST /api/ni/data-sources/bulk/add' : `posts one body per source to POST /api/ni${kind.path}`}; each body is in sources.json, and the secrets come from the environment variables named there.`,
      steps: [
        ...(kind.bulk && mode !== 'enable' && mode !== 'disable'
          ? [
              {
                heading: mode === 'bulk' ? 'Bulk add' : 'Or: bulk add from the CSV instead',
                lines: [
                  mode === 'bulk'
                    ? `Export ${secretVars.join(', ') || 'the password variables'}, then \`./${base}.sh\`: it fills the password column into a private temporary copy, uploads it, deletes it and prints the per-row result.`
                    : 'Settings > Accounts and Data Sources > Add Source > Bulk add devices, with import/bulk-add-devices.csv after filling the password column on the machine that uploads (delete the filled copy afterwards).',
                  '',
                  `VERIFY: datasource_type "${kind.bulk}" against the sample .csv the Bulk add devices dialog offers.`,
                ],
              },
            ]
          : []),
        ...(mode === 'bulk'
          ? []
          : [
              {
                heading: `${verbs} the sources`,
                lines: [
                  `${allVars.length > 0 ? `Export ${allVars.join(', ')} from your vault (a switch-specific SNMP secret may be set in its snmpVar), then run` : 'Run'} \`./${base}.sh\` (\`--dry-run\` first prints every call without secrets).`,
                  '',
                  `By hand: Settings > Accounts and Data Sources > ${mode === 'add' ? `Add Source > ${kind.label}, collector ${collectorName || collectorId}` : `the source's menu > ${mode === 'enable' ? 'Enable' : 'Disable'}`}.`,
                ],
              },
            ]),
      ],
      verify: [
        `Body fields for ${kind.path} are the API reference's (${Object.keys(sources[0] ? bodyFor(sources[0]) : {}).join(', ')}${kind.auth === 'password' ? ', credentials.password' : ''}, proxy_id).`,
        ...(kind.enablePath ? ['The API reference spells this kind two ways (cisco-asrxr-switches for add, cisco-asr-xr-switches for enable and snmp-config); the script uses each as documented.'] : []),
        ...(type === 'velocloud' ? ['VeloCloud: the reference body shows credentials.username only; the password is sent too — drop it if your orchestrator uses an API token.'] : []),
        ...(type === 'generic' ? ['PUT /data-sources/generic-switches/{id}/data takes the device file as multipart "file".'] : []),
        ...(type === 'kubernetes' || type === 'openshift' ? ['manager_id is taken as the NSX Manager data source’s entity id.'] : []),
        ...(needsSnmp ? ['snmp-config replaces the whole SNMP block of the switch.'] : []),
        ...(type !== 'vcenter' && mode === 'add' ? ['Only vCenter has a validate call; for this kind the add itself rejects a bad address or credential, and the script reports that source as failed.'] : []),
      ],
      sources: [API_REF, 'Data Sources: POST per kind, /{id}/enable, /{id}/disable, /{id}/snmp-config (SNMPConfig v2c/v3), /vcenters/validate, /bulk/add (multipart attachment), /bulk/view-details/{request_id}.'],
    });

    const flowsNote = kind.flows ? (type === 'vcenter' ? (ipfix ? `IPFIX on ${ipfixDvs.length > 0 ? ipfixDvs.join(', ') : 'every VDS'}${antrea ? ' and the Supervisor Antrea IPFIX' : ''}` : 'no IPFIX') : `IPFIX ${ipfix ? 'on' : 'off'}, latency ${latency ? 'on' : 'off'}`) : '';

    return {
      platform: NET,
      title: `${verbs} ${sources.length} ${kind.label} data source${sources.length === 1 ? '' : 's'}${flowsNote && mode === 'add' ? ` (${flowsNote})` : ''}${needsSnmp ? `, SNMP ${snmp}` : ''}`,
      effect: 'reversible',
      trigger: { kind: 'manual', detail: 'Run when the sources are ready to be monitored, or to switch them on or off.', worstCase: 'once per source' },
      scope: {
        what: `Exactly the listed ${kind.label} sources: ${sources.map((source) => source.address).join(', ') || 'none'}.`,
        decidedBy: ['sources.json, written from the list above.', ...(mode === 'enable' || mode === 'disable' ? ['Each is found by its address; one not found is reported, not guessed.'] : [`Collector ${collectorId || collectorName}.`, 'A source already present at the same address is left alone.'])],
        ifWrong: kind.flows && ipfix ? 'IPFIX on a switch it was not meant for adds a flow export from every host on it: nothing breaks, but the collector’s load rises with it.' : 'A source on the wrong collector is polled across a WAN link, or not at all; delete it and add it again.',
      },
      guardrails: [
        { rule: 'Every secret from its own variable, all present before anything is sent', because: 'A password in the payload is a password in the repository.' },
        { rule: 'Skips a source that already exists', because: 'Adding it twice makes Networks poll the device twice with the same credential.' },
        ...(type === 'vcenter' && validate ? [{ rule: 'Validates each vCenter before adding it', because: 'A bad certificate or credential is caught before a half-working source is left behind.' }] : []),
        { rule: 'Through a named collector', because: 'A source on the wrong collector is polled across a WAN link, or not at all.' },
      ],
      dryRun: [`Run ./${base}.sh --dry-run. It prints every call it would make, with secrets left out.`],
      undo: [
        mode === 'disable' ? `Run it again with the action Enable.` : mode === 'enable' ? 'Run it again with the action Disable.' : `DELETE /api/ni${kind.path}/{id} for each id in created-ids.txt, or Settings > Accounts and Data Sources > Delete. Collected history is kept until it ages out.`,
      ],
      told: ['Nobody. A failing data source shows on Settings > Accounts and Data Sources and in GET /api/ni/data-sources/health.'],
      requires: [
        `A ${kind.label} account with read access${type === 'vcenter' ? ' and the privilege to change IPFIX settings on the VDS' : ''}.`,
        ...allVars.map((variable) => `${variable} from your vault${variable.startsWith('VCFNET_KUBECONFIG') ? ' (the path to the kubeconfig file)' : ''}.`),
        'The collector able to reach every source (and IPv6 routing to any IPv6 address listed).',
        'jq and curl.',
      ],
      files,
      notes: [
        'AWS and Azure data sources are deprecated in 9.1 and not offered here.',
        ...(sources.some((source) => isIpv6(source.address)) ? ['IPv6 addresses go in the ip field; the collector needs an IPv6 path to them.'] : []),
        'Collector lookup by name walks /api/ni/infra/nodes; pass the id when you have it.',
      ],
      findings,
    };
  },
});

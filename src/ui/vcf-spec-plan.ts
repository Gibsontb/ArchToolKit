/**
 * The VCF spec builder page's plan assembly, without the DOM.
 *
 * The page reads every control into a flat record of values, keyed by the
 * control's name, and hands it here. Everything that turns those values into a
 * `DeploymentPlan` — which fields apply to which scenario, how a grid's text
 * becomes switches or resource pools, what an empty box means — lives in this
 * module, so it can be tested with plain objects and every scenario can be
 * built without a browser.
 *
 * `FORM_DEFAULTS` is what the page draws its controls with, so a test that
 * starts from it is building exactly what an untouched page builds.
 */

import type { Json } from '../editor/doc.ts';
import {
  SIZE_PRESETS,
  type CustomDvsPlan,
  type DeploymentPlan,
  type DvsProfile,
  type ExistingComponent,
  type HostEntry,
  type LacpPlan,
  type NetworkPlan,
  type NsxTeamingPlan,
  type PoolPlan,
  type ServiceSpecKey,
  type SizePreset,
  type VersionedComponent,
} from '../vcf/spec-builder.ts';
import { scenarioRule, type DeploymentScenario, type ScenarioRule } from '../vcf/scenarios.ts';
import { managementNetworkModel, type ManagementNetworkModel } from '../vcf/management-network.ts';
import {
  HOST_SWITCH_MODES,
  LAG_LOAD_BALANCING_MODES,
  NETWORK_TYPES,
  NSX_TEAMING_POLICIES,
  RESOURCE_POOL_TYPES,
} from '../vcf/spec-validate.ts';
import type {
  EvcMode,
  IpRange,
  LagSpec,
  NsxtManagerSize,
  NsxtSwitchConfig,
  ResourcePoolSpec,
  TeamingPolicy,
  TeamingSpec,
  TransportZone,
  VcenterStorageSize,
  VcenterVmSize,
  VmnicToUplink,
  VpcSpec,
} from '../vcf/spec-types.ts';
import { DEFAULT_VCF_VERSION } from '../vcf/version.ts';
import { INTERNAL_CLUSTER_CIDRS_V4, INTERNAL_CLUSTER_CIDRS_V6 } from '../vcf/sizing-data.ts';

/** Every control's value by its name: text and selects as strings, checkboxes as booleans. */
export type FormValues = Readonly<Record<string, Json | undefined>>;

// ---------------------------------------------------------------------------
// The repeated groups of controls
// ---------------------------------------------------------------------------

/** The networks with a per-network advanced section, and the plan key each fills. */
export const ADVANCED_NETWORKS = [
  { id: 'mgmt', label: 'Management' },
  { id: 'vmMgmt', label: 'VM management' },
  { id: 'vmotion', label: 'vMotion' },
  { id: 'vsan', label: 'vSAN' },
  { id: 'nfs', label: 'NFS' },
  { id: 'fleet', label: 'Fleet network' },
] as const;
export type AdvancedNetworkId = (typeof ADVANCED_NETWORKS)[number]['id'];

/** The fields of one network's advanced section. `net_<id>_<field>` is the control name. */
export const NETWORK_ADVANCED_FIELDS = [
  'gateway',
  'mtu',
  'portGroup',
  'assignment',
  'teaming',
  'active',
  'standby',
  'ranges',
  'addresses',
] as const;

export const IP_POOLS = [
  { id: 'vcfms', key: 'vcfmsPool', label: 'VCF management services pool' },
  { id: 'automation', key: 'automationPool', label: 'VCF Automation pool' },
  { id: 'tep', key: 'tepPool', label: 'Host TEP pool' },
] as const;

/** Every password the builder asks for, by its `plan.passwords` key. */
export const PASSWORDS: readonly { key: string; label: string; generated: boolean }[] = [
  { key: 'vcenterRoot', label: 'vCenter root', generated: true },
  { key: 'ssoAdmin', label: 'vCenter SSO administrator', generated: true },
  { key: 'nsxRoot', label: 'NSX Manager root', generated: true },
  { key: 'nsxAdmin', label: 'NSX admin', generated: true },
  { key: 'nsxAudit', label: 'NSX audit', generated: true },
  { key: 'sddcManagerRoot', label: 'SDDC Manager root', generated: true },
  { key: 'sddcManagerSsh', label: 'SDDC Manager vcf (SSH) user', generated: true },
  { key: 'sddcManagerLocal', label: 'SDDC Manager local administrator', generated: true },
  { key: 'vspSystem', label: 'VCF management services system user', generated: true },
  { key: 'automationAdmin', label: 'VCF Automation admin', generated: true },
  { key: 'opsRoot', label: 'VCF Operations node root', generated: false },
  { key: 'opsCollectorRoot', label: 'VCF Operations cloud proxy root', generated: false },
];

/** The per-component FQDN overrides, with the short name each is generated from. */
export const FQDN_OVERRIDES: readonly {
  key: keyof NonNullable<DeploymentPlan['fqdnOverrides']>;
  label: string;
  suffix: string;
}[] = [
  { key: 'vcenter', label: 'vCenter', suffix: 'vc01' },
  { key: 'sddcManager', label: 'SDDC Manager', suffix: 'sddcm01' },
  { key: 'nsxVip', label: 'NSX Manager VIP', suffix: 'nsx' },
  { key: 'nsxManager1', label: 'NSX Manager node 1', suffix: 'nsx01' },
  { key: 'nsxManager2', label: 'NSX Manager node 2', suffix: 'nsx02' },
  { key: 'nsxManager3', label: 'NSX Manager node 3', suffix: 'nsx03' },
  { key: 'opsPrimary', label: 'VCF Operations primary node', suffix: 'ops01' },
  { key: 'opsReplica', label: 'VCF Operations replica node', suffix: 'ops02' },
  { key: 'opsData', label: 'VCF Operations data node', suffix: 'ops03' },
  { key: 'opsLoadBalancer', label: 'VCF Operations load balancer', suffix: 'ops' },
  { key: 'opsCollector', label: 'VCF Operations cloud proxy', suffix: 'proxy01' },
  { key: 'licenseServer', label: 'License Server', suffix: 'lic01' },
  { key: 'identityBroker', label: 'Identity Broker', suffix: 'idb01' },
  { key: 'automation', label: 'VCF Automation', suffix: 'auto01' },
  { key: 'automationPlatform', label: 'VCF Automation platform', suffix: 'asr01' },
  { key: 'vspPlatform', label: 'VCF management services platform', suffix: 'msr01' },
  { key: 'vspInstance', label: 'VCF management services instance', suffix: 'int01' },
  { key: 'vspFleet', label: 'VCF management services fleet', suffix: 'flt01' },
];

/** The FQDN the builder generates when no override is given. */
export function generatedFqdn(suffix: string, prefix: string, domain: string): string {
  return `${prefix}-${suffix}.${domain}`.toLowerCase();
}

export const SERVICE_SPECS: readonly { key: ServiceSpecKey; label: string }[] = [
  { key: 'fleetLcm', label: 'Fleet lifecycle (fleetLcmSpec)' },
  { key: 'sddcLcm', label: 'Instance lifecycle (sddcLcmSpec)' },
  { key: 'fleetDepot', label: 'Fleet depot (fleetDepotSpec)' },
  { key: 'telemetryAcceptor', label: 'Telemetry acceptor (telemetryAcceptorSpec)' },
  { key: 'salt', label: 'Salt (saltSpec)' },
  { key: 'saltRaas', label: 'Salt RaaS (saltRaasSpec)' },
];

export const VERSIONED_COMPONENTS: readonly { key: VersionedComponent; label: string }[] = [
  { key: 'vcenter', label: 'vCenter' },
  { key: 'nsx', label: 'NSX' },
  { key: 'sddcManager', label: 'SDDC Manager' },
  { key: 'managementServices', label: 'VCF management services' },
  { key: 'operations', label: 'VCF Operations' },
  { key: 'collector', label: 'VCF Operations cloud proxy' },
  { key: 'automation', label: 'VCF Automation' },
  { key: 'identityBroker', label: 'Identity Broker' },
  { key: 'licenseServer', label: 'License Server' },
  { key: 'fleetLcm', label: 'Fleet lifecycle' },
  { key: 'sddcLcm', label: 'Instance lifecycle' },
  { key: 'fleetDepot', label: 'Fleet depot' },
  { key: 'telemetryAcceptor', label: 'Telemetry acceptor' },
  { key: 'salt', label: 'Salt' },
  { key: 'saltRaas', label: 'Salt RaaS' },
];

/** Existing components beyond the original five, with their control-name stem. */
export const EXISTING_COMPONENTS = [
  { key: 'vcenter', stem: 'existingVcenter', label: 'vCenter' },
  { key: 'nsx', stem: 'existingNsx', label: 'NSX Manager VIP' },
  { key: 'sddcManager', stem: 'existingSddcManager', label: 'SDDC Manager' },
  { key: 'operations', stem: 'existingOps', label: 'VCF Operations master node' },
  { key: 'automation', stem: 'existingAutomation', label: 'VCF Automation' },
  { key: 'licenseServer', stem: 'existingLicense', label: 'License Server' },
  { key: 'collector', stem: 'existingCollector', label: 'VCF Operations cloud proxy' },
  { key: 'managementServices', stem: 'existingVsp', label: 'VCF management services platform' },
] as const;
export type ExistingKey = (typeof EXISTING_COMPONENTS)[number]['key'];

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

/** A grid's column hint and the dropdowns for its closed-set columns (src/ui/multi-editors.ts). */
export interface GridSpec {
  readonly hint: string;
  readonly options: readonly { value: string; label: string; group: string }[];
}

const column = (group: string, values: readonly string[], blank?: string) => [
  ...(blank !== undefined ? [{ value: '', label: blank, group }] : []),
  ...values.map((v) => ({ value: v, label: v, group })),
];

export const DVS_SWITCH_GRID: GridSpec = {
  hint: 'Name | Networks | vmnics | MTU | NSX | Transport zones | Mode | IP assignment | Teaming | Active | Standby | LACP',
  options: [
    ...column('NSX', ['no', 'yes']),
    ...column('Mode', HOST_SWITCH_MODES, 'Default'),
    ...column('Teaming', NSX_TEAMING_POLICIES, 'Default'),
    ...column('LACP', ['yes'], 'No'),
  ],
};

export const ROOT_CA_GRID: GridSpec = {
  hint: 'Alias | Certificate chain',
  options: [],
};

const SHARES_LEVELS = ['low', 'normal', 'high', 'custom'] as const;

export const RESOURCE_POOL_GRID: GridSpec = {
  hint:
    'Name | Type | CPU shares | CPU shares value | CPU reservation % | CPU reservation MHz | CPU limit | CPU expandable | ' +
    'Memory shares | Memory shares value | Memory reservation % | Memory reservation MB | Memory limit | Memory expandable',
  options: [
    ...column('Type', RESOURCE_POOL_TYPES, 'Default'),
    ...column('CPU shares', SHARES_LEVELS, 'Default'),
    ...column('CPU expandable', ['true', 'false'], 'Default'),
    ...column('Memory shares', SHARES_LEVELS, 'Default'),
    ...column('Memory expandable', ['true', 'false'], 'Default'),
  ],
};

/** Rows of a " | " grid, blank rows and comments dropped. */
function gridRows(text: string, columns: number): string[][] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const cells = ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((c) => c.trim());
      return Array.from({ length: columns }, (_, i) => cells[i] ?? '');
    })
    .filter((cells) => cells.some((c) => c !== ''));
}

/** A comma- or whitespace-separated list. */
export function parseList(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `10.0.0.10-10.0.0.20, 10.0.0.30-10.0.0.31` into ranges; a single address is a range of one. */
export function parseIpRanges(text: string | undefined): IpRange[] {
  return (text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [start = '', end] = part.split(/\s*-\s*/);
      return { startIpAddress: start.trim(), endIpAddress: (end ?? start).trim() };
    });
}

/** `vmnic0:uplink1, vmnic1:uplink2`, or plain `vmnic0, vmnic1` mapped to uplink1, uplink2... */
export function parseVmnicMapping(text: string): (VmnicToUplink | string)[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [id = '', uplink] = part.split(/\s*[:=]\s*/);
      return uplink ? { id: id.trim(), uplink: uplink.trim() } : id.trim();
    });
}

/** `name:OVERLAY, name:VLAN`, or a bare `OVERLAY` for an unnamed zone. */
export function parseTransportZones(text: string): TransportZone[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.lastIndexOf(':');
      const type = (at >= 0 ? part.slice(at + 1) : part).trim().toUpperCase();
      const name = at >= 0 ? part.slice(0, at).trim() : '';
      return {
        ...(name ? { name } : {}),
        transportType: type === 'VLAN' ? 'VLAN' : 'OVERLAY',
      } as TransportZone;
    });
}

/**
 * The custom switch grid into `dvsSwitches`.
 *
 * `lacp` is the page's LACP parameters, used by a switch whose LACP cell says
 * yes. Without one, an NSX switch still picks up the plan-level LACP.
 */
export function parseDvsSwitches(text: string, lacp: LacpPlan): CustomDvsPlan[] {
  return gridRows(text, 12).map(
    ([name, networks, vmnics, mtu, nsx, zones, mode, ipAssignment, teaming, active, standby, useLacp]) => {
      const nsxTeaming: NsxTeamingPlan | undefined =
        teaming || active || standby
          ? {
              ...(teaming ? { policy: teaming as TeamingSpec['policy'] } : {}),
              ...(active ? { activeUplinks: parseList(active) } : {}),
              ...(standby ? { standByUplinks: parseList(standby) } : {}),
            }
          : undefined;
      const mtuValue = Number(mtu);
      return {
        ...(name ? { name } : {}),
        ...(networks ? { networks: parseList(networks) } : {}),
        vmnicsToUplinks: parseVmnicMapping(vmnics ?? ''),
        ...(mtu && Number.isFinite(mtuValue) ? { mtu: mtuValue } : {}),
        nsx: nsx === 'yes',
        ...(zones ? { transportZones: parseTransportZones(zones) } : {}),
        ...(mode ? { hostSwitchOperationalMode: mode as NsxtSwitchConfig['hostSwitchOperationalMode'] } : {}),
        ...(ipAssignment ? { ipAssignmentType: ipAssignment } : {}),
        ...(nsxTeaming ? { nsxTeaming } : {}),
        ...(useLacp === 'yes' ? { lacp } : {}),
      };
    },
  );
}

/** `alias | chain1, chain2` rows into `rootCaCerts`. */
export function parseRootCaCerts(text: string): { alias: string; certChain: string[] }[] {
  return gridRows(text, 2).map(([alias = '', chain = '']) => ({
    alias,
    certChain: chain
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  }));
}

/** The resource pool grid into `resourcePools`. Blank cells are left out. */
export function parseResourcePools(text: string): ResourcePoolSpec[] {
  const num = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const flag = (v: string | undefined): boolean | undefined => (v === 'true' ? true : v === 'false' ? false : undefined);
  const put = <T>(key: string, value: T | undefined): Record<string, T> => (value === undefined || value === '' ? {} : { [key]: value });
  return gridRows(text, 14).map((c) => ({
    ...put('name', c[0]),
    ...put('type', c[1]),
    ...put('cpuSharesLevel', c[2]),
    ...put('cpuSharesValue', num(c[3])),
    ...put('cpuReservationPercentage', num(c[4])),
    ...put('cpuReservationMhz', num(c[5])),
    ...put('cpuLimit', num(c[6])),
    ...put('cpuReservationExpandable', flag(c[7])),
    ...put('memorySharesLevel', c[8]),
    ...put('memorySharesValue', num(c[9])),
    ...put('memoryReservationPercentage', num(c[10])),
    ...put('memoryReservationMb', num(c[11])),
    ...put('memoryLimit', num(c[12])),
    ...put('memoryReservationExpandable', flag(c[13])),
  })) as ResourcePoolSpec[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const perNetwork = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const n of ADVANCED_NETWORKS) for (const f of NETWORK_ADVANCED_FIELDS) out[`net_${n.id}_${f}`] = '';
  return out;
};
const perPool = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of IP_POOLS) {
    out[`pool_${p.id}_mode`] = 'range';
    for (const f of ['cidr', 'addresses', 'excluded', 'offset', 'count']) out[`pool_${p.id}_${f}`] = '';
  }
  return out;
};
const keyed = (prefix: string, keys: readonly { key: string }[]): Record<string, string> =>
  Object.fromEntries(keys.map((k) => [`${prefix}${k.key}`, '']));
const existingDefaults = (): Record<string, string> => {
  const out: Record<string, string> = { existingNsxNodes: '', existingDatastoreName: '' };
  for (const c of EXISTING_COMPONENTS) {
    out[`${c.stem}Fqdn`] = '';
    out[`${c.stem}Thumbprint`] = '';
  }
  return out;
};

/**
 * What every control starts with. Placeholders are not defaults: a documentation
 * prefix typed in for someone would end up in a real spec. Secrets are never
 * pre-filled.
 */
export const FORM_DEFAULTS: Readonly<Record<string, string | boolean>> = {
  // instance
  sddcId: 'vcf-m01',
  instanceName: '',
  domainSuffix: 'vcf.lab',
  namePrefix: 'vcf-m01',
  version: DEFAULT_VCF_VERSION,
  scenario: 'new-vcf-fleet',
  documentShape: '',
  skipGatewayPingValidation: false,
  // hosts and services
  esxBase: 'esx',
  hostCount: '4',
  vmnics: 'vmnic0, vmnic1',
  pnicsPerHost: '2',
  dns1: '192.168.30.29',
  dns2: '192.168.30.30',
  ntp1: '192.168.30.1',
  ntp2: '192.168.30.2',
  // networks
  mgmtCidr: '172.30.0.0/24',
  mgmtVlan: '30',
  vmMgmtCidr: '',
  vmMgmtVlan: '30',
  vmotionCidr: '172.30.40.0/24',
  vmotionVlan: '40',
  vsanCidr: '172.30.50.0/24',
  vsanVlan: '50',
  nfsCidr: '172.30.90.0/24',
  nfsVlan: '90',
  tepCidr: '172.30.60.0/24',
  tepVlan: '60',
  tepGateway: '',
  dualStack: false,
  mgmtV6Cidr: '',
  mgmtV6Gateway: '',
  vmMgmtV6Cidr: '',
  vmMgmtV6Gateway: '',
  vmotionV6Cidr: '',
  vmotionV6Gateway: '',
  vsanV6Cidr: '',
  vsanV6Gateway: '',
  nfsV6Cidr: '',
  nfsV6Gateway: '',
  ...perNetwork(),
  // fleet-level components
  managementNetworkModel: 'shared-vlan',
  fleetCidr: '172.30.80.0/24',
  fleetVlan: '80',
  fleetV6Cidr: '',
  fleetV6Gateway: '',
  managementPoolName: '',
  internalClusterCidr: INTERNAL_CLUSTER_CIDRS_V4[0],
  internalClusterCidrIpv6: INTERNAL_CLUSTER_CIDRS_V6[0],
  vcfmsIpv6Pool: '',
  overlaySegment: '',
  overlayMask: '255.255.255.0',
  overlayGateway: '192.168.11.1',
  overlayIpv6Gateway: '',
  localSegment: '',
  localMask: '255.255.255.0',
  localGateway: '192.168.12.1',
  localIpv6Gateway: '',
  ...perPool(),
  // storage and scale
  storage: 'vsan-esa',
  datastoreName: '',
  ftt: '1',
  vsanDedup: false,
  skipHclAutoDiskClaim: false,
  vsanEncryptionInTransit: false,
  vsanRekeyMinutes: '1440',
  nfsServers: '',
  nfsPath: '/export/vcf',
  nfsUserTag: '',
  nfsReadOnly: false,
  nfsBindToVmknic: false,
  vmfsDatastoreNames: '',
  sizePreset: '',
  profile: 'simple',
  vcenterSize: '',
  vcenterStorageSize: '',
  nsxSize: '',
  nsxManagerCount: '',
  opsSize: '',
  opsNodeCount: '',
  opsLoadBalancer: '',
  collectorSize: '',
  vspSize: '',
  automationSize: '',
  evcMode: '',
  datacenterName: '',
  clusterName: '',
  resourcePools: '',
  // switching and NSX
  dvsProfile: 'default',
  dvsMtu: '9000',
  dvsSwitches: '',
  hostSwitchOperationalMode: '',
  nsxTeamingPolicy: '',
  nsxActiveUplinks: '',
  nsxStandbyUplinks: '',
  enableLacp: false,
  lacpName: '',
  lacpUplinksCount: '2',
  lacpMode: 'ACTIVE',
  lacpTimeoutMode: 'FAST',
  lacpLoadBalancingMode: 'SOURCE_AND_DESTINATION_IP',
  tepLess: false,
  tepMode: 'static',
  tepPoolName: '',
  ignoreUnavailableNsxtCluster: false,
  skipNsxOverlayOverManagementNetwork: '',
  enableEdgeClusterSync: true,
  vpcMode: '',
  dtgwVlan: '70',
  dtgwGatewayCidr: '172.30.70.1/24',
  dtgwExternalCidr: '172.30.70.0/26',
  dtgwPrivateCidr: '172.31.0.0/16',
  // components
  esxiCertsMode: '',
  rootCaCerts: '',
  ceipEnabled: false,
  includeOperations: true,
  includeAutomation: true,
  includeManagementServices: true,
  includeIdentityBroker: true,
  identityBrokerModel: '',
  identityBrokerSize: '',
  includeLicenseServer: true,
  vcenterSsoDomain: '',
  vcenterSsoUsername: '',
  automationNodePrefix: '',
  automationInternalClusterCidr: '',
  vspName: '',
  includeFleetServiceSpecs: true,
  ...keyed('size_', SERVICE_SPECS),
  ...keyed('ver_', VERSIONED_COMPONENTS),
  ...keyed('fqdn_', FQDN_OVERRIDES),
  brownfield: false,
  ...existingDefaults(),
  // secrets: never pre-filled, never saved
  autoGeneratePasswords: false,
  esxRootPassword: '',
  password_opsAdmin: '',
  ...keyed('password_', PASSWORDS),
  redact: false,
};

/** Control names that hold a secret; the settings file never carries them. */
export function isSecretControl(name: string): boolean {
  return name.startsWith('password_') || name === 'esxRootPassword';
}

/** Rename fields saved by an earlier version of the page. */
export function migrateFields(fields: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = { ...fields };
  if ('enableVpc' in out) {
    if (!('vpcMode' in out)) out.vpcMode = out.enableVpc === true ? 'full-distributed' : '';
    delete out.enableVpc;
  }
  return out;
}

// ---------------------------------------------------------------------------
// What the scenario shows
// ---------------------------------------------------------------------------

export interface ScenarioView {
  /** Per existing component: whether its FQDN and thumbprint apply to this scenario. */
  readonly existing: Readonly<Record<ExistingKey, boolean>>;
  /** Whether the existing-components block shows at all. */
  readonly anyExisting: boolean;
  readonly existingDatastore: boolean;
  /** The License Server's presence is the plan's choice (the * footnote). */
  readonly licenseServerOptional: boolean;
  /** The Identity Broker appears at all. */
  readonly identityBroker: boolean;
  /** Its presence is the plan's choice. */
  readonly identityBrokerOptional: boolean;
  /** NSX takes part. */
  readonly nsx: boolean;
  /** NSX may already exist (converge), so the brownfield NSX flags apply. */
  readonly nsxMayExist: boolean;
  /** VCF Automation takes part. */
  readonly automation: boolean;
  /** VCF management services take part (or may). */
  readonly managementServices: boolean;
  /** A further instance: the existing VCF Operations admin password is required. */
  readonly existingOpsAdminPassword: boolean;
  /** The document shape the builder uses when none is chosen. */
  readonly defaultShape: 'full' | 'minimal';
}

const can = (cell: ScenarioRule['vcenterExisting']): boolean => cell === 'true' || cell === 'either';

/**
 * Which blocks of the form apply to a scenario.
 *
 * Existing components follow Broadcom's table: a component is offered as
 * existing only where the scenario's row allows it (true or true/false), plus
 * the few the table does not name — SDDC Manager for deferred components, the
 * License Server where the existing VCF Operations may already have one, the
 * cloud proxy wherever VCF Operations is reused, and VCF management services
 * where a converged vCenter may already run them.
 */
export function scenarioView(scenario: DeploymentScenario, brownfield = false): ScenarioView {
  const rule = scenarioRule(scenario);
  const vvf = rule.workflowType === 'VVF';
  const vcenter = can(rule.vcenterExisting) || brownfield;
  const operations = can(rule.operationsExisting);
  const existing: Record<ExistingKey, boolean> = {
    vcenter,
    nsx: !vvf && can(rule.nsxExisting),
    sddcManager: scenario === 'deferred-components',
    operations,
    automation: !vvf && can(rule.automationExisting),
    licenseServer: rule.conditionalPresence?.includes('licenseServer') ?? false,
    collector: operations && scenario !== 'vvf-management-services',
    managementServices:
      rule.vcenterExisting === 'true' && can(rule.managementServices) && scenario !== 'vvf-management-services',
  };
  const minimal = scenario === 'deferred-components' || scenario === 'vvf-management-services';
  return {
    existing,
    anyExisting: Object.values(existing).some(Boolean),
    existingDatastore: vcenter,
    licenseServerOptional: rule.conditionalPresence?.includes('licenseServer') ?? false,
    identityBroker: rule.identityBroker !== 'na' && rule.identityBroker !== 'false',
    identityBrokerOptional:
      rule.identityBroker === 'either' || (rule.conditionalPresence?.includes('identityBroker') ?? false),
    nsx: !vvf && !minimal,
    nsxMayExist: !vvf && can(rule.nsxExisting),
    automation: !vvf,
    managementServices: rule.managementServices === 'true' || rule.managementServices === 'either',
    existingOpsAdminPassword: rule.workflowType === 'VCF_EXTEND',
    defaultShape: minimal ? 'minimal' : 'full',
  };
}

// ---------------------------------------------------------------------------
// Values into a plan
// ---------------------------------------------------------------------------

/** The page's LACP parameters, with every field the plan's LacpPlan takes. */
function lacpFrom(v: Reader): LacpPlan {
  const count = v.num('lacpUplinksCount');
  return {
    ...(v.str('lacpName') ? { name: v.str('lacpName') } : {}),
    uplinksCount: count !== undefined && count > 0 ? count : 2,
    lacpMode: (v.str('lacpMode') || 'ACTIVE') as LagSpec['lacpMode'],
    lacpTimeoutMode: (v.str('lacpTimeoutMode') || 'FAST') as LagSpec['lacpTimeoutMode'],
    loadBalancingMode: (v.str('lacpLoadBalancingMode') || 'SOURCE_AND_DESTINATION_IP') as LagSpec['loadBalancingMode'],
  };
}

interface Reader {
  str(key: string): string;
  bool(key: string): boolean;
  /** A number, or undefined when blank or not a number. */
  num(key: string): number | undefined;
}

function reader(values: FormValues): Reader {
  const raw = (key: string): Json | undefined => (key in values ? values[key] : FORM_DEFAULTS[key]);
  return {
    str: (key) => {
      const value = raw(key);
      return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
    },
    bool: (key) => raw(key) === true,
    num: (key) => {
      const value = raw(key);
      if (value === '' || value === undefined || value === null) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    },
  };
}

/** A network whose gateway or MTU came from an estate keeps it while its subnet is unchanged. */
function keep(from: NetworkPlan | undefined, cidr: string, vlanId: number): NetworkPlan {
  return from && from.cidr === cidr ? { ...from, cidr, vlanId } : { cidr, vlanId };
}

/** The advanced section of one network, as the NetworkPlan fields it sets. Blank fields are left out. */
export function networkAdvanced(values: FormValues, id: AdvancedNetworkId): Partial<NetworkPlan> {
  const v = reader(values);
  const f = (field: string): string => v.str(`net_${id}_${field}`);
  const mtu = v.num(`net_${id}_mtu`);
  const ranges = parseIpRanges(f('ranges'));
  const addresses = parseList(f('addresses'));
  const active = parseList(f('active'));
  const standby = parseList(f('standby'));
  return {
    ...(f('gateway') ? { gateway: f('gateway') } : {}),
    ...(mtu !== undefined ? { mtu } : {}),
    ...(f('portGroup') ? { portGroupName: f('portGroup') } : {}),
    ...(f('assignment') ? { assignmentMode: f('assignment') as NetworkPlan['assignmentMode'] } : {}),
    ...(f('teaming') ? { teamingPolicy: f('teaming') as TeamingPolicy } : {}),
    ...(active.length ? { activeUplinks: active } : {}),
    ...(standby.length ? { standbyUplinks: standby } : {}),
    ...(ranges.length ? { ipRanges: ranges } : {}),
    ...(addresses.length ? { ipAddresses: addresses } : {}),
  };
}

/** One IP pool's controls merged over what sizing supplied; untouched controls leave sizing's pool alone. */
function poolFrom(v: Reader, id: string, inherited: PoolPlan | undefined): PoolPlan | undefined {
  const mode = v.str(`pool_${id}_mode`) || 'range';
  const cidr = v.str(`pool_${id}_cidr`);
  const addresses = parseList(v.str(`pool_${id}_addresses`));
  const excluded = parseList(v.str(`pool_${id}_excluded`));
  const offset = v.num(`pool_${id}_offset`);
  const count = v.num(`pool_${id}_count`);
  const touched = mode !== 'range' || cidr || addresses.length || excluded.length || offset !== undefined || count !== undefined;
  if (!touched) return inherited;
  return {
    ...inherited,
    mode: mode as PoolPlan['mode'],
    ...(cidr ? { cidr } : {}),
    ...(addresses.length ? { addresses } : {}),
    ...(excluded.length ? { excludedAddresses: excluded } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

/** The `existing` block: only the components the scenario can reuse, and only those named. */
export function existingFrom(values: FormValues): Pick<DeploymentPlan, 'existing'> | undefined {
  const v = reader(values);
  const scenario = (v.str('scenario') || 'new-vcf-fleet') as DeploymentScenario;
  const rule = scenarioRule(scenario);
  const view = scenarioView(scenario, v.bool('brownfield'));
  const out: Record<string, ExistingComponent | string> = {};
  for (const c of EXISTING_COMPONENTS) {
    if (!view.existing[c.key]) continue;
    const fqdn = v.str(`${c.stem}Fqdn`);
    const sslThumbprint = v.str(`${c.stem}Thumbprint`);
    const nodes = c.key === 'nsx' ? parseList(v.str('existingNsxNodes')) : [];
    if (fqdn) {
      out[c.key] = {
        fqdn,
        ...(sslThumbprint ? { sslThumbprint } : {}),
        ...(nodes.length ? { nodeFqdns: nodes } : {}),
      };
    } else if (c.key === 'vcenter' && (v.bool('brownfield') || rule.vcenterExisting === 'true')) {
      // The scenario fixes vCenter as existing even when nothing was typed;
      // declaring it keeps the builder's mismatch finding accurate.
      out.vcenter = { fqdn: '', ...(sslThumbprint ? { sslThumbprint } : {}) };
    }
  }
  const datastoreName = view.existingDatastore ? v.str('existingDatastoreName') : '';
  if (datastoreName) out.datastoreName = datastoreName;
  return Object.keys(out).length ? { existing: out as DeploymentPlan['existing'] } : undefined;
}

/**
 * Assemble the plan from the form's values.
 *
 * `hosts` is the host table's rows; `inherited` is what a sizing or estate
 * handoff supplied that no control represents (the IP pool counts above all),
 * which every control overrides.
 */
export function planFromForm(
  values: FormValues,
  hosts: readonly HostEntry[] = [],
  inherited: Partial<DeploymentPlan> = {},
): DeploymentPlan {
  const v = reader(values);
  const num = (key: string, fallback: number): number => v.num(key) ?? fallback;
  const list = (key: string): string[] => parseList(v.str(key));
  const opt = <K extends string, T>(key: K, value: T | undefined | '' | false): Partial<Record<K, T>> =>
    value === undefined || value === '' || value === false ? {} : ({ [key]: value } as Record<K, T>);

  const storage = (v.str('storage') || 'vsan-esa') as DeploymentPlan['storage'];
  const vsanSelected = storage === 'vsan-esa' || storage === 'vsan-osa';
  const scenario = (v.str('scenario') || 'new-vcf-fleet') as DeploymentScenario;
  const rule = scenarioRule(scenario);
  const view = scenarioView(scenario, v.bool('brownfield'));
  const model = managementNetworkModel((v.str('managementNetworkModel') || 'shared-vlan') as ManagementNetworkModel);
  const dual = v.bool('dualStack');
  const preset = v.str('sizePreset') as SizePreset | '';

  // The IPv6 side of a network. Always written, so an IPv6 prefix inherited
  // from the estate is dropped once the field is cleared or dual stack is off.
  const v6 = (cidrKey: string, gatewayKey: string): Partial<NetworkPlan> => {
    const c = v.str(cidrKey);
    const g = v.str(gatewayKey);
    return dual && c ? { ipv6Cidr: c, ipv6Gateway: g || undefined } : { ipv6Cidr: undefined, ipv6Gateway: undefined };
  };
  // "2001:db8:11::1/64" into the API's separate ipv6Gateway and ipv6Prefix.
  const v6GatewayPrefix = (key: string): { ipv6Gateway?: string; ipv6Prefix?: number } => {
    const [gateway = '', prefix] = v.str(key).split('/');
    if (!dual || !gateway) return {};
    return { ipv6Gateway: gateway, ...(prefix !== undefined ? { ipv6Prefix: Number(prefix) } : {}) };
  };
  const adv = (id: AdvancedNetworkId): Partial<NetworkPlan> => networkAdvanced(values, id);

  // Blank takes a range from the IPv6 prefix of the network the services live
  // on; a CIDR or an address list is used as typed.
  const vcfmsV6 = v.str('vcfmsIpv6Pool');
  const vcfmsIpv6Pool: DeploymentPlan['vcfmsIpv6Pool'] =
    dual && vcfmsV6
      ? vcfmsV6.includes('/')
        ? { mode: 'cidr', cidr: vcfmsV6 }
        : { mode: 'addresses', addresses: parseList(vcfmsV6) }
      : undefined;

  const management: NetworkPlan = {
    ...keep(inherited.management, v.str('mgmtCidr'), num('mgmtVlan', 30)),
    ...v6('mgmtV6Cidr', 'mgmtV6Gateway'),
    ...adv('mgmt'),
  };
  // VM management takes its own addressing when a CIDR is given; otherwise its
  // advanced settings (a port group name above all, for a converged vCenter)
  // apply on the management addressing.
  const vmMgmtAdv = adv('vmMgmt');
  const vmManagement: NetworkPlan | undefined = v.str('vmMgmtCidr')
    ? { cidr: v.str('vmMgmtCidr'), vlanId: num('vmMgmtVlan', 30), ...v6('vmMgmtV6Cidr', 'vmMgmtV6Gateway'), ...vmMgmtAdv }
    : Object.keys(vmMgmtAdv).length
      ? { cidr: management.cidr, vlanId: management.vlanId, ...v6('mgmtV6Cidr', 'mgmtV6Gateway'), ...vmMgmtAdv }
      : undefined;

  const lacp = lacpFrom(v);
  const dvsProfile = (v.str('dvsProfile') || 'default') as DvsProfile;
  const dvsSwitches = dvsProfile === 'custom' ? parseDvsSwitches(v.str('dvsSwitches'), lacp) : [];
  const nsxTeaming: NsxTeamingPlan | undefined =
    v.str('nsxTeamingPolicy') || v.str('nsxActiveUplinks') || v.str('nsxStandbyUplinks')
      ? {
          ...opt('policy', v.str('nsxTeamingPolicy') as TeamingSpec['policy']),
          ...(list('nsxActiveUplinks').length ? { activeUplinks: list('nsxActiveUplinks') } : {}),
          ...(list('nsxStandbyUplinks').length ? { standByUplinks: list('nsxStandbyUplinks') } : {}),
        }
      : undefined;

  // VPC: Full Stack with Distributed connectivity carries a DTGW; Full Stack
  // with Centralized connectivity has none; VLAN-backed implies TEP-less.
  const vpcMode = v.str('vpcMode');
  const vpcType: VpcSpec['vpcNetworkConfigurationType'] | undefined =
    vpcMode === 'vlan-backed' ? 'VLAN_BACKED_VPC' : vpcMode ? 'FULL_STACK_VPC' : undefined;

  const fqdnOverrides: Record<string, string> = {};
  for (const o of FQDN_OVERRIDES) {
    const value = v.str(`fqdn_${o.key}`);
    if (value) fqdnOverrides[o.key] = value.toLowerCase();
  }
  const serviceSizes: Record<string, string> = {};
  for (const s of SERVICE_SPECS) if (v.str(`size_${s.key}`)) serviceSizes[s.key] = v.str(`size_${s.key}`);
  const componentVersions: Record<string, string> = {};
  for (const c of VERSIONED_COMPONENTS) if (v.str(`ver_${c.key}`)) componentVersions[c.key] = v.str(`ver_${c.key}`);
  const passwords: Record<string, string> = { ...(inherited.passwords ?? {}) };
  for (const p of PASSWORDS) if (v.str(`password_${p.key}`)) passwords[p.key] = v.str(`password_${p.key}`);
  if (v.str('password_opsAdmin')) passwords.opsAdmin = v.str('password_opsAdmin');

  const vcfmsPool = poolFrom(v, 'vcfms', inherited.vcfmsPool);
  const automationPool = poolFrom(v, 'automation', inherited.automationPool);
  const tepPool = poolFrom(v, 'tep', inherited.tepPool);
  const rootCaCerts = parseRootCaCerts(v.str('rootCaCerts'));
  const resourcePools = parseResourcePools(v.str('resourcePools'));
  const tepMode = (v.str('tepMode') || 'static') as NonNullable<DeploymentPlan['tepMode']>;
  const overlaySegment = v.str('overlaySegment');
  const opsLb = v.str('opsLoadBalancer');
  const existing = existingFrom(values);
  const skipOverlay = v.str('skipNsxOverlayOverManagementNetwork');

  return {
    ...inherited,
    // --- identity
    sddcId: v.str('sddcId') || 'vcf-m01',
    vcfInstanceName: v.str('instanceName') || undefined,
    domainSuffix: v.str('domainSuffix') || 'vcf.lab',
    namePrefix: v.str('namePrefix') || undefined,
    version: v.str('version') || DEFAULT_VCF_VERSION,
    scenario,
    // A further instance joins an existing fleet; the scenario decides that,
    // so the two can no longer disagree.
    instanceRole: rule.workflowType === 'VCF_EXTEND' ? 'secondary' : 'primary',
    ...opt('documentShape', v.str('documentShape') as DeploymentPlan['documentShape']),
    skipGatewayPingValidation: v.bool('skipGatewayPingValidation'),

    // --- hosts and services
    esxHostnameBase: v.str('esxBase') || 'esx',
    hostCount: Math.max(1, num('hostCount', 4)),
    hosts: [...hosts],
    ...opt('esxRootPassword', v.str('esxRootPassword')),
    dnsServers: [v.str('dns1'), v.str('dns2')].filter(Boolean),
    ntpServers: [v.str('ntp1'), v.str('ntp2')].filter(Boolean),
    pnicsPerHost: Math.max(1, num('pnicsPerHost', 2)),

    // --- networks
    management,
    ...(vmManagement ? { vmManagement } : { vmManagement: inherited.vmManagement }),
    vmotion: {
      ...keep(inherited.vmotion, v.str('vmotionCidr'), num('vmotionVlan', 40)),
      ...v6('vmotionV6Cidr', 'vmotionV6Gateway'),
      ...adv('vmotion'),
    },
    ...(vsanSelected
      ? {
          vsan: {
            ...keep(inherited.vsan, v.str('vsanCidr'), num('vsanVlan', 50)),
            ...v6('vsanV6Cidr', 'vsanV6Gateway'),
            ...adv('vsan'),
          },
        }
      : { vsan: undefined }),
    ...(storage === 'nfs' && v.str('nfsCidr')
      ? {
          nfs: {
            ...keep(inherited.nfs, v.str('nfsCidr'), num('nfsVlan', 90)),
            ...v6('nfsV6Cidr', 'nfsV6Gateway'),
            ...adv('nfs'),
          },
        }
      : { nfs: undefined }),
    hostTep: { cidr: v.str('tepCidr'), vlanId: num('tepVlan', 60), ...opt('gateway', v.str('tepGateway')) },
    dualStack: dual,
    ...(dual ? { internalClusterCidrIpv6: v.str('internalClusterCidrIpv6') } : {}),
    ...(vcfmsIpv6Pool ? { vcfmsIpv6Pool } : {}),

    // --- fleet-level components
    managementNetworkModel: model.model,
    ...(model.requiresDedicatedNetwork && v.str('fleetCidr')
      ? {
          fleetManagement: {
            cidr: v.str('fleetCidr'),
            vlanId: num('fleetVlan', 80),
            ...v6('fleetV6Cidr', 'fleetV6Gateway'),
            ...adv('fleet'),
          },
        }
      : {}),
    // The network the fleet-level components are placed on
    // (xRegionNetwork): the NSX segment of the overlay models, or any named
    // port group. Blank on a non-overlay model lets the builder derive it.
    ...(overlaySegment
      ? {
          managementComponentNetworks: {
            xRegion: {
              networkName: overlaySegment,
              subnetMask: v.str('overlayMask'),
              gateway: v.str('overlayGateway'),
              ...v6GatewayPrefix('overlayIpv6Gateway'),
            },
            // The stretched model spans two regions, so the cross-region
            // segment is joined by a region-local one.
            ...(model.stretched && v.str('localSegment')
              ? {
                  local: {
                    networkName: v.str('localSegment'),
                    subnetMask: v.str('localMask'),
                    gateway: v.str('localGateway'),
                    ...v6GatewayPrefix('localIpv6Gateway'),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...opt('managementPoolName', v.str('managementPoolName')),
    internalClusterCidr: v.str('internalClusterCidr') || INTERNAL_CLUSTER_CIDRS_V4[0],
    ...opt('vcfmsPool', vcfmsPool),
    ...opt('automationPool', automationPool),
    ...opt('tepPool', tepPool),

    // --- storage
    storage,
    failuresToTolerate: num('ftt', 1),
    ...opt('datastoreName', v.str('datastoreName')),
    ...(vsanSelected
      ? {
          vsanDedup: v.bool('vsanDedup'),
          skipHclAutoDiskClaim: v.bool('skipHclAutoDiskClaim'),
          vsanEncryptionInTransit: v.bool('vsanEncryptionInTransit'),
          ...(v.bool('vsanEncryptionInTransit') ? { vsanRekeyIntervalMinutes: num('vsanRekeyMinutes', 1440) } : {}),
        }
      : {}),
    ...(storage === 'nfs'
      ? {
          nfsServers: list('nfsServers'),
          nfsPath: v.str('nfsPath'),
          nfsReadOnly: v.bool('nfsReadOnly'),
          ...opt('nfsUserTag', v.str('nfsUserTag')),
          nfsBindToVmknic: v.bool('nfsBindToVmknic'),
        }
      : {}),
    ...(storage === 'vmfs-fc' ? { vmfsDatastoreNames: list('vmfsDatastoreNames') } : {}),

    // --- scale: the preset sets everything; each field below still overrides it
    ...opt('sizePreset', preset || undefined),
    profile: (v.str('profile') || 'simple') as 'simple' | 'ha',
    ...opt('vcenterSize', v.str('vcenterSize') as VcenterVmSize),
    ...opt('vcenterStorageSize', v.str('vcenterStorageSize') as VcenterStorageSize),
    ...opt('nsxManagerSize', v.str('nsxSize') as NsxtManagerSize),
    ...opt('nsxManagerCount', v.num('nsxManagerCount') as 1 | 3 | undefined),
    ...opt('opsSize', v.str('opsSize') as DeploymentPlan['opsSize']),
    ...opt('opsNodeCount', v.num('opsNodeCount') as 1 | 2 | 3 | undefined),
    ...(opsLb ? { opsLoadBalancer: opsLb === 'true' } : {}),
    ...opt('collectorSize', v.str('collectorSize') as DeploymentPlan['collectorSize']),
    ...opt('vspSize', v.str('vspSize') as DeploymentPlan['vspSize']),
    ...opt('automationSize', v.str('automationSize')),
    ...opt('evcMode', v.str('evcMode') as EvcMode),
    ...opt('datacenterName', v.str('datacenterName')),
    ...opt('clusterName', v.str('clusterName')),
    ...(resourcePools.length ? { resourcePools } : {}),

    // --- switching
    dvsProfile,
    vmnics: list('vmnics'),
    dvsMtu: num('dvsMtu', 9000),
    ...(dvsSwitches.length ? { dvsSwitches } : { dvsSwitches: undefined }),
    ...(v.bool('enableLacp') ? { lacp } : {}),
    ...opt('nsxTeaming', nsxTeaming),
    ...opt(
      'hostSwitchOperationalMode',
      v.str('hostSwitchOperationalMode') as NsxtSwitchConfig['hostSwitchOperationalMode'],
    ),

    // --- NSX and VPC
    tepLess: v.bool('tepLess'),
    tepMode,
    ...(tepMode !== 'dhcp' ? opt('tepPoolName', v.str('tepPoolName')) : {}),
    ...(v.bool('ignoreUnavailableNsxtCluster') ? { ignoreUnavailableNsxtCluster: true } : {}),
    ...(skipOverlay ? { skipNsxOverlayOverManagementNetwork: skipOverlay === 'true' } : {}),
    // Existing NSX only; the builder ignores it otherwise.
    ...(view.nsxMayExist && existing?.existing?.nsx ? { enableEdgeClusterSync: v.bool('enableEdgeClusterSync') } : {}),
    ...opt('vpcNetworkConfigurationType', vpcType),
    ...(vpcMode === 'full-distributed'
      ? {
          dtgw: {
            vlan: num('dtgwVlan', 70),
            gatewayCidr: v.str('dtgwGatewayCidr'),
            externalIpBlockCidr: v.str('dtgwExternalCidr'),
            ...opt('privateTgwIpBlockCidr', v.str('dtgwPrivateCidr')),
          },
        }
      : {}),

    // --- security
    ...opt('esxiCertsMode', v.str('esxiCertsMode') as 'Custom' | 'VMCA'),
    ...(rootCaCerts.length ? { rootCaCerts } : {}),
    ceipEnabled: v.bool('ceipEnabled'),

    // --- components
    includeOperations: v.bool('includeOperations'),
    // vSphere Foundation has no VCF Automation at all.
    includeAutomation: view.automation && v.bool('includeAutomation'),
    includeManagementServices: v.bool('includeManagementServices'),
    includeIdentityBroker: v.bool('includeIdentityBroker'),
    // Where the broker is mandatory it is the Instance model; the choice exists
    // only where the scenario leaves the broker optional.
    ...(view.identityBrokerOptional
      ? opt('identityBrokerModel', v.str('identityBrokerModel') as DeploymentPlan['identityBrokerModel'])
      : {}),
    ...(view.identityBroker
      ? opt('identityBrokerSize', v.str('identityBrokerSize') as DeploymentPlan['identityBrokerSize'])
      : {}),
    ...(view.licenseServerOptional ? { includeLicenseServer: v.bool('includeLicenseServer') } : {}),
    ...opt('vcenterSsoDomain', v.str('vcenterSsoDomain')),
    ...opt('vcenterSsoUsername', v.str('vcenterSsoUsername')),
    ...(view.automation ? opt('automationNodePrefix', v.str('automationNodePrefix').toLowerCase()) : {}),
    ...(view.automation ? opt('automationInternalClusterCidr', v.str('automationInternalClusterCidr')) : {}),
    ...(view.managementServices ? opt('vspName', v.str('vspName')) : {}),
    includeFleetServiceSpecs: v.bool('includeFleetServiceSpecs'),
    ...(Object.keys(serviceSizes).length ? { serviceSizes } : {}),
    ...(Object.keys(componentVersions).length ? { componentVersions } : {}),
    ...(Object.keys(fqdnOverrides).length ? { fqdnOverrides } : {}),

    // --- brownfield
    ...(existing ?? {}),

    // --- secrets
    autoGeneratePasswords: v.bool('autoGeneratePasswords'),
    ...(Object.keys(passwords).length ? { passwords } : {}),
  };
}

/** The values an untouched page holds for a scenario, with the scenario's fixed toggles applied. */
export function defaultValues(scenario: DeploymentScenario): Record<string, Json> {
  const rule = scenarioRule(scenario);
  const out: Record<string, Json> = { ...FORM_DEFAULTS, scenario };
  const fixed = (key: string, cell: ScenarioRule['managementServices']): void => {
    if (cell !== 'either') out[key] = cell === 'true';
  };
  fixed('includeManagementServices', rule.managementServices);
  if (!(rule.conditionalPresence?.includes('identityBroker') ?? false)) fixed('includeIdentityBroker', rule.identityBroker);
  if (rule.workflowType === 'VVF') out.includeAutomation = false;
  return out;
}

/** The label of each preset, for the dropdown. */
export const SIZE_PRESET_OPTIONS: readonly { value: SizePreset; label: string }[] = (
  Object.keys(SIZE_PRESETS) as SizePreset[]
).map((key) => {
  const p = SIZE_PRESETS[key];
  return {
    value: key,
    label: `${p.label}: vCenter ${p.vcenterSize}, NSX ${p.nsxManagerCount} × ${p.nsxManagerSize}, Operations ${p.opsNodeCount} × ${p.opsSize}, cloud proxy ${p.collectorSize}, Automation ${p.automationSize}, services ${p.vspSize}`,
  };
});

/** The LAG load-balancing modes, all twenty. */
export const LAG_MODES = LAG_LOAD_BALANCING_MODES;
/** The traffic types a switch or network can carry (custom names are also accepted). */
export const TRAFFIC_TYPES = NETWORK_TYPES;

/**
 * The size line under the output's summary. A minimal document (deferred
 * components, VCF management services for VVF) has no hostSpecs, networkSpecs
 * or dnsSpec at all, which is said rather than counted as zero.
 */
export function specSummary(spec: {
  readonly hostSpecs?: readonly unknown[];
  readonly networkSpecs?: readonly unknown[];
  readonly dnsSpec?: unknown;
}): string {
  if (!spec.hostSpecs && !spec.networkSpecs && !spec.dnsSpec) return 'Minimal document: no hosts, networks or DNS';
  return `${spec.hostSpecs?.length ?? 0} hosts, ${spec.networkSpecs?.length ?? 0} networks`;
}

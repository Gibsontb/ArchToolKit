/**
 * `SddcSpec` generation from a deployment plan.
 *
 * Takes the handful of decisions an architect actually makes — naming, subnets,
 * VLANs, storage, scale, greenfield or brownfield — and derives a complete VCF
 * 9.1 specification, including the components the existing public builders omit
 * entirely: `vspClusterSpec`, `vidbSpec`, `licenseServerSpec`, the fleet
 * services, VPC/DTGW, and LACP.
 *
 * Secrets are never invented. Any password the plan does not supply is emitted
 * as a placeholder that validation then flags, so a spec can be reviewed and
 * shared safely before credentials are added.
 */

import {
  parseCidr,
  parseIPv4,
  formatIPv4,
  allocateRange,
  usableRange,
  prefixToMask,
  type Cidr,
} from '../core/net.ts';
import { familyOf, isIp, containsAny } from '../core/ip.ts';
import { parseCidr6, bigToV6, compressIPv6, type Cidr6 } from '../core/net-calc.ts';
import { error, warning, info, type Finding } from '../core/findings.ts';
import {
  DEFAULT_MTU,
  VCFMS_RECOMMENDED_IPS,
  INTERNAL_CLUSTER_CIDRS_V4,
} from './sizing-data.ts';
import {
  DEFAULT_VCF_VERSION,
  automationIpCount,
  compareVcfVersion,
  defaultApplianceSize,
} from './version.ts';
import { PLACEHOLDER_SECRET } from './spec-types.ts';
import type {
  SddcSpec,
  SddcNetworkSpec,
  SddcHostSpec,
  DvsSpec,
  SddcNsxtSpec,
  SddcVspClusterSpec,
  VcfOperationsSpec,
  VcfAutomationSpec,
  SddcDatastoreSpec,
  VmnicToUplink,
  LagSpec,
  VpcSpec,
  NsxtManagerSize,
  VcenterVmSize,
  WorkflowType,
  NetworkType,
  EvcMode,
  ResourcePoolSpec,
  SecuritySpec,
  TeamingPolicy,
  IPv4Pool,
  IPv6Pool,
  VcfManagementComponentsInfrastructureSpec,
  VcfManagementComponentsNetworkSpec,
  VcfOperationsNode,
  VcfOperationsCollectorSpec,
  LicenseServerSpec,
  VidbSpec,
  SddcVcenterSpec,
  SddcManagerSpec,
  TeamingSpec,
  TransportZone,
  NsxtSwitchConfig,
  IpRange,
  VcenterStorageSize,
} from './spec-types.ts';
import {
  MANAGEMENT_NETWORK_MODELS,
  managementNetworkModel,
  CLOUD_PROXY_ALWAYS_VM_MANAGEMENT,
  type ManagementNetworkModel,
} from './management-network.ts';
import {
  SCENARIO_RULES,
  scenarioRule,
  resolveFlag,
  componentTakesPart,
  VVF_WITHOUT_MANAGEMENT_SERVICES_PREREQUISITE,
  type DeploymentScenario,
} from './scenarios.ts';




export { PLACEHOLDER_SECRET };

export interface NetworkPlan {
  /** CIDR, e.g. "172.30.0.0/24". */
  readonly cidr: string;
  readonly vlanId: number;
  /** Defaults to the first usable address in the CIDR. */
  readonly gateway?: string;
  readonly mtu?: number;
  /**
   * IPv6 prefix for a dual-stack or IPv6-only network.
   *
   * The API has no separate v6 fields on SddcNetworkSpec: an IPv6 network sets
   * ipAddressVersion to IPv6 and reuses subnet/gateway with v6 values. Supplying
   * this emits a second network entry for the same traffic type.
   */
  readonly ipv6Cidr?: string;
  readonly ipv6Gateway?: string;
  /** Per-traffic teaming, matching the wizard's per-traffic-type controls. */
  readonly teamingPolicy?: TeamingPolicy;
  readonly activeUplinks?: string[];
  readonly standbyUplinks?: string[];
  readonly assignmentMode?: 'STATIC' | 'DHCP' | 'SLAAC';
  /**
   * Distributed port group name (`portGroupKey`, max 80 characters). Defaults
   * to `<prefix>-pg-<traffic>`. When the vCenter already exists this must be
   * the name of the port group that is really there.
   */
  readonly portGroupName?: string;
  /**
   * Explicit static ranges for the host VMkernel addresses (vMotion, vSAN,
   * NFS). Replaces the default range carved at a fixed offset.
   */
  readonly ipRanges?: readonly IpRange[];
  /** Explicit individual host VMkernel addresses (`includeIpAddress`). */
  readonly ipAddresses?: readonly string[];
}

/** Uplink teaming for the NSX host switch (`dvsSpecs[].nsxTeamings[0]`). */
export interface NsxTeamingPlan {
  /** Default LOADBALANCE_SRCID. */
  readonly policy?: TeamingSpec['policy'];
  /** Default: every uplink of the switch not listed as standby. */
  readonly activeUplinks?: readonly string[];
  readonly standByUplinks?: readonly string[];
}

/** LACP link aggregation for one switch. Every field has a default. */
export interface LacpPlan {
  /** Max 16 characters. Default `<prefix>-lag01`. */
  readonly name?: string;
  /** Default 2. */
  readonly uplinksCount?: number;
  /** Default ACTIVE. */
  readonly lacpMode?: LagSpec['lacpMode'];
  /** Default FAST. */
  readonly lacpTimeoutMode?: LagSpec['lacpTimeoutMode'];
  /** Default SOURCE_AND_DESTINATION_IP. */
  readonly loadBalancingMode?: LagSpec['loadBalancingMode'];
}

/**
 * One distributed switch of a custom layout (the wizard's "Custom Switch
 * Configuration"). Nothing is split or inferred: the vmnic mapping is used as
 * written.
 */
export interface CustomDvsPlan {
  /** Max 80 characters. Default `<prefix>-vds0N`. */
  readonly name?: string;
  /** Traffic types carried, standard or custom. */
  readonly networks?: readonly NetworkType[];
  /**
   * Explicit vmnic to uplink mapping. A plain list of vmnic names is mapped to
   * uplink1, uplink2... in order.
   */
  readonly vmnicsToUplinks: readonly (VmnicToUplink | string)[];
  /** Default 9000. */
  readonly mtu?: number;
  /** Whether this switch is prepared for NSX (overlay and VLAN transport zones). */
  readonly nsx?: boolean;
  /** Default: an overlay and a VLAN transport zone named from the prefix. */
  readonly transportZones?: readonly TransportZone[];
  readonly hostSwitchOperationalMode?: NsxtSwitchConfig['hostSwitchOperationalMode'];
  /** Free text; no enum is published. */
  readonly ipAssignmentType?: string;
  /** Default: the plan-level nsxTeaming. */
  readonly nsxTeaming?: NsxTeamingPlan;
  /** Default: none. */
  readonly lacp?: LacpPlan;
}

/**
 * Broadcom's four fleet sizing models (VCF 9.1 "VCF Fleet Sizing Models").
 */
export type SizePreset = 'simple' | 'ha-small' | 'ha-medium' | 'ha-large';

export interface SizePresetValues {
  readonly label: string;
  readonly ha: boolean;
  readonly vspSize: 'small' | 'small_ha' | 'medium' | 'large';
  /** vCenter for the first instance. */
  readonly vcenterSize: VcenterVmSize;
  /** vCenter for an additional instance. */
  readonly vcenterSizeAdditional: VcenterVmSize;
  readonly nsxManagerSize: NsxtManagerSize;
  readonly nsxManagerCount: 1 | 3;
  readonly opsSize: 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
  readonly opsNodeCount: 1 | 2 | 3;
  readonly collectorSize: 'small' | 'standard';
  readonly automationSize: string;
}

/**
 * The sizing table, first instance and additional instance.
 *
 * HA-Small's VCF management services size is rendered in the published table
 * as "Medium (3 control plane + 3 workers)", identical to HA-Medium; the API's
 * own `small_ha` value exists for exactly this model, so it is used. VERIFY.
 */
export const SIZE_PRESETS: Readonly<Record<SizePreset, SizePresetValues>> = {
  simple: {
    label: 'Simple',
    ha: false,
    vspSize: 'small',
    vcenterSize: 'small',
    vcenterSizeAdditional: 'small',
    nsxManagerSize: 'medium',
    nsxManagerCount: 1,
    opsSize: 'small',
    opsNodeCount: 1,
    collectorSize: 'small',
    automationSize: 'small',
  },
  'ha-small': {
    label: 'HA-Small',
    ha: true,
    vspSize: 'small_ha',
    vcenterSize: 'medium',
    vcenterSizeAdditional: 'small',
    nsxManagerSize: 'medium',
    nsxManagerCount: 3,
    opsSize: 'small',
    opsNodeCount: 2,
    collectorSize: 'small',
    automationSize: 'medium',
  },
  'ha-medium': {
    label: 'HA-Medium',
    ha: true,
    vspSize: 'medium',
    vcenterSize: 'medium',
    vcenterSizeAdditional: 'medium',
    nsxManagerSize: 'medium',
    nsxManagerCount: 3,
    opsSize: 'medium',
    opsNodeCount: 3,
    collectorSize: 'standard',
    automationSize: 'medium',
  },
  'ha-large': {
    label: 'HA-Large',
    ha: true,
    vspSize: 'large',
    vcenterSize: 'large',
    vcenterSizeAdditional: 'large',
    nsxManagerSize: 'large',
    nsxManagerCount: 3,
    opsSize: 'large',
    opsNodeCount: 3,
    collectorSize: 'standard',
    automationSize: 'large',
  },
};

/** Components whose `version` can be pinned. */
export type VersionedComponent =
  | 'vcenter'
  | 'nsx'
  | 'sddcManager'
  | 'managementServices'
  | 'operations'
  | 'collector'
  | 'automation'
  | 'identityBroker'
  | 'licenseServer'
  | 'fleetLcm'
  | 'sddcLcm'
  | 'fleetDepot'
  | 'telemetryAcceptor'
  | 'salt'
  | 'saltRaas';

/** The fleet and lifecycle service blocks that take a free-text size. */
export type ServiceSpecKey =
  | 'fleetLcm'
  | 'sddcLcm'
  | 'fleetDepot'
  | 'telemetryAcceptor'
  | 'salt'
  | 'saltRaas';

/**
 * Flexible IP pool specification.
 *
 * VCF 9.1 accepts a contiguous range, a CIDR, or an explicit address list, and
 * 9.1.0.400+ supports exclusions. Estates with fragmented free space need the
 * list form, so all three are expressible rather than only the range.
 */
export interface PoolPlan {
  readonly mode?: 'range' | 'cidr' | 'addresses';
  /** Explicit addresses, for the non-contiguous case. */
  readonly addresses?: string[];
  /** Addresses to carve out of a range or CIDR. */
  readonly excludedAddresses?: string[];
  /** Override the CIDR the pool is allocated from. */
  readonly cidr?: string;
  /** Offset into the source subnet when auto-allocating a range. */
  readonly offset?: number;
  readonly count?: number;
}

export type DvsProfile =
  | 'default'
  | 'storage-separation'
  | 'nsx-separation'
  | 'storage-and-nsx-separation'
  | 'custom';

export interface ExistingComponent {
  readonly fqdn: string;
  /** SHA256 thumbprint, required when reusing a component. */
  readonly sslThumbprint?: string;
  /**
   * Individual node FQDNs, where the component has nodes of its own: the NSX
   * Managers behind an existing NSX VIP. Optional.
   */
  readonly nodeFqdns?: readonly string[];
}

/**
 * One ESX host as the installer wants it.
 *
 * These are the only four fields `SddcHostSpec` defines. There is no per-host
 * IP (it resolves from DNS), and no per-host disk selection anywhere in the
 * API — vSAN claiming is automatic at cluster level.
 */
export interface HostEntry {
  /** Short name only; the DNS subdomain is appended by the installer. */
  readonly hostname: string;
  readonly password?: string;
  readonly username?: string;
  /** SHA256:<base64>, omittable when thumbprint validation is skipped. */
  readonly sshThumbprint?: string;
  /** Colon-separated uppercase hex SHA256. */
  readonly sslThumbprint?: string;
}

export interface DeploymentPlan {
  // --- identity ------------------------------------------------------------
  /** 3-20 chars, alphanumeric and hyphens. */
  readonly sddcId: string;
  readonly vcfInstanceName?: string;
  readonly version?: string;
  readonly workflowType?: WorkflowType;
  /** Domain suffix, e.g. "vcf.lab". Lowercase. */
  readonly domainSuffix: string;
  /** A secondary instance joins an existing fleet and omits fleetFqdn. */
  readonly instanceRole?: 'primary' | 'secondary';
  /** Short name prefix for generated component hostnames, e.g. "vcf-m01". */
  readonly namePrefix?: string;

  // --- hosts ---------------------------------------------------------------
  /**
   * Short hostname base, e.g. "esx" produces esx01, esx02...
   * Used only to seed the host list; `hosts` overrides it entirely.
   */
  readonly esxHostnameBase: string;
  readonly hostCount: number;
  readonly esxRootPassword?: string;
  /**
   * Explicit per-host detail.
   *
   * Real estates are not sequentially named and each host carries its own
   * credentials and thumbprints, so when this is present it replaces the
   * generated list rather than supplementing it.
   */
  readonly hosts?: HostEntry[];

  // --- infrastructure services --------------------------------------------
  /** Maximum 2. */
  readonly dnsServers: string[];
  readonly ntpServers: string[];

  // --- networks ------------------------------------------------------------
  readonly management: NetworkPlan;
  readonly vmManagement?: NetworkPlan;
  readonly vmotion: NetworkPlan;
  readonly vsan?: NetworkPlan;
  readonly nfs?: NetworkPlan;
  /**
   * Dedicated network for the fleet-level components, emitted as a
   * FLEET_MANAGEMENT networkSpec. Required by every model except shared VLAN.
   */
  readonly fleetManagement?: NetworkPlan;

  /**
   * Which of Broadcom's four VCF Management Network Models this deployment
   * follows. Derived from the networks present when left unset.
   */
  readonly managementNetworkModel?: ManagementNetworkModel;
  /** Host overlay TEP network. */
  readonly hostTep: NetworkPlan;
  readonly pnicsPerHost?: number;

  // --- storage -------------------------------------------------------------
  readonly storage: 'vsan-esa' | 'vsan-osa' | 'nfs' | 'vmfs-fc';
  readonly datastoreName?: string;
  readonly failuresToTolerate?: number;
  readonly vsanDedup?: boolean;
  /**
   * vSAN ESA `skipHclAutoDiskClaim`: true skips the HCL check when disks are
   * claimed automatically, so HCL-incompatible disks are claimed too (the
   * wizard's "Allow auto claim of HCL incompatible disks"). It does not turn
   * automatic claiming off.
   */
  readonly skipHclAutoDiskClaim?: boolean;
  /** vSAN data-in-transit encryption. */
  readonly vsanEncryptionInTransit?: boolean;
  /** Rekey interval in minutes, when DIT encryption is enabled. */
  readonly vsanRekeyIntervalMinutes?: number;

  // NFS — the API takes an array of servers, a mount path and a read-only flag.
  readonly nfsServers?: string[];
  readonly nfsPath?: string;
  /** Kept for convenience; folded into nfsServers when that is absent. */
  readonly nfsServer?: string;
  readonly nfsReadOnly?: boolean;
  readonly nfsUserTag?: string;
  readonly nfsBindToVmknic?: boolean;

  /** VMFS-on-FC datastore names; one entry per LUN. */
  readonly vmfsDatastoreNames?: string[];

  // --- IP pools ------------------------------------------------------------
  readonly vcfmsPool?: PoolPlan;
  readonly automationPool?: PoolPlan;
  readonly tepPool?: PoolPlan;

  // --- dual stack ----------------------------------------------------------
  /** Emit IPv6 alongside IPv4 where a network defines an ipv6Cidr. */
  readonly dualStack?: boolean;
  readonly internalClusterCidrIpv6?: string;
  /** IPv6 pool for VCF Management Services. */
  readonly vcfmsIpv6Pool?: PoolPlan;

  /** Local and cross-region networks for VCF management components. */
  readonly managementComponentNetworks?: {
    readonly local?: {
      networkName: string;
      subnetMask: string;
      gateway: string;
      ipv6Gateway?: string;
      ipv6Prefix?: number;
    };
    readonly xRegion?: {
      networkName: string;
      subnetMask: string;
      gateway: string;
      ipv6Gateway?: string;
      ipv6Prefix?: number;
    };
  };

  // --- scale ---------------------------------------------------------------
  /**
   * Broadcom's fleet sizing model. Sets every component size and node count at
   * once; the individual size fields below still win. When unset, `profile`
   * applies as before.
   */
  readonly sizePreset?: SizePreset;
  /** Ignored when sizePreset is set (the preset decides simple or HA). */
  readonly profile?: 'simple' | 'ha';
  readonly vcenterSize?: VcenterVmSize;
  /** vCenter appliance storage size. Default lstorage. */
  readonly vcenterStorageSize?: VcenterStorageSize;
  readonly nsxManagerSize?: NsxtManagerSize;
  /** 1 or 3. Default from the preset, or 3 for HA and 1 for simple. */
  readonly nsxManagerCount?: 1 | 3;
  readonly opsSize?: 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
  /** 1-3 VCF Operations nodes (master, replica, data). Default from the preset, or 3 for HA and 1 for simple. */
  readonly opsNodeCount?: 1 | 2 | 3;
  /**
   * Whether to emit `vcfOperationsSpec.loadBalancerFqdn` (name from
   * fqdnOverrides.opsLoadBalancer). Default: true for HA with more than one
   * node, which is the earlier behaviour.
   */
  readonly opsLoadBalancer?: boolean;
  /** Cloud proxy size. Default from the preset, else small. */
  readonly collectorSize?: 'small' | 'standard';
  readonly vspSize?: 'small' | 'small_ha' | 'medium' | 'large';
  readonly automationSize?: string;

  // --- switching -----------------------------------------------------------
  readonly dvsProfile?: DvsProfile;
  /** e.g. ["vmnic0", "vmnic1"]. */
  readonly vmnics?: string[];
  readonly dvsMtu?: number;
  /** LACP on the NSX-carrying switch of a predefined profile. */
  readonly lacp?: LacpPlan;
  /**
   * The switches of a custom layout, with explicit vmnic mapping. Used as
   * written, whatever the profile; required when dvsProfile is 'custom'.
   */
  readonly dvsSwitches?: readonly CustomDvsPlan[];
  /** NSX uplink teaming. Default LOADBALANCE_SRCID with every uplink active. */
  readonly nsxTeaming?: NsxTeamingPlan;
  /** Emitted on the NSX switch only when set (STANDARD, ENS, ENS_INTERRUPT). */
  readonly hostSwitchOperationalMode?: NsxtSwitchConfig['hostSwitchOperationalMode'];

  // --- NSX / VPC -----------------------------------------------------------
  /**
   * VPC type. VLAN_BACKED_VPC (9.1.1+) implies a TEP-less deployment
   * (`overlayVtepSpec.vtepType=NO_IP`), with no TEP pool and no DTGW.
   */
  readonly vpcNetworkConfigurationType?: VpcSpec['vpcNetworkConfigurationType'];
  /**
   * Host TEP addressing. 'static' (default) emits an IP pool; 'existing-pool'
   * names a pool to reuse (tepPoolName); 'dhcp' emits no pool (inferred; VERIFY).
   */
  readonly tepMode?: 'static' | 'dhcp' | 'existing-pool';
  /** TEP pool name. Default `<prefix>-tep01`. */
  readonly tepPoolName?: string;
  readonly ignoreUnavailableNsxtCluster?: boolean;
  /** Emitted only when set. Documented for a converted vCenter; Broadcom's greenfield sample sets it true. */
  readonly skipNsxOverlayOverManagementNetwork?: boolean;
  /**
   * Existing NSX only. Default true (the earlier behaviour). Triggers a one-time
   * reset of the Edge node passwords.
   */
  readonly enableEdgeClusterSync?: boolean;
  readonly dtgw?: {
    readonly vlan: number;
    readonly gatewayCidr: string;
    readonly externalIpBlockCidr: string;
    /** Optional in the API. */
    readonly privateTgwIpBlockCidr?: string;
  };

  // --- cluster -------------------------------------------------------------
  readonly datacenterName?: string;
  readonly clusterName?: string;
  readonly evcMode?: EvcMode;
  readonly resourcePools?: ResourcePoolSpec[];

  // --- security ------------------------------------------------------------
  readonly esxiCertsMode?: 'Custom' | 'VMCA';
  /** Base64-encoded root CA chain, required when esxiCertsMode is Custom. */
  readonly rootCaCerts?: { alias: string; certChain: string[] }[];

  /** Names the SDDC Manager network pool created for the management cluster. */
  readonly managementPoolName?: string;

  /** TEP-less deployment (9.1.1+): no host overlay VTEPs are created. */
  readonly tepLess?: boolean;

  /**
   * Override individual generated component FQDNs.
   *
   * Everything is derived from namePrefix + domainSuffix by default, but real
   * environments have naming standards that do not fit one pattern, so any
   * single name can be replaced.
   */
  readonly fqdnOverrides?: Partial<
    Record<
      | 'vcenter'
      | 'sddcManager'
      | 'nsxVip'
      | 'nsxManager1'
      | 'nsxManager2'
      | 'nsxManager3'
      | 'opsPrimary'
      | 'opsReplica'
      | 'opsData'
      | 'opsLoadBalancer'
      | 'opsCollector'
      | 'licenseServer'
      | 'identityBroker'
      | 'automation'
      | 'automationPlatform'
      | 'vspPlatform'
      | 'vspInstance'
      | 'vspFleet',
      string
    >
  >;

  // --- scenario ------------------------------------------------------------
  /**
   * Which of Broadcom's eight published deployment scenarios this is.
   *
   * Derived from instanceRole, workflowType and the `existing` block when left
   * unset, which reproduces the behaviour of plans written before scenarios
   * existed. Set it explicitly for anything beyond a new or secondary VCF
   * instance — a vSphere Foundation platform or a deferred-component run cannot
   * be inferred from the rest of the plan.
   */
  readonly scenario?: DeploymentScenario;

  // --- components ----------------------------------------------------------
  readonly includeAutomation?: boolean;
  readonly includeOperations?: boolean;
  /** Only consulted where the scenario leaves the choice open. */
  readonly includeManagementServices?: boolean;
  readonly includeIdentityBroker?: boolean;
  /**
   * Identity broker model. 'instance' emits vidbSpec (runs on VCF management
   * services); 'embedded' is the vCenter-embedded broker, expressed by leaving
   * vidbSpec out. Default: 'instance' wherever the scenario includes one.
   */
  readonly identityBrokerModel?: 'embedded' | 'instance';
  /** vidbSpec.size, emitted only when set. Documented small / medium / large. */
  readonly identityBrokerSize?: 'small' | 'medium' | 'large';
  /**
   * License Server presence where the table's * footnote makes it conditional
   * (the existing VCF Operations may already have one). Default true.
   */
  readonly includeLicenseServer?: boolean;
  readonly ceipEnabled?: boolean;
  /** VCF management services internal cluster CIDR (and Automation's, unless set separately). */
  readonly internalClusterCidr?: string;
  /** VCF Automation internal cluster CIDR. Default: internalClusterCidr, else 198.18.0.0/15. */
  readonly automationInternalClusterCidr?: string;
  /** VCF Automation node prefix. Default `<prefix>-node-01`. */
  readonly automationNodePrefix?: string;
  /** vspClusterSpec.name (undocumented but accepted). Default `<prefix>-vmsp-01`. */
  readonly vspName?: string;

  // --- vCenter SSO --------------------------------------------------------------
  /** Default vsphere.local. */
  readonly vcenterSsoDomain?: string;
  /** Default administrator@<vcenterSsoDomain>, as Broadcom's samples use. */
  readonly vcenterSsoUsername?: string;

  // --- document ----------------------------------------------------------------
  /**
   * 'minimal' emits only the component blocks and the existing vCenter / SDDC
   * Manager, as Broadcom's samples for deferred components, VCF management
   * services for VVF and converge do. Default 'minimal' for
   * deferred-components and vvf-management-services, 'full' otherwise.
   */
  readonly documentShape?: 'full' | 'minimal';
  /**
   * Emit fleetDepotSpec, telemetryAcceptorSpec, saltSpec and saltRaasSpec as
   * empty blocks. Default true (the earlier behaviour); Broadcom's samples omit them.
   */
  readonly includeFleetServiceSpecs?: boolean;
  /** Free-text sizes for the fleet and lifecycle service blocks. */
  readonly serviceSizes?: Partial<Record<ServiceSpecKey, string>>;
  /** Per-component `version` pins. Default: none emitted. */
  readonly componentVersions?: Partial<Record<VersionedComponent, string>>;
  /** Default false. */
  readonly skipGatewayPingValidation?: boolean;

  // --- brownfield ----------------------------------------------------------
  readonly existing?: {
    readonly vcenter?: ExistingComponent;
    readonly nsx?: ExistingComponent;
    readonly sddcManager?: ExistingComponent;
    /** For a VCF_EXTEND run this is the fleet's VCF Operations master node. */
    readonly operations?: ExistingComponent;
    readonly automation?: ExistingComponent;
    readonly licenseServer?: ExistingComponent;
    /** The cloud proxy (vcfOperationsCollectorSpec). */
    readonly collector?: ExistingComponent;
    /** VCF management services (vspClusterSpec); fqdn is the platform FQDN. */
    readonly managementServices?: ExistingComponent;
    readonly datastoreName?: string;
  };

  // --- secrets (optional; placeholders emitted when absent) ----------------
  readonly passwords?: Record<string, string>;
  /**
   * Leave blank every password the API documents as auto-generated when blank
   * (vCenter root and SSO, NSX, SDDC Manager, VCF management services, VCF
   * Operations admin, VCF Automation admin) instead of emitting a placeholder.
   * Existing components' passwords, ESX root, and the Operations node and cloud
   * proxy root passwords stay required. Default false.
   */
  readonly autoGeneratePasswords?: boolean;
}

export interface BuildResult {
  readonly spec: SddcSpec;
  /** Notes about derived values and anything the plan left for the user. */
  readonly findings: readonly Finding[];
  /** Dotted paths that still contain a placeholder secret. */
  readonly placeholders: readonly string[];
}

function fqdn(shortName: string, domain: string): string {
  return `${shortName}.${domain}`.toLowerCase();
}

function gatewayFor(plan: NetworkPlan, cidr: Cidr): string {
  return plan.gateway ?? formatIPv4(usableRange(cidr).first);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function networkSpec(
  type: NetworkType,
  plan: NetworkPlan,
  extras: Partial<SddcNetworkSpec> = {},
): SddcNetworkSpec | null {
  const cidr = parseCidr(plan.cidr);
  if (!cidr) return null;
  const spec: SddcNetworkSpec = {
    networkType: type,
    vlanId: plan.vlanId,
    subnet: plan.cidr,
    gateway: gatewayFor(plan, cidr),
    ipAddressVersion: 'IPv4',
    // SLAAC is IPv6-only; on a dual-stack plan it applies to the IPv6 twin.
    ipAddressAssignmentMode: plan.assignmentMode === 'SLAAC' ? 'STATIC' : (plan.assignmentMode ?? 'STATIC'),
    // Per-traffic-type teaming — the wizard exposes this per network, and the
    // enum here is lowercase, unlike the uppercase NSX uplink-profile enum.
    teamingPolicy: plan.teamingPolicy ?? 'loadbalance_loadbased',
    activeUplinks: plan.activeUplinks ?? ['uplink1', 'uplink2'],
    standbyUplinks: plan.standbyUplinks ?? [],
    ...(plan.mtu !== undefined ? { mtu: plan.mtu } : {}),
    ...extras,
    ...(plan.portGroupName ? { portGroupKey: plan.portGroupName } : {}),
    ...(plan.ipRanges?.length ? { includeIpAddressRanges: plan.ipRanges.map((r) => ({ ...r })) } : {}),
    ...(plan.ipAddresses?.length ? { includeIpAddress: [...plan.ipAddresses] } : {}),
  };
  return spec;
}

/**
 * IPv6 counterpart of a network.
 *
 * The API carries no separate v6 fields: an IPv6 network sets
 * `ipAddressVersion: "IPv6"` and puts v6 values in the same `subnet` and
 * `gateway` fields.
 */
function networkSpecV6(
  type: NetworkType,
  plan: NetworkPlan,
  extras: Partial<SddcNetworkSpec> = {},
): SddcNetworkSpec | null {
  const cidr = v6Cidr(plan.ipv6Cidr);
  if (!cidr) return null;
  return {
    networkType: type,
    vlanId: plan.vlanId,
    // Written canonically: the API bounds subnet at 18 characters for IPv4,
    // so the compressed form gives an IPv6 prefix its best chance to fit.
    subnet: `${compressIPv6(bigToV6(cidr.network))}/${cidr.prefix}`,
    ...(plan.ipv6Gateway ? { gateway: plan.ipv6Gateway } : {}),
    ipAddressVersion: 'IPv6',
    ipAddressAssignmentMode: plan.assignmentMode ?? 'STATIC',
    teamingPolicy: plan.teamingPolicy ?? 'loadbalance_loadbased',
    activeUplinks: plan.activeUplinks ?? ['uplink1', 'uplink2'],
    standbyUplinks: plan.standbyUplinks ?? [],
    ...(plan.mtu !== undefined ? { mtu: plan.mtu } : {}),
    ...extras,
    // The IPv6 twin shares the VLAN, so it shares a named port group too.
    ...(plan.portGroupName ? { portGroupKey: plan.portGroupName } : {}),
  };
}

/**
 * Build an IPv4 pool in whichever form the plan asks for.
 *
 * Exactly one of addresses / ipRange / cidr must be present, so the branches
 * are mutually exclusive rather than merged.
 */
function buildPool(
  plan: PoolPlan | undefined,
  sourceCidr: Cidr | null,
  defaultOffset: number,
  defaultCount: number,
): IPv4Pool | null {
  const mode = plan?.mode ?? 'range';

  if (mode === 'addresses') {
    if (!plan?.addresses?.length) return null;
    return { addresses: plan.addresses };
  }

  if (mode === 'cidr') {
    const cidr = plan?.cidr;
    if (!cidr) return null;
    return {
      cidr,
      ...(plan?.excludedAddresses?.length ? { excludedAddresses: plan.excludedAddresses } : {}),
    };
  }

  const cidr = plan?.cidr ? parseCidr(plan.cidr) : sourceCidr;
  if (!cidr) return null;
  const range = allocateRange(cidr, plan?.offset ?? defaultOffset, plan?.count ?? defaultCount);
  if (!range) return null;

  return {
    ipRange: { startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) },
    ...(plan?.excludedAddresses?.length ? { excludedAddresses: plan.excludedAddresses } : {}),
  };
}

/**
 * Flatten a pool to a plain address list.
 *
 * `vcfAutomationSpec.ipPool` is a bare string array rather than an IPv4Pool, so
 * whichever form the plan used has to be expanded here.
 */
function poolToAddresses(pool: IPv4Pool): string[] {
  if (pool.addresses?.length) return pool.addresses;
  if (pool.ipRange) {
    const start = parseIPv4(pool.ipRange.startIpAddress);
    const end = parseIPv4(pool.ipRange.endIpAddress);
    if (start === null || end === null || end < start) return [];
    const excluded = new Set(pool.excludedAddresses ?? []);
    const out: string[] = [];
    for (let addr = start; addr <= end; addr += 1) {
      const text = formatIPv4(addr);
      if (!excluded.has(text)) out.push(text);
    }
    return out;
  }
  if (pool.cidr) {
    const cidr = parseCidr(pool.cidr);
    if (!cidr) return [];
    const { first, last } = usableRange(cidr);
    const excluded = new Set(pool.excludedAddresses ?? []);
    const out: string[] = [];
    for (let addr = first; addr <= last && out.length < 256; addr += 1) {
      const text = formatIPv4(addr);
      if (!excluded.has(text)) out.push(text);
    }
    return out;
  }
  return [];
}

/** An IPv6 prefix, or null for anything else (including IPv4). */
function v6Cidr(text: string | undefined): Cidr6 | null {
  if (!text || !text.includes('/') || familyOf(text) !== 6) return null;
  return parseCidr6(text);
}

/**
 * IPv6 counterpart of allocateRange: `count` consecutive addresses starting
 * `offset` into the prefix. The first usable address is network + 1 (the
 * network address itself is the subnet-router anycast), so the same offsets
 * land on the same host numbers in both families.
 */
function allocateRange6(cidr: Cidr6, offset: number, count: number): { start: string; end: string } | null {
  if (count <= 0 || offset < 0) return null;
  const size = 1n << BigInt(128 - cidr.prefix);
  const start = 1n + BigInt(offset);
  const end = start + BigInt(count) - 1n;
  if (end > size - 1n) return null;
  const text = (v: bigint): string => compressIPv6(bigToV6(cidr.network + v));
  return { start: text(start), end: text(end) };
}

/**
 * IPv6 pool, in the same three forms as buildPool.
 *
 * An explicit address list or a bare CIDR is emitted as given, as before. The
 * range form is carved out of `sourceCidr` (the IPv6 prefix of the network the
 * pool serves) or the plan's own IPv6 CIDR, at the same offset IPv4 uses.
 */
function buildPoolV6(
  plan: PoolPlan | undefined,
  sourceCidr: Cidr6 | null,
  defaultOffset: number,
  defaultCount: number,
): IPv6Pool | null {
  const excluded = plan?.excludedAddresses?.length ? { excludedAddresses: plan.excludedAddresses } : {};
  const mode =
    plan?.mode ??
    (plan?.addresses?.length
      ? 'addresses'
      : plan?.cidr && plan.offset === undefined && plan.count === undefined
        ? 'cidr'
        : 'range');

  if (mode === 'addresses') return plan?.addresses?.length ? { addresses: plan.addresses } : null;
  if (mode === 'cidr') return plan?.cidr ? { cidr: plan.cidr, ...excluded } : null;

  const cidr = plan?.cidr ? v6Cidr(plan.cidr) : sourceCidr;
  if (!cidr) return null;
  const range = allocateRange6(cidr, plan?.offset ?? defaultOffset, plan?.count ?? defaultCount);
  if (!range) return null;
  return { ipRange: { startIpAddress: range.start, endIpAddress: range.end }, ...excluded };
}

/**
 * Check a network plan's addresses before anything is emitted from it.
 *
 * VCF 9.1 runs IPv6 as dual stack: every network keeps its IPv4 `cidr` and
 * carries IPv6 in `ipv6Cidr`/`ipv6Gateway`. An IPv6 value in an IPv4 field, or
 * the reverse, cannot work, so it is an error rather than a silent drop.
 */
function checkNetworkPlan(label: string, path: string, plan: NetworkPlan | undefined, findings: Finding[]): void {
  if (!plan) return;
  if (familyOf(plan.cidr) === 6) {
    findings.push(
      error(
        'vcf.build.ipv6-only-network',
        `${label} has an IPv6 prefix (${plan.cidr}) in its IPv4 cidr. VCF 9.1 IPv6 is dual stack: the IPv4 subnet stays in cidr.`,
        { path: `${path}.cidr`, remediation: `Put the IPv4 subnet in cidr and ${plan.cidr} in ipv6Cidr.` },
      ),
    );
  }
  if (plan.gateway !== undefined && familyOf(plan.gateway) !== 4) {
    findings.push(
      error('vcf.build.invalid-gateway', `${label} gateway "${plan.gateway}" is not an IPv4 address.`, {
        path: `${path}.gateway`,
        remediation: 'An IPv6 gateway goes in ipv6Gateway.',
      }),
    );
  }
  if (plan.ipv6Cidr !== undefined && !v6Cidr(plan.ipv6Cidr)) {
    findings.push(
      error('vcf.build.invalid-ipv6-cidr', `${label} ipv6Cidr "${plan.ipv6Cidr}" is not an IPv6 prefix.`, {
        path: `${path}.ipv6Cidr`,
      }),
    );
  }
  if (plan.ipv6Gateway !== undefined) {
    if (!isIp(plan.ipv6Gateway) || familyOf(plan.ipv6Gateway) !== 6) {
      findings.push(
        error('vcf.build.invalid-ipv6-gateway', `${label} ipv6Gateway "${plan.ipv6Gateway}" is not an IPv6 address.`, {
          path: `${path}.ipv6Gateway`,
        }),
      );
    } else if (v6Cidr(plan.ipv6Cidr) && !containsAny(plan.ipv6Cidr!, plan.ipv6Gateway)) {
      findings.push(
        error('vcf.build.ipv6-gateway-outside-subnet', `${label} ipv6Gateway ${plan.ipv6Gateway} is not inside ${plan.ipv6Cidr}.`, {
          path: `${path}.ipv6Gateway`,
        }),
      );
    }
  }
}

function buildLag(lacp: LacpPlan, prefix: string): LagSpec {
  return {
    name: (lacp.name ?? `${prefix}-lag01`).slice(0, 16),
    uplinksCount: lacp.uplinksCount ?? 2,
    lacpMode: lacp.lacpMode ?? 'ACTIVE',
    lacpTimeoutMode: lacp.lacpTimeoutMode ?? 'FAST',
    loadBalancingMode: lacp.loadBalancingMode ?? 'SOURCE_AND_DESTINATION_IP',
  };
}

/** NSX teaming for a switch whose uplinks are `uplinks`. */
function buildTeaming(teaming: NsxTeamingPlan | undefined, uplinks: string[]): TeamingSpec {
  const standby = teaming?.standByUplinks ? [...teaming.standByUplinks] : null;
  const active = teaming?.activeUplinks
    ? [...teaming.activeUplinks]
    : uplinks.filter((u) => !standby?.includes(u));
  return {
    policy: teaming?.policy ?? 'LOADBALANCE_SRCID',
    activeUplinks: active,
    standByUplinks: standby,
  };
}

/**
 * vDS layout.
 *
 * The 9.1 installer offers Default (one switch), Storage Traffic Separation
 * (two), NSX Traffic Separation (two), Storage and NSX Separation (three), and
 * Custom. Each predefined profile's switch needs its own uplinks, so the
 * available vmnics are split across them. A custom layout is used exactly as
 * the plan writes it.
 */
function buildDvsSpecs(plan: DeploymentPlan, findings: Finding[]): DvsSpec[] {
  const profile = plan.dvsProfile ?? 'default';
  const vmnics = plan.vmnics ?? ['vmnic0', 'vmnic1'];
  const mtu = plan.dvsMtu ?? DEFAULT_MTU;
  const prefix = plan.namePrefix ?? plan.sddcId;

  const toUplinks = (nics: string[]): VmnicToUplink[] =>
    nics.map((id, i) => ({ id, uplink: `uplink${i + 1}` }));

  const defaultZones: TransportZone[] = [
    { name: `${prefix}-overlay-tz`, transportType: 'OVERLAY' },
    { name: `${prefix}-vlan-tz`, transportType: 'VLAN' },
  ];
  const switchConfig = (
    zones: readonly TransportZone[] | undefined,
    mode: NsxtSwitchConfig['hostSwitchOperationalMode'] | undefined,
    ipAssignmentType?: string,
  ): NsxtSwitchConfig => ({
    transportZones: (zones ?? defaultZones).map((z) => ({ ...z })),
    ...(mode ? { hostSwitchOperationalMode: mode } : {}),
    ...(ipAssignmentType ? { ipAssignmentType } : {}),
  });

  const storageNetworks: NetworkType[] = [];
  if (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa') storageNetworks.push('VSAN');
  if (plan.nfs) storageNetworks.push('NFS');

  const coreNetworks: NetworkType[] = ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION'];
  if (plan.fleetManagement) coreNetworks.push('FLEET_MANAGEMENT');

  // --- custom ---------------------------------------------------------------
  if (plan.dvsSwitches?.length) {
    if (plan.dvsProfile !== undefined && profile !== 'custom') {
      findings.push(
        info(
          'vcf.build.custom-dvs-overrides-profile',
          `dvsSwitches is set, so the "${profile}" profile is ignored and the switches are emitted as written.`,
          { path: 'dvsSwitches' },
        ),
      );
    }
    if (!plan.dvsSwitches.some((d) => d.nsx)) {
      findings.push(
        warning(
          'vcf.build.custom-dvs-no-nsx',
          'No custom switch is marked for NSX, so no host switch carries the NSX transport zones.',
          {
            path: 'dvsSwitches',
            remediation: 'Set nsx: true on the switch that should carry the NSX transport zones.',
          },
        ),
      );
    }
    const used = new Map<string, number>();
    const switches = plan.dvsSwitches.map((d, i): DvsSpec => {
      const mapping: VmnicToUplink[] = d.vmnicsToUplinks.map((m, j) =>
        typeof m === 'string' ? { id: m, uplink: `uplink${j + 1}` } : { id: m.id, uplink: m.uplink },
      );
      for (const m of mapping) used.set(m.id, (used.get(m.id) ?? 0) + 1);
      if (mapping.length === 0) {
        findings.push(
          error('vcf.build.custom-dvs-no-vmnics', `Custom switch ${i + 1} has no vmnics.`, {
            path: `dvsSwitches[${i}].vmnicsToUplinks`,
          }),
        );
      }
      const uplinks = mapping.map((m) => m.uplink);
      const lacp = d.lacp ?? (d.nsx ? plan.lacp : undefined);
      return {
        dvsName: d.name ?? `${prefix}-vds${pad(i + 1)}`,
        ...(d.networks?.length ? { networks: [...d.networks] } : {}),
        mtu: d.mtu ?? mtu,
        ...(d.nsx
          ? {
              nsxtSwitchConfig: switchConfig(
                d.transportZones,
                d.hostSwitchOperationalMode ?? plan.hostSwitchOperationalMode,
                d.ipAssignmentType,
              ),
            }
          : {}),
        vmnicsToUplinks: mapping,
        ...(d.nsx ? { nsxTeamings: [buildTeaming(d.nsxTeaming ?? plan.nsxTeaming, uplinks)] } : {}),
        ...(lacp ? { lagSpecs: [buildLag(lacp, prefix)] } : {}),
      };
    });
    // A vmnic belongs to one switch only.
    const shared = [...used].filter(([, n]) => n > 1).map(([id]) => id);
    if (shared.length > 0) {
      findings.push(
        error('vcf.build.custom-dvs-shared-vmnic', `vmnic(s) ${shared.join(', ')} are mapped to more than one switch.`, {
          path: 'dvsSwitches',
        }),
      );
    }
    return switches;
  }

  if (profile === 'custom') {
    // The custom profile must not quietly become the default single switch.
    findings.push(
      error(
        'vcf.build.custom-dvs-missing',
        'The custom vDS profile was chosen but no switches were defined, so no dvsSpecs are emitted.',
        {
          path: 'dvsSwitches',
          remediation:
            'Define each switch with its networks and explicit vmnic-to-uplink mapping, or pick a predefined profile.',
          source: 'VCF 9.1 vDS profiles',
        },
      ),
    );
    return [];
  }

  // --- predefined profiles ----------------------------------------------------
  const lagSpecs: LagSpec[] | null = plan.lacp ? [buildLag(plan.lacp, prefix)] : null;
  const overlayConfig = switchConfig(undefined, plan.hostSwitchOperationalMode);

  const needed: Record<Exclude<DvsProfile, 'custom'>, number> = {
    default: 1,
    'storage-separation': 2,
    'nsx-separation': 2,
    'storage-and-nsx-separation': 3,
  };
  const switchCount = needed[profile];

  if (vmnics.length < switchCount * 2) {
    findings.push(
      warning(
        'vcf.build.insufficient-vmnics',
        `The "${profile}" vDS profile wants ${switchCount} switch(es) with redundant uplinks, which needs ${switchCount * 2} vmnics; ${vmnics.length} supplied.`,
        {
          path: 'vmnics',
          remediation: 'Add vmnics, or use the default single-switch profile.',
          source: 'VCF 9.1 vDS profiles',
        },
      ),
    );
  }

  const chunk = Math.max(1, Math.floor(vmnics.length / switchCount));
  const slice = (index: number): string[] =>
    vmnics.slice(index * chunk, index === switchCount - 1 ? undefined : (index + 1) * chunk);

  const nsxSwitch = (name: string, nics: string[], networks?: NetworkType[]): DvsSpec => {
    const uplinks = toUplinks(nics);
    return {
      dvsName: name,
      ...(networks ? { networks } : {}),
      mtu,
      nsxtSwitchConfig: overlayConfig,
      vmnicsToUplinks: uplinks,
      nsxTeamings: [buildTeaming(plan.nsxTeaming, uplinks.map((u) => u.uplink))],
      lagSpecs,
    };
  };

  if (profile === 'default') {
    return [nsxSwitch(`${prefix}-vds01`, vmnics, [...coreNetworks, ...storageNetworks])];
  }

  if (profile === 'storage-separation') {
    return [
      nsxSwitch(`${prefix}-vds01`, slice(0), coreNetworks),
      {
        dvsName: `${prefix}-vds02-storage`,
        networks: storageNetworks,
        mtu,
        vmnicsToUplinks: toUplinks(slice(1)),
      },
    ];
  }

  if (profile === 'nsx-separation') {
    return [
      {
        dvsName: `${prefix}-vds01`,
        networks: [...coreNetworks, ...storageNetworks],
        mtu,
        vmnicsToUplinks: toUplinks(slice(0)),
      },
      nsxSwitch(`${prefix}-vds02-nsx`, slice(1)),
    ];
  }

  return [
    {
      dvsName: `${prefix}-vds01`,
      networks: coreNetworks,
      mtu,
      vmnicsToUplinks: toUplinks(slice(0)),
    },
    {
      dvsName: `${prefix}-vds02-storage`,
      networks: storageNetworks,
      mtu,
      vmnicsToUplinks: toUplinks(slice(1)),
    },
    nsxSwitch(`${prefix}-vds03-nsx`, slice(2)),
  ];
}

function buildDatastoreSpec(plan: DeploymentPlan, findings: Finding[]): SddcDatastoreSpec {
  if (plan.existing?.datastoreName) {
    return { existingDatastoreName: plan.existing.datastoreName };
  }

  if (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa') {
    const esa = plan.storage === 'vsan-esa';
    // The API documentation is inconsistent about the FTT default, so it is
    // always emitted explicitly. 6+ hosts can sustain FTT=2.
    const ftt = plan.failuresToTolerate ?? (plan.hostCount >= 6 ? 2 : 1);
    if (plan.failuresToTolerate === undefined) {
      findings.push(
        info(
          'vcf.build.ftt-derived',
          `failuresToTolerate set to ${ftt} from a ${plan.hostCount}-host cluster. Emitted explicitly because the documented default is ambiguous.`,
          { path: 'datastoreSpec.vsanSpec.failuresToTolerate' },
        ),
      );
    }
    return {
      vsanSpec: {
        datastoreName: plan.datastoreName ?? 'vsanDatastore',
        // Dedup and compression is an OSA-only feature and conflicts with ESA.
        vsanDedup: esa ? false : (plan.vsanDedup ?? false),
        failuresToTolerate: ftt,
        esaConfig: {
          enabled: esa,
          ...(esa && plan.skipHclAutoDiskClaim !== undefined
            ? { skipHclAutoDiskClaim: plan.skipHclAutoDiskClaim }
            : {}),
        },
        encryptionConfig: {
          dataInTransitConfig: {
            enable: plan.vsanEncryptionInTransit ?? false,
            ...(plan.vsanEncryptionInTransit && plan.vsanRekeyIntervalMinutes !== undefined
              ? { rekeyInterval: plan.vsanRekeyIntervalMinutes }
              : {}),
          },
        },
      },
    };
  }

  if (plan.storage === 'nfs') {
    const servers = plan.nfsServers?.length
      ? plan.nfsServers
      : plan.nfsServer
        ? [plan.nfsServer]
        : [];
    if (servers.length === 0) {
      findings.push(
        warning('vcf.build.nfs-no-server', 'NFS storage selected but no server address was supplied.', {
          path: 'nfsServers',
          remediation: 'Add at least one NFS server address; the API requires a non-empty list.',
          source: 'VCF Installer API — NasVolumeSpec',
        }),
      );
    }
    return {
      nfsDatastoreSpec: {
        datastoreName: plan.datastoreName ?? 'nfsDatastore',
        nasVolume: {
          serverName: servers.length > 0 ? servers : [PLACEHOLDER_SECRET],
          path: plan.nfsPath ?? '/export/vcf',
          // readOnly is REQUIRED by the API, so it is always emitted.
          readOnly: plan.nfsReadOnly ?? false,
          ...(plan.nfsUserTag ? { userTag: plan.nfsUserTag } : {}),
          ...(plan.nfsBindToVmknic !== undefined
            ? { enableBindToVmknic: plan.nfsBindToVmknic }
            : {}),
        },
      },
    };
  }

  const vmfsNames = plan.vmfsDatastoreNames?.length
    ? plan.vmfsDatastoreNames
    : [plan.datastoreName ?? 'vmfsDatastore'];

  return {
    vmfsDatastoreSpec: {
      fcSpec: vmfsNames.map((datastoreName) => ({ datastoreName })),
    },
  };
}

/**
 * Infer the scenario from a plan written before scenarios were modelled.
 *
 * Only the VCF rows are inferable: a vSphere Foundation platform and a
 * deferred-component run look identical to a plain VCF plan apart from the
 * workflowType, so those must be asked for explicitly.
 */
function deriveScenario(plan: DeploymentPlan): DeploymentScenario {
  const converging = Boolean(
    plan.existing?.vcenter || plan.existing?.nsx || plan.existing?.datastoreName,
  );
  const secondary = plan.instanceRole === 'secondary';

  if (plan.workflowType === 'VVF') return converging ? 'converge-to-vvf' : 'new-vvf';
  if (plan.workflowType === 'VCF_COMPLETE') return 'deferred-components';
  if (secondary) return converging ? 'converge-to-vcf-instance' : 'new-vcf-instance';
  return converging ? 'converge-to-vcf-fleet' : 'new-vcf-fleet';
}

/**
 * Infer the management network model from the networks a plan supplies.
 *
 * Naming an overlay segment is the strongest signal, then a dedicated network;
 * with neither, the components share the Instance-level port group. Stretched
 * cannot be inferred — a second region is a deliberate choice, not a side
 * effect of the networks present.
 */
function deriveManagementNetworkModel(plan: DeploymentPlan): ManagementNetworkModel {
  if (plan.managementComponentNetworks?.xRegion) return 'dedicated-vlan-overlay';
  if (plan.fleetManagement) return 'dedicated-vlan';
  return 'shared-vlan';
}

/** Every management network model, for UI listing. */
export const VCF_MANAGEMENT_NETWORK_MODELS = MANAGEMENT_NETWORK_MODELS;

/** Every scenario the builder can produce, for UI listing. */
export const DEPLOYMENT_SCENARIOS = SCENARIO_RULES;

/**
 * Top-level keys a minimal document keeps, per scenario.
 *
 * Broadcom's worked examples for these workflows carry the component blocks
 * and the existing vCenter (and SDDC Manager), and nothing of the bring-up:
 * no hosts, networks, switches, NSX, datastore or cluster.
 *
 *  - deferred components: the three "Deploy Deferred Components" pages;
 *  - VCF management services for VVF: domainSpec-example-VMSPonVVF.json;
 *  - converge: domainSpec-sfo-m01-example03.json.
 */
const MINIMAL_KEYS: Readonly<Record<'deferred' | 'vvf-services' | 'converge', readonly string[]>> = {
  deferred: [
    'sddcId',
    'workflowType',
    'vcfInstanceName',
    'version',
    'ceipEnabled',
    'vcenterSpec',
    'sddcManagerSpec',
    'vcfOperationsSpec',
    'vcfOperationsCollectorSpec',
    'licenseServerSpec',
    'vcfAutomationSpec',
    'vcfManagementComponentsInfrastructureSpec',
    'securitySpec',
  ],
  'vvf-services': [
    'sddcId',
    'workflowType',
    'vcfInstanceName',
    'version',
    'ceipEnabled',
    'skipEsxThumbprintValidation',
    'vcenterSpec',
    'vcfOperationsSpec',
    'vspClusterSpec',
    'licenseServerSpec',
    'vcfManagementComponentsInfrastructureSpec',
    'securitySpec',
  ],
  converge: [
    'sddcId',
    'workflowType',
    'vcfInstanceName',
    'version',
    'ceipEnabled',
    'managementPoolName',
    'vcenterSpec',
    'nsxtSpec',
    'sddcManagerSpec',
    'vspClusterSpec',
    'vidbSpec',
    'vcfOperationsSpec',
    'vcfOperationsCollectorSpec',
    'vcfAutomationSpec',
    'licenseServerSpec',
    'vcfManagementComponentsInfrastructureSpec',
    'securitySpec',
  ],
};

/** The first key of a dotted path: `vcenterSpec` for `vcenterSpec.rootVcenterPassword`. */
const topKey = (path: string): string => path.split(/[.[]/)[0] ?? path;

/**
 * Build a complete VCF 9.1 SddcSpec from a deployment plan.
 */
export function buildSddcSpec(plan: DeploymentPlan): BuildResult {
  const findings: Finding[] = [];
  const placeholders: string[] = [];
  const autoGenerated: string[] = [];
  const domain = plan.domainSuffix.toLowerCase();
  const prefix = plan.namePrefix ?? plan.sddcId;
  const preset = plan.sizePreset ? SIZE_PRESETS[plan.sizePreset] : undefined;
  const ha = preset ? preset.ha : plan.profile === 'ha';
  // Several documented defaults move between patch releases, so they are
  // resolved against the version actually being deployed.
  const targetVersion = plan.version ?? DEFAULT_VCF_VERSION;
  const versions = plan.componentVersions ?? {};
  const versionOf = (key: VersionedComponent): { version?: string } =>
    versions[key] ? { version: versions[key] } : {};

  // --- deployment scenario -------------------------------------------------
  // Broadcom's decision table fixes workflowType and which components take part
  // for each supported scenario. Resolving it once here keeps every downstream
  // choice consistent with a single published row, instead of each component
  // deciding for itself and drifting out of agreement with the others.
  const scenario: DeploymentScenario = plan.scenario ?? deriveScenario(plan);
  const rule = scenarioRule(scenario);
  const workflowType: WorkflowType = plan.workflowType ?? rule.workflowType;
  // A further instance joins an existing fleet: its VCF Operations is the
  // fleet's, and it declares no fleetFqdn.
  const secondary = plan.instanceRole === 'secondary' || workflowType === 'VCF_EXTEND';

  // Broadcom's samples for these runs carry only the component blocks.
  const shape: 'full' | 'minimal' =
    plan.documentShape ??
    (scenario === 'deferred-components' || scenario === 'vvf-management-services' ? 'minimal' : 'full');
  const minimal = shape === 'minimal';
  const minimalKind: 'deferred' | 'vvf-services' | 'converge' =
    scenario === 'deferred-components'
      ? 'deferred'
      : scenario === 'vvf-management-services'
        ? 'vvf-services'
        : 'converge';

  // Where the fleet-level components live is a named model, so a spec can state
  // which one it represents instead of landing in one by accident.
  const networkModel = managementNetworkModel(
    plan.managementNetworkModel ?? deriveManagementNetworkModel(plan),
  );

  /** Presence of a component whose column is a presence column, not a flag. */
  const includes = (
    cell: (typeof rule)['managementServices'],
    requested: boolean | undefined,
    column: string,
    conditional = false,
  ): boolean => {
    // The * footnote: required only when the existing VCF Operations does not
    // already have the component, so leaving it out is a legitimate choice.
    if (conditional && requested === false) {
      findings.push(
        info(
          'vcf.build.scenario-conditional-omitted',
          `${column} is left out. "${rule.label}" requires it only when the existing VCF Operations does not already have one.`,
          { path: column, source: 'VCF 9.1 Deployment — Use a JSON Specification File' },
        ),
      );
      return false;
    }
    const { value, conflict } = resolveFlag(cell, requested, true);
    if (conflict) {
      findings.push(
        warning(
          'vcf.build.scenario-conflict',
          `The plan asks for ${column}, but "${rule.label}" does not include that component.`,
          {
            path: column,
            remediation: `Choose a scenario that includes it, or drop ${column} from the plan.`,
            source: 'VCF 9.1 Deployment — Use a JSON Specification File',
          },
        ),
      );
    }
    return value;
  };

  /** Warn when the plan's brownfield inputs disagree with the scenario's row. */
  const checkExisting = (
    cell: (typeof rule)['vcenterExisting'],
    supplied: boolean,
    column: string,
  ): void => {
    if (cell === 'either' || cell === 'na') return;
    const expected = cell === 'true';
    if (supplied !== expected) {
      findings.push(
        warning(
          'vcf.build.scenario-existing-mismatch',
          `"${rule.label}" expects ${column} useExistingDeployment to be ${expected}, but the plan ${supplied ? 'supplies' : 'does not supply'} an existing component.`,
          {
            path: column,
            remediation: expected
              ? `Add existing.${column} with its FQDN and SSL thumbprint, or pick a scenario that deploys it new.`
              : `Remove existing.${column}, or pick a converge scenario.`,
            source: 'VCF 9.1 Deployment — Use a JSON Specification File',
          },
        ),
      );
    }
  };

  checkExisting(rule.vcenterExisting, plan.existing?.vcenter !== undefined, 'vcenter');
  checkExisting(rule.nsxExisting, plan.existing?.nsx !== undefined, 'nsx');
  checkExisting(
    rule.operationsExisting,
    secondary || plan.existing?.operations !== undefined,
    'operations',
  );
  checkExisting(rule.automationExisting, plan.existing?.automation !== undefined, 'automation');

  if (plan.workflowType && plan.workflowType !== rule.workflowType) {
    findings.push(
      warning(
        'vcf.build.workflow-type-override',
        `workflowType "${plan.workflowType}" was supplied, but "${rule.label}" is documented as "${rule.workflowType}". The plan's value is used.`,
        {
          path: 'workflowType',
          source: 'VCF 9.1 Deployment — Use a JSON Specification File',
        },
      ),
    );
  }

  const conditional = (column: 'licenseServer' | 'identityBroker'): boolean =>
    rule.conditionalPresence?.includes(column) ?? false;

  // Neither the deferred-components run nor VCF management services for VVF
  // touches NSX: Broadcom's examples carry no nsxtSpec.
  const includeNsx = componentTakesPart(rule, rule.nsxExisting) && !(minimal && minimalKind !== 'converge');
  const includeManagementServices = includes(
    rule.managementServices,
    plan.includeManagementServices,
    'includeManagementServices',
  );
  const includeLicenseServer = includes(
    rule.licenseServer,
    plan.includeLicenseServer,
    'licenseServerSpec',
    conditional('licenseServer'),
  );
  const brokerRequested =
    plan.identityBrokerModel === 'embedded'
      ? false
      : plan.identityBrokerModel === 'instance'
        ? true
        : plan.includeIdentityBroker;
  const includeIdentityBroker = includes(
    rule.identityBroker,
    brokerRequested,
    'includeIdentityBroker',
    conditional('identityBroker'),
  );
  if (plan.identityBrokerModel === 'embedded') {
    findings.push(
      info(
        'vcf.build.identity-broker-embedded',
        'Embedded identity broker model: the broker runs as a vCenter service, one per instance, so no vidbSpec is emitted. Broadcom positions it for lab and proof-of-concept use.',
        { path: 'vidbSpec', source: 'VCF 9.1 Design Library — Identity Broker Detailed Design' },
      ),
    );
  }

  if (rule.workflowType === 'VVF' && !includeManagementServices) {
    findings.push(
      warning(
        'vcf.build.vvf-without-management-services',
        'A vSphere Foundation platform without VCF management services requires the VCF Installer appliance to be reconfigured before this spec is uploaded. No JSON field expresses this step.',
        {
          remediation: VVF_WITHOUT_MANAGEMENT_SERVICES_PREREQUISITE,
          source: 'VCF 9.1 Deployment — Use a JSON Specification File',
        },
      ),
    );
  }

  findings.push(
    info('vcf.build.scenario', `Built as "${rule.label}" (workflowType ${rule.workflowType}).`, {
      source: 'VCF 9.1 Deployment — Use a JSON Specification File',
    }),
  );
  for (const override of rule.supersedesTable ?? []) {
    findings.push(
      info(
        'vcf.build.scenario-table-superseded',
        `${override.column} is set to ${override.used}, not the ${override.tableValue} in Broadcom's summary table. ${override.reason}`,
        {
          path: override.column,
          source: 'VCF 9.1 Deployment — Deploy Deferred Components',
        },
      ),
    );
  }
  if (minimal) {
    findings.push(
      info(
        'vcf.build.minimal-document',
        `Emitted as a minimal document: only the component blocks${scenario === 'vvf-management-services' ? ' and the existing vCenter' : ' and the existing vCenter and SDDC Manager'}, as Broadcom's worked example for "${rule.label}" does. VERIFY: the schema marks networkSpecs and dnsSpec required, but Broadcom's own examples for this workflow omit them.`,
        { source: 'VCF 9.1 Deployment — Broadcom sample specifications' },
      ),
    );
  }

  type FqdnKey = keyof NonNullable<DeploymentPlan['fqdnOverrides']>;

  /** Resolve a component FQDN, honouring any per-component override. */
  const name = (key: FqdnKey, shortName: string): string =>
    plan.fqdnOverrides?.[key] ?? fqdn(shortName, domain);

  /** An existing component's own FQDN wins over any generated name. */
  const existingName = (component: ExistingComponent | undefined, key: FqdnKey, shortName: string): string =>
    component?.fqdn ? component.fqdn.toLowerCase() : name(key, shortName);

  const secret = (key: string, path: string): string => {
    const value = plan.passwords?.[key];
    if (value) return value;
    placeholders.push(path);
    return PLACEHOLDER_SECRET;
  };

  /**
   * A secret the API auto-generates when blank. With autoGeneratePasswords it
   * is left blank rather than carrying a placeholder; `allowed` is false where
   * the value must be the existing component's real password.
   */
  const generatable = (key: string, path: string, allowed = true): string => {
    const value = plan.passwords?.[key];
    if (value) return value;
    if (plan.autoGeneratePasswords && allowed) {
      autoGenerated.push(path);
      return '';
    }
    placeholders.push(path);
    return PLACEHOLDER_SECRET;
  };

  /** An existing component's thumbprint, or a placeholder the validator flags. */
  const thumbprint = (component: ExistingComponent | undefined, path: string): string => {
    if (component?.sslThumbprint) return component.sslThumbprint;
    placeholders.push(path);
    return PLACEHOLDER_SECRET;
  };

  // --- which components are reused ------------------------------------------
  // A row whose cell is fixed at true reuses the component whether or not the
  // plan named it; the missing FQDN or thumbprint is then reported rather than
  // silently replaced by a newly generated component.
  const existing: NonNullable<DeploymentPlan['existing']> = plan.existing ?? {};
  const vcenterExisting = existing.vcenter !== undefined || rule.vcenterExisting === 'true';
  const nsxExisting = existing.nsx !== undefined || rule.nsxExisting === 'true';
  const opsExisting = existing.operations !== undefined || rule.operationsExisting === 'true' || secondary;
  const automationExisting = existing.automation !== undefined || rule.automationExisting === 'true';
  const sddcManagerExisting = existing.sddcManager !== undefined || scenario === 'deferred-components';
  const licenseExisting = existing.licenseServer !== undefined;
  const collectorExisting = existing.collector !== undefined;
  const vspExisting = existing.managementServices !== undefined;

  const reportImplied = (component: string, supplied: ExistingComponent | undefined, reused: boolean): void => {
    if (!reused || supplied?.fqdn) return;
    findings.push(
      warning(
        'vcf.build.existing-component-not-supplied',
        `"${rule.label}" reuses the existing ${component}, but the plan does not name it, so a generated FQDN and a placeholder thumbprint are emitted.`,
        {
          path: `existing.${component}`,
          remediation: `Supply existing.${component}.fqdn and its SHA256 SSL thumbprint.`,
          source: 'VCF 9.1 Deployment — Use a JSON Specification File',
        },
      ),
    );
  };
  // vCenter, NSX and Automation are already reported by the row check above.
  if (secondary && !existing.operations) reportImplied('operations', existing.operations, true);

  // --- hosts ---------------------------------------------------------------
  // Explicit host detail wins; otherwise names are generated from the base.
  const hostSpecs: SddcHostSpec[] = (plan.hosts?.length
    ? plan.hosts
    : Array.from(
        { length: plan.hostCount },
        (_, i): HostEntry => ({ hostname: `${plan.esxHostnameBase}${pad(i + 1)}` }),
      )
  ).map((entry, i) => ({
    hostname: entry.hostname,
    credentials: {
      username: entry.username ?? 'root',
      password:
        entry.password ??
        plan.esxRootPassword ??
        secret('esxRoot', `hostSpecs[${i}].credentials.password`),
    },
    ...(entry.sshThumbprint ? { sshThumbprint: entry.sshThumbprint } : {}),
    ...(entry.sslThumbprint ? { sslThumbprint: entry.sslThumbprint } : {}),
  }));

  // Thumbprints are only omittable when validation is explicitly skipped.
  const missingThumbprints = hostSpecs.filter((h) => !h.sslThumbprint && !h.sshThumbprint).length;
  if (missingThumbprints > 0 && !minimal) {
    findings.push(
      info(
        'vcf.build.hosts-without-thumbprints',
        `${missingThumbprints} host(s) have no SSH or SSL thumbprint, so skipEsxThumbprintValidation must stay true.`,
        {
          path: 'hostSpecs',
          remediation:
            'Supply per-host thumbprints to validate host identity during bring-up, or leave validation skipped.',
          source: 'VCF Installer API — SddcHostSpec',
        },
      ),
    );
  }

  const duplicateHostnames = hostSpecs
    .map((h) => h.hostname)
    .filter((name, i, all) => all.indexOf(name) !== i);
  if (duplicateHostnames.length > 0) {
    findings.push(
      warning(
        'vcf.build.duplicate-hostnames',
        `Duplicate host name(s): ${[...new Set(duplicateHostnames)].join(', ')}.`,
        { path: 'hosts' },
      ),
    );
  }

  // --- networks ------------------------------------------------------------
  const networkSpecs: SddcNetworkSpec[] = [];
  const mgmtCidr = parseCidr(plan.management.cidr);

  checkNetworkPlan('Management', 'management', plan.management, findings);
  checkNetworkPlan('VM management', 'vmManagement', plan.vmManagement, findings);
  checkNetworkPlan('vMotion', 'vmotion', plan.vmotion, findings);
  checkNetworkPlan('vSAN', 'vsan', plan.vsan, findings);
  checkNetworkPlan('NFS', 'nfs', plan.nfs, findings);
  checkNetworkPlan('Fleet management', 'fleetManagement', plan.fleetManagement, findings);

  /** Host VMkernel range at a fixed offset, one address per host. */
  const hostRange = (cidrText: string, offset: number): IpRange[] | undefined => {
    const cidr = parseCidr(cidrText);
    if (!cidr) return undefined;
    const range = allocateRange(cidr, offset, Math.max(plan.hostCount, 1));
    return range ? [{ startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) }] : [];
  };

  const mgmt = networkSpec('MANAGEMENT', plan.management, {
    portGroupKey: `${prefix}-pg-mgmt`,
  });
  if (mgmt) networkSpecs.push(mgmt);

  // VM management commonly shares the management VLAN; the installer still
  // wants it declared as its own network with its own port group.
  // Sharing the management network's addressing does not share its port group.
  const vmMgmtOwnPlan: NetworkPlan = plan.vmManagement ?? {
    ...plan.management,
    portGroupName: undefined,
    ipRanges: undefined,
    ipAddresses: undefined,
  };
  const vmMgmt = networkSpec('VM_MANAGEMENT', vmMgmtOwnPlan, {
    portGroupKey: `${prefix}-pg-vm-mgmt`,
  });
  if (vmMgmt) networkSpecs.push(vmMgmt);

  const vmotionRange = hostRange(plan.vmotion.cidr, 9);
  const vmotion = networkSpec('VMOTION', { mtu: DEFAULT_MTU, ...plan.vmotion }, {
    portGroupKey: `${prefix}-pg-vmotion`,
    ...(vmotionRange ? { includeIpAddressRanges: vmotionRange } : {}),
  });
  if (vmotion) networkSpecs.push(vmotion);

  if (plan.vsan && (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa')) {
    const vsanRange = hostRange(plan.vsan.cidr, 1);
    const vsan = networkSpec('VSAN', { mtu: DEFAULT_MTU, ...plan.vsan }, {
      portGroupKey: `${prefix}-pg-vsan`,
      ...(vsanRange ? { includeIpAddressRanges: vsanRange } : {}),
    });
    if (vsan) networkSpecs.push(vsan);
  }

  if (plan.nfs) {
    const nfs = networkSpec('NFS', { mtu: DEFAULT_MTU, ...plan.nfs }, {
      portGroupKey: `${prefix}-pg-nfs`,
    });
    if (nfs) networkSpecs.push(nfs);
  } else if (plan.storage === 'nfs' && !existing.datastoreName && !minimal) {
    // NFS principal storage needs its own VMkernel network; without one the
    // hosts cannot mount the datastore.
    findings.push(
      error('vcf.build.nfs-network-missing', 'NFS principal storage is selected but no NFS network was planned, so networkSpecs has no NFS entry.', {
        path: 'nfs',
        remediation: 'Add the NFS network: its CIDR and VLAN (and MTU, default 9000).',
        source: 'VCF Installer API — SddcNetworkSpec',
      }),
    );
  }

  if (plan.fleetManagement) {
    const fleet = networkSpec('FLEET_MANAGEMENT', plan.fleetManagement, {
      portGroupKey: `${prefix}-pg-fleet`,
    });
    if (fleet) networkSpecs.push(fleet);
  }

  // Dual stack: emit an IPv6 twin for every network that defines an ipv6Cidr.
  // The API has no dual-stack field, so a network carrying both address
  // families is expressed as two entries sharing a VLAN.
  if (plan.dualStack) {
    const v6Candidates: [NetworkType, NetworkPlan | undefined][] = [
      ['MANAGEMENT', plan.management],
      ['VM_MANAGEMENT', vmMgmtOwnPlan],
      ['VMOTION', plan.vmotion],
      ['VSAN', plan.vsan],
      ['NFS', plan.nfs],
      ['FLEET_MANAGEMENT', plan.fleetManagement],
    ];

    // Static vMotion and vSAN addresses are handed out from the same host
    // numbers IPv4 uses, so esx01 is ::a in vMotion as it is .10.
    const hostRangeOffset: Partial<Record<NetworkType, number>> = { VMOTION: 9, VSAN: 1 };

    let emitted = 0;
    for (const [type, netPlan] of v6Candidates) {
      if (!netPlan?.ipv6Cidr) continue;
      if (type === 'VSAN' && plan.storage !== 'vsan-esa' && plan.storage !== 'vsan-osa') continue;
      const cidr6 = v6Cidr(netPlan.ipv6Cidr);
      const offset = hostRangeOffset[type];
      const range =
        cidr6 && offset !== undefined && (netPlan.assignmentMode ?? 'STATIC') === 'STATIC'
          ? allocateRange6(cidr6, offset, Math.max(plan.hostCount, 1))
          : null;
      const v6 = networkSpecV6(type, netPlan, {
        portGroupKey: `${prefix}-pg-${type.toLowerCase().replace(/_/g, '-')}-v6`,
        ...(range ? { includeIpAddressRanges: [{ startIpAddress: range.start, endIpAddress: range.end }] } : {}),
      });
      if (v6) {
        networkSpecs.push(v6);
        emitted += 1;
        // IPv4 defaults a gateway to the first address; IPv6 gateways are as
        // often a link-local router address, so none is invented.
        const routed =
          type === 'MANAGEMENT' || type === 'FLEET_MANAGEMENT' || (type === 'VM_MANAGEMENT' && plan.vmManagement);
        if (!v6.gateway && routed) {
          findings.push(
            warning(
              'vcf.build.ipv6-no-gateway',
              `The IPv6 ${type} network ${v6.subnet} has no gateway, so its components cannot route IPv6 off the subnet.`,
              { path: `${type === 'MANAGEMENT' ? 'management' : type === 'VM_MANAGEMENT' ? 'vmManagement' : 'fleetManagement'}.ipv6Gateway` },
            ),
          );
        }
      }
    }

    if (emitted === 0) {
      findings.push(
        warning(
          'vcf.build.dual-stack-without-v6',
          'Dual stack is enabled but no network defines an IPv6 prefix, so no IPv6 networks were emitted.',
          { path: 'dualStack', remediation: 'Set ipv6Cidr on the networks that should carry IPv6.' },
        ),
      );
    } else {
      findings.push(
        info(
          'vcf.build.dual-stack',
          `Emitted ${emitted} IPv6 network(s). Note the API declares maxLength 15 on gateway and 18 on subnet, sized for IPv4; whether those bounds are relaxed for IPv6 is not documented.`,
          { source: 'VCF Installer API — SddcNetworkSpec' },
        ),
      );
      // VCF Automation's pool is a bare address list with no IPv6 form, so
      // only IPv4 is emitted there.
      if (plan.includeAutomation !== false) {
        findings.push(
          info(
            'vcf.build.automation-ipv4-only',
            'VERIFY: vcfAutomationSpec.ipPool is emitted as IPv4 only. The 9.1 API documents no IPv6 form for it, unlike vspClusterSpec.ipv6Pool.',
            { path: 'vcfAutomationSpec.ipPool', source: 'VCF Installer API — VcfAutomationSpec' },
          ),
        );
      }
    }
  } else {
    const ignored = (
      [
        ['management', plan.management],
        ['vmManagement', plan.vmManagement],
        ['vmotion', plan.vmotion],
        ['vsan', plan.vsan],
        ['nfs', plan.nfs],
        ['fleetManagement', plan.fleetManagement],
      ] as const
    ).filter(([, p]) => p?.ipv6Cidr);
    if (ignored.length > 0) {
      findings.push(
        info(
          'vcf.build.ipv6-without-dual-stack',
          `IPv6 prefixes are set on ${ignored.map(([k]) => k).join(', ')} but dual stack is off, so no IPv6 networks were emitted.`,
          { path: 'dualStack', remediation: 'Turn on dual stack to emit them.' },
        ),
      );
    }
  }

  // --- NSX -----------------------------------------------------------------
  // VLAN-backed VPC and TEP-less are the same deployment seen from two sides:
  // NO_IP disables VTEP creation, which is what enables a VLAN-backed VPC.
  const vlanBackedVpc = plan.vpcNetworkConfigurationType === 'VLAN_BACKED_VPC';
  const tepLess = plan.tepLess === true || vlanBackedVpc;
  if (plan.tepLess && plan.vpcNetworkConfigurationType === 'FULL_STACK_VPC') {
    findings.push(
      warning(
        'vcf.build.tepless-full-stack-vpc',
        'TEP-less (vtepType NO_IP) creates no host overlay VTEPs, which is the VLAN-backed VPC configuration, but the VPC type is FULL_STACK_VPC.',
        {
          path: 'vpcNetworkConfigurationType',
          remediation: 'Use VLAN_BACKED_VPC with TEP-less, or keep TEPs for a full-stack VPC.',
          source: 'VCF Installer API — OverlayVtepSpec',
        },
      ),
    );
  }
  if (tepLess && compareVcfVersion(targetVersion, '9.1.1.0') < 0) {
    findings.push(
      warning(
        'vcf.build.tepless-before-9-1-1',
        `VLAN-backed VPC and TEP-less deployment are VCF 9.1.1 features, but the target version is ${targetVersion}.`,
        { path: 'version', source: 'VCF 9.1.1 release notes' },
      ),
    );
  }

  // The installer's host TEP pool is IPv4 only (see spec-validate), so IPv6
  // for it is refused here rather than emitted into a pool that rejects it.
  const tepV6 = [plan.hostTep.cidr, plan.hostTep.gateway, plan.hostTep.ipv6Cidr, plan.hostTep.ipv6Gateway].filter(
    (v): v is string => typeof v === 'string' && familyOf(v) === 6,
  );
  if (tepV6.length > 0 && !tepLess) {
    findings.push(
      error(
        'vcf.build.tep-ipv6-unsupported',
        `NSX host TEP pool on VCF 9.1 does not support IPv6 (${tepV6.join(', ')}); no IPv6 TEP configuration was emitted.`,
        {
          path: 'hostTep',
          remediation:
            'Give the host TEP network an IPv4 cidr. VERIFY: IPv6 host TEPs are an NSX capability the VCF 9.1 installer spec does not document.',
          source: 'VCF Installer API — IpAddressPoolSubnetSpec',
        },
      ),
    );
  }
  const tepMode = plan.tepMode ?? 'static';
  const tepCidr = parseCidr(plan.hostTep.cidr);
  const tepCount = plan.tepPool?.count ?? plan.hostCount * (plan.pnicsPerHost ?? 2);
  const tepRange = tepCidr
    ? allocateRange(tepCidr, plan.tepPool?.offset ?? 9, Math.max(tepCount, 1))
    : null;
  const tepPoolName = plan.tepPoolName ?? `${prefix}-tep01`;
  const ignoreUnavailable =
    plan.ignoreUnavailableNsxtCluster !== undefined
      ? { ignoreUnavailableNsxtCluster: plan.ignoreUnavailableNsxtCluster }
      : {};

  const ipAddressPoolSpec =
    tepLess || tepMode === 'dhcp'
      ? undefined
      : tepMode === 'existing-pool'
        ? { name: tepPoolName, ...ignoreUnavailable }
        : tepCidr && tepRange
          ? {
              name: tepPoolName,
              description: 'ESXi host overlay TEP IP pool',
              ...ignoreUnavailable,
              subnets: [
                {
                  cidr: plan.hostTep.cidr,
                  gateway: gatewayFor(plan.hostTep, tepCidr),
                  // Note: start/end here, unlike the startIpAddress/endIpAddress
                  // used by networkSpecs. This asymmetry is in the API itself.
                  ipAddressPoolRanges: [
                    { start: formatIPv4(tepRange.start), end: formatIPv4(tepRange.end) },
                  ],
                },
              ],
            }
          : undefined;
  if (!tepLess && tepMode === 'dhcp') {
    findings.push(
      info(
        'vcf.build.tep-dhcp',
        'Host TEPs use DHCP: no ipAddressPoolSpec is emitted. VERIFY: the API does not state that an absent pool means DHCP.',
        { path: 'nsxtSpec.ipAddressPoolSpec', source: 'VCF Installer API — SddcNsxtSpec' },
      ),
    );
  }

  const nsxManagerCount = plan.nsxManagerCount ?? preset?.nsxManagerCount ?? (ha ? 3 : 1);
  const nsxManagers = existing.nsx
    ? (existing.nsx.nodeFqdns?.length ? existing.nsx.nodeFqdns : [existing.nsx.fqdn]).map((h) => ({ hostname: h.toLowerCase() }))
    : nsxManagerCount === 3
      ? ([1, 2, 3] as const).map((n) => ({
          hostname: name(`nsxManager${n}` as FqdnKey, `${prefix}-nsx${pad(n)}`),
        }))
      : [{ hostname: name('nsxManager1', `${prefix}-nsx01`) }];
  if (existing.nsx && !existing.nsx.nodeFqdns?.length) {
    findings.push(
      info(
        'vcf.build.existing-nsx-nodes',
        'The existing NSX Manager node FQDNs were not supplied, so nsxtManagers carries the VIP FQDN.',
        { path: 'existing.nsx.nodeFqdns', remediation: 'List the existing NSX Manager node FQDNs.' },
      ),
    );
  }
  const edgeSync = plan.enableEdgeClusterSync ?? true;

  const nsxtSpec: SddcNsxtSpec = {
    nsxtManagers: nsxManagers,
    vipFqdn: existingName(existing.nsx, 'nsxVip', `${prefix}-nsx`),
    ...(nsxExisting ? {} : { nsxtManagerSize: plan.nsxManagerSize ?? preset?.nsxManagerSize ?? 'medium' }),
    rootNsxtManagerPassword: generatable('nsxRoot', 'nsxtSpec.rootNsxtManagerPassword', !nsxExisting),
    nsxtAdminPassword: generatable('nsxAdmin', 'nsxtSpec.nsxtAdminPassword', !nsxExisting),
    nsxtAuditPassword: generatable('nsxAudit', 'nsxtSpec.nsxtAuditPassword', !nsxExisting),
    transportVlanId: plan.hostTep.vlanId,
    ...(ipAddressPoolSpec ? { ipAddressPoolSpec } : {}),
    ...(tepLess ? { overlayVtepSpec: { vtepType: 'NO_IP' as const } } : {}),
    ...(plan.skipNsxOverlayOverManagementNetwork !== undefined
      ? { skipNsxOverlayOverManagementNetwork: plan.skipNsxOverlayOverManagementNetwork }
      : {}),
    ...versionOf('nsx'),
    ...(nsxExisting
      ? {
          useExistingDeployment: true,
          sslThumbprint: thumbprint(existing.nsx, 'nsxtSpec.sslThumbprint'),
          enableEdgeClusterSync: edgeSync,
        }
      : {}),
  };

  if (nsxExisting && edgeSync) {
    findings.push(
      warning(
        'vcf.build.edge-cluster-sync',
        'enableEdgeClusterSync is true: importing the existing NSX triggers a one-time reset of the NSX Edge node passwords.',
        {
          path: 'nsxtSpec.enableEdgeClusterSync',
          remediation: 'Set enableEdgeClusterSync to false to leave the Edge passwords alone.',
          source: 'VCF Installer API — SddcNsxtSpec',
        },
      ),
    );
  }
  if (!nsxExisting && plan.enableEdgeClusterSync !== undefined) {
    findings.push(
      info('vcf.build.edge-cluster-sync-ignored', 'enableEdgeClusterSync applies only to an imported NSX, so it is not emitted.', {
        path: 'enableEdgeClusterSync',
      }),
    );
  }
  if (plan.skipNsxOverlayOverManagementNetwork !== undefined && !vcenterExisting) {
    findings.push(
      info(
        'vcf.build.skip-nsx-overlay-greenfield',
        'skipNsxOverlayOverManagementNetwork is documented for an existing vCenter being converted; Broadcom’s greenfield sample sets it anyway.',
        { path: 'nsxtSpec.skipNsxOverlayOverManagementNetwork', source: 'VCF Installer API — SddcNsxtSpec' },
      ),
    );
  }

  // A TEP-less deployment creates no host overlay VTEPs, so a TEP pool would
  // be meaningless alongside it.
  if (tepLess) {
    findings.push(
      info(
        'vcf.build.tep-less',
        `TEP-less deployment${vlanBackedVpc ? ' (VLAN-backed VPC)' : ''} selected: no host overlay TEP pool is emitted.`,
        { source: 'VCF 9.1.1 TEP-less deployments' },
      ),
    );
  }

  // The DTGW block's gateway and IP blocks are only documented with IPv4
  // values, so IPv6 is not emitted there until that is confirmed.
  const vpcType = plan.vpcNetworkConfigurationType ?? (plan.tepLess ? 'VLAN_BACKED_VPC' : 'FULL_STACK_VPC');
  const dtgwV6 = plan.dtgw
    ? [plan.dtgw.gatewayCidr, plan.dtgw.externalIpBlockCidr, plan.dtgw.privateTgwIpBlockCidr].filter(
        (v): v is string => typeof v === 'string' && familyOf(v) === 6,
      )
    : [];
  if (plan.dtgw && vpcType === 'VLAN_BACKED_VPC') {
    findings.push(
      warning(
        'vcf.build.dtgw-with-vlan-backed-vpc',
        'A VLAN-backed VPC has no distributed transit gateway, so the planned DTGW is not emitted.',
        { path: 'dtgw', remediation: 'Remove the DTGW, or choose a full-stack VPC.' },
      ),
    );
    nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: vpcType };
  } else if (dtgwV6.length > 0) {
    findings.push(
      warning(
        'vcf.build.dtgw-ipv6-unverified',
        `VERIFY: the distributed transit gateway was given IPv6 (${dtgwV6.join(', ')}). The 9.1 DtgwSpec documents IPv4 blocks only, so dtgwSpec was not emitted.`,
        {
          path: 'dtgw',
          remediation: 'Use IPv4 blocks for the bring-up DTGW and add IPv6 VPC blocks in NSX after deployment.',
          source: 'VCF Installer API — DtgwSpec',
        },
      ),
    );
    nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: vpcType };
  } else if (plan.dtgw) {
    nsxtSpec.vpcSpec = {
      vpcNetworkConfigurationType: vpcType,
      dtgwSpec: {
        vlan: plan.dtgw.vlan,
        gatewayCidr: plan.dtgw.gatewayCidr,
        externalIpBlockCidr: plan.dtgw.externalIpBlockCidr,
        privateTgwIpBlockCidr: plan.dtgw.privateTgwIpBlockCidr,
      },
    };
  } else if (plan.vpcNetworkConfigurationType || tepLess) {
    nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: vpcType };
  }

  if (tepCidr && !tepRange && !tepLess && tepMode === 'static') {
    findings.push(
      warning(
        'vcf.build.tep-pool-not-allocated',
        `Could not fit ${tepCount} TEP addresses in ${plan.hostTep.cidr}.`,
        { path: 'hostTep.cidr', remediation: 'Use a larger TEP subnet.' },
      ),
    );
  }

  // --- VCF Management Services (vSphere Supervisor) ------------------------
  // The VCFMS pool lives in the management subnet unless a dedicated fleet
  // management network was planned.
  // The shared model puts fleet-level components on the port group the
  // Instance-level components already use, which is the VM management network
  // when one is planned separately from management.
  const sharedHomeCidr = plan.vmManagement ? parseCidr(plan.vmManagement.cidr) : mgmtCidr;
  const vcfmsHomeCidr =
    networkModel.requiresDedicatedNetwork && plan.fleetManagement
      ? parseCidr(plan.fleetManagement.cidr)
      : sharedHomeCidr;
  const vcfmsPool = buildPool(plan.vcfmsPool, vcfmsHomeCidr, 31, VCFMS_RECOMMENDED_IPS);
  // On dual stack the services runtime takes an IPv6 pool too, carved from the
  // IPv6 prefix of whichever network the IPv4 pool came from, at the same
  // offset. An explicit vcfmsIpv6Pool is honoured with or without dual stack.
  const vcfmsHomePlan =
    networkModel.requiresDedicatedNetwork && plan.fleetManagement
      ? plan.fleetManagement
      : (plan.vmManagement ?? plan.management);
  const vcfmsHomeV6 = plan.dualStack ? v6Cidr(vcfmsHomePlan.ipv6Cidr) : null;
  const vcfmsIpv6 =
    plan.vcfmsIpv6Pool || vcfmsHomeV6
      ? buildPoolV6(plan.vcfmsIpv6Pool, vcfmsHomeV6, 31, VCFMS_RECOMMENDED_IPS)
      : null;
  if (!vcfmsIpv6 && (plan.vcfmsIpv6Pool || vcfmsHomeV6) && includeManagementServices && !vspExisting) {
    findings.push(
      warning(
        'vcf.build.vcfms-ipv6-pool-not-allocated',
        `Could not build the VCF Management Services IPv6 pool${vcfmsHomeV6 ? ` from ${vcfmsHomePlan.ipv6Cidr}` : ''}.`,
        {
          path: 'vcfmsIpv6Pool',
          remediation: 'Give vcfmsIpv6Pool an IPv6 CIDR or address list, or widen the IPv6 prefix it is carved from.',
        },
      ),
    );
  }

  const fleetFqdnValue = name('vspFleet', `${prefix}-flt01`);
  const instanceFqdnValue = name('vspInstance', `${prefix}-int01`);
  // An existing runtime is referenced, not redeployed: no pool, size, internal
  // CIDRs or password. VERIFY: the API marks ipv4Pool required without saying
  // whether that holds for an existing deployment.
  const vspClusterSpec: SddcVspClusterSpec = vspExisting
    ? ({
        platformFqdn: existingName(existing.managementServices, 'vspPlatform', `${prefix}-msr01`),
        instanceFqdn: instanceFqdnValue,
        ...(secondary ? {} : { fleetFqdn: fleetFqdnValue }),
        ...versionOf('managementServices'),
        useExistingDeployment: true,
        sslThumbprint: thumbprint(existing.managementServices, 'vspClusterSpec.sslThumbprint'),
      } as SddcVspClusterSpec)
    : {
        platformFqdn: name('vspPlatform', `${prefix}-msr01`),
        instanceFqdn: instanceFqdnValue,
        // A secondary instance joins an existing fleet and must omit fleetFqdn.
        ...(secondary ? {} : { fleetFqdn: fleetFqdnValue }),
        ipv4Pool: vcfmsPool ?? {},
        ...(vcfmsIpv6 ? { ipv6Pool: vcfmsIpv6 } : {}),
        ...(plan.internalClusterCidrIpv6
          ? { internalClusterCidrIpv6: plan.internalClusterCidrIpv6 }
          : {}),
        systemUserPassword: generatable('vspSystem', 'vspClusterSpec.systemUserPassword'),
        size: plan.vspSize ?? preset?.vspSize ?? (ha ? 'small_ha' : 'small'),
        internalClusterCidrIpv4: plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0],
        // Present in a real working spec but absent from the published schema.
        name: plan.vspName ?? `${prefix}-vmsp-01`,
        ...versionOf('managementServices'),
        // Broadcom's VVF example states the new runtime explicitly.
        ...(scenario === 'vvf-management-services' ? { useExistingDeployment: false } : {}),
      };

  if (!vcfmsPool && includeManagementServices && !vspExisting) {
    findings.push(
      warning(
        'vcf.build.vcfms-pool-not-allocated',
        `Could not fit ${VCFMS_RECOMMENDED_IPS} VCF Management Services addresses in the management subnet.`,
        {
          path: 'vspClusterSpec.ipv4Pool',
          remediation:
            'Widen the management subnet, or add a dedicated FLEET_MANAGEMENT network for these components.',
          source: 'VCF 9.1 IP requirements',
        },
      ),
    );
  }

  // --- Operations ----------------------------------------------------------
  const includeOps = plan.includeOperations !== false;
  const opsNodeCount = plan.opsNodeCount ?? preset?.opsNodeCount ?? (ha ? 3 : 1);
  const opsSize = plan.opsSize ?? preset?.opsSize ?? defaultApplianceSize(targetVersion, ha);
  if (!opsExisting && opsNodeCount > 1 && opsSize === 'xsmall') {
    findings.push(
      error('vcf.build.ops-xsmall-ha', 'VCF Operations xsmall supports a single node only; HA needs small or larger.', {
        path: 'opsSize',
        source: 'VCF Installer API — VcfOperationsSpec',
      }),
    );
  }
  const opsNodeRoles: readonly ['opsPrimary' | 'opsReplica' | 'opsData', 'master' | 'replica' | 'data'][] = [
    ['opsPrimary', 'master'],
    ['opsReplica', 'replica'],
    ['opsData', 'data'],
  ];
  const opsLoadBalancer = plan.opsLoadBalancer ?? (ha && opsNodeCount > 1);

  // Reusing VCF Operations (a further instance, or a converge onto the fleet's
  // Operations) references exactly one node, the existing master, with its
  // thumbprint and the existing admin password; nothing is sized.
  const vcfOperationsSpec: VcfOperationsSpec | undefined = !includeOps
    ? undefined
    : opsExisting
      ? {
          nodes: [
            {
              hostname: existingName(existing.operations, 'opsPrimary', `${prefix}-ops01`),
              type: 'master',
              sslThumbprint: thumbprint(existing.operations, 'vcfOperationsSpec.nodes[0].sslThumbprint'),
            },
          ],
          adminUserPassword: generatable('opsAdmin', 'vcfOperationsSpec.adminUserPassword', false),
          useExistingDeployment: true,
          ...versionOf('operations'),
        }
      : {
          nodes: opsNodeRoles.slice(0, opsNodeCount).map(([key, type], i): VcfOperationsNode => ({
            hostname: name(key, `${prefix}-ops${pad(i + 1)}`),
            type,
            rootUserPassword: secret('opsRoot', `vcfOperationsSpec.nodes[${i}].rootUserPassword`),
          })),
          adminUserPassword: generatable('opsAdmin', 'vcfOperationsSpec.adminUserPassword'),
          applianceSize: opsSize,
          ...(opsLoadBalancer ? { loadBalancerFqdn: name('opsLoadBalancer', `${prefix}-ops`) } : {}),
          ...versionOf('operations'),
        };

  // The deferred-components example states useExistingDeployment:false outright.
  if (vcfOperationsSpec && !opsExisting && scenario === 'deferred-components') {
    vcfOperationsSpec.useExistingDeployment = false;
  }

  // --- cloud proxy -----------------------------------------------------------
  // The collector is an Instance-level component: every instance, including a
  // further one, deploys its own unless one is named as existing.
  const includeCollector = includeOps && scenario !== 'vvf-management-services';
  const vcfOperationsCollectorSpec: VcfOperationsCollectorSpec | undefined = !includeCollector
    ? undefined
    : collectorExisting
      ? {
          hostname: existingName(existing.collector, 'opsCollector', `${prefix}-proxy01`),
          useExistingDeployment: true,
          sslThumbprint: thumbprint(existing.collector, 'vcfOperationsCollectorSpec.sslThumbprint'),
          ...versionOf('collector'),
        }
      : {
          hostname: name('opsCollector', `${prefix}-proxy01`),
          rootUserPassword: secret('opsCollectorRoot', 'vcfOperationsCollectorSpec.rootUserPassword'),
          applianceSize: plan.collectorSize ?? preset?.collectorSize ?? 'small',
          ...(scenario === 'deferred-components' ? { useExistingDeployment: false } : {}),
          ...versionOf('collector'),
        };

  // --- License Server ----------------------------------------------------------
  const licenseServerSpec: LicenseServerSpec | undefined = !includeLicenseServer
    ? undefined
    : licenseExisting
      ? {
          hostname: existingName(existing.licenseServer, 'licenseServer', `${prefix}-lic01`),
          useExistingDeployment: true,
          sslThumbprint: thumbprint(existing.licenseServer, 'licenseServerSpec.sslThumbprint'),
          ...versionOf('licenseServer'),
        }
      : { hostname: name('licenseServer', `${prefix}-lic01`), ...versionOf('licenseServer') };

  // --- identity broker ---------------------------------------------------------
  const vidbSpec: VidbSpec | undefined = includeIdentityBroker
    ? {
        hostname: name('identityBroker', `${prefix}-idb01`),
        ...(plan.identityBrokerSize ? { size: plan.identityBrokerSize } : {}),
        ...versionOf('identityBroker'),
      }
    : undefined;
  if (plan.identityBrokerSize && !vidbSpec) {
    findings.push(
      info('vcf.build.identity-broker-size-ignored', 'identityBrokerSize is set but no vidbSpec is emitted, so it has no effect.', {
        path: 'identityBrokerSize',
      }),
    );
  }

  // --- Automation ----------------------------------------------------------
  // VVF has no VCF Automation at all.
  const includeAutomation =
    componentTakesPart(rule, rule.automationExisting) && plan.includeAutomation !== false;
  const automationPool = automationExisting
    ? null
    : buildPool(plan.automationPool, vcfmsHomeCidr, 31 + VCFMS_RECOMMENDED_IPS, automationIpCount(targetVersion));
  const automationCidr =
    plan.automationInternalClusterCidr ?? plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0];

  // An existing VCF Automation is referenced only: hostname, thumbprint and
  // the internal CIDR the API still requires; no platform FQDN, pool, prefix,
  // size or password.
  const vcfAutomationSpec: VcfAutomationSpec | undefined = !includeAutomation
    ? undefined
    : automationExisting
      ? {
          hostname: existingName(existing.automation, 'automation', `${prefix}-auto01`),
          internalClusterCidr: automationCidr,
          useExistingDeployment: true,
          sslThumbprint: thumbprint(existing.automation, 'vcfAutomationSpec.sslThumbprint'),
          ...versionOf('automation'),
        }
      : {
          hostname: name('automation', `${prefix}-auto01`),
          platformFqdn: name('automationPlatform', `${prefix}-asr01`),
          internalClusterCidr: automationCidr,
          adminUserPassword: generatable('automationAdmin', 'vcfAutomationSpec.adminUserPassword'),
          nodePrefix: (plan.automationNodePrefix ?? `${prefix}-node-01`).toLowerCase(),
          // vcfAutomationSpec.ipPool is a plain string array, not an IPv4Pool,
          // so whichever pool form was chosen is flattened to addresses here.
          ...(automationPool ? { ipPool: poolToAddresses(automationPool) } : {}),
          size: plan.automationSize ?? preset?.automationSize ?? defaultApplianceSize(targetVersion, ha),
          ...versionOf('automation'),
        };

  if (includeAutomation && !automationExisting && !automationPool) {
    findings.push(
      warning(
        'vcf.build.automation-pool-not-allocated',
        `Could not allocate ${automationIpCount(targetVersion)} VCF Automation addresses after the VCFMS pool.`,
        { path: 'vcfAutomationSpec.ipPool' },
      ),
    );
  }

  // --- security ------------------------------------------------------------
  const securitySpec: SecuritySpec | undefined =
    plan.esxiCertsMode || plan.rootCaCerts?.length
      ? {
          ...(plan.esxiCertsMode ? { esxiCertsMode: plan.esxiCertsMode } : {}),
          ...(plan.rootCaCerts?.length ? { rootCaCerts: plan.rootCaCerts.map((c) => ({ alias: c.alias, certChain: [...c.certChain] })) } : {}),
        }
      : undefined;

  if (plan.esxiCertsMode === 'Custom' && !plan.rootCaCerts?.length) {
    findings.push(
      warning(
        'vcf.build.custom-certs-without-ca',
        'esxiCertsMode is Custom but no root CA certificates were supplied.',
        {
          path: 'rootCaCerts',
          remediation: 'Provide the Base64-encoded CA chain, or use VMCA-issued certificates.',
          source: 'VCF Installer API — SecuritySpec',
        },
      ),
    );
  }

  // --- VCF management component networks -----------------------------------
  // xRegionNetwork names the port group or segment the fleet-level components
  // are placed on. Broadcom's examples use it for a dedicated VLAN port group,
  // an NSX segment, the converge placement and VCF management services for VVF;
  // they never use localRegionNetwork.
  const mc = plan.managementComponentNetworks;
  const fromNetworkPlan = (
    net: NetworkPlan,
    defaultPortGroup: string,
  ): VcfManagementComponentsNetworkSpec | undefined => {
    const cidr = parseCidr(net.cidr);
    if (!cidr) return undefined;
    const v6 = plan.dualStack ? v6Cidr(net.ipv6Cidr) : null;
    return {
      networkName: net.portGroupName ?? defaultPortGroup,
      subnetMask: formatIPv4(prefixToMask(cidr.prefix)),
      gateway: gatewayFor(net, cidr),
      ...(v6 && net.ipv6Gateway ? { ipv6Gateway: net.ipv6Gateway, ipv6Prefix: v6.prefix } : {}),
    };
  };
  let derivedXRegion: VcfManagementComponentsNetworkSpec | undefined;
  let derivedFrom: NetworkPlan | undefined;
  if (!mc?.xRegion) {
    if (networkModel.model === 'dedicated-vlan' && plan.fleetManagement) {
      derivedFrom = plan.fleetManagement;
      derivedXRegion = fromNetworkPlan(plan.fleetManagement, `${prefix}-pg-fleet`);
    } else if (
      networkModel.model === 'shared-vlan' &&
      vcenterExisting &&
      scenario !== 'deferred-components' &&
      (includeManagementServices || includeOps)
    ) {
      // Converge and VCF management services for VVF place the components on
      // the existing VM management port group.
      derivedFrom = vmMgmtOwnPlan;
      derivedXRegion = fromNetworkPlan(vmMgmtOwnPlan, `${prefix}-pg-vm-mgmt`);
    }
  }
  if (derivedXRegion && vcenterExisting && !derivedFrom?.portGroupName) {
    findings.push(
      warning(
        'vcf.build.xregion-port-group-unnamed',
        `xRegionNetwork.networkName is "${derivedXRegion.networkName}", a generated name. With an existing vCenter it must be the name of a port group that already exists there.`,
        {
          path: 'vcfManagementComponentsInfrastructureSpec.xRegionNetwork.networkName',
          remediation: 'Set portGroupName on the network the fleet-level components are placed on.',
        },
      ),
    );
  }
  const xRegion = mc?.xRegion ?? derivedXRegion;
  const managementInfrastructure: VcfManagementComponentsInfrastructureSpec | undefined =
    mc?.local || xRegion
      ? {
          ...(mc?.local ? { localRegionNetwork: mc.local } : {}),
          ...(xRegion ? { xRegionNetwork: xRegion } : {}),
        }
      : undefined;
  if (mc?.local) {
    findings.push(
      info(
        'vcf.build.local-region-unconfirmed',
        'VERIFY: localRegionNetwork is in the schema, but Broadcom documents no example of it; its semantics are unconfirmed.',
        { path: 'vcfManagementComponentsInfrastructureSpec.localRegionNetwork', source: 'VCF Installer API — VcfManagementComponentsInfrastructureSpec' },
      ),
    );
  }
  if (
    scenario === 'deferred-components' &&
    networkModel.requiresDedicatedNetwork &&
    !xRegion
  ) {
    findings.push(
      warning(
        'vcf.build.deferred-without-placement',
        'Deferred components on a dedicated network or NSX segment are placed through vcfManagementComponentsInfrastructureSpec.xRegionNetwork, which is not set.',
        {
          path: 'managementComponentNetworks.xRegion',
          remediation: 'Name the port group or segment with its subnet mask and gateway.',
          source: 'VCF 9.1 Deployment — Deploy Deferred Components',
        },
      ),
    );
  }

  // --- deferred components reuse the instance they are added to -------------
  // Broadcom's worked example for this workflow marks both vCenter and SDDC
  // Manager as existing. The summary table has no SDDC Manager column at all,
  // so this is reported rather than assumed.
  if (scenario === 'deferred-components' && !existing.sddcManager) {
    findings.push(
      warning(
        'vcf.build.deferred-without-existing-sddc-manager',
        'Deferred components are added to an instance that already exists, but no existing SDDC Manager was supplied, so sddcManagerSpec carries a generated hostname and a placeholder thumbprint.',
        {
          path: 'existing.sddcManager',
          remediation:
            'Supply the existing SDDC Manager FQDN and SSL thumbprint, as Broadcom’s worked example does.',
          source: 'VCF 9.1 Deployment — Deploy Deferred Components on NSX Overlay Segments',
        },
      ),
    );
  }

  // --- target version -------------------------------------------------------
  // The version drives the Automation pool size and the appliance size
  // defaults, so a typo here changes the document rather than being cosmetic.
  if (compareVcfVersion(targetVersion, '9.1.0.0') < 0) {
    findings.push(
      warning(
        'vcf.build.version-below-9-1',
        `version "${targetVersion}" is below 9.1.0.0. This builder emits the 9.1 schema, which earlier releases do not accept.`,
        {
          path: 'version',
          remediation: `Target ${DEFAULT_VCF_VERSION} unless a specific earlier 9.1 patch is required.`,
          source: 'VCF Installer API — SddcSpec',
        },
      ),
    );
  }

  // --- management network model --------------------------------------------
  findings.push(
    info(
      'vcf.build.management-network-model',
      `Fleet-level components follow the ${networkModel.label}. ${networkModel.summary}`,
      { source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design' },
    ),
  );

  if (networkModel.requiresDedicatedNetwork && !plan.fleetManagement && !minimal) {
    findings.push(
      warning(
        'vcf.build.management-network-missing-dedicated',
        `${networkModel.label} requires a dedicated network for the fleet-level components, but none was planned. They fall back to the shared port group, which is a different model.`,
        {
          path: 'fleetManagement',
          remediation:
            'Add a fleetManagement network, or choose the VCF Management Shared VLAN Network Model.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (!networkModel.requiresDedicatedNetwork && plan.fleetManagement) {
    findings.push(
      warning(
        'vcf.build.management-network-unused-dedicated',
        `${networkModel.label} shares the Instance-level port group, but a dedicated fleetManagement network was planned. It is emitted but the model does not place components on it.`,
        {
          path: 'fleetManagement',
          remediation: 'Choose a dedicated model, or drop the fleetManagement network.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (networkModel.requiresOverlaySegment && !plan.managementComponentNetworks?.xRegion) {
    findings.push(
      warning(
        'vcf.build.management-network-missing-overlay',
        `${networkModel.label} places the remaining fleet-level components on an NSX overlay segment, but no segment was named.`,
        {
          path: 'managementComponentNetworks.xRegion',
          remediation:
            'Name the overlay segment with its networkName, subnetMask and gateway; all three are required.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (networkModel.stretched && !plan.managementComponentNetworks?.local) {
    findings.push(
      warning(
        'vcf.build.management-network-missing-local-region',
        'A stretched overlay segment provides fleet disaster recovery across two regions, so a local region network is expected alongside the cross-region one.',
        {
          path: 'managementComponentNetworks.local',
          remediation:
            'Add the local region network, or choose the non-stretched overlay model.',
          source: 'VCF 9.1 Design Library — VCF Management Network Detailed Design',
        },
      ),
    );
  }

  if (includeCollector) {
    findings.push(
      info('vcf.build.cloud-proxy-network', CLOUD_PROXY_ALWAYS_VM_MANAGEMENT, {
        path: 'vcfOperationsCollectorSpec',
        source: 'VCF 9.1 Design Library — VCF Management Dedicated VLAN Network Model',
      }),
    );
  }

  // --- vCenter -----------------------------------------------------------------
  const ssoDomain = plan.vcenterSsoDomain ?? 'vsphere.local';
  const vcenterSize =
    plan.vcenterSize ?? (preset ? (secondary ? preset.vcenterSizeAdditional : preset.vcenterSize) : 'small');
  // An existing vCenter is referenced with its real passwords: nothing is
  // sized, and rootVcenterPassword is the existing one (8-20 characters). The
  // deferred-components example carries no root password at all.
  const vcenterSpec: SddcVcenterSpec = {
    vcenterHostname: existingName(existing.vcenter, 'vcenter', `${prefix}-vc01`),
    rootVcenterPassword: generatable('vcenterRoot', 'vcenterSpec.rootVcenterPassword', !vcenterExisting),
    ...(vcenterExisting
      ? {}
      : {
          vmSize: vcenterSize,
          storageSize: plan.vcenterStorageSize ?? 'lstorage',
          ssoDomain,
        }),
    adminUserSsoUsername: plan.vcenterSsoUsername ?? `administrator@${ssoDomain}`,
    adminUserSsoPassword: generatable('ssoAdmin', 'vcenterSpec.adminUserSsoPassword', !vcenterExisting),
    ...versionOf('vcenter'),
    ...(vcenterExisting
      ? {
          useExistingDeployment: true,
          sslThumbprint: thumbprint(existing.vcenter, 'vcenterSpec.sslThumbprint'),
        }
      : {}),
  };
  if (scenario === 'deferred-components' && minimal && !plan.passwords?.vcenterRoot) {
    delete (vcenterSpec as { rootVcenterPassword?: string }).rootVcenterPassword;
    const at = placeholders.indexOf('vcenterSpec.rootVcenterPassword');
    if (at >= 0) placeholders.splice(at, 1);
  }

  // --- SDDC Manager ------------------------------------------------------------
  const sddcManagerSpec: SddcManagerSpec = {
    hostname: existingName(existing.sddcManager, 'sddcManager', `${prefix}-sddcm01`),
    rootPassword: generatable('sddcManagerRoot', 'sddcManagerSpec.rootPassword', !sddcManagerExisting),
    sshPassword: generatable('sddcManagerSsh', 'sddcManagerSpec.sshPassword', !sddcManagerExisting),
    localUserPassword: generatable('sddcManagerLocal', 'sddcManagerSpec.localUserPassword', !sddcManagerExisting),
    ...versionOf('sddcManager'),
    ...(sddcManagerExisting
      ? {
          useExistingDeployment: true,
          sslThumbprint: thumbprint(existing.sddcManager, 'sddcManagerSpec.sslThumbprint'),
        }
      : {}),
  };

  // --- fleet and lifecycle services -----------------------------------------------
  // The LCM hostnames mirror the vsp FQDNs. A further instance joins an existing
  // fleet, so it carries no fleet-level lifecycle block of its own.
  const sizes = plan.serviceSizes ?? {};
  const service = (key: ServiceSpecKey): { version?: string; size?: string } => ({
    ...versionOf(key),
    ...(sizes[key] ? { size: sizes[key] } : {}),
  });
  const includeServiceBlocks = plan.includeFleetServiceSpecs ?? true;
  if (secondary && includeManagementServices) {
    findings.push(
      info(
        'vcf.build.secondary-no-fleet-lcm',
        'A further instance joins the existing fleet, so no fleetLcmSpec is emitted. VERIFY: whether fleetDepotSpec and saltRaasSpec, also fleet-level, should be omitted too is not documented.',
        { path: 'fleetLcmSpec', source: 'VCF Installer API — SddcVspClusterSpec' },
      ),
    );
  }

  // --- assemble ------------------------------------------------------------
  const full: SddcSpec = {
    sddcId: plan.sddcId,
    version: targetVersion,
    vcfInstanceName: plan.vcfInstanceName ?? plan.sddcId,
    // Taken from the scenario's own row. A secondary instance joining an
    // existing fleet must declare VCF_EXTEND rather than VCF, and a vSphere
    // Foundation platform must declare VVF; emitting the wrong one is a silent
    // misconfiguration rather than a rejected document.
    workflowType,
    ceipEnabled: plan.ceipEnabled ?? false,
    // Validation can only be enforced when every host carries a thumbprint.
    skipEsxThumbprintValidation: missingThumbprints > 0,
    skipGatewayPingValidation: plan.skipGatewayPingValidation ?? false,

    dnsSpec: {
      subdomain: domain,
      nameservers: plan.dnsServers.slice(0, 2),
    },
    ntpServers: plan.ntpServers,

    hostSpecs,
    networkSpecs,

    clusterSpec: {
      datacenterName: plan.datacenterName ?? `${prefix}-dc01`,
      clusterName: plan.clusterName ?? `${prefix}-cl01`,
      ...(plan.evcMode ? { clusterEvcMode: plan.evcMode } : {}),
      ...(plan.resourcePools ? { resourcePoolSpecs: plan.resourcePools } : {}),
    },

    ...(plan.managementPoolName ? { managementPoolName: plan.managementPoolName } : {}),
    ...(securitySpec ? { securitySpec } : {}),
    ...(managementInfrastructure
      ? { vcfManagementComponentsInfrastructureSpec: managementInfrastructure }
      : {}),

    vcenterSpec,

    ...(includeNsx ? { nsxtSpec } : {}),

    datastoreSpec: buildDatastoreSpec(plan, minimal ? [] : findings),

    dvsSpecs: buildDvsSpecs(plan, minimal ? [] : findings),

    sddcManagerSpec,

    ...(includeManagementServices
      ? {
          vspClusterSpec,
          ...(secondary ? {} : { fleetLcmSpec: { hostname: fleetFqdnValue, ...service('fleetLcm') } }),
          sddcLcmSpec: { hostname: instanceFqdnValue, ...service('sddcLcm') },
        }
      : {}),
    ...(includeServiceBlocks
      ? {
          fleetDepotSpec: service('fleetDepot'),
          telemetryAcceptorSpec: service('telemetryAcceptor'),
          saltSpec: service('salt'),
          saltRaasSpec: service('saltRaas'),
        }
      : {}),

    ...(vidbSpec ? { vidbSpec } : {}),
    ...(licenseServerSpec ? { licenseServerSpec } : {}),

    ...(vcfOperationsSpec ? { vcfOperationsSpec } : {}),
    ...(vcfOperationsCollectorSpec ? { vcfOperationsCollectorSpec } : {}),
    ...(vcfAutomationSpec ? { vcfAutomationSpec } : {}),
  };

  // A minimal document keeps only the keys Broadcom's example for the workflow
  // carries. The SddcSpec type still declares networkSpecs and dnsSpec, which
  // the schema marks required, so consumers must not assume them here.
  let spec: SddcSpec = full;
  if (minimal) {
    const keep = new Set(MINIMAL_KEYS[minimalKind]);
    spec = Object.fromEntries(Object.entries(full).filter(([key]) => keep.has(key))) as SddcSpec;
    if (minimalKind === 'vvf-services') spec.skipEsxThumbprintValidation = true;
  }

  if (secondary) {
    findings.push(
      info(
        'vcf.build.secondary-instance',
        'Built as a secondary instance: workflowType is VCF_EXTEND, vspClusterSpec.fleetFqdn is omitted, and VCF Operations references the fleet’s existing master node.',
        { source: 'VCF Installer API — SddcSpec.workflowType' },
      ),
    );
  }

  // VCF_BOOTSTRAP is the only workflowType left in the enum with no published
  // definition. VCF_COMPLETE is documented as the deferred-components workflow.
  if (plan.workflowType === 'VCF_BOOTSTRAP') {
    findings.push(
      warning(
        'vcf.build.undocumented-workflow-type',
        'workflowType "VCF_BOOTSTRAP" appears in the API enum but Broadcom publishes no definition of what it does.',
        {
          path: 'workflowType',
          remediation:
            'Use VCF for a new fleet, VCF_EXTEND for a further instance, VCF_COMPLETE for deferred components, or VVF for vSphere Foundation.',
          source: 'VCF Installer API — SddcSpec',
        },
      ),
    );
  }

  // Only what is actually in the document counts.
  const present = (path: string): boolean => topKey(path) in spec;
  const remaining = placeholders.filter(present);
  const blank = autoGenerated.filter(present);

  if (blank.length > 0) {
    findings.push(
      info(
        'vcf.build.auto-generated-passwords',
        `${blank.length} password field(s) are left blank for the VCF Installer to auto-generate: ${blank.join(', ')}.`,
        {
          remediation: 'Retrieve the generated passwords from the installer after deployment.',
          source: 'VCF Installer API — SddcSpec',
        },
      ),
    );
  }

  if (remaining.length > 0) {
    findings.push(
      warning(
        'vcf.build.placeholder-secrets',
        `${remaining.length} credential or thumbprint field(s) contain "${PLACEHOLDER_SECRET}" and must be filled before deployment.`,
        {
          remediation: plan.autoGeneratePasswords
            ? 'These cannot be auto-generated: an existing component’s real password or thumbprint, the ESX root password, or an appliance root password.'
            : 'VCF 9.1 can auto-generate most passwords during installation (set autoGeneratePasswords); alternatively supply them in the plan.',
        },
      ),
    );
  }

  findings.push(
    info(
      'vcf.build.not-validated',
      'This specification has not been validated by a VCF Installer. Run POST /v1/sddcs/validations before deploying.',
      { source: 'VCF Installer API' },
    ),
  );

  return { spec, findings, placeholders: remaining };
}

/** Serialize a spec with stable key ordering for diffing between runs. */
export function serializeSpec(spec: SddcSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

/**
 * Redact every placeholder and supplied secret, for sharing a spec for review.
 */
export function redactSpec(spec: SddcSpec): SddcSpec {
  const SECRET_KEY = /password|thumbprint|secret|token/i;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SECRET_KEY.test(key) && typeof inner === 'string' ? '<REDACTED>' : walk(inner);
      }
      return out;
    }
    return value;
  };
  return walk(spec) as SddcSpec;
}

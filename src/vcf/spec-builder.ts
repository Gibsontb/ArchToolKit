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
  formatIPv4,
  allocateRange,
  usableRange,
  type Cidr,
} from '../core/net.ts';
import { warning, info, type Finding } from '../core/findings.ts';
import {
  DEFAULT_MTU,
  VCFMS_RECOMMENDED_IPS,
  AUTOMATION_IP_COUNT,
  INTERNAL_CLUSTER_CIDRS_V4,
} from './sizing-data.ts';
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
} from './spec-types.ts';




export { PLACEHOLDER_SECRET };

export interface NetworkPlan {
  /** CIDR, e.g. "172.30.0.0/24". */
  readonly cidr: string;
  readonly vlanId: number;
  /** Defaults to the first usable address in the CIDR. */
  readonly gateway?: string;
  readonly mtu?: number;
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
  /** Short hostname base, e.g. "esx" produces esx01, esx02... */
  readonly esxHostnameBase: string;
  readonly hostCount: number;
  readonly esxRootPassword?: string;

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
  readonly fleetManagement?: NetworkPlan;
  /** Host overlay TEP network. */
  readonly hostTep: NetworkPlan;
  readonly pnicsPerHost?: number;

  // --- storage -------------------------------------------------------------
  readonly storage: 'vsan-esa' | 'vsan-osa' | 'nfs' | 'vmfs-fc';
  readonly datastoreName?: string;
  readonly failuresToTolerate?: number;
  readonly vsanDedup?: boolean;
  /** NFS export path, required when storage is nfs. */
  readonly nfsPath?: string;
  readonly nfsServer?: string;

  // --- scale ---------------------------------------------------------------
  readonly profile?: 'simple' | 'ha';
  readonly vcenterSize?: VcenterVmSize;
  readonly nsxManagerSize?: NsxtManagerSize;
  readonly opsSize?: 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
  readonly vspSize?: 'small' | 'small_ha' | 'medium' | 'large';
  readonly automationSize?: string;

  // --- switching -----------------------------------------------------------
  readonly dvsProfile?: DvsProfile;
  /** e.g. ["vmnic0", "vmnic1"]. */
  readonly vmnics?: string[];
  readonly dvsMtu?: number;
  readonly lacp?: Omit<LagSpec, 'name'> & { readonly name?: string };

  // --- NSX / VPC -----------------------------------------------------------
  readonly vpcNetworkConfigurationType?: VpcSpec['vpcNetworkConfigurationType'];
  readonly dtgw?: {
    readonly vlan: number;
    readonly gatewayCidr: string;
    readonly externalIpBlockCidr: string;
    readonly privateTgwIpBlockCidr: string;
  };

  // --- cluster -------------------------------------------------------------
  readonly datacenterName?: string;
  readonly clusterName?: string;

  // --- components ----------------------------------------------------------
  readonly includeAutomation?: boolean;
  readonly includeOperations?: boolean;
  readonly ceipEnabled?: boolean;
  readonly internalClusterCidr?: string;

  // --- brownfield ----------------------------------------------------------
  readonly existing?: {
    readonly vcenter?: ExistingComponent;
    readonly nsx?: ExistingComponent;
    readonly sddcManager?: ExistingComponent;
    readonly operations?: ExistingComponent;
    readonly automation?: ExistingComponent;
    readonly datastoreName?: string;
  };

  // --- secrets (optional; placeholders emitted when absent) ----------------
  readonly passwords?: Record<string, string>;
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
    ipAddressAssignmentMode: 'STATIC',
    teamingPolicy: 'loadbalance_loadbased',
    activeUplinks: ['uplink1', 'uplink2'],
    standbyUplinks: [],
    ...(plan.mtu !== undefined ? { mtu: plan.mtu } : {}),
    ...extras,
  };
  return spec;
}

/**
 * vDS layout.
 *
 * The 9.1 installer offers Default (one switch), Storage Traffic Separation
 * (two), NSX Traffic Separation (two), Storage and NSX Separation (three), and
 * Custom. Each switch needs its own uplinks, so the available vmnics are split
 * across them.
 */
function buildDvsSpecs(plan: DeploymentPlan, findings: Finding[]): DvsSpec[] {
  const profile = plan.dvsProfile ?? 'default';
  const vmnics = plan.vmnics ?? ['vmnic0', 'vmnic1'];
  const mtu = plan.dvsMtu ?? DEFAULT_MTU;
  const prefix = plan.namePrefix ?? plan.sddcId;

  const toUplinks = (nics: string[]): VmnicToUplink[] =>
    nics.map((id, i) => ({ id, uplink: `uplink${i + 1}` }));

  const overlayConfig = {
    transportZones: [
      { name: `${prefix}-overlay-tz`, transportType: 'OVERLAY' as const },
      { name: `${prefix}-vlan-tz`, transportType: 'VLAN' as const },
    ],
  };

  const lagSpecs: LagSpec[] | null = plan.lacp
    ? [{ name: plan.lacp.name ?? `${prefix}-lag01`.slice(0, 16), ...plan.lacp }]
    : null;

  const teamings = [
    {
      policy: 'LOADBALANCE_SRCID' as const,
      activeUplinks: toUplinks(vmnics).map((u) => u.uplink),
      standByUplinks: null,
    },
  ];

  const storageNetworks: NetworkType[] = [];
  if (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa') storageNetworks.push('VSAN');
  if (plan.nfs) storageNetworks.push('NFS');

  const coreNetworks: NetworkType[] = ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION'];
  if (plan.fleetManagement) coreNetworks.push('FLEET_MANAGEMENT');

  const needed: Record<DvsProfile, number> = {
    default: 1,
    'storage-separation': 2,
    'nsx-separation': 2,
    'storage-and-nsx-separation': 3,
    custom: 1,
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

  if (profile === 'default' || profile === 'custom') {
    return [
      {
        dvsName: `${prefix}-vds01`,
        networks: [...coreNetworks, ...storageNetworks],
        mtu,
        nsxtSwitchConfig: overlayConfig,
        vmnicsToUplinks: toUplinks(vmnics),
        nsxTeamings: teamings,
        lagSpecs,
      },
    ];
  }

  if (profile === 'storage-separation') {
    return [
      {
        dvsName: `${prefix}-vds01`,
        networks: coreNetworks,
        mtu,
        nsxtSwitchConfig: overlayConfig,
        vmnicsToUplinks: toUplinks(slice(0)),
        nsxTeamings: teamings,
        lagSpecs,
      },
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
      {
        dvsName: `${prefix}-vds02-nsx`,
        mtu,
        nsxtSwitchConfig: overlayConfig,
        vmnicsToUplinks: toUplinks(slice(1)),
        nsxTeamings: teamings,
        lagSpecs,
      },
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
    {
      dvsName: `${prefix}-vds03-nsx`,
      mtu,
      nsxtSwitchConfig: overlayConfig,
      vmnicsToUplinks: toUplinks(slice(2)),
      nsxTeamings: teamings,
      lagSpecs,
    },
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
        vsanDedup: esa ? false : (plan.vsanDedup ?? false),
        failuresToTolerate: ftt,
        esaConfig: { enabled: esa },
        encryptionConfig: { dataInTransitConfig: { enable: false } },
      },
    };
  }

  if (plan.storage === 'nfs') {
    return {
      nfsDatastoreSpec: {
        datastoreName: plan.datastoreName ?? 'nfsDatastore',
        nasVolume: {
          serverName: plan.nfsServer ? [plan.nfsServer] : [PLACEHOLDER_SECRET],
          path: plan.nfsPath ?? '/export/vcf',
          readOnly: false,
        },
      },
    };
  }

  return {
    vmfsDatastoreSpec: {
      fcSpec: [{ datastoreName: plan.datastoreName ?? 'vmfsDatastore' }],
    },
  };
}

/**
 * Build a complete VCF 9.1 SddcSpec from a deployment plan.
 */
export function buildSddcSpec(plan: DeploymentPlan): BuildResult {
  const findings: Finding[] = [];
  const placeholders: string[] = [];
  const domain = plan.domainSuffix.toLowerCase();
  const prefix = plan.namePrefix ?? plan.sddcId;
  const ha = plan.profile === 'ha';
  const secondary = plan.instanceRole === 'secondary';

  const secret = (key: string, path: string): string => {
    const value = plan.passwords?.[key];
    if (value) return value;
    placeholders.push(path);
    return PLACEHOLDER_SECRET;
  };

  // --- hosts ---------------------------------------------------------------
  const hostSpecs: SddcHostSpec[] = Array.from({ length: plan.hostCount }, (_, i) => ({
    hostname: `${plan.esxHostnameBase}${pad(i + 1)}`,
    credentials: {
      username: 'root',
      password: plan.esxRootPassword ?? secret('esxRoot', 'hostSpecs[].credentials.password'),
    },
  }));

  // --- networks ------------------------------------------------------------
  const networkSpecs: SddcNetworkSpec[] = [];
  const mgmtCidr = parseCidr(plan.management.cidr);

  const mgmt = networkSpec('MANAGEMENT', plan.management, {
    portGroupKey: `${prefix}-pg-mgmt`,
  });
  if (mgmt) networkSpecs.push(mgmt);

  // VM management commonly shares the management VLAN; the installer still
  // wants it declared as its own network with its own port group.
  const vmMgmtPlan = plan.vmManagement ?? plan.management;
  const vmMgmt = networkSpec('VM_MANAGEMENT', vmMgmtPlan, {
    portGroupKey: `${prefix}-pg-vm-mgmt`,
  });
  if (vmMgmt) networkSpecs.push(vmMgmt);

  const vmotionCidr = parseCidr(plan.vmotion.cidr);
  const vmotion = networkSpec('VMOTION', { mtu: DEFAULT_MTU, ...plan.vmotion }, {
    portGroupKey: `${prefix}-pg-vmotion`,
    ...(vmotionCidr
      ? {
          includeIpAddressRanges: (() => {
            const range = allocateRange(vmotionCidr, 9, Math.max(plan.hostCount, 1));
            return range
              ? [{ startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) }]
              : [];
          })(),
        }
      : {}),
  });
  if (vmotion) networkSpecs.push(vmotion);

  if (plan.vsan && (plan.storage === 'vsan-esa' || plan.storage === 'vsan-osa')) {
    const vsanCidr = parseCidr(plan.vsan.cidr);
    const vsan = networkSpec('VSAN', { mtu: DEFAULT_MTU, ...plan.vsan }, {
      portGroupKey: `${prefix}-pg-vsan`,
      ...(vsanCidr
        ? {
            includeIpAddressRanges: (() => {
              const range = allocateRange(vsanCidr, 1, Math.max(plan.hostCount, 1));
              return range
                ? [{ startIpAddress: formatIPv4(range.start), endIpAddress: formatIPv4(range.end) }]
                : [];
            })(),
          }
        : {}),
    });
    if (vsan) networkSpecs.push(vsan);
  }

  if (plan.nfs) {
    const nfs = networkSpec('NFS', { mtu: DEFAULT_MTU, ...plan.nfs }, {
      portGroupKey: `${prefix}-pg-nfs`,
    });
    if (nfs) networkSpecs.push(nfs);
  }

  if (plan.fleetManagement) {
    const fleet = networkSpec('FLEET_MANAGEMENT', plan.fleetManagement, {
      portGroupKey: `${prefix}-pg-fleet`,
    });
    if (fleet) networkSpecs.push(fleet);
  }

  // --- NSX -----------------------------------------------------------------
  const tepCidr = parseCidr(plan.hostTep.cidr);
  const tepCount = plan.hostCount * (plan.pnicsPerHost ?? 2);
  const tepRange = tepCidr ? allocateRange(tepCidr, 9, Math.max(tepCount, 1)) : null;

  const nsxtSpec: SddcNsxtSpec = {
    nsxtManagers: ha
      ? [1, 2, 3].map((n) => ({ hostname: fqdn(`${prefix}-nsx${pad(n)}`, domain) }))
      : [{ hostname: fqdn(`${prefix}-nsx01`, domain) }],
    vipFqdn: fqdn(`${prefix}-nsx`, domain),
    nsxtManagerSize: plan.nsxManagerSize ?? 'medium',
    rootNsxtManagerPassword: secret('nsxRoot', 'nsxtSpec.rootNsxtManagerPassword'),
    nsxtAdminPassword: secret('nsxAdmin', 'nsxtSpec.nsxtAdminPassword'),
    nsxtAuditPassword: secret('nsxAudit', 'nsxtSpec.nsxtAuditPassword'),
    transportVlanId: plan.hostTep.vlanId,
    ...(tepCidr && tepRange
      ? {
          ipAddressPoolSpec: {
            name: `${prefix}-tep01`,
            description: 'ESXi host overlay TEP IP pool',
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
          },
        }
      : {}),
    ...(plan.existing?.nsx
      ? {
          useExistingDeployment: true,
          sslThumbprint: plan.existing.nsx.sslThumbprint ?? PLACEHOLDER_SECRET,
          enableEdgeClusterSync: true,
        }
      : {}),
  };

  if (plan.dtgw) {
    nsxtSpec.vpcSpec = {
      vpcNetworkConfigurationType: plan.vpcNetworkConfigurationType ?? 'FULL_STACK_VPC',
      dtgwSpec: {
        vlan: plan.dtgw.vlan,
        gatewayCidr: plan.dtgw.gatewayCidr,
        externalIpBlockCidr: plan.dtgw.externalIpBlockCidr,
        privateTgwIpBlockCidr: plan.dtgw.privateTgwIpBlockCidr,
      },
    };
  } else if (plan.vpcNetworkConfigurationType) {
    nsxtSpec.vpcSpec = { vpcNetworkConfigurationType: plan.vpcNetworkConfigurationType };
  }

  if (tepCidr && !tepRange) {
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
  const vcfmsHomeCidr = plan.fleetManagement ? parseCidr(plan.fleetManagement.cidr) : mgmtCidr;
  const vcfmsRange = vcfmsHomeCidr
    ? allocateRange(vcfmsHomeCidr, 31, VCFMS_RECOMMENDED_IPS)
    : null;

  const vspClusterSpec: SddcVspClusterSpec = {
    platformFqdn: fqdn(`${prefix}-msr01`, domain),
    instanceFqdn: fqdn(`${prefix}-int01`, domain),
    // A secondary instance joins an existing fleet and must omit fleetFqdn.
    ...(secondary ? {} : { fleetFqdn: fqdn(`${prefix}-flt01`, domain) }),
    ipv4Pool: vcfmsRange
      ? { ipRange: { startIpAddress: formatIPv4(vcfmsRange.start), endIpAddress: formatIPv4(vcfmsRange.end) } }
      : {},
    systemUserPassword: secret('vspSystem', 'vspClusterSpec.systemUserPassword'),
    size: plan.vspSize ?? (ha ? 'small_ha' : 'small'),
    internalClusterCidrIpv4: plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0],
    // Present in a real working spec but absent from the published schema.
    name: `${prefix}-vmsp-01`,
  };

  if (!vcfmsRange) {
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
  const vcfOperationsSpec: VcfOperationsSpec | undefined = includeOps
    ? {
        nodes: ha
          ? [
              { hostname: fqdn(`${prefix}-ops01`, domain), type: 'master', rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[0].rootUserPassword') },
              { hostname: fqdn(`${prefix}-ops02`, domain), type: 'replica', rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[1].rootUserPassword') },
              { hostname: fqdn(`${prefix}-ops03`, domain), type: 'data', rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[2].rootUserPassword') },
            ]
          : [
              {
                hostname: fqdn(`${prefix}-ops01`, domain),
                type: 'master',
                rootUserPassword: secret('opsRoot', 'vcfOperationsSpec.nodes[0].rootUserPassword'),
              },
            ],
        adminUserPassword: secret('opsAdmin', 'vcfOperationsSpec.adminUserPassword'),
        applianceSize: plan.opsSize ?? (ha ? 'medium' : 'small'),
        ...(ha ? { loadBalancerFqdn: fqdn(`${prefix}-ops`, domain) } : {}),
        // A secondary instance attaches to the fleet's existing Operations.
        ...(secondary || plan.existing?.operations ? { useExistingDeployment: true } : {}),
      }
    : undefined;

  // --- Automation ----------------------------------------------------------
  const includeAutomation = plan.includeAutomation !== false;
  const automationRange = vcfmsHomeCidr
    ? allocateRange(vcfmsHomeCidr, 31 + VCFMS_RECOMMENDED_IPS, AUTOMATION_IP_COUNT)
    : null;

  const vcfAutomationSpec: VcfAutomationSpec | undefined = includeAutomation
    ? {
        hostname: fqdn(`${prefix}-auto01`, domain),
        platformFqdn: fqdn(`${prefix}-asr01`, domain),
        internalClusterCidr: plan.internalClusterCidr ?? INTERNAL_CLUSTER_CIDRS_V4[0],
        adminUserPassword: secret('automationAdmin', 'vcfAutomationSpec.adminUserPassword'),
        nodePrefix: `${prefix}-node-01`.toLowerCase(),
        ...(automationRange
          ? {
              ipPool: Array.from({ length: AUTOMATION_IP_COUNT }, (_, i) =>
                formatIPv4(automationRange.start + i),
              ),
            }
          : {}),
        size: plan.automationSize ?? (ha ? 'medium' : 'small'),
        ...(plan.existing?.automation ? { useExistingDeployment: true } : {}),
      }
    : undefined;

  if (includeAutomation && !automationRange) {
    findings.push(
      warning(
        'vcf.build.automation-pool-not-allocated',
        `Could not allocate ${AUTOMATION_IP_COUNT} VCF Automation addresses after the VCFMS pool.`,
        { path: 'vcfAutomationSpec.ipPool' },
      ),
    );
  }

  // --- assemble ------------------------------------------------------------
  const spec: SddcSpec = {
    sddcId: plan.sddcId,
    version: plan.version ?? '9.1.0.0',
    vcfInstanceName: plan.vcfInstanceName ?? plan.sddcId,
    workflowType: plan.workflowType ?? 'VCF',
    ceipEnabled: plan.ceipEnabled ?? false,
    skipEsxThumbprintValidation: false,
    skipGatewayPingValidation: false,

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
    },

    vcenterSpec: {
      vcenterHostname: fqdn(`${prefix}-vc01`, domain),
      rootVcenterPassword: secret('vcenterRoot', 'vcenterSpec.rootVcenterPassword'),
      vmSize: plan.vcenterSize ?? 'small',
      storageSize: 'lstorage',
      ssoDomain: 'vsphere.local',
      adminUserSsoUsername: 'administrator',
      adminUserSsoPassword: secret('ssoAdmin', 'vcenterSpec.adminUserSsoPassword'),
      ...(plan.existing?.vcenter
        ? {
            useExistingDeployment: true,
            sslThumbprint: plan.existing.vcenter.sslThumbprint ?? PLACEHOLDER_SECRET,
          }
        : {}),
    },

    nsxtSpec,

    datastoreSpec: buildDatastoreSpec(plan, findings),

    dvsSpecs: buildDvsSpecs(plan, findings),

    sddcManagerSpec: {
      hostname: fqdn(`${prefix}-sddcm01`, domain),
      rootPassword: secret('sddcManagerRoot', 'sddcManagerSpec.rootPassword'),
      sshPassword: secret('sddcManagerSsh', 'sddcManagerSpec.sshPassword'),
      localUserPassword: secret('sddcManagerLocal', 'sddcManagerSpec.localUserPassword'),
      ...(plan.existing?.sddcManager
        ? {
            useExistingDeployment: true,
            sslThumbprint: plan.existing.sddcManager.sslThumbprint ?? PLACEHOLDER_SECRET,
          }
        : {}),
    },

    vspClusterSpec,

    // Fleet and lifecycle services. An empty object signals "deploy with
    // defaults", which is how a real working 9.1 spec expresses them.
    fleetLcmSpec: { hostname: fqdn(`${prefix}-flt01`, domain) },
    sddcLcmSpec: { hostname: fqdn(`${prefix}-int01`, domain) },
    fleetDepotSpec: {},
    telemetryAcceptorSpec: {},
    saltSpec: {},
    saltRaasSpec: {},

    vidbSpec: { hostname: fqdn(`${prefix}-idb01`, domain) },
    licenseServerSpec: { hostname: fqdn(`${prefix}-lic01`, domain) },

    ...(vcfOperationsSpec ? { vcfOperationsSpec } : {}),
    ...(includeOps
      ? {
          vcfOperationsCollectorSpec: {
            hostname: fqdn(`${prefix}-proxy01`, domain),
            rootUserPassword: secret('opsCollectorRoot', 'vcfOperationsCollectorSpec.rootUserPassword'),
            applianceSize: 'small',
          },
        }
      : {}),
    ...(vcfAutomationSpec ? { vcfAutomationSpec } : {}),
  };

  if (secondary) {
    findings.push(
      info(
        'vcf.build.secondary-instance',
        'Built as a secondary instance: vspClusterSpec.fleetFqdn is omitted and VCF Operations is set to use the existing fleet deployment.',
        { source: 'VCF Installer API — SddcVspClusterSpec' },
      ),
    );
  }

  if (placeholders.length > 0) {
    findings.push(
      warning(
        'vcf.build.placeholder-secrets',
        `${placeholders.length} credential field(s) contain "${PLACEHOLDER_SECRET}" and must be filled before deployment.`,
        {
          remediation:
            'VCF 9.1 can auto-generate complex passwords during installation; alternatively supply them in the plan.',
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

  return { spec, findings, placeholders };
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

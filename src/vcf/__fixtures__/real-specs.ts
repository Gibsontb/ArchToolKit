/**
 * Real, working VCF 9.1.0.0 deployment specifications.
 *
 * Source: github.com/lamw/vcf-91-in-box (William Lam), config/*.json. These
 * specs were used to deploy actual 9.1.0.0 instances, which makes them the
 * strongest offline check available: if our validator rejects a spec that
 * genuinely deployed, the validator is wrong.
 *
 * The passwords are the public lab values from that repository, kept verbatim
 * so the fixtures exercise real field lengths. They are not credentials.
 *
 * These live under __fixtures__, which the build excludes, so they never ship
 * to the browser.
 */

import type { SddcSpec } from '../spec-types.ts';

/** Single-host deployment. */
export const ONE_NODE_VSAN_ESA = {
  version: '9.1.0.0',
  vcfInstanceName: 'VMUG x Intel x Micron VCF 9.1 Instance',
  sddcId: 'vcf-m01',
  ceipEnabled: true,
  skipEsxThumbprintValidation: true,
  workflowType: 'VCF',
  dnsSpec: { subdomain: 'vcf.lab', nameservers: ['192.168.30.29'] },
  ntpServers: ['96.19.94.82'],
  hostSpecs: [
    { hostname: 'esx01.vcf.lab', credentials: { username: 'root', password: 'VMware1!' } },
  ],
  networkSpecs: [
    {
      networkType: 'MANAGEMENT',
      ipAddressVersion: 'IPv4',
      subnet: '172.30.0.0/24',
      gateway: '172.30.0.1',
      vlanId: '30',
      activeUplinks: ['uplink1'],
      portGroupKey: 'DVPG_FOR_MANAGEMENT',
      standbyUplinks: [],
      teamingPolicy: 'loadbalance_loadbased',
    },
    {
      networkType: 'VM_MANAGEMENT',
      ipAddressVersion: 'IPv4',
      subnet: '172.30.0.0/24',
      gateway: '172.30.0.1',
      vlanId: '30',
      activeUplinks: ['uplink1'],
      portGroupKey: 'DVPG_FOR_VM_MANAGEMENT',
      standbyUplinks: [],
      teamingPolicy: 'loadbalance_loadbased',
    },
    {
      networkType: 'VMOTION',
      ipAddressVersion: 'IPv4',
      subnet: '172.30.40.0/24',
      gateway: '172.30.40.1',
      vlanId: '40',
      mtu: 9000,
      includeIpAddressRanges: [
        { startIpAddress: '172.30.40.10', endIpAddress: '172.30.40.20' },
      ],
      activeUplinks: ['uplink1'],
      portGroupKey: 'DVPG_FOR_VMOTION',
      standbyUplinks: [],
      teamingPolicy: 'loadbalance_loadbased',
    },
    {
      networkType: 'VSAN',
      ipAddressVersion: 'IPv4',
      subnet: '172.30.50.0/24',
      gateway: '172.30.50.1',
      vlanId: '50',
      mtu: 9000,
      includeIpAddressRanges: [{ startIpAddress: '172.30.50.2', endIpAddress: '172.30.50.4' }],
      activeUplinks: ['uplink1'],
      portGroupKey: 'DVPG_FOR_VSAN',
      standbyUplinks: [],
      teamingPolicy: 'loadbalance_loadbased',
    },
  ],
  vspClusterSpec: {
    ipv4Pool: { ipRange: { startIpAddress: '172.30.0.33', endIpAddress: '172.30.0.46' } },
    platformFqdn: 'vcf-msr01.vcf.lab',
    instanceFqdn: 'vcf-int01.vcf.lab',
    fleetFqdn: 'vcf-flt01.vcf.lab',
    systemUserPassword: 'VMware1!VMware1!',
    size: 'small',
    // Undocumented but present in every working spec.
    name: 'vcf-m01-vmsp-01',
    internalClusterCidrIpv4: '198.18.0.0/15',
  },
  vcfAutomationSpec: {
    // Six addresses, though TechDocs documents five (3 active + 2 buffer).
    ipPool: [
      '172.30.0.65',
      '172.30.0.66',
      '172.30.0.67',
      '172.30.0.68',
      '172.30.0.69',
      '172.30.0.70',
    ],
    hostname: 'auto01.vcf.lab',
    platformFqdn: 'vcf-asr01.vcf.lab',
    adminUserPassword: 'VMware1!VMware1!',
    nodePrefix: 'vcf-m01-node-01',
    internalClusterCidr: '198.18.0.0/15',
    useExistingDeployment: false,
    size: 'small',
  },
  nsxtSpec: {
    transportVlanId: '60',
    ipAddressPoolSpec: {
      name: 'vcf-m01-cl01-tep01',
      description: 'ESXi Host Overlay TEP IP Pool',
      subnets: [
        {
          cidr: '172.30.60.0/24',
          gateway: '172.30.60.1',
          // start/end here, unlike startIpAddress/endIpAddress on networkSpecs.
          ipAddressPoolRanges: [{ start: '172.30.60.10', end: '172.30.60.20' }],
        },
      ],
    },
    nsxtManagerSize: 'medium',
    vipFqdn: 'nsx01.vcf.lab',
    rootNsxtManagerPassword: 'VMware1!VMware1!',
    nsxtAdminPassword: 'VMware1!VMware1!',
    nsxtAuditPassword: 'VMware1!VMware1!',
    useExistingDeployment: false,
    vpcSpec: {
      dtgwSpec: {
        vlan: '70',
        gatewayCidr: '172.30.70.1/24',
        externalIpBlockCidr: '172.30.70.0/26',
        privateTgwIpBlockCidr: '172.31.0.0/16',
      },
    },
    nsxtManagers: [{ hostname: 'nsx01a.vcf.lab' }],
  },
  vcfOperationsSpec: {
    applianceSize: 'small',
    useExistingDeployment: false,
    adminUserPassword: 'VMware1!VMware1!',
    nodes: [
      { hostname: 'vcf01.vcf.lab', rootUserPassword: 'VMware1!VMware1!', type: 'master' },
    ],
  },
  vcfOperationsCollectorSpec: {
    applianceSize: 'small',
    hostname: 'vcf-proxy01.vcf.lab',
    rootUserPassword: 'VMware1!VMware1!',
    useExistingDeployment: false,
  },
  licenseServerSpec: { hostname: 'vcf-lic01.vcf.lab' },
  vidbSpec: { hostname: 'vcf-idb01.vcf.lab' },
  // Empty objects are how a working spec asks for default deployment.
  saltSpec: {},
  saltRaasSpec: {},
  telemetryAcceptorSpec: {},
  fleetLcmSpec: { hostname: 'vcf-flt01.vcf.lab' },
  sddcLcmSpec: { hostname: 'vcf-int01.vcf.lab' },
  fleetDepotSpec: {},
  vcenterSpec: {
    vcenterHostname: 'vc01.vcf.lab',
    adminUserSsoPassword: 'VMware1!VMware1!',
    rootVcenterPassword: 'VMware1!VMware1!',
    vmSize: 'small',
    storageSize: 'lstorage',
    ssoDomain: 'vsphere.local',
    useExistingDeployment: false,
  },
  clusterSpec: { datacenterName: 'VCF-Datacenter', clusterName: 'VCF-Mgmt-Cluster' },
  datastoreSpec: {
    vsanSpec: {
      vsanDedup: false,
      failuresToTolerate: 1,
      esaConfig: { enabled: true },
      datastoreName: 'vsanDatastore',
      encryptionConfig: { dataInTransitConfig: { enable: false } },
    },
  },
  dvsSpecs: [
    {
      dvsName: 'vcf-m01-cl01-vds01',
      networks: ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN'],
      mtu: 9000,
      nsxtSwitchConfig: {
        transportZones: [
          { name: 'vcf-overlay-TZ', transportType: 'OVERLAY' },
          { transportType: 'VLAN', name: 'vcf-vlan-TZ' },
        ],
        // Documented as VI workload domains only, yet set here on a management
        // domain that deployed successfully.
        hostSwitchOperationalMode: 'ENS',
      },
      vmnicsToUplinks: [{ id: 'vmnic1', uplink: 'uplink1' }],
      nsxTeamings: [
        // Capital B, unlike standbyUplinks on networkSpecs.
        { policy: 'LOADBALANCE_SRCID', activeUplinks: ['uplink1'], standByUplinks: null },
      ],
      lagSpecs: null,
    },
  ],
  sddcManagerSpec: {
    hostname: 'sddcm01.vcf.lab',
    localUserPassword: 'VMware1!VMware1!',
    // The Installer appliance converts itself into SDDC Manager here.
    useExistingDeployment: true,
  },
} as unknown as SddcSpec;

/** Three-host deployment. Identical apart from host count and instance name. */
export const THREE_NODE_VSAN_ESA = {
  ...ONE_NODE_VSAN_ESA,
  vcfInstanceName: 'William Lam VCF 9.1 Instance',
  hostSpecs: [
    { hostname: 'esx01.vcf.lab', credentials: { username: 'root', password: 'VMware1!' } },
    { hostname: 'esx02.vcf.lab', credentials: { username: 'root', password: 'VMware1!' } },
    { hostname: 'esx03.vcf.lab', credentials: { username: 'root', password: 'VMware1!' } },
  ],
} as unknown as SddcSpec;

export const REAL_SPECS: { name: string; spec: SddcSpec }[] = [
  { name: 'one-node-vsan-esa', spec: ONE_NODE_VSAN_ESA },
  { name: 'three-node-vsan-esa', spec: THREE_NODE_VSAN_ESA },
];

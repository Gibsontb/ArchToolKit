/**
 * Editing a VCF deployment specification that already exists.
 *
 * The builder writes a spec from a plan. This is for the other case: a spec
 * that already deployed — exported from the VCF Installer, or built here —
 * and now needs changing because some of the systems have. New hostnames, a
 * re-addressed subnet, a different datastore, another host. Rebuilding it from
 * scratch would lose everything that was not changing; editing the JSON by
 * hand loses the checks.
 *
 * So the document is edited as it is, field by field, in the data editor.
 * The editing itself is generic (../editor/doc.ts); what is VCF's lives here:
 * the answer sets, and the labels. The generic helpers are re-exported so
 * existing callers keep working. The editor's generic operations cover:
 *
 *  - paths, and reading and writing through them without mutating the original;
 *  - the answer set for every field that has one, keyed by the path pattern
 *    (`networkSpecs[].teamingPolicy`), so a size or a teaming policy is a
 *    dropdown and not a text box;
 *  - what adding an entry to a list means (a copy of the last one, since a new
 *    host looks like the previous host);
 *  - find-and-replace across every value, for the change that touches forty
 *    fields at once — a domain, a subnet prefix, a site code;
 *  - the difference from the document as it was loaded;
 *  - the passwords, which an installer export carries in clear text.
 */

import { EVC_MODES } from './spec-types.ts';
import { INTERNAL_CLUSTER_CIDRS_V4, INTERNAL_CLUSTER_CIDRS_V6 } from './sizing-data.ts';
import {
  COLLECTOR_SIZES,
  DOCUMENTED_SIZES,
  ESXI_CERTS_MODES,
  HOST_SWITCH_MODES,
  IP_ADDRESS_VERSIONS,
  IP_ASSIGNMENT_MODES,
  LACP_MODES,
  LACP_TIMEOUT_MODES,
  LAG_LOAD_BALANCING_MODES,
  NETWORK_TEAMING_POLICIES,
  NETWORK_TYPES,
  NSX_MANAGER_SIZES,
  NSX_TEAMING_POLICIES,
  OPS_NODE_TYPES,
  OPS_SIZES,
  RESOURCE_POOL_TYPES,
  TRANSPORT_TYPES,
  VCENTER_STORAGE_SIZES,
  VCENTER_VM_SIZES,
  VPC_TYPES,
  VSP_SIZES,
  VTEP_TYPES,
  WORKFLOW_TYPES,
} from './spec-validate.ts';
import { labelFor as genericLabel, pathPattern, type Path } from '../editor/doc.ts';

export {
  diff,
  findReplace,
  getAt,
  isSecretPath,
  moveAt,
  newEntry,
  parsePath,
  pathPattern,
  pathString,
  redactSecrets,
  removeAt,
  secretPaths,
  setAt,
  type Change,
  type Json,
  type Path,
  type Replacement,
} from '../editor/doc.ts';

// ---------------------------------------------------------------------------
// Answer sets
// ---------------------------------------------------------------------------

const UPLINKS = ['uplink1', 'uplink2', 'uplink3', 'uplink4'];

/**
 * Fields with a fixed set of answers, by path pattern. Every enumeration here
 * is the VCF 9.1 Installer API's own, taken from the same lists the validator
 * checks against (spec-validate.ts), so a dropdown cannot offer something the
 * validator or the installer would refuse. Every key is a real schema path;
 * spec-validate-full.test.ts holds them to `schemaPaths()`.
 *
 * Where the API publishes no enum (vidbSpec.size, vcfAutomationSpec.size) the
 * list is the sizes the 9.1 documentation gives. The data store kind has no
 * enum: it is chosen by which of vsanSpec, nfsDatastoreSpec or
 * vmfsDatastoreSpec is present.
 */
export const CHOICES: Readonly<Record<string, readonly string[]>> = {
  workflowType: WORKFLOW_TYPES,
  version: ['9.1.0.0', '9.1.0.400', '9.1.1.0'],

  // networks
  'networkSpecs[].networkType': NETWORK_TYPES,
  'networkSpecs[].ipAddressVersion': IP_ADDRESS_VERSIONS,
  // Was keyed 'networkSpecs[].assignmentMode', a field the schema does not have.
  'networkSpecs[].ipAddressAssignmentMode': IP_ASSIGNMENT_MODES,
  'networkSpecs[].teamingPolicy': NETWORK_TEAMING_POLICIES,
  'networkSpecs[].activeUplinks[]': UPLINKS,
  'networkSpecs[].standbyUplinks[]': UPLINKS,

  // vCenter and cluster
  'vcenterSpec.vmSize': VCENTER_VM_SIZES,
  'vcenterSpec.storageSize': VCENTER_STORAGE_SIZES,
  'vcenterSpec.ssoDomain': ['vsphere.local'],
  'clusterSpec.clusterEvcMode': [...EVC_MODES],
  'clusterSpec.resourcePoolSpecs[].type': RESOURCE_POOL_TYPES,
  'hostSpecs[].credentials.username': ['root'],
  'securitySpec.esxiCertsMode': ESXI_CERTS_MODES,

  // switches
  'dvsSpecs[].networks[]': NETWORK_TYPES,
  'dvsSpecs[].vmnicsToUplinks[].uplink': UPLINKS,
  'dvsSpecs[].nsxtSwitchConfig.transportZones[].transportType': TRANSPORT_TYPES,
  'dvsSpecs[].nsxtSwitchConfig.hostSwitchOperationalMode': HOST_SWITCH_MODES,
  'dvsSpecs[].nsxTeamings[].policy': NSX_TEAMING_POLICIES,
  'dvsSpecs[].nsxTeamings[].activeUplinks[]': UPLINKS,
  'dvsSpecs[].nsxTeamings[].standByUplinks[]': UPLINKS,
  'dvsSpecs[].lagSpecs[].lacpMode': LACP_MODES,
  'dvsSpecs[].lagSpecs[].lacpTimeoutMode': LACP_TIMEOUT_MODES,
  'dvsSpecs[].lagSpecs[].loadBalancingMode': LAG_LOAD_BALANCING_MODES,

  // NSX
  'nsxtSpec.nsxtManagerSize': NSX_MANAGER_SIZES,
  'nsxtSpec.vpcSpec.vpcNetworkConfigurationType': VPC_TYPES,
  'nsxtSpec.overlayVtepSpec.vtepType': VTEP_TYPES,

  // appliance sizes
  'vcfOperationsSpec.applianceSize': OPS_SIZES,
  'vcfOperationsSpec.nodes[].type': OPS_NODE_TYPES,
  'vcfOperationsCollectorSpec.applianceSize': COLLECTOR_SIZES,
  'vspClusterSpec.size': VSP_SIZES,
  'vcfAutomationSpec.size': DOCUMENTED_SIZES,
  'vidbSpec.size': DOCUMENTED_SIZES,

  // internal cluster networks
  'vspClusterSpec.internalClusterCidrIpv4': INTERNAL_CLUSTER_CIDRS_V4,
  'vspClusterSpec.internalClusterCidrIpv6': INTERNAL_CLUSTER_CIDRS_V6,
  'vcfAutomationSpec.internalClusterCidr': INTERNAL_CLUSTER_CIDRS_V4,
};

export function choicesFor(path: Path): readonly string[] | undefined {
  return CHOICES[pathPattern(path)];
}

/** A human label for a key: `vcfOperationsCollectorSpec` → `VCF Operations collector`. */
export const VCF_LABELS: Readonly<Record<string, string>> = {
  sddcId: 'SDDC ID',
  vcfInstanceName: 'VCF instance name',
  ceipEnabled: 'CEIP enabled',
  dnsSpec: 'DNS',
  ntpServers: 'NTP servers',
  hostSpecs: 'Hosts',
  networkSpecs: 'Networks',
  vspClusterSpec: 'VCF Management Services',
  vcfAutomationSpec: 'VCF Automation',
  nsxtSpec: 'NSX',
  vcfOperationsSpec: 'VCF Operations',
  vcfOperationsCollectorSpec: 'VCF Operations collector',
  licenseServerSpec: 'License server',
  vidbSpec: 'Identity broker',
  fleetLcmSpec: 'Fleet lifecycle',
  sddcLcmSpec: 'Instance lifecycle',
  vcenterSpec: 'vCenter',
  clusterSpec: 'Cluster',
  datastoreSpec: 'Datastore',
  dvsSpecs: 'Distributed switches',
  sddcManagerSpec: 'SDDC Manager',
  vlanId: 'VLAN',
  mtu: 'MTU',
  fqdn: 'FQDN',
  vipFqdn: 'VIP FQDN',
  ipPool: 'IP pool',
  ipv4Pool: 'IPv4 pool',
  sslThumbprint: 'SSL thumbprint',
  sshThumbprint: 'SSH thumbprint',
  // Where the generic rule reads badly.
  vcenterHostname: 'vCenter FQDN',
  rootVcenterPassword: 'vCenter root password',
  vcfManagementComponentsInfrastructureSpec: 'VCF management component networks',
  xRegionNetwork: 'Cross-region network',
  localRegionNetwork: 'Local-region network',
  lagSpecs: 'LAGs (LACP)',
  nsxTeamings: 'NSX uplink teaming',
  standByUplinks: 'Standby uplinks',
  nsxtSwitchConfig: 'NSX switch configuration',
  hostSwitchOperationalMode: 'Host switch mode',
  overlayVtepSpec: 'Overlay TEPs',
  vtepType: 'TEP type',
  privateTgwIpBlockCidr: 'Private transit gateway IP block CIDR',
  dtgwSpec: 'Distributed transit gateway',
  vpcNetworkConfigurationType: 'VPC type',
  esxiCertsMode: 'ESX certificate mode',
  rootCaCerts: 'Root CA certificates',
  certChain: 'Certificate chain',
  esaConfig: 'vSAN ESA',
  // The wizard's wording. Setting it true lets vSAN ESA claim disks that are
  // not on the HCL; "Skip automatic disk claim" says the opposite.
  skipHclAutoDiskClaim: 'Allow auto-claim of HCL-incompatible disks',
  vsanDedup: 'vSAN deduplication and compression',
  nasVolume: 'NAS volume',
  enableBindToVmknic: 'Bind to VMkernel adapter',
  dataInTransitConfig: 'Data-in-transit encryption',
  rekeyInterval: 'Rekey interval (minutes)',
  cpuReservationMhz: 'CPU reservation (MHz)',
  memoryReservationMb: 'Memory reservation (MB)',
  saltSpec: 'Salt',
  saltRaasSpec: 'Salt RaaS',
  fleetDepotSpec: 'Fleet depot',
  ipAddressPoolSpec: 'Host TEP IP pool',
  transportVlanId: 'Host TEP VLAN',
  portGroupKey: 'Port group name',
  useExistingDeployment: 'Existing deployment',
  skipNsxOverlayOverManagementNetwork: 'Skip NSX overlay on management network',
  enableEdgeClusterSync: 'Sync Edge clusters (resets Edge passwords)',
  ignoreUnavailableNsxtCluster: 'Ignore unavailable NSX cluster',
  failuresToTolerate: 'Failures to tolerate (FTT)',
  platformFqdn: 'Platform FQDN',
  loadBalancerFqdn: 'Load balancer FQDN',
  vmnicsToUplinks: 'vmnic to uplink mapping',
};

export function labelFor(key: string): string {
  return genericLabel(key, VCF_LABELS);
}

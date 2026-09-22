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

const SIZES_OPS = ['xsmall', 'small', 'medium', 'large', 'xlarge'];

/**
 * Fields with a fixed set of answers, by path pattern. Every value here is the
 * VCF 9.1 Installer API's own enumeration (see spec-types.ts), so a dropdown
 * cannot offer something the installer would refuse.
 */
export const CHOICES: Readonly<Record<string, readonly string[]>> = {
  workflowType: ['VCF', 'VCF_COMPLETE', 'VCF_EXTEND', 'VVF', 'VCF_BOOTSTRAP'],
  version: ['9.1.0.0', '9.1.0.400', '9.1.1.0'],
  'networkSpecs[].networkType': ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN', 'NFS', 'FLEET_MANAGEMENT'],
  'networkSpecs[].ipAddressVersion': ['IPv4', 'IPv6'],
  'networkSpecs[].assignmentMode': ['STATIC', 'DHCP', 'SLAAC'],
  'networkSpecs[].teamingPolicy': [
    'loadbalance_loadbased',
    'loadbalance_srcid',
    'loadbalance_srcmac',
    'loadbalance_ip',
    'failover_explicit',
  ],
  'networkSpecs[].activeUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'networkSpecs[].standbyUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'vcenterSpec.vmSize': ['tiny', 'small', 'medium', 'large', 'xlarge'],
  'vcenterSpec.storageSize': ['lstorage', 'xlstorage'],
  'nsxtSpec.nsxtManagerSize': ['medium', 'large', 'xlarge'],
  'vcfOperationsSpec.applianceSize': SIZES_OPS,
  'vcfOperationsSpec.nodes[].type': ['master', 'replica', 'data'],
  'vcfOperationsCollectorSpec.applianceSize': ['small', 'standard'],
  'vspClusterSpec.size': ['small', 'small_ha', 'medium', 'large'],
  'vcfAutomationSpec.size': ['small', 'medium', 'large'],
  'clusterSpec.clusterEvcMode': [...EVC_MODES],
  'dvsSpecs[].nsxtSwitchConfig.transportZones[].transportType': ['OVERLAY', 'VLAN'],
  'dvsSpecs[].nsxTeamings[].policy': ['LOADBALANCE_SRCID', 'LOADBALANCE_SRC_MAC', 'FAILOVER_ORDER'],
  'dvsSpecs[].nsxTeamings[].activeUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'dvsSpecs[].nsxTeamings[].standByUplinks[]': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'dvsSpecs[].vmnicsToUplinks[].uplink': ['uplink1', 'uplink2', 'uplink3', 'uplink4'],
  'dvsSpecs[].networks[]': ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN', 'NFS', 'FLEET_MANAGEMENT'],
  'hostSpecs[].credentials.username': ['root'],
  'vcenterSpec.ssoDomain': ['vsphere.local'],
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
};

export function labelFor(key: string): string {
  return genericLabel(key, VCF_LABELS);
}

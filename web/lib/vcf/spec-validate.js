/**
 * `SddcSpec` validation.
 *
 * Checks a spec against the documented 9.1 constraints before it ever reaches
 * an installer: required keys, field formats, cross-field consistency, network
 * overlaps, and version drift from 9.0.
 *
 * This is deliberately conservative. Where the published schema and a real
 * working spec disagree, a warning is emitted rather than an error, because
 * rejecting a spec the installer would have accepted is worse than flagging it.
 *
 * This does NOT replace `POST /v1/sddcs/validations` on a live installer,
 * which is authoritative. It replaces the round trip you cannot make offline.
 */

import { error, warning, info,              } from '../core/findings.js';
import { parseCidr, parseIPv4, usableAddresses } from '../core/net.js';
import { familyOf, isIp, parseCidrAny, formatCidrAny, overlapsAny, containsAny,             } from '../core/ip.js';
import { parseIPv6, v6ToBig } from '../core/net-calc.js';
import { didYouMean } from '../editor/profile.js';
import { atLeastVcfVersion, AUTOMATION_SIX_IP_VERSION } from './version.js';
import {
  SDDC_SPEC_REQUIRED_KEYS,
  REMOVED_IN_91_KEYS,
  PLACEHOLDER_SECRET,
  EVC_MODES,
  isPlaceholderSecret,
                
                       
                                          
                
                
} from './spec-types.js';
import {
  VLAN_MIN,
  VLAN_MAX,
  MTU_MIN,
  MTU_MAX,
  NSX_OVERLAY_MIN_MTU,
  MAX_NAMESERVERS,
  INTERNAL_CLUSTER_CIDRS_V4,
  VCFMS_MIN_IPS,
  AUTOMATION_IP_COUNT,
  INTERNAL_CLUSTER_CIDRS_V6,
} from './sizing-data.js';

const SDDC_ID_PATTERN = /^[a-zA-Z0-9-]{3,20}$/;
const RFC1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const POOL_NAME_PATTERN = /^[a-zA-Z0-9-_]+$/;
const NODE_PREFIX_PATTERN = /^[a-z0-9]([a-z0-9-]{0,55}[a-z0-9])?$/;

/** Password complexity required by SddcManagerSpec.rootPassword. */
const SPECIAL_CHARS = /[!%@$^#?*]/;

// ---------------------------------------------------------------------------
// The published schema, as data
// ---------------------------------------------------------------------------
//
// Every enumeration below is verbatim from the VCF Installer API 9.1 / 9.1.1
// data structures (SddcSpec and its nested types), including Broadcom's own
// spellings. The editor's dropdowns (spec-edit.ts CHOICES) are built from these
// same lists, so a dropdown and the validator cannot disagree.

export const WORKFLOW_TYPES = ['VCF', 'VCF_COMPLETE', 'VCF_EXTEND', 'VVF', 'VCF_BOOTSTRAP']         ;
/** SddcNetworkSpec.networkType. Custom names are also accepted. */
export const NETWORK_TYPES = ['MANAGEMENT', 'VM_MANAGEMENT', 'VMOTION', 'VSAN', 'NFS', 'FLEET_MANAGEMENT']         ;
export const NETWORK_TEAMING_POLICIES = [
  'loadbalance_loadbased',
  'loadbalance_srcid',
  'loadbalance_srcmac',
  'loadbalance_ip',
  'failover_explicit',
]         ;
export const IP_ADDRESS_VERSIONS = ['IPv4', 'IPv6']         ;
export const IP_ASSIGNMENT_MODES = ['STATIC', 'DHCP', 'SLAAC']         ;
export const VCENTER_VM_SIZES = ['tiny', 'small', 'medium', 'large', 'xlarge']         ;
export const VCENTER_STORAGE_SIZES = ['lstorage', 'xlstorage']         ;
export const NSX_MANAGER_SIZES = ['medium', 'large', 'xlarge']         ;
export const RESOURCE_POOL_TYPES = ['management', 'compute', 'network']         ;
export const TRANSPORT_TYPES = ['OVERLAY', 'VLAN']         ;
export const HOST_SWITCH_MODES = ['STANDARD', 'ENS', 'ENS_INTERRUPT']         ;
export const NSX_TEAMING_POLICIES = ['LOADBALANCE_SRCID', 'LOADBALANCE_SRC_MAC', 'FAILOVER_ORDER']         ;
export const LACP_MODES = ['ACTIVE', 'PASSIVE']         ;
export const LACP_TIMEOUT_MODES = ['SLOW', 'FAST']         ;
export const LAG_LOAD_BALANCING_MODES = [
  'SOURCE_MAC',
  'DESTINATION_MAC',
  'SOURCE_AND_DESTINATION_MAC',
  'DESTINATION_IP_AND_VLAN',
  'SOURCE_IP_AND_VLAN',
  'SOURCE_AND_DESTINATION_IP_AND_VLAN',
  'DESTINATION_TCP_UDP_PORT',
  'SOURCE_TCP_UDP_PORT',
  'SOURCE_AND_DESTINATION_TCP_UDP_PORT',
  'DESTINATION_IP_AND_TCP_UDP_PORT',
  'SOURCE_IP_AND_TCP_UDP_PORT',
  'SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT',
  'DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN',
  'SOURCE_IP_AND_TCP_UDP_PORT_AND_VLAN',
  'SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT_AND_VLAN',
  'DESTINATION_IP',
  'SOURCE_IP',
  'SOURCE_AND_DESTINATION_IP',
  'VLAN',
  'SOURCE_PORT_ID',
]         ;
/** The two usable VPC types. The API enum also lists VPC_UNSUPPORTED and INVALID_TYPE. */
export const VPC_TYPES = ['FULL_STACK_VPC', 'VLAN_BACKED_VPC']         ;
const VPC_TYPES_ALL = [...VPC_TYPES, 'VPC_UNSUPPORTED', 'INVALID_TYPE']         ;
export const VTEP_TYPES = ['NO_IP']         ;
export const ESXI_CERTS_MODES = ['VMCA', 'Custom']         ;
export const OPS_SIZES = ['xsmall', 'small', 'medium', 'large', 'xlarge']         ;
export const OPS_NODE_TYPES = ['master', 'replica', 'data']         ;
export const COLLECTOR_SIZES = ['small', 'standard']         ;
export const VSP_SIZES = ['small', 'small_ha', 'medium', 'large']         ;
/**
 * VidbSpec.size and VcfAutomationSpec.size are plain strings in the API; these
 * are the sizes the 9.1 documentation gives, so a different value is a warning.
 */
export const DOCUMENTED_SIZES = ['small', 'medium', 'large']         ;

                                                  

                       
                                                                                  
                     
                                    
                                                                                                          
                                                             
                             
 
                                                          

const str = (o                       = {})              => ({ kind: 'string', ...o });
const num = (o                       = {})              => ({ kind: 'number', ...o });
const bool = (o                       = {})              => ({ kind: 'boolean', ...o });
const strs = (o                       = {})              => ({ kind: 'strings', ...o });
const obj = (of              , o                       = {})              => ({ kind: 'object', of, ...o });
const arr = (of              , o                       = {})              => ({ kind: 'array', of, ...o });
const oneOf = (values                   , o                       = {})              => str({ enum: values, ...o });

const EXISTING = { version: str(), useExistingDeployment: bool(), sslThumbprint: str() };
const IP_RANGE               = { startIpAddress: str({ req: true }), endIpAddress: str({ req: true }) };
const IP_POOL               = { cidr: str(), ipRange: obj(IP_RANGE), addresses: strs(), excludedAddresses: strs() };
const SERVICE               = { version: str(), size: str() };
/** fleetLcmSpec and sddcLcmSpec carry a hostname in real working 9.1 specs, though the API page omits it. */
const LCM_SERVICE               = { hostname: str(), version: str(), size: str() };
const MC_NETWORK               = {
  networkName: str({ req: 'handled' }),
  subnetMask: str({ req: 'handled' }),
  gateway: str({ req: 'handled' }),
  ipv6Gateway: str(),
  ipv6Prefix: num(),
};

/**
 * The SddcSpec field tree for VCF 9.1 / 9.1.1 (the two are field-identical).
 * `vspClusterSpec.name` is undocumented but present in Broadcom's own VVF
 * sample and in specs that deployed, so it is accepted.
 */
export const SDDC_SCHEMA               = {
  sddcId: str({ req: 'handled' }),
  vcenterSpec: obj(
    {
      vcenterHostname: str({ req: true }),
      // Marked required, but "for VCF only: if blank ... auto-generated", and a
      // real 9.1.1.0 export that deployed omits it. Not enforced.
      rootVcenterPassword: str(),
      vmSize: oneOf(VCENTER_VM_SIZES),
      storageSize: oneOf(VCENTER_STORAGE_SIZES),
      ssoDomain: str(),
      adminUserSsoUsername: str(),
      adminUserSsoPassword: str(),
      ...EXISTING,
    },
    { req: 'handled' },
  ),
  networkSpecs: arr(
    {
      networkType: oneOf(NETWORK_TYPES, { req: true, enumMode: 'open' }),
      vlanId: num({ req: true }),
      subnet: str(),
      gateway: str(),
      subnetMask: str(),
      mtu: num(),
      includeIpAddress: strs(),
      includeIpAddressRanges: arr(IP_RANGE),
      teamingPolicy: oneOf(NETWORK_TEAMING_POLICIES),
      activeUplinks: strs(),
      standbyUplinks: strs(),
      portGroupKey: str(),
      ipAddressVersion: oneOf(IP_ADDRESS_VERSIONS),
      ipAddressAssignmentMode: oneOf(IP_ASSIGNMENT_MODES),
    },
    { req: 'handled' },
  ),
  dnsSpec: obj({ subdomain: str({ req: true }), nameservers: strs() }, { req: 'handled' }),
  workflowType: oneOf(WORKFLOW_TYPES),
  vcfInstanceName: str(),
  version: str(),
  hostSpecs: arr({
    hostname: str({ req: true }),
    credentials: obj({ username: str(), password: str({ req: true }) }),
    sshThumbprint: str(),
    sslThumbprint: str(),
  }),
  clusterSpec: obj({
    datacenterName: str(),
    clusterName: str(),
    clusterEvcMode: oneOf(EVC_MODES                     ),
    resourcePoolSpecs: arr({
      name: str(),
      type: oneOf(RESOURCE_POOL_TYPES),
      cpuSharesLevel: str(),
      cpuSharesValue: num(),
      cpuLimit: num(),
      cpuReservationExpandable: bool(),
      cpuReservationMhz: num(),
      cpuReservationPercentage: num(),
      memorySharesLevel: str(),
      memorySharesValue: num(),
      memoryLimit: num(),
      memoryReservationExpandable: bool(),
      memoryReservationMb: num(),
      memoryReservationPercentage: num(),
    }),
  }),
  dvsSpecs: arr({
    dvsName: str(),
    networks: strs({ enum: NETWORK_TYPES, enumMode: 'open' }),
    mtu: num(),
    nsxtSwitchConfig: obj({
      transportZones: arr({ name: str(), transportType: oneOf(TRANSPORT_TYPES, { req: true }) }),
      hostSwitchOperationalMode: oneOf(HOST_SWITCH_MODES),
      ipAssignmentType: str(),
    }),
    vmnicsToUplinks: arr({ id: str({ req: true }), uplink: str({ req: true }) }, { req: 'handled' }),
    nsxTeamings: arr({
      policy: oneOf(NSX_TEAMING_POLICIES, { req: true }),
      activeUplinks: strs({ req: 'handled' }),
      standByUplinks: strs(),
    }),
    lagSpecs: arr({
      name: str({ req: true }),
      uplinksCount: num({ req: true }),
      lacpMode: oneOf(LACP_MODES, { req: true }),
      lacpTimeoutMode: oneOf(LACP_TIMEOUT_MODES, { req: true }),
      loadBalancingMode: oneOf(LAG_LOAD_BALANCING_MODES, { req: true }),
    }),
  }),
  nsxtSpec: obj({
    nsxtManagers: arr({ hostname: str() }, { req: true }),
    vipFqdn: str({ req: true }),
    nsxtManagerSize: oneOf(NSX_MANAGER_SIZES, { enumMode: 'handled' }),
    rootNsxtManagerPassword: str(),
    nsxtAdminPassword: str(),
    nsxtAuditPassword: str(),
    transportVlanId: num(),
    ipAddressPoolSpec: obj({
      name: str({ req: true }),
      description: str(),
      ignoreUnavailableNsxtCluster: bool(),
      subnets: arr({
        cidr: str({ req: true }),
        gateway: str({ req: true }),
        ipAddressPoolRanges: arr({ start: str({ req: true }), end: str({ req: true }) }, { req: true }),
      }),
    }),
    vpcSpec: obj({
      vpcNetworkConfigurationType: oneOf(VPC_TYPES_ALL),
      dtgwSpec: obj({
        vlan: num({ req: true }),
        gatewayCidr: str({ req: true }),
        externalIpBlockCidr: str({ req: true }),
        privateTgwIpBlockCidr: str(),
      }),
    }),
    skipNsxOverlayOverManagementNetwork: bool(),
    enableEdgeClusterSync: bool(),
    overlayVtepSpec: obj({ vtepType: oneOf(VTEP_TYPES) }),
    ...EXISTING,
  }),
  ntpServers: strs(),
  sddcManagerSpec: obj({
    hostname: str({ req: true }),
    rootPassword: str(),
    sshPassword: str(),
    localUserPassword: str(),
    ...EXISTING,
  }),
  managementPoolName: str(),
  ceipEnabled: bool(),
  skipEsxThumbprintValidation: bool(),
  skipGatewayPingValidation: bool(),
  securitySpec: obj({
    esxiCertsMode: oneOf(ESXI_CERTS_MODES),
    rootCaCerts: arr({ alias: str(), certChain: strs() }),
  }),
  datastoreSpec: obj({
    vsanSpec: obj({
      datastoreName: str(),
      vsanDedup: bool(),
      failuresToTolerate: num(),
      esaConfig: obj({ enabled: bool(), skipHclAutoDiskClaim: bool() }),
      encryptionConfig: obj({
        dataInTransitConfig: obj({ enable: bool({ req: true }), rekeyInterval: num() }),
      }),
    }),
    nfsDatastoreSpec: obj({
      datastoreName: str(),
      nasVolume: obj(
        {
          serverName: strs({ req: true }),
          path: str({ req: true }),
          readOnly: bool({ req: 'handled' }),
          userTag: str(),
          enableBindToVmknic: bool(),
        },
        { req: true },
      ),
    }),
    vmfsDatastoreSpec: obj({ fcSpec: arr({ datastoreName: str() }) }),
    existingDatastoreName: str(),
  }),
  vspClusterSpec: obj({
    platformFqdn: str({ req: true }),
    instanceFqdn: str({ req: true }),
    fleetFqdn: str(),
    ipv4Pool: obj(IP_POOL, { req: true }),
    ipv6Pool: obj(IP_POOL),
    systemUserPassword: str(),
    size: oneOf(VSP_SIZES),
    internalClusterCidrIpv4: oneOf(INTERNAL_CLUSTER_CIDRS_V4, { enumMode: 'handled' }),
    internalClusterCidrIpv6: oneOf(INTERNAL_CLUSTER_CIDRS_V6, { enumMode: 'handled' }),
    name: str(),
    ...EXISTING,
  }),
  fleetLcmSpec: obj(LCM_SERVICE),
  sddcLcmSpec: obj(LCM_SERVICE),
  fleetDepotSpec: obj(SERVICE),
  telemetryAcceptorSpec: obj(SERVICE),
  vidbSpec: obj({ hostname: str({ req: true }), version: str(), size: oneOf(DOCUMENTED_SIZES, { enumMode: 'soft' }) }),
  saltSpec: obj(SERVICE),
  saltRaasSpec: obj(SERVICE),
  vcfOperationsSpec: obj({
    nodes: arr(
      {
        hostname: str({ req: true }),
        rootUserPassword: str(),
        type: oneOf(OPS_NODE_TYPES),
        sslThumbprint: str(),
      },
      { req: true },
    ),
    adminUserPassword: str(),
    applianceSize: oneOf(OPS_SIZES),
    loadBalancerFqdn: str(),
    useExistingDeployment: bool(),
    version: str(),
  }),
  vcfOperationsCollectorSpec: obj({
    hostname: str({ req: true }),
    rootUserPassword: str(),
    applianceSize: oneOf(COLLECTOR_SIZES),
    ...EXISTING,
  }),
  vcfAutomationSpec: obj({
    hostname: str({ req: true }),
    internalClusterCidr: str({ req: true }),
    platformFqdn: str({ req: 'unlessExisting' }),
    adminUserPassword: str(),
    ipPool: strs(),
    nodePrefix: str(),
    size: oneOf(DOCUMENTED_SIZES, { enumMode: 'soft' }),
    ...EXISTING,
  }),
  vcfManagementComponentsInfrastructureSpec: obj({
    localRegionNetwork: obj(MC_NETWORK),
    xRegionNetwork: obj(MC_NETWORK),
  }),
  licenseServerSpec: obj({ hostname: str({ req: true }), ...EXISTING }),
};

/**
 * Every field path the schema defines, in the editor's pattern form
 * (`networkSpecs[].teamingPolicy`, `dvsSpecs[].networks[]`).
 */
export function schemaPaths()           {
  const out           = [];
  const walk = (schema              , prefix        )       => {
    for (const [key, field] of Object.entries(schema)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      if (field.kind === 'strings') out.push(`${path}[]`);
      if (field.kind === 'object' && field.of) walk(field.of, path);
      if (field.kind === 'array' && field.of) {
        out.push(`${path}[]`);
        walk(field.of, `${path}[]`);
      }
    }
  };
  walk(SDDC_SCHEMA, '');
  return out;
}

const isPlainObject = (v         )                               =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A typo's likely intended key: edit distance, then containment (assignmentMode → ipAddressAssignmentMode). */
function suggestKey(key        , options                   )                     {
  const lower = key.toLowerCase();
  const exactCase = options.find((o) => o.toLowerCase() === lower);
  if (exactCase) return exactCase;
  const close = didYouMean(key, options);
  if (close) return close;
  if (key.length >= 4) {
    const contained = options.filter((o) => o.toLowerCase().includes(lower) || lower.includes(o.toLowerCase()));
    if (contained.length === 1) return contained[0];
  }
  return undefined;
}

/** Keys at the top level that have their own, more specific finding. */
const TOP_LEVEL_HANDLED = (key        )          =>
  (REMOVED_IN_91_KEYS                     ).includes(key) || /licenseKey|licenseFile|licenses$/i.test(key);

/**
 * Walk the document against SDDC_SCHEMA: unknown keys (with a did-you-mean),
 * required fields, enumerations and container types. Field-specific checks
 * that already exist elsewhere in this file are marked 'handled' and skipped.
 */
function checkAgainstSchema(findings           , doc                         )       {
  const source = 'VCF Installer API 9.1 — SddcSpec';

  const checkEnum = (value         , field             , path        )       => {
    if (!field.enum || field.enumMode === 'handled' || typeof value !== 'string') return;
    if (field.enum.includes(value)) return;
    const caseMatch = field.enum.find((e) => e.toLowerCase() === value.toLowerCase());
    if (field.enumMode === 'open') {
      if (caseMatch) {
        findings.push(
          warning('vcf.spec.enum-case', `"${value}" at ${path} differs only in case from the standard value "${caseMatch}"; it would be taken as a custom value.`, {
            path,
            remediation: `Use "${caseMatch}".`,
            source,
          }),
        );
      }
      return;
    }
    const hint = caseMatch ?? didYouMean(value, field.enum);
    const list = field.enum.join(', ');
    if (field.enumMode === 'soft') {
      findings.push(
        warning('vcf.spec.undocumented-value', `${path} "${value}" is not one of the documented values (${list}).`, {
          path,
          remediation: hint ? `Did you mean "${hint}"? The API does not publish an enum for this field; confirm the value with POST /v1/sddcs/validations.` : 'The API does not publish an enum for this field; confirm the value with POST /v1/sddcs/validations.',
          source: 'VCF 9.1 documentation',
        }),
      );
      return;
    }
    findings.push(
      error('vcf.spec.invalid-enum', `${path} "${value}" is not an accepted value. Accepted: ${list}.`, {
        path,
        ...(hint ? { remediation: `Did you mean "${hint}"? Values are case-sensitive.` } : {}),
        source,
      }),
    );
  };

  const walk = (node                         , schema              , at        )       => {
    const known = Object.keys(schema);
    for (const key of Object.keys(node)) {
      if (key in schema) continue;
      if (at === '' && TOP_LEVEL_HANDLED(key)) continue;
      const path = at ? `${at}.${key}` : key;
      const hint = suggestKey(key, known);
      findings.push(
        warning('vcf.spec.unknown-key', `"${key}" is not a field the 9.1 schema defines${at ? ` in ${at}` : ''}. The installer ignores or rejects it.`, {
          path,
          remediation: hint ? `Did you mean "${hint}"?` : `Known fields here: ${known.join(', ')}.`,
          source,
        }),
      );
    }

    for (const [key, field] of Object.entries(schema)) {
      const path = at ? `${at}.${key}` : key;
      const value = node[key];
      if (value === undefined || value === null) {
        const needed =
          field.req === true || (field.req === 'unlessExisting' && node.useExistingDeployment !== true);
        if (needed) {
          findings.push(
            error('vcf.spec.missing-required', `Required field "${path}" is missing.`, {
              path,
              ...(field.req === 'unlessExisting' ? { remediation: 'It may be omitted only when useExistingDeployment is true.' } : {}),
              source,
            }),
          );
        }
        continue;
      }
      if (field.kind === 'object') {
        if (!isPlainObject(value)) {
          findings.push(error('vcf.spec.wrong-type', `${path} must be an object.`, { path, source }));
          continue;
        }
        walk(value, field.of ?? {}, path);
      } else if (field.kind === 'array' || field.kind === 'strings') {
        if (!Array.isArray(value)) {
          findings.push(error('vcf.spec.wrong-type', `${path} must be a list.`, { path, source }));
          continue;
        }
        value.forEach((item, i) => {
          const itemPath = `${path}[${i}]`;
          if (field.kind === 'strings') {
            checkEnum(item, field, itemPath);
          } else if (isPlainObject(item)) {
            walk(item, field.of ?? {}, itemPath);
          } else {
            findings.push(error('vcf.spec.wrong-type', `${itemPath} must be an object.`, { path: itemPath, source }));
          }
        });
      } else {
        checkEnum(value, field, path);
      }
    }
  };

  walk(doc, SDDC_SCHEMA, '');
}

// ---------------------------------------------------------------------------
// Thumbprints
// ---------------------------------------------------------------------------

const SHA256_COLON = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;
const SHA1_COLON = /^([0-9A-Fa-f]{2}:){19}[0-9A-Fa-f]{2}$/;
const SHA256_BARE = /^[0-9A-Fa-f]{64}$/;
const SSH_SHA256 = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

/**
 * An SSL thumbprint in the form the API takes: the SHA-256 certificate
 * fingerprint as 32 colon-separated hex pairs.
 */
function checkSslThumbprint(findings           , value         , path        )       {
  if (typeof value !== 'string' || value === '') return;
  if (notePlaceholder(findings, value, path)) return;
  const t = value.trim();
  if (SHA256_COLON.test(t)) return;
  const source = 'VCF Installer API — sslThumbprint (SHA-256)';
  if (SHA1_COLON.test(t)) {
    findings.push(
      error('vcf.spec.thumbprint-sha1', `${path} is a SHA-1 thumbprint; VCF 9.1 takes the SHA-256 fingerprint.`, {
        path,
        remediation: 'Take the SHA-256 fingerprint: openssl s_client -connect <fqdn>:443 </dev/null | openssl x509 -noout -fingerprint -sha256',
        source,
      }),
    );
  } else if (SHA256_BARE.test(t)) {
    findings.push(
      warning('vcf.spec.thumbprint-format', `${path} is a SHA-256 value without separators; the API's examples write it as 32 colon-separated hex pairs.`, {
        path,
        remediation: `Use "${t.match(/../g) .join(':').toUpperCase()}".`,
        source,
      }),
    );
  } else {
    findings.push(
      error('vcf.spec.thumbprint-format', `${path} "${value}" is not a SHA-256 thumbprint (32 colon-separated hex pairs).`, {
        path,
        remediation: 'openssl s_client -connect <fqdn>:443 </dev/null | openssl x509 -noout -fingerprint -sha256',
        source,
      }),
    );
  }
}

/** Host SSH thumbprints: the SHA256:base64 form ssh-keygen prints, or a colon-hex SHA-256. */
function checkSshThumbprint(findings           , value         , path        )       {
  if (typeof value !== 'string' || value === '') return;
  if (notePlaceholder(findings, value, path)) return;
  if (SSH_SHA256.test(value.trim()) || SHA256_COLON.test(value.trim())) return;
  findings.push(
    warning('vcf.spec.thumbprint-format', `${path} "${value}" is not an SSH SHA-256 fingerprint (SHA256:<base64>).`, {
      path,
      remediation: 'ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub -E sha256 on the host, or ssh-keyscan <host> | ssh-keygen -lf -',
      source: 'VCF Installer API — SddcHostSpec',
    }),
  );
}

/** Every component that can be an existing deployment, and where its thumbprint lives. */
const EXISTING_COMPONENTS                                          = [
  ['vcenterSpec', 'vCenter'],
  ['nsxtSpec', 'NSX'],
  ['sddcManagerSpec', 'SDDC Manager'],
  ['vcfOperationsSpec', 'VCF Operations'],
  ['vcfOperationsCollectorSpec', 'VCF Operations collector (cloud proxy)'],
  ['vcfAutomationSpec', 'VCF Automation'],
  ['licenseServerSpec', 'License Server'],
  ['vspClusterSpec', 'VCF management services'],
];

function checkThumbprints(findings           , spec                         )       {
  for (const [key, label] of EXISTING_COMPONENTS) {
    const block = spec[key];
    if (!isPlainObject(block)) continue;
    if (key === 'vcfOperationsSpec') {
      const nodes = Array.isArray(block.nodes) ? block.nodes : [];
      nodes.forEach((node, i) => {
        if (isPlainObject(node)) checkSslThumbprint(findings, node.sslThumbprint, `vcfOperationsSpec.nodes[${i}].sslThumbprint`);
      });
      const first = nodes[0];
      if (block.useExistingDeployment === true && isPlainObject(first) && !first.sslThumbprint) {
        findings.push(
          warning('vcf.spec.existing-without-thumbprint', `${label} is existing, but its master node carries no sslThumbprint.`, {
            path: 'vcfOperationsSpec.nodes[0].sslThumbprint',
            remediation: 'Add the SHA-256 thumbprint of the existing master node, so the installer can trust it.',
            source: 'VCF Installer API — VcfOperationsNode',
          }),
        );
      }
      continue;
    }
    checkSslThumbprint(findings, block.sslThumbprint, `${key}.sslThumbprint`);
    // vCenter keeps its original error code, vcf.spec.missing-thumbprint.
    // SDDC Manager is excluded: specs that really deployed set
    // useExistingDeployment on it with no thumbprint, because the Installer
    // appliance itself becomes the SDDC Manager.
    if (key !== 'vcenterSpec' && key !== 'sddcManagerSpec' && block.useExistingDeployment === true && !block.sslThumbprint) {
      findings.push(
        warning('vcf.spec.existing-without-thumbprint', `${label} is existing (useExistingDeployment), but ${key}.sslThumbprint is absent.`, {
          path: `${key}.sslThumbprint`,
          remediation: `Add the SHA-256 thumbprint of the existing ${label}.`,
          source: 'VCF Installer API — SddcSpec',
        }),
      );
    }
  }
  const hosts = Array.isArray(spec.hostSpecs) ? spec.hostSpecs : [];
  hosts.forEach((host, i) => {
    if (!isPlainObject(host)) return;
    checkSslThumbprint(findings, host.sslThumbprint, `hostSpecs[${i}].sslThumbprint`);
    checkSshThumbprint(findings, host.sshThumbprint, `hostSpecs[${i}].sshThumbprint`);
  });
}

// ---------------------------------------------------------------------------
// FQDNs
// ---------------------------------------------------------------------------

/**
 * The component names that must be FQDNs. `strict` marks the ones the 9.1
 * wizard itself refuses in upper case or under .local: VCF management
 * services, the identity broker and VCF Automation.
 */
function componentFqdns(spec                         )                                                     {
  const out                                                     = [];
  const add = (path        , value         , strict = false)       => {
    if (typeof value === 'string' && value !== '' && !isPlaceholderSecret(value)) out.push({ path, value, strict });
  };
  const get = (key        )                          => (isPlainObject(spec[key]) ? (spec[key]                           ) : {});
  add('vcenterSpec.vcenterHostname', get('vcenterSpec').vcenterHostname);
  const nsx = get('nsxtSpec');
  add('nsxtSpec.vipFqdn', nsx.vipFqdn);
  (Array.isArray(nsx.nsxtManagers) ? nsx.nsxtManagers : []).forEach((m, i) => {
    if (isPlainObject(m)) add(`nsxtSpec.nsxtManagers[${i}].hostname`, m.hostname);
  });
  add('sddcManagerSpec.hostname', get('sddcManagerSpec').hostname);
  const vsp = get('vspClusterSpec');
  add('vspClusterSpec.platformFqdn', vsp.platformFqdn, true);
  add('vspClusterSpec.instanceFqdn', vsp.instanceFqdn, true);
  add('vspClusterSpec.fleetFqdn', vsp.fleetFqdn, true);
  const ops = get('vcfOperationsSpec');
  (Array.isArray(ops.nodes) ? ops.nodes : []).forEach((n, i) => {
    if (isPlainObject(n)) add(`vcfOperationsSpec.nodes[${i}].hostname`, n.hostname);
  });
  add('vcfOperationsSpec.loadBalancerFqdn', ops.loadBalancerFqdn);
  add('vcfOperationsCollectorSpec.hostname', get('vcfOperationsCollectorSpec').hostname);
  const auto = get('vcfAutomationSpec');
  add('vcfAutomationSpec.hostname', auto.hostname, true);
  add('vcfAutomationSpec.platformFqdn', auto.platformFqdn, true);
  add('vidbSpec.hostname', get('vidbSpec').hostname, true);
  add('licenseServerSpec.hostname', get('licenseServerSpec').hostname);
  return out;
}

function checkFqdns(findings           , spec                         )       {
  const source = 'VCF 9.1 Deployment — FQDN requirements';
  const names = componentFqdns(spec);
  const seen = new Map                ();
  const dns = spec.dnsSpec;
  const subdomain = isPlainObject(dns) && typeof dns.subdomain === 'string' ? dns.subdomain.toLowerCase() : '';

  for (const { path, value, strict } of names) {
    if (isIp(value)) {
      findings.push(
        error('vcf.spec.fqdn-is-ip', `${path} is the IP address ${value}; it must be a DNS name that resolves to it.`, {
          path,
          remediation: 'Create forward and reverse DNS records and use the name.',
          source,
        }),
      );
      continue;
    }
    const labels = value.replace(/\.$/, '').split('.');
    if (value.length > 253 || labels.some((l) => !RFC1123_LABEL.test(l))) {
      findings.push(
        error('vcf.spec.invalid-fqdn', `${path} "${value}" is not a valid DNS name (letters, digits and hyphens; labels of 1-63 characters).`, {
          path,
          source,
        }),
      );
      continue;
    }
    if (value !== value.toLowerCase()) {
      const make = strict ? error : warning;
      findings.push(
        make('vcf.spec.fqdn-not-lowercase', `${path} "${value}" contains upper case. ${strict ? 'VCF management services, identity broker and VCF Automation FQDNs must be lowercase.' : 'VCF expects every FQDN in lowercase.'}`, {
          path,
          remediation: `Use "${value.toLowerCase()}".`,
          source,
        }),
      );
    }
    if (/\.local\.?$/i.test(value)) {
      const make = strict ? error : warning;
      findings.push(
        make('vcf.spec.fqdn-local-suffix', `${path} "${value}" is under .local, which VCF does not support.`, { path, source }),
      );
    }
    // Every FQDN must resolve to its own IP, so a name used twice is two
    // components claiming one address.
    const key = (value.includes('.') || !subdomain ? value : `${value}.${subdomain}`).toLowerCase().replace(/\.$/, '');
    const first = seen.get(key);
    if (first) {
      findings.push(
        error('vcf.spec.duplicate-fqdn', `${path} reuses "${value}", already used by ${first}. Every FQDN must resolve to a unique IP.`, {
          path,
          source,
        }),
      );
    } else {
      seen.set(key, path);
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow shape
// ---------------------------------------------------------------------------

/**
 * What the deployment is, read from the document alone: the workflowType plus
 * which of vCenter and VCF Operations are existing. That is enough to pick the
 * row of Broadcom's decision table.
 */
function isVvfManagementServices(spec                   )          {
  return (
    spec.workflowType === 'VVF' &&
    spec.vcenterSpec?.useExistingDeployment === true &&
    spec.vcfOperationsSpec?.useExistingDeployment === true
  );
}

/** The two workflows whose documents carry only the component blocks. */
function isComponentsOnlyWorkflow(spec                   )          {
  return spec.workflowType === 'VCF_COMPLETE' || isVvfManagementServices(spec);
}

const INFRASTRUCTURE_BLOCKS = ['hostSpecs', 'networkSpecs', 'dvsSpecs', 'nsxtSpec', 'datastoreSpec', 'clusterSpec']         ;
const SERVICE_BLOCKS = ['fleetLcmSpec', 'sddcLcmSpec', 'fleetDepotSpec', 'telemetryAcceptorSpec', 'saltSpec', 'saltRaasSpec']         ;

function checkWorkflowShape(findings           , spec                                             )       {
  const wf = spec.workflowType;
  if (!wf || !(WORKFLOW_TYPES                     ).includes(wf)) return;
  const source = 'VCF 9.1 Deployment — Use a JSON Specification File (decision table)';
  const vcExisting = spec.vcenterSpec?.useExistingDeployment === true;
  const opsExisting = spec.vcfOperationsSpec?.useExistingDeployment === true;
  const has = (key        )          => spec[key] !== undefined && spec[key] !== null;
  const existing = (key        )          => isPlainObject(spec[key]) && (spec[key]                           ).useExistingDeployment === true;
  const row =
    wf === 'VCF'
      ? vcExisting ? 'Converge to a new VCF fleet' : 'Deploy a new VCF fleet'
      : wf === 'VCF_EXTEND'
        ? vcExisting ? 'Converge to a new VCF instance' : 'Deploy a new VCF Instance'
        : wf === 'VCF_COMPLETE'
          ? 'Deploy deferred components'
          : wf === 'VVF'
            ? isVvfManagementServices(spec)
              ? 'VCF management services and License Server for VVF'
              : vcExisting ? 'Converge to VVF' : 'Deploy a new VVF platform'
            : 'VCF_BOOTSTRAP';

  const need = (key        , why = '')       => {
    if (has(key)) return;
    findings.push(
      error('vcf.spec.workflow-missing-block', `"${row}" (workflowType ${wf}) needs ${key}${why ? `: ${why}` : '.'}`, { path: key, source }),
    );
  };
  const unexpected = (key        , severity                     , why        )       => {
    if (!has(key)) return;
    const make = severity === 'error' ? error : warning;
    findings.push(make('vcf.spec.workflow-unexpected-block', `"${row}" (workflowType ${wf}) should not carry ${key}: ${why}`, { path: key, remediation: `Remove ${key}.`, source }));
  };
  const mustBeExisting = (key        , want         , severity                     , why        )       => {
    if (!has(key) || existing(key) === want) return;
    const make = severity === 'error' ? error : warning;
    findings.push(
      make('vcf.spec.workflow-existing-mismatch', `"${row}" expects ${key}.useExistingDeployment to be ${want}. ${why}`, {
        path: `${key}.useExistingDeployment`,
        remediation: want ? `Set ${key}.useExistingDeployment to true and supply its sslThumbprint.` : `Remove useExistingDeployment from ${key}, or pick the workflow that reuses it.`,
        source,
      }),
    );
  };

  if (wf === 'VCF' || wf === 'VCF_EXTEND') {
    need('nsxtSpec', 'every VCF instance has NSX.');
    need('vspClusterSpec', 'VCF management services are part of every VCF fleet and instance row.');
  }

  if (wf === 'VCF') {
    // Ops, collector, License Server and Automation may all be left out
    // together: that is the wizard's "deploy them to a specific network later"
    // path, which a VCF_COMPLETE run finishes. Leaving out only some of them
    // matches no documented path.
    const components = ['vcfOperationsSpec', 'vcfOperationsCollectorSpec', 'licenseServerSpec', 'vcfAutomationSpec'];
    const absent = components.filter((k) => !has(k));
    if (absent.length === components.length) {
      findings.push(
        info('vcf.spec.components-deferred', 'VCF Operations, the cloud proxy, the License Server and VCF Automation are all absent: they are deferred to a later VCF_COMPLETE run.', {
          path: 'vcfOperationsSpec',
          source: 'VCF 9.1 Deployment — deployment wizard options',
        }),
      );
    } else if (absent.length > 0) {
      findings.push(
        warning('vcf.spec.components-partly-deferred', `${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} absent while the other management components are present. Only all four can be deferred together.`, {
          path: absent[0],
          remediation: 'Add the missing blocks. To defer VCF Automation alone, declare the existing one (useExistingDeployment) instead.',
          source,
        }),
      );
    }
    if (!vcExisting && !has('vidbSpec')) {
      findings.push(
        warning('vcf.spec.workflow-missing-identity-broker', 'A new VCF fleet has no vidbSpec. The identity broker is mandatory for the primary instance; without it only the vCenter-embedded model is available.', {
          path: 'vidbSpec',
          source,
        }),
      );
    }
  }

  if (wf === 'VCF_EXTEND') {
    const ops = spec.vcfOperationsSpec;
    if (!ops) {
      need('vcfOperationsSpec', 'a new instance attaches to the fleet’s existing VCF Operations.');
    } else {
      if (ops.useExistingDeployment !== true) {
        findings.push(
          error('vcf.spec.extend-needs-existing-operations', 'workflowType VCF_EXTEND joins an existing fleet, so vcfOperationsSpec.useExistingDeployment must be true.', {
            path: 'vcfOperationsSpec.useExistingDeployment',
            remediation: 'Set useExistingDeployment to true, list the existing master node with its sslThumbprint, and give the existing admin password.',
            source: 'VCF Installer API — VcfOperationsSpec',
          }),
        );
      }
      if (Array.isArray(ops.nodes) && ops.nodes.length !== 1) {
        findings.push(
          error('vcf.spec.extend-operations-node-count', `A new instance lists the fleet's existing VCF Operations master node only; ${ops.nodes.length} nodes are given.`, {
            path: 'vcfOperationsSpec.nodes',
            remediation: 'Keep exactly one node: the existing master, with type "master" and its sslThumbprint.',
            source: 'VCF Installer API — VcfOperationsSpec',
          }),
        );
      }
    }
    if (spec.vspClusterSpec?.fleetFqdn) {
      findings.push(
        error('vcf.spec.fleet-fqdn-on-secondary', 'vspClusterSpec.fleetFqdn is set on a VCF_EXTEND spec. It is provided for VVF and the primary instance only, never for an instance joining a fleet.', {
          path: 'vspClusterSpec.fleetFqdn',
          remediation: 'Remove fleetFqdn.',
          source: 'VCF Installer API — SddcVspClusterSpec',
        }),
      );
    }
    mustBeExisting('vcfAutomationSpec', true, 'error', 'VCF Automation is fleet-wide; a new instance reuses the fleet’s.');
    if (spec.fleetLcmSpec?.hostname) {
      findings.push(
        info('vcf.spec.fleet-service-on-secondary', 'fleetLcmSpec names a fleet-level host on a VCF_EXTEND spec. VERIFY: fleet-level services belong to the primary instance.', {
          path: 'fleetLcmSpec.hostname',
          source,
        }),
      );
    }
  }

  if (wf === 'VCF_COMPLETE') {
    if (!vcExisting && spec.vcenterSpec) {
      findings.push(
        error('vcf.spec.workflow-existing-mismatch', `"${row}" adds components to an instance that already exists, so vcenterSpec.useExistingDeployment must be true.`, {
          path: 'vcenterSpec.useExistingDeployment',
          remediation: 'Set useExistingDeployment to true and supply the vCenter sslThumbprint, as Broadcom’s deferred-components example does.',
          source: 'VCF 9.1 Deployment — Deploy deferred components',
        }),
      );
    }
    mustBeExisting('sddcManagerSpec', true, 'warning', 'Broadcom’s deferred-components example declares the instance’s SDDC Manager as existing.');
    need('vcfOperationsSpec');
    mustBeExisting('vcfOperationsSpec', false, 'warning', 'VCF Operations is one of the components this run deploys; Broadcom’s example sets it new.');
    mustBeExisting('vcfAutomationSpec', false, 'warning', 'VCF Automation is one of the components this run deploys.');
    unexpected('vidbSpec', 'warning', 'the decision table has no identity broker for this row.');
    if (!spec.vcfManagementComponentsInfrastructureSpec?.xRegionNetwork) {
      findings.push(
        warning('vcf.spec.deferred-without-xregion-network', 'Deferred components are placed on vcfManagementComponentsInfrastructureSpec.xRegionNetwork, which is absent.', {
          path: 'vcfManagementComponentsInfrastructureSpec.xRegionNetwork',
          remediation: 'Give the port group or NSX segment name, subnet mask and gateway the components go on.',
          source: 'VCF 9.1 Deployment — Deploy deferred components',
        }),
      );
    }
  }

  if (wf === 'VVF') {
    const mgmtServices = isVvfManagementServices(spec);
    if (opsExisting && !vcExisting) {
      findings.push(
        error('vcf.spec.workflow-existing-mismatch', 'workflowType VVF with an existing VCF Operations needs an existing vCenter too; no VVF row reuses VCF Operations on a new vCenter.', {
          path: 'vcfOperationsSpec.useExistingDeployment',
          source,
        }),
      );
    }
    need('vcfOperationsSpec', 'every VVF row has VCF Operations.');
    if (mgmtServices) {
      need('vspClusterSpec', 'this run installs VCF management services.');
      unexpected('vidbSpec', 'warning', 'the decision table has no identity broker for this row.');
      unexpected('nsxtSpec', 'warning', 'Broadcom’s VCF management services for VVF example carries no NSX.');
      unexpected('vcfAutomationSpec', 'warning', 'vSphere Foundation has no VCF Automation.');
    } else {
      unexpected('nsxtSpec', 'error', 'vSphere Foundation has no NSX.');
      unexpected('vcfAutomationSpec', 'error', 'vSphere Foundation has no VCF Automation.');
      if (vcExisting) unexpected('vidbSpec', 'warning', 'the decision table has no identity broker when converging to VVF.');
      if (!has('vspClusterSpec')) {
        findings.push(
          info('vcf.spec.vvf-without-management-services', 'VVF without vspClusterSpec deploys no VCF management services. That needs explicit.management.components.deployment=true on the Installer appliance first.', {
            path: 'vspClusterSpec',
            source,
          }),
        );
      }
    }
  }

  if (isComponentsOnlyWorkflow(spec)) {
    for (const key of [...INFRASTRUCTURE_BLOCKS, ...SERVICE_BLOCKS]) {
      if (wf === 'VVF' && key === 'nsxtSpec') continue; // reported above
      unexpected(key, 'warning', 'Broadcom’s example for this workflow carries only the component blocks plus the existing vCenter and SDDC Manager.');
    }
  }
}

                                  
                                                              
                                  
                                                                            
                                       
 

function vlanOf(spec                 )         {
  return typeof spec.vlanId === 'string' ? Number(spec.vlanId) : spec.vlanId;
}

/**
 * The family a network entry declares. The API has no separate IPv6 fields:
 * an IPv6 entry sets ipAddressVersion and reuses subnet/gateway, so the
 * version decides how those are read. Absent means IPv4.
 */
function versionOf(spec                 )         {
  return spec.ipAddressVersion === 'IPv6' ? 6 : 4;
}

/** An address as a number for range arithmetic, in either family. */
function addressValue(text         )                                           {
  if (typeof text !== 'string' || !isIp(text)) return null;
  const t = text.trim();
  if (familyOf(t) === 6) {
    const groups = parseIPv6(t);
    return groups ? { family: 6, value: v6ToBig(groups) } : null;
  }
  const v = parseIPv4(t);
  return v === null ? null : { family: 4, value: BigInt(v) };
}

/** Addresses a prefix can hand out. IPv6 has no broadcast; the network address is the subnet-router anycast. */
function usableCount(c                                                     )         {
  if (c.family === 4) {
    const v4 = parseCidr(`${c.network}/${c.prefix}`);
    return v4 ? BigInt(usableAddresses(v4)) : 0n;
  }
  const size = 1n << BigInt(128 - c.prefix);
  return c.prefix >= 127 ? size : size - 1n;
}

/** A dotted IPv4 netmask: contiguous ones, then zeros. */
function isNetmask(text         )          {
  if (typeof text !== 'string') return false;
  const v = parseIPv4(text.trim());
  if (v === null) return false;
  const inverted = ~v >>> 0;
  return (inverted & (inverted + 1)) === 0;
}

/** Large IPv6 counts only need comparing against small minimums. */
const clampCount = (n        )         => (n > 1_000_000n ? 1_000_000 : Number(n));

/**
 * Check one VCF Management Services pool in the family it is declared for and
 * return how many addresses it provides. ipv4Pool and ipv6Pool take the same
 * three forms, so a value of the other family is an error in either.
 */
function checkVspPool(
  findings           ,
  pool                     ,
  family        ,
  path        ,
)         {
  const other = family === 4 ? 'vspClusterSpec.ipv6Pool' : 'vspClusterSpec.ipv4Pool';
  const wrong = (field        , value         )       => {
    findings.push(
      error('vcf.spec.vsp-pool-family', `${path}.${field} "${String(value)}" is not a valid IPv${family} value.`, {
        path: `${path}.${field}`,
        remediation: `Only IPv${family} belongs in ${path}; the other family goes in ${other}.`,
        source: 'VCF Installer API — SddcVspClusterSpec',
      }),
    );
  };

  (pool.excludedAddresses ?? []).forEach((a, i) => {
    if (addressValue(a)?.family !== family) wrong(`excludedAddresses[${i}]`, a);
  });

  if (pool.addresses) {
    let good = 0;
    pool.addresses.forEach((a, i) => {
      if (addressValue(a)?.family === family) good += 1;
      else wrong(`addresses[${i}]`, a);
    });
    return good;
  }
  if (pool.ipRange) {
    const start = addressValue(pool.ipRange.startIpAddress);
    const end = addressValue(pool.ipRange.endIpAddress);
    if (start?.family !== family) wrong('ipRange.startIpAddress', pool.ipRange.startIpAddress);
    if (end?.family !== family) wrong('ipRange.endIpAddress', pool.ipRange.endIpAddress);
    if (start?.family === family && end?.family === family) {
      if (end.value < start.value) {
        findings.push(
          error('vcf.spec.inverted-vsp-range', `Range ${pool.ipRange.startIpAddress}-${pool.ipRange.endIpAddress} is inverted.`, {
            path: `${path}.ipRange`,
          }),
        );
        return 0;
      }
      return clampCount(end.value - start.value + 1n);
    }
    return 0;
  }
  if (pool.cidr) {
    const cidr = parseCidrAny(pool.cidr);
    if (!cidr || cidr.family !== family || !pool.cidr.includes('/')) {
      wrong('cidr', pool.cidr);
      return 0;
    }
    return clampCount(usableCount(cidr));
  }
  return 0;
}

/**
 * Record an unfilled credential.
 *
 * Returns true when the value is a placeholder, so the caller can skip the
 * complexity checks that would otherwise report "too short" for a field the
 * user has not filled in yet.
 */
function notePlaceholder(findings           , value         , path        )          {
  if (!isPlaceholderSecret(value)) return false;
  findings.push(
    warning(
      'vcf.spec.placeholder-credential',
      `${path} still contains the "${PLACEHOLDER_SECRET}" placeholder.`,
      {
        path,
        remediation:
          'Supply the credential, or let the VCF 9.1 installer auto-generate complex passwords during deployment.',
      },
    ),
  );
  return true;
}

/** Validate a parsed SddcSpec. Returns findings; never throws. */
export function validateSddcSpec(
  spec                                             ,
  options                  = {},
)            {
  const findings            = [];

  // --- version drift -------------------------------------------------------
  for (const removed of REMOVED_IN_91_KEYS) {
    if (removed in spec) {
      findings.push(
        error(
          'vcf.spec.removed-9.0-field',
          `"${removed}" was removed in VCF 9.1. This looks like a 9.0 specification.`,
          {
            path: removed,
            remediation:
              'Delete this key. The VCF Fleet Management Appliance no longer exists in 9.1; its role is covered by vspClusterSpec and fleetLcmSpec.',
            source: 'Broadcom KB 440630',
          },
        ),
      );
    }
  }

  // --- required keys -------------------------------------------------------
  for (const key of SDDC_SPEC_REQUIRED_KEYS) {
    if (spec[key] === undefined || spec[key] === null) {
      // Broadcom's own examples for the two components-only workflows omit
      // networkSpecs and dnsSpec although the schema marks them required.
      if ((key === 'networkSpecs' || key === 'dnsSpec') && isComponentsOnlyWorkflow(spec)) {
        findings.push(
          info('vcf.spec.required-omitted-by-example', `"${key}" is absent. The schema marks it required, but Broadcom's example for this workflow omits it. VERIFY with POST /v1/sddcs/validations.`, {
            path: key,
            source: 'VCF 9.1 Deployment — worked examples',
          }),
        );
        continue;
      }
      findings.push(
        error('vcf.spec.missing-required', `Required field "${key}" is missing.`, {
          path: key,
          source: 'VCF Installer API — SddcSpec',
        }),
      );
    }
  }

  // --- sddcId --------------------------------------------------------------
  if (typeof spec.sddcId === 'string' && !SDDC_ID_PATTERN.test(spec.sddcId)) {
    findings.push(
      error(
        'vcf.spec.sddc-id-format',
        `sddcId must be 3-20 alphanumeric characters or hyphens; got "${spec.sddcId}".`,
        { path: 'sddcId', source: 'VCF Installer API — SddcSpec' },
      ),
    );
  }

  if (typeof spec.vcfInstanceName === 'string' && (spec.vcfInstanceName.length < 1 || spec.vcfInstanceName.length > 300)) {
    findings.push(
      error('vcf.spec.instance-name-length', 'vcfInstanceName must be 1-300 characters.', {
        path: 'vcfInstanceName',
        source: 'VCF Installer API — SddcSpec',
      }),
    );
  }

  // --- schema: unknown keys, required fields, enums ---------------------------
  checkAgainstSchema(findings, spec);
  checkThumbprints(findings, spec);
  checkFqdns(findings, spec);
  checkWorkflowShape(findings, spec);

  // --- DNS -----------------------------------------------------------------
  if (spec.dnsSpec) {
    const { subdomain, nameservers } = spec.dnsSpec;
    if (typeof subdomain === 'string') {
      if (subdomain !== subdomain.toLowerCase()) {
        findings.push(
          error('vcf.spec.dns-subdomain-case', 'All FQDNs must be lowercase.', {
            path: 'dnsSpec.subdomain',
            remediation: `Use "${subdomain.toLowerCase()}".`,
            source: 'VCF 9.1 deployment prerequisites',
          }),
        );
      }
      if (/\.local$/i.test(subdomain)) {
        findings.push(
          error(
            'vcf.spec.dns-unsupported-suffix',
            'The ".local" domain suffix is not supported by VCF.',
            { path: 'dnsSpec.subdomain', source: 'VCF 9.1 deployment prerequisites' },
          ),
        );
      }
    }
    if (Array.isArray(nameservers)) {
      if (nameservers.length > MAX_NAMESERVERS) {
        findings.push(
          error(
            'vcf.spec.too-many-nameservers',
            `dnsSpec.nameservers accepts at most ${MAX_NAMESERVERS} entries; ${nameservers.length} given.`,
            { path: 'dnsSpec.nameservers', source: 'VCF Installer API — DnsSpec' },
          ),
        );
      }
      if (nameservers.length === 1) {
        findings.push(
          warning(
            'vcf.spec.single-nameserver',
            'Only one DNS server is configured. Two are recommended on every appliance.',
            { path: 'dnsSpec.nameservers', source: 'VCF 9.1 deployment guidance' },
          ),
        );
      }
      nameservers.forEach((ns, i) => {
        if (!isIp(ns)) {
          findings.push(
            error('vcf.spec.invalid-nameserver', `"${ns}" is not a valid IPv4 or IPv6 address.`, {
              path: `dnsSpec.nameservers[${i}]`,
            }),
          );
        }
      });
      // The DnsSpec schema types nameservers as plain strings with no family
      // restriction, but no published example uses an IPv6 resolver.
      const v6Resolvers = nameservers.filter((ns) => isIp(ns) && familyOf(ns) === 6);
      if (v6Resolvers.length > 0) {
        findings.push(
          info(
            'vcf.spec.ipv6-nameserver',
            `VERIFY: ${v6Resolvers.join(', ')} ${v6Resolvers.length === 1 ? 'is an IPv6 resolver' : 'are IPv6 resolvers'}. Confirm the installer and every appliance reach DNS over IPv6, or list an IPv4 resolver first.`,
            { path: 'dnsSpec.nameservers', source: 'VCF Installer API — DnsSpec' },
          ),
        );
      }
    }
  }

  // --- NTP -----------------------------------------------------------------
  if (Array.isArray(spec.ntpServers)) {
    spec.ntpServers.forEach((server, i) => {
      if (typeof server !== 'string') return;
      const looksIp = server.includes(':') || /^[\d.]+$/.test(server);
      const valid = looksIp ? isIp(server) : server.split('.').every((l) => RFC1123_LABEL.test(l));
      if (!valid) {
        findings.push(
          error('vcf.spec.invalid-ntp-server', `"${server}" is not a valid ${looksIp ? 'IPv4 or IPv6 address' : 'host name'}.`, {
            path: `ntpServers[${i}]`,
          }),
        );
      }
    });
    if (spec.ntpServers.length === 0) {
      findings.push(
        warning('vcf.spec.no-ntp', 'No NTP servers configured. Time sync is required for bring-up.', {
          path: 'ntpServers',
        }),
      );
    } else if (spec.ntpServers.length === 1) {
      findings.push(
        info('vcf.spec.single-ntp', 'Two external time sources per site are recommended.', {
          path: 'ntpServers',
        }),
      );
    }
  }

  // --- networks ------------------------------------------------------------
  const networks = Array.isArray(spec.networkSpecs) ? spec.networkSpecs : [];
  const seenTypes = new Set        ();
  // Dual stack is two entries of one networkType, one per ipAddressVersion, so
  // a duplicate is the same type twice in the same family.
  const seenTypeVersions = new Set        ();

  networks.forEach((net, i) => {
    const at = `networkSpecs[${i}]`;
    const version = versionOf(net);

    const typeVersion = `${net.networkType}/${version}`;
    if (seenTypeVersions.has(typeVersion)) {
      findings.push(
        error(
          'vcf.spec.duplicate-network-type',
          `Duplicate networkType "${net.networkType}"${version === 6 ? ' for IPv6' : ''}.`,
          { path: at },
        ),
      );
    }
    seenTypeVersions.add(typeVersion);
    seenTypes.add(net.networkType);

    const vlan = vlanOf(net);
    if (!Number.isInteger(vlan) || vlan < VLAN_MIN || vlan > VLAN_MAX) {
      findings.push(
        error('vcf.spec.invalid-vlan', `VLAN ID must be ${VLAN_MIN}-${VLAN_MAX}; got "${net.vlanId}".`, {
          path: `${at}.vlanId`,
        }),
      );
    }

    if (net.mtu !== undefined) {
      if (net.mtu < MTU_MIN || net.mtu > MTU_MAX) {
        findings.push(
          error('vcf.spec.invalid-mtu', `MTU must be ${MTU_MIN}-${MTU_MAX}; got ${net.mtu}.`, {
            path: `${at}.mtu`,
          }),
        );
      } else if (
        (net.networkType === 'VSAN' || net.networkType === 'VMOTION') &&
        net.mtu < 9000
      ) {
        findings.push(
          warning(
            'vcf.spec.mtu-below-jumbo',
            `${net.networkType} is configured at MTU ${net.mtu}. 9000 is recommended.`,
            { path: `${at}.mtu`, source: 'VCF 9.1 network guidance' },
          ),
        );
      }
    }

    // subnet and gateway are read in the family ipAddressVersion declares; a
    // value of the other family is a mismatch, not merely a bad address.
    const parsedSubnet =
      typeof net.subnet === 'string' && net.subnet.includes('/') ? parseCidrAny(net.subnet) : null;
    if (net.subnet !== undefined && parsedSubnet === null) {
      findings.push(
        error('vcf.spec.invalid-subnet', `"${net.subnet}" is not a valid CIDR.`, {
          path: `${at}.subnet`,
        }),
      );
    } else if (parsedSubnet && parsedSubnet.family !== version) {
      findings.push(
        error(
          'vcf.spec.subnet-version-mismatch',
          `${net.networkType} declares ipAddressVersion IPv${version} but its subnet ${net.subnet} is IPv${parsedSubnet.family}.`,
          {
            path: `${at}.subnet`,
            remediation: `Set ipAddressVersion to "IPv${parsedSubnet.family}", or add a separate ${net.networkType} entry for that family.`,
            source: 'VCF Installer API — SddcNetworkSpec',
          },
        ),
      );
    }
    const cidr = parsedSubnet && parsedSubnet.family === version ? parsedSubnet : null;

    const gwFamily = typeof net.gateway === 'string' && isIp(net.gateway) ? familyOf(net.gateway) : null;
    if (net.gateway !== undefined && gwFamily === null) {
      findings.push(
        error('vcf.spec.invalid-gateway', `"${net.gateway}" is not a valid IPv${version} address.`, {
          path: `${at}.gateway`,
        }),
      );
    } else if (gwFamily !== null && gwFamily !== version) {
      findings.push(
        error(
          'vcf.spec.gateway-version-mismatch',
          `${net.networkType} declares ipAddressVersion IPv${version} but its gateway ${net.gateway} is IPv${gwFamily}.`,
          { path: `${at}.gateway`, source: 'VCF Installer API — SddcNetworkSpec' },
        ),
      );
    }

    // A gateway outside its own subnet is a classic copy-paste error that the
    // installer only catches late, during bring-up.
    if (cidr && gwFamily === version && !containsAny(formatCidrAny(cidr), net.gateway          )) {
      findings.push(
        error(
          'vcf.spec.gateway-outside-subnet',
          `Gateway ${net.gateway} is not inside ${formatCidrAny(cidr)}.`,
          { path: `${at}.gateway` },
        ),
      );
    }

    // SLAAC derives the interface ID from 64 bits, so it is IPv6-only and
    // needs a /64 (RFC 4862).
    if (net.ipAddressAssignmentMode === 'SLAAC') {
      if (version !== 6) {
        findings.push(
          error('vcf.spec.slaac-needs-ipv6', `${net.networkType} uses SLAAC, which assigns IPv6 addresses only.`, {
            path: `${at}.ipAddressAssignmentMode`,
            remediation: 'Use STATIC or DHCP for the IPv4 entry; SLAAC belongs on the IPv6 entry.',
          }),
        );
      } else if (cidr && cidr.prefix !== 64) {
        findings.push(
          error('vcf.spec.slaac-needs-64', `SLAAC needs a /64; ${net.networkType} is ${formatCidrAny(cidr)}.`, {
            path: `${at}.subnet`,
            source: 'RFC 4862',
          }),
        );
      }
    }

    // Static ranges are handed to VMkernel adapters, so they must be in the
    // entry's own family and inside its subnet.
    (net.includeIpAddressRanges ?? []).forEach((range, ri) => {
      const start = addressValue(range.startIpAddress);
      const end = addressValue(range.endIpAddress);
      const path = `${at}.includeIpAddressRanges[${ri}]`;
      if (start?.family !== version || end?.family !== version) {
        findings.push(
          error(
            'vcf.spec.invalid-network-range',
            `Range ${range.startIpAddress}-${range.endIpAddress} must be two IPv${version} addresses to match ipAddressVersion.`,
            { path },
          ),
        );
      } else if (end.value < start.value) {
        findings.push(
          error('vcf.spec.inverted-network-range', `Range ${range.startIpAddress}-${range.endIpAddress} is inverted.`, { path }),
        );
      } else if (
        cidr &&
        (!containsAny(formatCidrAny(cidr), range.startIpAddress) || !containsAny(formatCidrAny(cidr), range.endIpAddress))
      ) {
        findings.push(
          error(
            'vcf.spec.range-outside-subnet',
            `Range ${range.startIpAddress}-${range.endIpAddress} is not inside ${formatCidrAny(cidr)}.`,
            { path },
          ),
        );
      }
    });
    (net.includeIpAddress ?? []).forEach((addr, ai) => {
      if (addressValue(addr)?.family !== version) {
        findings.push(
          error('vcf.spec.invalid-network-address', `"${addr}" is not a valid IPv${version} address.`, {
            path: `${at}.includeIpAddress[${ai}]`,
          }),
        );
      }
    });

    if (net.subnetMask !== undefined && !isNetmask(net.subnetMask)) {
      findings.push(
        error('vcf.spec.invalid-subnet-mask', `"${net.subnetMask}" is not a valid IPv4 subnet mask.`, {
          path: `${at}.subnetMask`,
          source: 'VCF Installer API — SddcNetworkSpec',
        }),
      );
    }

    // The schema caps subnet at 18 characters and gateway at 15, which are
    // IPv4 lengths; an IPv6 entry cannot fit them.
    if (version === 6 && ((net.subnet?.length ?? 0) > 18 || (net.gateway?.length ?? 0) > 15)) {
      findings.push(
        info('vcf.spec.ipv6-length-unverified', `VERIFY: ${net.networkType} (IPv6) exceeds the schema's documented lengths for subnet (18) or gateway (15), which are IPv4-sized. Confirm with POST /v1/sddcs/validations.`, {
          path: at,
          source: 'VCF Installer API — SddcNetworkSpec',
        }),
      );
    }

    if (net.portGroupKey !== undefined && net.portGroupKey.length > 80) {
      findings.push(
        error('vcf.spec.portgroup-too-long', 'portGroupKey exceeds 80 characters.', {
          path: `${at}.portGroupKey`,
        }),
      );
    }
  });

  if (networks.length > 0) {
    if (!seenTypes.has('MANAGEMENT')) {
      findings.push(
        error('vcf.spec.missing-management-network', 'A MANAGEMENT network is required.', {
          path: 'networkSpecs',
        }),
      );
    }
    // Overlapping subnets on different VLANs will route unpredictably. Checked
    // within a family: an IPv4 and an IPv6 subnet never overlap.
    for (let i = 0; i < networks.length; i += 1) {
      for (let j = i + 1; j < networks.length; j += 1) {
        const a = networks[i]                   ;
        const b = networks[j]                   ;
        const valid = (n                 )          =>
          typeof n.subnet === 'string' && n.subnet.includes('/') && parseCidrAny(n.subnet) !== null;
        if (valid(a) && valid(b) && vlanOf(a) !== vlanOf(b) && overlapsAny(a.subnet , b.subnet )) {
          findings.push(
            error(
              'vcf.spec.overlapping-subnets',
              `${a.networkType} (${a.subnet}) and ${b.networkType} (${b.subnet}) overlap but are on different VLANs.`,
              { path: `networkSpecs[${j}].subnet` },
            ),
          );
        }
      }
    }
  }

  // --- hosts ---------------------------------------------------------------
  const hosts = Array.isArray(spec.hostSpecs) ? spec.hostSpecs : [];
  const seenHostnames = new Set        ();
  hosts.forEach((host, i) => {
    const at = `hostSpecs[${i}]`;
    if (typeof host.hostname === 'string') {
      const subdomain = (spec.dnsSpec?.subdomain ?? '').toLowerCase();
      // The installer's own export writes hosts as FQDNs in the DNS subdomain,
      // so that form is native, not a mistake. An FQDN in some other domain is
      // still worth a look.
      const inSubdomain = subdomain !== '' && host.hostname.toLowerCase().endsWith(`.${subdomain}`);
      if (host.hostname.includes('.') && !inSubdomain) {
        findings.push(
          warning(
            'vcf.spec.host-fqdn-not-short-name',
            `"${host.hostname}" is an FQDN outside the DNS subdomain "${subdomain || '(none)'}". Use a short name, or the FQDN in that subdomain.`,
            { path: `${at}.hostname`, source: 'VCF Installer API — SddcHostSpec' },
          ),
        );
      } else if (!host.hostname.includes('.') && !RFC1123_LABEL.test(host.hostname)) {
        findings.push(
          error('vcf.spec.invalid-hostname', `"${host.hostname}" is not a valid RFC1123 hostname.`, {
            path: `${at}.hostname`,
          }),
        );
      }
      if (seenHostnames.has(host.hostname)) {
        findings.push(
          error('vcf.spec.duplicate-hostname', `Duplicate hostname "${host.hostname}".`, {
            path: `${at}.hostname`,
          }),
        );
      }
      seenHostnames.add(host.hostname);
    }
  });

  // Management subnet must hold the hosts plus the component addresses. The
  // community builders use "10 + hostCount" as the floor; VCF's own IP
  // requirements are considerably higher once VCFMS and Automation are counted.
  // Checked per family: on dual stack each family's management prefix has to
  // hold its own copy of every address.
  for (const mgmt of networks.filter((n) => n.networkType === 'MANAGEMENT')) {
    if (!mgmt.subnet || hosts.length === 0) continue;
    const cidr = mgmt.subnet.includes('/') ? parseCidrAny(mgmt.subnet) : null;
    if (cidr && cidr.family === versionOf(mgmt)) {
      const available = clampCount(usableCount(cidr));
      const needed = hosts.length + VCFMS_MIN_IPS + AUTOMATION_IP_COUNT + 12;
      if (available < needed) {
        findings.push(
          error(
            'vcf.spec.management-subnet-too-small',
            `Management subnet ${mgmt.subnet} has ${available} usable addresses but this design needs roughly ${needed}.`,
            {
              path: cidr.family === 6 ? 'networkSpecs[MANAGEMENT/IPv6].subnet' : 'networkSpecs[MANAGEMENT].subnet',
              remediation:
                'Widen the management subnet, or move VCF Management Services onto a dedicated FLEET_MANAGEMENT network.',
              source: 'VCF 9.1 IP address requirements',
            },
          ),
        );
      }
    }
  }

  // --- vCenter -------------------------------------------------------------
  if (spec.vcenterSpec) {
    const vc = spec.vcenterSpec;
    if (typeof vc.vcenterHostname === 'string' && vc.vcenterHostname.length > 63) {
      findings.push(
        error('vcf.spec.vcenter-hostname-too-long', 'vcenterHostname exceeds 63 characters.', {
          path: 'vcenterSpec.vcenterHostname',
        }),
      );
    }
    if (
      typeof vc.rootVcenterPassword === 'string' &&
      !notePlaceholder(findings, vc.rootVcenterPassword, 'vcenterSpec.rootVcenterPassword')
    ) {
      const min = vc.useExistingDeployment ? 8 : 15;
      if (vc.rootVcenterPassword.length > 0 && vc.rootVcenterPassword.length < min) {
        findings.push(
          error(
            'vcf.spec.vcenter-password-length',
            `rootVcenterPassword must be at least ${min} characters for this deployment mode.`,
            { path: 'vcenterSpec.rootVcenterPassword', source: 'VCF Installer API — SddcVcenterSpec' },
          ),
        );
      }
    }
    // The schema caps this at 20 characters, which is easy to exceed with a
    // generated passphrase and only fails at submission time.
    if (typeof vc.rootVcenterPassword === 'string' && vc.rootVcenterPassword.length > 20) {
      findings.push(
        error(
          'vcf.spec.vcenter-password-too-long',
          `rootVcenterPassword is ${vc.rootVcenterPassword.length} characters; the maximum is 20.`,
          { path: 'vcenterSpec.rootVcenterPassword', source: 'VCF Installer API — SddcVcenterSpec' },
        ),
      );
    }

    if (vc.useExistingDeployment && !vc.sslThumbprint) {
      findings.push(
        error(
          'vcf.spec.missing-thumbprint',
          'sslThumbprint is required when reusing an existing vCenter.',
          { path: 'vcenterSpec.sslThumbprint', source: 'VCF Installer API — SddcVcenterSpec' },
        ),
      );
    }
  }

  // --- NSX -----------------------------------------------------------------
  if (spec.nsxtSpec) {
    const nsx = spec.nsxtSpec;
    if (nsx.overlayVtepSpec?.vtepType === 'NO_IP' && nsx.ipAddressPoolSpec) {
      findings.push(
        warning(
          'vcf.spec.tep-pool-with-tepless',
          'A host TEP pool is configured alongside a TEP-less deployment, which creates no VTEPs.',
          {
            path: 'nsxtSpec.ipAddressPoolSpec',
            remediation: 'Remove the TEP pool, or drop overlayVtepSpec to deploy VTEPs normally.',
            source: 'VCF Installer API — OverlayVtepSpec',
          },
        ),
      );
    }

    if (nsx.nsxtManagerSize && !['medium', 'large', 'xlarge'].includes(nsx.nsxtManagerSize)) {
      findings.push(
        error(
          'vcf.spec.nsx-size-not-supported',
          `nsxtManagerSize "${nsx.nsxtManagerSize}" is not selectable for VCF bring-up. Use medium, large or xlarge.`,
          { path: 'nsxtSpec.nsxtManagerSize', source: 'VCF Installer API — SddcNsxtSpec' },
        ),
      );
    }

    // VLAN-backed VPC and TEP-less are one choice made twice: the VPC type
    // that needs no overlay, and the switch setting that creates no VTEPs.
    const vpcType = nsx.vpcSpec?.vpcNetworkConfigurationType;
    const tepLess = nsx.overlayVtepSpec?.vtepType === 'NO_IP';
    if (vpcType === 'VLAN_BACKED_VPC' && !tepLess) {
      findings.push(
        warning('vcf.spec.vlan-vpc-without-tepless', 'vpcNetworkConfigurationType is VLAN_BACKED_VPC but overlayVtepSpec.vtepType is not NO_IP, so host TEPs are still created.', {
          path: 'nsxtSpec.overlayVtepSpec',
          remediation: 'Set overlayVtepSpec.vtepType to NO_IP and drop the TEP pool, or use FULL_STACK_VPC.',
          source: 'VCF Installer API — OverlayVtepSpec',
        }),
      );
    }
    if (tepLess && vpcType !== undefined && vpcType !== 'VLAN_BACKED_VPC') {
      findings.push(
        warning('vcf.spec.tepless-without-vlan-vpc', `overlayVtepSpec.vtepType is NO_IP, which enables the VLAN-backed VPC configuration, but vpcNetworkConfigurationType is ${vpcType}.`, {
          path: 'nsxtSpec.vpcSpec.vpcNetworkConfigurationType',
          source: 'VCF Installer API — OverlayVtepSpec',
        }),
      );
    }
    if (vpcType === 'VPC_UNSUPPORTED' || vpcType === 'INVALID_TYPE') {
      findings.push(
        warning('vcf.spec.vpc-type-sentinel', `vpcNetworkConfigurationType ${vpcType} is a status value in the API enum, not a configuration to request.`, {
          path: 'nsxtSpec.vpcSpec.vpcNetworkConfigurationType',
          remediation: 'Use FULL_STACK_VPC or VLAN_BACKED_VPC.',
        }),
      );
    }
    if ((vpcType === 'VLAN_BACKED_VPC' || tepLess) && typeof spec.version === 'string' && !atLeastVcfVersion(spec.version, '9.1.1')) {
      findings.push(
        warning('vcf.spec.vlan-vpc-needs-911', `VLAN-backed VPC and TEP-less deployment need VCF 9.1.1 or later; this spec targets ${spec.version}.`, {
          path: 'version',
          source: 'VCF 9.1.1 Release Notes',
        }),
      );
    }
    const dtgw = nsx.vpcSpec?.dtgwSpec;
    if (dtgw) {
      for (const field of ['gatewayCidr', 'externalIpBlockCidr', 'privateTgwIpBlockCidr']         ) {
        const value = dtgw[field];
        if (value !== undefined && (typeof value !== 'string' || !value.includes('/') || parseCidrAny(value) === null)) {
          findings.push(
            error('vcf.spec.invalid-dtgw-cidr', `nsxtSpec.vpcSpec.dtgwSpec.${field} "${String(value)}" is not a valid CIDR.`, {
              path: `nsxtSpec.vpcSpec.dtgwSpec.${field}`,
              source: 'VCF Installer API — DtgwSpec',
            }),
          );
        }
      }
      const dtgwVlan = typeof dtgw.vlan === 'string' ? Number(dtgw.vlan) : dtgw.vlan;
      if (dtgw.vlan !== undefined && (!Number.isInteger(dtgwVlan) || dtgwVlan < VLAN_MIN || dtgwVlan > VLAN_MAX)) {
        findings.push(
          error('vcf.spec.invalid-vlan', `VLAN ID must be ${VLAN_MIN}-${VLAN_MAX}; got "${dtgw.vlan}".`, {
            path: 'nsxtSpec.vpcSpec.dtgwSpec.vlan',
          }),
        );
      }
    }

    if (Array.isArray(nsx.nsxtManagers)) {
      const count = nsx.nsxtManagers.length;
      if (count !== 1 && count !== 3) {
        findings.push(
          warning(
            'vcf.spec.nsx-manager-count',
            `${count} NSX Manager nodes configured. VCF deploys either 1 (simple) or 3 (HA).`,
            { path: 'nsxtSpec.nsxtManagers' },
          ),
        );
      }
    }

    for (const field of ['rootNsxtManagerPassword', 'nsxtAdminPassword', 'nsxtAuditPassword']         ) {
      const value = nsx[field];
      if (notePlaceholder(findings, value, `nsxtSpec.${field}`)) continue;
      if (typeof value === 'string' && value.length > 0 && value.length < 12) {
        findings.push(
          error('vcf.spec.nsx-password-length', `${field} must be at least 12 characters.`, {
            path: `nsxtSpec.${field}`,
            source: 'VCF Installer API — SddcNsxtSpec',
          }),
        );
      }
    }

    const pool = nsx.ipAddressPoolSpec;
    if (pool) {
      if (pool.name && !POOL_NAME_PATTERN.test(pool.name)) {
        findings.push(
          error(
            'vcf.spec.pool-name-format',
            `TEP pool name "${pool.name}" must match ^[a-zA-Z0-9-_]+$.`,
            { path: 'nsxtSpec.ipAddressPoolSpec.name' },
          ),
        );
      }
      (pool.subnets ?? []).forEach((subnet, si) => {
        const at = `nsxtSpec.ipAddressPoolSpec.subnets[${si}]`;
        // NSX itself can run IPv6 host TEPs, but the installer's host TEP pool
        // (IpAddressPoolSubnetSpec) is IPv4 only in every published 9.1
        // example and definition, so IPv6 here is refused rather than guessed.
        const v6Values = [
          subnet.cidr,
          subnet.gateway,
          ...(subnet.ipAddressPoolRanges ?? []).flatMap((r) => [r.start, r.end]),
        ].filter((v) => typeof v === 'string' && familyOf(v) === 6);
        if (v6Values.length > 0) {
          findings.push(
            error(
              'vcf.spec.tep-ipv6-unsupported',
              `NSX host TEP pool on VCF 9.1 does not support IPv6 (${v6Values.join(', ')}).`,
              {
                path: at,
                remediation:
                  'Give the host TEP pool an IPv4 subnet, gateway and range. VERIFY: IPv6 host TEPs are an NSX capability the VCF 9.1 installer spec does not document.',
                source: 'VCF Installer API — IpAddressPoolSubnetSpec',
              },
            ),
          );
          return;
        }
        if (parseCidr(subnet.cidr) === null) {
          findings.push(
            error('vcf.spec.invalid-tep-cidr', `"${subnet.cidr}" is not a valid CIDR.`, {
              path: `${at}.cidr`,
            }),
          );
        }
        (subnet.ipAddressPoolRanges ?? []).forEach((range, ri) => {
          const start = parseIPv4(range.start);
          const end = parseIPv4(range.end);
          if (start === null || end === null) {
            findings.push(
              error('vcf.spec.invalid-tep-range', 'TEP pool range endpoints must be IPv4 addresses.', {
                path: `${at}.ipAddressPoolRanges[${ri}]`,
                remediation:
                  'Note this range uses "start"/"end", not "startIpAddress"/"endIpAddress" as networkSpecs does.',
              }),
            );
          } else if (end < start) {
            findings.push(
              error('vcf.spec.inverted-tep-range', `Range ${range.start}-${range.end} is inverted.`, {
                path: `${at}.ipAddressPoolRanges[${ri}]`,
              }),
            );
          }
        });
      });

      // The host TEP pool must cover every host's TEPs.
      const totalTepIps = (pool.subnets ?? []).reduce((sum, subnet) => {
        return (
          sum +
          (subnet.ipAddressPoolRanges ?? []).reduce((inner, range) => {
            const start = parseIPv4(range.start);
            const end = parseIPv4(range.end);
            if (start === null || end === null || end < start) return inner;
            return inner + (end - start + 1);
          }, 0)
        );
      }, 0);

      if (hosts.length > 0 && totalTepIps > 0 && totalTepIps < hosts.length) {
        findings.push(
          error(
            'vcf.spec.tep-pool-too-small',
            `Host TEP pool provides ${totalTepIps} addresses for ${hosts.length} hosts.`,
            {
              path: 'nsxtSpec.ipAddressPoolSpec',
              remediation: 'Size the pool for hosts x pNICs participating in the overlay, plus growth.',
              source: 'VCF 9.1 NSX host TEP guidance',
            },
          ),
        );
      }
    }
  }

  // --- VCF Operations -------------------------------------------------------
  const ops = spec.vcfOperationsSpec;
  if (ops) {
    // Checked for every workflow: this used to sit inside the NSX block, so a
    // VVF spec (which has no NSX) was never checked.
    if (Array.isArray(ops.nodes) && ops.nodes.length > 3) {
      findings.push(
        error(
          'vcf.spec.too-many-ops-nodes',
          `VCF Operations accepts at most 3 nodes; ${ops.nodes.length} supplied.`,
          { path: 'vcfOperationsSpec.nodes', source: 'VCF Installer API — VcfOperationsSpec' },
        ),
      );
    }
    if (Array.isArray(ops.nodes) && ops.nodes.length === 0) {
      findings.push(
        error('vcf.spec.no-ops-nodes', 'vcfOperationsSpec.nodes needs at least one node.', {
          path: 'vcfOperationsSpec.nodes',
          source: 'VCF Installer API — VcfOperationsSpec',
        }),
      );
    }
    if (ops.applianceSize === 'xsmall' && Array.isArray(ops.nodes) && ops.nodes.length > 1 && ops.useExistingDeployment !== true) {
      findings.push(
        error('vcf.spec.ops-xsmall-ha', `applianceSize xsmall is for a single node; ${ops.nodes.length} nodes need small or larger.`, {
          path: 'vcfOperationsSpec.applianceSize',
          source: 'VCF Installer API — VcfOperationsSpec',
        }),
      );
    }
    if (ops.useExistingDeployment === true && (ops.applianceSize !== undefined || ops.loadBalancerFqdn !== undefined)) {
      findings.push(
        warning('vcf.spec.existing-operations-extra-fields', 'VCF Operations is existing, yet applianceSize or loadBalancerFqdn is set. Those describe a new deployment and are ignored.', {
          path: 'vcfOperationsSpec',
          remediation: 'Keep only the existing master node (hostname, type, sslThumbprint), the existing admin password and useExistingDeployment.',
          source: 'VCF Installer API — VcfOperationsSpec',
        }),
      );
    }
  }

  // --- dvs -----------------------------------------------------------------
  (spec.dvsSpecs ?? []).forEach((dvs, i) => {
    const at = `dvsSpecs[${i}]`;
    if (dvs.dvsName && dvs.dvsName.length > 80) {
      findings.push(
        error('vcf.spec.dvs-name-too-long', 'dvsName exceeds 80 characters.', { path: `${at}.dvsName` }),
      );
    }
    if (!Array.isArray(dvs.vmnicsToUplinks) || dvs.vmnicsToUplinks.length === 0) {
      findings.push(
        error('vcf.spec.dvs-no-uplinks', 'vmnicsToUplinks is required and must not be empty.', {
          path: `${at}.vmnicsToUplinks`,
          source: 'VCF Installer API — DvsSpec',
        }),
      );
    }
    if (dvs.mtu !== undefined && dvs.mtu < NSX_OVERLAY_MIN_MTU && dvs.nsxtSwitchConfig) {
      findings.push(
        error(
          'vcf.spec.dvs-mtu-below-overlay-minimum',
          `MTU ${dvs.mtu} is below the ${NSX_OVERLAY_MIN_MTU} minimum for NSX overlay traffic.`,
          { path: `${at}.mtu`, source: 'NSX overlay requirements' },
        ),
      );
    }
    if ((dvs.nsxTeamings?.length ?? 0) > 1) {
      findings.push(
        error(
          'vcf.spec.too-many-nsx-teamings',
          `nsxTeamings accepts at most 1 entry; ${dvs.nsxTeamings?.length} supplied.`,
          { path: `${at}.nsxTeamings`, source: 'VCF Installer API — DvsSpec' },
        ),
      );
    }
    (dvs.nsxTeamings ?? []).forEach((teaming, ti) => {
      if (!Array.isArray(teaming.activeUplinks) || teaming.activeUplinks.length === 0) {
        findings.push(
          error('vcf.spec.teaming-no-active-uplink', 'A teaming policy needs at least one active uplink.', {
            path: `${at}.nsxTeamings[${ti}].activeUplinks`,
          }),
        );
      }
    });
    (dvs.lagSpecs ?? []).forEach((lag, li) => {
      if (lag.name && lag.name.length > 16) {
        findings.push(
          error('vcf.spec.lag-name-too-long', 'LAG name exceeds 16 characters.', {
            path: `${at}.lagSpecs[${li}].name`,
          }),
        );
      }
    });
  });

  // --- vSAN ----------------------------------------------------------------
  const vsan = spec.datastoreSpec?.vsanSpec;
  if (vsan) {
    if (vsan.failuresToTolerate === undefined) {
      findings.push(
        warning(
          'vcf.spec.ftt-not-explicit',
          'failuresToTolerate is not set. The API documentation is inconsistent about its default, so set it explicitly.',
          {
            path: 'datastoreSpec.vsanSpec.failuresToTolerate',
            remediation: 'Set 1 for a standard cluster of 3-5 hosts, or 2 for 6 or more.',
          },
        ),
      );
    } else if (vsan.failuresToTolerate < 0 || vsan.failuresToTolerate > 3) {
      findings.push(
        error('vcf.spec.ftt-out-of-range', 'failuresToTolerate must be 0-3.', {
          path: 'datastoreSpec.vsanSpec.failuresToTolerate',
        }),
      );
    } else if (vsan.failuresToTolerate >= 2 && hosts.length > 0 && hosts.length < 6) {
      findings.push(
        error(
          'vcf.spec.ftt-needs-more-hosts',
          `FTT=${vsan.failuresToTolerate} requires at least 6 hosts; ${hosts.length} configured.`,
          { path: 'datastoreSpec.vsanSpec.failuresToTolerate', source: 'vSAN 9.1 Design Guide' },
        ),
      );
    }

    if (vsan.vsanDedup && vsan.esaConfig?.enabled) {
      findings.push(
        error(
          'vcf.spec.dedup-esa-conflict',
          'vsanDedup applies to vSAN OSA only and cannot be combined with ESA.',
          { path: 'datastoreSpec.vsanSpec.vsanDedup', source: 'vSAN 9.1 Design Guide' },
        ),
      );
    }
  }

  // --- vSphere Supervisor / VCFMS -----------------------------------------
  const vsp = spec.vspClusterSpec;
  if (vsp) {
    if (vsp.internalClusterCidrIpv4) {
      const allowed = INTERNAL_CLUSTER_CIDRS_V4                     ;
      if (!allowed.includes(vsp.internalClusterCidrIpv4)) {
        findings.push(
          error(
            'vcf.spec.invalid-internal-cidr',
            `internalClusterCidrIpv4 must be one of ${allowed.join(', ')}; got "${vsp.internalClusterCidrIpv4}".`,
            { path: 'vspClusterSpec.internalClusterCidrIpv4', source: 'VCF Installer API — SddcVspClusterSpec' },
          ),
        );
      }
    }

    // IPv6 has its own fixed list, including spelling variants of the same
    // prefixes. Like the IPv4 list, these are routed internally by the runtime,
    // so an unsupported value is rejected rather than merely unusual.
    if (vsp.internalClusterCidrIpv6) {
      const allowed6 = INTERNAL_CLUSTER_CIDRS_V6                     ;
      if (!allowed6.includes(vsp.internalClusterCidrIpv6)) {
        findings.push(
          error(
            'vcf.spec.invalid-internal-cidr-v6',
            `internalClusterCidrIpv6 must be one of ${allowed6.join(', ')}; got "${vsp.internalClusterCidrIpv6}".`,
            { path: 'vspClusterSpec.internalClusterCidrIpv6', source: 'VCF Installer API — SddcVspClusterSpec' },
          ),
        );
      }
    }

    // ipv4Pool and ipv6Pool take the same forms and the same minimum; each is
    // checked in its own family.
    const pools                                                      = [
      [4, 'vspClusterSpec.ipv4Pool', vsp.ipv4Pool],
      [6, 'vspClusterSpec.ipv6Pool', vsp.ipv6Pool],
    ];
    for (const [family, path, pool] of pools) {
      if (!pool) continue;
      const supplied = [pool.cidr, pool.ipRange, pool.addresses].filter((v) => v !== undefined);
      if (supplied.length === 0) {
        findings.push(
          error('vcf.spec.vsp-pool-empty', `${path} needs one of cidr, ipRange or addresses.`, {
            path,
          }),
        );
      }

      const count = checkVspPool(findings, pool, family, path);
      if (count > 0 && count < VCFMS_MIN_IPS) {
        findings.push(
          error(
            'vcf.spec.vcfms-pool-too-small',
            `VCF Management Services requires at least ${VCFMS_MIN_IPS} IP addresses; this pool provides ${count}.`,
            {
              path,
              remediation: `${VCFMS_MIN_IPS} is a hard minimum; 30 is recommended.`,
              source: 'VCF 9.1 IP requirements / KB 440630',
            },
          ),
        );
      }
    }

    // An IPv6 pool is only reachable over an IPv6 network entry.
    if (vsp.ipv6Pool && networks.length > 0 && !networks.some((n) => versionOf(n) === 6)) {
      findings.push(
        warning(
          'vcf.spec.ipv6-pool-without-ipv6-network',
          'vspClusterSpec.ipv6Pool is set but no networkSpecs entry declares ipAddressVersion IPv6, so nothing can carry those addresses.',
          {
            path: 'vspClusterSpec.ipv6Pool',
            remediation: 'Add the IPv6 twin of the network the management services live on, or remove ipv6Pool.',
          },
        ),
      );
    }
    if (vsp.ipv6Pool && !vsp.internalClusterCidrIpv6) {
      findings.push(
        info(
          'vcf.spec.ipv6-pool-without-internal-cidr',
          `VERIFY: vspClusterSpec.ipv6Pool is set without internalClusterCidrIpv6. Whether the runtime then falls back to ${INTERNAL_CLUSTER_CIDRS_V6[0]} is not documented; set it explicitly.`,
          { path: 'vspClusterSpec.internalClusterCidrIpv6', source: 'VCF Installer API — SddcVspClusterSpec' },
        ),
      );
    }

    if (!vsp.fleetFqdn && !options.secondaryInstance && spec.workflowType !== 'VCF_EXTEND') {
      findings.push(
        warning(
          'vcf.spec.missing-fleet-fqdn',
          'vspClusterSpec.fleetFqdn is absent. It is required for a primary VCF instance and for VVF, and omitted only for a secondary instance joining an existing fleet.',
          { path: 'vspClusterSpec.fleetFqdn', source: 'VCF Installer API — SddcVspClusterSpec' },
        ),
      );
    }

    if (vsp.size === 'small_ha') {
      findings.push(
        info(
          'vcf.spec.vsp-small-ha',
          'size "small_ha" is valid only for the management VSP cluster, not a consumption cluster.',
          { path: 'vspClusterSpec.size', source: 'VCF Installer API — SddcVspClusterSpec' },
        ),
      );
    }
  }

  // --- VCF Automation ------------------------------------------------------
  const automation = spec.vcfAutomationSpec;
  if (automation) {
    if (automation.nodePrefix && !NODE_PREFIX_PATTERN.test(automation.nodePrefix)) {
      findings.push(
        error(
          'vcf.spec.node-prefix-format',
          `nodePrefix "${automation.nodePrefix}" must be lowercase alphanumeric with hyphens, starting and ending alphanumeric, max 57 characters.`,
          { path: 'vcfAutomationSpec.nodePrefix' },
        ),
      );
    }
    if (Array.isArray(automation.ipPool)) {
      automation.ipPool.forEach((addr, ai) => {
        const family = addressValue(addr)?.family;
        if (family === undefined) {
          findings.push(
            error('vcf.spec.invalid-automation-address', `"${addr}" is not a valid IP address.`, {
              path: `vcfAutomationSpec.ipPool[${ai}]`,
            }),
          );
        } else if (family === 6) {
          // The pool is a bare string list with no IPv6 counterpart, unlike
          // vspClusterSpec, and no published example carries IPv6 in it.
          findings.push(
            warning(
              'vcf.spec.automation-ipv6-unverified',
              `VERIFY: vcfAutomationSpec.ipPool entry ${addr} is IPv6. The 9.1 API documents no IPv6 form for VCF Automation's pool; use IPv4 addresses unless Broadcom confirms it.`,
              { path: `vcfAutomationSpec.ipPool[${ai}]`, source: 'VCF Installer API — VcfAutomationSpec' },
            ),
          );
        }
      });
    }
    // 5 addresses up to 9.1.0.300. From 9.1.0.400 Broadcom's pages conflict:
    // one says 5, another says 6 with the sixth not consumed, and the samples
    // use 5. So 5 is the floor everywhere and 6 is equally acceptable.
    if (Array.isArray(automation.ipPool) && automation.ipPool.length < AUTOMATION_IP_COUNT) {
      const sixToo = typeof spec.version === 'string' && atLeastVcfVersion(spec.version, AUTOMATION_SIX_IP_VERSION);
      findings.push(
        error(
          'vcf.spec.automation-pool-too-small',
          `VCF Automation needs ${AUTOMATION_IP_COUNT}${sixToo ? ' or 6' : ''} addresses (3 active plus 2 buffer); ${automation.ipPool.length} supplied.`,
          {
            path: 'vcfAutomationSpec.ipPool',
            source: 'VCF 9.1 IP requirements',
            ...(sixToo ? { remediation: `From ${AUTOMATION_SIX_IP_VERSION} Broadcom documents both 5 and 6 (the sixth is not consumed); either is accepted.` } : {}),
          },
        ),
      );
    }
    if (automation.useExistingDeployment === true) {
      const extra = (['platformFqdn', 'ipPool', 'nodePrefix', 'size']         ).filter((k) => automation[k] !== undefined);
      if (extra.length > 0) {
        findings.push(
          warning('vcf.spec.existing-automation-extra-fields', `VCF Automation is existing, yet ${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} set. Those describe a new deployment.`, {
            path: 'vcfAutomationSpec',
            remediation: 'For an existing VCF Automation keep hostname, internalClusterCidr, useExistingDeployment and sslThumbprint.',
            source: 'VCF Installer API — VcfAutomationSpec',
          }),
        );
      }
    }
    if (
      typeof automation.internalClusterCidr === 'string' &&
      (!automation.internalClusterCidr.includes('/') || parseCidrAny(automation.internalClusterCidr) === null)
    ) {
      findings.push(
        error('vcf.spec.invalid-automation-internal-cidr', `vcfAutomationSpec.internalClusterCidr "${automation.internalClusterCidr}" is not a valid CIDR.`, {
          path: 'vcfAutomationSpec.internalClusterCidr',
          remediation: `Use one of ${INTERNAL_CLUSTER_CIDRS_V4.join(', ')}, as VCF management services do.`,
          source: 'VCF Installer API — VcfAutomationSpec',
        }),
      );
    }
    if (
      automation.internalClusterCidr &&
      vsp?.internalClusterCidrIpv4 &&
      automation.internalClusterCidr !== vsp.internalClusterCidrIpv4
    ) {
      findings.push(
        info(
          'vcf.spec.internal-cidr-mismatch',
          'vcfAutomationSpec.internalClusterCidr differs from vspClusterSpec.internalClusterCidrIpv4. A real working spec uses the same value for both.',
          { path: 'vcfAutomationSpec.internalClusterCidr' },
        ),
      );
    }
  }

  // --- SDDC Manager --------------------------------------------------------
  const sddcManager = spec.sddcManagerSpec;
  if (
    sddcManager?.rootPassword &&
    !notePlaceholder(findings, sddcManager.rootPassword, 'sddcManagerSpec.rootPassword')
  ) {
    const pw = sddcManager.rootPassword;
    if (pw.length < 15) {
      findings.push(
        error('vcf.spec.sddcm-password-length', 'SDDC Manager rootPassword must be at least 15 characters.', {
          path: 'sddcManagerSpec.rootPassword',
        }),
      );
    }
    if (!(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && SPECIAL_CHARS.test(pw))) {
      findings.push(
        error(
          'vcf.spec.sddcm-password-complexity',
          'SDDC Manager rootPassword needs upper case, lower case, a digit and one of ! % @ $ ^ # ? *',
          { path: 'sddcManagerSpec.rootPassword', source: 'VCF Installer API — SddcManagerSpec' },
        ),
      );
    }
  }

  // --- workflow type -------------------------------------------------------
  // Broadcom documents VCF_EXTEND explicitly for secondary instances. A spec
  // that omits fleetFqdn and reuses Operations but still declares VCF is
  // internally inconsistent and will not join the fleet correctly.
  if (spec.workflowType && spec.vspClusterSpec) {
    const looksSecondary =
      !spec.vspClusterSpec.fleetFqdn || spec.vcfOperationsSpec?.useExistingDeployment === true;
    // An existing VCF Operations alone does not make a secondary: the decision
    // table allows it when converging to a new fleet, and the wizard offers
    // "I have an existing VCF Operations instance" for a new fleet. Only a
    // missing fleetFqdn does.
    if (!spec.vspClusterSpec.fleetFqdn && spec.workflowType === 'VCF') {
      findings.push(
        error(
          'vcf.spec.secondary-needs-vcf-extend',
          'This looks like a secondary instance (no vspClusterSpec.fleetFqdn) but workflowType is "VCF".',
          {
            path: 'workflowType',
            remediation: 'Set workflowType to VCF_EXTEND when joining an existing fleet.',
            source: 'VCF Installer API — SddcSpec.workflowType',
          },
        ),
      );
    }
    if (!looksSecondary && spec.workflowType === 'VCF_EXTEND') {
      findings.push(
        warning(
          'vcf.spec.extend-without-fleet',
          'workflowType is VCF_EXTEND, which joins an existing fleet, but this spec carries a fleetFqdn as a primary instance would.',
          { path: 'workflowType' },
        ),
      );
    }
  }

  if (spec.workflowType === 'VCF_COMPLETE') {
    // Broadcom's JSON-spec decision table defines this one: it is the workflow
    // for deploying deferred components. It used to be reported here as
    // undocumented, which steered people away from a supported workflow.
    findings.push(
      info(
        'vcf.spec.deferred-components-workflow',
        'workflowType is VCF_COMPLETE, the workflow for deploying deferred components into an existing instance.',
        {
          path: 'workflowType',
          source: 'VCF 9.1 Deployment — Use a JSON Specification File',
        },
      ),
    );
    if (spec.vspClusterSpec) {
      findings.push(
        warning(
          'vcf.spec.deferred-components-with-vsp',
          'workflowType is VCF_COMPLETE, but the spec carries a vspClusterSpec. The deferred-components row of the decision table specifies no VCF management services.',
          {
            path: 'vspClusterSpec',
            remediation: 'Remove vspClusterSpec, or use a workflowType that deploys VCF management services.',
            source: 'VCF 9.1 Deployment — Use a JSON Specification File',
          },
        ),
      );
    }
  }

  if (spec.workflowType === 'VCF_BOOTSTRAP') {
    findings.push(
      warning(
        'vcf.spec.undocumented-workflow-type',
        'workflowType "VCF_BOOTSTRAP" is in the API enum but has no published definition.',
        { path: 'workflowType', source: 'VCF Installer API — SddcSpec' },
      ),
    );
  }

  // --- NFS datastore --------------------------------------------------------
  const nasVolume = spec.datastoreSpec?.nfsDatastoreSpec?.nasVolume;
  if (nasVolume && typeof nasVolume.readOnly !== 'boolean') {
    findings.push(
      error(
        'vcf.spec.nfs-readonly-missing',
        'nasVolume.readOnly is required and is absent. It reads like an optional flag but the API rejects a spec without it.',
        {
          path: 'datastoreSpec.nfsDatastoreSpec.nasVolume.readOnly',
          remediation: 'Set readOnly to false for a read-write datastore, or true for read-only.',
          source: 'VCF Installer API — NasVolumeSpec',
        },
      ),
    );
  }

  // --- VCF management component networks ------------------------------------
  const mcInfra = spec.vcfManagementComponentsInfrastructureSpec;
  if (mcInfra) {
    const networks                                                             = [
      ['localRegionNetwork', mcInfra.localRegionNetwork],
      ['xRegionNetwork', mcInfra.xRegionNetwork],
    ];
    for (const [key, network] of networks) {
      if (!network) continue;
      for (const field of ['networkName', 'subnetMask', 'gateway']         ) {
        if (!network[field]) {
          findings.push(
            error(
              'vcf.spec.management-network-incomplete',
              `vcfManagementComponentsInfrastructureSpec.${key}.${field} is required and is absent.`,
              {
                path: `vcfManagementComponentsInfrastructureSpec.${key}.${field}`,
                remediation: 'Supply networkName, subnetMask and gateway together; all three are required.',
                source: 'VCF Installer API — VcfManagementComponentsNetworkSpec',
              },
            ),
          );
        }
      }
      // gateway/subnetMask are the IPv4 half; IPv6 has its own pair of fields.
      const at = `vcfManagementComponentsInfrastructureSpec.${key}`;
      if (network.gateway && addressValue(network.gateway)?.family !== 4) {
        findings.push(
          error('vcf.spec.management-network-gateway', `${at}.gateway "${network.gateway}" is not an IPv4 address.`, {
            path: `${at}.gateway`,
            remediation: 'gateway takes the IPv4 gateway; an IPv6 gateway goes in ipv6Gateway with ipv6Prefix.',
            source: 'VCF Installer API — VcfManagementComponentsNetworkSpec',
          }),
        );
      }
      if (network.subnetMask && !isNetmask(network.subnetMask)) {
        findings.push(
          error('vcf.spec.invalid-subnet-mask', `${at}.subnetMask "${network.subnetMask}" is not a valid IPv4 subnet mask.`, {
            path: `${at}.subnetMask`,
            remediation: 'subnetMask is the IPv4 mask (255.255.255.0); the IPv6 side is ipv6Prefix.',
            source: 'VCF Installer API — VcfManagementComponentsNetworkSpec',
          }),
        );
      }
      if (network.ipv6Gateway !== undefined && addressValue(network.ipv6Gateway)?.family !== 6) {
        findings.push(
          error('vcf.spec.management-network-ipv6-gateway', `${at}.ipv6Gateway "${network.ipv6Gateway}" is not an IPv6 address.`, {
            path: `${at}.ipv6Gateway`,
          }),
        );
      }
      if (
        network.ipv6Prefix !== undefined &&
        !(Number.isInteger(network.ipv6Prefix) && network.ipv6Prefix >= 1 && network.ipv6Prefix <= 128)
      ) {
        findings.push(
          error('vcf.spec.management-network-ipv6-prefix', `${at}.ipv6Prefix must be an integer 1-128; got ${String(network.ipv6Prefix)}.`, {
            path: `${at}.ipv6Prefix`,
            source: 'VCF Installer API — VcfManagementComponentsNetworkSpec',
          }),
        );
      }
      if ((network.ipv6Gateway === undefined) !== (network.ipv6Prefix === undefined)) {
        findings.push(
          warning(
            'vcf.spec.management-network-ipv6-incomplete',
            `${at} sets only one of ipv6Gateway and ipv6Prefix; the segment's IPv6 side needs both.`,
            { path: at },
          ),
        );
      }
    }
  }

  // --- licensing -----------------------------------------------------------
  if (!spec.licenseServerSpec) {
    // Joining a fleet or converging reuses the License Server of the VCF
    // Operations already there (the decision table's footnote), so absence is
    // only a note on those rows.
    const optional = spec.workflowType === 'VCF_EXTEND' || spec.vcenterSpec?.useExistingDeployment === true;
    const make = optional ? info : warning;
    findings.push(
      make(
        'vcf.spec.no-license-server',
        optional
          ? 'licenseServerSpec is absent. That is right only when the existing VCF Operations already has a License Server; one License Server serves one VCF Operations.'
          : 'licenseServerSpec is absent. The centralized License Server is a mandatory component in 9.1 for both VCF and VVF.',
        { path: 'licenseServerSpec', source: 'VCF 9.1 licensing' },
      ),
    );
  }

  for (const key of Object.keys(spec)) {
    if (/licenseKey|licenseFile|licenses$/i.test(key)) {
      findings.push(
        error(
          'vcf.spec.license-key-in-spec',
          `"${key}" does not belong in a 9.1 SddcSpec. Licensing moved to a post-deployment step in VCF Operations.`,
          {
            path: key,
            remediation:
              'Remove it. Products run in evaluation mode for up to 90 days and are licensed through the VCF Business Services Console.',
            source: 'VCF 9.1 licensing',
          },
        ),
      );
    }
  }

  return findings;
}

/** Parse JSON and validate. Reports malformed JSON as a finding rather than throwing. */
export function validateSddcSpecJson(json        , options                  = {})            {
  let parsed         ;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return [
      error('vcf.spec.invalid-json', `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`),
    ];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [error('vcf.spec.not-an-object', 'A specification must be a JSON object.')];
  }
  return validateSddcSpec(parsed                                               , options);
}

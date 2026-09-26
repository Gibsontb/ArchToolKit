/**
 * VCF 9.1 workload domains, clusters, network pools and hosts — the parts of an
 * instance that SDDC Manager still owns in 9.1.
 *
 * Fleet management in VCF Operations took over passwords, certificates,
 * identity and the lifecycle of the management components (vcf-fleet-91.ts).
 * Building a VCF instance out — a new workload domain, a cluster added,
 * expanded or shrunk, a network pool, a host released, an existing vCenter
 * imported, an Avi Load Balancer controller cluster deployed — is still done
 * through the SDDC Manager API of that instance, at /v1.
 *
 * Every acting script here validates first (the validation is the dry run:
 * `--dry-run` stops after it), refuses while another SDDC Manager task runs,
 * reads every secret from a mode-600 file into memory, and follows the task to
 * the end. The request bodies follow the SDDC Manager API reference; where a
 * 9.1 field could not be confirmed the file says VERIFY.
 *
 * The same objects exist declaratively on the Terraform page (vcf provider:
 * vcf_workload_domain, vcf_add_cluster, vcf_commission_hosts and the network
 * pool with it). These are the apply-now equivalents, with the guardrails a
 * one-off change needs.
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { containsAny, familyOf, isIp, overlapsAny, parseCidrAny } from '../../core/ip.js';
import { EVC_MODES,                                                                                                                                    } from '../../vcf/spec-types.js';
import { scheduledEnv } from '../apply.js';
import { SRC, json, lifecycleGuard, parseArgs, sddcHead, sddcImport, sq, tableRows } from './vcf-fleet-91-common.js';

const PLATFORM = 'vcf-fleet'         ;

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

export const PRINCIPAL_STORAGE = [
  { value: 'VSAN_ESA', label: 'vSAN ESA' },
  { value: 'VSAN', label: 'vSAN OSA' },
  { value: 'NFS', label: 'NFS v3' },
  { value: 'VMFS_FC', label: 'VMFS on Fibre Channel' },
  { value: 'VVOL', label: 'vVols' },
];

const VC_SIZES                           = ['tiny', 'small', 'medium', 'large', 'xlarge'];
const VC_STORAGE                                = ['lstorage', 'xlstorage'];
// The domain API also takes a small NSX Manager for a lab; bring-up does not.
const NSX_SIZES                                         = ['small', 'medium', 'large', 'xlarge'];

const LAG_MODES                                                            = [
  { value: 'SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT', label: 'Source and destination IP and TCP/UDP port' },
  { value: 'SOURCE_AND_DESTINATION_IP', label: 'Source and destination IP' },
  { value: 'SOURCE_AND_DESTINATION_IP_AND_VLAN', label: 'Source and destination IP and VLAN' },
  { value: 'SOURCE_AND_DESTINATION_MAC', label: 'Source and destination MAC' },
  { value: 'SOURCE_PORT_ID', label: 'Source port ID' },
];

const NETWORK_TYPES = ['VMOTION', 'VSAN', 'NFS', 'ISCSI'];

// ---------------------------------------------------------------------------
// Small checks
// ---------------------------------------------------------------------------

/** A dotted IPv4 mask for a prefix. */
function maskOf(prefix        )         {
  const bits = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 255).join('.');
}

/** A prefix length from "255.255.255.0" or "24" or "/64". */
function prefixOf(mask        )                {
  const t = mask.trim().replace(/^\//, '');
  if (/^\d{1,3}$/.test(t)) return Number(t);
  const parts = t.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  const bits = parts.reduce((acc, p) => acc * 256 + p, 0);
  const text = bits.toString(2).padStart(32, '0');
  return /^1*0*$/.test(text) ? text.indexOf('0') === -1 ? 32 : text.indexOf('0') : null;
}

/** IPv4 address as a number, for comparing a range's two ends; null for IPv6. */
function v4Number(address        )                {
  if (familyOf(address) !== 4) return null;
  return address.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

/** "a-b; c-d" as ranges. */
function rangesOf(text        )                                   {
  return text
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      // An IPv6 range is written start-end too; the dash is never inside an address.
      const [start = '', end = ''] = part.split(/\s*-\s*/);
      return { start: start.trim(), end: (end || start).trim() };
    });
}

/** Findings for one subnet, gateway and set of ranges. */
function checkSubnet(what        , cidr        , gateway        , ranges                                           , code        , findings           )       {
  const net = parseCidrAny(cidr);
  if (!net || !cidr.includes('/')) {
    findings.push(error(`${code}.subnet`, `${what}: "${cidr}" is not a subnet in CIDR form (10.0.12.0/24 or 2001:db8:12::/64).`, { source: SRC }));
    return;
  }
  if (gateway && !containsAny(cidr, gateway)) findings.push(error(`${code}.gateway`, `${what}: gateway ${gateway} is not inside ${cidr}.`, { source: SRC }));
  if (ranges.length === 0) findings.push(error(`${code}.no-range`, `${what}: no address range.`, { source: SRC }));
  for (const range of ranges) {
    if (!isIp(range.start) || !isIp(range.end) || !containsAny(cidr, range.start) || !containsAny(cidr, range.end)) {
      findings.push(error(`${code}.range`, `${what}: range ${range.start}-${range.end} is not inside ${cidr}.`, { source: SRC }));
      continue;
    }
    const a = v4Number(range.start);
    const b = v4Number(range.end);
    if (a !== null && b !== null && a > b) findings.push(error(`${code}.range-order`, `${what}: range ${range.start}-${range.end} ends before it starts.`, { source: SRC }));
    if (gateway && a !== null && b !== null) {
      const g = v4Number(gateway);
      if (g !== null && g >= a && g <= b) findings.push(error(`${code}.gateway-in-range`, `${what}: the gateway ${gateway} is inside the range ${range.start}-${range.end}; a host would be given the gateway's address.`, { source: SRC }));
    }
  }
}

/** Every line of a textarea, trimmed, no blanks or comments. */
function linesOf(text        )           {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// ---------------------------------------------------------------------------
// The cluster: shared by workload domain create and cluster create / expand
// ---------------------------------------------------------------------------

/** The inputs of a cluster's hosts, storage and network, shown when `when` holds. */
function clusterInputs(when                             , expandWhen                             )                   {
  const at = when ? { showWhen: when } : {};
  const hostsAt = expandWhen ? { showWhen: expandWhen } : at;
  const section = 'Cluster storage and networking';
  const onStorage = (...storage          ) => ({ showWhen: { input: 'storage', equals: storage } });
  return [
    { id: 'network_pool', label: 'Network pool of the hosts', control: 'text', default: 'wld01-np01', hint: 'Every host must have been commissioned into it (fleet_network_pool, fleet_host_commission)', ...hostsAt },
    // In the cluster blueprint the host list is also what a shrink removes, so it is always shown there.
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx05.example.com\nesx06.example.com\nesx07.example.com\nesx08.example.com', hint: 'One FQDN per line: commissioned, unassigned and usable (for a shrink: the hosts to remove)', ...(expandWhen ? {} : at) },
    { id: 'vmnics', label: 'Physical NICs for the VDS', control: 'text', default: 'vmnic0, vmnic1', hint: 'Comma separated; mapped to uplink1, uplink2, … (or to the LAG) on every host', ...hostsAt },
    { id: 'storage', label: 'Principal storage', control: 'select', options: PRINCIPAL_STORAGE, default: 'VSAN_ESA', ...at },
    { id: 'datastore_name', label: 'Datastore name', control: 'text', default: 'wld01-cl01-ds-vsan01', section, ...at },
    { id: 'ftt', label: 'vSAN failures to tolerate', control: 'select', options: [{ value: '1', label: '1 (three hosts or more)' }, { value: '2', label: '2 (five hosts or more)' }], default: '1', section, ...onStorage('VSAN', 'VSAN_ESA') },
    { id: 'dedup', label: 'Deduplication and compression (vSAN OSA)', control: 'toggle', default: false, section, ...onStorage('VSAN') },
    { id: 'nfs_server', label: 'NFS server', control: 'text', default: 'nfs01.example.com', hint: 'IPv4, IPv6 or FQDN', section, ...onStorage('NFS') },
    { id: 'nfs_path', label: 'NFS export path', control: 'text', default: '/exports/wld01-cl01', section, ...onStorage('NFS') },
    { id: 'vvol_protocol', label: 'vVols protocol', control: 'select', options: [{ value: 'FC', label: 'Fibre Channel' }, { value: 'ISCSI', label: 'iSCSI' }, { value: 'NFS', label: 'NFS' }], default: 'FC', section, ...onStorage('VVOL') },
    { id: 'vasa_provider', label: 'VASA provider (as registered in SDDC Manager)', control: 'text', default: 'array01-vasa', section, ...onStorage('VVOL') },
    { id: 'vds_name', label: 'VDS name', control: 'text', default: 'wld01-cl01-vds01', section, ...at },
    {
      id: 'lacp',
      label: 'LACP on the VDS uplinks (9.1)',
      control: 'select',
      options: [
        { value: 'off', label: 'Off — uplinks teamed by the port groups' },
        { value: 'ACTIVE', label: 'LAG, LACP active' },
        { value: 'PASSIVE', label: 'LAG, LACP passive' },
      ],
      default: 'off',
      section,
      ...at,
    },
    { id: 'lag_lb', label: 'LAG load balancing', control: 'select', options: LAG_MODES, default: 'SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT', section, showWhen: { input: 'lacp', notEquals: ['off'] } },
    { id: 'lacp_timeout', label: 'LACP timeout', control: 'select', options: [{ value: 'SLOW', label: 'Slow (30 s)' }, { value: 'FAST', label: 'Fast (1 s)' }], default: 'SLOW', section, showWhen: { input: 'lacp', notEquals: ['off'] } },
    { id: 'mtu', label: 'VDS MTU', control: 'number', default: 9000, min: 1500, max: 9000, section, ...at },
    { id: 'geneve_vlan', label: 'Host TEP (Geneve) VLAN', control: 'number', default: 1614, min: 0, max: 4094, section, ...at },
    { id: 'tep_mode', label: 'Host TEP addresses', control: 'select', options: [{ value: 'static', label: 'Static IP pool' }, { value: 'dhcp', label: 'DHCP on the TEP VLAN' }], default: 'static', section, ...at },
    { id: 'tep_pool', label: 'Host TEP pool name', control: 'text', default: 'wld01-cl01-tep-pool', section, showWhen: { input: 'tep_mode', equals: ['static'] } },
    { id: 'tep_cidr', label: 'Host TEP subnet', control: 'text', default: '172.16.14.0/24', hint: 'IPv4 or IPv6', section, showWhen: { input: 'tep_mode', equals: ['static'] } },
    { id: 'tep_gateway', label: 'Host TEP gateway', control: 'text', default: '172.16.14.1', section, showWhen: { input: 'tep_mode', equals: ['static'] } },
    { id: 'tep_range', label: 'Host TEP range', control: 'text', default: '172.16.14.101-172.16.14.199', hint: 'start-end; more than one separated by ;', section, showWhen: { input: 'tep_mode', equals: ['static'] } },
    { id: 'evc', label: 'EVC mode', control: 'select', options: EVC_MODES.map((mode) => ({ value: mode, label: mode })), blankLabel: 'None', section, ...at },
    { id: 'ha', label: 'vSphere HA', control: 'toggle', default: true, section, ...at },
    { id: 'cluster_image', label: 'vLCM cluster image id', control: 'text', default: '', hint: 'Optional: GET /v1/personalities. Empty: the domain default', section, ...at },
  ];
}

                       
                                                                       
                                         
                                                             
                                                                                                         
                           
                               
 

/** The ClusterSpec the domain and cluster APIs take, from the cluster inputs. */
function clusterPlan(values                 , clusterName        , code        , needSpec = true)              {
  const findings            = [];
  const fqdns = linesOf(str(values, 'hosts', ''));
  const vmnics = listOf(str(values, 'vmnics', 'vmnic0, vmnic1'));
  const storage = str(values, 'storage', 'VSAN_ESA');
  const ftt = Number(str(values, 'ftt', '1')) || 1;
  const vds = str(values, 'vds_name', `${clusterName}-vds01`);
  const lacp = str(values, 'lacp', 'off');
  const lag                      =
    lacp === 'off'
      ? undefined
      : {
          name: 'lag1',
          uplinksCount: Math.max(2, vmnics.length),
          lacpMode: lacp === 'PASSIVE' ? 'PASSIVE' : 'ACTIVE',
          lacpTimeoutMode: str(values, 'lacp_timeout', 'SLOW') === 'FAST' ? 'FAST' : 'SLOW',
          loadBalancingMode: str(values, 'lag_lb', 'SOURCE_AND_DESTINATION_IP_AND_TCP_UDP_PORT')                        ,
        };
  const tepMode = str(values, 'tep_mode', 'static');
  const tepCidr = str(values, 'tep_cidr', '');
  const tepGateway = str(values, 'tep_gateway', '');
  const tepRanges = rangesOf(str(values, 'tep_range', ''));
  const geneve = num(values, 'geneve_vlan', 1614);
  const mtu = num(values, 'mtu', 9000);
  const evc = str(values, 'evc', '');
  const image = str(values, 'cluster_image', '');

  if (fqdns.length === 0) findings.push(error(`${code}.no-hosts`, 'No hosts are listed.', { source: SRC }));
  const dupes = fqdns.filter((f, i) => fqdns.indexOf(f) !== i);
  if (dupes.length > 0) findings.push(error(`${code}.duplicate-host`, `Listed twice: ${[...new Set(dupes)].join(', ')}.`, { source: SRC }));
  const short = fqdns.filter((f) => !f.includes('.') && !isIp(f));
  if (short.length > 0) findings.push(warning(`${code}.not-fqdn`, `Not fully qualified: ${short.join(', ')}. SDDC Manager matches hosts by the FQDN they were commissioned with.`, { source: SRC }));
  if (vmnics.length === 0) findings.push(error(`${code}.no-vmnics`, 'Name at least one physical NIC for the VDS.', { source: SRC }));
  if (vmnics.length === 1) findings.push(warning(`${code}.one-vmnic`, 'One physical NIC means no uplink redundancy for management, vMotion, storage or overlay traffic.', { source: SRC }));
  if (lag && vmnics.length < 2) findings.push(error(`${code}.lag-one`, 'A LAG needs at least two physical NICs.', { source: SRC }));
  if (lag) findings.push(info(`${code}.lacp`, 'LACP for VCF-built VDS is new in the 9.1 interface (API-only before). The physical switch ports must be in a matching port channel before the hosts are added, or the hosts lose connectivity.', { source: SRC }));
  if (storage.startsWith('VSAN') && fqdns.length > 0 && fqdns.length < 2 * ftt + 1) {
    findings.push(error(`${code}.vsan-min`, `vSAN with failures to tolerate ${ftt} needs at least ${2 * ftt + 1} hosts; ${fqdns.length} listed.`, { source: SRC }));
  }
  if (storage.startsWith('VSAN') && fqdns.length === 2 * ftt + 1) {
    findings.push(warning(`${code}.vsan-headroom`, `${fqdns.length} hosts is the minimum for FTT=${ftt}: with one in maintenance the cluster cannot rebuild to full protection.`, { remediation: `Use ${2 * ftt + 2} hosts or more.`, source: SRC }));
  }
  if (storage === 'VSAN_ESA' && bool(values, 'dedup', false)) findings.push(warning(`${code}.esa-dedup`, 'Deduplication and compression is an OSA setting; vSAN ESA compresses by storage policy. It is ignored for ESA.', { source: SRC }));
  if (storage === 'NFS' && (!str(values, 'nfs_server', '') || !str(values, 'nfs_path', '').startsWith('/'))) findings.push(error(`${code}.nfs`, 'NFS needs a server and an absolute export path.', { source: SRC }));
  if (!storage.startsWith('VSAN') && fqdns.length === 1) findings.push(warning(`${code}.one-host`, 'A one-host cluster has no vSphere HA.', { source: SRC }));
  if (geneve < 0 || geneve > 4094) findings.push(error(`${code}.geneve-vlan`, `Geneve VLAN ${geneve} is outside 0-4094.`, { source: SRC }));
  if (mtu < 1600) findings.push(error(`${code}.mtu`, `A VDS MTU of ${mtu} is below the 1600 the NSX overlay needs.`, { remediation: 'Use 9000 end to end, or at least 1700.', source: SRC }));
  if (tepMode === 'static') {
    checkSubnet('Host TEP pool', tepCidr, tepGateway, tepRanges, `${code}.tep`, findings);
    const size = tepRanges.reduce((sum, r) => {
      const a = v4Number(r.start);
      const b = v4Number(r.end);
      return a !== null && b !== null && b >= a ? sum + (b - a + 1) : sum + 1_000_000;
    }, 0);
    if (fqdns.length > 0 && size < fqdns.length * 2) findings.push(error(`${code}.tep-small`, `The TEP range has ${size} address(es); ${fqdns.length} hosts with two TEPs each need ${fqdns.length * 2}.`, { source: SRC }));
    if (familyOf(tepCidr) === 6) findings.push(warning(`${code}.tep-ipv6`, 'An IPv6 host TEP pool: NSX supports IPv6 TEPs, but VERIFY that the SDDC Manager 9.1 cluster spec accepts an IPv6 ipAddressPoolSpec before relying on it.', { source: SRC }));
  }

  const portGroups                                            = [
    { name: `${vds}-pg-mgmt`, transportType: 'MANAGEMENT' },
    { name: `${vds}-pg-vmotion`, transportType: 'VMOTION' },
  ];
  if (storage.startsWith('VSAN')) portGroups.push({ name: `${vds}-pg-vsan`, transportType: 'VSAN' });
  if (storage === 'NFS' || (storage === 'VVOL' && str(values, 'vvol_protocol', 'FC') === 'NFS')) portGroups.push({ name: `${vds}-pg-nfs`, transportType: 'NFS' });
  if (storage === 'VVOL' && str(values, 'vvol_protocol', 'FC') === 'ISCSI') portGroups.push({ name: `${vds}-pg-iscsi`, transportType: 'ISCSI' });

  const datastoreName = str(values, 'datastore_name', `${clusterName}-ds01`);
  const datastoreSpec                          = storage.startsWith('VSAN')
    ? { vsanDatastoreSpec: { datastoreName, failuresToTolerate: ftt, ...(storage === 'VSAN' ? { dedupAndCompressionEnabled: bool(values, 'dedup', false) } : {}), esaConfig: { enabled: storage === 'VSAN_ESA' } } }
    : storage === 'NFS'
      ? { nfsDatastoreSpecs: [{ datastoreName, nasVolume: { serverName: [str(values, 'nfs_server', '')], path: str(values, 'nfs_path', ''), readOnly: false } }] }
      : storage === 'VMFS_FC'
        ? { vmfsDatastoreSpec: { fcSpec: [{ datastoreName }] } }
        : { vvolDatastoreSpecs: [{ name: datastoreName, vasaProviderSpec: { vasaProviderName: str(values, 'vasa_provider', ''), storageProtocolType: str(values, 'vvol_protocol', 'FC'), storageContainerName: '<REQUIRED — storage container, from GET /v1/vasa-providers>' } }] };

  const tepPool                                =
    tepMode === 'static'
      ? { name: str(values, 'tep_pool', `${clusterName}-tep-pool`), subnets: [{ cidr: tepCidr, gateway: tepGateway, ipAddressPoolRanges: tepRanges.map((r) => ({ start: r.start, end: r.end })) }] }
      : undefined;

  const hosts = fqdns.map((fqdn) => ({
    fqdn,
    vmNics: vmnics.map((id, index) => ({ id, vdsName: vds, uplink: lag ? `${lag.name}-${index}` : `uplink${index + 1}` })),
  }));

  const spec                          = needSpec
    ? {
        name: clusterName,
        ...(image ? { clusterImageId: image } : {}),
        hostSpecs: [],
        datastoreSpec,
        networkSpec: {
          vdsSpecs: [{ name: vds, mtu, portGroupSpecs: portGroups, ...(lag ? { lagSpecs: [lag] } : {}) }],
          nsxClusterSpec: { nsxTClusterSpec: { geneveVlanId: geneve, ...(tepPool ? { ipAddressPoolSpec: tepPool } : {}) } },
        },
        advancedOptions: { highAvailability: { enabled: bool(values, 'ha', true) }, ...(evc ? { evcMode: evc } : {}) },
      }
    : {};
  if (needSpec && storage === 'VVOL') findings.push(warning(`${code}.vvol-container`, 'vVols principal storage needs the storage container of the VASA provider; the spec leaves it <REQUIRED> and the script refuses until it is filled.', { source: SRC }));
  return { spec, hosts, storage, findings };
}

/**
 * Resolve hosts.json FQDNs to SDDC Manager host ids. Every host must be
 * commissioned, UNASSIGNED_USEABLE and — when a pool is named — in that pool.
 * Leaves HOST_IDS as [{fqdn, id}].
 */
function resolveHosts(pool        )           {
  return [
    '# Every listed host must be commissioned, unassigned and usable, and in the',
    '# network pool named — or nothing is sent. Matched by FQDN, case-insensitively.',
    `POOL=${sq(pool)}`,
    'ALL_HOSTS=$(api GET /v1/hosts | jq -c \'if (.elements | type) == "array" then .elements else error("no elements array in GET /v1/hosts") end\')',
    'HOST_IDS=$(jq -c --argjson all "$ALL_HOSTS" \'[ .[].fqdn as $f',
    '  | ([ $all[] | select((.fqdn // "" | ascii_downcase) == ($f | ascii_downcase)) ][0]) as $h',
    '  | { fqdn: $f, id: ($h.id // null), status: ($h.status // "NOT COMMISSIONED"), pool: ($h.networkPool.name // "") } ]\' hosts.json)',
    'BAD=$(jq -r --arg pool "$POOL" \'.[] | select(.id == null or .status != "UNASSIGNED_USEABLE" or ($pool != "" and .pool != $pool)) | "  \\(.fqdn): \\(.status)\\(if .pool != "" then " in pool " + .pool else "" end)"\' <<<"$HOST_IDS")',
    'if [[ -n "$BAD" ]]; then',
    '  echo "Refusing: these hosts are not commissioned, unassigned and usable${POOL:+ in pool ${POOL}}:" >&2',
    '  echo "$BAD" >&2',
    '  exit 1',
    'fi',
    'echo "Hosts: $(jq -r \'[.[].fqdn] | join(", ")\' <<<"$HOST_IDS")"',
  ];
}

/** jq that fills .hostSpecs of a ClusterSpec from hosts.json and $HOST_IDS. */
const HOST_SPECS_JQ = '[ $h[0][] as $x | { id: ([ $ids[] | select(.fqdn == $x.fqdn) ][0].id), hostNetworkSpec: { vmNics: $x.vmNics } } ]';

// ---------------------------------------------------------------------------
// The blueprints
// ---------------------------------------------------------------------------

export const VCF_FLEET_91_DOMAINS                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_network_pool',
    platform: PLATFORM,
    label: 'Network pool for vMotion and storage (SDDC Manager)',
    group: 'Network pools',
    description:
      'Create the network pool hosts are commissioned into — VLAN, MTU, subnet, gateway and address ranges for vMotion and vSAN, NFS or iSCSI — or add a range to a pool that is running out. Every range is checked against its subnet and gateway before anything is sent; the pool is created as given, and a range added only to the network of the type named.',
    inputs: [
      {
        id: 'mode',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'create', label: 'Create the pool' },
          { value: 'add_range', label: 'Add ranges to an existing pool' },
          { value: 'report', label: 'Report free addresses in every pool' },
        ],
        default: 'create',
      },
      { id: 'pool_name', label: 'Pool name', control: 'text', default: 'wld01-np01', showWhen: { input: 'mode', notEquals: ['report'] } },
      {
        id: 'networks',
        label: 'Networks',
        control: 'textarea',
        default: 'VMOTION | 1612 | 9000 | 172.16.12.0/24 | 172.16.12.1 | 172.16.12.101-172.16.12.199\nVSAN | 1613 | 9000 | 172.16.13.0/24 | 172.16.13.1 | 172.16.13.101-172.16.13.199',
        hint: 'type | VLAN | MTU | subnet | gateway | ranges (start-end; start-end)',
        showWhen: { input: 'mode', notEquals: ['report'] },
      },
      { id: 'min_free', label: 'Report a network with fewer free addresses than', control: 'number', default: 8, min: 1, max: 1000 },
      { id: 'webhook', label: 'Report to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-network-pools' },
    ],
    automation: (values                 , name        )             => {
      const mode = str(values, 'mode', 'create');
      const pool = str(values, 'pool_name', 'wld01-np01');
      const minFree = num(values, 'min_free', 8);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || `network-pool-${pool}`, 'network-pool');
      const findings            = [];

      const rows = tableRows(str(values, 'networks', ''), 6).map(([type = '', vlan = '', mtu = '', subnet = '', gateway = '', ranges = '']) => ({
        type: type.toUpperCase(),
        vlan: Number(vlan),
        mtu: Number(mtu || 9000),
        subnet,
        gateway,
        ranges: rangesOf(ranges),
      }));

      if (mode !== 'report') {
        if (rows.length === 0) findings.push(error('fleet.pool.no-networks', 'List at least the vMotion network.', { source: SRC }));
        if (mode === 'create' && !rows.some((r) => r.type === 'VMOTION')) findings.push(error('fleet.pool.no-vmotion', 'A network pool needs a VMOTION network.', { source: SRC }));
        if (mode === 'create' && !rows.some((r) => r.type !== 'VMOTION')) findings.push(warning('fleet.pool.no-storage', 'No storage network (VSAN, NFS or ISCSI): hosts from this pool can only use VMFS on Fibre Channel or vVols over FC.', { source: SRC }));
        const types = rows.map((r) => r.type);
        const dupes = types.filter((t, i) => types.indexOf(t) !== i);
        if (dupes.length > 0) findings.push(error('fleet.pool.duplicate-type', `A pool has one network per type; ${[...new Set(dupes)].join(', ')} is listed twice.`, { source: SRC }));
        if (types.includes('VSAN') && types.includes('NFS')) findings.push(info('fleet.pool.vsan-nfs', 'A pool with both VSAN and NFS networks serves hosts of either principal storage; each cluster still uses one.', { source: SRC }));
        for (const row of rows) {
          if (!NETWORK_TYPES.includes(row.type)) findings.push(error('fleet.pool.type', `Network type "${row.type}" is not one of ${NETWORK_TYPES.join(', ')}.`, { source: SRC }));
          if (!Number.isInteger(row.vlan) || row.vlan < 0 || row.vlan > 4094) findings.push(error('fleet.pool.vlan', `${row.type}: VLAN "${row.vlan}" is outside 0-4094.`, { source: SRC }));
          if (!Number.isInteger(row.mtu) || row.mtu < 1500 || row.mtu > 9000) findings.push(error('fleet.pool.mtu', `${row.type}: MTU ${row.mtu} is outside 1500-9000.`, { source: SRC }));
          else if (row.mtu < 9000 && row.type !== 'ISCSI') findings.push(warning('fleet.pool.mtu-small', `${row.type}: MTU ${row.mtu}. vMotion and vSAN are sized for jumbo frames (9000) end to end.`, { source: SRC }));
          checkSubnet(row.type, row.subnet, row.gateway, row.ranges, 'fleet.pool', findings);
          if (familyOf(row.subnet) === 6) findings.push(warning('fleet.pool.ipv6', `${row.type} is IPv6. VCF 9.x supports IPv6 host networking; VERIFY that the SDDC Manager network pool API of your release takes an IPv6 subnet (the prefix length is sent in "mask") before commissioning hosts into it.`, { source: SRC }));
        }
        for (let i = 0; i < rows.length; i += 1) {
          for (let j = i + 1; j < rows.length; j += 1) {
            if (overlapsAny(rows[i] .subnet, rows[j] .subnet)) findings.push(error('fleet.pool.overlap', `${rows[i] .type} ${rows[i] .subnet} overlaps ${rows[j] .type} ${rows[j] .subnet}.`, { source: SRC }));
            if (rows[i] .vlan === rows[j] .vlan) findings.push(warning('fleet.pool.same-vlan', `${rows[i] .type} and ${rows[j] .type} share VLAN ${rows[i] .vlan}; storage and vMotion traffic are then only separated by subnet.`, { source: SRC }));
          }
        }
      }

      const networks = rows.map((row) => {
        const net = parseCidrAny(row.subnet);
        return {
          type: row.type,
          vlanId: row.vlan,
          mtu: row.mtu,
          subnet: net?.network ?? row.subnet,
          mask: net ? (net.family === 4 ? maskOf(net.prefix) : String(net.prefix)) : '',
          gateway: row.gateway,
          ipPools: row.ranges.map((range) => ({ start: range.start, end: range.end })),
        };
      });
      const body = { name: pool, networks };

      const report = [
        ...sddcHead(`Free addresses in every SDDC Manager network pool; exits 1 below ${minFree} free.`, ['Reads only.']),
        'PROBLEMS=()',
        `MIN_FREE=${minFree}`,
        'POOLS=$(api GET /v1/network-pools | jq -c \'if (.elements | type) == "array" then .elements else error("no elements array") end\')',
        'for PID in $(jq -r \'.[].id\' <<<"$POOLS"); do',
        '  PNAME=$(jq -r --arg id "$PID" \'.[] | select(.id == $id) | .name\' <<<"$POOLS")',
        '  # GET /v1/network-pools/{id}/networks returns freeIps and usedIps per network (VERIFY on your release).',
        '  ROWS=$(api GET "/v1/network-pools/${PID}/networks" | jq -r \'(.elements // .)[]? | [.type, (.vlanId|tostring), .subnet, ((.freeIps // []) | length | tostring), ((.usedIps // []) | length | tostring)] | @tsv\')',
        '  while IFS=$\'\\t\' read -r TYPE VLAN SUBNET FREE USED; do',
        '    [[ -n "$TYPE" ]] || continue',
        '    echo "${PNAME}  ${TYPE}  VLAN ${VLAN}  ${SUBNET}  free ${FREE}  used ${USED}"',
        '    if (( FREE < MIN_FREE )); then PROBLEMS+=("${PNAME} ${TYPE}: ${FREE} free address(es), below ${MIN_FREE}"); fi',
        '  done <<<"$ROWS"',
        'done',
        'if (( ${#PROBLEMS[@]} == 0 )); then echo "Every pool has room."; exit 0; fi',
        'printf "%s\\n" "${PROBLEMS[@]}" >&2',
        ...(webhook
          ? [
              `printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vcf-network-pools", problems: .}' | curl -sS -f -o /dev/null -X POST ${sq(webhook)} -H "Content-Type: application/json" --data-binary @- || echo "WARNING: could not post to the webhook." >&2`,
            ]
          : []),
        'exit 1',
        '',
      ].join('\n');

      const apply = [
        ...sddcHead(mode === 'create' ? `Create network pool ${pool}.` : `Add address ranges to network pool ${pool}.`, [
          'Applies when run. With --dry-run it resolves the pool and prints what it would send.',
        ]),
        ...parseArgs(),
        ...lifecycleGuard(),
        `POOL=${sq(pool)}`,
        'EXISTING=$(api GET /v1/network-pools | jq -r --arg n "$POOL" \'[.elements[]? | select(.name == $n)] | if length > 1 then error("two pools share the name") else (.[0].id // empty) end\')',
        ...(mode === 'create'
          ? [
              'if [[ -n "$EXISTING" ]]; then echo "Refusing: a network pool named ${POOL} already exists (${EXISTING}). Use add_range to grow it." >&2; exit 1; fi',
              'if (( DRY_RUN )); then echo "DRY RUN: would POST /v1/network-pools:"; jq . network-pool.json; exit 0; fi',
              'RESULT=$(api POST /v1/network-pools --data @network-pool.json)',
              'jq -r \'"Created \\(.name // "the pool") \\(.id // "")"\' <<<"$RESULT"',
              'api GET /v1/network-pools | jq -r --arg n "$POOL" \'.elements[]? | select(.name == $n) | .networks[]? | "  \\(.type)  VLAN \\(.vlanId)  \\(.subnet)"\'',
            ]
          : [
              '[[ -n "$EXISTING" ]] || { echo "Refusing: no network pool named ${POOL}." >&2; exit 1; }',
              'NETS=$(api GET "/v1/network-pools/${EXISTING}/networks" | jq -c \'(.elements // .) | if type == "array" then . else error("unrecognised networks response") end\')',
              'for TYPE in $(jq -r \'.networks[].type\' network-pool.json); do',
              '  NID=$(jq -r --arg t "$TYPE" \'[.[] | select(.type == $t)] | if length == 1 then .[0].id else empty end\' <<<"$NETS")',
              '  [[ -n "$NID" ]] || { echo "Refusing: pool ${POOL} has no single ${TYPE} network." >&2; exit 1; }',
              '  SUBNET=$(jq -r --arg t "$TYPE" \'.[] | select(.type == $t) | .subnet\' <<<"$NETS")',
              '  WANT=$(jq -r --arg t "$TYPE" \'.networks[] | select(.type == $t) | .subnet\' network-pool.json)',
              '  [[ "$SUBNET" == "$WANT" ]] || { echo "Refusing: ${TYPE} in ${POOL} is ${SUBNET}, not ${WANT}. A range must sit in the network it is added to." >&2; exit 1; }',
              '  for R in $(jq -c --arg t "$TYPE" \'.networks[] | select(.type == $t) | .ipPools[]\' network-pool.json); do',
              '    if (( DRY_RUN )); then echo "DRY RUN: would POST /v1/network-pools/${EXISTING}/networks/${NID}/ip-pools ${R}"; continue; fi',
              '    api POST "/v1/network-pools/${EXISTING}/networks/${NID}/ip-pools" --data "$R" >/dev/null',
              '    echo "  ${TYPE}: added ${R}"',
              '  done',
              'done',
              'if (( DRY_RUN )); then echo "Dry run: nothing was changed."; fi',
            ]),
        '',
      ].join('\n');

      const files                         = { 'pool-report.sh': report, 'crontab.txt': `# ${base}: daily network pool capacity. The login comes from the mode-600 password file.\n15 7 * * * cd /opt/vcf-automation/${base} && ${scheduledEnv('sddc-manager')} ./pool-report.sh >> /var/log/vcf-automation/${base}.log 2>&1\n` };
      if (mode !== 'report') {
        files['network-pool.json'] = json(body);
        files['network-pool.sh'] = apply;
      }
      files['IMPORT.md'] = sddcImport(
        mode === 'report' ? 'Nothing is imported: pool-report.sh reads the pools.' : 'network-pool.json is the NetworkPool body of POST /v1/network-pools (name, networks[type, vlanId, mtu, subnet, mask, gateway, ipPools[start, end]]).',
        [
          mode !== 'report' ? { heading: mode === 'create' ? 'Create the pool' : 'Add the ranges', lines: [`\`./network-pool.sh\` (add \`--dry-run\` first). In the interface: Inventory > Network Settings > Network Pool${mode === 'create' ? ' > Create Network Pool' : ' > the pool > Edit'}.`] } : undefined,
          { heading: 'Watch the free addresses', lines: ['Install the line in crontab.txt with `crontab -e`; it runs `pool-report.sh`, which only reads.'] },
        ],
        ['VERIFY: the IPv6 form of a network (subnet with the prefix length in mask); the ip-pools sub-resource path used to add a range; freeIps/usedIps on GET .../networks.'],
      );

      return {
        platform: PLATFORM,
        title: mode === 'report' ? 'Report network pool capacity' : mode === 'create' ? `Create network pool ${pool}` : `Add ranges to network pool ${pool}`,
        effect: mode === 'report' ? 'read' : 'reversible',
        trigger: mode === 'report' ? { kind: 'schedule', detail: 'Daily, from a scheduler outside SDDC Manager.', worstCase: 'once a day' } : { kind: 'manual', detail: 'Run by hand before hosts are commissioned into the pool.', worstCase: 'once per run' },
        scope: {
          what: mode === 'report' ? 'Every network pool in this SDDC Manager. Reads only.' : `Network pool ${pool}: ${rows.map((r) => `${r.type} ${r.subnet}`).join(', ') || 'no networks'}.`,
          decidedBy: [mode === 'report' ? 'GET /v1/network-pools and each pool’s networks.' : `The pool named ${pool}, matched exactly; ${mode === 'create' ? 'refused if it exists' : 'refused unless it exists with a network of each type listed, in the same subnet'}.`],
          ifWrong: 'Hosts commissioned from a pool with the wrong VLAN or subnet cannot reach each other over vMotion or storage, which the host validation at commissioning does not always catch.',
        },
        guardrails:
          mode === 'report'
            ? []
            : [
                { rule: 'Every range is checked against its subnet and gateway before anything is generated', because: 'A range outside its subnet is accepted and hands hosts addresses they cannot use.' },
                { rule: mode === 'create' ? 'Refuses to create a pool whose name exists' : 'Refuses a range for a network whose subnet differs', because: mode === 'create' ? 'Two pools of one name make every later commission ambiguous.' : 'A range has to be in the network it is added to.' },
                { rule: 'Refuses while another SDDC Manager task runs', because: 'A commission in flight is allocating addresses from the pools.' },
                { rule: 'Applies when run; --dry-run previews', because: 'The body can be read before it is sent.' },
              ],
        dryRun: mode === 'report' ? ['pool-report.sh only reads.'] : ['network-pool.sh --dry-run prints the body and the paths it would call.'],
        undo: mode === 'report' ? ['Nothing to undo.'] : [mode === 'create' ? 'DELETE /v1/network-pools/{id} while no host uses it (Inventory > Network Settings > Network Pool > Delete).' : 'DELETE /v1/network-pools/{id}/networks/{networkId}/ip-pools with the same {start, end}, while no host holds an address from it.'],
        told: [...(webhook ? [`${webhook}, when a network runs low.`] : []), 'SDDC Manager records the change.'],
        requires: ['An SDDC Manager account with the ADMIN role.', 'The VLANs trunked to every host that will be commissioned from the pool, with the MTU end to end.', 'jq and bash 4.'],
        files,
        notes: [
          'Confirmed: GET/POST /v1/network-pools with networks of type VMOTION, VSAN, NFS (ISCSI from 5.x), each with vlanId, mtu, subnet, mask, gateway and ipPools (SDDC Manager API reference).',
          'Hosts get their vMotion and storage vmkernel addresses from the pool when they are commissioned (fleet_host_commission) — size each range for every host that will use the pool, plus the ones you will add later.',
          'The Terraform page has the declarative form (vcf_network_pool in the vcf_commission_hosts scenario).',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_domain_create',
    platform: PLATFORM,
    label: 'Create a workload domain: vCenter, NSX and first cluster (SDDC Manager)',
    group: 'Workload domains',
    description:
      'Deploy a VI workload domain: its vCenter (size, network, SSO — join the management SSO domain or a new isolated one), a new NSX Manager cluster or one shared with another domain, and the first cluster from commissioned hosts with its VDS (LACP from 9.1), host TEPs and principal storage. SDDC Manager validates the whole spec first; the domain is created only when every check passed.',
    inputs: [
      { id: 'domain_name', label: 'Domain name', control: 'text', default: 'wld01', hint: '3–20 characters, letters, digits and dash' },
      { id: 'org_name', label: 'Organization name', control: 'text', default: 'Example' },
      {
        id: 'sso',
        label: 'SSO',
        control: 'select',
        options: [
          { value: 'join', label: 'Join the management SSO domain' },
          { value: 'isolated', label: 'New isolated SSO domain' },
        ],
        default: 'join',
      },
      { id: 'sso_domain', label: 'Isolated SSO domain name', control: 'text', default: 'wld01.local', showWhen: { input: 'sso', equals: ['isolated'] } },
      { id: 'vc_name', label: 'vCenter VM name', control: 'text', default: 'vcenter-wld01', section: 'vCenter' },
      { id: 'vc_fqdn', label: 'vCenter FQDN', control: 'text', default: 'vcenter-wld01.example.com', section: 'vCenter' },
      { id: 'vc_ip', label: 'vCenter IP', control: 'text', default: '10.0.10.20', hint: 'IPv4 or IPv6', section: 'vCenter' },
      { id: 'gateway', label: 'Management gateway', control: 'text', default: '10.0.10.1', hint: 'vCenter and NSX Managers', section: 'vCenter' },
      { id: 'mask', label: 'Management subnet mask or prefix', control: 'text', default: '255.255.255.0', hint: '255.255.255.0, or 64 for IPv6', section: 'vCenter' },
      { id: 'datacenter', label: 'Datacenter name', control: 'text', default: 'wld01-dc01', section: 'vCenter' },
      { id: 'vc_size', label: 'vCenter size', control: 'select', options: VC_SIZES.map((s) => ({ value: s, label: s })), default: 'small', section: 'vCenter' },
      { id: 'vc_storage', label: 'vCenter storage size', control: 'select', options: VC_STORAGE.map((s) => ({ value: s, label: s })), blankLabel: 'Default', section: 'vCenter' },
      {
        id: 'nsx',
        label: 'NSX',
        control: 'select',
        options: [
          { value: 'new', label: 'Deploy a new NSX Manager cluster' },
          { value: 'join', label: 'Share the NSX Manager of another workload domain' },
        ],
        default: 'new',
      },
      { id: 'nsx_vip', label: 'NSX Manager VIP', control: 'text', default: '10.0.10.30', showWhen: { input: 'nsx', equals: ['new'] }, section: 'NSX' },
      { id: 'nsx_vip_fqdn', label: 'NSX Manager VIP FQDN', control: 'text', default: 'nsx-wld01.example.com', hint: 'For join: the VIP FQDN of the NSX Manager cluster to share', section: 'NSX' },
      { id: 'nsx_nodes', label: 'NSX Manager nodes', control: 'textarea', default: 'nsx-wld01a | nsx-wld01a.example.com | 10.0.10.31\nnsx-wld01b | nsx-wld01b.example.com | 10.0.10.32\nnsx-wld01c | nsx-wld01c.example.com | 10.0.10.33', hint: 'name | FQDN | IP', showWhen: { input: 'nsx', equals: ['new'] }, section: 'NSX' },
      { id: 'nsx_size', label: 'NSX Manager size', control: 'select', options: NSX_SIZES.map((s) => ({ value: s, label: s })), default: 'medium', showWhen: { input: 'nsx', equals: ['new'] }, section: 'NSX' },
      {
        id: 'first_cluster',
        label: 'First cluster',
        control: 'select',
        options: [
          { value: 'with', label: 'Create the first cluster with the domain' },
          { value: 'without', label: 'Domain only — add clusters later (VERIFY on your release)' },
        ],
        default: 'with',
      },
      { id: 'cluster_name', label: 'Cluster name', control: 'text', default: 'wld01-cl01', showWhen: { input: 'first_cluster', equals: ['with'] } },
      ...clusterInputs({ input: 'first_cluster', equals: ['with'] }),
    ],
    automation: (values                 , name        )             => {
      const domain = str(values, 'domain_name', 'wld01');
      const sso = str(values, 'sso', 'join');
      const nsxMode = str(values, 'nsx', 'new');
      const withCluster = str(values, 'first_cluster', 'with') === 'with';
      const clusterName = str(values, 'cluster_name', `${domain}-cl01`);
      const vcFqdn = str(values, 'vc_fqdn', '');
      const vcIp = str(values, 'vc_ip', '');
      const gateway = str(values, 'gateway', '');
      const mask = str(values, 'mask', '255.255.255.0');
      const vipFqdn = str(values, 'nsx_vip_fqdn', '');
      const vip = str(values, 'nsx_vip', '');
      const base = slugOf(name || `domain-${domain}`, 'domain');
      const findings            = [];

      if (!/^[A-Za-z0-9-]{3,20}$/.test(domain)) findings.push(error('fleet.domain.name', `Domain name "${domain}" must be 3–20 letters, digits or dashes.`, { source: SRC }));
      if (!vcFqdn.includes('.')) findings.push(error('fleet.domain.vc-fqdn', 'The vCenter needs a fully qualified name with forward and reverse DNS.', { source: SRC }));
      if (!isIp(vcIp)) findings.push(error('fleet.domain.vc-ip', `vCenter IP "${vcIp}" is not an address.`, { source: SRC }));
      if (!isIp(gateway)) findings.push(error('fleet.domain.gateway', `Gateway "${gateway}" is not an address.`, { source: SRC }));
      const prefix = prefixOf(mask);
      const family = familyOf(vcIp);
      if (prefix === null || (family === 4 && prefix > 32) || (family === 6 && prefix > 128)) findings.push(error('fleet.domain.mask', `"${mask}" is not a subnet mask or prefix length.`, { source: SRC }));
      else if (isIp(vcIp) && isIp(gateway) && !containsAny(`${vcIp}/${prefix}`, gateway)) findings.push(error('fleet.domain.gateway-subnet', `The gateway ${gateway} is not in the vCenter subnet ${vcIp}/${prefix}.`, { source: SRC }));
      if (family === 6) findings.push(warning('fleet.domain.ipv6', 'An IPv6 management address. VCF 9.1 supports IPv6 for management components; VERIFY that the SDDC Manager 9.1 domain API takes IPv6 in networkDetailsSpec (prefix length in subnetMask) before relying on it.', { source: SRC }));
      if (sso === 'isolated') findings.push(info('fleet.domain.isolated-sso', 'An isolated SSO domain gives the workload domain its own identity boundary; it is not in the management vCenter’s Enhanced Linked Mode and needs its own identity provider configuration.', { source: SRC }));

      const nodes = tableRows(str(values, 'nsx_nodes', ''), 3).map(([nodeName = '', fqdn = '', ip = '']) => ({ nodeName, fqdn, ip }));
      if (nsxMode === 'new') {
        if (nodes.length !== 3) findings.push(error('fleet.domain.nsx-nodes', `A new NSX Manager cluster is three nodes; ${nodes.length} listed.`, { source: SRC }));
        for (const node of nodes) {
          if (!isIp(node.ip) || !node.fqdn.includes('.')) findings.push(error('fleet.domain.nsx-node', `NSX node "${node.nodeName}" needs an FQDN and an IP address.`, { source: SRC }));
          else if (prefix !== null && familyOf(node.ip) === family && !containsAny(`${vcIp}/${prefix}`, node.ip)) findings.push(warning('fleet.domain.nsx-subnet', `NSX node ${node.fqdn} (${node.ip}) is not in the vCenter subnet; the spec uses one gateway and mask for both.`, { source: SRC }));
        }
        if (!isIp(vip)) findings.push(error('fleet.domain.nsx-vip', `NSX VIP "${vip}" is not an address.`, { source: SRC }));
        const ips = [vcIp, vip, ...nodes.map((n) => n.ip)];
        const dupes = ips.filter((ip, i) => ip && ips.indexOf(ip) !== i);
        if (dupes.length > 0) findings.push(error('fleet.domain.duplicate-ip', `Address used twice: ${[...new Set(dupes)].join(', ')}.`, { source: SRC }));
        if (str(values, 'nsx_size', 'medium') === 'small') findings.push(warning('fleet.domain.nsx-small', 'A small NSX Manager is for labs; production workload domains use medium or larger.', { source: SRC }));
      } else {
        findings.push(info('fleet.domain.nsx-join', 'Sharing an NSX Manager cluster ties this domain’s NSX upgrades to the other domain’s. All domains sharing it must be at the same VCF version.', { source: SRC }));
        if (!vipFqdn.includes('.')) findings.push(error('fleet.domain.nsx-join-fqdn', 'Give the VIP FQDN of the NSX Manager cluster to share.', { source: SRC }));
      }
      if (!withCluster) findings.push(warning('fleet.domain.no-cluster', 'A domain without a first cluster: VERIFY that your 9.1 build accepts a DomainCreationSpec without computeSpec. Older releases require one.', { source: SRC }));

      const plan = withCluster ? clusterPlan(values, clusterName, 'fleet.domain.cluster') : undefined;
      if (plan) findings.push(...plan.findings);
      const subnetMask = prefix === null ? mask : family === 4 ? maskOf(prefix) : String(prefix);
      const net = (ipAddress        , dnsName        ) => ({ ipAddress, dnsName, gateway, subnetMask });

      const vcStorage = str(values, 'vc_storage', '');
      const spec                          = {
        domainName: domain,
        orgName: str(values, 'org_name', ''),
        ...(sso === 'isolated' ? { ssoDomainSpec: { ssoDomainName: str(values, 'sso_domain', '') } } : {}),
        vcenterSpec: {
          name: str(values, 'vc_name', ''),
          networkDetailsSpec: net(vcIp, vcFqdn),
          datacenterName: str(values, 'datacenter', ''),
          vmSize: str(values, 'vc_size', 'small'),
          ...(vcStorage ? { storageSize: vcStorage } : {}),
        },
        ...(plan ? { computeSpec: { clusterSpecs: [plan.spec] } } : {}),
        nsxTSpec:
          nsxMode === 'new'
            ? { nsxManagerSpecs: nodes.map((node) => ({ name: node.nodeName, networkDetailsSpec: net(node.ip, node.fqdn) })), vip, vipFqdn, formFactor: str(values, 'nsx_size', 'medium') }
            : { vipFqdn },
      };

      const script = [
        ...sddcHead(`Create workload domain ${domain} (vCenter ${vcFqdn}${plan ? `, cluster ${clusterName}` : ''}).`, [
          'Validates the whole spec with SDDC Manager first, and creates the domain',
          'only when every check passed. --dry-run stops after the validation.',
          '',
          'Secrets, each a mode-600 file read into memory, never written or passed as an argument:',
          '  VC_ROOT_PASSWORD_FILE      root password of the new vCenter',
          ...(nsxMode === 'new' ? ['  NSX_ADMIN_PASSWORD_FILE    admin password of the new NSX Managers'] : []),
          ...(sso === 'isolated' ? ['  SSO_PASSWORD_FILE          administrator password of the new SSO domain'] : []),
        ]),
        ...parseArgs(),
        ': "${VC_ROOT_PASSWORD_FILE:?set VC_ROOT_PASSWORD_FILE to a mode-600 file}"; need_private "$VC_ROOT_PASSWORD_FILE"',
        ...(nsxMode === 'new' ? [': "${NSX_ADMIN_PASSWORD_FILE:?set NSX_ADMIN_PASSWORD_FILE to a mode-600 file}"; need_private "$NSX_ADMIN_PASSWORD_FILE"'] : ['NSX_ADMIN_PASSWORD_FILE=/dev/null']),
        ...(sso === 'isolated' ? [': "${SSO_PASSWORD_FILE:?set SSO_PASSWORD_FILE to a mode-600 file}"; need_private "$SSO_PASSWORD_FILE"'] : ['SSO_PASSWORD_FILE=/dev/null']),
        'if grep -q "<REQUIRED" domain-spec.json; then echo "domain-spec.json still has <REQUIRED> values." >&2; exit 1; fi',
        ...lifecycleGuard(),
        '',
        `DOMAIN=${sq(domain)}`,
        'if api GET /v1/domains | jq -e --arg n "$DOMAIN" \'any(.elements[]?; .name == $n)\' >/dev/null; then',
        '  echo "Refusing: a workload domain named ${DOMAIN} already exists." >&2; exit 1',
        'fi',
        '',
        '# DNS first: SDDC Manager refuses names without forward and reverse records,',
        '# but says so only after a long validation.',
        `for NAME in ${[vcFqdn, ...(nsxMode === 'new' ? [vipFqdn, ...nodes.map((n) => n.fqdn)] : [])].filter(Boolean).map(sq).join(' ')}; do`,
        '  getent ahosts "$NAME" >/dev/null || { echo "Refusing: ${NAME} does not resolve from here." >&2; exit 1; }',
        'done',
        ...(plan ? ['', ...resolveHosts(str(values, 'network_pool', ''))] : ['HOST_IDS=\'[]\'']),
        '',
        '# The spec, with host ids and secrets added in memory.',
        'build() {',
        '  jq --arg mask "$1" --argjson ids "$HOST_IDS" --slurpfile h hosts.json \\',
        '     --rawfile vc "$VC_ROOT_PASSWORD_FILE" --rawfile nsx "$NSX_ADMIN_PASSWORD_FILE" --rawfile sso "$SSO_PASSWORD_FILE" \'',
        '    def secret($s): if $mask == "mask" then "********" else ($s | rtrimstr("\\n")) end;',
        '    .vcenterSpec.rootPassword = secret($vc)',
        ...(nsxMode === 'new' ? ['    | .nsxTSpec.nsxManagerAdminPassword = secret($nsx)'] : []),
        ...(sso === 'isolated' ? ['    | .ssoDomainSpec.ssoDomainPassword = secret($sso)'] : []),
        ...(plan ? [`    | .computeSpec.clusterSpecs[0].hostSpecs = ${HOST_SPECS_JQ}`] : []),
        '  \' domain-spec.json',
        '}',
        '',
        '# 1. Validate. Not optional, and the dry run: it deploys nothing.',
        'VAL=$(build send | api POST /v1/domains/validations --data-binary @- | jq -r \'.id // empty\')',
        '[[ -n "$VAL" ]] || { echo "The validation was not accepted." >&2; exit 1; }',
        'echo "Validation ${VAL}:"',
        'if ! wait_validation "/v1/domains/validations/${VAL}"; then echo "Validation did not succeed. Nothing was deployed." >&2; exit 1; fi',
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: validation passed. The spec (secrets masked):"; build mask | jq .',
        '  echo "Nothing was deployed. Run it without --dry-run to create the domain."',
        '  exit 0',
        'fi',
        '',
        '# 2. Create. Several hours: vCenter, NSX and the cluster are deployed in turn.',
        'TASK=$(build send | api POST /v1/domains --data-binary @- | jq -r \'.id // empty\')',
        '[[ -n "$TASK" ]] || { echo "The domain request was sent but no task id came back; check SDDC Manager > Tasks before re-running." >&2; exit 1; }',
        'echo "Domain task ${TASK}"',
        'wait_task "$TASK" && RC=0 || RC=$?',
        'if (( RC != 0 )); then exit 1; fi',
        'api GET /v1/domains | jq -r --arg n "$DOMAIN" \'.elements[]? | select(.name == $n) | "Domain \\(.name) \\(.id) \\(.status // "")"\'',
        '',
      ].join('\n');

      const files                         = {
        'domain-spec.json': json(spec),
        'create-domain.sh': script,
        'hosts.json': json(plan?.hosts ?? []),
        'IMPORT.md': sddcImport(
          'domain-spec.json is the DomainCreationSpec of POST /v1/domains and /v1/domains/validations without its secrets or host ids; create-domain.sh adds the vCenter root, NSX admin and SSO passwords from their mode-600 files and the ids of the hosts in hosts.json, in memory.',
          [
            { heading: 'Commission the hosts', lines: ['Into the network pool named here: fleet_network_pool, then fleet_host_commission.'] },
            { heading: 'Validate, then create', lines: ['`./create-domain.sh --dry-run` validates only; `./create-domain.sh` validates and creates. In the interface: Workload Domains > + Workload Domain > VI – Workload Domain, which runs the same validation.'] },
          ],
          [
            'VERIFY for 9.1: ssoDomainSpec (isolated SSO); a shared NSX given by vipFqdn alone; a DomainCreationSpec without computeSpec; lagSpecs on vdsSpecs with vmNics uplinks named lag1-0, lag1-1; advancedOptions (highAvailability, evcMode); IPv6 in networkDetailsSpec. License keys are not sent: VCF 9 licenses through VCF Operations.',
          ],
        ),
      };

      return {
        platform: PLATFORM,
        title: `Create workload domain ${domain}${plan ? ` with cluster ${clusterName} (${plan.hosts.length} hosts, ${plan.storage})` : ''}`,
        effect: 'irreversible',
        trigger: { kind: 'manual', detail: 'Run by hand in a change window, once the hosts are commissioned and DNS is in place.', worstCase: 'once per run: one vCenter, one NSX Manager cluster and every listed host' },
        scope: {
          what: `A new workload domain ${domain}: vCenter ${vcFqdn}, ${nsxMode === 'new' ? `a new NSX Manager cluster ${vipFqdn}` : `the shared NSX Manager ${vipFqdn}`}${plan ? `, and hosts ${plan.hosts.map((h) => h.fqdn).join(', ')}` : ''}.`,
          decidedBy: ['domain-spec.json as generated here.', ...(plan ? [`hosts.json, each host resolved by FQDN and refused unless UNASSIGNED_USEABLE${str(values, 'network_pool', '') ? ` in pool ${str(values, 'network_pool', '')}` : ''}.`] : []), 'SDDC Manager’s validation, which must pass.'],
          ifWrong: 'Hosts are wiped into a new cluster, and addresses and names are taken. Removing a domain deletes its vCenter and NSX and returns the hosts only after they are re-imaged.',
        },
        guardrails: [
          { rule: 'Always validates, and creates only if the validation succeeded', because: 'A domain that fails half way leaves a vCenter or NSX deployed with nothing to clean it up but a support case.' },
          { rule: 'Refuses a domain name that exists, a name that does not resolve, and any host not unassigned and usable in the named pool', because: 'These are the three failures that surface hours into a deployment.' },
          { rule: 'Refuses while another SDDC Manager task runs', because: 'Two workload domain operations at once lock resources against each other.' },
          { rule: 'Passwords are read from mode-600 files into memory; the dry run prints the spec with them masked', because: 'The vCenter root and NSX admin passwords are the keys to the domain.' },
        ],
        dryRun: ['create-domain.sh --dry-run runs SDDC Manager’s validation — which connects to the hosts and checks DNS, addresses and the spec — and deploys nothing.'],
        undo: ['There is no undo short of removing the domain: DELETE /v1/domains/{id} after PATCH {markForDeletion: true} (Workload Domains > the domain > Delete). The vCenter and NSX Manager VMs are deleted and the hosts must be re-imaged before reuse.'],
        told: ['SDDC Manager records the validation and the domain task.', 'The change record, which should name the domain.'],
        requires: [
          'An SDDC Manager account with the ADMIN role.',
          'Forward and reverse DNS for the vCenter and every NSX name.',
          ...(plan ? [`At least ${plan.hosts.length} hosts commissioned into ${str(values, 'network_pool', 'the network pool')}, at the ESX build the domain’s image expects.`] : []),
          'The passwords in mode-600 files, from your vault.',
          'jq, getent and bash 4.',
        ],
        files,
        notes: [
          'Confirmed shape (SDDC Manager API reference, DomainCreationSpec): domainName, orgName, vcenterSpec {name, networkDetailsSpec {ipAddress, dnsName, gateway, subnetMask}, rootPassword, datacenterName, vmSize, storageSize}, computeSpec.clusterSpecs[] {name, hostSpecs[] {id, hostNetworkSpec.vmNics[] {id, vdsName, uplink}}, datastoreSpec, networkSpec {vdsSpecs[] {name, portGroupSpecs[] {name, transportType}}, nsxClusterSpec.nsxTClusterSpec {geneveVlanId, ipAddressPoolSpec}}}, nsxTSpec {nsxManagerSpecs[], vip, vipFqdn, nsxManagerAdminPassword, formFactor}.',
          'The Terraform page has the declarative equivalent (vcf_workload_domain scenario). Use one or the other for a given domain: Terraform will try to undo a change made here.',
          'Clusters after the first: fleet_cluster. Edge clusters are on the Terraform page (vcf_edge_cluster).',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_cluster',
    platform: PLATFORM,
    label: 'Add, expand or shrink a cluster (SDDC Manager)',
    group: 'Workload domains',
    description:
      'Add a cluster to a workload domain (hosts from the commissioned pool, VDS and uplink mapping with optional LACP, host TEPs, vSAN ESA or OSA, NFS, VMFS on FC or vVols), expand a cluster with more hosts, or shrink one by removing hosts. Every change is validated by SDDC Manager first, and a shrink refuses to take a cluster below what its storage and HA need.',
    inputs: [
      {
        id: 'mode',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'create', label: 'Add a new cluster to a domain' },
          { value: 'expand', label: 'Expand a cluster with hosts' },
          { value: 'shrink', label: 'Shrink a cluster: remove hosts' },
        ],
        default: 'create',
      },
      { id: 'domain_name', label: 'Workload domain', control: 'text', default: 'wld01' },
      { id: 'cluster_name', label: 'Cluster', control: 'text', default: 'wld01-cl02' },
      { id: 'min_hosts', label: 'Never shrink below (hosts)', control: 'number', default: 3, min: 1, max: 64, showWhen: { input: 'mode', equals: ['shrink'] } },
      { id: 'force', label: 'Force removal of a host that is disconnected', control: 'toggle', default: false, showWhen: { input: 'mode', equals: ['shrink'] } },
      ...clusterInputs({ input: 'mode', equals: ['create'] }, { input: 'mode', notEquals: ['shrink'] }),
    ],
    automation: (values                 , name        )             => {
      const mode = str(values, 'mode', 'create');
      const domain = str(values, 'domain_name', 'wld01');
      const clusterName = str(values, 'cluster_name', 'wld01-cl02');
      const minHosts = num(values, 'min_hosts', 3);
      const force = bool(values, 'force', false);
      const pool = str(values, 'network_pool', '');
      const base = slugOf(name || `cluster-${mode}-${clusterName}`, 'cluster');
      const plan = clusterPlan(values, clusterName, 'fleet.cluster', mode === 'create');
      const findings            = mode === 'shrink' ? plan.findings.filter((f) => /no-hosts|duplicate-host|not-fqdn/.test(f.code)) : mode === 'expand' ? plan.findings.filter((f) => !/vsan-min|vsan-headroom|tep|nfs|esa-dedup|one-host|vvol/.test(f.code)) : plan.findings;
      if (mode === 'shrink') {
        if (minHosts < 2) findings.push(warning('fleet.cluster.min-one', 'Allowing a shrink to one host removes vSphere HA from the cluster.', { source: SRC }));
        if (force) findings.push(warning('fleet.cluster.force', 'Force removes a host SDDC Manager cannot reach; its VMs are not evacuated and its vSAN data is not migrated.', { remediation: 'Use it only for a host that is already dead.', source: SRC }));
        if (plan.hosts.length > 1) findings.push(info('fleet.cluster.shrink-many', `${plan.hosts.length} hosts leave in one operation: vSAN data is evacuated from each, and the cluster runs with less capacity until it finishes.`, { source: SRC }));
      }

      const clusterId = [
        `DOMAIN=${sq(domain)}`,
        `CLUSTER=${sq(clusterName)}`,
        'DOMAIN_ID=$(api GET /v1/domains | jq -r --arg n "$DOMAIN" \'[.elements[]? | select(.name == $n)] | if length == 1 then .[0].id else empty end\')',
        '[[ -n "$DOMAIN_ID" ]] || { echo "Refusing: no single workload domain named ${DOMAIN}." >&2; exit 1; }',
        'CLUSTER_ID=$(api GET /v1/clusters | jq -r --arg n "$CLUSTER" --arg d "$DOMAIN_ID" \'[.elements[]? | select(.name == $n and ((.domain.id // $d) == $d))] | if length == 1 then .[0].id else empty end\')',
      ];

      let body          ;
      if (mode === 'create') {
        body = [
          ...clusterId,
          '[[ -z "$CLUSTER_ID" ]] || { echo "Refusing: ${CLUSTER} already exists in ${DOMAIN}. Use expand." >&2; exit 1; }',
          'if grep -q "<REQUIRED" cluster-spec.json; then echo "cluster-spec.json still has <REQUIRED> values." >&2; exit 1; fi',
          ...resolveHosts(pool),
          'build() {',
          `  jq --arg d "$DOMAIN_ID" --argjson ids "$HOST_IDS" --slurpfile h hosts.json '{domainId: $d, computeSpec: {clusterSpecs: [ .hostSpecs = ${HOST_SPECS_JQ} ]}}' cluster-spec.json`,
          '}',
          'VAL=$(build | api POST /v1/clusters/validations --data-binary @- | jq -r \'.id // empty\')',
          '[[ -n "$VAL" ]] || { echo "The validation was not accepted." >&2; exit 1; }',
          'echo "Validation ${VAL}:"',
          'wait_validation "/v1/clusters/validations/${VAL}" || { echo "Validation did not succeed. Nothing was changed." >&2; exit 1; }',
          'if (( DRY_RUN )); then echo "DRY RUN: validation passed:"; build | jq .; echo "Nothing was changed."; exit 0; fi',
          'TASK=$(build | api POST /v1/clusters --data-binary @- | jq -r \'.id // empty\')',
        ];
      } else if (mode === 'expand') {
        body = [
          ...clusterId,
          '[[ -n "$CLUSTER_ID" ]] || { echo "Refusing: no cluster ${CLUSTER} in ${DOMAIN}." >&2; exit 1; }',
          ...resolveHosts(pool),
          '# The VDS the new hosts join is the cluster’s own; hosts.json names it for each vmnic.',
          'build() {',
          `  jq -n --argjson ids "$HOST_IDS" --slurpfile h hosts.json '{clusterExpansionSpec: {hostSpecs: ${HOST_SPECS_JQ}}}'`,
          '}',
          'VAL=$(build | api POST "/v1/clusters/${CLUSTER_ID}/validations" --data-binary @- | jq -r \'.id // empty\')',
          '[[ -n "$VAL" ]] || { echo "The validation was not accepted." >&2; exit 1; }',
          'wait_validation "/v1/clusters/validations/${VAL}" || { echo "Validation did not succeed. Nothing was changed." >&2; exit 1; }',
          'if (( DRY_RUN )); then echo "DRY RUN: validation passed:"; build | jq .; echo "Nothing was changed."; exit 0; fi',
          'TASK=$(build | api PATCH "/v1/clusters/${CLUSTER_ID}" --data-binary @- | jq -r \'.id // empty\')',
        ];
      } else {
        body = [
          ...clusterId,
          '[[ -n "$CLUSTER_ID" ]] || { echo "Refusing: no cluster ${CLUSTER} in ${DOMAIN}." >&2; exit 1; }',
          `MIN_HOSTS=${minHosts}`,
          'IN_CLUSTER=$(api GET /v1/hosts | jq -c --arg c "$CLUSTER_ID" \'[.elements[]? | select(.cluster.id == $c) | {id, fqdn}]\')',
          'REMOVE=$(jq -c --argjson in "$IN_CLUSTER" \'[ .[].fqdn as $f | ([ $in[] | select((.fqdn | ascii_downcase) == ($f | ascii_downcase)) ][0]) // {fqdn: $f, id: null} ]\' hosts.json)',
          'NOTIN=$(jq -r \'.[] | select(.id == null) | .fqdn\' <<<"$REMOVE")',
          'if [[ -n "$NOTIN" ]]; then echo "Refusing: not in ${CLUSTER}: ${NOTIN//$\'\\n\'/, }" >&2; exit 1; fi',
          'HAVE=$(jq length <<<"$IN_CLUSTER"); GO=$(jq length <<<"$REMOVE")',
          'if (( HAVE - GO < MIN_HOSTS )); then echo "Refusing: ${CLUSTER} has ${HAVE} hosts; removing ${GO} leaves $(( HAVE - GO )), below ${MIN_HOSTS}." >&2; exit 1; fi',
          `build() { jq -n --argjson r "$REMOVE" '{clusterCompactionSpec: {hosts: [ $r[] | {id, fqdn} ], force: ${force}}}'; }`,
          'VAL=$(build | api POST "/v1/clusters/${CLUSTER_ID}/validations" --data-binary @- | jq -r \'.id // empty\')',
          '[[ -n "$VAL" ]] || { echo "The validation was not accepted." >&2; exit 1; }',
          'wait_validation "/v1/clusters/validations/${VAL}" || { echo "Validation did not succeed. Nothing was changed." >&2; exit 1; }',
          'if (( DRY_RUN )); then echo "DRY RUN: validation passed; would remove $(jq -r \'[.[].fqdn] | join(", ")\' <<<"$REMOVE") from ${CLUSTER}. Nothing was changed."; exit 0; fi',
          'TASK=$(build | api PATCH "/v1/clusters/${CLUSTER_ID}" --data-binary @- | jq -r \'.id // empty\')',
        ];
      }

      const verb = mode === 'create' ? `Add cluster ${clusterName} to ${domain}` : mode === 'expand' ? `Expand ${clusterName} with ${plan.hosts.length} host(s)` : `Remove ${plan.hosts.length} host(s) from ${clusterName}`;
      const script = [
        ...sddcHead(`${verb}.`, ['Validates with SDDC Manager first; --dry-run stops after the validation.']),
        ...parseArgs(),
        ...lifecycleGuard(),
        ...body,
        '[[ -n "$TASK" ]] || { echo "The request was sent but no task id came back; check SDDC Manager > Tasks before re-running." >&2; exit 1; }',
        'echo "Task ${TASK}"',
        'wait_task "$TASK" && RC=0 || RC=$?',
        'if (( RC != 0 )); then exit 1; fi',
        ...(mode === 'shrink' ? ['echo "Removed. The hosts are back in the free pool; decommission them with fleet_host_decommission if they are leaving VCF."'] : []),
        '',
      ].join('\n');

      const files                         = {
        'cluster.sh': script,
        'hosts.json': json(plan.hosts),
        'IMPORT.md': sddcImport(
          mode === 'create'
            ? 'cluster-spec.json is the ClusterSpec that goes into ClusterCreationSpec.computeSpec.clusterSpecs of POST /v1/clusters; cluster.sh wraps it with the domain id and fills hostSpecs with the ids of the hosts in hosts.json.'
            : mode === 'expand'
              ? 'cluster.sh sends a ClusterUpdateSpec with clusterExpansionSpec.hostSpecs, built from hosts.json and the host ids, to PATCH /v1/clusters/{id}.'
              : 'cluster.sh sends a ClusterUpdateSpec with clusterCompactionSpec.hosts, the hosts in hosts.json resolved in the cluster, to PATCH /v1/clusters/{id}.',
          [{ heading: 'Validate, then apply', lines: [`\`./cluster.sh --dry-run\` validates only; \`./cluster.sh\` validates and applies. In the interface: Workload Domains > ${domain} > Clusters > ${mode === 'create' ? 'Add Cluster' : mode === 'expand' ? `${clusterName} > Add Host` : `${clusterName} > Hosts > Remove`}.`] }],
          ['VERIFY: the result path of a cluster update validation (read here at /v1/clusters/validations/{id}); lagSpecs and lag uplink names on 9.1; vvolDatastoreSpecs fields; clusterCompactionSpec.force.'],
        ),
      };
      if (mode === 'create') files['cluster-spec.json'] = json(plan.spec);

      return {
        platform: PLATFORM,
        title: verb,
        effect: mode === 'shrink' ? 'reversible' : 'irreversible',
        trigger: { kind: 'manual', detail: 'Run by hand in a change window.', worstCase: `once per run, ${plan.hosts.length} host(s)` },
        scope: {
          what: `${mode === 'create' ? 'A new cluster' : 'Cluster'} ${clusterName} in workload domain ${domain}: hosts ${plan.hosts.map((h) => h.fqdn).join(', ') || 'none'}.`,
          decidedBy: [
            `GET /v1/domains and /v1/clusters, matched by name ${domain} / ${clusterName}.`,
            mode === 'shrink' ? 'hosts.json, each host refused unless it is in that cluster.' : `hosts.json, each host refused unless UNASSIGNED_USEABLE${pool ? ` in pool ${pool}` : ''}.`,
            'SDDC Manager’s validation, which must pass.',
          ],
          ifWrong: mode === 'shrink' ? 'The cluster loses capacity and, for vSAN, the data on the removed hosts is moved to the rest — a cluster already near full can run out.' : 'Hosts are added to the wrong cluster; taking them back out is a shrink and, to reuse them elsewhere, a decommission and a re-image.',
        },
        guardrails: [
          { rule: 'Always validates, and applies only if the validation succeeded', because: 'The validation finds wrong VLANs, a bad vmnic mapping or an incompatible host before anything moves.' },
          ...(mode === 'shrink'
            ? [
                { rule: `Refuses to leave fewer than ${minHosts} hosts`, because: 'vSAN needs 2×FTT+1 hosts and HA needs two; a shrink past that is an outage on the next failure.' },
                { rule: 'Refuses a host that is not in the cluster', because: 'A typo should not remove a different host.' },
              ]
            : [{ rule: 'Refuses any host not unassigned and usable in the named pool', because: 'A host from another pool has vMotion and storage addresses the cluster cannot reach.' }]),
          { rule: 'Refuses while another SDDC Manager task runs', because: 'Cluster changes during an upgrade or another domain operation lock each other.' },
        ],
        dryRun: ['cluster.sh --dry-run runs SDDC Manager’s validation and changes nothing.'],
        undo: mode === 'shrink' ? ['Expand the cluster again with the same hosts (mode expand), while they are still commissioned.'] : mode === 'expand' ? ['Shrink the cluster by the same hosts (mode shrink).'] : ['Delete the cluster: PATCH /v1/clusters/{id} {markForDeletion: true}, then DELETE /v1/clusters/{id}. Its hosts must be re-imaged before reuse.'],
        told: ['SDDC Manager records the validation and the task.'],
        requires: ['An SDDC Manager account with the ADMIN role.', ...(mode === 'shrink' ? ['Room in the rest of the cluster for the VMs and vSAN data on the hosts being removed.'] : ['The hosts commissioned into the network pool, with the physical NICs named cabled to the VDS uplinks (and in a port channel, for LACP).']), 'jq and bash 4.'],
        files,
        notes: [
          'Confirmed: POST /v1/clusters and /v1/clusters/validations (ClusterCreationSpec {domainId, computeSpec.clusterSpecs}); PATCH /v1/clusters/{id} and POST /v1/clusters/{id}/validations with ClusterUpdateSpec (clusterExpansionSpec.hostSpecs, clusterCompactionSpec.hosts) — SDDC Manager API reference.',
          'The Terraform page has the declarative form (vcf_add_cluster scenario).',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_host_decommission',
    platform: PLATFORM,
    label: 'Decommission ESX hosts (SDDC Manager)',
    group: 'Hosts',
    description:
      'Take hosts out of SDDC Manager’s inventory when they are leaving VCF. Only hosts that are commissioned and not in any cluster are accepted — a host still in a cluster has to be removed from it first (fleet_cluster, shrink) — and each host’s record is saved before it goes, so it can be commissioned again with the same pool and storage type.',
    inputs: [
      { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'esx09.example.com\nesx10.example.com', hint: 'One FQDN per line' },
      { id: 'max_hosts', label: 'Refuse above (hosts)', control: 'number', default: 4, min: 1, max: 64 },
    ],
    automation: (values                 , name        )             => {
      const hosts = linesOf(str(values, 'hosts', ''));
      const max = num(values, 'max_hosts', 4);
      const base = slugOf(name || 'decommission-hosts', 'decommission-hosts');
      const findings            = [];
      if (hosts.length === 0) findings.push(error('fleet.decommission.none', 'No hosts are listed.', { source: SRC }));
      if (hosts.length > max) findings.push(error('fleet.decommission.too-many', `${hosts.length} hosts listed, above the cap of ${max}.`, { source: SRC }));
      const short = hosts.filter((h) => !h.includes('.'));
      if (short.length > 0) findings.push(warning('fleet.decommission.not-fqdn', `Not fully qualified: ${short.join(', ')}.`, { source: SRC }));

      const script = [
        ...sddcHead(`Decommission ${hosts.length} ESX host(s) from SDDC Manager.`, [
          'Only hosts that are commissioned and in no cluster. Each host record is saved',
          'to hosts-before-<time>.json first. --dry-run lists what would go and stops.',
        ]),
        ...parseArgs(),
        ...lifecycleGuard(),
        `MAX=${max}`,
        'ALL=$(api GET /v1/hosts | jq -c \'if (.elements | type) == "array" then .elements else error("no elements array in GET /v1/hosts") end\')',
        'SEL=$(jq -c --argjson all "$ALL" \'[ .[] as $f | ([ $all[] | select((.fqdn // "" | ascii_downcase) == ($f | ascii_downcase)) ][0]) // {fqdn: $f, status: "NOT COMMISSIONED"} ]\' hosts.json)',
        'BAD=$(jq -r \'.[] | select(.id == null or (.status // "") == "ASSIGNED" or .cluster.id != null or .domain.id != null) | "  \\(.fqdn): \\(.status // "?")\\(if .cluster.id then " in a cluster" else "" end)"\' <<<"$SEL")',
        'if [[ -n "$BAD" ]]; then echo "Refusing: these hosts are not commissioned-and-unassigned (remove them from their cluster first):" >&2; echo "$BAD" >&2; exit 1; fi',
        'COUNT=$(jq length <<<"$SEL")',
        'if (( COUNT > MAX )); then echo "Refusing: ${COUNT} hosts is above the cap of ${MAX}." >&2; exit 1; fi',
        'jq -r \'.[] | "  \\(.fqdn)  \\(.status)  pool \\(.networkPool.name // "?")  \\(.storageType // "")"\' <<<"$SEL"',
        'if (( DRY_RUN )); then echo "DRY RUN: would decommission the ${COUNT} host(s) above. Nothing was changed."; exit 0; fi',
        'STAMP=$(date +%Y%m%d-%H%M%S)',
        'jq . <<<"$SEL" > "hosts-before-${STAMP}.json"',
        'echo "Host records saved to hosts-before-${STAMP}.json"',
        'TASK=$(jq -c \'[.[] | {fqdn}]\' <<<"$SEL" | api DELETE /v1/hosts --data-binary @- | jq -r \'.id // empty\')',
        '[[ -n "$TASK" ]] || { echo "The request was sent but no task id came back; check SDDC Manager > Tasks." >&2; exit 1; }',
        'wait_task "$TASK" && RC=0 || RC=$?',
        'if (( RC != 0 )); then exit 1; fi',
        'echo "Decommissioned. Re-image a host before commissioning it again."',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Decommission ${hosts.length} ESX host${hosts.length === 1 ? '' : 's'}`,
        effect: 'irreversible',
        trigger: { kind: 'manual', detail: 'Run by hand when hosts leave VCF, after they are out of every cluster.', worstCase: `once per run, at most ${max} hosts` },
        scope: {
          what: `Exactly the hosts listed: ${hosts.join(', ') || 'none'}.`,
          decidedBy: ['hosts.json, each host matched by FQDN in GET /v1/hosts.', 'Refused unless commissioned and in no cluster or domain.', `Refused above ${max} hosts.`],
          ifWrong: 'A host that was meant to stay leaves SDDC Manager and must be re-imaged and commissioned again before it can be used.',
        },
        guardrails: [
          { rule: 'Only hosts in no cluster', because: 'A host in a cluster carries VMs and vSAN data; it has to be removed through a cluster shrink, which evacuates it.' },
          { rule: `Refuses above ${max} hosts`, because: 'A list pasted from the wrong place should stop the run.' },
          { rule: 'Saves each host’s record before it goes', because: 'The pool and storage type are what commissioning it again needs.' },
          { rule: 'Refuses while another SDDC Manager task runs', because: 'A domain operation in flight may be about to use one of these hosts.' },
        ],
        dryRun: ['decommission.sh --dry-run lists the hosts and their state and changes nothing.'],
        undo: ['Re-image the host at the domain’s ESX build and commission it again (fleet_host_commission), with the pool and storage type in hosts-before-<time>.json.'],
        told: ['SDDC Manager records the decommission task.'],
        requires: ['An SDDC Manager account with the ADMIN role.', 'jq and bash 4.'],
        files: {
          'decommission.sh': script,
          'hosts.json': json(hosts),
          'IMPORT.md': sddcImport('hosts.json lists the FQDNs; decommission.sh sends them as the HostDecommissionSpec array ([{fqdn}]) of DELETE /v1/hosts.', [
            { heading: 'Decommission', lines: ['`./decommission.sh --dry-run` first, then `./decommission.sh`. In the interface: Inventory > Hosts > select > Decommission.'] },
          ], ['VERIFY: the DELETE /v1/hosts body on your release; newer builds may also take the host ids.']),
        },
        notes: [`${base}: the SDDC Manager API decommissions with DELETE /v1/hosts and a body naming each FQDN, returning a task.`],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_vcf_import',
    platform: PLATFORM,
    label: 'Import an existing vCenter into VCF (VCF Import)',
    group: 'Workload domains',
    description:
      'Bring an existing vSphere environment under VCF: check it, precheck it, then import its vCenter as a VI workload domain (or, for a new instance, convert it into the management domain), optionally deploying NSX with it. Runs the VCF Import tool on SDDC Manager in the order it has to run; each step stops the next when it fails, and --dry-run stops after the precheck.',
    inputs: [
      {
        id: 'operation',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'import', label: 'Import as a VI workload domain' },
          { value: 'convert', label: 'Convert into the management domain (new VCF instance)' },
          { value: 'sync', label: 'Sync SDDC Manager with changes made in vCenter after import' },
        ],
        default: 'import',
      },
      { id: 'vcenter', label: 'vCenter FQDN', control: 'text', default: 'vcenter-legacy01.example.com' },
      { id: 'sso_user', label: 'vCenter SSO user', control: 'text', default: 'administrator@vsphere.local' },
      { id: 'domain_name', label: 'Workload domain name', control: 'text', default: 'wld-legacy01', showWhen: { input: 'operation', equals: ['import'] } },
      {
        id: 'nsx',
        label: 'NSX',
        control: 'select',
        options: [
          { value: 'deploy', label: 'Deploy NSX with the import' },
          { value: 'none', label: 'Import without NSX (add it later)' },
        ],
        default: 'deploy',
        showWhen: { input: 'operation', notEquals: ['sync'] },
      },
      { id: 'nsx_vip', label: 'NSX VIP | FQDN', control: 'text', default: '10.0.20.30 | nsx-legacy01.example.com', showWhen: { input: 'nsx', equals: ['deploy'] } },
      { id: 'nsx_nodes', label: 'NSX Manager nodes', control: 'textarea', default: 'nsx-legacy01a | nsx-legacy01a.example.com | 10.0.20.31\nnsx-legacy01b | nsx-legacy01b.example.com | 10.0.20.32\nnsx-legacy01c | nsx-legacy01c.example.com | 10.0.20.33', hint: 'name | FQDN | IP', showWhen: { input: 'nsx', equals: ['deploy'] } },
      { id: 'nsx_size', label: 'NSX Manager size', control: 'select', options: NSX_SIZES.map((s) => ({ value: s, label: s })), default: 'medium', showWhen: { input: 'nsx', equals: ['deploy'] } },
      { id: 'nsx_gateway', label: 'NSX gateway | mask', control: 'text', default: '10.0.20.1 | 255.255.255.0', showWhen: { input: 'nsx', equals: ['deploy'] } },
      { id: 'tool_dir', label: 'VCF Import tool directory on SDDC Manager', control: 'text', default: '/home/vcf/vcf-import-tool', hint: 'Where the tool bundle was extracted' },
      { id: 'ssh_user', label: 'SSH user on SDDC Manager', control: 'text', default: 'vcf' },
    ],
    automation: (values                 , name        )             => {
      const operation = str(values, 'operation', 'import');
      const vcenter = str(values, 'vcenter', '');
      const ssoUser = str(values, 'sso_user', 'administrator@vsphere.local');
      const domain = str(values, 'domain_name', '');
      const nsx = operation === 'sync' ? 'none' : str(values, 'nsx', 'deploy');
      const toolDir = str(values, 'tool_dir', '/home/vcf/vcf-import-tool');
      const sshUser = str(values, 'ssh_user', 'vcf');
      const base = slugOf(name || `vcf-import-${operation}`, 'vcf-import');
      const findings            = [];
      if (!vcenter.includes('.')) findings.push(error('fleet.import.vcenter', 'Give the vCenter FQDN.', { source: SRC }));
      if (operation === 'import' && !/^[A-Za-z0-9-]{3,20}$/.test(domain)) findings.push(error('fleet.import.domain', `Domain name "${domain}" must be 3–20 letters, digits or dashes.`, { source: SRC }));
      if (/^root$/.test(sshUser)) findings.push(warning('fleet.import.root', 'SSH to SDDC Manager as vcf and elevate only if the tool asks; root SSH is disabled by default.', { source: SRC }));
      const [vip = '', vipFqdn = ''] = str(values, 'nsx_vip', '').split('|').map((s) => s.trim());
      const [nsxGw = '', nsxMask = ''] = str(values, 'nsx_gateway', '').split('|').map((s) => s.trim());
      const nodes = tableRows(str(values, 'nsx_nodes', ''), 3).map(([nodeName = '', fqdn = '', ip = '']) => ({ nodeName, fqdn, ip }));
      if (nsx === 'deploy') {
        if (nodes.length !== 3) findings.push(error('fleet.import.nsx-nodes', `NSX is deployed as three managers; ${nodes.length} listed.`, { source: SRC }));
        if (!isIp(vip) || !vipFqdn.includes('.')) findings.push(error('fleet.import.nsx-vip', 'Give the NSX VIP as "address | FQDN".', { source: SRC }));
        if (!isIp(nsxGw)) findings.push(error('fleet.import.nsx-gateway', 'Give the NSX gateway as "address | mask".', { source: SRC }));
      }
      if (operation === 'convert') findings.push(warning('fleet.import.convert', 'Convert makes this vCenter the management domain of a new VCF instance: the SDDC Manager appliance must already be deployed into that vCenter, and every host must meet the VCF 9.1 requirements (vLCM images, supported storage, no standard switches carrying VMkernel traffic that VCF must own).', { source: SRC }));
      findings.push(info('fleet.import.prompts', 'The tool asks for the vCenter SSO password (and the NSX passwords) itself at run time; none is written here.', { source: SRC }));

      const nsxSpec = {
        form_factor: str(values, 'nsx_size', 'medium'),
        cluster_ip: vip,
        cluster_fqdn: vipFqdn,
        nsx_manager_specs: nodes.map((node) => ({ hostname: node.fqdn, ip_address: node.ip, gateway: nsxGw, subnet_mask: nsxMask })),
      };

      const cmd = operation === 'sync' ? 'sync' : operation;
      const script = [
        '#!/usr/bin/env bash',
        `# VCF Import: ${operation} ${vcenter} through the VCF Import tool on SDDC Manager.`,
        '#',
        `#   ./vcf-import.sh            check, precheck, then ${cmd}`,
        '#   ./vcf-import.sh --dry-run  check and precheck only; change nothing',
        '#',
        '# The tool runs on SDDC Manager (SDDC_HOST) over SSH with a terminal, so it can',
        '# ask for the SSO and NSX passwords itself; none is on this machine or in a file.',
        'set -euo pipefail',
        ...parseArgs(),
        ': "${SDDC_HOST:?set SDDC_HOST to the SDDC Manager FQDN}"',
        `SSH_TARGET=${sq(`${sshUser}@`)}"\${SDDC_HOST}"`,
        `TOOL_DIR=${sq(toolDir)}`,
        `VC=${sq(vcenter)}`,
        `SSO_USER=${sq(ssoUser)}`,
        ...(operation === 'import' ? [`DOMAIN=${sq(domain)}`] : []),
        'run() {',
        '  echo "== vcf_brownfield.py $*"',
        '  ssh -t "$SSH_TARGET" "cd $(printf %q "$TOOL_DIR") && python3 vcf_brownfield.py $(printf "%q " "$@")"',
        '}',
        ...(nsx === 'deploy'
          ? [
              '# The NSX deployment spec goes to SDDC Manager first; it holds no password.',
              'scp nsx-deployment-spec.json "${SSH_TARGET}:${TOOL_DIR}/nsx-deployment-spec.json"',
            ]
          : []),
        '',
        ...(operation === 'sync'
          ? [
              'run precheck --vcenter "$VC" --sso-user "$SSO_USER" || { echo "Precheck failed; nothing was synced." >&2; exit 1; }',
              'if (( DRY_RUN )); then echo "DRY RUN: precheck passed. Nothing was synced."; exit 0; fi',
              'run sync --vcenter "$VC" --sso-user "$SSO_USER"',
            ]
          : [
              '# 1. check: can this vCenter be imported at all (versions, topology, storage).',
              'run check --vcenter "$VC" --sso-user "$SSO_USER" || { echo "Check failed; read the report above. Nothing was imported." >&2; exit 1; }',
              '# 2. precheck: the detailed guardrails, per host and per cluster.',
              'run precheck --vcenter "$VC" --sso-user "$SSO_USER" || { echo "Precheck failed; nothing was imported." >&2; exit 1; }',
              'if (( DRY_RUN )); then echo "DRY RUN: check and precheck passed. Nothing was imported."; exit 0; fi',
              `# 3. ${cmd}.`,
              `run ${cmd} --vcenter "$VC" --sso-user "$SSO_USER"${operation === 'import' ? ' --domain-name "$DOMAIN"' : ''}${nsx === 'deploy' ? ' --nsx-deployment-spec-path "${TOOL_DIR}/nsx-deployment-spec.json"' : ' --skip-nsx-deployment'}`,
            ]),
        'echo "Done. The domain shows in SDDC Manager > Workload Domains and, after the next collection, in VCF Operations > Fleet management."',
        '',
      ].join('\n');

      const files                         = { 'vcf-import.sh': script };
      if (nsx === 'deploy') files['nsx-deployment-spec.json'] = json(nsxSpec);
      files['IMPORT.md'] = sddcImport(
        `vcf-import.sh runs the VCF Import tool (vcf_brownfield.py) on SDDC Manager: check, precheck, then ${cmd}.${nsx === 'deploy' ? ' nsx-deployment-spec.json is the tool’s NSX deployment spec; it holds no password — the tool asks for them.' : ''}`,
        [
          { heading: 'Put the tool on SDDC Manager', lines: [`Download the VCF Import tool bundle for your release from the Broadcom support portal and extract it to ${toolDir} as ${sshUser}.`] },
          { heading: 'Check and precheck', lines: ['`./vcf-import.sh --dry-run`. Fix everything the precheck reports; it is the list of what would fail the import.'] },
          { heading: operation === 'sync' ? 'Sync' : 'Import', lines: ['`./vcf-import.sh`. In 9.1 the same import is started from SDDC Manager > Workload Domains > Import (VERIFY the menu on your build).'] },
        ],
        ['VERIFY: the tool name, its subcommands (check, precheck, convert, import, sync) and flags (--vcenter, --sso-user, --domain-name, --nsx-deployment-spec-path, --skip-nsx-deployment) and the NSX spec keys against the VCF Import tool guide for 9.1: they are carried from the documented 5.2/9.0 tool.'],
        ['VCF Import tool guide (techdocs.broadcom.com, "Converting or Importing Existing vSphere Environments into VMware Cloud Foundation").'],
      );

      return {
        platform: PLATFORM,
        title: operation === 'sync' ? `Sync SDDC Manager with ${vcenter}` : operation === 'convert' ? `Convert ${vcenter} into a VCF management domain` : `Import ${vcenter} as workload domain ${domain}`,
        effect: operation === 'sync' ? 'reversible' : 'irreversible',
        trigger: { kind: 'manual', detail: 'Run by hand in a change window; the tool asks for passwords at a terminal.', worstCase: 'once per vCenter' },
        scope: {
          what: `vCenter ${vcenter} and every cluster and host it manages${nsx === 'deploy' ? `, plus a new NSX Manager cluster ${vipFqdn}` : ''}.`,
          decidedBy: [`The vCenter named, ${vcenter}: the tool imports everything it manages.`, 'The tool’s check and precheck, which must pass.'],
          ifWrong: 'An imported vCenter is managed by SDDC Manager from then on — upgrades, passwords and certificates go through VCF. There is no supported way to un-import it.',
        },
        guardrails: [
          { rule: 'check, then precheck, then the operation; each stops the next when it fails', because: 'The precheck is the list of what would fail half way through an import.' },
          { rule: 'Passwords are typed into the tool, never written here', because: 'The SSO administrator password opens every host in the environment.' },
          { rule: '--dry-run stops after the precheck', because: 'The report can be read and fixed before anything changes.' },
        ],
        dryRun: ['vcf-import.sh --dry-run runs check and precheck only.'],
        undo: operation === 'sync' ? ['A sync only updates SDDC Manager’s view; run it again after correcting vCenter.'] : ['None supported. Take a file-based backup of vCenter (and SDDC Manager) before the import; restoring both is the only way back.'],
        told: ['SDDC Manager records the import task; the tool writes its log in its directory on SDDC Manager.'],
        requires: ['SSH access to SDDC Manager as the vcf user, with the VCF Import tool extracted there.', 'vCenter and hosts at versions the tool supports for import into VCF 9.1.', ...(nsx === 'deploy' ? ['Forward and reverse DNS for the NSX VIP and managers.'] : [])],
        files,
        notes: ['Import brings existing vSphere into VCF without rebuilding it. After import, workload domain operations (fleet_cluster, fleet_domain_create for new domains) and 9.1 fleet management apply to it like any other domain.'],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'fleet_avi_deploy',
    platform: PLATFORM,
    label: 'Deploy an Avi Load Balancer controller cluster (SDDC Manager)',
    group: 'Load balancing',
    description:
      'Deploy a three-node Avi Load Balancer controller cluster for a workload domain through SDDC Manager, validated first. The vSphere Supervisor, the Avi vCenter cloud and Service Engine groups are built on the Terraform page (vsphere_supervisor, avi_vcenter_cloud); this is the controller cluster underneath them.',
    inputs: [
      { id: 'domain_name', label: 'Workload domain', control: 'text', default: 'wld01' },
      { id: 'cluster_fqdn', label: 'Controller cluster FQDN', control: 'text', default: 'avi-wld01.example.com' },
      { id: 'cluster_ip', label: 'Controller cluster VIP', control: 'text', default: '10.0.10.40', hint: 'IPv4 or IPv6' },
      { id: 'nodes', label: 'Controller nodes', control: 'textarea', default: 'avi-wld01a.example.com | 10.0.10.41\navi-wld01b.example.com | 10.0.10.42\navi-wld01c.example.com | 10.0.10.43', hint: 'FQDN | IP' },
      { id: 'form_factor', label: 'Controller size', control: 'select', options: [{ value: 'SMALL', label: 'Small (8 vCPU, 24 GB)' }, { value: 'MEDIUM', label: 'Medium (16 vCPU, 32 GB)' }, { value: 'LARGE', label: 'Large (24 vCPU, 48 GB)' }], default: 'MEDIUM' },
      { id: 'version', label: 'Avi version', control: 'text', default: '', hint: 'Empty: the version SDDC Manager offers for this domain' },
    ],
    automation: (values                 , name        )             => {
      const domain = str(values, 'domain_name', 'wld01');
      const clusterFqdn = str(values, 'cluster_fqdn', '');
      const clusterIp = str(values, 'cluster_ip', '');
      const version = str(values, 'version', '');
      const nodes = tableRows(str(values, 'nodes', ''), 2).map(([fqdn = '', ip = '']) => ({ fqdn, ip }));
      const base = slugOf(name || `avi-${domain}`, 'avi');
      const findings            = [];
      if (nodes.length !== 3) findings.push(error('fleet.avi.nodes', `An Avi controller cluster is three nodes; ${nodes.length} listed.`, { source: SRC }));
      for (const node of nodes) if (!isIp(node.ip) || !node.fqdn.includes('.')) findings.push(error('fleet.avi.node', `Controller "${node.fqdn}" needs an FQDN and an IP address.`, { source: SRC }));
      if (!isIp(clusterIp)) findings.push(error('fleet.avi.vip', `Cluster VIP "${clusterIp}" is not an address.`, { source: SRC }));
      const ips = [clusterIp, ...nodes.map((n) => n.ip)];
      if (new Set(ips).size !== ips.length) findings.push(error('fleet.avi.duplicate-ip', 'The VIP and the node addresses must all differ.', { source: SRC }));
      if (familyOf(clusterIp) === 6) findings.push(warning('fleet.avi.ipv6', 'IPv6 controller addresses: Avi supports them; VERIFY that SDDC Manager 9.1 deploys an IPv6 controller cluster.', { source: SRC }));
      if (str(values, 'form_factor', 'MEDIUM') === 'SMALL') findings.push(info('fleet.avi.small', 'Small controllers suit up to a few hundred virtual services; a Supervisor with many namespaces grows past that.', { source: SRC }));

      const spec = {
        clusterName: clusterFqdn.split('.')[0] ?? clusterFqdn,
        clusterFqdn,
        clusterIpAddress: clusterIp,
        formFactor: str(values, 'form_factor', 'MEDIUM'),
        ...(version ? { version } : {}),
        domainIds: ['__DOMAIN_ID__'],
        nodes: nodes.map((node) => ({ ipAddress: node.ip, fqdn: node.fqdn })),
      };

      const script = [
        ...sddcHead(`Deploy the Avi Load Balancer controller cluster ${clusterFqdn} for ${domain}.`, [
          'Needs AVI_ADMIN_PASSWORD_FILE: a mode-600 file with the controller admin password.',
          'Validates with SDDC Manager first; --dry-run stops after the validation.',
        ]),
        ...parseArgs(),
        ': "${AVI_ADMIN_PASSWORD_FILE:?set AVI_ADMIN_PASSWORD_FILE to a mode-600 file}"; need_private "$AVI_ADMIN_PASSWORD_FILE"',
        ...lifecycleGuard(),
        `DOMAIN=${sq(domain)}`,
        'DOMAIN_ID=$(api GET /v1/domains | jq -r --arg n "$DOMAIN" \'[.elements[]? | select(.name == $n)] | if length == 1 then .[0].id else empty end\')',
        '[[ -n "$DOMAIN_ID" ]] || { echo "Refusing: no single workload domain named ${DOMAIN}." >&2; exit 1; }',
        'if api GET /v1/nsx-alb-clusters 2>/dev/null | jq -e --arg d "$DOMAIN_ID" \'any((.elements // [])[]; (.domainIds // []) | index($d))\' >/dev/null; then',
        '  echo "Refusing: ${DOMAIN} already has an Avi controller cluster." >&2; exit 1',
        'fi',
        'build() { jq --arg d "$DOMAIN_ID" --arg mask "$1" --rawfile p "$AVI_ADMIN_PASSWORD_FILE" \'.domainIds = [$d] | .adminPassword = (if $mask == "mask" then "********" else ($p | rtrimstr("\\n")) end)\' avi-cluster-spec.json; }',
        'VAL=$(build send | api POST /v1/nsx-alb-clusters/validations --data-binary @- | jq -r \'.id // empty\')',
        '[[ -n "$VAL" ]] || { echo "The validation was not accepted." >&2; exit 1; }',
        'wait_validation "/v1/nsx-alb-clusters/validations/${VAL}" || { echo "Validation did not succeed. Nothing was deployed." >&2; exit 1; }',
        'if (( DRY_RUN )); then echo "DRY RUN: validation passed:"; build mask | jq .; echo "Nothing was deployed."; exit 0; fi',
        'TASK=$(build send | api POST /v1/nsx-alb-clusters --data-binary @- | jq -r \'.id // empty\')',
        '[[ -n "$TASK" ]] || { echo "No task id came back; check SDDC Manager > Tasks." >&2; exit 1; }',
        'wait_task "$TASK" && RC=0 || RC=$?',
        'if (( RC != 0 )); then exit 1; fi',
        'echo "Controller cluster deployed. Next: the vCenter cloud and Service Engine group (Terraform page, avi_vcenter_cloud), then the Supervisor (vsphere_supervisor)."',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Deploy Avi Load Balancer controllers ${clusterFqdn} for ${domain}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Run by hand once per workload domain that needs Avi.', worstCase: 'once per run: three controller VMs' },
        scope: {
          what: `Three Avi controller VMs (${nodes.map((n) => n.fqdn).join(', ')}) in workload domain ${domain}, clustered behind ${clusterFqdn}.`,
          decidedBy: [`GET /v1/domains matched by name ${domain}.`, 'Refused if the domain already has a controller cluster.', 'SDDC Manager’s validation, which must pass.'],
          ifWrong: 'Controller VMs and addresses in the wrong domain; remove the cluster through SDDC Manager and deploy again.',
        },
        guardrails: [
          { rule: 'Always validates, and deploys only if the validation succeeded', because: 'A half-formed controller cluster is harder to remove than to never deploy.' },
          { rule: 'One controller cluster per domain', because: 'A second one would split the Supervisor’s and VCF Automation’s view of the load balancer.' },
          { rule: 'The admin password is read from a mode-600 file; the dry run masks it', because: 'The Avi admin controls every virtual service in the domain.' },
        ],
        dryRun: ['avi-deploy.sh --dry-run validates and prints the spec with the password masked.'],
        undo: ['DELETE /v1/nsx-alb-clusters/{id} (SDDC Manager > Workload Domains > the domain > Avi Load Balancer > Delete), once no Supervisor or virtual service uses it.'],
        told: ['SDDC Manager records the validation and the deployment task.'],
        requires: ['An SDDC Manager account with the ADMIN role.', 'The Avi bundle downloaded in SDDC Manager (or a depot configured).', 'Forward and reverse DNS for the cluster FQDN and every node.', 'jq and bash 4.'],
        files: {
          'avi-cluster-spec.json': json(spec),
          'avi-deploy.sh': script,
          'IMPORT.md': sddcImport(
            'avi-cluster-spec.json is the controller cluster spec of POST /v1/nsx-alb-clusters without the admin password (avi-deploy.sh adds it from its mode-600 file, and the domain id, in memory).',
            [
              { heading: 'Validate, then deploy', lines: ['`./avi-deploy.sh --dry-run`, then `./avi-deploy.sh`. In the interface: Workload Domains > the domain > Actions > Deploy Avi Load Balancer (VERIFY the menu on your build).'] },
              { heading: 'Then the cloud, Service Engines and Supervisor', lines: ['On the Terraform page: avi_vcenter_cloud (vCenter cloud and Service Engine group) and vsphere_supervisor (Supervisor activation, namespaces and VM classes).'] },
            ],
            ['VERIFY: /v1/nsx-alb-clusters and its validations path and body fields (clusterName, clusterFqdn, clusterIpAddress, formFactor, adminPassword, domainIds, nodes) on 9.1 — carried from the 5.2 SDDC Manager API, where Avi was named NSX Advanced Load Balancer; the form factor sizes.'],
          ),
        },
        notes: [
          'Supervisor activation and the Avi cloud and Service Engine groups are already on the Terraform page — vsphere_supervisor (vsphere provider) and avi_vcenter_cloud (avi provider) — and are not repeated here.',
          `${base}: VCF Automation’s Avi self-service for namespaces (9.1) sits on top of this controller cluster; see the VCF Automation 9.1 blueprints.`,
        ],
        findings,
      };
    },
  }),
];

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
import { parseCidr, parseIPv4, cidrsOverlap, formatCidr, usableAddresses } from '../core/net.js';
import {
  SDDC_SPEC_REQUIRED_KEYS,
  REMOVED_IN_91_KEYS,
  PLACEHOLDER_SECRET,
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

                                  
                                                              
                                  
                                                                            
                                       
 

function vlanOf(spec                 )         {
  return typeof spec.vlanId === 'string' ? Number(spec.vlanId) : spec.vlanId;
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
        if (parseIPv4(ns) === null) {
          findings.push(
            error('vcf.spec.invalid-nameserver', `"${ns}" is not a valid IPv4 address.`, {
              path: `dnsSpec.nameservers[${i}]`,
            }),
          );
        }
      });
    }
  }

  // --- NTP -----------------------------------------------------------------
  if (Array.isArray(spec.ntpServers)) {
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

  networks.forEach((net, i) => {
    const at = `networkSpecs[${i}]`;

    if (seenTypes.has(net.networkType)) {
      findings.push(
        error('vcf.spec.duplicate-network-type', `Duplicate networkType "${net.networkType}".`, {
          path: at,
        }),
      );
    }
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

    if (net.subnet !== undefined && parseCidr(net.subnet) === null) {
      findings.push(
        error('vcf.spec.invalid-subnet', `"${net.subnet}" is not a valid CIDR.`, {
          path: `${at}.subnet`,
        }),
      );
    }

    if (net.gateway !== undefined && parseIPv4(net.gateway) === null) {
      findings.push(
        error('vcf.spec.invalid-gateway', `"${net.gateway}" is not a valid IPv4 address.`, {
          path: `${at}.gateway`,
        }),
      );
    }

    // A gateway outside its own subnet is a classic copy-paste error that the
    // installer only catches late, during bring-up.
    const cidr = net.subnet ? parseCidr(net.subnet) : null;
    const gw = net.gateway ? parseIPv4(net.gateway) : null;
    if (cidr && gw !== null) {
      const masked = parseCidr(`${net.gateway}/${cidr.prefix}`);
      if (masked && masked.network !== cidr.network) {
        findings.push(
          error(
            'vcf.spec.gateway-outside-subnet',
            `Gateway ${net.gateway} is not inside ${formatCidr(cidr)}.`,
            { path: `${at}.gateway` },
          ),
        );
      }
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
    // Overlapping subnets on different VLANs will route unpredictably.
    for (let i = 0; i < networks.length; i += 1) {
      for (let j = i + 1; j < networks.length; j += 1) {
        const a = networks[i]                   ;
        const b = networks[j]                   ;
        const ca = a.subnet ? parseCidr(a.subnet) : null;
        const cb = b.subnet ? parseCidr(b.subnet) : null;
        if (ca && cb && vlanOf(a) !== vlanOf(b) && cidrsOverlap(ca, cb)) {
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
      if (host.hostname.includes('.')) {
        findings.push(
          warning(
            'vcf.spec.host-fqdn-not-short-name',
            `hostSpecs expects a short name; "${host.hostname}" looks like an FQDN and the subdomain is appended automatically.`,
            { path: `${at}.hostname`, source: 'VCF Installer API — SddcHostSpec' },
          ),
        );
      } else if (!RFC1123_LABEL.test(host.hostname)) {
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
  const mgmt = networks.find((n) => n.networkType === 'MANAGEMENT');
  if (mgmt?.subnet && hosts.length > 0) {
    const cidr = parseCidr(mgmt.subnet);
    if (cidr) {
      const available = usableAddresses(cidr);
      const needed = hosts.length + VCFMS_MIN_IPS + AUTOMATION_IP_COUNT + 12;
      if (available < needed) {
        findings.push(
          error(
            'vcf.spec.management-subnet-too-small',
            `Management subnet ${mgmt.subnet} has ${available} usable addresses but this design needs roughly ${needed}.`,
            {
              path: 'networkSpecs[MANAGEMENT].subnet',
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

    if (Array.isArray(spec.vcfOperationsSpec?.nodes) && spec.vcfOperationsSpec.nodes.length > 3) {
      findings.push(
        error(
          'vcf.spec.too-many-ops-nodes',
          `VCF Operations accepts at most 3 nodes; ${spec.vcfOperationsSpec.nodes.length} supplied.`,
          { path: 'vcfOperationsSpec.nodes', source: 'VCF Installer API — VcfOperationsSpec' },
        ),
      );
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

    const pool = vsp.ipv4Pool;
    if (pool) {
      const supplied = [pool.cidr, pool.ipRange, pool.addresses].filter((v) => v !== undefined);
      if (supplied.length === 0) {
        findings.push(
          error('vcf.spec.vsp-pool-empty', 'vspClusterSpec.ipv4Pool needs one of cidr, ipRange or addresses.', {
            path: 'vspClusterSpec.ipv4Pool',
          }),
        );
      }

      let count = 0;
      if (pool.addresses) count = pool.addresses.length;
      else if (pool.ipRange) {
        const start = parseIPv4(pool.ipRange.startIpAddress);
        const end = parseIPv4(pool.ipRange.endIpAddress);
        if (start !== null && end !== null && end >= start) count = end - start + 1;
      } else if (pool.cidr) {
        const cidr = parseCidr(pool.cidr);
        if (cidr) count = usableAddresses(cidr);
      }

      if (count > 0 && count < VCFMS_MIN_IPS) {
        findings.push(
          error(
            'vcf.spec.vcfms-pool-too-small',
            `VCF Management Services requires at least ${VCFMS_MIN_IPS} IP addresses; this pool provides ${count}.`,
            {
              path: 'vspClusterSpec.ipv4Pool',
              remediation: `${VCFMS_MIN_IPS} is a hard minimum; 30 is recommended.`,
              source: 'VCF 9.1 IP requirements / KB 440630',
            },
          ),
        );
      }
    }

    if (!vsp.fleetFqdn && !options.secondaryInstance) {
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
    if (Array.isArray(automation.ipPool) && automation.ipPool.length < AUTOMATION_IP_COUNT) {
      findings.push(
        error(
          'vcf.spec.automation-pool-too-small',
          `VCF Automation needs ${AUTOMATION_IP_COUNT} addresses (3 active plus 2 buffer); ${automation.ipPool.length} supplied.`,
          { path: 'vcfAutomationSpec.ipPool', source: 'VCF 9.1 IP requirements' },
        ),
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
    if (looksSecondary && spec.workflowType === 'VCF') {
      findings.push(
        error(
          'vcf.spec.secondary-needs-vcf-extend',
          'This looks like a secondary instance (no fleetFqdn, or Operations reuses an existing deployment) but workflowType is "VCF".',
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
    }
  }

  // --- licensing -----------------------------------------------------------
  if (!spec.licenseServerSpec) {
    findings.push(
      warning(
        'vcf.spec.no-license-server',
        'licenseServerSpec is absent. The centralized License Server is a mandatory component in 9.1 for both VCF and VVF.',
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

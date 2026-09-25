/**
 * Junos SRX security: zones, address books, security policies, source,
 * destination and static NAT, route-based IPsec VPNs and screens.
 *
 * The SRX order of operations drives the notes: screens, then static and
 * destination NAT, then route lookup, then the security policy — which is
 * matched against the translated destination address — then source NAT.
 * A policy written against the public address of a destination-NAT rule
 * never matches.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { isAnyNetwork, isIp, parseCidrAny } from '../../core/ip.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { listOf,                   } from '../device.js';
import { COMMIT_CONFIRMED, ident, ifl, interfaceFindings, logicals, PLATFORM, prefixes, prefixFindings, SECRET, SRC } from './junos-common.js';

const SERVICES = ['ping', 'traceroute', 'ssh', 'https', 'http', 'netconf', 'snmp', 'ntp', 'dns', 'dhcp', 'ike', 'telnet', 'all'];
const PROTOCOLS = ['bgp', 'ospf', 'ospf3', 'bfd', 'vrrp', 'all'];

/** "a/32" or "a" as a host prefix; null when it is not an address. */
function hostPrefix(value        )                {
  const c = parseCidrAny(value);
  return c ? `${c.address}/${c.prefix}` : null;
}

export const JUNOS_SECURITY                             = [
  deviceBlueprint({
    id: 'junos_security_zone',
    platform: PLATFORM,
    label: 'Security zone and host-inbound traffic',
    group: 'Security (SRX)',
    description: 'A security zone with its interfaces, and the services and routing protocols the SRX itself answers on them.',
    inputs: [
      { id: 'zone', label: 'Zone name', control: 'text', default: 'trust' },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'ge-0/0/1.0' },
      { id: 'services', label: 'System services', control: 'checklist', default: 'ping,ssh,https', options: SERVICES.map((s) => ({ value: s, label: s })) },
      { id: 'protocols', label: 'Routing protocols', control: 'checklist', default: '', options: PROTOCOLS.map((s) => ({ value: s, label: s })) },
    ],
    change: (values                 )               => {
      const zone = ident(str(values, 'zone', 'trust'), 'trust');
      const list = logicals(str(values, 'interfaces', ''));
      const services = listOf(str(values, 'services', '')).filter((s) => SERVICES.includes(s));
      const protocols = listOf(str(values, 'protocols', '')).filter((s) => PROTOCOLS.includes(s));
      const findings            = [...interfaceFindings(list)];
      const outside = /untrust|outside|internet|wan/i.test(zone);
      if (services.includes('all')) findings.push(warning('network.junos.all-services', `\`system-services all\` opens every management service in ${zone} — including telnet and FTP where they are enabled.`, SRC));
      if (services.includes('telnet')) findings.push(warning('network.junos.telnet', 'Telnet sends credentials in clear text. Use SSH.', SRC));
      if (outside && services.some((s) => ['ssh', 'https', 'http', 'snmp', 'netconf'].includes(s))) {
        findings.push(warning('network.junos.mgmt-outside', `Management services are open in ${zone}, which looks internet-facing. Manage the SRX from a trusted zone or the fxp0 port.`, SRC));
      }
      const z = `set security zones security-zone ${zone}`;

      return {
        platform: PLATFORM,
        title: `Security zone ${zone}`,
        impact: list.length > 0 ? 'brief' : 'none',
        notes: [
          COMMIT_CONFIRMED,
          'An interface in no zone drops everything. Moving an interface between zones drops its sessions, and traffic stops until a policy allows it.',
          'Host-inbound traffic set on an interface replaces the zone-level setting for that interface, it does not add to it: this sets it at the zone level.',
        ],
        findings,
        before: [`show security zones ${zone}`, `show configuration security zones security-zone ${zone} | display set`],
        config: [
          ...list.map((i) => `${z} interfaces ${i}`),
          ...services.map((s) => `${z} host-inbound-traffic system-services ${s === 'ping' ? 'ping' : s}`),
          ...protocols.map((p) => `${z} host-inbound-traffic protocols ${p}`),
          ...(list.length === 0 && services.length === 0 && protocols.length === 0 ? [`${z} description ${zone}`] : []),
        ],
        verify: [`show security zones ${zone} detail`, 'show interfaces terse | match "' + (list[0] ?? 'ge') + '"', ...(protocols.length > 0 ? ['show ospf neighbor', 'show bgp summary'] : [])],
        backout: [`delete security zones security-zone ${zone}`, 'commit  (fails while a policy or NAT rule still names the zone)'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_address_book',
    platform: PLATFORM,
    label: 'Address book entries and set',
    group: 'Security (SRX)',
    description: 'Named addresses in the global address book — prefixes or DNS names — and an address set that groups them for policies.',
    inputs: [
      { id: 'entries', label: 'Addresses', control: 'textarea', default: 'NET-USERS 10.10.0.0/16\nWEB-01 10.20.0.10/32\nWEB-02 10.20.0.11/32\nNET-USERS-V6 2001:db8:10::/48', hint: 'One per line: name, then a prefix or a DNS name' },
      { id: 'set_name', label: 'Address set', control: 'text', default: 'WEB-SERVERS', hint: 'Groups every entry except those starting NET-; empty for none' },
    ],
    change: (values                 )               => {
      const lines = str(values, 'entries', '')
        .split(/\n+/)
        .map((l) => l.trim())
        .filter(Boolean);
      const findings            = [];
      const entries                                                  = [];
      for (const line of lines) {
        const [rawName = '', value = ''] = line.split(/[\s=,]+/);
        const name = ident(rawName, '');
        const c = parseCidrAny(value);
        if (!name || !value) {
          findings.push(error('network.junos.bad-address-entry', `"${line}" is not "name prefix".`, SRC));
          continue;
        }
        if (c) entries.push({ name, value: `${c.network}/${c.prefix}`, dns: false });
        else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value) && !/^[\d.]+$/.test(value)) entries.push({ name, value, dns: true });
        else findings.push(error('network.junos.bad-address-entry', `"${value}" for ${name} is neither a prefix nor a DNS name.`, SRC));
        if (c && isAnyNetwork(value)) findings.push(warning('network.junos.any-address', `${name} is every address; policies already have \`any\` for that.`, SRC));
      }
      if (entries.length === 0) findings.push(error('network.junos.empty-address-book', 'No valid entries.', SRC));
      const setName = str(values, 'set_name', '') ? ident(str(values, 'set_name', ''), 'SET') : '';
      const members = entries.filter((e) => !e.name.startsWith('NET-'));
      const ab = 'set security address-book global';

      return {
        platform: PLATFORM,
        title: `Address book: ${entries.length} entries${setName ? ` and set ${setName}` : ''}`,
        impact: 'none',
        notes: [
          'Nothing uses these until a policy or NAT rule names them. A zone-attached address book and the global one cannot both be used on the same box.',
          ...(entries.some((e) => e.dns) ? ['A dns-name entry is resolved by the SRX itself and needs `system name-server`.'] : []),
        ],
        findings,
        before: ['show security address-book', 'show configuration security address-book | display set'],
        config: [
          ...entries.map((e) => `${ab} address ${e.name} ${e.dns ? `dns-name ${e.value}` : e.value}`),
          ...(setName && members.length > 0 ? members.map((e) => `${ab} address-set ${setName} address ${e.name}`) : []),
        ],
        verify: ['show security address-book', ...(setName ? [`show configuration security address-book global address-set ${setName}`] : [])],
        backout: [...(setName && members.length > 0 ? [`delete security address-book global address-set ${setName}`] : []), ...entries.map((e) => `delete security address-book global address ${e.name}`), 'commit  (fails while a policy still names an entry)'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_security_policy',
    platform: PLATFORM,
    label: 'Security policy',
    group: 'Security (SRX)',
    description: 'A zone-to-zone security policy: source and destination addresses, applications, the action, and session logging.',
    inputs: [
      { id: 'from_zone', label: 'From zone', control: 'text', default: 'trust' },
      { id: 'to_zone', label: 'To zone', control: 'text', default: 'dmz' },
      { id: 'name', label: 'Policy name', control: 'text', default: 'USERS-TO-WEB' },
      { id: 'source', label: 'Source addresses', control: 'text', default: 'NET-USERS', hint: 'Address-book names, or any' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: 'WEB-SERVERS' },
      { id: 'applications', label: 'Applications', control: 'text', default: 'junos-http, junos-https', hint: 'junos-https, junos-ssh … or any' },
      { id: 'action', label: 'Action', control: 'select', default: 'permit', options: [{ value: 'permit', label: 'Permit' }, { value: 'deny', label: 'Deny (silently)' }, { value: 'reject', label: 'Reject (send a reset)' }] },
      { id: 'log', label: 'Log at session close', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const from = ident(str(values, 'from_zone', 'trust'), 'trust');
      const to = ident(str(values, 'to_zone', 'untrust'), 'untrust');
      const name = ident(str(values, 'name', 'POLICY'), 'POLICY');
      const src = listOf(str(values, 'source', 'any'));
      const dst = listOf(str(values, 'destination', 'any'));
      const apps = listOf(str(values, 'applications', 'any'));
      const action = str(values, 'action', 'permit');
      const log = bool(values, 'log', true);
      const any = (l          ) => l.length === 0 || l.includes('any');
      const findings            = [];
      if (action === 'permit' && any(src) && any(dst)) {
        findings.push(
          warning('network.junos.permit-any', `The policy permits any source to any destination from ${from} to ${to}${any(apps) ? ', for any application' : ''}. That is a routed hole through the firewall.`, {
            remediation: 'Name the source and destination address-book entries and the applications.',
            ...SRC,
          }),
        );
      } else if (action === 'permit' && any(apps)) {
        findings.push(warning('network.junos.any-application', 'The policy permits any application. Name the ones that are needed.', SRC));
      }
      if (!log && action === 'permit') findings.push(warning('network.junos.no-logging', 'No session logging: there will be no record of what this policy allowed.', SRC));
      if (from === to) findings.push(warning('network.junos.intra-zone', `An intra-zone policy (${from} to ${from}); traffic within a zone is denied by default on the SRX, so this opens it.`, SRC));
      const p = `set security policies from-zone ${from} to-zone ${to} policy ${name}`;

      return {
        platform: PLATFORM,
        title: `Policy ${name}: ${from} to ${to} ${action}`,
        impact: action === 'permit' ? 'none' : 'brief',
        notes: [
          `A new policy goes at the end of the ${from} to ${to} list, after any broader policy that already matches. Move it with \`insert security policies from-zone ${from} to-zone ${to} policy ${name} before policy <name>\`.`,
          'Destination addresses are matched after destination NAT: use the internal address of a NATted server.',
          'Address names must exist in the address book (or the zone’s), and application names in `show configuration applications` or the junos- predefined set.',
        ],
        findings,
        before: [`show security policies from-zone ${from} to-zone ${to}`, `show security policies hit-count from-zone ${from} to-zone ${to}`],
        config: [
          ...(any(src) ? [`${p} match source-address any`] : src.map((s) => `${p} match source-address ${s}`)),
          ...(any(dst) ? [`${p} match destination-address any`] : dst.map((d) => `${p} match destination-address ${d}`)),
          ...(any(apps) ? [`${p} match application any`] : apps.map((a) => `${p} match application ${a}`)),
          `${p} then ${action}`,
          ...(log ? [`${p} then log session-close`] : []),
          `${p} then count`,
        ],
        verify: [`show security policies policy-name ${name} detail`, `show security policies hit-count from-zone ${from} to-zone ${to}`, `show security flow session policy-id <id from the line above>`],
        backout: [`delete security policies from-zone ${from} to-zone ${to} policy ${name}`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_source_nat',
    platform: PLATFORM,
    label: 'Source NAT (interface or pool)',
    group: 'Security (SRX)',
    description: 'Source NAT from one zone to another: hide internal addresses behind the egress interface address, or behind a pool of public addresses with proxy ARP.',
    inputs: [
      { id: 'from_zone', label: 'From zone', control: 'text', default: 'trust' },
      { id: 'to_zone', label: 'To zone', control: 'text', default: 'untrust' },
      { id: 'sources', label: 'Source prefixes', control: 'text', default: '10.10.0.0/16' },
      { id: 'mode', label: 'Translate to', control: 'select', default: 'interface', options: [{ value: 'interface', label: 'The egress interface address' }, { value: 'pool', label: 'A pool of addresses' }] },
      { id: 'pool_from', label: 'Pool first address', control: 'text', default: '203.0.113.10', showWhen: { input: 'mode', equals: ['pool'] } },
      { id: 'pool_to', label: 'Pool last address', control: 'text', default: '203.0.113.14', showWhen: { input: 'mode', equals: ['pool'] } },
      { id: 'proxy_arp_interface', label: 'Proxy ARP on', control: 'text', default: 'ge-0/0/0.0', hint: 'The outside interface, when the pool is in its subnet; empty for none', showWhen: { input: 'mode', equals: ['pool'] } },
    ],
    change: (values                 )               => {
      const from = ident(str(values, 'from_zone', 'trust'), 'trust');
      const to = ident(str(values, 'to_zone', 'untrust'), 'untrust');
      const nets = prefixes(str(values, 'sources', ''));
      const pool = str(values, 'mode', 'interface') === 'pool';
      const first = pool ? hostPrefix(str(values, 'pool_from', '')) : null;
      const last = pool ? hostPrefix(str(values, 'pool_to', '')) : null;
      const arp = pool ? str(values, 'proxy_arp_interface', '') : '';
      const rs = `${from}-to-${to}`;
      const poolName = `SNAT-${to}`;
      const findings            = [...prefixFindings('network.junos.bad-prefix', 'the source prefixes', nets.invalid)];
      if (nets.v4.length + nets.v6.length === 0) findings.push(error('network.junos.nat-no-source', 'No source prefixes to translate.', SRC));
      if (pool && (!first || !last)) findings.push(error('network.junos.bad-pool', 'The pool range is not two addresses.', SRC));
      if (arp) findings.push(...interfaceFindings([arp]));
      const r = `set security nat source rule-set ${rs}`;
      const range = first && last ? `${first} to ${last}` : '';

      return {
        platform: PLATFORM,
        title: `Source NAT ${from} to ${to} via ${pool ? `pool ${range}` : 'the interface'}`,
        impact: 'brief',
        notes: [
          'Source NAT is applied after the security policy: a policy must still permit the traffic.',
          'Rules in a rule-set are matched in order; a new rule goes last. Existing sessions keep their old translation until they close (`clear security flow session`).',
          ...(pool ? ['A pool in the outside interface subnet needs proxy ARP, or the upstream router never gets an answer for those addresses.'] : []),
        ],
        findings,
        before: ['show security nat source summary', `show security nat source rule-set ${rs}`],
        config: [
          ...(pool && range ? [`set security nat source pool ${poolName} address ${range}`] : []),
          `${r} from zone ${from}`,
          `${r} to zone ${to}`,
          ...[...nets.v4, ...nets.v6].map((n) => `${r} rule SNAT-1 match source-address ${n}`),
          `${r} rule SNAT-1 match destination-address ${nets.v4.length > 0 || nets.v6.length === 0 ? '0.0.0.0/0' : '::/0'}`,
          pool ? `${r} rule SNAT-1 then source-nat pool ${poolName}` : `${r} rule SNAT-1 then source-nat interface`,
          ...(arp && range ? [`set security nat proxy-arp interface ${ifl(arp).text} address ${range}`] : []),
        ],
        verify: ['show security nat source rule all', 'show security nat source summary', 'show security flow session nat', ...(pool ? [`show security nat source pool ${poolName}`] : [])],
        backout: [`delete security nat source rule-set ${rs}`, ...(pool ? [`delete security nat source pool ${poolName}`] : []), ...(arp && range ? [`delete security nat proxy-arp interface ${ifl(arp).text} address ${range}`] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_destination_nat',
    platform: PLATFORM,
    label: 'Destination NAT (port forward)',
    group: 'Security (SRX)',
    description: 'Publish an internal server: traffic to a public address and port is translated to the internal address and port.',
    inputs: [
      { id: 'from_zone', label: 'From zone', control: 'text', default: 'untrust' },
      { id: 'public_address', label: 'Public address', control: 'text', default: '203.0.113.5' },
      { id: 'public_port', label: 'Public port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'tcp', options: [{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }] },
      { id: 'internal_address', label: 'Internal address', control: 'text', default: '10.20.0.10' },
      { id: 'internal_port', label: 'Internal port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'proxy_arp_interface', label: 'Proxy ARP on', control: 'text', default: 'ge-0/0/0.0', hint: 'Empty when the public address is the interface’s own or routed to the SRX' },
    ],
    change: (values                 )               => {
      const from = ident(str(values, 'from_zone', 'untrust'), 'untrust');
      const pub = hostPrefix(str(values, 'public_address', ''));
      const internal = hostPrefix(str(values, 'internal_address', ''));
      const port = num(values, 'public_port', 443);
      const inPort = num(values, 'internal_port', 443);
      const protocol = str(values, 'protocol', 'tcp');
      const arp = str(values, 'proxy_arp_interface', '');
      const name = `DNAT-${(internal ?? 'server').split('/')[0]?.replace(/[.:]/g, '-')}-${inPort}`;
      const rs = `DNAT-from-${from}`;
      const findings            = [...(arp ? interfaceFindings([arp]) : [])];
      if (!pub) findings.push(error('network.junos.bad-public-address', 'The public address is not an address.', SRC));
      if (!internal) findings.push(error('network.junos.bad-internal-address', 'The internal address is not an address.', SRC));
      const r = `set security nat destination rule-set ${rs}`;

      return {
        platform: PLATFORM,
        title: `Destination NAT ${pub ?? '?'}:${port} to ${internal ?? '?'}:${inPort}`,
        impact: 'none',
        notes: [
          `The security policy from ${from} must permit the internal address (${internal ?? '?'}) and port ${inPort}, not the public one: destination NAT happens before the policy lookup.`,
          'This rule-set may already exist with other rules; the rule is added to it.',
        ],
        findings,
        before: ['show security nat destination summary', `show security nat destination rule-set ${rs}`],
        config: [
          `set security nat destination pool ${name} address ${internal ?? '<internal address>'} port ${inPort}`,
          `${r} from zone ${from}`,
          `${r} rule ${name} match destination-address ${pub ?? '<public address>'}`,
          `${r} rule ${name} match destination-port ${port}`,
          `${r} rule ${name} match protocol ${protocol}`,
          `${r} rule ${name} then destination-nat pool ${name}`,
          ...(arp && pub ? [`set security nat proxy-arp interface ${ifl(arp).text} address ${pub}`] : []),
        ],
        verify: [`show security nat destination rule ${name}`, `show security nat destination pool ${name}`, `show security flow session destination-port ${port}`],
        backout: [`delete security nat destination rule-set ${rs} rule ${name}`, `delete security nat destination pool ${name}`, ...(arp && pub ? [`delete security nat proxy-arp interface ${ifl(arp).text} address ${pub}`] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_static_nat',
    platform: PLATFORM,
    label: 'Static NAT (one-to-one)',
    group: 'Security (SRX)',
    description: 'A one-to-one translation between a public and an internal address (or equal-sized prefixes), both directions.',
    inputs: [
      { id: 'from_zone', label: 'From zone', control: 'text', default: 'untrust' },
      { id: 'public', label: 'Public address or prefix', control: 'text', default: '203.0.113.6/32' },
      { id: 'internal', label: 'Internal address or prefix', control: 'text', default: '10.20.0.20/32' },
      { id: 'proxy_arp_interface', label: 'Proxy ARP on', control: 'text', default: 'ge-0/0/0.0', hint: 'Empty for none' },
    ],
    change: (values                 )               => {
      const from = ident(str(values, 'from_zone', 'untrust'), 'untrust');
      const pub = parseCidrAny(str(values, 'public', ''));
      const internal = parseCidrAny(str(values, 'internal', ''));
      const arp = str(values, 'proxy_arp_interface', '');
      const findings            = [...(arp ? interfaceFindings([arp]) : [])];
      if (!pub || !internal) findings.push(error('network.junos.bad-static-nat', 'The public and internal values must both be an address or a prefix.', SRC));
      if (pub && internal && (pub.prefix !== internal.prefix || pub.family !== internal.family)) findings.push(error('network.junos.static-nat-size', 'Static NAT maps one-to-one: both sides must be the same family and prefix length.', SRC));
      const p = pub ? `${pub.address}/${pub.prefix}` : '<public>';
      const i = internal ? `${internal.address}/${internal.prefix}` : '<internal>';
      const rule = `STATIC-${i.split('/')[0]?.replace(/[.:]/g, '-')}`;
      const rs = `STATIC-from-${from}`;
      const r = `set security nat static rule-set ${rs}`;

      return {
        platform: PLATFORM,
        title: `Static NAT ${p} to ${i}`,
        impact: 'none',
        notes: ['Static NAT translates both ways: inbound to the public address, and outbound from the internal one (ahead of any source NAT).', 'The security policy must name the internal address.'],
        findings,
        before: ['show security nat static rule all'],
        config: [`${r} from zone ${from}`, `${r} rule ${rule} match destination-address ${p}`, `${r} rule ${rule} then static-nat prefix ${i}`, ...(arp ? [`set security nat proxy-arp interface ${ifl(arp).text} address ${p}`] : [])],
        verify: [`show security nat static rule ${rule}`, 'show security flow session nat'],
        backout: [`delete security nat static rule-set ${rs} rule ${rule}`, ...(arp ? [`delete security nat proxy-arp interface ${ifl(arp).text} address ${p}`] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_ipsec_vpn',
    platform: PLATFORM,
    label: 'Route-based IPsec VPN (site to site)',
    group: 'Security (SRX)',
    description: 'A route-based site-to-site VPN: the IKE proposal, policy and gateway with a pre-shared key, the IPsec proposal, policy and VPN bound to an st0 interface, its zone, and routes to the far side.',
    inputs: [
      { id: 'name', label: 'VPN name', control: 'text', default: 'TO-BRANCH-1' },
      { id: 'peer', label: 'Peer address', control: 'text', default: '198.51.100.20' },
      { id: 'external_interface', label: 'External interface', control: 'text', default: 'ge-0/0/0.0' },
      { id: 'external_zone', label: 'External zone', control: 'text', default: 'untrust' },
      { id: 'st0_unit', label: 'st0 unit', control: 'number', default: 1, min: 0, max: 16383 },
      { id: 'vpn_zone', label: 'Tunnel zone', control: 'text', default: 'vpn' },
      { id: 'remote_prefixes', label: 'Remote prefixes', control: 'text', default: '10.60.0.0/16' },
      { id: 'ike_version', label: 'IKE version', control: 'select', default: 'v2-only', options: [{ value: 'v2-only', label: 'IKEv2' }, { value: 'v1-only', label: 'IKEv1' }] },
      { id: 'dh_group', label: 'DH group', control: 'select', default: 'group19', options: [{ value: 'group19', label: 'group19 (ECP-256)' }, { value: 'group20', label: 'group20 (ECP-384)' }, { value: 'group14', label: 'group14 (MODP-2048)' }, { value: 'group5', label: 'group5 (MODP-1536)' }, { value: 'group2', label: 'group2 (MODP-1024)' }] },
      { id: 'esp', label: 'ESP encryption', control: 'select', default: 'aes-256-gcm', options: [{ value: 'aes-256-gcm', label: 'AES-256-GCM' }, { value: 'aes-256-cbc', label: 'AES-256-CBC with SHA-256' }] },
    ],
    change: (values                 )               => {
      const name = ident(str(values, 'name', 'VPN'), 'VPN');
      const peer = str(values, 'peer', '');
      const ext = ifl(str(values, 'external_interface', 'ge-0/0/0.0')).text;
      const extZone = ident(str(values, 'external_zone', 'untrust'), 'untrust');
      const st0 = `st0.${num(values, 'st0_unit', 1)}`;
      const vpnZone = ident(str(values, 'vpn_zone', 'vpn'), 'vpn');
      const remote = prefixes(str(values, 'remote_prefixes', ''));
      const version = str(values, 'ike_version', 'v2-only');
      const dh = str(values, 'dh_group', 'group19');
      const gcm = str(values, 'esp', 'aes-256-gcm') === 'aes-256-gcm';
      const findings            = [...interfaceFindings([ext]), ...prefixFindings('network.junos.bad-prefix', 'the remote prefixes', remote.invalid)];
      if (!isIp(peer)) findings.push(error('network.junos.bad-peer', `The peer "${peer}" is not an address. (A dynamic peer needs \`dynamic hostname\` instead, which is not written here.)`, SRC));
      if (dh === 'group2' || dh === 'group5') findings.push(warning('network.junos.weak-dh', `${dh} is below current guidance (NIST SP 800-77r1). Use group19, group20 or group14.`, SRC));
      if (version === 'v1-only') findings.push(warning('network.junos.ikev1', 'IKEv1 is deprecated (RFC 9395). Use IKEv2 unless the peer cannot.', SRC));
      const ike = `set security ike`;
      const ipsec = `set security ipsec`;

      return {
        platform: PLATFORM,
        title: `IPsec VPN ${name} to ${peer} on ${st0}`,
        impact: 'none',
        notes: [
          `Replace ${SECRET} with the pre-shared key from your vault; the peer needs the same key and matching proposals.`,
          'Pre-shared keys are the default authentication method of an IKE proposal, so the proposal does not name it.',
          `The external zone ${extZone} must allow IKE as host-inbound traffic (included), and security policies between ${vpnZone} and the inside zones must allow the traffic.`,
        ],
        findings,
        before: ['show security ike security-associations', 'show security ipsec security-associations', 'show interfaces st0 terse'],
        config: [
          `set interfaces ${st0.replace('.', ' unit ')} family inet`,
          `${ike} proposal ${name}-IKE dh-group ${dh}`,
          `${ike} proposal ${name}-IKE authentication-algorithm sha-256`,
          `${ike} proposal ${name}-IKE encryption-algorithm aes-256-cbc`,
          `${ike} proposal ${name}-IKE lifetime-seconds 28800`,
          ...(version === 'v1-only' ? [`${ike} policy ${name}-IKE mode main`] : []),
          `${ike} policy ${name}-IKE proposals ${name}-IKE`,
          `${ike} policy ${name}-IKE pre-shared-key ascii-text "${SECRET}"`,
          `${ike} gateway ${name}-GW ike-policy ${name}-IKE`,
          `${ike} gateway ${name}-GW address ${peer}`,
          `${ike} gateway ${name}-GW external-interface ${ext}`,
          `${ike} gateway ${name}-GW version ${version}`,
          `${ike} gateway ${name}-GW dead-peer-detection optimized`,
          `${ipsec} proposal ${name}-ESP protocol esp`,
          `${ipsec} proposal ${name}-ESP encryption-algorithm ${gcm ? 'aes-256-gcm' : 'aes-256-cbc'}`,
          ...(gcm ? [] : [`${ipsec} proposal ${name}-ESP authentication-algorithm hmac-sha-256-128`]),
          `${ipsec} proposal ${name}-ESP lifetime-seconds 3600`,
          `${ipsec} policy ${name}-ESP perfect-forward-secrecy keys ${dh}`,
          `${ipsec} policy ${name}-ESP proposals ${name}-ESP`,
          `${ipsec} vpn ${name} bind-interface ${st0}`,
          `${ipsec} vpn ${name} ike gateway ${name}-GW`,
          `${ipsec} vpn ${name} ike ipsec-policy ${name}-ESP`,
          `${ipsec} vpn ${name} establish-tunnels immediately`,
          `set security zones security-zone ${vpnZone} interfaces ${st0}`,
          `set security zones security-zone ${extZone} host-inbound-traffic system-services ike`,
          ...remote.v4.map((p) => `set routing-options static route ${p} next-hop ${st0}`),
          ...remote.v6.map((p) => `set routing-options rib inet6.0 static route ${p} next-hop ${st0}`),
        ],
        verify: ['show security ike security-associations', 'show security ipsec security-associations', `show security ipsec statistics`, ...remote.v4.map((p) => `show route ${p}`), 'show log kmd | last 30'],
        backout: [
          ...remote.v4.map((p) => `delete routing-options static route ${p}`),
          ...remote.v6.map((p) => `delete routing-options rib inet6.0 static route ${p}`),
          `delete security zones security-zone ${vpnZone} interfaces ${st0}`,
          `delete security ipsec vpn ${name}`,
          `delete security ipsec policy ${name}-ESP`,
          `delete security ipsec proposal ${name}-ESP`,
          `delete security ike gateway ${name}-GW`,
          `delete security ike policy ${name}-IKE`,
          `delete security ike proposal ${name}-IKE`,
          `delete interfaces ${st0.replace('.', ' unit ')}`,
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_screens',
    platform: PLATFORM,
    label: 'Screens (IDS options) on a zone',
    group: 'Security (SRX)',
    description: 'A screen profile against floods and malformed packets — SYN flood, ping of death, teardrop, land, source-route — applied to an internet-facing zone.',
    inputs: [
      { id: 'name', label: 'Screen name', control: 'text', default: 'UNTRUST-SCREEN' },
      { id: 'zone', label: 'Zone', control: 'text', default: 'untrust' },
      { id: 'syn_threshold', label: 'SYN flood attack threshold (per second)', control: 'number', default: 1000, min: 1, max: 1000000 },
      { id: 'session_limit', label: 'Sessions per source address', control: 'number', default: 0, min: 0, max: 1000000, hint: '0 for no limit' },
      { id: 'alarm_only', label: 'Alarm without dropping', control: 'toggle', default: false, hint: 'Watch it first, then enforce' },
    ],
    change: (values                 )               => {
      const name = ident(str(values, 'name', 'UNTRUST-SCREEN'), 'UNTRUST-SCREEN');
      const zone = ident(str(values, 'zone', 'untrust'), 'untrust');
      const syn = num(values, 'syn_threshold', 1000);
      const limit = num(values, 'session_limit', 0);
      const alarm = bool(values, 'alarm_only', false);
      const s = `set security screen ids-option ${name}`;
      const findings            = [];
      if (syn < 100) findings.push(warning('network.junos.syn-low', `A SYN flood threshold of ${syn} per second will trigger on ordinary busy traffic.`, SRC));

      return {
        platform: PLATFORM,
        title: `Screen ${name} on zone ${zone}`,
        impact: alarm ? 'none' : 'brief',
        notes: ['Screens act before sessions are created, so they can drop legitimate traffic that looks like an attack — a busy NAT pool can look like a SYN flood. Start with alarm-without-drop and watch `show security screen statistics zone`.'],
        findings,
        before: [`show security screen statistics zone ${zone}`, `show configuration security screen | display set`],
        config: [
          `${s} icmp ping-death`,
          `${s} ip source-route-option`,
          `${s} ip tear-drop`,
          `${s} tcp land`,
          `${s} tcp syn-fin`,
          `${s} tcp tcp-no-flag`,
          `${s} tcp syn-flood alarm-threshold ${syn}`,
          `${s} tcp syn-flood attack-threshold ${syn}`,
          `${s} tcp syn-flood timeout 20`,
          ...(limit > 0 ? [`${s} limit-session source-ip-based ${limit}`] : []),
          ...(alarm ? [`${s} alarm-without-drop`] : []),
          `set security zones security-zone ${zone} screen ${name}`,
        ],
        verify: [`show security screen ids-option ${name}`, `show security screen statistics zone ${zone}`, 'show log messages | match RT_SCREEN'],
        backout: [`delete security zones security-zone ${zone} screen`, `delete security screen ids-option ${name}`, 'commit'],
      };
    },
  }),
];

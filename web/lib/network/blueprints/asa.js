/**
 * Cisco ASA firewalls.
 *
 * The ASA is not an IOS router with access lists. Interfaces have names and
 * security levels, and traffic from a higher level to a lower one is permitted
 * by default while the reverse is not; NAT is its own ordered table that is
 * evaluated before the access list; and an access list applied to an interface
 * is matched against the **real** address after NAT has been worked out, which
 * is the single most common way an ASA rule does not do what it looks like it
 * does. Each change here says which of those apply.
 *
 * Everything is CLI, pushed with `cisco.asa.asa_config`. No key, password or
 * shared secret is ever written: they are `<REQUIRED>`.
 *
 * IPv6 is native on the ASA and its access lists are unified: one list holds
 * both families, but one entry cannot mix them. IPv4 is written address and
 * dotted mask, IPv6 always as prefix/length — never a mask.
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { containsAny, familyOf, isAnyNetwork, isIp, parseCidrAny,             } from '../../core/ip.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { description, listOf, netmask, parseCidrDual,                   } from '../device.js';

const PLATFORM = 'cisco_asa'         ;
const SECRET = '<REQUIRED>';

                                                         

/** A network as an ASA command wants it: 10.0.0.0 255.255.255.0, 2001:db8::/64. */
const asaNet = (c     )         => (c.family === 4 ? `${c.address} ${netmask(c.prefix)}` : `${c.network}/${c.prefix}`);

/** A test address of the right family for packet-tracer. */
const probeSource = (family               )         => (family === 6 ? '2001:db8:ffff::9' : '203.0.113.9');

/**
 * The family an ACL operand is in, or null when it could be either (any, an
 * object name) — ASA only knows an object's family once it exists.
 */
function operandFamily(value        )                {
  if (value === 'any4') return 4;
  if (value === 'any6') return 6;
  return familyOf(value.replace(/^host\s+/, '').trim());
}

/** Networks one per line or comma separated, split into the parsed ones and the ones that are not. */
function networksOf(text        )                                     {
  const items = String(text ?? '')
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const nets        = [];
  const invalid           = [];
  for (const item of items) {
    const c = parseCidrDual(item);
    if (c) nets.push(c);
    else invalid.push(item);
  }
  return { nets, invalid };
}

const BLUEPRINTS                             = [
  deviceBlueprint({
    id: 'asa_interface',
    platform: PLATFORM,
    label: 'Interface: nameif, security level, address',
    group: 'Network',
    description: 'A physical interface or a VLAN sub-interface with its name, security level and address — the three things that decide what it may talk to.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'GigabitEthernet0/1' },
      { id: 'subinterface', label: 'Sub-interface VLAN', control: 'number', default: 0, min: 0, max: 4094, hint: '0 for the physical interface' },
      { id: 'nameif', label: 'Name', control: 'text', default: 'dmz', hint: 'inside, outside, dmz — how every other command refers to it' },
      { id: 'security_level', label: 'Security level', control: 'number', default: 50, min: 0, max: 100, hint: '100 inside, 0 outside. Higher may reach lower without a rule' },
      { id: 'address', label: 'Address', control: 'text', default: '10.20.30.1/24', hint: 'IPv4 or IPv6, with the prefix: 10.20.30.1/24 or 2001:db8:30::1/64' },
      { id: 'ipv6_address', label: 'IPv6 address (dual stack)', control: 'text', default: '', hint: 'Optional second address when the first is IPv4: 2001:db8:30::1/64' },
      { id: 'standby_address', label: 'Standby address', control: 'text', default: '', hint: 'The failover standby unit’s address for the first address; empty without failover' },
      { id: 'ipv6_standby', label: 'IPv6 standby address', control: 'text', default: '', hint: 'The standby unit’s address for the IPv6 address', showWhen: { input: 'ipv6_address', notEquals: [''] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'DMZ' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 1500, min: 576, max: 9198 },
    ],
    change: (values                 )               => {
      const physical = str(values, 'interface', '');
      const vlan = num(values, 'subinterface', 0);
      const iface = vlan > 0 ? `${physical}.${vlan}` : physical;
      const name = str(values, 'nameif', 'dmz').toLowerCase();
      const level = num(values, 'security_level', 50);
      const first = parseCidrDual(str(values, 'address', ''));
      const secondText = str(values, 'ipv6_address', '');
      const second = secondText ? parseCidrDual(secondText) : null;
      const findings            = [];
      if (!first) findings.push(error('network.asa.bad-address', 'The address is not a valid IPv4 or IPv6 address and prefix.', { source: 'ArchToolKit' }));
      if (secondText && second?.family !== 6) {
        findings.push(error('network.asa.bad-ipv6-address', 'The IPv6 address is not a valid IPv6 address and prefix.', { remediation: 'Write it as 2001:db8:30::1/64.', source: 'ArchToolKit' }));
      }
      // Each address with the standby unit's address for it, checked to be the same family and in the same network.
      const standbyFor = (c            , input        )         => {
        const standby = str(values, input, '');
        if (!standby || !c) return '';
        if (!isIp(standby) || familyOf(standby) !== c.family || !containsAny(`${c.network}/${c.prefix}`, standby)) {
          findings.push(error('network.asa.bad-standby', `The standby address ${standby} is not an IPv${c.family} address in ${c.network}/${c.prefix}.`, { source: 'ArchToolKit' }));
          return '';
        }
        return ` standby ${standby}`;
      };
      const v4 = first?.family === 4 ? first : null;
      const v6 = [first?.family === 6 ? { c: first, standby: standbyFor(first, 'standby_address') } : null, second?.family === 6 ? { c: second, standby: standbyFor(second, 'ipv6_standby') } : null].filter(
        (x)                                   => x !== null,
      );
      const v4Standby = standbyFor(v4, 'standby_address');
      const cidr = v4;
      if (level === 100 && name !== 'inside') {
        findings.push(
          warning('network.asa.security-level-100', 'Security level 100 lets this interface reach every other interface without a rule. Only the trusted inside should have it.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Interface ${iface} as ${name} (level ${level})`,
        impact: 'outage',
        notes: [
          'The security level is a permission: traffic from a higher level to a lower one is allowed unless an access list says otherwise, and the other direction is denied unless one does.',
          'Naming an interface you are managing through, or changing its address, ends your session.',
          ...(vlan > 0 ? ['A sub-interface needs the physical interface up with no address and the switch port trunked with this VLAN.'] : []),
        ],
        before: ['show running-config interface', 'show interface ip brief', 'show nameif'],
        config: [
          ...(vlan > 0 ? [`interface ${physical}`, ' no shutdown', ' no nameif', '!'] : []),
          `interface ${iface}`,
          ...(vlan > 0 ? [` vlan ${vlan}`] : []),
          ` description ${description(str(values, 'port_description', ''), 'Managed')}`,
          ` nameif ${name}`,
          ` security-level ${level}`,
          ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}${v4Standby}`] : []),
          ...v6.map(({ c, standby }) => ` ipv6 address ${c.address}/${c.prefix}${standby}`),
          ...(v6.length > 0 ? [' ipv6 enable'] : []),
          ...(num(values, 'mtu', 1500) !== 1500 ? [` mtu ${name} ${num(values, 'mtu', 1500)}`] : []),
          ' no shutdown',
          '!',
        ],
        verify: [
          'show interface ip brief',
          `show interface ${iface}`,
          'show nameif',
          ...(v6.length > 0 ? [`show ipv6 interface ${name}`] : []),
          ...(cidr ? [`ping ${name} ${cidr.address}`] : []),
          ...v6.map(({ c }) => `ping ${name} ${c.address}`),
        ],
        backout: [
          `interface ${iface}`,
          ' shutdown',
          ' no nameif',
          ' no ip address',
          ...v6.map(({ c }) => ` no ipv6 address ${c.address}/${c.prefix}`),
          ...(v6.length > 0 ? [' no ipv6 enable'] : []),
          '!',
          ...(vlan > 0 ? [`no interface ${iface}`] : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_objects',
    platform: PLATFORM,
    label: 'Network and service objects',
    group: 'Objects',
    description: 'Named network objects, an object-group to collect them, and the service objects a rule refers to instead of port numbers.',
    inputs: [
      { id: 'group_name', label: 'Network object-group', control: 'text', default: 'GRP-APP-SERVERS' },
      { id: 'networks', label: 'Network objects', control: 'textarea', default: 'APP-WEB-01 host 10.20.30.11\nAPP-WEB-02 host 10.20.30.12\nAPP-SUBNET subnet 10.20.31.0/24', hint: 'One per line: NAME host|subnet value — IPv4 or IPv6, e.g. APP-V6 subnet 2001:db8:31::/64' },
      { id: 'service_group', label: 'Service object-group', control: 'text', default: 'SVC-APP-PORTS' },
      { id: 'services', label: 'Service objects', control: 'textarea', default: 'tcp 443\ntcp 8080\nudp 514', hint: 'One per line: protocol port' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'GRP').toUpperCase().replace(/\s+/g, '-');
      const serviceGroup = str(values, 'service_group', 'SVC').toUpperCase().replace(/\s+/g, '-');
      const networks = str(values, 'networks', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 3)
        .map(([name, kind, value]) => ({ name: String(name), kind: String(kind), value: String(value) }));
      const services = str(values, 'services', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const findings            = [];
      for (const entry of networks) {
        if (entry.kind === 'subnet' && !parseCidrDual(entry.value)) {
          findings.push(error('network.asa.bad-subnet', `"${entry.value}" for ${entry.name} is not a valid prefix.`, { remediation: 'Write it as 10.20.31.0/24 or 2001:db8:31::/64.', source: 'ArchToolKit' }));
        }
        if (entry.kind === 'host' && !isIp(entry.value)) {
          findings.push(error('network.asa.bad-host', `"${entry.value}" for ${entry.name} is not a valid IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
        }
        if (entry.kind !== 'host' && entry.kind !== 'subnet') {
          findings.push(error('network.asa.bad-object-kind', `"${entry.kind}" for ${entry.name} is neither host nor subnet.`, { source: 'ArchToolKit' }));
        }
      }
      if (networks.length === 0) findings.push(error('network.asa.no-objects', 'No objects were given.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `${networks.length} object(s), the group ${group} and ${services.length} service(s)`,
        impact: 'none',
        notes: [
          'Objects change nothing on their own. They make the rules readable and, more usefully, make changing an address one edit rather than a hunt through the rulebase.',
          'An object used by a NAT rule or an access list cannot be removed until those are removed first.',
        ],
        before: ['show running-config object', `show running-config object-group id ${group}`],
        config: [
          ...networks.flatMap((entry) => {
            // An IPv6 subnet object is written as prefix/length, never with a mask.
            const cidr = entry.kind === 'subnet' ? parseCidrDual(entry.value) : null;
            return [
              `object network ${entry.name}`,
              entry.kind === 'host' ? ` host ${entry.value}` : ` subnet ${cidr ? asaNet(cidr) : '<REQUIRED>'}`,
              ` description`,
              '!',
            ];
          }),
          `object-group network ${group}`,
          ...networks.map((entry) => ` network-object object ${entry.name}`),
          '!',
          `object-group service ${serviceGroup}`,
          ...services.map((parts) => ` service-object ${parts[0]} destination eq ${parts[1]}`),
          '!',
        ],
        verify: [`show running-config object-group id ${group}`, 'show running-config object', `show object-group service ${serviceGroup}`],
        backout: [`no object-group service ${serviceGroup}`, `no object-group network ${group}`, ...networks.map((entry) => `no object network ${entry.name}`)],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_access_rule',
    platform: PLATFORM,
    label: 'Access rule',
    group: 'Policy',
    description: 'An access list entry and the access-group that applies it to an interface, with logging and a remark that says why it exists.',
    inputs: [
      { id: 'acl_name', label: 'Access list', control: 'text', default: 'outside_access_in' },
      { id: 'interface', label: 'Interface', control: 'text', default: 'outside', hint: 'The nameif, not the physical port' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'in', options: [{ value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }] },
      { id: 'action', label: 'Action', control: 'select', default: 'permit', options: [{ value: 'permit', label: 'Permit' }, { value: 'deny', label: 'Deny' }] },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'tcp', options: [{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'icmp', label: 'ICMP' }, { value: 'ip', label: 'Any IP' }] },
      { id: 'source', label: 'Source', control: 'text', default: 'any4', hint: 'any, any4, any6, an IPv4 or IPv6 address or network, an object name, or object-group NAME' },
      { id: 'destination', label: 'Destination', control: 'text', default: 'APP-WEB-01', hint: 'The same forms as the source, and the same family' },
      { id: 'ports', label: 'Destination port or service group', control: 'text', default: '443', hint: 'A port, a range, or object-group NAME' },
      { id: 'remark', label: 'Remark', control: 'text', default: 'Published web service — change CR-1234' },
      { id: 'log_level', label: 'Logging', control: 'select', default: 'informational', options: [
        { value: 'informational', label: 'Informational' },
        { value: 'default', label: 'Default' },
        { value: 'disable', label: 'None' },
      ] },
    ],
    change: (values                 )               => {
      const acl = str(values, 'acl_name', 'outside_access_in');
      const iface = str(values, 'interface', 'outside');
      const action = str(values, 'action', 'permit');
      const protocol = str(values, 'protocol', 'tcp');
      const source = str(values, 'source', 'any4');
      const destination = str(values, 'destination', '');
      const ports = str(values, 'ports', '');
      const log = str(values, 'log_level', 'informational');
      const findings            = [];

      // An address becomes "host a"; an IPv4 network "a mask"; an IPv6 network "net/len" — the
      // ASA takes no mask for IPv6. A dotted "address mask" pair already typed is left alone.
      const asObject = (value        )         => {
        if (value.startsWith('object-group ') || value.startsWith('object ') || value.startsWith('host ') || value === 'any' || value === 'any4' || value === 'any6') return value;
        if (/^\d+\.\d+\.\d+\.\d+\s+\d+\.\d+\.\d+\.\d+$/.test(value)) return value;
        const c = parseCidrAny(value);
        if (!c) return `object ${value}`;
        if (!value.includes('/') || c.prefix === (c.family === 4 ? 32 : 128)) return `host ${c.address}`;
        return c.family === 4 ? `${c.network} ${netmask(c.prefix)}` : `${c.network}/${c.prefix}`;
      };
      const sourceFamily = operandFamily(source);
      const destinationFamily = operandFamily(destination);
      if (sourceFamily !== null && destinationFamily !== null && sourceFamily !== destinationFamily) {
        findings.push(
          error('network.asa.acl-mixed-family', `The source is IPv${sourceFamily} and the destination IPv${destinationFamily}. One access list entry matches one family; a rule from one to the other can never match.`, {
            remediation: 'Write one entry per family — the list itself can hold both — or use any, which covers both.',
            source: 'ArchToolKit',
          }),
        );
      }

      if ((source === 'any' || source === 'any4' || source === 'any6') && action === 'permit' && protocol === 'ip') {
        findings.push(
          warning('network.asa.permit-any-ip', 'Permitting any IP from any source is not a rule, it is the absence of one.', { remediation: 'Name the protocol and the ports the service uses.', source: 'ArchToolKit' }),
        );
      }

      const portPart = protocol === 'icmp' || protocol === 'ip' ? '' : ports.startsWith('object-group ') ? ` ${ports}` : ` eq ${ports}`;
      // ICMP for IPv6 is its own protocol keyword on the ASA.
      const aceProtocol = protocol === 'icmp' && (sourceFamily === 6 || destinationFamily === 6) ? 'icmp6' : protocol;

      return {
        platform: PLATFORM,
        title: `${action} ${protocol} to ${destination} on ${iface} ${str(values, 'direction', 'in')}`,
        impact: 'brief',
        notes: [
          '**The access list matches the real address, not the translated one.** On a published service, that means the inside address — the NAT rule is evaluated first and the ACL sees what comes out of it.',
          'A new line goes to the end of the list. If something above it already matches, this rule never fires; `show access-list` shows the hit counts.',
          'Applying an access-group to an interface that had none turns implicit permission into explicit: everything not permitted is then denied.',
        ],
        before: [`show access-list ${acl}`, 'show running-config access-group', `show running-config access-list ${acl}`],
        config: [
          `access-list ${acl} remark ${description(str(values, 'remark', ''), '')}`,
          `access-list ${acl} extended ${action} ${aceProtocol} ${asObject(source)} ${asObject(destination)}${portPart}${log === 'disable' ? ' log disable' : log === 'informational' ? ' log informational' : ''}`,
          `access-group ${acl} ${str(values, 'direction', 'in')} interface ${iface}`,
        ],
        verify: [`show access-list ${acl}`, 'show running-config access-group', `packet-tracer input ${iface} ${protocol} ${probeSource(destinationFamily ?? sourceFamily)} 12345 <destination> ${ports || '443'} detailed`],
        backout: [
          `no access-list ${acl} extended ${action} ${aceProtocol} ${asObject(source)} ${asObject(destination)}${portPart}`,
          `no access-list ${acl} remark ${description(str(values, 'remark', ''), '')}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_nat',
    platform: PLATFORM,
    label: 'NAT: publish a server or hide a network',
    group: 'Policy',
    description: 'Object NAT to publish an internal server on an outside address, or dynamic PAT to hide a network behind the outside interface.',
    inputs: [
      { id: 'kind', label: 'Kind', control: 'select', default: 'static', options: [
        { value: 'static', label: 'Static — publish an internal server' },
        { value: 'pat', label: 'Dynamic PAT — hide a network outbound' },
      ] },
      { id: 'real_interface', label: 'Real (inside) interface', control: 'text', default: 'inside' },
      { id: 'mapped_interface', label: 'Mapped (outside) interface', control: 'text', default: 'outside' },
      { id: 'object_name', label: 'Object name', control: 'text', default: 'APP-WEB-01' },
      { id: 'real_address', label: 'Real address or subnet', control: 'text', default: '10.20.30.11', hint: 'IPv4 or IPv6: 10.20.30.11, 2001:db8:30::11 or a prefix' },
      { id: 'mapped_address', label: 'Mapped address', control: 'text', default: '203.0.113.11', hint: 'IPv4 or IPv6. A different family from the real address is NAT46/NAT64', showWhen: { input: 'kind', equals: ['static'] } },
      { id: 'service_translation', label: 'Translate the port too', control: 'toggle', default: false, showWhen: { input: 'kind', equals: ['static'] } },
      { id: 'real_port', label: 'Real port', control: 'number', default: 8443, min: 1, max: 65535, showWhen: { input: 'service_translation', equals: ['true'] } },
      { id: 'mapped_port', label: 'Mapped port', control: 'number', default: 443, min: 1, max: 65535, showWhen: { input: 'service_translation', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const kind = str(values, 'kind', 'static');
      const object = str(values, 'object_name', 'OBJ').toUpperCase().replace(/\s+/g, '-');
      const real = str(values, 'real_address', '');
      const realInterface = str(values, 'real_interface', 'inside');
      const mappedInterface = str(values, 'mapped_interface', 'outside');
      const mapped = str(values, 'mapped_address', '');
      const translate = bool(values, 'service_translation', false);
      const any = parseCidrAny(real);
      const realFamily = any?.family ?? null;
      const mappedFamily = familyOf(mapped);
      const findings            = [];
      if (!any) findings.push(error('network.asa.bad-real', 'The real address is not a valid IPv4 or IPv6 address or network.', { source: 'ArchToolKit' }));
      if (kind === 'static' && !isIp(mapped)) findings.push(error('network.asa.bad-mapped', 'The mapped address is not a valid IPv4 or IPv6 address.', { source: 'ArchToolKit' }));
      // NAT66 keeps the family; a static rule between families is NAT46 or NAT64.
      const crossFamily = kind === 'static' && realFamily !== null && mappedFamily !== null && realFamily !== mappedFamily;
      const objectLine =
        any && any.family === 4 && any.prefix < 32
          ? ` subnet ${any.address} ${netmask(any.prefix)}`
          : any && any.family === 6 && any.prefix < 128
            ? ` subnet ${any.network}/${any.prefix}`
            : ` host ${any ? any.address : real}`;
      // PAT to the interface's own address: the ipv6 keyword makes it the interface's IPv6 address (NAT66 PAT).
      const patLine = ` nat (${realInterface},${mappedInterface}) dynamic interface${realFamily === 6 ? ' ipv6' : ''}`;
      const testFamily = kind === 'static' ? mappedFamily : realFamily;

      return {
        platform: PLATFORM,
        title: kind === 'static' ? `Publish ${real} as ${mapped}` : `PAT ${real} behind ${mappedInterface}`,
        impact: 'brief',
        notes: [
          'NAT is evaluated before the access list, and the access list then matches the **real** address. A published server needs both: this rule, and a rule permitting traffic to the inside address.',
          'Object NAT (this) sits in section 2 of the NAT table, after any manual twice-NAT rules. If something is not translating as expected, `show nat detail` shows the order and the hit counts.',
          ...(kind === 'static' && mappedFamily === 6
            ? ['The mapped IPv6 address must be routed to this firewall, or on the outside prefix where the ASA answers neighbour discovery for it.']
            : kind === 'static'
              ? ['The mapped address must be routed to this firewall, or reachable by proxy ARP on the outside segment.']
              : []),
          ...(realFamily === 6 && !crossFamily
            ? ['This is NAT66. IPv6 rarely needs address translation — with global addresses inside, a plain access rule is usually the better design; keep NAT66 for prefix independence or overlapping ULA space.']
            : []),
          ...(crossFamily
            ? [
                `This translates between families (NAT${realFamily === 6 ? '46: IPv4 clients reach the IPv6 server' : '64: IPv6 clients reach the IPv4 server'}). Clients use the mapped address in their own family; add the dns keyword if DNS answers for the server must be rewritten, and note that the access rule still matches the real (IPv${realFamily}) address.`,
              ]
            : []),
        ],
        before: ['show nat detail', 'show running-config nat', `show running-config object id ${object}`, 'show xlate count'],
        config: [
          `object network ${object}`,
          objectLine,
          kind === 'static'
            ? translate
              ? ` nat (${realInterface},${mappedInterface}) static ${mapped} service tcp ${num(values, 'real_port', 8443)} ${num(values, 'mapped_port', 443)}`
              : ` nat (${realInterface},${mappedInterface}) static ${mapped}`
            : patLine,
          '!',
        ],
        verify: [
          'show nat detail',
          'show xlate | include ' + real,
          `packet-tracer input ${mappedInterface} tcp ${probeSource(testFamily)} 12345 ${kind === 'static' ? mapped : testFamily === 6 ? '2001:db8:ffff::53' : '8.8.8.8'} 443 detailed`,
        ],
        findings,
        backout: [`object network ${object}`, ' no nat', '!', `no object network ${object}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_static_route',
    platform: PLATFORM,
    label: 'Static route with tracking',
    group: 'Network',
    description: 'A route out of a named interface, optionally tracked by an SLA monitor so a backup route takes over when the next hop dies.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'outside' },
      { id: 'destination', label: 'Destination', control: 'combo', default: '0.0.0.0/0', options: [{ value: '0.0.0.0/0', label: '0.0.0.0/0 — IPv4 default' }, { value: '::/0', label: '::/0 — IPv6 default' }], hint: 'IPv4 or IPv6 prefix' },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '203.0.113.1', hint: 'The same family as the destination' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 255 },
      { id: 'track', label: 'Track the next hop', control: 'toggle', default: true },
      { id: 'track_id', label: 'Track id', control: 'number', default: 1, min: 1, max: 500, showWhen: { input: 'track', equals: ['true'] } },
      { id: 'sla_target', label: 'Probe target', control: 'text', default: '8.8.8.8', showWhen: { input: 'track', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', 'outside');
      const dual = parseCidrDual(str(values, 'destination', '0.0.0.0/0'));
      const v6 = dual?.family === 6;
      const cidr = dual;
      const gateway = str(values, 'gateway', '');
      const distance = num(values, 'distance', 1);
      const findings            = [];
      if (!cidr) findings.push(error('network.asa.bad-destination', 'The destination is not a valid IPv4 or IPv6 prefix.', { source: 'ArchToolKit' }));
      if (!isIp(gateway)) {
        findings.push(error('network.asa.bad-gateway', 'The gateway is not a valid IPv4 or IPv6 address.', { source: 'ArchToolKit' }));
      } else if (cidr && familyOf(gateway) !== cidr.family) {
        findings.push(error('network.asa.gateway-family', `The destination is IPv${cidr.family} but the gateway is IPv${familyOf(gateway)}. A route's next hop must be the same family.`, { source: 'ArchToolKit' }));
      }
      const target = str(values, 'sla_target', '8.8.8.8');
      // The SLA monitor that tracks a route probes with IPv4 ICMP only.
      const wantsTrack = bool(values, 'track', true);
      if (wantsTrack && v6) {
        findings.push(
          error('network.asa.ipv6-route-track', 'Route tracking (SLA monitor) on Cisco ASA does not support IPv6: an ipv6 route takes no track option and the monitor probes IPv4 only.', {
            remediation: 'Turn tracking off for the IPv6 route, or track the IPv4 path and let the IPv6 route follow a routing protocol.',
            source: 'ArchToolKit',
          }),
        );
      } else if (wantsTrack && familyOf(target) === 6) {
        findings.push(error('network.asa.sla-ipv6-target', 'The SLA monitor on Cisco ASA does not support IPv6 probe targets. Probe an IPv4 address.', { source: 'ArchToolKit' }));
      }
      const track = wantsTrack && !v6 && familyOf(target) !== 6;
      const trackId = num(values, 'track_id', 1);

      const routeLine = v6
        ? `ipv6 route ${iface} ${cidr .network}/${cidr .prefix} ${gateway} ${distance}`
        : `route ${iface} ${cidr ? cidr.address : '0.0.0.0'} ${cidr ? netmask(cidr.prefix) : '0.0.0.0'} ${gateway} ${distance}${track ? ` track ${trackId}` : ''}`;

      return {
        platform: PLATFORM,
        title: `Route ${cidr ? `${v6 ? cidr.network : cidr.address}/${cidr.prefix}` : '(invalid)'} via ${gateway} on ${iface}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: [
          ...(cidr && cidr.prefix === 0 ? ['This is the default route. A wrong gateway takes the firewall — and everything behind it — off the internet.'] : []),
          ...(track ? ['The SLA monitor probes from this interface. Probe something beyond the next hop, or a dead upstream still looks alive.'] : []),
        ],
        before: v6 ? ['show ipv6 route', 'show running-config ipv6 route'] : ['show route', 'show running-config route', ...(track ? [`show sla monitor ${trackId} configuration`, `show track ${trackId}`] : [])],
        config: [
          ...(track
            ? [
                `sla monitor ${trackId}`,
                ` type echo protocol ipIcmpEcho ${str(values, 'sla_target', '8.8.8.8')} interface ${iface}`,
                ' num-packets 3',
                ' frequency 10',
                '!',
                `sla monitor schedule ${trackId} life forever start-time now`,
                `track ${trackId} rtr ${trackId} reachability`,
                '!',
              ]
            : []),
          routeLine,
        ],
        verify: [v6 ? 'show ipv6 route' : 'show route', ...(track ? [`show track ${trackId}`, `show sla monitor ${trackId} operational-state`] : []), `ping ${iface} ${gateway}`],
        backout: [`no ${routeLine}`, ...(track ? [`no track ${trackId}`, `no sla monitor schedule ${trackId}`, `no sla monitor ${trackId}`] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_site_to_site_vpn',
    platform: PLATFORM,
    label: 'Site-to-site VPN (IKEv2)',
    group: 'VPN',
    description: 'A policy-based IKEv2 tunnel: the proposal, the policy, the tunnel group, the crypto map and the interesting-traffic access list.',
    inputs: [
      { id: 'peer', label: 'Peer address', control: 'text', default: '198.51.100.10', hint: 'IPv4 or IPv6' },
      { id: 'outside_interface', label: 'Outside interface', control: 'text', default: 'outside' },
      { id: 'local_networks', label: 'Local networks', control: 'textarea', default: '10.20.0.0/16', hint: 'One per line, IPv4 or IPv6. Each is paired with the remote networks of the same family' },
      { id: 'remote_networks', label: 'Remote networks', control: 'textarea', default: '10.30.0.0/16' },
      { id: 'crypto_map', label: 'Crypto map name', control: 'text', default: 'outside_map' },
      { id: 'sequence', label: 'Crypto map sequence', control: 'number', default: 10, min: 1, max: 65535, hint: 'Lower is evaluated first' },
      { id: 'encryption', label: 'Encryption', control: 'select', default: 'aes-gcm-256', options: [
        { value: 'aes-gcm-256', label: 'AES-GCM-256' },
        { value: 'aes-256', label: 'AES-256 with SHA-256' },
      ] },
      { id: 'dh_group', label: 'DH group', control: 'select', default: '20', options: [{ value: '20', label: 'Group 20' }, { value: '19', label: 'Group 19' }, { value: '14', label: 'Group 14' }] },
      { id: 'nat_exempt', label: 'Exempt the VPN traffic from NAT', control: 'toggle', default: true, hint: 'Without this, traffic is translated before it reaches the tunnel and never matches' },
    ],
    change: (values                 )               => {
      const peer = str(values, 'peer', '');
      const outside = str(values, 'outside_interface', 'outside');
      const localParsed = networksOf(str(values, 'local_networks', ''));
      const remoteParsed = networksOf(str(values, 'remote_networks', ''));
      const local = localParsed.nets;
      const remote = remoteParsed.nets;
      const map = str(values, 'crypto_map', 'outside_map');
      const sequence = num(values, 'sequence', 10);
      const gcm = str(values, 'encryption', 'aes-gcm-256') === 'aes-gcm-256';
      const dh = str(values, 'dh_group', '20');
      const exempt = bool(values, 'nat_exempt', true);
      const acl = `VPN-${peer.replace(/[.:]/g, '-')}`;
      const findings            = [];
      if (!isIp(peer)) findings.push(error('network.asa.bad-peer', 'The peer is not a valid IPv4 or IPv6 address.', { source: 'ArchToolKit' }));
      const invalid = [...localParsed.invalid, ...remoteParsed.invalid];
      if (invalid.length > 0) findings.push(error('network.asa.vpn-bad-network', `Not a network with a prefix: ${invalid.join(', ')}.`, { source: 'ArchToolKit' }));
      if (local.length === 0 || remote.length === 0) {
        findings.push(error('network.asa.vpn-networks', 'Both the local and the remote networks are needed: they are the interesting traffic.', { source: 'ArchToolKit' }));
      }
      // A crypto ACL entry is one family: IPv4 local to IPv4 remote, IPv6 to IPv6.
      for (const family of [4, 6]         ) {
        const l = local.some((c) => c.family === family);
        const r = remote.some((c) => c.family === family);
        if (l !== r && local.length > 0 && remote.length > 0) {
          findings.push(
            error('network.asa.vpn-family', `There are IPv${family} ${l ? 'local' : 'remote'} networks but no IPv${family} ${l ? 'remote' : 'local'} ones. Interesting traffic is matched within one family, so those networks would never enter the tunnel.`, {
              source: 'ArchToolKit',
            }),
          );
        }
      }
      const pairs = local.flatMap((l, i) => remote.map((r, j) => ({ l, r, i, j })).filter((p) => p.l.family === p.r.family));
      const innerV6 = pairs.some((p) => p.l.family === 6);
      const outerFamily = familyOf(peer);
      if (!exempt) {
        findings.push(
          warning('network.asa.no-nat-exempt', 'Without a NAT exemption, traffic to the remote site is translated first and never matches the tunnel. This is the most common reason a new ASA tunnel carries nothing.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `IKEv2 VPN to ${peer}`,
        impact: 'brief',
        notes: [
          `The pre-shared key is ${SECRET}. Type the real one in, or take it from your vault.`,
          'Both ends need matching proposals, groups and mirrored interesting traffic. A mismatch shows in `debug crypto ikev2 protocol 10`.',
          'A crypto map is applied to the interface as a whole; adding a sequence to a map already applied does not disturb the other tunnels on it.',
          ...(outerFamily !== null && pairs.some((p) => p.l.family !== outerFamily)
            ? [`VERIFY: this tunnel carries IPv${outerFamily === 4 ? 6 : 4} traffic over an IPv${outerFamily} peer. IKEv2 on the ASA supports mixed inner and outer families; check the release on both ends does too.`]
            : []),
          ...(innerV6 ? ['The IPv6 entries in the crypto ACL are written as prefix/length. The far end must mirror them exactly, family by family.'] : []),
        ],
        before: ['show crypto ikev2 sa', 'show crypto ipsec sa', 'show running-config crypto map', 'show nat detail'],
        config: [
          `crypto ikev2 policy ${sequence}`,
          gcm ? ' encryption aes-gcm-256' : ' encryption aes-256',
          gcm ? ' integrity null' : ' integrity sha256',
          ` group ${dh}`,
          ' prf sha256',
          ' lifetime seconds 86400',
          '!',
          `crypto ipsec ikev2 ipsec-proposal CFG-PROPOSAL`,
          gcm ? ' protocol esp encryption aes-gcm-256' : ' protocol esp encryption aes-256',
          gcm ? ' protocol esp integrity null' : ' protocol esp integrity sha-256',
          '!',
          ...pairs.map(({ l, r }) => `access-list ${acl} extended permit ip ${asaNet(l)} ${asaNet(r)}`),
          '!',
          `crypto map ${map} ${sequence} match address ${acl}`,
          `crypto map ${map} ${sequence} set peer ${peer}`,
          `crypto map ${map} ${sequence} set ikev2 ipsec-proposal CFG-PROPOSAL`,
          `crypto map ${map} ${sequence} set pfs group${dh}`,
          `crypto map ${map} ${sequence} set security-association lifetime seconds 3600`,
          `crypto map ${map} interface ${outside}`,
          '!',
          `tunnel-group ${peer} type ipsec-l2l`,
          `tunnel-group ${peer} ipsec-attributes`,
          ` ikev2 remote-authentication pre-shared-key ${SECRET}`,
          ` ikev2 local-authentication pre-shared-key ${SECRET}`,
          '!',
          `crypto ikev2 enable ${outside}`,
          '!',
          ...(exempt
            ? pairs.map(({ l, r, i, j }) =>
                [
                  `object network VPN-LOCAL-${i}`,
                  ` subnet ${asaNet(l)}`,
                  `object network VPN-REMOTE-${j}`,
                  ` subnet ${asaNet(r)}`,
                  `nat (inside,${outside}) source static VPN-LOCAL-${i} VPN-LOCAL-${i} destination static VPN-REMOTE-${j} VPN-REMOTE-${j} no-proxy-arp route-lookup`,
                ].join('\n'),
              )
            : []),
        ],
        verify: [
          'show crypto ikev2 sa detail',
          `show crypto ipsec sa peer ${peer}`,
          `packet-tracer input inside tcp ${pairs[0]?.l.address ?? '10.20.0.10'} 12345 ${pairs[0]?.r.address ?? '10.30.0.10'} 443 detailed`,
          'show nat detail | include VPN',
        ],
        backout: [
          `no crypto map ${map} ${sequence}`,
          `no tunnel-group ${peer}`,
          `no access-list ${acl}`,
          `no crypto ipsec ikev2 ipsec-proposal CFG-PROPOSAL`,
          `no crypto ikev2 policy ${sequence}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_remote_access_vpn',
    platform: PLATFORM,
    label: 'Remote access VPN (AnyConnect)',
    group: 'VPN',
    description: 'The group policy, tunnel group, address pool and split tunnelling for client VPN, authenticated against RADIUS or LDAP.',
    inputs: [
      { id: 'group_name', label: 'Connection profile', control: 'text', default: 'CORP-VPN' },
      { id: 'pool_name', label: 'Address pool', control: 'text', default: 'VPN-POOL' },
      { id: 'pool_start', label: 'Pool start', control: 'text', default: '10.99.0.10' },
      { id: 'pool_end', label: 'Pool end', control: 'text', default: '10.99.0.200' },
      { id: 'pool_mask', label: 'Pool mask', control: 'text', default: '255.255.255.0' },
      { id: 'ipv6_pool', label: 'IPv6 pool', control: 'text', default: '', hint: 'Optional, for dual-stack clients: the first address and prefix, 2001:db8:99::1/64' },
      { id: 'ipv6_pool_size', label: 'IPv6 pool size', control: 'number', default: 250, min: 1, max: 16384, showWhen: { input: 'ipv6_pool', notEquals: [''] } },
      { id: 'auth_server', label: 'Authentication server group', control: 'text', default: 'ISE-RADIUS', hint: 'Or LOCAL for a lab' },
      { id: 'split_tunnel', label: 'Split tunnelling', control: 'select', default: 'split', options: [
        { value: 'split', label: 'Split — only the listed networks go over the VPN' },
        { value: 'full', label: 'Full tunnel — everything goes over the VPN' },
      ] },
      { id: 'split_networks', label: 'Networks to tunnel', control: 'textarea', default: '10.20.0.0/16\n10.30.0.0/16', hint: 'One per line, IPv4 or IPv6', showWhen: { input: 'split_tunnel', equals: ['split'] } },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.10, 10.0.0.11', hint: 'IPv4 or IPv6' },
      { id: 'domain', label: 'Default domain', control: 'text', default: 'corp.local' },
      { id: 'certificate', label: 'Identity certificate trustpoint', control: 'text', default: 'ASDM_TrustPoint0', hint: 'Must already exist — none is generated here' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'CORP-VPN').toUpperCase().replace(/\s+/g, '-');
      const pool = str(values, 'pool_name', 'VPN-POOL').toUpperCase().replace(/\s+/g, '-');
      const split = str(values, 'split_tunnel', 'split') === 'split';
      const splitParsed = networksOf(split ? str(values, 'split_networks', '') : '');
      const networks = splitParsed.nets;
      const splitV6 = networks.some((n) => n.family === 6);
      const dns = listOf(str(values, 'dns_servers', ''));
      const findings            = [];
      if (splitParsed.invalid.length > 0) findings.push(error('network.asa.split-bad-network', `Not a network with a prefix: ${splitParsed.invalid.join(', ')}.`, { source: 'ArchToolKit' }));
      // The IPv4 pool is a range with a mask; IPv6 has its own pool, a first address and a count.
      for (const input of ['pool_start', 'pool_end']) {
        const value = str(values, input, '');
        if (familyOf(value) !== 4) {
          findings.push(
            error('network.asa.bad-pool', `${input === 'pool_start' ? 'The pool start' : 'The pool end'} is not an IPv4 address. The ip local pool is IPv4 only; IPv6 clients take their address from the IPv6 pool.`, { source: 'ArchToolKit' }),
          );
        }
      }
      const v6PoolText = str(values, 'ipv6_pool', '');
      const v6Pool = v6PoolText ? parseCidrDual(v6PoolText) : null;
      if (v6PoolText && v6Pool?.family !== 6) {
        findings.push(error('network.asa.bad-ipv6-pool', 'The IPv6 pool is not an IPv6 address and prefix.', { remediation: 'Write it as 2001:db8:99::1/64.', source: 'ArchToolKit' }));
      }
      const pool6 = v6Pool?.family === 6 ? v6Pool : null;
      const pool6Name = `${pool}-V6`;
      if (splitV6 && !pool6) {
        findings.push(
          warning('network.asa.split-v6-no-pool', 'IPv6 networks are listed for the tunnel but there is no IPv6 pool. Clients get no IPv6 address on the VPN, so the IPv6 networks cannot be reached through it.', {
            remediation: 'Add an IPv6 pool, or remove the IPv6 networks.',
            source: 'ArchToolKit',
          }),
        );
      }
      const badDns = dns.filter((server) => !isIp(server));
      if (badDns.length > 0) findings.push(error('network.asa.bad-dns', `Not an IPv4 or IPv6 address: ${badDns.join(', ')}.`, { source: 'ArchToolKit' }));
      if (str(values, 'auth_server', '') === 'LOCAL') {
        findings.push(
          warning('network.asa.local-vpn-auth', 'Local accounts for remote access mean no central control, no MFA and no way to disable someone in one place.', {
            remediation: 'Authenticate against RADIUS or LDAP with MFA.',
            source: 'ArchToolKit',
          }),
        );
      }
      findings.push(
        warning('network.asa.vpn-mfa', 'Remote access without a second factor is a password away from being someone else’s VPN. Enforce MFA at the identity provider.', { source: 'ArchToolKit' }),
      );

      return {
        platform: PLATFORM,
        title: `Remote access VPN profile ${group}`,
        impact: 'brief',
        notes: [
          'AnyConnect needs its package on the flash and a licence. This configures the profile, not the client image.',
          'The identity certificate must be trusted by the clients, or every connection starts with a warning.',
          ...(split ? ['Split tunnelling sends only the listed networks over the VPN. Anything not listed goes out of the client’s own connection — which is the point, and also the risk.'] : ['Full tunnel sends everything through the firewall, including the user’s streaming. Size the internet link for it.']),
          'The pool must be routed back to the ASA by whatever is inside, or return traffic never arrives.',
          ...(pool6 ? [`The IPv6 pool ${pool6.network}/${pool6.prefix} needs the same: a route to the ASA for it inside. The clients are dual-stack on the tunnel, so IPv6 follows the ipv6-split-tunnel-policy rather than the IPv4 one.`] : []),
        ],
        before: ['show running-config tunnel-group', 'show running-config group-policy', 'show vpn-sessiondb anyconnect', 'show ip local pool'],
        config: [
          `ip local pool ${pool} ${str(values, 'pool_start', '')}-${str(values, 'pool_end', '')} mask ${str(values, 'pool_mask', '255.255.255.0')}`,
          ...(pool6 ? [`ipv6 local pool ${pool6Name} ${pool6.address}/${pool6.prefix} ${num(values, 'ipv6_pool_size', 250)}`] : []),
          '!',
          // A standard ACL is IPv4 only. With IPv6 networks in the split list it has to be an
          // extended one, each entry to any4 or any6, which split tunnelling accepts for both families.
          ...(split && networks.length > 0 && !splitV6
            ? [`access-list SPLIT-${group} standard permit ${networks.map((n) => `${n.address} ${netmask(n.prefix)}`).join(`\naccess-list SPLIT-${group} standard permit `)}`, '!']
            : []),
          ...(split && splitV6
            ? [...networks.map((n) => `access-list SPLIT-${group} extended permit ip ${asaNet(n)} ${n.family === 6 ? 'any6' : 'any4'}`), '!']
            : []),
          `group-policy ${group} internal`,
          `group-policy ${group} attributes`,
          ' vpn-tunnel-protocol ssl-client',
          ...(dns.length > 0 ? [` dns-server value ${dns.join(' ')}`] : []),
          ` default-domain value ${str(values, 'domain', 'corp.local')}`,
          ...(split ? [' split-tunnel-policy tunnelspecified', ` split-tunnel-network-list value SPLIT-${group}`] : [' split-tunnel-policy tunnelall']),
          ...(pool6 ? [` ipv6-split-tunnel-policy ${split && splitV6 ? 'tunnelspecified' : 'tunnelall'}`] : []),
          ' vpn-idle-timeout 30',
          ' vpn-session-timeout 720',
          '!',
          `tunnel-group ${group} type remote-access`,
          `tunnel-group ${group} general-attributes`,
          ` address-pool ${pool}`,
          ...(pool6 ? [` ipv6-address-pool ${pool6Name}`] : []),
          ` authentication-server-group ${str(values, 'auth_server', 'ISE-RADIUS')}`,
          ` default-group-policy ${group}`,
          `tunnel-group ${group} webvpn-attributes`,
          ` group-alias ${group} enable`,
          '!',
          'webvpn',
          ' enable outside',
          ' anyconnect enable',
          ` ssl trust-point ${str(values, 'certificate', 'ASDM_TrustPoint0')} outside`,
          ' tunnel-group-list enable',
          '!',
        ],
        verify: [
          'show vpn-sessiondb anyconnect',
          `show running-config tunnel-group ${group}`,
          'show ip local pool ' + pool,
          ...(pool6 ? [`show ipv6 local pool ${pool6Name}`] : []),
          'Connect a test client and check the routes it installs.',
        ],
        backout: [
          `no tunnel-group ${group}`,
          `no group-policy ${group}`,
          ...(split ? [`no access-list SPLIT-${group}`] : []),
          `no ip local pool ${pool}`,
          ...(pool6 ? [`no ipv6 local pool ${pool6Name}`] : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_failover',
    platform: PLATFORM,
    label: 'Active/standby failover',
    group: 'Baseline',
    description: 'The failover pair: the link, the state link, the addresses and the interface monitoring that decides when to switch.',
    inputs: [
      { id: 'role', label: 'This unit is', control: 'select', default: 'primary', options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] },
      { id: 'failover_interface', label: 'Failover link', control: 'text', default: 'GigabitEthernet0/3' },
      { id: 'failover_name', label: 'Failover interface name', control: 'text', default: 'folink' },
      { id: 'primary_address', label: 'Primary address on the link', control: 'text', default: '10.0.254.1/30', hint: 'IPv4 or IPv6 with prefix: 10.0.254.1/30 or fd00:254::1/64' },
      { id: 'secondary_address', label: 'Secondary address on the link', control: 'text', default: '10.0.254.2', hint: 'Same family and network as the primary' },
      { id: 'state_link', label: 'Separate state link', control: 'toggle', default: false, hint: 'On a busy pair, stateful replication deserves its own interface' },
      { id: 'state_interface', label: 'State link interface', control: 'text', default: 'GigabitEthernet0/4', showWhen: { input: 'state_link', equals: ['true'] } },
      { id: 'monitored', label: 'Monitored interfaces', control: 'text', default: 'inside, outside' },
      { id: 'key', label: 'Encrypt the failover link', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const primary = str(values, 'role', 'primary') === 'primary';
      const link = str(values, 'failover_interface', '');
      const name = str(values, 'failover_name', 'folink');
      const cidr = parseCidrDual(str(values, 'primary_address', ''));
      const secondary = str(values, 'secondary_address', '');
      const state = bool(values, 'state_link', false);
      const monitored = listOf(str(values, 'monitored', ''));
      const findings            = [];
      if (!cidr) findings.push(error('network.asa.bad-failover-address', 'The primary address on the failover link is not a valid IPv4 or IPv6 address and prefix.', { source: 'ArchToolKit' }));
      if (cidr && (!isIp(secondary) || familyOf(secondary) !== cidr.family || !containsAny(`${cidr.network}/${cidr.prefix}`, secondary))) {
        findings.push(error('network.asa.bad-failover-standby', `The secondary address must be an IPv${cidr.family} address in ${cidr.network}/${cidr.prefix}, the same network as the primary.`, { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Failover, ${primary ? 'primary' : 'secondary'} unit`,
        impact: 'outage',
        notes: [
          'Configure the primary fully first. The secondary needs only the failover commands — everything else replicates to it, and anything configured on it directly is overwritten.',
          'Both units must be the same model, the same software version and have the same modules, or the pair will not form.',
          ...(bool(values, 'key', true) ? [`The failover key is ${SECRET}. Without one, the state and configuration replication crosses the link in the clear.`] : []),
          'Enabling failover on a live firewall interrupts traffic while the pair negotiates.',
          'Every data interface needs a standby address as well, IPv4 and IPv6 alike (ip address … standby …, ipv6 address …/len standby …), or the standby unit cannot be monitored on it. The interface change has fields for both.',
        ],
        before: ['show failover', 'show failover state', 'show version | include Version|Model', 'show interface ip brief'],
        config: [
          `interface ${link}`,
          ' no shutdown',
          '!',
          ...(state ? [`interface ${str(values, 'state_interface', '')}`, ' no shutdown', '!'] : []),
          `failover lan unit ${primary ? 'primary' : 'secondary'}`,
          `failover lan interface ${name} ${link}`,
          ...(bool(values, 'key', true) ? [`failover key ${SECRET}`] : []),
          // IPv6 on the failover link is address/prefix, like everywhere else on the ASA.
          `failover interface ip ${name} ${cidr ? (cidr.family === 4 ? `${cidr.address} ${netmask(cidr.prefix)}` : `${cidr.address}/${cidr.prefix}`) : '<REQUIRED>'} standby ${secondary}`,
          ...(state
            ? [`failover link statelink ${str(values, 'state_interface', '')}`, `failover interface ip statelink 10.0.253.1 255.255.255.252 standby 10.0.253.2`]
            : [`failover link ${name} ${link}`]),
          'failover replication http',
          ...monitored.map((iface) => `monitor-interface ${iface}`),
          'failover polltime unit 1 holdtime 3',
          'failover polltime interface 5 holdtime 25',
          'failover',
          '!',
        ],
        verify: ['show failover', 'show failover state', 'show monitor-interface', 'failover exec standby show version | include Version'],
        backout: ['no failover', 'no failover lan interface ' + name],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_management',
    platform: PLATFORM,
    label: 'Management access and AAA',
    group: 'Baseline',
    description: 'SSH and ASDM restricted to a management network, TACACS+ with a local fallback, NTP, syslog and SNMPv3.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'asa-edge-01' },
      { id: 'domain', label: 'Domain name', control: 'text', default: 'corp.local' },
      { id: 'management_network', label: 'Management source networks', control: 'text', default: '10.0.0.0/24', hint: 'IPv4 and/or IPv6, comma separated: 10.0.0.0/24, 2001:db8:0:10::/64' },
      { id: 'management_interface', label: 'Management interface', control: 'text', default: 'inside' },
      { id: 'tacacs_servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.30, 10.0.0.31', hint: 'IPv4 or IPv6' },
      { id: 'local_user', label: 'Local fallback username', control: 'text', default: 'netadmin' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11', hint: 'IPv4 or IPv6' },
      { id: 'syslog_server', label: 'Syslog server', control: 'text', default: '10.0.0.20', hint: 'IPv4 or IPv6' },
      { id: 'syslog_level', label: 'Syslog level', control: 'select', default: 'informational', options: [
        { value: 'informational', label: 'Informational' },
        { value: 'notifications', label: 'Notifications' },
        { value: 'warnings', label: 'Warnings' },
      ] },
    ],
    change: (values                 )               => {
      const parsed = networksOf(str(values, 'management_network', ''));
      const mgmtNets = parsed.nets;
      const iface = str(values, 'management_interface', 'inside');
      const tacacs = listOf(str(values, 'tacacs_servers', ''));
      const user = str(values, 'local_user', 'netadmin');
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = str(values, 'syslog_server', '');
      const findings            = [];
      if (mgmtNets.length === 0) findings.push(error('network.asa.no-management-network', 'A management source network is required — SSH on an ASA needs one, and an open one is a bad idea.', { source: 'ArchToolKit' }));
      if (parsed.invalid.length > 0) findings.push(error('network.asa.bad-management-network', `Not a network with a prefix: ${parsed.invalid.join(', ')}.`, { source: 'ArchToolKit' }));
      if (mgmtNets.some((n) => isAnyNetwork(`${n.network}/${n.prefix}`))) {
        findings.push(warning('network.asa.management-open', 'The management network is 0.0.0.0/0 or ::/0: SSH and ASDM would answer the whole internet on that interface.', { source: 'ArchToolKit' }));
      }
      // logging host takes an address, not a name; the AAA and NTP servers may be names on newer releases.
      if (syslog && !isIp(syslog)) findings.push(error('network.asa.bad-syslog', `The syslog server ${syslog} is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      // SSH/HTTP access: IPv4 as address and mask, IPv6 as prefix/length.
      const access = (verb        , n     )         => `${verb} ${asaNet(n)} ${iface}`;
      const anyV6 = mgmtNets.some((n) => n.family === 6) || [...tacacs, ...ntp, syslog].some((server) => familyOf(server) === 6);

      return {
        platform: PLATFORM,
        title: 'Management access, AAA, NTP and logging',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET}: the TACACS+ key, the local password and the SNMPv3 credentials.`,
          'Keep a second session open. If the TACACS+ key is wrong, the local account is the only way back in.',
          'Generate the SSH key separately: `crypto key generate rsa modulus 4096`. It is interactive and cannot be pasted in a block.',
          ...(anyV6
            ? [
                `IPv6 management needs an IPv6 address on ${iface} (ipv6 address …/len and ipv6 enable).`,
                ...(tacacs.some((server) => familyOf(server) === 6) ? ['VERIFY: TACACS+ servers by IPv6 address are accepted only by later 9.x releases. Check the running release takes an IPv6 aaa-server host before relying on it.'] : []),
                ...(ntp.some((server) => familyOf(server) === 6) ? ['VERIFY: NTP servers by IPv6 address are accepted only by later 9.x releases. Check the running release takes an IPv6 ntp server before relying on it.'] : []),
              ]
            : []),
        ],
        before: ['show running-config ssh', 'show running-config aaa', 'show running-config logging', 'show ntp status'],
        config: [
          `hostname ${str(values, 'hostname', 'asa')}`,
          `domain-name ${str(values, 'domain', 'corp.local')}`,
          '!',
          `username ${user} password ${SECRET} privilege 15`,
          '!',
          ...tacacs.flatMap((server) => [`aaa-server TACACS-GROUP protocol tacacs+`, `aaa-server TACACS-GROUP (${iface}) host ${server}`, ` key ${SECRET}`, ' timeout 3', '!']),
          'aaa authentication ssh console TACACS-GROUP LOCAL',
          'aaa authentication enable console TACACS-GROUP LOCAL',
          'aaa authorization exec authentication-server auto-enable',
          'aaa accounting command TACACS-GROUP',
          '!',
          ...mgmtNets.flatMap((n) => [access('ssh', n), access('http', n)]),
          'ssh version 2',
          'ssh cipher encryption high',
          'ssh timeout 10',
          'http server enable',
          'console timeout 10',
          '!',
          ...ntp.map((server) => `ntp server ${server}`),
          '!',
          'logging enable',
          'logging timestamp',
          'logging buffered informational',
          `logging trap ${str(values, 'syslog_level', 'informational')}`,
          `logging host ${iface} ${syslog}`,
          '!',
        ],
        verify: ['show running-config ssh', 'show aaa-server TACACS-GROUP', 'show ntp associations', 'show logging | include Syslog', 'Log in from a second session before closing this one.'],
        backout: [
          'no aaa authentication ssh console TACACS-GROUP LOCAL',
          'no aaa-server TACACS-GROUP protocol tacacs+',
          ...mgmtNets.map((n) => `no ${access('ssh', n)}`),
          ...ntp.map((server) => `no ntp server ${server}`),
          `no logging host ${iface} ${syslog}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_inspection',
    platform: PLATFORM,
    label: 'Inspection policy',
    group: 'Policy',
    description: 'The global policy map: which protocols are inspected, and the timeouts and TCP checks that go with them.',
    inputs: [
      { id: 'enable', label: 'Protocols to inspect', control: 'text', default: 'ftp, dns, esmtp, sip, tftp, icmp', hint: 'ICMP inspection is what makes ping and traceroute work through the firewall' },
      { id: 'disable', label: 'Protocols to stop inspecting', control: 'text', default: '', hint: 'SIP and ESMTP inspection break as much as they fix on modern applications' },
      { id: 'dns_length', label: 'Maximum DNS message length', control: 'number', default: 4096, min: 512, max: 65535, hint: '512 is the old default and breaks DNSSEC and EDNS' },
      { id: 'tcp_timeout', label: 'TCP idle timeout (minutes)', control: 'number', default: 60, min: 1, max: 1440 },
    ],
    change: (values                 )               => {
      const enable = listOf(str(values, 'enable', ''));
      const disable = listOf(str(values, 'disable', ''));
      const findings            = [];
      if (enable.includes('sip') || enable.includes('esmtp')) {
        findings.push(
          warning('network.asa.inspection-breaks-things', 'SIP and ESMTP inspection rewrite traffic and are a common cause of "it works everywhere except through the firewall".', {
            remediation: 'Turn them off unless something specifically needs them.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!enable.includes('icmp')) {
        findings.push(
          warning('network.asa.no-icmp-inspection', 'Without ICMP inspection, ping and traceroute through the firewall do not return, and path MTU discovery can break.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Inspection: ${enable.length} protocol(s) on, ${disable.length} off`,
        impact: 'brief',
        notes: [
          'This edits the global policy that every interface uses. Turning an inspection off drops the connections that were relying on it to be translated.',
          'Change one protocol at a time on a production firewall and watch the application, not the firewall.',
        ],
        before: ['show service-policy', 'show running-config policy-map', 'show conn count'],
        config: [
          'policy-map type inspect dns preset_dns_map',
          ' parameters',
          `  message-length maximum ${num(values, 'dns_length', 4096)}`,
          '  no tcp-inspection',
          '!',
          'policy-map global_policy',
          ' class inspection_default',
          ...enable.map((protocol) => `  inspect ${protocol}${protocol === 'dns' ? ' preset_dns_map' : ''}`),
          ...disable.map((protocol) => `  no inspect ${protocol}`),
          '!',
          `timeout conn ${num(values, 'tcp_timeout', 60)}:00:00 half-closed 0:10:00 udp 0:02:00 icmp 0:00:02`,
          'service-policy global_policy global',
          '!',
        ],
        verify: ['show service-policy', 'show service-policy inspect dns', 'show conn count', 'Test the applications that use the protocols you changed.'],
        backout: ['policy-map global_policy', ' class inspection_default', ...enable.map((protocol) => `  no inspect ${protocol}`), '!'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_capture',
    platform: PLATFORM,
    label: 'Packet capture and packet-tracer',
    group: 'Operations',
    description: 'A capture on an interface with a matching access list, and the packet-tracer command that explains what the firewall would do — the two tools that answer "why is this being dropped".',
    inputs: [
      { id: 'capture_name', label: 'Capture name', control: 'text', default: 'CAP-TROUBLESHOOT' },
      { id: 'interface', label: 'Interface', control: 'text', default: 'outside' },
      { id: 'source', label: 'Source', control: 'text', default: '203.0.113.9', hint: 'IPv4 or IPv6' },
      { id: 'destination', label: 'Destination', control: 'text', default: '10.20.30.11', hint: 'The same family as the source' },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'tcp', options: [{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }, { value: 'icmp', label: 'ICMP' }, { value: 'ip', label: 'Any' }] },
      { id: 'port', label: 'Port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'buffer_kb', label: 'Buffer (KB)', control: 'number', default: 512, min: 64, max: 33554432 },
      { id: 'asp_drop', label: 'Also capture what the firewall drops', control: 'toggle', default: true, hint: 'A capture of type asp-drop shows the reason code for every dropped packet' },
    ],
    change: (values                 )               => {
      const name = str(values, 'capture_name', 'CAP').toUpperCase().replace(/\s+/g, '-');
      const iface = str(values, 'interface', 'outside');
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      const protocol = str(values, 'protocol', 'tcp');
      const port = num(values, 'port', 443);
      const acl = `${name}-ACL`;
      const findings            = [];
      if (!isIp(source) || !isIp(destination)) {
        findings.push(error('network.asa.capture-bad-address', 'The source and destination must each be an IPv4 or IPv6 address.', { source: 'ArchToolKit' }));
      } else if (familyOf(source) !== familyOf(destination)) {
        findings.push(error('network.asa.capture-mixed-family', 'The source and destination are different address families. A packet has one family, so this capture would match nothing.', { source: 'ArchToolKit' }));
      }
      const aceProtocol = protocol === 'icmp' && familyOf(source) === 6 ? 'icmp6' : protocol;
      const ported = protocol === 'tcp' || protocol === 'udp';

      return {
        platform: PLATFORM,
        title: `Capture ${name} on ${iface}`,
        impact: 'none',
        notes: [
          'A capture costs CPU and memory in proportion to what it matches. Always match narrowly, and always remove it afterwards — `no capture` is in the back-out for a reason.',
          '`packet-tracer` is usually faster than a capture: it tells you which rule, NAT entry or route decided the packet’s fate without waiting for the traffic to happen again.',
          'A capture buffer fills and stops. `show capture <name>` shows how full it is.',
        ],
        before: ['show capture', 'show conn count', 'show cpu usage'],
        config: [
          `access-list ${acl} extended permit ${aceProtocol} host ${source} host ${destination}${ported ? ` eq ${port}` : ''}`,
          // The reply comes from the port, so it is the source port on the return line.
          `access-list ${acl} extended permit ${aceProtocol} host ${destination}${ported ? ` eq ${port}` : ''} host ${source}`,
          `capture ${name} interface ${iface} access-list ${acl} buffer ${num(values, 'buffer_kb', 512) * 1024} circular-buffer`,
          ...(bool(values, 'asp_drop', true) ? [`capture ${name}-DROP type asp-drop all buffer ${num(values, 'buffer_kb', 512) * 1024} circular-buffer`] : []),
        ],
        verify: [
          `show capture ${name}`,
          `show capture ${name} decode | include ${destination}`,
          ...(bool(values, 'asp_drop', true) ? [`show capture ${name}-DROP | include ${source}`] : []),
          `packet-tracer input ${iface} ${protocol} ${source} 12345 ${destination} ${port} detailed`,
          `copy /pcap capture:${name} tftp://10.0.0.50/${name}.pcap`,
        ],
        backout: [`no capture ${name}`, ...(bool(values, 'asp_drop', true) ? [`no capture ${name}-DROP`] : []), `no access-list ${acl}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'asa_threat_detection',
    platform: PLATFORM,
    label: 'Threat detection and connection limits',
    group: 'Policy',
    description: 'Basic and advanced threat detection, scanning-threat shunning, and per-client connection limits that stop one host exhausting the table.',
    inputs: [
      { id: 'basic', label: 'Basic threat detection', control: 'toggle', default: true, hint: 'Rates for drops, ACL denies and scanning. Cheap' },
      { id: 'advanced', label: 'Statistics by host', control: 'toggle', default: false, hint: 'Per-host statistics. Expensive on a busy firewall' },
      { id: 'scanning', label: 'Shun scanning hosts', control: 'toggle', default: false, hint: 'Blocks a host the firewall believes is scanning — including your own scanner' },
      { id: 'shun_duration', label: 'Shun duration (seconds)', control: 'number', default: 3600, min: 60, showWhen: { input: 'scanning', equals: ['true'] } },
      { id: 'conn_max', label: 'Maximum connections per client', control: 'number', default: 0, min: 0, hint: '0 for no limit' },
      { id: 'embryonic_max', label: 'Maximum half-open connections per client', control: 'number', default: 100, min: 0, hint: 'What absorbs a SYN flood from one source' },
      { id: 'class_name', label: 'Policy class name', control: 'text', default: 'CONN-LIMITS' },
    ],
    change: (values                 )               => {
      const scanning = bool(values, 'scanning', false);
      const advanced = bool(values, 'advanced', false);
      const connMax = num(values, 'conn_max', 0);
      const embryonic = num(values, 'embryonic_max', 100);
      const className = str(values, 'class_name', 'CONN-LIMITS').toUpperCase().replace(/\s+/g, '-');
      const findings            = [];
      if (scanning) {
        findings.push(
          warning('network.asa.shun', 'Scanning-threat shunning blocks hosts automatically. It will eventually block your own vulnerability scanner, a monitoring system, or a NAT address with many users behind it.', {
            remediation: 'Exempt the addresses you know about, and watch `show threat-detection shun` for a while before trusting it.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (advanced) {
        findings.push(
          warning('network.asa.threat-detection-cost', 'Per-host statistics cost CPU and memory on a busy firewall. Check `show cpu usage` after enabling it.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: 'Threat detection and connection limits',
        impact: 'brief',
        notes: [
          'Connection limits protect the firewall from one host, not the network from an attack. They are the thing that keeps the conn table usable during a flood.',
          'An embryonic limit turns on TCP intercept for that class, which changes how half-open connections are handled — test it against a real application before rolling it out.',
        ],
        before: ['show threat-detection rate', 'show conn count', 'show cpu usage', 'show running-config policy-map'],
        config: [
          ...(bool(values, 'basic', true) ? ['threat-detection basic-threat'] : ['no threat-detection basic-threat']),
          ...(advanced ? ['threat-detection statistics host', 'threat-detection statistics access-list', 'threat-detection statistics port', 'threat-detection statistics protocol'] : ['threat-detection statistics access-list']),
          ...(scanning ? [`threat-detection scanning-threat shun duration ${num(values, 'shun_duration', 3600)}`] : []),
          '!',
          ...(connMax > 0 || embryonic > 0
            ? [
                `class-map ${className}`,
                ' match any',
                '!',
                'policy-map global_policy',
                ` class ${className}`,
                `  set connection${connMax > 0 ? ` conn-max ${connMax}` : ''}${embryonic > 0 ? ` embryonic-conn-max ${embryonic}` : ''} per-client-max ${connMax > 0 ? connMax : 0} per-client-embryonic-max ${embryonic}`,
                '  set connection timeout embryonic 0:00:30',
                '!',
                'service-policy global_policy global',
              ]
            : []),
        ],
        verify: ['show threat-detection rate', 'show threat-detection statistics top', ...(scanning ? ['show threat-detection shun'] : []), 'show service-policy | include connection', 'show conn count'],
        backout: [
          ...(scanning ? ['no threat-detection scanning-threat shun'] : []),
          ...(advanced ? ['no threat-detection statistics host'] : []),
          ...(connMax > 0 || embryonic > 0 ? ['policy-map global_policy', ` no class ${className}`, '!', `no class-map ${className}`] : []),
        ],
        findings,
      };
    },
  }),
];

export const ASA_NETWORK                 = { target: PLATFORM, label: 'Cisco ASA (firewall)', blueprints: BLUEPRINTS };
export const ASA_CHANGES                             = BLUEPRINTS;

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
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { description, listOf, netmask, parseCidr,                   } from '../device.js';

const PLATFORM = 'cisco_asa'         ;
const SECRET = '<REQUIRED>';

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
      { id: 'address', label: 'Address', control: 'text', default: '10.20.30.1/24' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'DMZ' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 1500, min: 576, max: 9198 },
    ],
    change: (values                 )               => {
      const physical = str(values, 'interface', '');
      const vlan = num(values, 'subinterface', 0);
      const iface = vlan > 0 ? `${physical}.${vlan}` : physical;
      const name = str(values, 'nameif', 'dmz').toLowerCase();
      const level = num(values, 'security_level', 50);
      const cidr = parseCidr(str(values, 'address', ''));
      const findings            = [];
      if (!cidr) findings.push(error('network.asa.bad-address', 'The address is not a valid address and prefix.', { source: 'ArchToolKit' }));
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
          ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}`] : []),
          ...(num(values, 'mtu', 1500) !== 1500 ? [` mtu ${name} ${num(values, 'mtu', 1500)}`] : []),
          ' no shutdown',
          '!',
        ],
        verify: ['show interface ip brief', `show interface ${iface}`, 'show nameif', ...(cidr ? [`ping ${name} ${cidr.address}`] : [])],
        backout: [`interface ${iface}`, ' shutdown', ' no nameif', ' no ip address', '!', ...(vlan > 0 ? [`no interface ${iface}`] : [])],
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
      { id: 'networks', label: 'Network objects', control: 'textarea', default: 'APP-WEB-01 host 10.20.30.11\nAPP-WEB-02 host 10.20.30.12\nAPP-SUBNET subnet 10.20.31.0/24', hint: 'One per line: NAME host|subnet value' },
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
        if (entry.kind === 'subnet' && !parseCidr(entry.value)) {
          findings.push(error('network.asa.bad-subnet', `"${entry.value}" for ${entry.name} is not a valid prefix.`, { remediation: 'Write it as 10.20.31.0/24.', source: 'ArchToolKit' }));
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
            const cidr = entry.kind === 'subnet' ? parseCidr(entry.value) : null;
            return [
              `object network ${entry.name}`,
              entry.kind === 'host' ? ` host ${entry.value}` : ` subnet ${cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : '<REQUIRED>'}`,
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
      { id: 'source', label: 'Source', control: 'text', default: 'any4', hint: 'any4, an object name, or object-group NAME' },
      { id: 'destination', label: 'Destination', control: 'text', default: 'APP-WEB-01' },
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

      const asObject = (value        )         =>
        value.startsWith('object-group ') || value.startsWith('object ') || value === 'any' || value === 'any4' || value === 'any6' || /^\d+\.\d+\.\d+\.\d+/.test(value) ? value : `object ${value}`;

      if ((source === 'any' || source === 'any4') && action === 'permit' && protocol === 'ip') {
        findings.push(
          warning('network.asa.permit-any-ip', 'Permitting any IP from any source is not a rule, it is the absence of one.', { remediation: 'Name the protocol and the ports the service uses.', source: 'ArchToolKit' }),
        );
      }

      const portPart = protocol === 'icmp' || protocol === 'ip' ? '' : ports.startsWith('object-group ') ? ` ${ports}` : ` eq ${ports}`;

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
          `access-list ${acl} extended ${action} ${protocol} ${asObject(source)} ${asObject(destination)}${portPart}${log === 'disable' ? ' log disable' : log === 'informational' ? ' log informational' : ''}`,
          `access-group ${acl} ${str(values, 'direction', 'in')} interface ${iface}`,
        ],
        verify: [`show access-list ${acl}`, 'show running-config access-group', `packet-tracer input ${iface} ${protocol} 203.0.113.9 12345 <destination> ${ports || '443'} detailed`],
        backout: [
          `no access-list ${acl} extended ${action} ${protocol} ${asObject(source)} ${asObject(destination)}${portPart}`,
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
      { id: 'real_address', label: 'Real address or subnet', control: 'text', default: '10.20.30.11' },
      { id: 'mapped_address', label: 'Mapped address', control: 'text', default: '203.0.113.11', showWhen: { input: 'kind', equals: ['static'] } },
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
      const cidr = parseCidr(real);

      return {
        platform: PLATFORM,
        title: kind === 'static' ? `Publish ${real} as ${mapped}` : `PAT ${real} behind ${mappedInterface}`,
        impact: 'brief',
        notes: [
          'NAT is evaluated before the access list, and the access list then matches the **real** address. A published server needs both: this rule, and a rule permitting traffic to the inside address.',
          'Object NAT (this) sits in section 2 of the NAT table, after any manual twice-NAT rules. If something is not translating as expected, `show nat detail` shows the order and the hit counts.',
          ...(kind === 'static' ? ['The mapped address must be routed to this firewall, or reachable by proxy ARP on the outside segment.'] : []),
        ],
        before: ['show nat detail', 'show running-config nat', `show running-config object id ${object}`, 'show xlate count'],
        config: [
          `object network ${object}`,
          cidr && cidr.prefix < 32 ? ` subnet ${cidr.address} ${netmask(cidr.prefix)}` : ` host ${real}`,
          kind === 'static'
            ? translate
              ? ` nat (${realInterface},${mappedInterface}) static ${mapped} service tcp ${num(values, 'real_port', 8443)} ${num(values, 'mapped_port', 443)}`
              : ` nat (${realInterface},${mappedInterface}) static ${mapped}`
            : ` nat (${realInterface},${mappedInterface}) dynamic interface`,
          '!',
        ],
        verify: [
          'show nat detail',
          'show xlate | include ' + real,
          `packet-tracer input ${mappedInterface} tcp 203.0.113.9 12345 ${kind === 'static' ? mapped : '8.8.8.8'} 443 detailed`,
        ],
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
      { id: 'destination', label: 'Destination', control: 'text', default: '0.0.0.0/0' },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '203.0.113.1' },
      { id: 'distance', label: 'Administrative distance', control: 'number', default: 1, min: 1, max: 255 },
      { id: 'track', label: 'Track the next hop', control: 'toggle', default: true },
      { id: 'track_id', label: 'Track id', control: 'number', default: 1, min: 1, max: 500, showWhen: { input: 'track', equals: ['true'] } },
      { id: 'sla_target', label: 'Probe target', control: 'text', default: '8.8.8.8', showWhen: { input: 'track', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', 'outside');
      const cidr = parseCidr(str(values, 'destination', '0.0.0.0/0'));
      const gateway = str(values, 'gateway', '');
      const distance = num(values, 'distance', 1);
      const track = bool(values, 'track', true);
      const trackId = num(values, 'track_id', 1);
      const findings            = [];
      if (!cidr) findings.push(error('network.asa.bad-destination', 'The destination is not a valid prefix.', { source: 'ArchToolKit' }));

      const routeLine = `route ${iface} ${cidr ? cidr.address : '0.0.0.0'} ${cidr ? netmask(cidr.prefix) : '0.0.0.0'} ${gateway} ${distance}${track ? ` track ${trackId}` : ''}`;

      return {
        platform: PLATFORM,
        title: `Route ${cidr ? `${cidr.address}/${cidr.prefix}` : '(invalid)'} via ${gateway} on ${iface}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: [
          ...(cidr && cidr.prefix === 0 ? ['This is the default route. A wrong gateway takes the firewall — and everything behind it — off the internet.'] : []),
          ...(track ? ['The SLA monitor probes from this interface. Probe something beyond the next hop, or a dead upstream still looks alive.'] : []),
        ],
        before: ['show route', 'show running-config route', ...(track ? [`show sla monitor ${trackId} configuration`, `show track ${trackId}`] : [])],
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
        verify: ['show route', ...(track ? [`show track ${trackId}`, `show sla monitor ${trackId} operational-state`] : []), `ping ${iface} ${gateway}`],
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
      { id: 'peer', label: 'Peer address', control: 'text', default: '198.51.100.10' },
      { id: 'outside_interface', label: 'Outside interface', control: 'text', default: 'outside' },
      { id: 'local_networks', label: 'Local networks', control: 'textarea', default: '10.20.0.0/16' },
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
      const local = str(values, 'local_networks', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c)                                           => c !== null);
      const remote = str(values, 'remote_networks', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c)                                           => c !== null);
      const map = str(values, 'crypto_map', 'outside_map');
      const sequence = num(values, 'sequence', 10);
      const gcm = str(values, 'encryption', 'aes-gcm-256') === 'aes-gcm-256';
      const dh = str(values, 'dh_group', '20');
      const exempt = bool(values, 'nat_exempt', true);
      const acl = `VPN-${peer.replace(/\./g, '-')}`;
      const findings            = [];
      if (local.length === 0 || remote.length === 0) {
        findings.push(error('network.asa.vpn-networks', 'Both the local and the remote networks are needed: they are the interesting traffic.', { source: 'ArchToolKit' }));
      }
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
          ...local.flatMap((l) => remote.map((r) => `access-list ${acl} extended permit ip ${l.address} ${netmask(l.prefix)} ${r.address} ${netmask(r.prefix)}`)),
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
            ? local.flatMap((l, i) =>
                remote.map((r, j) => [
                  `object network VPN-LOCAL-${i}`,
                  ` subnet ${l.address} ${netmask(l.prefix)}`,
                  `object network VPN-REMOTE-${j}`,
                  ` subnet ${r.address} ${netmask(r.prefix)}`,
                  `nat (inside,${outside}) source static VPN-LOCAL-${i} VPN-LOCAL-${i} destination static VPN-REMOTE-${j} VPN-REMOTE-${j} no-proxy-arp route-lookup`,
                ].join('\n'),
                ),
              )
            : []),
        ],
        verify: [
          'show crypto ikev2 sa detail',
          `show crypto ipsec sa peer ${peer}`,
          `packet-tracer input inside tcp ${local[0]?.address ?? '10.20.0.10'} 12345 ${remote[0]?.address ?? '10.30.0.10'} 443 detailed`,
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
      { id: 'auth_server', label: 'Authentication server group', control: 'text', default: 'ISE-RADIUS', hint: 'Or LOCAL for a lab' },
      { id: 'split_tunnel', label: 'Split tunnelling', control: 'select', default: 'split', options: [
        { value: 'split', label: 'Split — only the listed networks go over the VPN' },
        { value: 'full', label: 'Full tunnel — everything goes over the VPN' },
      ] },
      { id: 'split_networks', label: 'Networks to tunnel', control: 'textarea', default: '10.20.0.0/16\n10.30.0.0/16', showWhen: { input: 'split_tunnel', equals: ['split'] } },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'domain', label: 'Default domain', control: 'text', default: 'corp.local' },
      { id: 'certificate', label: 'Identity certificate trustpoint', control: 'text', default: 'ASDM_TrustPoint0', hint: 'Must already exist — none is generated here' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'CORP-VPN').toUpperCase().replace(/\s+/g, '-');
      const pool = str(values, 'pool_name', 'VPN-POOL').toUpperCase().replace(/\s+/g, '-');
      const split = str(values, 'split_tunnel', 'split') === 'split';
      const networks = str(values, 'split_networks', '')
        .split(/\n+/)
        .map((line) => parseCidr(line.trim()))
        .filter((c)                                           => c !== null);
      const dns = listOf(str(values, 'dns_servers', ''));
      const findings            = [];
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
        ],
        before: ['show running-config tunnel-group', 'show running-config group-policy', 'show vpn-sessiondb anyconnect', 'show ip local pool'],
        config: [
          `ip local pool ${pool} ${str(values, 'pool_start', '')}-${str(values, 'pool_end', '')} mask ${str(values, 'pool_mask', '255.255.255.0')}`,
          '!',
          ...(split && networks.length > 0
            ? [`access-list SPLIT-${group} standard permit ${networks.map((n) => `${n.address} ${netmask(n.prefix)}`).join(`\naccess-list SPLIT-${group} standard permit `)}`, '!']
            : []),
          `group-policy ${group} internal`,
          `group-policy ${group} attributes`,
          ' vpn-tunnel-protocol ssl-client',
          ...(dns.length > 0 ? [` dns-server value ${dns.join(' ')}`] : []),
          ` default-domain value ${str(values, 'domain', 'corp.local')}`,
          ...(split ? [' split-tunnel-policy tunnelspecified', ` split-tunnel-network-list value SPLIT-${group}`] : [' split-tunnel-policy tunnelall']),
          ' vpn-idle-timeout 30',
          ' vpn-session-timeout 720',
          '!',
          `tunnel-group ${group} type remote-access`,
          `tunnel-group ${group} general-attributes`,
          ` address-pool ${pool}`,
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
        verify: ['show vpn-sessiondb anyconnect', `show running-config tunnel-group ${group}`, 'show ip local pool ' + pool, 'Connect a test client and check the routes it installs.'],
        backout: [`no tunnel-group ${group}`, `no group-policy ${group}`, ...(split ? [`no access-list SPLIT-${group}`] : []), `no ip local pool ${pool}`],
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
      { id: 'primary_address', label: 'Primary address on the link', control: 'text', default: '10.0.254.1/30' },
      { id: 'secondary_address', label: 'Secondary address on the link', control: 'text', default: '10.0.254.2' },
      { id: 'state_link', label: 'Separate state link', control: 'toggle', default: false, hint: 'On a busy pair, stateful replication deserves its own interface' },
      { id: 'state_interface', label: 'State link interface', control: 'text', default: 'GigabitEthernet0/4', showWhen: { input: 'state_link', equals: ['true'] } },
      { id: 'monitored', label: 'Monitored interfaces', control: 'text', default: 'inside, outside' },
      { id: 'key', label: 'Encrypt the failover link', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const primary = str(values, 'role', 'primary') === 'primary';
      const link = str(values, 'failover_interface', '');
      const name = str(values, 'failover_name', 'folink');
      const cidr = parseCidr(str(values, 'primary_address', ''));
      const state = bool(values, 'state_link', false);
      const monitored = listOf(str(values, 'monitored', ''));

      return {
        platform: PLATFORM,
        title: `Failover, ${primary ? 'primary' : 'secondary'} unit`,
        impact: 'outage',
        notes: [
          'Configure the primary fully first. The secondary needs only the failover commands — everything else replicates to it, and anything configured on it directly is overwritten.',
          'Both units must be the same model, the same software version and have the same modules, or the pair will not form.',
          ...(bool(values, 'key', true) ? [`The failover key is ${SECRET}. Without one, the state and configuration replication crosses the link in the clear.`] : []),
          'Enabling failover on a live firewall interrupts traffic while the pair negotiates.',
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
          `failover interface ip ${name} ${cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : '<REQUIRED>'} standby ${str(values, 'secondary_address', '')}`,
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
      { id: 'management_network', label: 'Management source network', control: 'text', default: '10.0.0.0/24' },
      { id: 'management_interface', label: 'Management interface', control: 'text', default: 'inside' },
      { id: 'tacacs_servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'local_user', label: 'Local fallback username', control: 'text', default: 'netadmin' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'syslog_server', label: 'Syslog server', control: 'text', default: '10.0.0.20' },
      { id: 'syslog_level', label: 'Syslog level', control: 'select', default: 'informational', options: [
        { value: 'informational', label: 'Informational' },
        { value: 'notifications', label: 'Notifications' },
        { value: 'warnings', label: 'Warnings' },
      ] },
    ],
    change: (values                 )               => {
      const mgmt = parseCidr(str(values, 'management_network', ''));
      const iface = str(values, 'management_interface', 'inside');
      const tacacs = listOf(str(values, 'tacacs_servers', ''));
      const user = str(values, 'local_user', 'netadmin');
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const findings            = [];
      if (!mgmt) findings.push(error('network.asa.no-management-network', 'A management source network is required — SSH on an ASA needs one, and an open one is a bad idea.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: 'Management access, AAA, NTP and logging',
        impact: 'brief',
        notes: [
          `Replace every ${SECRET}: the TACACS+ key, the local password and the SNMPv3 credentials.`,
          'Keep a second session open. If the TACACS+ key is wrong, the local account is the only way back in.',
          'Generate the SSH key separately: `crypto key generate rsa modulus 4096`. It is interactive and cannot be pasted in a block.',
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
          ...(mgmt ? [`ssh ${mgmt.address} ${netmask(mgmt.prefix)} ${iface}`, `http ${mgmt.address} ${netmask(mgmt.prefix)} ${iface}`] : []),
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
          `logging host ${iface} ${str(values, 'syslog_server', '')}`,
          '!',
        ],
        verify: ['show running-config ssh', 'show aaa-server TACACS-GROUP', 'show ntp associations', 'show logging | include Syslog', 'Log in from a second session before closing this one.'],
        backout: [
          'no aaa authentication ssh console TACACS-GROUP LOCAL',
          'no aaa-server TACACS-GROUP protocol tacacs+',
          ...(mgmt ? [`no ssh ${mgmt.address} ${netmask(mgmt.prefix)} ${iface}`] : []),
          ...ntp.map((server) => `no ntp server ${server}`),
          `no logging host ${iface} ${str(values, 'syslog_server', '')}`,
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
      { id: 'source', label: 'Source', control: 'text', default: '203.0.113.9' },
      { id: 'destination', label: 'Destination', control: 'text', default: '10.20.30.11' },
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
          `access-list ${acl} extended permit ${protocol} host ${source} host ${destination}${protocol === 'tcp' || protocol === 'udp' ? ` eq ${port}` : ''}`,
          `access-list ${acl} extended permit ${protocol} host ${destination} host ${source}${protocol === 'tcp' || protocol === 'udp' ? ` eq ${port}` : ''}`,
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

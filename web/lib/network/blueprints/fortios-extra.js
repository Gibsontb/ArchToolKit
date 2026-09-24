/**
 * Fortinet FortiOS, the rest of it.
 *
 * Interfaces and VLANs, zones, service objects, IP pools, DHCP, IPsec, SD-WAN
 * link health, administrative access, logging, SNMP and HA — the configuration
 * a FortiGate carries beyond its first policy.
 *
 * Every block applies as its `end` is entered: there is no commit to hold it
 * back, which is why each of these carries a back-out that can be pasted
 * straight away.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint, withPush,                      } from '../from-change.js';
import { listOf, netmask, parseCidr,                   } from '../device.js';

const PLATFORM = 'fortios'         ;
const VDOM = '{{ vdom | default("root") }}';

const BLUEPRINTS                             = [
  deviceBlueprint({
    id: 'fortios_interface',
    platform: PLATFORM,
    label: 'Interface or VLAN sub-interface',
    group: 'Network',
    description: 'A physical interface or a VLAN on one, with its address, role and the administrative access it answers.',
    inputs: [
      { id: 'name', label: 'Interface name', control: 'text', default: 'port2' },
      { id: 'kind', label: 'Kind', control: 'select', default: 'physical', options: [{ value: 'physical', label: 'Physical' }, { value: 'vlan', label: 'VLAN sub-interface' }] },
      { id: 'parent', label: 'Parent interface', control: 'text', default: 'port2', showWhen: { input: 'kind', equals: ['vlan'] } },
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 100, min: 1, max: 4094, showWhen: { input: 'kind', equals: ['vlan'] } },
      { id: 'address', label: 'Address', control: 'text', default: '10.20.30.1/24' },
      { id: 'role', label: 'Role', control: 'select', default: 'lan', options: [{ value: 'lan', label: 'LAN' }, { value: 'wan', label: 'WAN' }, { value: 'dmz', label: 'DMZ' }, { value: 'undefined', label: 'Undefined' }] },
      { id: 'allow_access', label: 'Administrative access', control: 'text', default: 'ping', hint: 'ping, https, ssh, snmp — as few as possible, and never on a WAN interface' },
      { id: 'alias', label: 'Alias', control: 'text', default: 'APP-TIER' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const kind = str(values, 'kind', 'physical');
      const vlan = num(values, 'vlan_id', 100);
      const parent = str(values, 'parent', 'port2');
      const name = kind === 'vlan' ? `${parent}.${vlan}` : str(values, 'name', 'port2');
      const cidr = parseCidr(str(values, 'address', ''));
      const access = listOf(str(values, 'allow_access', ''));
      const role = str(values, 'role', 'lan');
      const findings            = [];
      if (!cidr) findings.push(error('network.fortios.bad-address', 'The address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      if (role === 'wan' && access.some((a) => a === 'https' || a === 'ssh')) {
        findings.push(
          warning('network.fortios.wan-management', 'Administrative access on a WAN interface exposes the management interface to the internet.', {
            remediation: 'Manage it from the inside, or restrict it with a local-in policy and trusted hosts.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Interface ${name}${kind === 'vlan' ? ` (VLAN ${vlan} on ${parent})` : ''}`,
        impact: kind === 'vlan' ? 'none' : 'outage',
        notes: [
          ...(kind === 'physical' ? ['Changing the address on an interface you are managing through will end your session.'] : []),
          'An interface with no policy passes nothing — this creates the interface, not the permission.',
        ],
        before: [`show system interface ${name}`, 'get system interface physical', 'diagnose ip address list'],
        config: [
          'config system interface',
          `    edit "${name}"`,
          ...(kind === 'vlan' ? [`        set interface "${parent}"`, '        set vdom "root"', `        set vlanid ${vlan}`] : []),
          '        set mode static',
          ...(cidr ? [`        set ip ${cidr.address} ${netmask(cidr.prefix)}`] : []),
          ...(access.length > 0 ? [`        set allowaccess ${access.join(' ')}`] : ['        unset allowaccess']),
          `        set role ${role}`,
          `        set alias "${str(values, 'alias', '')}"`,
          '        set description ""',
          '        set status up',
          '    next',
          'end',
        ],
        verify: [`show system interface ${name}`, `diagnose ip address list | grep ${cidr ? cidr.address : ''}`, `execute ping-options source ${cidr ? cidr.address : ''}`],
        backout: ['config system interface', `    delete "${name}"`, 'end'],
        push: {
          module: 'fortinet.fortios.fortios_system_interface',
          args: {
            vdom: VDOM,
            state: 'present',
            system_interface: {
              name,
              ...(kind === 'vlan' ? { interface: parent, vlanid: vlan, type: 'vlan' } : {}),
              mode: 'static',
              ip: cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : '',
              allowaccess: access.join(' '),
              role,
              alias: str(values, 'alias', ''),
              description: '',
              status: 'up',
            },
          },
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_service_objects',
    platform: PLATFORM,
    label: 'Service objects and a group',
    group: 'Objects',
    description: 'Custom TCP and UDP services and a group, for the ports the built-in list does not cover.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'SVC-APP' },
      { id: 'services', label: 'Services', control: 'textarea', default: 'SVC-APP-HTTP tcp 8080\nSVC-APP-ADMIN tcp 9443\nSVC-APP-SYSLOG udp 5140', hint: 'One per line: NAME protocol port(s)' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'SVC').toUpperCase().replace(/\s+/g, '-');
      const entries = str(values, 'services', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 3)
        .map(([name, protocol, port]) => ({ name: String(name), protocol: String(protocol).toLowerCase(), port: String(port) }));
      const findings            = [];
      if (entries.length === 0) findings.push(error('network.fortios.no-services', 'No service objects were given.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `${entries.length} service object(s) and the group ${group}`,
        impact: 'none',
        notes: ['Check the built-in services first: FortiOS ships most of what anyone needs, and a duplicate under a new name is how two policies end up meaning different things.'],
        before: ['show firewall service custom', `show firewall service group ${group}`],
        config: [
          'config firewall service custom',
          ...entries.flatMap((entry) => [
            `    edit "${entry.name}"`,
            `        set ${entry.protocol === 'udp' ? 'udp-portrange' : 'tcp-portrange'} ${entry.port}`,
            '        set comment ""',
            '    next',
          ]),
          'end',
          '',
          'config firewall service group',
          `    edit "${group}"`,
          `        set member ${entries.map((e) => `"${e.name}"`).join(' ')}`,
          '    next',
          'end',
        ],
        verify: [`show firewall service group ${group}`, 'show firewall service custom | grep SVC-'],
        backout: ['config firewall service group', `    delete "${group}"`, 'end', 'config firewall service custom', ...entries.map((e) => `    delete "${e.name}"`), 'end'],
        push: {
          module: 'fortinet.fortios.fortios_firewall_service_custom',
          args: { vdom: VDOM, state: 'present', firewall_service_custom: { name: '{{ item.name }}', tcp_portrange: '{{ item.tcp | default(omit) }}', comment: '' } },
          after: [
            {
              name: `Group them as ${group}`,
              module: 'fortinet.fortios.fortios_firewall_service_group',
              args: { vdom: VDOM, state: 'present', firewall_service_group: { name: group, member: entries.map((e) => ({ name: e.name })) } },
            },
          ],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_ipsec_vpn',
    platform: PLATFORM,
    label: 'Site-to-site IPsec VPN',
    group: 'Network',
    description: 'A route-based IPsec tunnel — phase 1 interface, phase 2, the tunnel address, a static route and the policies that let traffic across.',
    inputs: [
      { id: 'tunnel_name', label: 'Tunnel name', control: 'text', default: 'VPN-BRANCH-01' },
      { id: 'remote_gateway', label: 'Remote gateway', control: 'text', default: '198.51.100.10' },
      { id: 'outgoing_interface', label: 'Outgoing interface', control: 'text', default: 'port1' },
      { id: 'local_subnet', label: 'Local subnet', control: 'text', default: '10.20.0.0/16' },
      { id: 'remote_subnet', label: 'Remote subnet', control: 'text', default: '10.30.0.0/16' },
      { id: 'proposal', label: 'Proposal', control: 'select', default: 'aes256gcm-prfsha384', options: [
        { value: 'aes256gcm-prfsha384', label: 'AES-256-GCM / SHA-384 (IKEv2)' },
        { value: 'aes256-sha256', label: 'AES-256 / SHA-256' },
      ] },
      { id: 'dh_group', label: 'DH group', control: 'select', default: '20', options: [{ value: '20', label: 'Group 20' }, { value: '19', label: 'Group 19' }, { value: '14', label: 'Group 14' }] },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const name = str(values, 'tunnel_name', 'VPN').toUpperCase().replace(/\s+/g, '-');
      const remote = str(values, 'remote_gateway', '');
      const local = parseCidr(str(values, 'local_subnet', ''));
      const far = parseCidr(str(values, 'remote_subnet', ''));
      const gcm = str(values, 'proposal', 'aes256gcm-prfsha384').includes('gcm');
      const dh = str(values, 'dh_group', '20');
      const findings            = [];
      if (!local || !far) findings.push(error('network.fortios.vpn-subnets', 'The local and remote subnets must both be valid prefixes.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `IPsec VPN ${name} to ${remote}`,
        impact: 'brief',
        notes: [
          'The pre-shared key is <REQUIRED>. Type the real one in, or take it from a vault.',
          'Both ends need matching proposals, DH group and selectors. A mismatch shows in `diagnose debug application ike -1`.',
          'This creates the tunnel and the address objects. It does not create the firewall policies — add those next, in both directions.',
        ],
        before: ['get vpn ipsec tunnel summary', 'diagnose vpn ike gateway list', 'get router info routing-table all'],
        config: [
          'config vpn ipsec phase1-interface',
          `    edit "${name}"`,
          `        set interface "${str(values, 'outgoing_interface', 'port1')}"`,
          '        set ike-version 2',
          '        set peertype any',
          '        set net-device disable',
          `        set proposal ${gcm ? 'aes256gcm-prfsha384' : 'aes256-sha256'}`,
          `        set dhgrp ${dh}`,
          `        set remote-gw ${remote}`,
          '        set psksecret <REQUIRED>',
          '        set dpd on-idle',
          '        set comments ""',
          '    next',
          'end',
          '',
          'config vpn ipsec phase2-interface',
          `    edit "${name}-p2"`,
          `        set phase1name "${name}"`,
          `        set proposal ${gcm ? 'aes256gcm' : 'aes256-sha256'}`,
          `        set dhgrp ${dh}`,
          ...(local ? [`        set src-subnet ${local.address} ${netmask(local.prefix)}`] : []),
          ...(far ? [`        set dst-subnet ${far.address} ${netmask(far.prefix)}`] : []),
          '        set auto-negotiate enable',
          '    next',
          'end',
          '',
          'config firewall address',
          `    edit "${name}-LOCAL"`,
          ...(local ? [`        set subnet ${local.address} ${netmask(local.prefix)}`] : []),
          '    next',
          `    edit "${name}-REMOTE"`,
          ...(far ? [`        set subnet ${far.address} ${netmask(far.prefix)}`] : []),
          '    next',
          'end',
          '',
          'config router static',
          '    edit 0',
          ...(far ? [`        set dst ${far.address} ${netmask(far.prefix)}`] : []),
          `        set device "${name}"`,
          '        set comment ""',
          '    next',
          'end',
        ],
        verify: [`diagnose vpn tunnel list name ${name}`, 'get vpn ipsec tunnel summary', 'diagnose vpn ike gateway list', 'get router info routing-table static'],
        backout: [
          'config router static',
          '    ! delete the sequence number the route was given',
          'end',
          'config vpn ipsec phase2-interface',
          `    delete "${name}-p2"`,
          'end',
          'config vpn ipsec phase1-interface',
          `    delete "${name}"`,
          'end',
          'config firewall address',
          `    delete "${name}-LOCAL"`,
          `    delete "${name}-REMOTE"`,
          'end',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_ip_pool',
    platform: PLATFORM,
    label: 'IP pool for NAT',
    group: 'Policy',
    description: 'A pool of addresses for policies to translate behind, instead of the interface address.',
    inputs: [
      { id: 'pool_name', label: 'Pool name', control: 'text', default: 'POOL-OUTBOUND' },
      { id: 'kind', label: 'Type', control: 'select', default: 'overload', options: [
        { value: 'overload', label: 'Overload — many behind few, with ports' },
        { value: 'one-to-one', label: 'One to one' },
        { value: 'fixed-port-range', label: 'Fixed port range' },
      ] },
      { id: 'start_ip', label: 'First address', control: 'text', default: '203.0.113.20' },
      { id: 'end_ip', label: 'Last address', control: 'text', default: '203.0.113.24' },
      { id: 'arp_reply', label: 'Reply to ARP for these addresses', control: 'toggle', default: true },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const name = str(values, 'pool_name', 'POOL').toUpperCase().replace(/\s+/g, '-');
      const kind = str(values, 'kind', 'overload');

      return {
        platform: PLATFORM,
        title: `IP pool ${name} (${kind})`,
        impact: 'none',
        notes: [
          'A pool does nothing until a policy uses it. The policy needs `set nat enable`, `set ippool enable` and this pool named.',
          'The addresses have to be routed to this firewall by whatever is upstream, or the return traffic never comes back.',
        ],
        before: [`show firewall ippool ${name}`, 'get system arp'],
        config: [
          'config firewall ippool',
          `    edit "${name}"`,
          `        set type ${kind}`,
          `        set startip ${str(values, 'start_ip', '')}`,
          `        set endip ${str(values, 'end_ip', '')}`,
          `        set arp-reply ${bool(values, 'arp_reply', true) ? 'enable' : 'disable'}`,
          '        set comments ""',
          '    next',
          'end',
        ],
        verify: [`show firewall ippool ${name}`, 'diagnose firewall ippool list', 'get system arp'],
        backout: ['config firewall ippool', `    delete "${name}"`, 'end'],
        push: {
          module: 'fortinet.fortios.fortios_firewall_ippool',
          args: {
            vdom: VDOM,
            state: 'present',
            firewall_ippool: { name, type: kind, startip: str(values, 'start_ip', ''), endip: str(values, 'end_ip', ''), arp_reply: bool(values, 'arp_reply', true) ? 'enable' : 'disable', comments: '' },
          },
        },
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_dhcp_server',
    platform: PLATFORM,
    label: 'DHCP server on an interface',
    group: 'Services',
    description: 'A DHCP scope served by the FortiGate on one of its interfaces, with reservations and the usual options.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'port2' },
      { id: 'range_start', label: 'Range start', control: 'text', default: '10.20.30.100' },
      { id: 'range_end', label: 'Range end', control: 'text', default: '10.20.30.200' },
      { id: 'netmask', label: 'Netmask', control: 'text', default: '255.255.255.0' },
      { id: 'gateway', label: 'Default gateway', control: 'text', default: '10.20.30.1' },
      { id: 'dns', label: 'DNS servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'domain', label: 'Domain', control: 'text', default: 'corp.local' },
      { id: 'lease_seconds', label: 'Lease (seconds)', control: 'number', default: 86400, min: 300 },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', 'port2');
      const dns = listOf(str(values, 'dns', ''));

      return {
        platform: PLATFORM,
        title: `DHCP server on ${iface}`,
        impact: 'none',
        notes: [
          'Check nothing else is serving DHCP on that segment. Two servers is worse than none.',
          'The range must not overlap anything static, including the gateway and any VIPs.',
        ],
        before: ['show system dhcp server', 'execute dhcp lease-list', `show system interface ${iface}`],
        config: [
          'config system dhcp server',
          '    edit 0',
          '        set status enable',
          `        set interface "${iface}"`,
          `        set netmask ${str(values, 'netmask', '255.255.255.0')}`,
          `        set default-gateway ${str(values, 'gateway', '')}`,
          '        set dns-service specify',
          ...dns.map((server, i) => `        set dns-server${i + 1} ${server}`),
          `        set domain "${str(values, 'domain', '')}"`,
          `        set lease-time ${num(values, 'lease_seconds', 86400)}`,
          '        config ip-range',
          '            edit 1',
          `                set start-ip ${str(values, 'range_start', '')}`,
          `                set end-ip ${str(values, 'range_end', '')}`,
          '            next',
          '        end',
          '    next',
          'end',
        ],
        verify: ['show system dhcp server', 'execute dhcp lease-list', `diagnose debug application dhcps -1`],
        backout: ['config system dhcp server', '    ! delete the id this server was given (show system dhcp server)', 'end'],
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_sdwan',
    platform: PLATFORM,
    label: 'SD-WAN zone and health checks',
    group: 'Network',
    description: 'SD-WAN members, a performance SLA that measures each link, and a rule that steers traffic to the one that is healthy.',
    inputs: [
      { id: 'members', label: 'Members', control: 'textarea', default: 'port1 203.0.113.1 1\nport3 198.51.100.1 2', hint: 'One per line: interface gateway cost' },
      { id: 'health_server', label: 'Health check target', control: 'text', default: '8.8.8.8' },
      { id: 'latency_threshold', label: 'Latency threshold (ms)', control: 'number', default: 200, min: 1 },
      { id: 'loss_threshold', label: 'Packet loss threshold (%)', control: 'number', default: 2, min: 0, max: 100 },
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'CRITICAL-APPS' },
      { id: 'rule_destination', label: 'Rule destination', control: 'text', default: 'all', hint: 'An address object name' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const members = str(values, 'members', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const target = str(values, 'health_server', '');
      const rule = str(values, 'rule_name', 'RULE').toUpperCase().replace(/\s+/g, '-');
      const findings            = [];
      if (members.length < 2) {
        findings.push(warning('network.fortios.sdwan-one-member', 'SD-WAN with one member has nothing to steer between.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `SD-WAN with ${members.length} member(s)`,
        impact: 'outage',
        notes: [
          'Moving interfaces into SD-WAN removes their existing static routes and any policies that reference them directly. Capture both first.',
          'Policies must reference the SD-WAN zone, not the member interfaces, afterwards.',
          'The health check target has to be reachable over every member, or a healthy link will be marked dead.',
        ],
        before: ['diagnose sys sdwan member', 'get router info routing-table all', 'show firewall policy | grep -f srcintf'],
        config: [
          'config system sdwan',
          '    set status enable',
          '    config zone',
          '        edit "virtual-wan-link"',
          '        next',
          '    end',
          '    config members',
          ...members.flatMap((parts, i) => [
            `        edit ${i + 1}`,
            `            set interface "${parts[0]}"`,
            `            set gateway ${parts[1]}`,
            `            set cost ${parts[2] ?? 0}`,
            '        next',
          ]),
          '    end',
          '    config health-check',
          '        edit "HC-INTERNET"',
          `            set server "${target}"`,
          '            set protocol ping',
          '            set interval 500',
          '            set failtime 5',
          '            set recoverytime 10',
          `            set members ${members.map((_, i) => i + 1).join(' ')}`,
          '            config sla',
          '                edit 1',
          `                    set latency-threshold ${num(values, 'latency_threshold', 200)}`,
          `                    set packetloss-threshold ${num(values, 'loss_threshold', 2)}`,
          '                next',
          '            end',
          '        next',
          '    end',
          '    config service',
          '        edit 1',
          `            set name "${rule}"`,
          `            set dst "${str(values, 'rule_destination', 'all')}"`,
          '            set mode sla',
          '            config sla',
          '                edit "HC-INTERNET"',
          '                    set id 1',
          '                next',
          '            end',
          `            set priority-members ${members.map((_, i) => i + 1).join(' ')}`,
          '        next',
          '    end',
          'end',
        ],
        verify: ['diagnose sys sdwan member', 'diagnose sys sdwan health-check', 'diagnose sys sdwan service', 'get router info routing-table all'],
        backout: ['config system sdwan', '    set status disable', 'end'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_admin_access',
    platform: PLATFORM,
    label: 'Administrative access and trusted hosts',
    group: 'Baseline',
    description: 'An administrator restricted to trusted source addresses, with the global timeouts, the management ports and HTTP redirected to HTTPS.',
    inputs: [
      { id: 'admin_user', label: 'Administrator', control: 'text', default: 'netadmin' },
      { id: 'trusted_hosts', label: 'Trusted hosts', control: 'text', default: '10.0.0.0/24', hint: 'Up to ten prefixes; anything else is refused even with the right password' },
      { id: 'https_port', label: 'HTTPS port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'ssh_port', label: 'SSH port', control: 'number', default: 22, min: 1, max: 65535 },
      { id: 'idle_timeout', label: 'Idle timeout (minutes)', control: 'number', default: 15, min: 1, max: 480 },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const user = str(values, 'admin_user', 'netadmin');
      const trusted = listOf(str(values, 'trusted_hosts', ''))
        .map((prefix) => parseCidr(prefix))
        .filter((c)                                           => c !== null);
      const findings            = [];
      if (trusted.length === 0) {
        findings.push(
          error('network.fortios.no-trusted-hosts', 'No trusted hosts, so the administrator can log in from anywhere that can reach the interface.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Administrative access for ${user}`,
        impact: 'brief',
        notes: [
          'Trusted hosts take effect immediately. If your own address is not in the list, this is the last command you run.',
          'The password is <REQUIRED>: set it interactively or from a vault.',
          'Changing the HTTPS or SSH port ends the sessions using the old one.',
        ],
        before: ['show system admin', 'show system global | grep -f timeout', 'get system status'],
        config: [
          'config system admin',
          `    edit "${user}"`,
          '        set accprofile "super_admin"',
          '        set password <REQUIRED>',
          ...trusted.map((host, i) => `        set trusthost${i + 1} ${host.address} ${netmask(host.prefix)}`),
          '        set comments ""',
          '    next',
          'end',
          '',
          'config system global',
          `    set admin-sport ${num(values, 'https_port', 443)}`,
          `    set admin-ssh-port ${num(values, 'ssh_port', 22)}`,
          `    set admintimeout ${num(values, 'idle_timeout', 15)}`,
          '    set admin-https-redirect enable',
          '    set admin-telnet disable',
          '    set strong-crypto enable',
          '    set admin-lockout-threshold 3',
          '    set admin-lockout-duration 300',
          'end',
        ],
        verify: ['show system admin', 'show system global | grep -f admin', 'Log in from a second session before closing this one.'],
        backout: ['config system admin', `    edit "${user}"`, '        unset trusthost1', '    next', 'end'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_logging',
    platform: PLATFORM,
    label: 'Logging: syslog, FortiAnalyzer and SNMP',
    group: 'Operations',
    description: 'Where the logs go, what is logged, and the SNMP community or v3 user a monitoring system reads.',
    inputs: [
      { id: 'syslog_server', label: 'Syslog server', control: 'text', default: '10.0.0.20' },
      { id: 'syslog_port', label: 'Syslog port', control: 'number', default: 514, min: 1, max: 65535 },
      { id: 'syslog_mode', label: 'Syslog transport', control: 'select', default: 'udp', options: [{ value: 'udp', label: 'UDP' }, { value: 'reliable', label: 'TCP (reliable)' }] },
      { id: 'faz_server', label: 'FortiAnalyzer', control: 'text', default: '', hint: 'Optional' },
      { id: 'snmp_version', label: 'SNMP', control: 'select', default: 'v3', options: [{ value: 'v3', label: 'v3 (authenticated and encrypted)' }, { value: 'none', label: 'None' }] },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor', showWhen: { input: 'snmp_version', equals: ['v3'] } },
      { id: 'snmp_host', label: 'SNMP manager address', control: 'text', default: '10.0.0.40', showWhen: { input: 'snmp_version', equals: ['v3'] } },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const syslog = str(values, 'syslog_server', '');
      const faz = str(values, 'faz_server', '');
      const snmp = str(values, 'snmp_version', 'v3') === 'v3';
      const user = str(values, 'snmp_user', 'monitor');

      return {
        platform: PLATFORM,
        title: 'Logging and SNMP',
        impact: 'none',
        notes: [
          'Log everything to disk as well if the model has one — a syslog server that goes away should not take the evidence with it.',
          ...(snmp ? [`The SNMPv3 authentication and privacy passwords are <REQUIRED>.`] : []),
          'Traffic logging is verbose. Check the collector can take it before enabling it on every policy.',
        ],
        before: ['show log syslogd setting', 'show system snmp sysinfo', 'diagnose log test'],
        config: [
          'config log syslogd setting',
          '    set status enable',
          `    set server "${syslog}"`,
          `    set port ${num(values, 'syslog_port', 514)}`,
          `    set mode ${str(values, 'syslog_mode', 'udp')}`,
          '    set facility local7',
          '    set format default',
          'end',
          '',
          'config log syslogd filter',
          '    set severity information',
          '    set forward-traffic enable',
          '    set local-traffic disable',
          'end',
          ...(faz
            ? ['', 'config log fortianalyzer setting', '    set status enable', `    set server "${faz}"`, '    set upload-option realtime', '    set reliable enable', 'end']
            : []),
          ...(snmp
            ? [
                '',
                'config system snmp sysinfo',
                '    set status enable',
                '    set description ""',
                'end',
                '',
                'config system snmp user',
                `    edit "${user}"`,
                '        set security-level auth-priv',
                '        set auth-proto sha256',
                '        set auth-pwd <REQUIRED>',
                '        set priv-proto aes256',
                '        set priv-pwd <REQUIRED>',
                `        set notify-hosts ${str(values, 'snmp_host', '')}`,
                '    next',
                'end',
              ]
            : []),
        ],
        verify: ['diagnose log test', 'show log syslogd setting', ...(snmp ? ['show system snmp user'] : []), 'Check the collector is receiving.'],
        backout: [
          'config log syslogd setting',
          '    set status disable',
          'end',
          ...(faz ? ['config log fortianalyzer setting', '    set status disable', 'end'] : []),
          ...(snmp ? ['config system snmp user', `    delete "${user}"`, 'end'] : []),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_ha',
    platform: PLATFORM,
    label: 'High availability cluster',
    group: 'Baseline',
    description: 'Active/passive FGCP clustering: the group, the priority, the heartbeat interfaces and the monitored ports.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'FGT-CLUSTER' },
      { id: 'group_id', label: 'Group id', control: 'number', default: 1, min: 0, max: 255 },
      { id: 'mode', label: 'Mode', control: 'select', default: 'a-p', options: [{ value: 'a-p', label: 'Active / passive' }, { value: 'a-a', label: 'Active / active' }] },
      { id: 'role', label: 'This unit is', control: 'select', default: 'primary', options: [{ value: 'primary', label: 'Primary (priority 200)' }, { value: 'secondary', label: 'Secondary (priority 100)' }] },
      { id: 'heartbeat_interfaces', label: 'Heartbeat interfaces', control: 'text', default: 'port9, port10' },
      { id: 'monitor_interfaces', label: 'Monitored interfaces', control: 'text', default: 'port1, port2' },
      { id: 'override', label: 'Override (force the primary back)', control: 'toggle', default: false },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const priority = str(values, 'role', 'primary') === 'primary' ? 200 : 100;
      const heartbeat = listOf(str(values, 'heartbeat_interfaces', ''));
      const monitor = listOf(str(values, 'monitor_interfaces', ''));
      const findings            = [];
      if (heartbeat.length < 2) {
        findings.push(warning('network.fortios.ha-single-heartbeat', 'One heartbeat interface means one cable failure splits the cluster.', { source: 'ArchToolKit' }));
      }
      if (bool(values, 'override', false)) {
        findings.push(
          warning('network.fortios.ha-override', 'Override makes the higher-priority unit take over as soon as it returns, turning one failover into two.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `HA cluster ${str(values, 'group_name', '')} (${str(values, 'role', 'primary')})`,
        impact: 'outage',
        notes: [
          'Both units need the same firmware, the same licences and the same group name and id. They will not form a cluster otherwise.',
          'Enabling HA reboots the interfaces and can interrupt traffic. Do the secondary first, in a window.',
          'The HA password is <REQUIRED>.',
        ],
        before: ['get system ha status', 'diagnose sys ha status', 'get system status | grep Version'],
        config: [
          'config system ha',
          `    set group-name "${str(values, 'group_name', 'CLUSTER')}"`,
          `    set group-id ${num(values, 'group_id', 1)}`,
          `    set mode ${str(values, 'mode', 'a-p')}`,
          '    set password <REQUIRED>',
          `    set hbdev ${heartbeat.map((iface) => `"${iface}" ${heartbeat.indexOf(iface)}`).join(' ')}`,
          '    set session-pickup enable',
          '    set session-pickup-connectionless enable',
          `    set priority ${priority}`,
          `    set override ${bool(values, 'override', false) ? 'enable' : 'disable'}`,
          `    set monitor ${monitor.map((iface) => `"${iface}"`).join(' ')}`,
          '    set ha-mgmt-status enable',
          'end',
        ],
        verify: ['get system ha status', 'diagnose sys ha status', 'diagnose sys ha checksum cluster', 'execute ha manage 1'],
        backout: ['config system ha', '    set mode standalone', 'end'],
        findings,
      };
    },
  }),
];

/**
 * The modules that apply these changes.
 *
 * Attached here rather than inside each literal, so the whole mapping from
 * change to module can be read at once and checked against the collection.
 */
const PUSHES                                                                                                                                                                                    = {
  fortios_ipsec_vpn: (values) => ({
    module: 'fortinet.fortios.fortios_vpn_ipsec_phase1_interface',
    args: {
      vdom: VDOM,
      state: 'present',
      vpn_ipsec_phase1_interface: {
        name: str(values, 'tunnel_name', 'VPN'),
        interface: str(values, 'outgoing_interface', 'port1'),
        ike_version: '2',
        peertype: 'any',
        remote_gw: str(values, 'remote_gateway', ''),
        psksecret: '{{ vault_vpn_psk }}',
        proposal: str(values, 'proposal', 'aes256gcm-prfsha384'),
        dhgrp: str(values, 'dh_group', '20'),
        comments: '',
      },
    },
    after: [
      {
        name: 'Phase 2',
        module: 'fortinet.fortios.fortios_vpn_ipsec_phase2_interface',
        args: {
          vdom: VDOM,
          state: 'present',
          vpn_ipsec_phase2_interface: { name: `${str(values, 'tunnel_name', 'VPN')}-p2`, phase1name: str(values, 'tunnel_name', 'VPN'), auto_negotiate: 'enable' },
        },
      },
    ],
  }),
  fortios_dhcp_server: (values) => ({
    module: 'fortinet.fortios.fortios_system_dhcp_server',
    args: {
      vdom: VDOM,
      state: 'present',
      system_dhcp_server: {
        status: 'enable',
        interface: str(values, 'interface', 'port2'),
        netmask: str(values, 'netmask', '255.255.255.0'),
        default_gateway: str(values, 'gateway', ''),
        lease_time: num(values, 'lease_seconds', 86400),
        ip_range: [{ id: 1, start_ip: str(values, 'range_start', ''), end_ip: str(values, 'range_end', '') }],
      },
    },
  }),
  fortios_admin_access: (values) => ({
    module: 'fortinet.fortios.fortios_system_global',
    args: {
      vdom: VDOM,
      system_global: {
        admin_sport: num(values, 'https_port', 443),
        admin_ssh_port: num(values, 'ssh_port', 22),
        admintimeout: num(values, 'idle_timeout', 15),
        admin_telnet: 'disable',
        strong_crypto: 'enable',
      },
    },
  }),
  fortios_logging: (values) => ({
    module: 'fortinet.fortios.fortios_log_syslogd_setting',
    args: {
      vdom: VDOM,
      log_syslogd_setting: {
        status: 'enable',
        server: str(values, 'syslog_server', ''),
        port: num(values, 'syslog_port', 514),
        mode: str(values, 'syslog_mode', 'udp'),
        facility: 'local7',
      },
    },
  }),
  fortios_ha: (values) => ({
    module: 'fortinet.fortios.fortios_system_ha',
    args: {
      vdom: VDOM,
      system_ha: {
        group_name: str(values, 'group_name', 'CLUSTER'),
        group_id: num(values, 'group_id', 1),
        mode: str(values, 'mode', 'a-p'),
        password: '{{ vault_ha_password }}',
        priority: str(values, 'role', 'primary') === 'primary' ? 200 : 100,
        session_pickup: 'enable',
        override: bool(values, 'override', false) ? 'enable' : 'disable',
      },
    },
  }),
};

export const FORTIOS_EXTRA                             = BLUEPRINTS.map((blueprint) => {
  const push = PUSHES[blueprint.id];
  return push ? withPush(blueprint, push) : blueprint;
});

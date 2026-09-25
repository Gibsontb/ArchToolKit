/**
 * Fortinet FortiOS.
 *
 * FortiOS configuration is entered as `config` blocks and applies as each
 * `end` is typed — there is no staged candidate to review, so the back-out
 * matters more here than anywhere else, and every change in this group carries
 * one that can be pasted straight back.
 *
 * The push half uses the object modules (`fortios_firewall_policy`,
 * `fortios_firewall_address`), which speak to the REST API over the httpapi
 * connection with a token from the vault.
 */

import { bool, num, str, type BlueprintValues, type BlueprintGroup } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { FORTIOS_EXTRA } from './fortios-extra.ts';
import { FORTIOS_EXTRA_2 } from './fortios-extra2.ts';
import { FORTIOS_EXTRA_3 } from './fortios-extra3.ts';
import { listOf, netmask, parseCidr, type DeviceChange } from '../device.ts';
import { familyOf } from '../../core/ip.ts';
import { addressBody, addressTable, addrgrpTable, fgtCidr, fgtHost, fgtSubnet, looksLikeAddress, v6Name } from './fortios-ip.ts';

const PLATFORM = 'fortios' as const;
const VDOM = '{{ vdom | default("root") }}';

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'fortios_address_objects',
    platform: PLATFORM,
    label: 'Address objects and a group',
    group: 'Objects',
    description: 'Address objects from a list of prefixes, IPv4 or IPv6, collected into a group for policies to use.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'GRP-APP-SERVERS' },
      { id: 'addresses', label: 'Addresses', control: 'textarea', default: 'APP-WEB-01 10.20.30.11/32\nAPP-WEB-02 10.20.30.12/32', hint: 'One per line: NAME prefix — IPv4 (10.20.30.11/32) or IPv6 (2001:db8:30::11/128)' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const group = str(values, 'group_name', 'GRP').toUpperCase().replace(/\s+/g, '-');
      const entries = str(values, 'addresses', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map(([name, cidr]) => ({ name: String(name), cidr: String(cidr), parsed: fgtCidr(String(cidr)) }));
      const findings: Finding[] = [];
      for (const entry of entries) {
        if (!entry.parsed) findings.push(error('network.fortios.bad-address', `"${entry.cidr}" for ${entry.name} is not a valid IPv4 or IPv6 prefix.`, { source: 'ArchToolKit' }));
      }
      if (entries.length === 0) findings.push(error('network.fortios.no-addresses', 'No address objects were given.', { source: 'ArchToolKit' }));

      // IPv4 objects live in `firewall address`, IPv6 in `firewall address6`,
      // and a group holds one family only — so a mixed list becomes two groups.
      const v4 = entries.filter((e) => e.parsed?.family !== 6);
      const v6 = entries.filter((e) => e.parsed?.family === 6);
      const both = v4.length > 0 && v6.length > 0;
      const group6 = v6Name(group, both);
      const block = (family: 4 | 6, list: typeof entries, name: string): string[] =>
        list.length === 0
          ? []
          : [
              `config ${addressTable(family)}`,
              ...list.flatMap((entry) => [
                `    edit "${entry.name}"`,
                ...(entry.parsed ? addressBody(entry.parsed, '        ') : ['        set type ipmask', '        set subnet <REQUIRED>']),
                '        set comment ""',
                '    next',
              ]),
              'end',
              '',
              `config ${addrgrpTable(family)}`,
              `    edit "${name}"`,
              `        set member ${list.map((e) => `"${e.name}"`).join(' ')}`,
              '    next',
              'end',
            ];
      const unblock = (family: 4 | 6, list: typeof entries, name: string): string[] =>
        list.length === 0 ? [] : [`config ${addrgrpTable(family)}`, `    delete "${name}"`, 'end', `config ${addressTable(family)}`, ...list.map((entry) => `    delete "${entry.name}"`), 'end'];

      return {
        platform: PLATFORM,
        title: `${entries.length} address object(s) and the group ${group}${both ? ` (IPv6 members in ${group6})` : ''}`,
        impact: 'none',
        notes: [
          'Objects change no traffic on their own. The policy that uses them does.',
          ...(both ? [`FortiOS keeps IPv4 and IPv6 objects in separate tables and a group holds one family, so the IPv6 members are grouped as ${group6}. A policy names ${group} in srcaddr/dstaddr and ${group6} in srcaddr6/dstaddr6.`] : []),
        ],
        before: [
          ...(v6.length > 0 && v4.length === 0 ? [] : ['show firewall address', `show firewall addrgrp ${group}`]),
          ...(v6.length > 0 ? ['show firewall address6', `show firewall addrgrp6 ${group6}`] : []),
        ],
        config: [...block(4, v4, group), ...(v4.length > 0 && v6.length > 0 ? [''] : []), ...block(6, v6, group6)],
        verify: [
          ...(v4.length > 0 || v6.length === 0 ? [`show firewall addrgrp ${group}`, 'show firewall address | grep APP-'] : []),
          ...(v6.length > 0 ? [`show firewall addrgrp6 ${group6}`, 'show firewall address6'] : []),
        ],
        backout: [...unblock(4, v4, group), ...unblock(6, v6, group6)],
        push: {
          ...(v4.length === 0 && v6.length > 0
            ? { module: 'fortinet.fortios.fortios_firewall_address6', args: { vdom: VDOM, state: 'present', firewall_address6: { name: '{{ item.name }}', ip6: '{{ item.ip6 }}', comment: '' } } }
            : {
                module: 'fortinet.fortios.fortios_firewall_address',
                args: {
                  vdom: VDOM,
                  state: 'present',
                  firewall_address: {
                    name: '{{ item.name }}',
                    type: 'ipmask',
                    subnet: '{{ item.subnet }}',
                    comment: '',
                  },
                },
              }),
          after: [
            ...(v4.length > 0 || v6.length === 0
              ? [
                  {
                    name: `Collect them into ${group}`,
                    module: 'fortinet.fortios.fortios_firewall_addrgrp',
                    args: { vdom: VDOM, state: 'present', firewall_addrgrp: { name: group, member: v4.map((e) => ({ name: e.name })) } },
                  },
                ]
              : []),
            ...(v4.length === 0 ? [] : v6).map((entry) => ({
              name: `IPv6 address ${entry.name}`,
              module: 'fortinet.fortios.fortios_firewall_address6',
              args: { vdom: VDOM, state: 'present', firewall_address6: { name: entry.name, ip6: entry.parsed ? fgtSubnet(entry.parsed) : '', comment: '' } },
            })),
            ...(v6.length > 0
              ? [
                  {
                    name: `Collect the IPv6 ones into ${group6}`,
                    module: 'fortinet.fortios.fortios_firewall_addrgrp6',
                    args: { vdom: VDOM, state: 'present', firewall_addrgrp6: { name: group6, member: v6.map((e) => ({ name: e.name })) } },
                  },
                ]
              : []),
          ],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_firewall_policy',
    platform: PLATFORM,
    label: 'Firewall policy',
    group: 'Policy',
    description: 'A policy between two interfaces with addresses, services, NAT, logging and the security profiles attached.',
    inputs: [
      { id: 'policy_id', label: 'Policy id', control: 'number', default: 100, min: 1, hint: 'Must not already exist' },
      { id: 'policy_name', label: 'Name', control: 'text', default: 'Users-to-App' },
      { id: 'src_intf', label: 'Incoming interface', control: 'text', default: 'port1' },
      { id: 'dst_intf', label: 'Outgoing interface', control: 'text', default: 'port2' },
      { id: 'source', label: 'Source addresses', control: 'text', default: 'GRP-USERS' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: 'GRP-APP-SERVERS' },
      { id: 'source6', label: 'IPv6 source addresses', control: 'text', default: '', hint: 'address6/addrgrp6 object names ("all" for any) — empty for an IPv4-only policy' },
      { id: 'destination6', label: 'IPv6 destination addresses', control: 'text', default: '', hint: 'address6/addrgrp6/vip6 object names — needed whenever IPv6 sources are given' },
      { id: 'service', label: 'Services', control: 'text', default: 'HTTPS, DNS', hint: 'Service object names' },
      { id: 'action', label: 'Action', control: 'select', default: 'accept', options: [{ value: 'accept', label: 'Accept' }, { value: 'deny', label: 'Deny' }] },
      { id: 'nat', label: 'NAT (hide behind the outgoing interface)', control: 'toggle', default: false },
      { id: 'log', label: 'Log all sessions', control: 'toggle', default: true },
      { id: 'inspection', label: 'Security profiles', control: 'select', default: 'certificate-inspection', options: [
        { value: 'none', label: 'None' },
        { value: 'certificate-inspection', label: 'Certificate inspection' },
        { value: 'deep-inspection', label: 'Deep inspection' },
      ] },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'policy_id', 100);
      const name = str(values, 'policy_name', 'policy');
      const action = str(values, 'action', 'accept');
      const log = bool(values, 'log', true);
      const inspection = str(values, 'inspection', 'certificate-inspection');
      const source6 = listOf(str(values, 'source6', ''));
      const destination6 = listOf(str(values, 'destination6', ''));
      const dual = source6.length > 0 || destination6.length > 0;
      // With IPv6 given, an IPv4 side left empty on purpose means an IPv6-only
      // policy; with none, empty still means "all" as it always has.
      const blank = (id: string): boolean => values[id] !== undefined && String(values[id] ?? '').trim() === '';
      const v4Off = dual && blank('source') && blank('destination');
      const source = v4Off ? [] : listOf(str(values, 'source', 'all'));
      const destination = v4Off ? [] : listOf(str(values, 'destination', 'all'));
      const services = listOf(str(values, 'service', 'ALL'));
      const findings: Finding[] = [];

      // The consolidated policy table (FortiOS 7.0+) carries both families in
      // one policy, but each family needs a source and a destination of its own.
      if (dual && (source6.length === 0 || destination6.length === 0)) {
        findings.push(error('network.fortios.policy-v6-half', 'IPv6 needs both srcaddr6 and dstaddr6. Give IPv6 source and destination objects ("all" for any), or neither.', { source: 'ArchToolKit' }));
      }
      for (const [field, list] of [['source', source], ['destination', destination], ['IPv6 source', source6], ['IPv6 destination', destination6]] as const) {
        for (const name of list) {
          if (looksLikeAddress(name)) {
            findings.push(
              error('network.fortios.policy-literal-address', `"${name}" in ${field} is an address, but a FortiOS policy names address objects.`, {
                remediation: `Create an ${familyOf(name) === 6 ? 'address6' : 'address'} object for it (Address objects and a group) and name that here.`,
                source: 'ArchToolKit',
              }),
            );
          }
        }
      }

      if (services.some((s) => s.toUpperCase() === 'ALL') && action === 'accept') {
        findings.push(warning('network.fortios.service-all', 'This policy accepts every service between the two interfaces.', { remediation: 'Name the service objects the traffic uses.', source: 'ArchToolKit' }));
      }
      if (action === 'accept' && inspection === 'none') {
        findings.push(warning('network.fortios.no-inspection', 'An accept policy with no inspection profile passes the traffic unexamined.', { source: 'ArchToolKit' }));
      }
      if (!log) findings.push(warning('network.fortios.no-logging', 'Logging is off, so this policy leaves no record of what it passed.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Firewall policy ${id} (${name}): ${str(values, 'src_intf', '')} → ${str(values, 'dst_intf', '')}`,
        impact: 'brief',
        notes: [
          'FortiOS applies each block as `end` is entered. There is no commit to hold it back, so check the addresses and services before pasting.',
          'Policies match in order. A new policy goes to the bottom of the sequence; move it with `move <id> before <id>` if something above would match first.',
          ...(dual ? ['FortiOS 7.x uses one consolidated policy table: the IPv6 objects go in srcaddr6/dstaddr6 of this same policy. There is no `config firewall policy6` on 7.x.'] : []),
          ...(dual && bool(values, 'nat', false) ? ['VERIFY: with NAT enabled, IPv6 sessions through this policy are translated too (NAT66 behind the outgoing interface’s IPv6 address). Confirm that is intended, or split the IPv6 traffic into its own policy without NAT.'] : []),
        ],
        before: [`show firewall policy ${id}`, 'show firewall policy | grep -f name', 'get router info routing-table all'],
        config: [
          'config firewall policy',
          `    edit ${id}`,
          `        set name "${name}"`,
          `        set srcintf "${str(values, 'src_intf', 'port1')}"`,
          `        set dstintf "${str(values, 'dst_intf', 'port2')}"`,
          ...(source.length > 0 ? [`        set srcaddr ${source.map((s) => `"${s}"`).join(' ')}`] : []),
          ...(destination.length > 0 ? [`        set dstaddr ${destination.map((s) => `"${s}"`).join(' ')}`] : []),
          ...(source6.length > 0 ? [`        set srcaddr6 ${source6.map((s) => `"${s}"`).join(' ')}`] : []),
          ...(destination6.length > 0 ? [`        set dstaddr6 ${destination6.map((s) => `"${s}"`).join(' ')}`] : []),
          `        set action ${action}`,
          '        set schedule "always"',
          `        set service ${services.map((s) => `"${s}"`).join(' ')}`,
          ...(log ? ['        set logtraffic all'] : ['        set logtraffic disable']),
          ...(bool(values, 'nat', false) ? ['        set nat enable'] : []),
          ...(inspection !== 'none' && action === 'accept'
            ? [`        set ssl-ssh-profile "${inspection}"`, '        set av-profile "default"', '        set ips-sensor "default"', '        set utm-status enable']
            : []),
          '        set comments ""',
          '    next',
          'end',
        ],
        verify: [`show firewall policy ${id}`, `diagnose firewall iprope show 100004 ${id}`, 'get system status'],
        backout: ['config firewall policy', `    delete ${id}`, 'end'],
        push: {
          module: 'fortinet.fortios.fortios_firewall_policy',
          args: {
            vdom: VDOM,
            state: 'present',
            firewall_policy: {
              policyid: id,
              name,
              srcintf: [{ name: str(values, 'src_intf', 'port1') }],
              dstintf: [{ name: str(values, 'dst_intf', 'port2') }],
              srcaddr: source.map((s) => ({ name: s })),
              dstaddr: destination.map((s) => ({ name: s })),
              ...(dual ? { srcaddr6: source6.map((s) => ({ name: s })), dstaddr6: destination6.map((s) => ({ name: s })) } : {}),
              action,
              schedule: 'always',
              service: services.map((s) => ({ name: s })),
              logtraffic: log ? 'all' : 'disable',
              nat: bool(values, 'nat', false) ? 'enable' : 'disable',
              ...(inspection !== 'none' && action === 'accept' ? { ssl_ssh_profile: inspection, utm_status: 'enable', av_profile: 'default', ips_sensor: 'default' } : {}),
              comments: '',
            },
          },
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_vip',
    platform: PLATFORM,
    label: 'Virtual IP (publish a server)',
    group: 'Policy',
    description: 'A VIP that maps an external address and port to an internal server, with the policy that permits it.',
    inputs: [
      { id: 'vip_name', label: 'VIP name', control: 'text', default: 'VIP-WEB' },
      { id: 'external', label: 'External address', control: 'text', default: '203.0.113.10', hint: 'IPv4, or IPv6 for a vip6 (both addresses the same family)' },
      { id: 'internal', label: 'Internal address', control: 'text', default: '10.20.30.11' },
      { id: 'external_port', label: 'External port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'internal_port', label: 'Internal port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'interface', label: 'External interface', control: 'text', default: 'port1' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'vip_name', 'VIP');
      const external = str(values, 'external', '');
      const internal = str(values, 'internal', '');
      const extPort = num(values, 'external_port', 443);
      const intPort = num(values, 'internal_port', 443);
      const ext = fgtHost(external);
      const int = fgtHost(internal);
      const findings: Finding[] = [];
      if (!ext) findings.push(error('network.fortios.bad-vip-address', `The external address "${external}" is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      if (!int) findings.push(error('network.fortios.bad-vip-address', `The internal address "${internal}" is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      if (ext && int && ext.family !== int.family) {
        findings.push(
          error('network.fortios.vip-mixed-family', 'The external and internal addresses are different families. That is NAT46/NAT64, which this change does not generate — publish IPv4 with a vip and IPv6 with a vip6.', { source: 'ArchToolKit' }),
        );
      }
      // An IPv6 VIP is its own table, vip6, with no external interface and no ARP.
      if (ext?.family === 6 && int?.family === 6) {
        return {
          platform: PLATFORM,
          title: `VIP6 ${name}: [${ext.address}]:${extPort} → [${int.address}]:${intPort}`,
          impact: 'brief',
          notes: [
            'A VIP on its own publishes nothing: a firewall policy with this VIP in dstaddr6 is what lets the traffic in. Add one after this.',
            'IPv6 VIPs are `config firewall vip6`. There is no external interface or ARP setting: the external address must be routed to the FortiGate, or be on one of its interfaces so it answers neighbour discovery for it.',
            'VERIFY: if the external address is neither routed to the FortiGate nor on one of its interfaces, nothing upstream will find it.',
          ],
          before: [`show firewall vip6 ${name}`, 'diagnose ipv6 neighbor-cache list'],
          config: [
            'config firewall vip6',
            `    edit "${name}"`,
            `        set extip ${ext.address}`,
            `        set mappedip ${int.address}`,
            '        set portforward enable',
            '        set protocol tcp',
            `        set extport ${extPort}`,
            `        set mappedport ${intPort}`,
            '        set comment ""',
            '    next',
            'end',
          ],
          verify: [`show firewall vip6 ${name}`, `diagnose sys session6 list | grep ${ext.address}`, 'diagnose ipv6 neighbor-cache list'],
          backout: ['config firewall vip6', `    delete "${name}"`, 'end'],
          push: {
            module: 'fortinet.fortios.fortios_firewall_vip6',
            args: {
              vdom: VDOM,
              state: 'present',
              firewall_vip6: { name, extip: ext.address, mappedip: int.address, portforward: 'enable', protocol: 'tcp', extport: String(extPort), mappedport: String(intPort), comment: '' },
            },
          },
          findings,
        };
      }

      return {
        platform: PLATFORM,
        title: `VIP ${name}: ${external}:${extPort} → ${internal}:${intPort}`,
        impact: 'brief',
        notes: [
          'A VIP on its own publishes nothing: a firewall policy with this VIP as the destination is what lets the traffic in. Add one after this.',
          'If the external address is not on the interface, the firewall needs to answer ARP for it — `set arp-reply enable` does that and is included.',
        ],
        before: [`show firewall vip ${name}`, 'get system arp'],
        config: [
          'config firewall vip',
          `    edit "${name}"`,
          `        set extip ${external}`,
          `        set mappedip "${internal}"`,
          `        set extintf "${str(values, 'interface', 'port1')}"`,
          '        set portforward enable',
          '        set protocol tcp',
          `        set extport ${extPort}`,
          `        set mappedport ${intPort}`,
          '        set arp-reply enable',
          '        set comment ""',
          '    next',
          'end',
        ],
        verify: [`show firewall vip ${name}`, `diagnose sys session filter dport ${extPort}`, 'get system arp | grep ' + external],
        backout: ['config firewall vip', `    delete "${name}"`, 'end'],
        push: {
          module: 'fortinet.fortios.fortios_firewall_vip',
          args: {
            vdom: VDOM,
            state: 'present',
            firewall_vip: {
              name,
              extip: external,
              mappedip: [{ range: internal }],
              extintf: str(values, 'interface', 'port1'),
              portforward: 'enable',
              protocol: 'tcp',
              extport: String(extPort),
              mappedport: String(intPort),
              arp_reply: 'enable',
              comment: '',
            },
          },
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Network',
    description: 'A static route out of an interface, optionally as a backup behind a lower distance.',
    inputs: [
      { id: 'sequence', label: 'Sequence number', control: 'number', default: 10, min: 1 },
      { id: 'prefix', label: 'Destination', control: 'text', default: '0.0.0.0/0', hint: 'IPv4 or IPv6 (::/0 for the IPv6 default route, written to router static6)' },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '203.0.113.1', hint: 'Same family as the destination' },
      { id: 'device', label: 'Interface', control: 'text', default: 'port1' },
      { id: 'distance', label: 'Distance', control: 'number', default: 10, min: 1, max: 255 },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const seq = num(values, 'sequence', 10);
      const prefixText = str(values, 'prefix', '0.0.0.0/0');
      const gateway = str(values, 'gateway', '');
      const device = str(values, 'device', 'port1');
      const distance = num(values, 'distance', 10);
      const findings: Finding[] = [];
      const any = fgtCidr(prefixText);
      const gw = fgtHost(gateway);
      if (gateway && !gw) findings.push(error('network.fortios.bad-gateway', `The gateway "${gateway}" is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      if (any && gw && any.family !== gw.family) {
        findings.push(error('network.fortios.route-mixed-family', `The destination is IPv${any.family} but the gateway is IPv${gw.family}. A static route's gateway must be the same family as its destination.`, { source: 'ArchToolKit' }));
      }

      // IPv6 routes are `router static6`, written as prefix/length.
      if (any?.family === 6) {
        const dst = `${any.network}/${any.prefix}`;
        return {
          platform: PLATFORM,
          title: `Static route ${dst} via ${gw?.address ?? gateway}`,
          impact: any.prefix === 0 ? 'outage' : 'brief',
          notes: [
            ...(any.prefix === 0 ? ['This is the IPv6 default route. If the gateway is wrong, the firewall loses its IPv6 path out — including any session you have over IPv6.'] : []),
            ...(gw && /^fe80:/i.test(gw.address) ? ['The gateway is link-local, which is normal for IPv6 and is why the interface is required: it says which link the address is on.'] : []),
          ],
          before: ['get router info6 routing-table', 'show router static6'],
          config: [
            'config router static6',
            `    edit ${seq}`,
            `        set dst ${dst}`,
            ...(gw ? [`        set gateway ${gw.address}`] : []),
            `        set device "${device}"`,
            `        set distance ${distance}`,
            '        set comment ""',
            '    next',
            'end',
          ],
          verify: ['get router info6 routing-table', ...(gw ? [`execute ping6 ${gw.address}`] : [])],
          backout: ['config router static6', `    delete ${seq}`, 'end'],
          push: {
            module: 'fortinet.fortios.fortios_router_static6',
            args: { vdom: VDOM, state: 'present', router_static6: { seq_num: seq, dst, ...(gw ? { gateway: gw.address } : {}), device, distance, comment: '' } },
          },
          findings,
        };
      }

      const cidr = parseCidr(prefixText);
      if (!cidr) findings.push(error('network.fortios.bad-prefix', 'The destination is not a valid IPv4 or IPv6 prefix.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Static route ${cidr ? `${cidr.address}/${cidr.prefix}` : '(invalid)'} via ${gateway}`,
        impact: cidr && cidr.prefix === 0 ? 'outage' : 'brief',
        notes: cidr && cidr.prefix === 0 ? ['This is the default route. If the gateway is wrong, the firewall loses its path out — including the session you are on.'] : [],
        before: ['get router info routing-table all', 'show router static'],
        config: [
          'config router static',
          `    edit ${seq}`,
          `        set dst ${cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : '<REQUIRED>'}`,
          `        set gateway ${gateway}`,
          `        set device "${device}"`,
          `        set distance ${distance}`,
          '        set comment ""',
          '    next',
          'end',
        ],
        verify: ['get router info routing-table all', `execute ping ${gateway}`],
        backout: ['config router static', `    delete ${seq}`, 'end'],
        push: {
          module: 'fortinet.fortios.fortios_router_static',
          args: {
            vdom: VDOM,
            state: 'present',
            router_static: {
              seq_num: seq,
              dst: cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : '',
              gateway,
              device,
              distance,
              comment: '',
            },
          },
        },
        findings,
      };
    },
  }),
];

/** The rest of the platform's changes live in fortios-extra.ts. */
const ALL: readonly ChangeBlueprint[] = [...BLUEPRINTS, ...FORTIOS_EXTRA, ...FORTIOS_EXTRA_2, ...FORTIOS_EXTRA_3];

export const FORTIOS_NETWORK: BlueprintGroup = { target: PLATFORM, label: 'Fortinet FortiOS', blueprints: ALL };
export const FORTIOS_CHANGES: readonly ChangeBlueprint[] = ALL;

/**
 * Junos switching (EX, QFX): spanning tree, storm control, LLDP, 802.1X, port
 * security, and a virtual chassis.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { isIp } from '../../core/ip.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { listOf, vlanIds, vlanRange, type DeviceChange } from '../device.ts';
import { bridgePriority, COMMIT_CONFIRMED, ident, interfaceFindings, PLATFORM, ports, SECRET, SRC } from './junos-common.ts';

export const JUNOS_SWITCHING: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'junos_spanning_tree',
    platform: PLATFORM,
    label: 'RSTP or MSTP with BPDU protection',
    group: 'Switching',
    description: 'The spanning-tree protocol and bridge priority, edge ports, and BPDU protection that shuts an edge port that hears a BPDU.',
    inputs: [
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'rstp', options: [{ value: 'rstp', label: 'RSTP' }, { value: 'mstp', label: 'MSTP' }] },
      { id: 'priority', label: 'Bridge priority', control: 'number', default: 32768, min: 0, max: 61440, hint: 'Multiples of 4096; lowest wins root. 4096 on the core, 8192 on its peer' },
      { id: 'edge_ports', label: 'Edge ports', control: 'text', default: 'ge-0/0/1, ge-0/0/2' },
      { id: 'bpdu_block', label: 'Block BPDUs on edge ports', control: 'toggle', default: true },
      { id: 'region', label: 'MSTP region name', control: 'text', default: 'CAMPUS', showWhen: { input: 'protocol', equals: ['mstp'] } },
      { id: 'revision', label: 'MSTP revision', control: 'number', default: 1, min: 0, max: 65535, showWhen: { input: 'protocol', equals: ['mstp'] } },
      { id: 'msti_vlans', label: 'MSTI 1 VLANs', control: 'text', default: '10-99', showWhen: { input: 'protocol', equals: ['mstp'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const protocol = str(values, 'protocol', 'rstp');
      const priority = num(values, 'priority', 32768);
      const edges = ports(str(values, 'edge_ports', ''));
      const block = bool(values, 'bpdu_block', true);
      const msti = vlanIds(str(values, 'msti_vlans', ''));
      const findings: Finding[] = [...interfaceFindings(edges)];
      if (priority % 4096 !== 0) findings.push(error('network.junos.stp-priority', `A bridge priority of ${priority} is not a multiple of 4096. Junos takes 0, 4k, 8k … 60k.`, SRC));
      if (protocol === 'mstp' && msti.length === 0) findings.push(error('network.junos.msti-empty', 'MSTI 1 has no VLANs.', SRC));
      const other = protocol === 'mstp' ? 'rstp' : 'mstp';
      const p = `set protocols ${protocol}`;

      return {
        platform: PLATFORM,
        title: `${protocol.toUpperCase()} priority ${priority} with ${edges.length} edge ports`,
        impact: 'brief',
        notes: [
          COMMIT_CONFIRMED,
          'Only one spanning-tree protocol runs at a time: this deletes the other one. Changing protocol or priority reconverges the tree.',
          ...(protocol === 'mstp' ? ['Every switch in the region needs the same region name, revision and VLAN-to-instance map, or it is a region of its own.'] : []),
          ...(block ? ['An edge port that receives a BPDU is disabled. Clear it with `clear error bpdu interface <port>` once the loop or rogue switch is gone.'] : []),
        ],
        findings,
        before: ['show spanning-tree bridge', 'show spanning-tree interface', 'show configuration protocols | display set | match "rstp|mstp|layer2-control"'],
        config: [
          `delete protocols ${other}`,
          `${p} bridge-priority ${bridgePriority(priority)}`,
          ...(protocol === 'mstp'
            ? [`${p} configuration-name ${ident(str(values, 'region', 'CAMPUS'), 'CAMPUS')}`, `${p} revision-level ${num(values, 'revision', 1)}`, ...vlanRange(msti).split(',').filter(Boolean).map((r) => `${p} msti 1 vlan ${r}`),`${p} msti 1 bridge-priority ${bridgePriority(priority)}`]
            : []),
          ...edges.map((e) => `${p} interface ${e} edge`),
          ...(block ? ['set protocols layer2-control bpdu-block-on-edge'] : []),
        ],
        verify: ['show spanning-tree bridge', 'show spanning-tree interface', ...(block ? ['show spanning-tree interface detail | match "BPDU|Edge"'] : []), ...(protocol === 'mstp' ? ['show spanning-tree mstp configuration'] : [])],
        backout: [`delete protocols ${protocol} bridge-priority`, ...edges.map((e) => `delete protocols ${protocol} interface ${e}`), ...(block ? ['delete protocols layer2-control bpdu-block-on-edge'] : []), ...(protocol === 'mstp' ? ['delete protocols mstp', 'set protocols rstp'] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_storm_control',
    platform: PLATFORM,
    label: 'Storm control',
    group: 'Switching',
    description: 'A storm-control profile limiting broadcast, unknown unicast and multicast on access ports, optionally shutting the port.',
    inputs: [
      { id: 'profile', label: 'Profile name', control: 'text', default: 'SC-ACCESS' },
      { id: 'percent', label: 'Bandwidth percentage', control: 'number', default: 5, min: 1, max: 100 },
      { id: 'shutdown', label: 'Shut the port on a storm', control: 'toggle', default: false },
      { id: 'ports', label: 'Ports', control: 'text', default: 'ge-0/0/1, ge-0/0/2' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const profile = ident(str(values, 'profile', 'SC-ACCESS'), 'SC-ACCESS');
      const percent = num(values, 'percent', 5);
      const list = ports(str(values, 'ports', ''));
      const shutdown = bool(values, 'shutdown', false);
      const findings: Finding[] = [...interfaceFindings(list)];
      if (list.length === 0) findings.push(error('network.junos.no-ports', 'No ports to apply the profile to.', SRC));
      if (percent >= 50) findings.push(warning('network.junos.storm-high', `${percent}% lets a storm fill half the link before anything happens. 1–10% is usual on access ports.`, SRC));

      return {
        platform: PLATFORM,
        title: `Storm control ${profile} at ${percent}%`,
        impact: 'none',
        notes: [...(shutdown ? ['A port shut by storm control stays down until `clear ethernet-switching port-error interface <port>`, or set `port-error-disable disable-timeout`.'] : [])],
        findings,
        before: ['show ethernet-switching interface', 'show configuration forwarding-options storm-control-profiles'],
        config: [
          `set forwarding-options storm-control-profiles ${profile} all bandwidth-percentage ${percent}`,
          ...(shutdown ? [`set forwarding-options storm-control-profiles ${profile} action-shutdown`] : []),
          ...list.map((p) => `set interfaces ${p} unit 0 family ethernet-switching storm-control ${profile}`),
        ],
        verify: ['show ethernet-switching interface', 'show log messages | match storm'],
        backout: [...list.map((p) => `delete interfaces ${p} unit 0 family ethernet-switching storm-control`), `delete forwarding-options storm-control-profiles ${profile}`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_lldp',
    platform: PLATFORM,
    label: 'LLDP and LLDP-MED',
    group: 'Switching',
    description: 'LLDP on every port except the ones facing another organisation, and LLDP-MED for phones.',
    inputs: [
      { id: 'med', label: 'LLDP-MED (phones)', control: 'toggle', default: true },
      { id: 'exclude', label: 'Ports with LLDP off', control: 'text', default: '', hint: 'Internet and provider-facing ports' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const med = bool(values, 'med', true);
      const exclude = ports(str(values, 'exclude', ''));
      return {
        platform: PLATFORM,
        title: `LLDP on all ports${med ? ' with LLDP-MED' : ''}`,
        impact: 'none',
        notes: ['LLDP advertises the host name, model and management address to whatever is plugged in. Turn it off on ports facing networks you do not control.'],
        findings: interfaceFindings(exclude),
        before: ['show lldp', 'show lldp neighbors'],
        config: [
          'set protocols lldp interface all',
          'set protocols lldp port-id-subtype interface-name',
          ...exclude.map((p) => `set protocols lldp interface ${p} disable`),
          ...(med ? ['set protocols lldp-med interface all'] : []),
        ],
        verify: ['show lldp', 'show lldp neighbors', ...(med ? ['show lldp local-information'] : [])],
        backout: ['delete protocols lldp port-id-subtype', ...exclude.map((p) => `delete protocols lldp interface ${p}`), ...(med ? ['delete protocols lldp-med'] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_dot1x',
    platform: PLATFORM,
    label: '802.1X port authentication',
    group: 'Switching',
    description: '802.1X on access ports against RADIUS, with MAC RADIUS for devices that cannot do 802.1X and a VLAN to fall back to when the servers are unreachable.',
    inputs: [
      { id: 'servers', label: 'RADIUS servers', control: 'text', default: '10.0.0.45, 10.0.0.46' },
      { id: 'source_address', label: 'Source address', control: 'text', default: '10.0.0.2' },
      { id: 'ports', label: 'Ports', control: 'text', default: 'ge-0/0/1, ge-0/0/2' },
      { id: 'supplicant', label: 'Supplicants per port', control: 'select', default: 'multiple', options: [{ value: 'single', label: 'Single' }, { value: 'single-secure', label: 'Single secure' }, { value: 'multiple', label: 'Multiple' }] },
      { id: 'mac_radius', label: 'MAC RADIUS fallback', control: 'toggle', default: true },
      { id: 'fail_vlan', label: 'Server-fail VLAN', control: 'text', default: 'USERS', hint: 'Where ports go when RADIUS is down; empty to block them' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'servers', ''));
      const source = str(values, 'source_address', '');
      const list = ports(str(values, 'ports', ''));
      const macRadius = bool(values, 'mac_radius', true);
      const fail = str(values, 'fail_vlan', '') ? ident(str(values, 'fail_vlan', ''), 'USERS') : '';
      const findings: Finding[] = [
        ...interfaceFindings(list),
        ...servers.filter((s) => !isIp(s)).map((s) => error('network.junos.bad-radius', `"${s}" is not an address.`, SRC)),
        ...(source && !isIp(source) ? [error('network.junos.bad-source-address', `The source address "${source}" is not an address.`, SRC)] : []),
      ];
      if (servers.length === 0) findings.push(error('network.junos.no-radius', 'No RADIUS servers: every port would stay unauthorised.', SRC));
      if (!fail) findings.push(warning('network.junos.no-server-fail', 'With no server-fail action, every port blocks when the RADIUS servers are unreachable — the whole floor goes dark with them.', SRC));
      const d = 'set protocols dot1x authenticator';

      return {
        platform: PLATFORM,
        title: `802.1X on ${list.length} ports`,
        impact: 'brief',
        notes: [
          `Replace each ${SECRET} with the RADIUS shared secret from your vault.`,
          'Ports go unauthorised at commit and pass traffic again only once a supplicant (or MAC RADIUS) succeeds. Roll out a few ports first, with the RADIUS policy already in place.',
        ],
        findings,
        before: ['show dot1x interface', 'show configuration access | display set', ...list.map((p) => `show ethernet-switching interface ${p}`)],
        config: [
          ...servers.flatMap((s) => [`set access radius-server ${s} secret "${SECRET}"`, ...(source ? [`set access radius-server ${s} source-address ${source}`] : [])]),
          'set access profile DOT1X authentication-order radius',
          ...servers.map((s) => `set access profile DOT1X radius authentication-server ${s}`),
          ...servers.map((s) => `set access profile DOT1X radius accounting-server ${s}`),
          `${d} authentication-profile-name DOT1X`,
          ...list.flatMap((p) => [
            `${d} interface ${p} supplicant ${str(values, 'supplicant', 'multiple')}`,
            `${d} interface ${p} reauthentication 3600`,
            ...(macRadius ? [`${d} interface ${p} mac-radius`] : []),
            ...(fail ? [`${d} interface ${p} server-fail vlan-name ${fail}`] : []),
          ]),
        ],
        verify: ['show dot1x interface', 'show dot1x interface detail', 'show network-access aaa statistics authentication', 'show log messages | match dot1x'],
        backout: [...list.map((p) => `delete protocols dot1x authenticator interface ${p}`), 'delete protocols dot1x authenticator authentication-profile-name', 'delete access profile DOT1X', ...servers.map((s) => `delete access radius-server ${s}`), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_port_security',
    platform: PLATFORM,
    label: 'Port security: MAC limit, DHCP snooping, ARP inspection',
    group: 'Switching',
    description: 'A MAC address limit per access port, and DHCP snooping with dynamic ARP inspection and IP source guard on a VLAN, trusting the uplinks.',
    inputs: [
      { id: 'ports', label: 'Access ports', control: 'text', default: 'ge-0/0/1, ge-0/0/2' },
      { id: 'mac_limit', label: 'MAC limit per port', control: 'number', default: 3, min: 0, max: 65535, hint: '0 for no limit' },
      { id: 'action', label: 'Over the limit', control: 'select', default: 'drop', options: [{ value: 'drop', label: 'Drop new MACs' }, { value: 'drop-and-log', label: 'Drop and log' }, { value: 'shutdown', label: 'Shut the port' }, { value: 'log', label: 'Log only' }] },
      { id: 'vlan', label: 'VLAN for DHCP snooping', control: 'text', default: 'USERS', hint: 'Empty for none' },
      { id: 'trusted', label: 'Trusted ports (uplinks, DHCP servers)', control: 'text', default: 'xe-0/1/0' },
      { id: 'source_guard', label: 'IP source guard', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const list = ports(str(values, 'ports', ''));
      const limit = num(values, 'mac_limit', 3);
      const action = str(values, 'action', 'drop');
      const vlan = str(values, 'vlan', '') ? ident(str(values, 'vlan', ''), 'USERS') : '';
      const trusted = ports(str(values, 'trusted', ''));
      const guard = bool(values, 'source_guard', true);
      const findings: Finding[] = [...interfaceFindings([...list, ...trusted])];
      if (vlan && trusted.length === 0) findings.push(warning('network.junos.no-trusted-port', 'DHCP snooping with no trusted port drops every DHCP offer from the real server, unless it is on an access port in this VLAN.', SRC));
      if (limit === 0 && !vlan) findings.push(error('network.junos.nothing-to-do', 'No MAC limit and no VLAN: this change configures nothing.', SRC));

      return {
        platform: PLATFORM,
        title: `Port security${limit > 0 ? `, MAC limit ${limit}` : ''}${vlan ? `, DHCP security on ${vlan}` : ''}`,
        impact: 'brief',
        notes: [
          ...(vlan ? ['Hosts with a static address, or that got their lease before snooping started, have no binding: ARP inspection and source guard drop them until they renew. Add static bindings for servers and printers.'] : []),
          'This is the ELS syntax. Pre-ELS EX configures these under `ethernet-switching-options secure-access-port`.',
        ],
        findings,
        before: ['show ethernet-switching table summary', ...(vlan ? ['show dhcp-security binding'] : [])],
        config: [
          ...(limit > 0 ? list.flatMap((p) => [`set switch-options interface ${p}.0 interface-mac-limit ${limit}`, `set switch-options interface ${p}.0 interface-mac-limit packet-action ${action}`]) : []),
          ...(vlan
            ? [
                `set vlans ${vlan} forwarding-options dhcp-security arp-inspection`,
                ...(guard ? [`set vlans ${vlan} forwarding-options dhcp-security ip-source-guard`] : []),
                ...(trusted.length > 0 ? [`set vlans ${vlan} forwarding-options dhcp-security group TRUSTED overrides trusted`] : []),
                ...trusted.map((p) => `set vlans ${vlan} forwarding-options dhcp-security group TRUSTED interface ${p}.0`),
              ]
            : []),
        ],
        verify: ['show ethernet-switching interface', ...(vlan ? ['show dhcp-security binding', 'show dhcp-security arp inspection statistics'] : []), 'show log messages | match "MAC limit|DHCP"'],
        backout: [...(limit > 0 ? list.map((p) => `delete switch-options interface ${p}.0 interface-mac-limit`) : []), ...(vlan ? [`delete vlans ${vlan} forwarding-options dhcp-security`] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_virtual_chassis',
    platform: PLATFORM,
    label: 'Virtual Chassis (preprovisioned)',
    group: 'Switching',
    description: 'A preprovisioned virtual chassis: members by serial number, the two routing engines, graceful switchover and nonstop bridging and routing.',
    inputs: [
      { id: 'serials', label: 'Member serial numbers, in member order', control: 'text', default: 'XX0000000001, XX0000000002, XX0000000003', hint: 'The first two are the routing engines' },
      { id: 'no_split', label: 'Disable split detection (two members only)', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const serials = listOf(str(values, 'serials', '')).map((s) => s.toUpperCase());
      const noSplit = bool(values, 'no_split', false);
      const findings: Finding[] = [];
      if (serials.length < 2) findings.push(error('network.junos.vc-members', 'A virtual chassis needs at least two members.', SRC));
      if (new Set(serials).size !== serials.length) findings.push(error('network.junos.vc-duplicate', 'A serial number is listed twice.', SRC));
      if (noSplit && serials.length > 2) findings.push(warning('network.junos.vc-split', 'Split detection should only be disabled on a two-member virtual chassis.', SRC));
      if (serials.length === 2 && !noSplit) findings.push(warning('network.junos.vc-two-members', 'With two members and split detection on, losing the backup can take the master down with it. Juniper recommends `no-split-detection` for two members.', SRC));

      return {
        platform: PLATFORM,
        title: `Virtual chassis of ${serials.length} members`,
        impact: 'outage',
        notes: [
          'Members join with their VCP ports: on EX with dedicated VCP ports that is automatic; on uplink ports, run `request virtual-chassis vc-port set pic-slot <n> port <n>` on each member (operational mode).',
          'The serial numbers are the chassis serials from `show chassis hardware`, not the PSU or module ones.',
          'Adding members renumbers nothing that is preprovisioned, but a member that joins with the wrong serial stays inactive. Do this in a window.',
        ],
        findings,
        before: ['show virtual-chassis', 'show virtual-chassis vc-port', 'show chassis hardware | match Chassis'],
        config: [
          'set virtual-chassis preprovisioned',
          ...serials.map((s, i) => `set virtual-chassis member ${i} role ${i < 2 ? 'routing-engine' : 'line-card'} serial-number ${s}`),
          ...(noSplit ? ['set virtual-chassis no-split-detection'] : []),
          'set chassis redundancy graceful-switchover',
          'set system commit synchronize',
          'set routing-options nonstop-routing',
          'set protocols layer2-control nonstop-bridging',
        ],
        verify: ['show virtual-chassis', 'show virtual-chassis status', 'show virtual-chassis vc-port', 'show system switchover'],
        backout: ['delete virtual-chassis', 'delete chassis redundancy graceful-switchover', 'delete routing-options nonstop-routing', 'delete protocols layer2-control nonstop-bridging', 'commit'],
      };
    },
  }),
];

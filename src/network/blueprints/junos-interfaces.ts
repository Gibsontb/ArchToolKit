/**
 * Junos interfaces: routed ports, access and trunk ports, VLANs with their
 * IRB, aggregated Ethernet, and the physical settings.
 *
 * The switching syntax is the Enhanced Layer 2 Software (ELS) one that every
 * current EX and QFX runs: `family ethernet-switching interface-mode`, `vlans`
 * with `l3-interface irb.N`. Older EX releases wrote `port-mode` and `vlan.N`;
 * the notes say so where it matters.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, vlanIds, type DeviceChange } from '../device.ts';
import { dualCidrs, dualFindings } from './nxos-eos-dual.ts';
import { COMMIT_CONFIRMED, ident, ifl, interfaceFindings, PLATFORM, ports, q, SRC } from './junos-common.ts';

export const JUNOS_INTERFACES: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'junos_l3_interface',
    platform: PLATFORM,
    label: 'Routed interface (IPv4 / IPv6)',
    group: 'Interfaces',
    description: 'An address on a physical port or a VLAN-tagged unit, IPv4, IPv6 or both — a router uplink, a firewall leg, a point-to-point link.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'ge-0/0/0' },
      { id: 'vlan_id', label: 'VLAN tag', control: 'number', default: 0, min: 0, max: 4094, hint: '0 for an untagged unit 0; otherwise the unit and the tag are this number' },
      { id: 'address', label: 'Addresses', control: 'text', default: '10.0.12.1/30', hint: 'IPv4, IPv6, or one of each: 10.0.12.1/30, 2001:db8:12::1/64' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Uplink to core-01 ge-0/0/0' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 0, min: 0, max: 9216, hint: '0 to leave it; Junos counts the Layer 2 header (1514 is a 1500-byte IP MTU)' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifd = ifl(str(values, 'interface', 'ge-0/0/0')).ifd;
      const tag = num(values, 'vlan_id', 0);
      const unit = tag > 0 ? tag : 0;
      const address = dualCidrs(str(values, 'address', ''));
      const mtu = num(values, 'mtu', 0);
      const findings: Finding[] = [...interfaceFindings([ifd]), ...dualFindings('network.junos.interface-address', 'the addresses', address, '10.0.12.1/30 or 2001:db8:12::1/64')];
      if (!address.v4 && !address.v6) findings.push(error('network.junos.interface-address', 'There is no valid address to configure.', SRC));
      if (mtu > 0 && mtu < 256) findings.push(error('network.junos.mtu', `An MTU of ${mtu} is below what Junos accepts (256).`, SRC));
      const base = `set interfaces ${ifd}`;

      return {
        platform: PLATFORM,
        title: `${ifd}.${unit} routed${address.v4 ? ` ${address.v4.text}` : ''}${address.v6 ? ` ${address.v6.text}` : ''}`,
        impact: mtu > 0 ? 'brief' : 'none',
        notes: [
          'A unit carries one kind of family: `family inet`/`inet6` cannot sit beside `family ethernet-switching` on the same unit.',
          ...(tag > 0 ? ['`vlan-tagging` applies to the whole port: every other unit on it needs a vlan-id too.'] : []),
          ...(mtu > 0 ? ['Changing the MTU flaps the port. Match it on the far end.'] : []),
        ],
        findings,
        before: [`show interfaces ${ifd} terse`, `show configuration interfaces ${ifd} | display set`],
        config: [
          `${base} description ${q(description(str(values, 'port_description', ''), 'routed interface'))}`,
          ...(mtu > 0 ? [`${base} mtu ${mtu}`] : []),
          ...(tag > 0 ? [`${base} vlan-tagging`, `${base} unit ${unit} vlan-id ${tag}`] : []),
          ...(address.v4 ? [`${base} unit ${unit} family inet address ${address.v4.text}`] : []),
          ...(address.v6 ? [`${base} unit ${unit} family inet6 address ${address.v6.text}`] : []),
        ],
        verify: [`show interfaces ${ifd}.${unit} terse`, `show interfaces ${ifd} extensive | match "error|MTU|Link"`, ...(address.v4 ? [`show route ${address.v4.network}/${address.v4.prefix} exact`] : []), ...(address.v6 ? [`show route ${address.v6.network}/${address.v6.prefix} exact`] : [])],
        backout: [
          ...(address.v4 ? [`delete interfaces ${ifd} unit ${unit} family inet address ${address.v4.text}`] : []),
          ...(address.v6 ? [`delete interfaces ${ifd} unit ${unit} family inet6 address ${address.v6.text}`] : []),
          ...(tag > 0 ? [`delete interfaces ${ifd} unit ${unit}`] : []),
          ...(mtu > 0 ? [`delete interfaces ${ifd} mtu`] : []),
          `delete interfaces ${ifd} description`,
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_access_port',
    platform: PLATFORM,
    label: 'Access port (EX / QFX)',
    group: 'Interfaces',
    description: 'Edge ports in one VLAN, with an optional voice VLAN and the port marked as an RSTP edge.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: 'ge-0/0/1, ge-0/0/2' },
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'USERS' },
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'voice_vlan', label: 'Voice VLAN name', control: 'text', default: '', hint: 'Empty for none; the VLAN must exist' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'User access' },
      { id: 'edge', label: 'RSTP edge port', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const list = ports(str(values, 'ports', ''));
      const vlan = ident(str(values, 'vlan_name', 'USERS'), 'USERS');
      const id = num(values, 'vlan_id', 10);
      const voice = str(values, 'voice_vlan', '') ? ident(str(values, 'voice_vlan', ''), 'VOICE') : '';
      const edge = bool(values, 'edge', true);
      const text = q(description(str(values, 'port_description', ''), 'access'));
      const findings: Finding[] = [...interfaceFindings(list)];
      if (list.length === 0) findings.push(error('network.junos.no-ports', 'No ports to configure.', SRC));
      if (id === 1) findings.push(warning('network.junos.default-vlan', 'VLAN 1 is the default VLAN on every port. Put users in a VLAN of their own.', SRC));

      return {
        platform: PLATFORM,
        title: `Access ports in ${vlan} (VLAN ${id})`,
        impact: 'brief',
        notes: [
          'Each port loses whatever it carried before: a port with `family inet` or a trunk configuration has to have that removed first, or the commit fails.',
          'This is the ELS syntax (EX2300/3400/4300/4400, QFX). Pre-ELS EX writes `port-mode access` instead of `interface-mode access`.',
        ],
        findings,
        before: ['show vlans', ...list.map((p) => `show configuration interfaces ${p} | display set`), 'show ethernet-switching interface'],
        config: [
          `set vlans ${vlan} vlan-id ${id}`,
          ...list.flatMap((p) => [
            `set interfaces ${p} description ${text}`,
            `set interfaces ${p} unit 0 family ethernet-switching interface-mode access`,
            `set interfaces ${p} unit 0 family ethernet-switching vlan members ${vlan}`,
            ...(edge ? [`set protocols rstp interface ${p} edge`] : []),
            ...(voice ? [`set switch-options voip interface ${p}.0 vlan ${voice}`, `set switch-options voip interface ${p}.0 forwarding-class expedited-forwarding`] : []),
          ]),
        ],
        verify: [`show vlans ${vlan}`, 'show ethernet-switching interface', ...list.map((p) => `show interfaces ${p} terse`), ...(edge ? ['show spanning-tree interface'] : [])],
        backout: [
          ...list.flatMap((p) => [
            `delete interfaces ${p} unit 0 family ethernet-switching`,
            `delete interfaces ${p} description`,
            ...(edge ? [`delete protocols rstp interface ${p}`] : []),
            ...(voice ? [`delete switch-options voip interface ${p}.0`] : []),
          ]),
          `# delete vlans ${vlan}   (only if nothing else uses it)`,
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_trunk_port',
    platform: PLATFORM,
    label: 'Trunk port with native VLAN',
    group: 'Interfaces',
    description: 'A trunk carrying a list of VLANs, with an untagged native VLAN — an uplink, an access-point port, a hypervisor.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: 'xe-0/1/0' },
      { id: 'allowed', label: 'VLANs carried', control: 'text', default: '10,20,30', hint: 'Ids and ranges: 10,20,100-110' },
      { id: 'native', label: 'Native VLAN', control: 'number', default: 999, min: 0, max: 4094, hint: '0 for none — every frame tagged' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Uplink to distribution' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const list = ports(str(values, 'ports', ''));
      const native = num(values, 'native', 999);
      const allowed = vlanIds(str(values, 'allowed', ''));
      const members = native > 0 && !allowed.includes(native) ? [...allowed, native].sort((a, b) => a - b) : allowed;
      const text = q(description(str(values, 'port_description', ''), 'trunk'));
      const findings: Finding[] = [...interfaceFindings(list)];
      if (list.length === 0) findings.push(error('network.junos.no-ports', 'No ports to configure.', SRC));
      if (allowed.length === 0) findings.push(error('network.junos.no-vlans', 'The trunk carries no VLANs. Give at least one id.', SRC));
      if (native === 1) {
        findings.push(
          warning('network.junos.native-vlan-1', 'The native VLAN is VLAN 1, the default VLAN. Untagged traffic lands in the VLAN every unconfigured port is in, and VLAN hopping by double tagging becomes possible.', {
            remediation: 'Use an unused VLAN as the native VLAN (999, for example), on both ends.',
            ...SRC,
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Trunk ${list.join(', ')} carrying ${members.length} VLANs`,
        impact: 'brief',
        notes: [
          'The VLANs must exist under `vlans` (with a vlan-id) or the commit fails.',
          ...(native > 0 ? [`On ELS the native VLAN also has to be a member, so VLAN ${native} is in the member list. Both ends must agree on it.`] : []),
        ],
        findings,
        before: ['show vlans', ...list.map((p) => `show configuration interfaces ${p} | display set`), 'show ethernet-switching interface'],
        config: list.flatMap((p) => [
          `set interfaces ${p} description ${text}`,
          ...(native > 0 ? [`set interfaces ${p} native-vlan-id ${native}`] : []),
          `set interfaces ${p} unit 0 family ethernet-switching interface-mode trunk`,
          ...members.map((v) => `set interfaces ${p} unit 0 family ethernet-switching vlan members ${v}`),
        ]),
        verify: ['show ethernet-switching interface', ...list.map((p) => `show interfaces ${p} terse`), 'show spanning-tree interface', 'show lldp neighbors'],
        backout: [...list.flatMap((p) => [`delete interfaces ${p} unit 0 family ethernet-switching`, ...(native > 0 ? [`delete interfaces ${p} native-vlan-id`] : []), `delete interfaces ${p} description`]), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_vlan_irb',
    platform: PLATFORM,
    label: 'VLAN with IRB interface',
    group: 'Interfaces',
    description: 'A VLAN and its routed IRB interface — the default gateway for the hosts in it — with an optional DHCP relay.',
    inputs: [
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'SERVERS' },
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 20, min: 1, max: 4094 },
      { id: 'address', label: 'IRB addresses', control: 'text', default: '10.20.0.1/24', hint: 'IPv4, IPv6 or both: 10.20.0.1/24, 2001:db8:20::1/64' },
      { id: 'dhcp_servers', label: 'DHCP relay servers', control: 'text', default: '', hint: 'Empty for no relay' },
      { id: 'mtu', label: 'IRB MTU', control: 'number', default: 0, min: 0, max: 9200, hint: '0 to leave the default' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlan = ident(str(values, 'vlan_name', 'VLAN'), 'VLAN');
      const id = num(values, 'vlan_id', 20);
      const address = dualCidrs(str(values, 'address', ''));
      const relays = str(values, 'dhcp_servers', '')
        .split(/[,\s]+/)
        .filter(Boolean);
      const mtu = num(values, 'mtu', 0);
      const findings: Finding[] = [...dualFindings('network.junos.irb-address', 'the IRB addresses', address, '10.20.0.1/24 or 2001:db8:20::1/64')];
      if (!address.v4 && !address.v6) findings.push(error('network.junos.irb-address', 'The IRB has no valid address.', SRC));
      for (const r of relays) if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(r)) findings.push(error('network.junos.bad-relay', `"${r}" is not an IPv4 address. DHCPv6 relay is configured under dhcpv6 and is not written here.`, SRC));

      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${vlan}) with irb.${id}`,
        impact: 'none',
        notes: [
          'The IRB comes up only when a port in the VLAN is up. Pre-ELS EX calls it `vlan.N` and uses `l3-interface vlan.N`.',
          ...(relays.length > 0 ? ['The DHCP servers need a route back to this IRB address for the replies.'] : []),
        ],
        findings,
        before: ['show vlans', 'show interfaces irb terse', `show configuration vlans ${vlan} | display set`],
        config: [
          `set vlans ${vlan} vlan-id ${id}`,
          `set vlans ${vlan} l3-interface irb.${id}`,
          ...(address.v4 ? [`set interfaces irb unit ${id} family inet address ${address.v4.text}`] : []),
          ...(address.v6 ? [`set interfaces irb unit ${id} family inet6 address ${address.v6.text}`] : []),
          ...(mtu > 0 ? [`set interfaces irb unit ${id} family inet mtu ${mtu}`] : []),
          ...(relays.length > 0
            ? [...relays.map((r) => `set forwarding-options dhcp-relay server-group DHCP-SERVERS ${r}`), `set forwarding-options dhcp-relay group ${vlan} active-server-group DHCP-SERVERS`, `set forwarding-options dhcp-relay group ${vlan} interface irb.${id}`]
            : []),
        ],
        verify: [`show vlans ${vlan}`, `show interfaces irb.${id} terse`, ...(address.v4 ? [`show route ${address.v4.network}/${address.v4.prefix}`] : []), ...(relays.length > 0 ? ['show dhcp relay binding', 'show dhcp relay statistics'] : [])],
        backout: [`delete vlans ${vlan}`, `delete interfaces irb unit ${id}`, ...(relays.length > 0 ? [`delete forwarding-options dhcp-relay group ${vlan}`] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_lag',
    platform: PLATFORM,
    label: 'Aggregated Ethernet (ae) with LACP',
    group: 'Interfaces',
    description: 'An ae bundle with LACP: the chassis device count, the member ports, and the bundle as an access, trunk or routed interface.',
    inputs: [
      { id: 'ae', label: 'ae number', control: 'number', default: 0, min: 0, max: 127 },
      { id: 'device_count', label: 'Aggregated devices on the chassis', control: 'number', default: 8, min: 1, max: 128, hint: 'How many ae interfaces exist; must be more than the ae number' },
      { id: 'members', label: 'Member ports', control: 'text', default: 'xe-0/0/46, xe-0/0/47' },
      {
        id: 'member_style',
        label: 'Platform',
        control: 'select',
        default: 'ether-options',
        options: [
          { value: 'ether-options', label: 'EX / QFX (ether-options)' },
          { value: 'gigether-options', label: 'MX / SRX (gigether-options)' },
        ],
      },
      { id: 'lacp', label: 'LACP', control: 'select', default: 'active', options: [{ value: 'active', label: 'Active' }, { value: 'passive', label: 'Passive' }] },
      { id: 'min_links', label: 'Minimum links', control: 'number', default: 1, min: 1, max: 64 },
      {
        id: 'mode',
        label: 'Bundle as',
        control: 'select',
        default: 'trunk',
        options: [
          { value: 'trunk', label: 'Trunk' },
          { value: 'access', label: 'Access' },
          { value: 'routed', label: 'Routed' },
        ],
      },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '10,20,30', hint: 'Ids; the first one for an access bundle', showWhen: { input: 'mode', equals: ['trunk', 'access'] } },
      { id: 'address', label: 'Addresses', control: 'text', default: '10.0.99.1/31', showWhen: { input: 'mode', equals: ['routed'] } },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Bundle to dist-01' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ae = `ae${num(values, 'ae', 0)}`;
      const count = num(values, 'device_count', 8);
      const members = ports(str(values, 'members', ''));
      const style = str(values, 'member_style', 'ether-options');
      const mode = str(values, 'mode', 'trunk');
      const vlans = vlanIds(str(values, 'vlans', ''));
      const address = dualCidrs(mode === 'routed' ? str(values, 'address', '') : '');
      const text = q(description(str(values, 'port_description', ''), 'LAG'));
      const findings: Finding[] = [...interfaceFindings(members)];
      if (num(values, 'ae', 0) >= count) findings.push(error('network.junos.ae-count', `${ae} does not exist with a device count of ${count}: ae numbers run from 0 to ${count - 1}.`, SRC));
      if (members.length === 0) findings.push(error('network.junos.no-members', 'The bundle has no member ports.', SRC));
      if (members.length === 1) findings.push(warning('network.junos.single-member', 'One member is a bundle with no redundancy.', SRC));
      if (num(values, 'min_links', 1) > members.length && members.length > 0) findings.push(error('network.junos.min-links', 'Minimum links is more than the number of members, so the bundle never comes up.', SRC));
      if (mode !== 'routed' && vlans.length === 0) findings.push(error('network.junos.no-vlans', 'No VLANs for the bundle.', SRC));
      if (mode === 'routed') {
        findings.push(...dualFindings('network.junos.interface-address', 'the addresses', address, '10.0.99.1/31'));
        if (!address.v4 && !address.v6) findings.push(error('network.junos.interface-address', 'The routed bundle has no valid address.', SRC));
      }
      const base = `set interfaces ${ae}`;
      const unit = `${base} unit 0`;

      return {
        platform: PLATFORM,
        title: `${ae} over ${members.join(', ')} (LACP ${str(values, 'lacp', 'active')})`,
        impact: 'brief',
        notes: [
          COMMIT_CONFIRMED,
          'A member port cannot have units of its own: whatever it carried before is removed here. Move it to the bundle in the same commit, and both ends together.',
          '`rollback 1` then `commit` is the quickest back-out if the bundle does not come up.',
        ],
        findings,
        before: ['show lacp interfaces', 'show interfaces terse | match "ae|' + members.join('|') + '"', ...members.map((m) => `show configuration interfaces ${m} | display set`)],
        config: [
          `set chassis aggregated-devices ethernet device-count ${count}`,
          ...members.flatMap((m) => [`delete interfaces ${m} unit 0`, `set interfaces ${m} description ${q(`${ae} member`)}`, `set interfaces ${m} ${style} 802.3ad ${ae}`]),
          `${base} description ${text}`,
          `${base} aggregated-ether-options lacp ${str(values, 'lacp', 'active')}`,
          `${base} aggregated-ether-options lacp periodic fast`,
          `${base} aggregated-ether-options minimum-links ${num(values, 'min_links', 1)}`,
          ...(mode === 'trunk' ? [`${unit} family ethernet-switching interface-mode trunk`, ...vlans.map((v) => `${unit} family ethernet-switching vlan members ${v}`)] : []),
          ...(mode === 'access' && vlans.length > 0 ? [`${unit} family ethernet-switching interface-mode access`, `${unit} family ethernet-switching vlan members ${vlans[0]}`] : []),
          ...(mode === 'routed' && address.v4 ? [`${unit} family inet address ${address.v4.text}`] : []),
          ...(mode === 'routed' && address.v6 ? [`${unit} family inet6 address ${address.v6.text}`] : []),
        ],
        verify: ['show lacp interfaces', `show interfaces ${ae} terse`, `show interfaces ${ae} extensive | match "LACP|Link|Speed"`, ...(mode === 'routed' ? [] : ['show ethernet-switching interface'])],
        backout: [`delete interfaces ${ae}`, ...members.map((m) => `delete interfaces ${m} ${style} 802.3ad`), ...members.map((m) => `delete interfaces ${m} description`), 'rollback 1  (instead of the lines above, to restore the members as they were)', 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_interface_settings',
    platform: PLATFORM,
    label: 'Port description, MTU, speed or shutdown',
    group: 'Interfaces',
    description: 'The physical settings of one or more ports: description, MTU, speed and duplex, or disabling the port.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: 'ge-0/0/10' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'Printer, floor 2' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 0, min: 0, max: 9216, hint: '0 to leave it' },
      {
        id: 'speed',
        label: 'Speed',
        control: 'select',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Leave to auto-negotiation' },
          { value: '100m', label: '100 Mb/s' },
          { value: '1g', label: '1 Gb/s' },
          { value: '10g', label: '10 Gb/s' },
          { value: '25g', label: '25 Gb/s' },
        ],
      },
      { id: 'disable', label: 'Disable the port', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const list = ports(str(values, 'ports', ''));
      const mtu = num(values, 'mtu', 0);
      const speed = str(values, 'speed', 'auto');
      const disable = bool(values, 'disable', false);
      const findings: Finding[] = [...interfaceFindings(list)];
      if (list.length === 0) findings.push(error('network.junos.no-ports', 'No ports to configure.', SRC));
      if (speed !== 'auto') findings.push(warning('network.junos.fixed-speed', 'A fixed speed on one end and auto-negotiation on the other is a duplex mismatch waiting to happen. Set both ends.', SRC));
      const text = q(description(str(values, 'port_description', ''), 'port'));

      return {
        platform: PLATFORM,
        title: `${disable ? 'Disable' : 'Settings on'} ${list.join(', ')}`,
        impact: disable ? 'outage' : mtu > 0 || speed !== 'auto' ? 'brief' : 'none',
        notes: [
          ...(speed !== 'auto' ? ['On EX/QFX speed is under `ether-options speed` on some models and directly under the interface on others; check `set interfaces ? speed` on the box.'] : []),
          ...(disable ? ['`disable` takes the port down at commit and keeps it down across reboots.'] : []),
        ],
        findings,
        before: list.map((p) => `show interfaces ${p} extensive | match "Link|Speed|MTU|Description"`),
        config: list.flatMap((p) => [
          `set interfaces ${p} description ${text}`,
          ...(mtu > 0 ? [`set interfaces ${p} mtu ${mtu}`] : []),
          ...(speed !== 'auto' ? [`set interfaces ${p} speed ${speed}`] : []),
          ...(disable ? [`set interfaces ${p} disable`] : []),
        ]),
        verify: [...list.map((p) => `show interfaces ${p} terse`), ...list.map((p) => `show interfaces ${p} | match "MTU|Speed|Description"`)],
        backout: [...list.flatMap((p) => [`delete interfaces ${p} description`, ...(mtu > 0 ? [`delete interfaces ${p} mtu`] : []), ...(speed !== 'auto' ? [`delete interfaces ${p} speed`] : []), ...(disable ? [`delete interfaces ${p} disable`] : [])]), 'commit'],
      };
    },
  }),
];

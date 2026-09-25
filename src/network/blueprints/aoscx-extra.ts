/**
 * Aruba AOS-CX: high availability (VSX and VSF), routing, security and the
 * EVPN-VXLAN data center fabric.
 *
 * VSX pairs two chassis with an inter-switch link and a keepalive, and splits
 * LAGs across them (`interface lag N multi-chassis`); each member keeps its own
 * control plane, so a change is made on both, and `vsx-sync` copies the parts
 * that must match. VSF stacks access switches into one control plane instead.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { info, type Finding } from '../../core/findings.ts';
import { containsAny } from '../../core/ip.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, isIpAny, isIpv4, listOf, parseCidrDual, vlanIds, vlanRange, type DeviceChange } from '../device.ts';
import {
  aclAddress,
  bad,
  CHECKPOINT,
  interfaceFindings,
  interfaceList,
  isRouteTag,
  macFindings,
  ospfArea,
  pairs,
  PLATFORM,
  portFindings,
  portList,
  RESERVED_VRFS,
  SECRET,
  SOURCE,
  warn,
} from './aoscx-common.ts';

const VSX_SYNC = 'aaa bfd-global bgp copp-policy dhcp-relay dhcp-server dns icmp-tcp lldp loop-protect-global mac-lockout mclag-interfaces neighbor ospf qos-global route-map sflow-global snmp ssh stp-global time vsx-global';

function vrfFindings(name: string): Finding[] {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return [bad('bad-vrf', `"${name}" is not a usable VRF name: up to 32 letters, digits, - and _.`)];
  if (RESERVED_VRFS.includes(name.toLowerCase())) return [bad('reserved-vrf', `"${name}" is a VRF AOS-CX creates itself; it cannot be created or removed.`)];
  return [];
}

function routerIdFindings(value: string): Finding[] {
  return isIpv4(value) ? [] : [bad('bad-router-id', `The router id "${value}" is not a dotted IPv4 address.`, 'Use the loopback address.')];
}

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  /* ------------------------------------------------------------------------ *
   * High availability
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_vsx_pair',
    platform: PLATFORM,
    label: 'VSX pair',
    group: 'High availability (VSX/VSF)',
    description: 'One side of a VSX pair: the inter-switch link LAG, the keepalive on its own routed port and VRF, the role, the system MAC and what is synchronised.',
    inputs: [
      { id: 'role', label: 'Role', control: 'select', default: 'primary', options: [{ value: 'primary', label: 'Primary' }, { value: 'secondary', label: 'Secondary' }] },
      { id: 'isl_lag', label: 'ISL LAG id', control: 'number', default: 256, min: 1, max: 256 },
      { id: 'isl_members', label: 'ISL member ports', control: 'text', default: '1/1/55, 1/1/56' },
      { id: 'keepalive_port', label: 'Keepalive port', control: 'text', default: '1/1/54', hint: 'A routed port that is not in the ISL' },
      { id: 'keepalive_address', label: 'Keepalive address (this switch)', control: 'text', default: '192.168.255.0/31' },
      { id: 'keepalive_peer', label: 'Keepalive address (peer)', control: 'text', default: '192.168.255.1' },
      { id: 'keepalive_vrf', label: 'Keepalive VRF', control: 'text', default: 'KEEPALIVE' },
      { id: 'system_mac', label: 'VSX system MAC', control: 'text', default: '02:01:00:00:01:00', hint: 'The same on both members' },
      { id: 'sync', label: 'Synchronise global configuration from the primary', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const role = str(values, 'role', 'primary');
      const lag = num(values, 'isl_lag', 256);
      const isl = portList(str(values, 'isl_members', ''));
      const ka = portList(str(values, 'keepalive_port', ''));
      const kaPort = ka.ports[0] ?? '';
      const kaText = str(values, 'keepalive_address', '');
      const kaAddress = kaText ? parseCidrDual(kaText) : null;
      const peer = str(values, 'keepalive_peer', '');
      const vrf = str(values, 'keepalive_vrf', '');
      const mac = str(values, 'system_mac', '');
      const sync = bool(values, 'sync', true) && role === 'primary';
      const findings: Finding[] = [...portFindings('the ISL members', isl.invalid), ...portFindings('the keepalive port', ka.invalid), ...(vrf ? vrfFindings(vrf) : [])];
      const keepalive = Boolean(kaAddress && peer && kaPort);
      if (!peer || !kaText || !kaPort) {
        findings.push(
          bad('vsx-no-keepalive', 'VSX without a keepalive cannot tell a failed ISL from a failed peer: both members stay active and the network splits in two.', 'Give it a keepalive over a routed port or the management network, not over the ISL.'),
        );
      } else {
        if (!kaAddress) findings.push(bad('bad-keepalive-address', `"${kaText}" is not an address and prefix.`));
        if (!isIpv4(peer)) findings.push(bad('bad-keepalive-peer', `The keepalive peer "${peer}" is not an IPv4 address.`));
        if (kaAddress && isIpv4(peer) && !containsAny(`${kaAddress.network}/${kaAddress.prefix}`, peer)) findings.push(bad('keepalive-subnet', `The keepalive peer ${peer} is not in this side's keepalive subnet ${kaAddress.network}/${kaAddress.prefix}.`));
        if (kaAddress && kaAddress.address === peer) findings.push(bad('keepalive-same', 'The keepalive peer is this switch’s own keepalive address.'));
      }
      if (kaPort && isl.ports.includes(kaPort)) findings.push(bad('keepalive-over-isl', `The keepalive port ${kaPort} is also an ISL member: when the ISL fails, the keepalive fails with it.`));
      if (isl.ports.length < 2) findings.push(warn('isl-single-link', 'The ISL has fewer than two links: one optic failure and the pair splits onto the keepalive.', 'Use two or more links, on different modules where the chassis has them.'));
      if (mac) findings.push(...macFindings('bad-system-mac', 'The VSX system MAC', mac));
      else findings.push(warn('vsx-no-system-mac', 'No system MAC: the pair uses the primary’s, and replacing the primary changes the LACP system id every multi-chassis LAG partner sees.'));
      const vrfSuffix = vrf ? ` vrf ${vrf}` : '';
      return {
        platform: PLATFORM,
        title: `VSX ${role} with ISL lag ${lag}`,
        impact: 'brief',
        notes: [
          `The peer takes the mirror image: role ${role === 'primary' ? 'secondary' : 'primary'}, the same system MAC and ISL, and the keepalive addresses swapped.`,
          ...(role === 'primary' ? ['`vsx-sync` is configured on the primary only; the secondary receives what it names.'] : ['The secondary takes the synchronised configuration from the primary once the ISL is up.']),
          'The ISL carries every VLAN on purpose: it must carry whatever a multi-chassis LAG does.',
        ],
        findings,
        before: ['show vsx status', 'show lacp interfaces', 'show interface brief', ...(vrf ? [`show vrf ${vrf}`] : [])],
        config: [
          ...(vrf && keepalive ? [`vrf ${vrf}`, '!'] : []),
          ...(keepalive && kaAddress
            ? [`interface ${kaPort}`, '    no shutdown', '    description VSX keepalive', '    routing', ...(vrf ? [`    vrf attach ${vrf}`] : []), `    ip address ${kaAddress.address}/${kaAddress.prefix}`, '!']
            : []),
          `interface lag ${lag}`,
          '    no shutdown',
          '    description VSX ISL',
          '    no routing',
          '    vlan trunk native 1 tag',
          '    vlan trunk allowed all',
          '    lacp mode active',
          '!',
          ...isl.ports.flatMap((p) => [`interface ${p}`, '    no shutdown', '    description VSX ISL member', `    lag ${lag}`, '!']),
          'vsx',
          ...(mac ? [`    system-mac ${mac}`] : []),
          `    inter-switch-link lag ${lag}`,
          `    role ${role}`,
          ...(keepalive && kaAddress ? [`    keepalive peer ${peer} source ${kaAddress.address}${vrfSuffix}`] : []),
          ...(sync ? [`    vsx-sync ${VSX_SYNC}`] : []),
          '!',
        ],
        verify: ['show vsx status', 'show vsx brief', 'show vsx status keepalive', 'show vsx config-consistency', `show lacp interfaces`],
        backout: [
          'no vsx',
          ...isl.ports.flatMap((p) => [`interface ${p}`, `    no lag ${lag}`, '!']),
          `no interface lag ${lag}`,
          ...(keepalive && kaAddress ? [`interface ${kaPort}`, `    no ip address ${kaAddress.address}/${kaAddress.prefix}`, ...(vrf ? [`    no vrf attach ${vrf}`] : []), '    shutdown', '!'] : []),
          ...(vrf && keepalive ? [`no vrf ${vrf}`] : []),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_vsx_mclag',
    platform: PLATFORM,
    label: 'Multi-chassis LAG (VSX)',
    group: 'High availability (VSX/VSF)',
    description: 'A LAG split across both members of a VSX pair, so a dual-homed switch or server survives the loss of either member.',
    inputs: [
      { id: 'lag_id', label: 'LAG id', control: 'number', default: 11, min: 1, max: 255 },
      { id: 'members', label: 'Member ports on this switch', control: 'text', default: '1/1/11' },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '10,20,30' },
      { id: 'native', label: 'Native VLAN', control: 'number', default: 999, min: 1, max: 4094 },
      { id: 'fallback', label: 'LACP fallback (PXE boot)', control: 'toggle', default: false },
      { id: 'port_description', label: 'Description', control: 'text', default: 'access-sw-11' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const lag = num(values, 'lag_id', 11);
      const { ports, invalid } = portList(str(values, 'members', ''));
      const allowedText = str(values, 'allowed', '');
      const all = allowedText.trim().toLowerCase() === 'all';
      const ids = all ? [] : vlanIds(allowedText);
      const native = num(values, 'native', 999);
      const fallback = bool(values, 'fallback', false);
      const text = description(str(values, 'port_description', ''), `MCLAG ${lag}`);
      const findings: Finding[] = portFindings('the members', invalid);
      if (ports.length === 0) findings.push(bad('lag-no-members', 'The multi-chassis LAG has no member port on this switch.'));
      if (native === 1) findings.push(warn('native-vlan-1', 'The LAG uses VLAN 1 as its native VLAN.', 'Use an unused parking VLAN.'));
      if (all) findings.push(warn('trunk-all-vlans', 'The multi-chassis LAG allows every VLAN.', 'List the VLANs the neighbour needs.'));
      else if (ids.length === 0) findings.push(bad('trunk-no-vlans', 'The multi-chassis LAG allows no valid VLAN.'));
      return {
        platform: PLATFORM,
        title: `Multi-chassis LAG ${lag}`,
        impact: 'brief',
        notes: [
          'Configure the same LAG id, VLANs and settings on the VSX peer (or let `vsx-sync mclag-interfaces` do it), with that switch’s own member ports.',
          'The VLANs must also be allowed on the ISL, which carries all of them by default.',
        ],
        findings,
        before: ['show vsx status', 'show lacp interfaces multi-chassis', 'show interface brief'],
        config: [
          `interface lag ${lag} multi-chassis`,
          '    no shutdown',
          `    description ${text}`,
          '    no routing',
          `    vlan trunk native ${native}`,
          `    vlan trunk allowed ${all ? 'all' : vlanRange(ids)}`,
          '    lacp mode active',
          ...(fallback ? ['    lacp fallback'] : []),
          '!',
          ...ports.flatMap((p) => [`interface ${p}`, '    no shutdown', `    description ${text} member`, `    lag ${lag}`, '!']),
        ],
        verify: ['show lacp interfaces multi-chassis', `show interface lag${lag}`, 'show vsx config-consistency lacp', 'show vsx brief'],
        backout: [...ports.flatMap((p) => [`interface ${p}`, `    no lag ${lag}`, '!']), `no interface lag ${lag}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_vsx_active_gateway',
    platform: PLATFORM,
    label: 'VSX active gateway',
    group: 'High availability (VSX/VSF)',
    description: 'A default gateway both members of a VSX pair answer for at once, with a shared virtual MAC. Active-active, with no first-hop protocol to converge.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'address', label: 'This switch’s SVI address', control: 'text', default: '10.1.10.2/24' },
      { id: 'gateway', label: 'Gateway (virtual) address', control: 'text', default: '10.1.10.1' },
      { id: 'mac', label: 'Virtual MAC', control: 'text', default: '02:00:00:00:01:00', hint: 'The same on both members and for every VLAN' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlan = num(values, 'vlan_id', 10);
      const text = str(values, 'address', '');
      const cidr = parseCidrDual(text);
      const gateway = str(values, 'gateway', '');
      const mac = str(values, 'mac', '');
      const family = cidr?.family === 6 ? 'ipv6' : 'ip';
      const findings: Finding[] = [...macFindings('bad-gateway-mac', 'The active gateway MAC', mac)];
      if (!cidr) findings.push(bad('bad-address', `"${text}" is not an address and prefix.`));
      if (!isIpAny(gateway)) findings.push(bad('bad-gateway', `The gateway "${gateway}" is not an IP address.`));
      else if (cidr && !containsAny(`${cidr.network}/${cidr.prefix}`, gateway)) findings.push(bad('gateway-subnet', `The gateway ${gateway} is not in the SVI subnet ${cidr.network}/${cidr.prefix}.`));
      if (cidr && cidr.address === gateway) findings.push(bad('gateway-is-svi', 'The gateway address is the SVI’s own address; each member needs its own address and they share the gateway.'));
      return {
        platform: PLATFORM,
        title: `Active gateway ${gateway} on VLAN ${vlan}`,
        impact: 'none',
        notes: ['Repeat on the VSX peer with its own SVI address and the same gateway and MAC; `vsx-sync active-gateways` copies the gateway lines for you.'],
        findings,
        before: [`show running-config interface vlan${vlan}`, 'show active-gateway'],
        config: [
          `interface vlan ${vlan}`,
          '    vsx-sync active-gateways',
          ...(cidr ? [`    ${family} address ${cidr.address}/${cidr.prefix}`] : []),
          `    active-gateway ${family} mac ${mac}`,
          `    active-gateway ${family} ${gateway}`,
          '!',
        ],
        verify: ['show active-gateway', `show interface vlan${vlan}`, 'show vsx config-consistency'],
        backout: [`interface vlan ${vlan}`, `    no active-gateway ${family} ${gateway}`, `    no active-gateway ${family} mac ${mac}`, '    no vsx-sync active-gateways', '!'],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_vsf_stack',
    platform: PLATFORM,
    label: 'VSF stack',
    group: 'High availability (VSX/VSF)',
    description: 'A VSF stack of 6200 or 6300 switches: each member’s model and stacking links, the standby member, and split detection over the management port.',
    inputs: [
      { id: 'members', label: 'Members', control: 'number', default: 2, min: 2, max: 10 },
      { id: 'model', label: 'Member type (product number)', control: 'text', default: 'jl658a', hint: 'The SKU as `show vsf` reports it, e.g. jl658a' },
      { id: 'link1', label: 'Link 1 port (slot/port)', control: 'text', default: '1/51' },
      { id: 'link2', label: 'Link 2 port (slot/port)', control: 'text', default: '1/52' },
      { id: 'secondary', label: 'Standby (secondary) member', control: 'number', default: 2, min: 0, max: 10, hint: '0 for none' },
      { id: 'split_detect', label: 'Split detection over the management port', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const count = num(values, 'members', 2);
      const model = str(values, 'model', 'jl658a').toLowerCase();
      const link1 = str(values, 'link1', '1/51');
      const link2 = str(values, 'link2', '1/52');
      const secondary = num(values, 'secondary', 2);
      const split = bool(values, 'split_detect', true);
      const findings: Finding[] = [];
      for (const link of [link1, link2]) if (!/^\d+\/\d+(:\d+)?$/.test(link)) findings.push(bad('bad-vsf-link', `"${link}" is not a slot/port such as 1/51.`));
      if (count > 10) findings.push(bad('vsf-too-many', 'A VSF stack takes at most 10 members.'));
      if (secondary === 0) findings.push(warn('vsf-no-standby', 'No standby member: when the conductor fails, the whole stack reboots instead of failing over.', 'Name a secondary member, usually member 2.'));
      else if (secondary === 1 || secondary > count) findings.push(bad('vsf-bad-standby', `Member ${secondary} cannot be the standby: it is the conductor or not in the stack.`));
      if (!split) findings.push(warn('vsf-no-split-detect', 'Without split detection, a broken ring leaves two halves with the same addresses both active.'));
      const members = Array.from({ length: Math.min(count, 10) }, (_, i) => i + 1);
      return {
        platform: PLATFORM,
        title: `VSF stack of ${count} members`,
        impact: 'outage',
        notes: [
          'Each new member has to be renumbered first, from its own console: `vsf member 1` → `vsf renumber-to <n>`. It reboots and joins the stack, and its own configuration is replaced by the conductor’s.',
          'Setting the secondary member reboots that member.',
          'Wire the links as a ring (member n link 2 to member n+1 link 1, and the last back to the first) so one broken cable does not split the stack.',
        ],
        findings,
        before: ['show vsf', 'show vsf topology', 'show running-config vsf'],
        config: [
          ...members.flatMap((m) => [`vsf member ${m}`, `    type ${model}`, `    link 1 ${m}/${link1}`, `    link 2 ${m}/${link2}`, '!']),
          ...(secondary > 1 && secondary <= count ? [`vsf secondary-member ${secondary}`] : []),
          ...(split ? ['vsf split-detect mgmt'] : []),
          '!',
        ],
        verify: ['show vsf', 'show vsf topology', 'show vsf link', 'show vsf detail'],
        backout: [...(split ? ['no vsf split-detect'] : []), ...(secondary > 1 && secondary <= count ? ['no vsf secondary-member'] : []), ...members.filter((m) => m > 1).reverse().map((m) => `no vsf member ${m}`)],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_vrrp',
    platform: PLATFORM,
    label: 'VRRP gateway',
    group: 'High availability (VSX/VSF)',
    description: 'A VRRP virtual gateway on a VLAN interface, for a pair of switches that are not a VSX pair.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN interface', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'vrid', label: 'VRRP group (VRID)', control: 'number', default: 10, min: 1, max: 255 },
      { id: 'address', label: 'This switch’s SVI address', control: 'text', default: '10.1.10.2/24' },
      { id: 'virtual', label: 'Virtual address', control: 'text', default: '10.1.10.1' },
      { id: 'priority', label: 'Priority', control: 'number', default: 110, min: 1, max: 254, hint: 'Higher wins; 100 is the default' },
      { id: 'preempt', label: 'Preempt', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlan = num(values, 'vlan_id', 10);
      const vrid = num(values, 'vrid', 10);
      const text = str(values, 'address', '');
      const cidr = parseCidrDual(text);
      const vip = str(values, 'virtual', '');
      const priority = num(values, 'priority', 110);
      const preempt = bool(values, 'preempt', true);
      const family = cidr?.family === 6 ? 'ipv6' : 'ipv4';
      const findings: Finding[] = [];
      if (!cidr) findings.push(bad('bad-address', `"${text}" is not an address and prefix.`));
      if (!isIpAny(vip)) findings.push(bad('bad-virtual', `The virtual address "${vip}" is not an IP address.`));
      else if (cidr && !containsAny(`${cidr.network}/${cidr.prefix}`, vip)) findings.push(bad('virtual-subnet', `The virtual address ${vip} is not in the SVI subnet ${cidr.network}/${cidr.prefix}.`));
      if (priority === 100) findings.push(warn('vrrp-default-priority', 'Priority 100 is the default: with both routers at 100 the master is chosen by address, not by design.'));
      return {
        platform: PLATFORM,
        title: `VRRP ${vrid} on VLAN ${vlan}`,
        impact: 'brief',
        notes: ['On a VSX pair, use the active gateway instead: VRRP makes one member forward and the other wait.', 'Configure the peer with the same VRID and virtual address and a lower priority.'],
        findings,
        before: [`show running-config interface vlan${vlan}`, 'show vrrp brief'],
        config: [
          'router vrrp enable',
          '!',
          `interface vlan ${vlan}`,
          ...(cidr ? [`    ${family === 'ipv6' ? 'ipv6' : 'ip'} address ${cidr.address}/${cidr.prefix}`] : []),
          `    vrrp ${vrid} address-family ${family}`,
          `        address ${vip} primary`,
          `        priority ${priority}`,
          ...(preempt ? ['        preempt'] : ['        no preempt']),
          '        no shutdown',
          '!',
        ],
        verify: ['show vrrp brief', `show vrrp ${vrid} detail`],
        backout: [`interface vlan ${vlan}`, `    no vrrp ${vrid} address-family ${family}`, '!'],
      };
    },
  }),

  /* ------------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_vrf',
    platform: PLATFORM,
    label: 'VRF',
    group: 'Routing',
    description: 'A VRF with its route distinguisher and route targets, and the VLAN interfaces attached to it.',
    inputs: [
      { id: 'name', label: 'VRF name', control: 'text', default: 'PROD' },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: '65001:10', hint: 'ASN:nn or router-id:nn; empty for none' },
      { id: 'route_target', label: 'Route target', control: 'text', default: '65001:10', hint: 'Imported and exported; empty for none' },
      { id: 'evpn', label: 'Route targets for EVPN', control: 'toggle', default: false },
      { id: 'vlans', label: 'VLAN interfaces to attach', control: 'text', default: '', hint: 'e.g. 10,20; attaching clears their addresses' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'name', 'PROD');
      const rd = str(values, 'rd', '');
      const rt = str(values, 'route_target', '');
      const evpn = bool(values, 'evpn', false);
      const vlans = vlanIds(str(values, 'vlans', ''));
      const findings: Finding[] = [...vrfFindings(name)];
      if (rd && !isRouteTag(rd)) findings.push(bad('bad-rd', `"${rd}" is not a route distinguisher (ASN:nn or 10.0.0.1:nn).`));
      if (rt && !isRouteTag(rt)) findings.push(bad('bad-rt', `"${rt}" is not a route target (ASN:nn).`));
      if (vlans.length > 0) findings.push(warn('vrf-attach-clears', `Attaching VLAN ${vlanRange(vlans)} to ${name} removes the addresses already on those interfaces: they stop routing until they are re-addressed.`, 'Re-apply the addresses in the same change (the SVI blueprint with this VRF).'));
      const suffix = evpn ? ' evpn' : '';
      return {
        platform: PLATFORM,
        title: `VRF ${name}`,
        impact: vlans.length > 0 ? 'outage' : 'none',
        findings,
        before: ['show vrf', ...vlans.map((v) => `show running-config interface vlan${v}`)],
        config: [
          `vrf ${name}`,
          ...(rd ? [`    rd ${rd}`] : []),
          ...(rt ? ['    address-family ipv4 unicast', `        route-target export ${rt}${suffix}`, `        route-target import ${rt}${suffix}`] : []),
          '!',
          ...vlans.flatMap((v) => [`interface vlan ${v}`, `    vrf attach ${name}`, '!']),
        ],
        verify: ['show vrf', `show ip route vrf ${name}`, `show ip interface brief vrf ${name}`],
        backout: [...vlans.flatMap((v) => [`interface vlan ${v}`, `    no vrf attach ${name}`, '!']), `no vrf ${name}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_ospf',
    platform: PLATFORM,
    label: 'OSPF',
    group: 'Routing',
    description: 'An OSPFv2 process with its router id and area, enabled on the links and loopbacks that take part, with optional message-digest authentication.',
    inputs: [
      { id: 'process', label: 'Process id', control: 'number', default: 1, min: 1, max: 63 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.11' },
      { id: 'area', label: 'Area', control: 'text', default: '0.0.0.0' },
      { id: 'interfaces', label: 'Active interfaces', control: 'text', default: '1/1/49, 1/1/50', hint: 'Ports, lag1, vlan10: interfaces that form adjacencies' },
      { id: 'passive', label: 'Passive interfaces', control: 'text', default: 'loopback0, vlan10', hint: 'Advertised, but no adjacency' },
      { id: 'p2p', label: 'Point-to-point network type on the active interfaces', control: 'toggle', default: true },
      { id: 'auth', label: 'Message-digest authentication', control: 'toggle', default: true },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the default VRF' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const process = num(values, 'process', 1);
      const routerId = str(values, 'router_id', '');
      const areaText = str(values, 'area', '0.0.0.0');
      const area = ospfArea(areaText);
      const active = interfaceList(str(values, 'interfaces', ''));
      const passive = interfaceList(str(values, 'passive', ''));
      const p2p = bool(values, 'p2p', true);
      const auth = bool(values, 'auth', true);
      const vrf = str(values, 'vrf', '');
      const areaOut = area ?? areaText;
      const findings: Finding[] = [...routerIdFindings(routerId), ...interfaceFindings('the active interfaces', active.invalid), ...interfaceFindings('the passive interfaces', passive.invalid)];
      if (!area) findings.push(bad('bad-area', `"${areaText}" is not an OSPF area: write it as 0.0.0.0 or a number.`));
      if (active.names.length === 0) findings.push(warn('ospf-no-adjacency', 'No active interface: the process advertises its passive networks to nobody.'));
      if (!auth && active.names.length > 0) findings.push(warn('ospf-no-auth', 'The adjacencies are unauthenticated: anything that can reach the link can inject routes.'));
      for (const name of active.names.filter((n) => passive.names.includes(n))) findings.push(warn('ospf-active-and-passive', `${name} is listed as both active and passive; it ends up passive.`));
      const perInterface = (name: string, isPassive: boolean) => [
        `interface ${name}`,
        `    ip ospf ${process} area ${areaOut}`,
        ...(isPassive ? ['    ip ospf passive'] : [...(p2p ? ['    ip ospf network point-to-point'] : []), ...(auth ? ['    ip ospf authentication message-digest', `    ip ospf message-digest-key 1 md5 plaintext ${SECRET}`] : [])]),
        '!',
      ];
      const undo = (name: string, isPassive: boolean) => [
        `interface ${name}`,
        `    no ip ospf ${process} area ${areaOut}`,
        ...(isPassive ? ['    no ip ospf passive'] : [...(p2p ? ['    no ip ospf network'] : []), ...(auth ? ['    no ip ospf authentication', '    no ip ospf message-digest-key 1'] : [])]),
        '!',
      ];
      const passiveOnly = passive.names;
      const activeOnly = active.names.filter((n) => !passiveOnly.includes(n));
      return {
        platform: PLATFORM,
        title: `OSPF ${process} area ${areaOut}`,
        impact: 'brief',
        notes: [...(auth ? [`Replace ${SECRET} with the OSPF key from your vault; the neighbour needs the same key id and key.`] : []), 'Both ends of a link must agree on the area, the network type, the MTU and the authentication.'],
        findings,
        before: ['show ip ospf', 'show ip ospf neighbors', 'show ip ospf interface brief', 'show ip route ospf'],
        config: [
          `router ospf ${process}${vrf ? ` vrf ${vrf}` : ''}`,
          `    router-id ${routerId}`,
          `    area ${areaOut}`,
          '!',
          ...activeOnly.flatMap((n) => perInterface(n, false)),
          ...passiveOnly.flatMap((n) => perInterface(n, true)),
        ],
        verify: [`show ip ospf neighbors${vrf ? ` vrf ${vrf}` : ''}`, 'show ip ospf interface brief', `show ip route ospf${vrf ? ` vrf ${vrf}` : ''}`, 'show ip ospf lsdb'],
        backout: [...activeOnly.flatMap((n) => undo(n, false)), ...passiveOnly.flatMap((n) => undo(n, true)), `no router ospf ${process}${vrf ? ` vrf ${vrf}` : ''}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_bgp_peer',
    platform: PLATFORM,
    label: 'BGP peer',
    group: 'Routing',
    description: 'A BGP neighbour with authentication and a maximum-prefix limit, and the networks this switch advertises to it.',
    inputs: [
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1, max: 4294967295 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.11' },
      { id: 'neighbor', label: 'Neighbour address', control: 'text', default: '10.0.12.1' },
      { id: 'remote_as', label: 'Neighbour AS', control: 'number', default: 65000, min: 1, max: 4294967295 },
      { id: 'peer_description', label: 'Description', control: 'text', default: 'core-01' },
      { id: 'networks', label: 'Networks to advertise', control: 'text', default: '10.1.0.0/16', hint: 'Must be in the routing table to be advertised' },
      { id: 'max_prefix', label: 'Maximum prefixes', control: 'number', default: 1000, min: 0, hint: '0 for no limit' },
      { id: 'auth', label: 'Authenticate the session (TCP MD5)', control: 'toggle', default: true },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the default VRF' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const asn = num(values, 'local_as', 65001);
      const remote = num(values, 'remote_as', 65000);
      const routerId = str(values, 'router_id', '');
      const neighbor = str(values, 'neighbor', '');
      const nets = listOf(str(values, 'networks', '')).map((n) => ({ text: n, cidr: parseCidrDual(n) }));
      const max = num(values, 'max_prefix', 1000);
      const auth = bool(values, 'auth', true);
      const vrf = str(values, 'vrf', '');
      const family = neighbor.includes(':') ? 'ipv6' : 'ipv4';
      const findings: Finding[] = [...routerIdFindings(routerId), ...nets.filter((n) => !n.cidr).map((n) => bad('bad-network', `"${n.text}" is not a network and prefix.`))];
      if (!isIpAny(neighbor)) findings.push(bad('bad-neighbor', `The neighbour "${neighbor}" is not an IP address.`));
      for (const n of nets) {
        if (n.cidr && (n.cidr.family === 6) !== (family === 'ipv6')) findings.push(bad('network-family', `${n.text} is not the neighbour's address family, so it is not advertised to it.`));
      }
      if (max === 0) {
        findings.push(warn('no-max-prefix', 'The session has no maximum-prefix limit: a neighbour that leaks a full table can exhaust the switch’s route table.', 'Set a limit a little above what the neighbour should send.'));
      }
      if (!auth && remote !== asn) findings.push(warn('bgp-no-auth', 'The eBGP session is unauthenticated.', 'Set a TCP MD5 password agreed with the neighbour.'));
      const inner = vrf ? '        ' : '    ';
      const context = vrf ? [`router bgp ${asn}`, `    vrf ${vrf}`] : [`router bgp ${asn}`];
      return {
        platform: PLATFORM,
        title: `BGP ${asn} peer ${neighbor} (AS ${remote})`,
        impact: 'brief',
        notes: [...(auth ? [`Replace ${SECRET} with the session password agreed with the neighbour.`] : []), 'Nothing is filtered: add route maps before this carries anything but a lab or a private network.'],
        findings,
        before: ['show bgp all summary', `show bgp ${family} unicast summary${vrf ? ` vrf ${vrf}` : ''}`, 'show running-config bgp'],
        config: [
          `router bgp ${asn}`,
          `    bgp router-id ${routerId}`,
          ...(vrf ? [`    vrf ${vrf}`] : []),
          `${inner}neighbor ${neighbor} remote-as ${remote}`,
          `${inner}neighbor ${neighbor} description ${description(str(values, 'peer_description', ''), 'peer')}`,
          ...(auth ? [`${inner}neighbor ${neighbor} password plaintext ${SECRET}`] : []),
          `${inner}address-family ${family} unicast`,
          `${inner}    neighbor ${neighbor} activate`,
          ...(max > 0 ? [`${inner}    neighbor ${neighbor} maximum-prefix ${max}`] : []),
          ...nets.filter((n) => n.cidr).map((n) => `${inner}    network ${n.cidr!.network}/${n.cidr!.prefix}`),
          `${inner}exit-address-family`,
          '!',
        ],
        verify: ['show bgp all summary', `show bgp ${family} unicast neighbors ${neighbor}${vrf ? ` vrf ${vrf}` : ''}`, `show bgp ${family} unicast${vrf ? ` vrf ${vrf}` : ''}`],
        backout: [
          ...context,
          `${inner}address-family ${family} unicast`,
          ...nets.filter((n) => n.cidr).map((n) => `${inner}    no network ${n.cidr!.network}/${n.cidr!.prefix}`),
          `${inner}exit-address-family`,
          `${inner}no neighbor ${neighbor}`,
          '!',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_static_route',
    platform: PLATFORM,
    label: 'Static routes',
    group: 'Routing',
    description: 'Static routes to a next hop, IPv4 or IPv6, optionally in a VRF.',
    inputs: [
      { id: 'prefixes', label: 'Destinations', control: 'text', default: '10.50.0.0/16, 10.60.0.0/16' },
      { id: 'next_hop', label: 'Next hop', control: 'text', default: '10.0.12.1' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the default VRF' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const prefixes = listOf(str(values, 'prefixes', '')).map((p) => ({ text: p, cidr: parseCidrDual(p) }));
      const nh = str(values, 'next_hop', '');
      const vrf = str(values, 'vrf', '');
      const nhFamily = nh.includes(':') ? 6 : 4;
      const findings: Finding[] = prefixes.filter((p) => !p.cidr).map((p) => bad('bad-prefix', `"${p.text}" is not a network and prefix.`));
      if (!isIpAny(nh)) findings.push(bad('bad-next-hop', `The next hop "${nh}" is not an IP address.`));
      const good = prefixes.flatMap((p) => (p.cidr ? [p.cidr] : []));
      for (const c of good.filter((c) => c.family !== nhFamily)) findings.push(bad('route-family', `${c.network}/${c.prefix} and the next hop ${nh} are different address families.`));
      if (good.some((c) => c.prefix === 0)) findings.push(warn('default-route', 'This includes a default route: everything the switch has no better route for goes to this next hop.'));
      const route = (c: { family: 4 | 6; network: string; prefix: number }) => `${c.family === 6 ? 'ipv6' : 'ip'} route ${c.network}/${c.prefix} ${nh}${vrf ? ` vrf ${vrf}` : ''}`;
      const usable = good.filter((c) => c.family === nhFamily);
      return {
        platform: PLATFORM,
        title: `${usable.length} static route(s) via ${nh}`,
        impact: 'brief',
        findings,
        before: [`show ip route${vrf ? ` vrf ${vrf}` : ''}`, 'show running-config | include route'],
        config: [...usable.map(route), '!'],
        verify: [`show ${nhFamily === 6 ? 'ipv6' : 'ip'} route static${vrf ? ` vrf ${vrf}` : ''}`, ...usable.slice(0, 2).map((c) => `show ${c.family === 6 ? 'ipv6' : 'ip'} route ${c.network}/${c.prefix}${vrf ? ` vrf ${vrf}` : ''}`)],
        backout: usable.map((c) => `no ${route(c)}`),
      };
    },
  }),

  /* ------------------------------------------------------------------------ *
   * Security
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_acl',
    platform: PLATFORM,
    label: 'IPv4 access list',
    group: 'Security',
    description: 'An IPv4 access list from a list of rules, applied to a port, a VLAN or a routed VLAN interface.',
    inputs: [
      { id: 'name', label: 'Name', control: 'text', default: 'SERVERS_IN' },
      {
        id: 'rules',
        label: 'Rules',
        control: 'textarea',
        default: 'permit tcp any 10.20.0.0/24 eq 443\npermit icmp any 10.20.0.0/24\ndeny any any any',
        hint: 'One per line: permit|deny protocol source destination [eq port]; addresses as 10.0.0.0/24, a host 10.0.0.5, or any',
      },
      { id: 'apply', label: 'Apply to', control: 'select', default: 'port', options: [{ value: 'port', label: 'A port (in)' }, { value: 'vlan', label: 'A VLAN (in)' }, { value: 'routed', label: 'A VLAN interface (routed-in)' }, { value: 'none', label: 'Nothing yet' }] },
      { id: 'target', label: 'Port or VLAN', control: 'text', default: '1/1/10', showWhen: { input: 'apply', notEquals: ['none'] } },
      { id: 'log', label: 'Log denies', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'name', 'ACL').replace(/\s+/g, '_');
      const apply = str(values, 'apply', 'port');
      const target = str(values, 'target', '');
      const log = bool(values, 'log', true);
      const lines = str(values, 'rules', '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const findings: Finding[] = [];
      const entries: string[] = [];
      lines.forEach((line) => {
        const t = line.split(/\s+/);
        const [action = '', proto = '', src = '', dst = '', ...rest] = t;
        const s = aclAddress(src);
        const d = aclAddress(dst);
        if (!['permit', 'deny'].includes(action) || !proto || !s || !d) {
          findings.push(bad('bad-acl-rule', `"${line}" is not a rule this list can take: permit|deny protocol source destination [eq port], IPv4 only.`));
          return;
        }
        const tail = rest.join(' ');
        const logged = action === 'deny' && log && !/\blog\b/.test(tail) ? ' log' : '';
        entries.push(`    ${(entries.length + 1) * 10} ${action} ${proto} ${s} ${d}${tail ? ` ${tail}` : ''}${logged}`);
      });
      if (lines.length === 0) findings.push(bad('empty-acl', 'An access list with no rules denies everything once applied, which is almost never what is wanted.'));
      let context: string[] = [];
      let applyLine = '';
      if (apply === 'port') {
        const { ports, invalid } = portList(target);
        findings.push(...portFindings('the target', invalid));
        context = ports.length > 0 ? [`interface ${ports[0]}`] : [];
        applyLine = `apply access-list ip ${name} in`;
      } else if (apply === 'vlan' || apply === 'routed') {
        const id = Number(target);
        if (!Number.isInteger(id) || id < 1 || id > 4094) findings.push(bad('bad-acl-target', `"${target}" is not a VLAN id.`));
        else context = [apply === 'vlan' ? `vlan ${id}` : `interface vlan ${id}`];
        applyLine = `apply access-list ip ${name} ${apply === 'vlan' ? 'in' : 'routed-in'}`;
      }
      const applied = context.length > 0;
      if (applied) findings.push(info('network.aoscx.acl-implicit-deny', 'Every AOS-CX access list ends in an implicit deny: whatever the rules do not permit is dropped once it is applied.', { source: SOURCE }));
      return {
        platform: PLATFORM,
        title: `Access list ${name}${applied ? ` on ${context[0]}` : ''}`,
        impact: applied ? 'brief' : 'none',
        notes: applied ? ['Applying a list that is missing a permit cuts traffic the moment it is applied.', CHECKPOINT] : [],
        findings,
        before: ['show access-list', ...(applied ? [`show running-config ${context[0]!.replace(/^interface vlan /, 'interface vlan').replace(/^vlan /, 'vlan ')}`] : [])],
        config: [`access-list ip ${name}`, ...entries, '!', ...(applied ? [context[0]!, `    ${applyLine}`, '!'] : [])],
        verify: [`show access-list ip ${name}`, ...(applied ? [`show access-list hitcounts ip ${name}`] : [])],
        backout: [...(applied ? [context[0]!, `    no ${applyLine}`, '!'] : []), `no access-list ip ${name}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_dot1x',
    platform: PLATFORM,
    label: '802.1X and MAC authentication',
    group: 'Security',
    description: 'RADIUS servers in a server group, 802.1X with MAC-authentication fallback on access ports, and change of authorization from the policy server.',
    inputs: [
      { id: 'servers', label: 'RADIUS servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'group', label: 'Server group', control: 'text', default: 'NAC' },
      { id: 'vrf', label: 'VRF', control: 'select', default: 'mgmt', options: [{ value: 'mgmt', label: 'mgmt' }, { value: 'default', label: 'default' }] },
      { id: 'ports', label: 'Ports', control: 'text', default: '1/1/1-1/1/24' },
      { id: 'mac_auth', label: 'MAC authentication for devices without a supplicant', control: 'toggle', default: true },
      { id: 'coa', label: 'Accept change of authorization (CoA)', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'servers', ''));
      const group = str(values, 'group', 'NAC').replace(/\s+/g, '_');
      const vrf = str(values, 'vrf', 'mgmt');
      const { ports, invalid } = portList(str(values, 'ports', ''));
      const macAuth = bool(values, 'mac_auth', true);
      const coa = bool(values, 'coa', true);
      const findings: Finding[] = [...portFindings('the ports', invalid), ...servers.filter((s) => !isIpAny(s)).map((s) => bad('bad-radius-server', `The RADIUS server "${s}" is not an IP address.`))];
      if (servers.length === 0) findings.push(bad('no-radius-server', 'No RADIUS server is given: every port would fail authentication.'));
      if (servers.length === 1) findings.push(warn('single-radius', 'One RADIUS server: when it is down, nothing new on these ports authenticates.', 'Add a second server.'));
      const methods = ['dot1x authenticator', ...(macAuth ? ['mac-auth'] : [])];
      return {
        platform: PLATFORM,
        title: `802.1X${macAuth ? ' and MAC authentication' : ''} on ${ports.length} port(s)`,
        impact: 'outage',
        notes: [
          `Replace every ${SECRET} with the RADIUS shared secret from your vault.`,
          'Every device on these ports has to authenticate once this is applied. Roll it out in monitor mode on the policy server first, and never on uplinks.',
        ],
        findings,
        before: ['show radius-server detail', 'show aaa authentication port-access interface all client-status', ...ports.slice(0, 2).map((p) => `show running-config interface ${p}`)],
        config: [
          ...servers.map((s) => `radius-server host ${s} key plaintext ${SECRET} vrf ${vrf}`),
          `aaa group server radius ${group}`,
          ...servers.map((s) => `    server ${s} vrf ${vrf}`),
          '!',
          ...methods.flatMap((m) => [`aaa authentication port-access ${m}`, `    radius server-group ${group}`, '    enable', '!']),
          ...(coa ? ['radius dyn-authorization enable', ...servers.map((s) => `radius dyn-authorization client ${s} secret-key plaintext ${SECRET} vrf ${vrf}`), '!'] : []),
          ...ports.flatMap((p) => [`interface ${p}`, ...methods.flatMap((m) => [`    aaa authentication port-access ${m}`, '        enable']), '!']),
        ],
        verify: ['show radius-server detail', 'show aaa authentication port-access interface all client-status', 'show port-access clients'],
        backout: [
          ...ports.flatMap((p) => [`interface ${p}`, ...methods.map((m) => `    no aaa authentication port-access ${m}`), '!']),
          ...methods.map((m) => `no aaa authentication port-access ${m}`),
          ...(coa ? [...servers.map((s) => `no radius dyn-authorization client ${s} vrf ${vrf}`), 'no radius dyn-authorization enable'] : []),
          `no aaa group server radius ${group}`,
          ...servers.map((s) => `no radius-server host ${s} vrf ${vrf}`),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_dhcp_snooping',
    platform: PLATFORM,
    label: 'DHCP snooping, ARP inspection and source lockout',
    group: 'Security',
    description: 'DHCPv4 snooping on user VLANs with the uplink trusted, dynamic ARP inspection, and IPv4 source lockout on the access ports.',
    inputs: [
      { id: 'vlans', label: 'VLANs', control: 'text', default: '10,20' },
      { id: 'trusted', label: 'Trusted ports (towards the DHCP server)', control: 'text', default: '1/1/49, 1/1/50', hint: 'Uplinks, or lag1' },
      { id: 'servers', label: 'Authorised DHCP servers', control: 'text', default: '10.0.0.50', hint: 'Empty to accept any server on a trusted port' },
      { id: 'arp', label: 'Dynamic ARP inspection', control: 'toggle', default: true },
      { id: 'lockout_ports', label: 'Source lockout ports', control: 'text', default: '1/1/1-1/1/24', hint: 'Empty for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlans = vlanIds(str(values, 'vlans', ''));
      const trusted = interfaceList(str(values, 'trusted', ''));
      const servers = listOf(str(values, 'servers', ''));
      const arp = bool(values, 'arp', true);
      const lockout = portList(str(values, 'lockout_ports', ''));
      const findings: Finding[] = [
        ...interfaceFindings('the trusted ports', trusted.invalid),
        ...portFindings('the source lockout ports', lockout.invalid),
        ...servers.filter((s) => !isIpv4(s)).map((s) => bad('bad-dhcp-server', `The DHCP server "${s}" is not an IPv4 address.`)),
      ];
      if (vlans.length === 0) findings.push(bad('snooping-no-vlans', 'No VLAN is given, so snooping protects nothing.'));
      if (trusted.names.length === 0) {
        findings.push(bad('snooping-no-trusted', 'No trusted port: every DHCP offer is dropped and no client on these VLANs gets an address.', 'Trust the uplinks towards the DHCP server or relay.'));
      }
      for (const p of lockout.ports.filter((x) => trusted.names.includes(x))) findings.push(warn('lockout-on-trusted', `${p} is trusted and has source lockout: traffic from anything behind it without a binding is dropped.`));
      if (arp || lockout.ports.length > 0) findings.push(info('network.aoscx.static-hosts', 'Hosts with static addresses have no DHCP binding: ARP inspection and source lockout drop them unless they get a static binding (`ipv4 source-binding`).', { source: SOURCE }));
      const range = vlanRange(vlans);
      return {
        platform: PLATFORM,
        title: `DHCP snooping on VLAN ${range || '(none)'}`,
        impact: 'brief',
        notes: ['Enable snooping first and let the binding table fill for a full lease time before turning on ARP inspection and source lockout, or clients with a current lease are dropped until they renew.'],
        findings,
        before: ['show dhcpv4-snooping', 'show dhcpv4-snooping binding', ...(arp ? ['show arp inspection interface'] : [])],
        config: [
          'dhcpv4-snooping',
          ...servers.map((s) => `dhcpv4-snooping authorized-server ${s}`),
          '!',
          ...vlans.flatMap((v) => [`vlan ${v}`, '    dhcpv4-snooping', ...(arp ? ['    arp inspection'] : []), '!']),
          ...trusted.names.flatMap((n) => [`interface ${n}`, '    dhcpv4-snooping trust', ...(arp ? ['    arp inspection trust'] : []), '!']),
          ...lockout.ports.flatMap((p) => [`interface ${p}`, '    ipv4 source-lockout', '!']),
        ],
        verify: ['show dhcpv4-snooping', 'show dhcpv4-snooping binding', 'show dhcpv4-snooping statistics', ...(arp ? ['show arp inspection statistics'] : []), ...(lockout.ports.length > 0 ? ['show ipv4 source-lockout'] : [])],
        backout: [
          ...lockout.ports.flatMap((p) => [`interface ${p}`, '    no ipv4 source-lockout', '!']),
          ...trusted.names.flatMap((n) => [`interface ${n}`, ...(arp ? ['    no arp inspection trust'] : []), '    no dhcpv4-snooping trust', '!']),
          ...vlans.flatMap((v) => [`vlan ${v}`, ...(arp ? ['    no arp inspection'] : []), '    no dhcpv4-snooping', '!']),
          ...servers.map((s) => `no dhcpv4-snooping authorized-server ${s}`),
          'no dhcpv4-snooping',
        ],
      };
    },
  }),

  /* ------------------------------------------------------------------------ *
   * Data center (EVPN)
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_evpn_vtep',
    platform: PLATFORM,
    label: 'VXLAN tunnel endpoint and L2 VNIs',
    group: 'Data center (EVPN)',
    description: 'The VTEP source loopback, `interface vxlan 1` with each VLAN mapped to a VNI, and the EVPN instance for each VLAN with automatic RD and route targets.',
    inputs: [
      { id: 'loopback_id', label: 'VTEP loopback id', control: 'number', default: 1, min: 0, max: 255 },
      { id: 'source', label: 'VTEP source address', control: 'text', default: '10.255.1.11', hint: 'On a VSX pair, the same address on both members' },
      { id: 'create_loopback', label: 'Create the loopback', control: 'toggle', default: true },
      { id: 'ospf_area', label: 'Advertise the loopback in OSPF area', control: 'text', default: '0.0.0.0', hint: 'Empty if the underlay is BGP', showWhen: { input: 'create_loopback', equals: ['true'] } },
      { id: 'vnis', label: 'VLAN to VNI', control: 'text', default: '10=10010, 20=10020', hint: 'vlan=vni, comma separated' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const lo = num(values, 'loopback_id', 1);
      const source = str(values, 'source', '');
      const create = bool(values, 'create_loopback', true);
      const area = create ? str(values, 'ospf_area', '') : '';
      const findings: Finding[] = [];
      if (!isIpv4(source)) findings.push(bad('bad-vtep-source', `The VTEP source "${source}" is not an IPv4 address.`));
      const maps: { vlan: number; vni: number }[] = [];
      for (const { key, value } of pairs(str(values, 'vnis', ''))) {
        const vlan = Number(key);
        const vni = Number(value);
        if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094 || !Number.isInteger(vni) || vni < 1 || vni > 16777214) {
          findings.push(bad('bad-vni-map', `"${key}=${value}" is not a VLAN (1-4094) mapped to a VNI (1-16777214).`));
          continue;
        }
        if (maps.some((m) => m.vni === vni || m.vlan === vlan)) {
          findings.push(bad('duplicate-vni', `VLAN ${vlan} or VNI ${vni} is mapped twice.`));
          continue;
        }
        maps.push({ vlan, vni });
      }
      if (maps.length === 0) findings.push(bad('no-vnis', 'No VLAN is mapped to a VNI.'));
      return {
        platform: PLATFORM,
        title: `VXLAN VTEP ${source} with ${maps.length} L2 VNI(s)`,
        impact: 'none',
        notes: [
          'The VLANs have to exist, and the VTEP source has to be reachable from every other VTEP through the underlay.',
          'The overlay needs BGP EVPN peering to learn remote VTEPs: see the EVPN overlay blueprint.',
          'The underlay MTU has to carry the VXLAN header: 50 bytes more than the largest host frame.',
        ],
        findings,
        before: ['show interface vxlan 1', 'show evpn evi', 'show vlan'],
        config: [
          ...(create && isIpv4(source) ? [`interface loopback ${lo}`, `    ip address ${source}/32`, ...(area ? [`    ip ospf 1 area ${area}`] : []), '!'] : []),
          'interface vxlan 1',
          `    source ip ${source}`,
          '    no shutdown',
          ...maps.flatMap((m) => [`    vni ${m.vni}`, `        vlan ${m.vlan}`]),
          '!',
          'evpn',
          ...maps.flatMap((m) => [`    vlan ${m.vlan}`, '        rd auto', '        route-target export auto', '        route-target import auto']),
          '!',
        ],
        verify: ['show interface vxlan 1', 'show interface vxlan vteps', 'show evpn evi', 'show evpn mac-ip', 'show bgp l2vpn evpn summary'],
        backout: [
          'evpn',
          ...maps.map((m) => `    no vlan ${m.vlan}`),
          '!',
          'interface vxlan 1',
          ...maps.map((m) => `    no vni ${m.vni}`),
          '!',
          ...(create ? [`no interface loopback ${lo}`] : []),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_evpn_overlay',
    platform: PLATFORM,
    label: 'BGP EVPN overlay peering',
    group: 'Data center (EVPN)',
    description: 'A leaf’s BGP sessions to the spines (the route reflectors) over loopbacks, with the L2VPN EVPN address family and extended communities.',
    inputs: [
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1, max: 4294967295 },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.0.11' },
      { id: 'spines', label: 'Spine loopback addresses', control: 'text', default: '10.255.0.1, 10.255.0.2' },
      { id: 'spine_as', label: 'Spine AS', control: 'number', default: 65001, min: 1, max: 4294967295, hint: 'The same as the local AS for iBGP with route reflectors' },
      { id: 'update_source', label: 'Update source loopback id', control: 'number', default: 0, min: 0, max: 255 },
      { id: 'auth', label: 'Authenticate the sessions', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const asn = num(values, 'local_as', 65001);
      const spineAs = num(values, 'spine_as', 65001);
      const routerId = str(values, 'router_id', '');
      const spines = listOf(str(values, 'spines', ''));
      const lo = num(values, 'update_source', 0);
      const auth = bool(values, 'auth', true);
      const ebgp = spineAs !== asn;
      const findings: Finding[] = [...routerIdFindings(routerId), ...spines.filter((s) => !isIpv4(s)).map((s) => bad('bad-spine', `The spine "${s}" is not an IPv4 address.`))];
      const good = spines.filter(isIpv4);
      if (good.length === 0) findings.push(bad('no-spines', 'No spine address: the overlay has no one to learn remote VTEPs from.'));
      if (good.length === 1) findings.push(warn('single-spine', 'One spine: when it fails, the leaf loses every EVPN route.', 'Peer with at least two spines.'));
      return {
        platform: PLATFORM,
        title: `BGP ${asn} EVPN overlay to ${good.length} spine(s)`,
        impact: 'brief',
        notes: [...(auth ? [`Replace ${SECRET} with the session password from your vault.`] : []), 'The loopbacks have to be reachable through the underlay before the sessions come up.'],
        findings,
        before: ['show bgp all summary', 'show bgp l2vpn evpn summary', 'show running-config bgp'],
        config: [
          `router bgp ${asn}`,
          `    bgp router-id ${routerId}`,
          ...good.flatMap((s) => [
            `    neighbor ${s} remote-as ${spineAs}`,
            `    neighbor ${s} update-source loopback ${lo}`,
            ...(ebgp ? [`    neighbor ${s} ebgp-multihop 3`] : []),
            ...(auth ? [`    neighbor ${s} password plaintext ${SECRET}`] : []),
          ]),
          '    address-family l2vpn evpn',
          ...good.flatMap((s) => [`        neighbor ${s} activate`, `        neighbor ${s} send-community extended`]),
          '    exit-address-family',
          '!',
        ],
        verify: ['show bgp l2vpn evpn summary', 'show bgp l2vpn evpn', 'show evpn evi', 'show interface vxlan vteps'],
        backout: [`router bgp ${asn}`, ...good.map((s) => `    no neighbor ${s}`), '!'],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_evpn_l3vni',
    platform: PLATFORM,
    label: 'EVPN L3 VNI (symmetric IRB)',
    group: 'Data center (EVPN)',
    description: 'A tenant VRF routed across the fabric: EVPN route targets on the VRF, its L3 VNI on the VXLAN interface, and the VRF in BGP.',
    inputs: [
      { id: 'vrf', label: 'VRF', control: 'text', default: 'TENANT1' },
      { id: 'l3vni', label: 'L3 VNI', control: 'number', default: 50001, min: 1, max: 16777214 },
      { id: 'rd', label: 'Route distinguisher', control: 'text', default: '10.255.0.11:1', hint: 'router-id:nn, unique per switch' },
      { id: 'route_target', label: 'Route target', control: 'text', default: '65001:50001' },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1, max: 4294967295 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vrf = str(values, 'vrf', 'TENANT1');
      const vni = num(values, 'l3vni', 50001);
      const rd = str(values, 'rd', '');
      const rt = str(values, 'route_target', '');
      const asn = num(values, 'local_as', 65001);
      const findings: Finding[] = [...vrfFindings(vrf)];
      if (!isRouteTag(rd)) findings.push(bad('bad-rd', `"${rd}" is not a route distinguisher.`));
      if (!isRouteTag(rt)) findings.push(bad('bad-rt', `"${rt}" is not a route target.`));
      return {
        platform: PLATFORM,
        title: `L3 VNI ${vni} for VRF ${vrf}`,
        impact: 'none',
        notes: [
          'The same VNI and route target on every leaf that has this VRF; the RD is unique per switch.',
          'Attach the tenant’s VLAN interfaces to the VRF and give them the same anycast gateway on every leaf (the active gateway blueprint).',
        ],
        findings,
        before: ['show vrf', 'show interface vxlan 1', 'show bgp l2vpn evpn summary'],
        config: [
          `vrf ${vrf}`,
          `    rd ${rd}`,
          '    address-family ipv4 unicast',
          `        route-target export ${rt} evpn`,
          `        route-target import ${rt} evpn`,
          '!',
          'interface vxlan 1',
          `    vni ${vni}`,
          `        vrf ${vrf}`,
          '        routing',
          '!',
          `router bgp ${asn}`,
          `    vrf ${vrf}`,
          '        address-family ipv4 unicast',
          '            redistribute connected',
          '        exit-address-family',
          '!',
        ],
        verify: ['show vrf', 'show interface vxlan 1', `show ip route vrf ${vrf}`, `show bgp l2vpn evpn`, 'show evpn vtep-neighbor all-vrfs'],
        backout: [`router bgp ${asn}`, `    no vrf ${vrf}`, '!', 'interface vxlan 1', `    no vni ${vni}`, '!', `no vrf ${vrf}`],
      };
    },
  }),
];

export const AOSCX_EXTRA: readonly ChangeBlueprint[] = BLUEPRINTS;

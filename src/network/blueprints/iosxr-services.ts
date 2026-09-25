/**
 * Cisco IOS-XR: MPLS, L2VPN, security, management and first-hop redundancy.
 *
 * The interface and routing changes are in iosxr.ts, which lists these after
 * its own.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import type { ChangeBlueprint } from '../from-change.ts';
import { description, isIpv4, listOf, type DeviceChange } from '../device.ts';
import { dualCidrs, dualFindings, routerIdFindings } from './nxos-eos-dual.ts';
import { COMMIT_CONFIRMED, lines, PLATFORM, ROLLBACK_NOTE, SECRET, SRC, xrAddress, xrBlueprint, xrInterface, xrName } from './iosxr-common.ts';

const MPLS: readonly ChangeBlueprint[] = [
  xrBlueprint({
    id: 'iosxr_mpls_ldp',
    platform: PLATFORM,
    label: 'MPLS LDP',
    group: 'MPLS and L2VPN',
    description: 'LDP with a router id from the loopback, enabled on the core links, with optional IGP sync so traffic is not black-holed while LDP converges.',
    inputs: [
      { id: 'router_id', label: 'LDP router id', control: 'text', default: '10.255.0.1', hint: 'The loopback address' },
      { id: 'interfaces', label: 'Core links', control: 'text', default: 'GigabitEthernet0/0/0/0, GigabitEthernet0/0/0/1' },
      { id: 'igp', label: 'IGP sync', control: 'select', default: 'isis', options: [{ value: 'none', label: 'None' }, { value: 'isis', label: 'IS-IS' }, { value: 'ospf', label: 'OSPF' }] },
      { id: 'process', label: 'IGP instance', control: 'text', default: 'CORE', showWhen: { input: 'igp', notEquals: ['none'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const rid = str(values, 'router_id', '');
      const links = listOf(str(values, 'interfaces', '')).map((i) => xrInterface(i, i));
      const igp = str(values, 'igp', 'isis');
      const process = xrName(str(values, 'process', ''), 'CORE');
      const findings: Finding[] = [...routerIdFindings('network.iosxr.router-id', rid)];
      if (links.length === 0) findings.push(error('network.iosxr.ldp-empty', 'LDP needs at least one interface.', SRC));
      const sync =
        igp === 'isis'
          ? [`router isis ${process}`, ' address-family ipv4 unicast', '  mpls ldp auto-config', ' !', '!']
          : igp === 'ospf'
            ? [`router ospf ${process}`, ' mpls ldp sync', '!']
            : [];
      return {
        platform: PLATFORM,
        title: `MPLS LDP on ${links.length} link(s)`,
        impact: 'brief',
        notes: [
          'The LDP router id must be reachable from every peer through the IGP: use the loopback that the IGP advertises.',
          ...(igp === 'isis' ? ['`mpls ldp auto-config` enables LDP on every IS-IS interface as well as the ones listed.'] : []),
          COMMIT_CONFIRMED,
        ],
        before: ['show running-config mpls ldp', 'show mpls ldp neighbor brief', 'show mpls interfaces'],
        config: ['mpls ldp', ...(rid ? [` router-id ${rid}`] : []), ' log', '  neighbor', ' !', ...links.flatMap((i) => [` interface ${i}`, ' !']), '!', ...sync],
        verify: ['show mpls ldp neighbor brief', 'show mpls ldp interface brief', 'show mpls forwarding', 'show mpls ldp igp sync'],
        backout: ['mpls ldp', ...links.map((i) => ` no interface ${i}`), '!', '! if this change created LDP: no mpls ldp', 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_sr_mpls',
    platform: PLATFORM,
    label: 'Segment routing (SR-MPLS)',
    group: 'MPLS and L2VPN',
    description: 'SR-MPLS in IS-IS or OSPF: the SRGB, `segment-routing mpls` in the IGP and a prefix-SID on the loopback.',
    inputs: [
      { id: 'igp', label: 'IGP', control: 'select', default: 'isis', options: [{ value: 'isis', label: 'IS-IS' }, { value: 'ospf', label: 'OSPF' }] },
      { id: 'process', label: 'IGP instance', control: 'text', default: 'CORE' },
      { id: 'area', label: 'OSPF area', control: 'text', default: '0', showWhen: { input: 'igp', equals: ['ospf'] } },
      { id: 'loopback', label: 'Loopback', control: 'text', default: 'Loopback0' },
      { id: 'sid_index', label: 'Prefix-SID index', control: 'number', default: 1, min: 0, max: 1048575, hint: 'Unique in the domain; label = SRGB base + index' },
      { id: 'srgb_start', label: 'SRGB start', control: 'number', default: 16000, min: 16000, max: 1048575 },
      { id: 'srgb_end', label: 'SRGB end', control: 'number', default: 23999, min: 16001, max: 1048575 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const igp = str(values, 'igp', 'isis');
      const process = xrName(str(values, 'process', ''), 'CORE');
      const loopback = xrInterface(str(values, 'loopback', ''), 'Loopback0');
      const index = num(values, 'sid_index', 1);
      const start = num(values, 'srgb_start', 16000);
      const end = num(values, 'srgb_end', 23999);
      const custom = start !== 16000 || end !== 23999;
      const findings: Finding[] = [];
      if (end <= start) findings.push(error('network.iosxr.srgb', 'The SRGB end has to be above its start.', SRC));
      if (index > end - start) findings.push(error('network.iosxr.sid-range', `Index ${index} is outside an SRGB of ${end - start + 1} labels.`, SRC));
      if (custom) findings.push(warning('network.iosxr.srgb-custom', 'A non-default SRGB only takes effect after a reload on many releases, and every node should use the same one.', SRC));
      const area = str(values, 'area', '0');
      const igpBlock =
        igp === 'ospf'
          ? [`router ospf ${process}`, ' segment-routing mpls', ` area ${area}`, `  interface ${loopback}`, `   prefix-sid index ${index}`, '  !', ' !', '!']
          : [`router isis ${process}`, ' address-family ipv4 unicast', '  segment-routing mpls', ' !', ` interface ${loopback}`, '  address-family ipv4 unicast', `   prefix-sid index ${index}`, '  !', ' !', '!'];
      return {
        platform: PLATFORM,
        title: `SR-MPLS prefix-SID ${index} on ${loopback} (${igp.toUpperCase()} ${process})`,
        impact: 'brief',
        notes: [
          `The node label will be ${start + index}. A duplicate index anywhere in the domain is a conflict the IGP reports and ignores.`,
          'With LDP still running, labels prefer LDP until `segment-routing mpls sr-prefer` is set: a migration is a separate change.',
          COMMIT_CONFIRMED,
        ],
        before: ['show running-config segment-routing', `show running-config router ${igp} ${process}`, 'show mpls label table summary'],
        config: [...(custom ? ['segment-routing', ` global-block ${start} ${end}`, '!'] : []), ...igpBlock],
        verify: [
          igp === 'ospf' ? `show ospf ${process} sid-database` : `show isis ${process} segment-routing label table`,
          `show mpls forwarding labels ${start + index}`,
          'show segment-routing mpls state',
        ],
        backout:
          igp === 'ospf'
            ? [`router ospf ${process}`, ` area ${area}`, `  interface ${loopback}`, `   no prefix-sid index ${index}`, '!', ` no segment-routing mpls`, '!', 'commit']
            : [`router isis ${process}`, ` interface ${loopback}`, '  address-family ipv4 unicast', `   no prefix-sid index ${index}`, '!', ' address-family ipv4 unicast', '  no segment-routing mpls', '!', 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_l2vpn_xconnect',
    platform: PLATFORM,
    label: 'L2VPN point-to-point pseudowire',
    group: 'MPLS and L2VPN',
    description: 'An l2transport sub-interface cross-connected to a remote PE over an LDP pseudowire (`l2vpn xconnect group … p2p`).',
    inputs: [
      { id: 'interface', label: 'Attachment circuit', control: 'text', default: 'GigabitEthernet0/0/0/2' },
      { id: 'vlan', label: 'VLAN tag', control: 'number', default: 200, min: 0, max: 4094, hint: '0 for the whole port' },
      { id: 'group', label: 'Xconnect group', control: 'text', default: 'CUSTOMERS' },
      { id: 'name', label: 'P2P name', control: 'text', default: 'CUST-A-SITE1' },
      { id: 'neighbor', label: 'Remote PE (loopback)', control: 'text', default: '10.255.0.2' },
      { id: 'pw_id', label: 'Pseudowire id', control: 'number', default: 200, min: 1, max: 4294967295, hint: 'The same on both PEs' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const parent = xrInterface(str(values, 'interface', ''), 'GigabitEthernet0/0/0/2');
      const vlan = num(values, 'vlan', 200);
      const ac = vlan > 0 ? `${parent}.${vlan}` : parent;
      const group = xrName(str(values, 'group', ''), 'CUSTOMERS');
      const name = xrName(str(values, 'name', ''), 'PW');
      const neighbor = str(values, 'neighbor', '');
      const pw = num(values, 'pw_id', 200);
      const findings: Finding[] = [];
      if (!isIpv4(neighbor)) findings.push(error('network.iosxr.bad-neighbor', 'The remote PE has to be its IPv4 loopback address.', SRC));
      return {
        platform: PLATFORM,
        title: `Pseudowire ${group}/${name} to ${neighbor} (pw-id ${pw})`,
        impact: 'none',
        notes: ['The remote PE needs the mirror image: same pw-id, pointing back at this loopback. LDP (or SR with targeted LDP) has to be up between the loopbacks.'],
        before: [`show running-config interface ${ac}`, `show running-config l2vpn xconnect group ${group}`, 'show l2vpn xconnect summary'],
        config: [
          `interface ${ac} l2transport`,
          ` description xconnect ${name}`,
          ...(vlan > 0 ? [` encapsulation dot1q ${vlan}`] : []),
          '!',
          'l2vpn',
          ` xconnect group ${group}`,
          `  p2p ${name}`,
          `   interface ${ac}`,
          `   neighbor ipv4 ${neighbor} pw-id ${pw}`,
          '   !',
          '  !',
          ' !',
          '!',
        ],
        verify: [`show l2vpn xconnect group ${group} xc-name ${name} detail`, `show l2vpn xconnect interface ${ac}`, `show mpls ldp neighbor ${neighbor}`],
        backout: ['l2vpn', ` xconnect group ${group}`, `  no p2p ${name}`, '!', ...(vlan > 0 ? [`no interface ${ac}`] : [`interface ${ac}`, ' no l2transport', '!']), 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_bridge_domain',
    platform: PLATFORM,
    label: 'L2VPN bridge-domain with BVI',
    group: 'MPLS and L2VPN',
    description: 'A bridge-domain joining l2transport sub-interfaces, with a routed BVI as the gateway for the segment.',
    inputs: [
      { id: 'bridge_group', label: 'Bridge group', control: 'text', default: 'CUSTOMERS' },
      { id: 'bridge_domain', label: 'Bridge-domain', control: 'text', default: 'BD300' },
      { id: 'vlan', label: 'VLAN tag', control: 'number', default: 300, min: 1, max: 4094 },
      { id: 'interfaces', label: 'Ports', control: 'text', default: 'GigabitEthernet0/0/0/3, GigabitEthernet0/0/0/4', hint: 'Each gets an l2transport sub-interface for the VLAN' },
      { id: 'bvi_address', label: 'BVI address', control: 'text', default: '10.30.0.1/24', hint: 'Empty for a bridge-domain with no gateway' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const bg = xrName(str(values, 'bridge_group', ''), 'BG');
      const bd = xrName(str(values, 'bridge_domain', ''), 'BD');
      const vlan = num(values, 'vlan', 300);
      const ports = listOf(str(values, 'interfaces', '')).map((i) => `${xrInterface(i, i)}.${vlan}`);
      const addrValue = str(values, 'bvi_address', '');
      const dual = dualCidrs(addrValue);
      const findings: Finding[] = addrValue ? dualFindings('network.iosxr.bad-address', 'the BVI address', dual, '10.30.0.1/24') : [];
      const bvi = addrValue && (dual.v4 || dual.v6) ? `BVI${vlan}` : '';
      if (ports.length === 0) findings.push(error('network.iosxr.bd-empty', 'The bridge-domain needs at least one port.', SRC));
      return {
        platform: PLATFORM,
        title: `Bridge-domain ${bg}/${bd} (VLAN ${vlan})`,
        impact: 'none',
        notes: ['`rewrite ingress tag pop 1 symmetric` strips the tag inside the bridge-domain so ports with different tags can share it; the BVI sees untagged frames.'],
        before: [`show running-config l2vpn bridge group ${bg}`, ...ports.map((p) => `show running-config interface ${p}`)],
        config: [
          ...ports.flatMap((p) => [`interface ${p} l2transport`, ` encapsulation dot1q ${vlan}`, ' rewrite ingress tag pop 1 symmetric', '!']),
          ...(bvi ? [`interface ${bvi}`, ` description gateway for ${bd}`, ...(dual.v4 ? [` ${xrAddress(dual.v4)}`] : []), ...(dual.v6 ? [` ${xrAddress(dual.v6)}`] : []), '!'] : []),
          'l2vpn',
          ` bridge group ${bg}`,
          `  bridge-domain ${bd}`,
          ...ports.flatMap((p) => [`   interface ${p}`, '   !']),
          ...(bvi ? [`   routed interface ${bvi}`, '   !'] : []),
          '  !',
          ' !',
          '!',
        ],
        verify: [`show l2vpn bridge-domain bd-name ${bd} detail`, `show l2vpn forwarding bridge-domain ${bg}:${bd} mac-address location 0/0/CPU0`, ...(bvi ? [`show interfaces ${bvi}`] : [])],
        backout: ['l2vpn', ` bridge group ${bg}`, `  no bridge-domain ${bd}`, '!', ...(bvi ? [`no interface ${bvi}`] : []), ...ports.map((p) => `no interface ${p}`), 'commit'],
        findings,
      };
    },
  }),
];

const SECURITY: readonly ChangeBlueprint[] = [
  xrBlueprint({
    id: 'iosxr_acl',
    platform: PLATFORM,
    label: 'IPv4 access list',
    group: 'Security',
    description: 'A numbered ipv4 access-list, applied ingress or egress to an interface. IOS-XR ends every list with an implicit deny.',
    inputs: [
      { id: 'name', label: 'ACL name', control: 'text', default: 'EDGE-IN' },
      { id: 'rules', label: 'Rules', control: 'textarea', default: 'permit tcp any host 192.0.2.10 eq 443\npermit icmp any any\ndeny ipv4 any any log', hint: 'One per line, without sequence numbers' },
      { id: 'interface', label: 'Apply to interface', control: 'text', default: 'GigabitEthernet0/0/0/0', hint: 'Empty to define it only' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'ingress', options: [{ value: 'ingress', label: 'Ingress' }, { value: 'egress', label: 'Egress' }] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = xrName(str(values, 'name', ''), 'ACL');
      const rules = lines(String(values['rules'] ?? '')).map((r) => r.replace(/^\d+\s+/, ''));
      const intfValue = str(values, 'interface', '');
      const intf = intfValue ? xrInterface(intfValue, intfValue) : '';
      const direction = str(values, 'direction', 'ingress');
      const findings: Finding[] = [];
      if (rules.length === 0) findings.push(warning('network.iosxr.empty-acl', 'The access list has no rules, so applied to an interface it drops everything (the implicit deny).', SRC));
      if (intf && !rules.some((r) => /^permit/.test(r))) findings.push(warning('network.iosxr.acl-no-permit', 'Nothing is permitted: applied, this list blocks every packet, including routing protocols and your own session.', SRC));
      return {
        platform: PLATFORM,
        title: `Access list ${name}${intf ? ` on ${intf} ${direction}` : ''}`,
        impact: intf ? 'brief' : 'none',
        notes: [
          'Routing protocols, BFD and management traffic to the router itself are filtered by an ingress list too: permit them explicitly.',
          ...(intf ? [COMMIT_CONFIRMED] : []),
        ],
        before: [`show running-config ipv4 access-list ${name}`, ...(intf ? [`show running-config interface ${intf}`] : [])],
        config: [`ipv4 access-list ${name}`, ...rules.map((r, i) => ` ${(i + 1) * 10} ${r}`), '!', ...(intf ? [`interface ${intf}`, ` ipv4 access-group ${name} ${direction}`, '!'] : [])],
        verify: [`show access-lists ipv4 ${name} hardware ${direction} location 0/0/CPU0`, `show access-lists ipv4 ${name}`, ...(intf ? [`show running-config interface ${intf}`] : [])],
        backout: [...(intf ? [`interface ${intf}`, ` no ipv4 access-group ${name} ${direction}`, '!'] : []), `no ipv4 access-list ${name}`, 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_qos',
    platform: PLATFORM,
    label: 'QoS: priority class on egress',
    group: 'Security',
    description: 'A class-map matching DSCP, a policy-map giving it a policed priority queue and the rest a share, applied outbound on an interface.',
    inputs: [
      { id: 'class', label: 'Class name', control: 'text', default: 'VOICE' },
      { id: 'dscp', label: 'DSCP values', control: 'text', default: 'ef', hint: 'ef, cs5, 46 … comma separated' },
      { id: 'policy', label: 'Policy-map name', control: 'text', default: 'WAN-EDGE-OUT' },
      { id: 'priority_percent', label: 'Priority police (%)', control: 'number', default: 20, min: 1, max: 100 },
      { id: 'interface', label: 'Interface', control: 'text', default: 'GigabitEthernet0/0/0/0' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const cls = xrName(str(values, 'class', ''), 'PRIORITY');
      const dscp = listOf(str(values, 'dscp', 'ef'));
      const policy = xrName(str(values, 'policy', ''), 'EDGE-OUT');
      const pct = num(values, 'priority_percent', 20);
      const intf = xrInterface(str(values, 'interface', ''), 'GigabitEthernet0/0/0/0');
      const findings: Finding[] = [];
      if (pct > 33) findings.push(warning('network.iosxr.priority-large', `${pct}% in the priority queue can starve every other class when it is full. A third is the usual ceiling.`, SRC));
      if (dscp.length === 0) findings.push(error('network.iosxr.no-dscp', 'The class matches nothing.', SRC));
      return {
        platform: PLATFORM,
        title: `QoS ${policy} on ${intf} (${cls} priority ${pct}%)`,
        impact: 'brief',
        notes: ['Applying a service-policy re-programs the interface queues: a short burst of drops is possible. An interface takes one output policy, so this replaces any other.'],
        before: [`show running-config interface ${intf}`, `show policy-map interface ${intf} output`, `show running-config policy-map ${policy}`],
        config: [
          `class-map match-any ${cls}`,
          ` match dscp ${dscp.join(' ')}`,
          ' end-class-map',
          '!',
          `policy-map ${policy}`,
          ` class ${cls}`,
          '  priority level 1',
          `  police rate percent ${pct}`,
          '  !',
          ' !',
          ' class class-default',
          '  bandwidth remaining percent 100',
          ' !',
          ' end-policy-map',
          '!',
          `interface ${intf}`,
          ` service-policy output ${policy}`,
          '!',
        ],
        verify: [`show policy-map interface ${intf} output`, `show qos interface ${intf} output`],
        backout: [`interface ${intf}`, ` no service-policy output ${policy}`, '!', `no policy-map ${policy}`, `no class-map match-any ${cls}`, 'commit'],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_aaa_tacacs',
    platform: PLATFORM,
    label: 'AAA with TACACS+',
    group: 'Security',
    description: 'TACACS+ servers in a server group, used for login, exec and command authorization and accounting, falling back to local users.',
    inputs: [
      { id: 'servers', label: 'TACACS+ servers', control: 'text', default: '192.0.2.70, 192.0.2.71' },
      { id: 'group', label: 'Server group', control: 'text', default: 'TACACS-SERVERS' },
      { id: 'source', label: 'Source interface', control: 'text', default: 'Loopback0' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: '', hint: 'e.g. MGMT; empty for the default VRF' },
      { id: 'command_authorization', label: 'Authorize commands', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'servers', ''));
      const group = xrName(str(values, 'group', ''), 'TACACS');
      const source = xrInterface(str(values, 'source', ''), 'Loopback0');
      const vrf = str(values, 'vrf', '');
      const cmd = bool(values, 'command_authorization', true);
      const findings: Finding[] = [];
      for (const s of servers) if (!isIpv4(s) && !s.includes(':')) findings.push(error('network.iosxr.bad-server', `"${s}" is not an address.`, SRC));
      if (servers.length < 2) findings.push(warning('network.iosxr.single-tacacs', 'One TACACS+ server: when it is unreachable, logins fall back to local users only.', SRC));
      findings.push(info('network.iosxr.aaa-lockout', 'AAA changes are how people lock themselves out. Keep a local user with a known secret, and a second session open, until a new login has been tested.', SRC));
      return {
        platform: PLATFORM,
        title: `AAA via TACACS+ group ${group}`,
        impact: 'brief',
        notes: [
          'The key is `<REQUIRED>`: fill it in from the vault. It must match the TACACS+ server’s key for this device.',
          'Test a new SSH login in a second window before closing the first. The `local` fallback only works if a local user exists (the local-user blueprint).',
          COMMIT_CONFIRMED,
          ROLLBACK_NOTE,
        ],
        before: ['show running-config aaa', 'show running-config tacacs-server', 'show tacacs'],
        config: [
          ...servers.flatMap((s) => [`tacacs-server host ${s} port 49`, ` key 0 ${SECRET}`, '!']),
          `tacacs source-interface ${source}${vrf ? ` vrf ${vrf}` : ''}`,
          `aaa group server tacacs+ ${group}`,
          ...servers.map((s) => ` server ${s}`),
          ...(vrf ? [` vrf ${vrf}`] : []),
          '!',
          `aaa authentication login default group ${group} local`,
          `aaa authorization exec default group ${group} local`,
          ...(cmd ? [`aaa authorization commands default group ${group} none`] : []),
          `aaa accounting exec default start-stop group ${group}`,
          `aaa accounting commands default start-stop group ${group}`,
        ],
        verify: ['show tacacs', 'show running-config aaa', 'show aaa usergroup', 'show users'],
        backout: [
          'no aaa authentication login default',
          'no aaa authorization exec default',
          ...(cmd ? ['no aaa authorization commands default'] : []),
          'no aaa accounting exec default',
          'no aaa accounting commands default',
          `no aaa group server tacacs+ ${group}`,
          ...servers.map((s) => `no tacacs-server host ${s} port 49`),
          'commit',
        ],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_local_user',
    platform: PLATFORM,
    label: 'Local user',
    group: 'Security',
    description: 'A local user in a task group (root-lr, netadmin, operator…), the fallback when TACACS+ is unreachable.',
    inputs: [
      { id: 'username', label: 'Username', control: 'text', default: 'netops-break-glass' },
      {
        id: 'group',
        label: 'Task group',
        control: 'select',
        default: 'root-lr',
        options: [
          { value: 'root-lr', label: 'root-lr (everything on this router)' },
          { value: 'netadmin', label: 'netadmin' },
          { value: 'sysadmin', label: 'sysadmin' },
          { value: 'operator', label: 'operator (read only)' },
        ],
      },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const user = xrName(str(values, 'username', ''), 'netops');
      const group = str(values, 'group', 'root-lr');
      return {
        platform: PLATFORM,
        title: `Local user ${user} (${group})`,
        impact: 'none',
        notes: [
          'The secret is `<REQUIRED>`: type it at commit time, or paste a type-10 (SHA-512) hash with `secret 10 <hash>`. Never keep the clear text in the file.',
          'On a router with no users yet, the first one created at the console gets root-system; this one is root-lr at most.',
        ],
        before: ['show running-config username', 'show users'],
        config: [`username ${user}`, ` group ${group}`, ` secret ${SECRET}`, '!'],
        verify: [`show running-config username ${user}`, 'show aaa userdb'],
        backout: [`no username ${user}`, 'commit'],
      };
    },
  }),
];

const MANAGEMENT: readonly ChangeBlueprint[] = [
  xrBlueprint({
    id: 'iosxr_management_baseline',
    platform: PLATFORM,
    label: 'Management baseline: NTP, logging, SSH',
    group: 'Management',
    description: 'Hostname and domain, NTP servers, remote and buffered logging, and SSH v2 as the only way in.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'PE1' },
      { id: 'domain', label: 'Domain name', control: 'text', default: 'example.net' },
      { id: 'ntp', label: 'NTP servers', control: 'text', default: '192.0.2.123, 192.0.2.124' },
      { id: 'syslog', label: 'Syslog servers', control: 'text', default: '192.0.2.50' },
      { id: 'source', label: 'Source interface', control: 'text', default: 'Loopback0' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: 'default', hint: 'default, or e.g. MGMT for MgmtEth' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const hostname = xrName(str(values, 'hostname', ''), 'router');
      const domain = str(values, 'domain', '');
      const ntp = listOf(str(values, 'ntp', ''));
      const syslog = listOf(str(values, 'syslog', ''));
      const source = xrInterface(str(values, 'source', ''), 'Loopback0');
      const vrf = str(values, 'vrf', 'default');
      const findings: Finding[] = [];
      if (ntp.length < 2) findings.push(warning('network.iosxr.single-ntp', 'Fewer than two NTP servers: one bad clock cannot be outvoted.', SRC));
      for (const s of [...ntp, ...syslog]) if (!isIpv4(s) && !s.includes(':')) findings.push(error('network.iosxr.bad-server', `"${s}" is not an address.`, SRC));
      return {
        platform: PLATFORM,
        title: `Management baseline for ${hostname}`,
        impact: 'none',
        notes: [
          'SSH needs a host key: run `crypto key generate rsa` (exec mode, not configuration) once, before relying on SSH.',
          'Telnet is off unless configured; this change does not enable it.',
        ],
        before: ['show running-config hostname', 'show running-config ntp', 'show running-config logging', 'show running-config ssh', 'show ntp associations'],
        config: [
          `hostname ${hostname}`,
          ...(domain ? [`domain name ${domain}`] : []),
          'clock timezone UTC UTC',
          'ntp',
          ...ntp.map((s) => ` server${vrf !== 'default' ? ` vrf ${vrf}` : ''} ${s}`),
          ` source${vrf !== 'default' ? ` vrf ${vrf}` : ''} ${source}`,
          '!',
          ...syslog.map((s) => `logging ${s} vrf ${vrf} severity info`),
          'logging buffered 10000000',
          'logging buffered informational',
          `logging source-interface ${source}${vrf !== 'default' ? ` vrf ${vrf}` : ''}`,
          'service timestamps log datetime localtime msec show-timezone',
          'ssh server v2',
          `ssh server vrf ${vrf}`,
          'ssh timeout 60',
          'ssh server rate-limit 60',
        ],
        verify: ['show ntp associations', 'show ntp status', 'show logging | include Syslog', 'show ssh server', 'show running-config hostname'],
        backout: [
          ...ntp.map((s) => `no ntp server${vrf !== 'default' ? ` vrf ${vrf}` : ''} ${s}`),
          ...syslog.map((s) => `no logging ${s} vrf ${vrf}`),
          `no ssh server vrf ${vrf}`,
          '! the hostname and domain: put back the previous values from the capture',
          'commit',
        ],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_snmp',
    platform: PLATFORM,
    label: 'SNMP',
    group: 'Management',
    description: 'SNMP v3 (authPriv) or v2c read-only access for the NMS, restricted by an ACL, with traps sent to it.',
    inputs: [
      { id: 'version', label: 'Version', control: 'select', default: 'v3', options: [{ value: 'v3', label: 'v3 authPriv' }, { value: 'v2c', label: 'v2c community' }] },
      { id: 'nms', label: 'NMS addresses', control: 'text', default: '192.0.2.60' },
      { id: 'user', label: 'v3 user', control: 'text', default: 'nms-poller', showWhen: { input: 'version', equals: ['v3'] } },
      { id: 'location', label: 'Location', control: 'text', default: 'DC1 row 4' },
      { id: 'contact', label: 'Contact', control: 'text', default: 'noc@example.net' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const v3 = str(values, 'version', 'v3') === 'v3';
      const nms = listOf(str(values, 'nms', ''));
      const user = xrName(str(values, 'user', ''), 'nms');
      const findings: Finding[] = [];
      if (!v3) findings.push(warning('network.iosxr.snmp-v2c', 'SNMP v2c sends the community in clear text. Use v3 with authPriv where the NMS supports it.', SRC));
      if (nms.length === 0) findings.push(warning('network.iosxr.snmp-no-nms', 'No NMS address: the ACL permits nobody and no traps are sent.', SRC));
      return {
        platform: PLATFORM,
        title: `SNMP ${v3 ? 'v3' : 'v2c'} for ${nms.join(', ') || 'the NMS'}`,
        impact: 'none',
        notes: [v3 ? 'The auth and priv keys are `<REQUIRED>`: enter them from the vault. IOS-XR stores the user localized, so it never appears in the running configuration.' : 'The community is `<REQUIRED>`: fill it in from the vault.'],
        before: ['show running-config snmp-server', 'show snmp'],
        config: [
          'ipv4 access-list SNMP-NMS',
          ...nms.map((a, i) => ` ${(i + 1) * 10} permit ipv4 host ${a} any`),
          '!',
          ...(v3
            ? ['snmp-server group NMS-RO v3 priv', `snmp-server user ${user} NMS-RO v3 auth sha ${SECRET} priv aes 128 ${SECRET} IPv4 SNMP-NMS`]
            : [`snmp-server community ${SECRET} RO IPv4 SNMP-NMS`]),
          ...nms.map((a) => (v3 ? `snmp-server host ${a} traps version 3 priv ${user}` : `snmp-server host ${a} traps version 2c ${SECRET}`)),
          `snmp-server location ${description(str(values, 'location', ''), 'unknown')}`,
          `snmp-server contact ${description(str(values, 'contact', ''), 'noc')}`,
          'snmp-server traps snmp linkup',
          'snmp-server traps snmp linkdown',
          'snmp-server traps bgp',
        ],
        verify: ['show snmp', 'show snmp host', ...(v3 ? ['show snmp user'] : []), 'show access-lists ipv4 SNMP-NMS'],
        backout: [
          ...nms.map((a) => `no snmp-server host ${a} traps`),
          ...(v3 ? [`no snmp-server user ${user} NMS-RO v3`, 'no snmp-server group NMS-RO v3 priv'] : [`no snmp-server community ${SECRET}`]),
          'no ipv4 access-list SNMP-NMS',
          'commit',
        ],
        findings,
      };
    },
  }),

  xrBlueprint({
    id: 'iosxr_lldp',
    platform: PLATFORM,
    label: 'LLDP',
    group: 'Management',
    description: 'LLDP on globally, with timers, and turned off on the interfaces that face outside the network.',
    inputs: [
      { id: 'timer', label: 'Advertisement interval (s)', control: 'number', default: 30, min: 5, max: 65534 },
      { id: 'holdtime', label: 'Hold time (s)', control: 'number', default: 120, min: 0, max: 65535 },
      { id: 'disable_on', label: 'Disable on', control: 'text', default: 'GigabitEthernet0/0/0/9', hint: 'Customer- and internet-facing ports' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const off = listOf(str(values, 'disable_on', '')).map((i) => xrInterface(i, i));
      return {
        platform: PLATFORM,
        title: `LLDP on, off on ${off.length} interface(s)`,
        impact: 'none',
        notes: ['LLDP tells a neighbor the hostname, platform and software release: keep it off ports facing customers or the internet.'],
        before: ['show running-config lldp', 'show lldp'],
        config: ['lldp', ` timer ${num(values, 'timer', 30)}`, ` holdtime ${num(values, 'holdtime', 120)}`, '!', ...off.flatMap((i) => [`interface ${i}`, ' lldp', '  receive disable', '  transmit disable', ' !', '!'])],
        verify: ['show lldp', 'show lldp neighbors', ...off.map((i) => `show lldp interface ${i}`)],
        backout: ['no lldp', ...off.flatMap((i) => [`interface ${i}`, ' no lldp', '!']), 'commit'],
      };
    },
  }),
];

/** HSRP and VRRP on IOS-XR live under `router hsrp` / `router vrrp`, not the interface. */
function fhrp(kind: 'hsrp' | 'vrrp'): ChangeBlueprint {
  const upper = kind.toUpperCase();
  return xrBlueprint({
    id: `iosxr_${kind}`,
    platform: PLATFORM,
    label: `${upper} gateway`,
    group: 'Redundancy',
    description: `A ${upper} group on an interface under \`router ${kind}\`, with the virtual address, a priority and preemption.`,
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'GigabitEthernet0/0/0/1.100' },
      { id: 'group', label: 'Group', control: 'number', default: 10, min: 0, max: kind === 'hsrp' ? 4095 : 255 },
      { id: 'virtual', label: 'Virtual address', control: 'text', default: '10.1.100.254' },
      { id: 'priority', label: 'Priority', control: 'number', default: 110, min: 1, max: kind === 'hsrp' ? 255 : 254, hint: 'Higher wins; the peer keeps the default 100' },
      { id: 'preempt', label: 'Preempt', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const intf = xrInterface(str(values, 'interface', ''), 'GigabitEthernet0/0/0/1.100');
      const group = num(values, 'group', 10);
      const virtual = str(values, 'virtual', '');
      const priority = num(values, 'priority', 110);
      const preempt = bool(values, 'preempt', true);
      const findings: Finding[] = [];
      if (!isIpv4(virtual)) findings.push(error(`network.iosxr.${kind}-address`, `The virtual address "${virtual}" is not an IPv4 address. This blueprint writes the IPv4 address family.`, SRC));
      const groupLines =
        kind === 'hsrp'
          ? [`   hsrp ${group}${group > 255 ? ' version 2' : ''}`, `    priority ${priority}`, ...(preempt ? ['    preempt'] : []), `    address ${virtual}`, '   !']
          : [`   vrrp ${group}`, `    priority ${priority}`, ...(preempt ? [] : ['    preempt disable']), `    address ${virtual}`, '   !'];
      return {
        platform: PLATFORM,
        title: `${upper} group ${group} on ${intf} (${virtual})`,
        impact: 'brief',
        notes: [
          `The interface needs an address in the same subnet as ${virtual}, and the peer router the same group with a different priority.`,
          ...(kind === 'vrrp' ? ['VRRP preempts by default on IOS-XR; `preempt disable` turns it off.'] : ['HSRP groups above 255 need version 2 on both routers.']),
        ],
        before: [`show running-config router ${kind}`, `show ${kind} brief`, `show running-config interface ${intf}`],
        config: [`router ${kind}`, ` interface ${intf}`, '  address-family ipv4', ...groupLines, '  !', ' !', '!'],
        verify: [`show ${kind} brief`, `show ${kind} interface ${intf} detail`],
        backout: [`router ${kind}`, ` interface ${intf}`, '  address-family ipv4', `   no ${kind} ${group}`, '!', 'commit'],
        findings,
      };
    },
  });
}

export const IOSXR_SERVICES: readonly ChangeBlueprint[] = [...MPLS, ...SECURITY, ...MANAGEMENT, fhrp('hsrp'), fhrp('vrrp')];

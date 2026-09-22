/**
 * Cisco NX-OS: the parts a data centre switch carries that the first two files
 * did not cover.
 *
 * Fabric extenders, control plane policing, precision time, first-hop
 * redundancy, multicast, IPv6, BFD, DHCP relay, SNMPv3, interface breakout and
 * route leaking between VRFs — plus the feature baseline, because on NX-OS
 * nothing works until its feature is enabled and half of the troubleshooting
 * anyone does on a new box is discovering which one is missing.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { listOf, netmask, parseCidr, vlanIds, vlanRange, type DeviceChange } from '../device.ts';

const PLATFORM = 'cisco_nxos' as const;
const SECRET = '<REQUIRED>';

export const NXOS_EXTRA_2: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'nxos_feature_baseline',
    platform: PLATFORM,
    label: 'Feature baseline',
    group: 'Platform',
    description: 'Turn on the features this switch’s role actually needs, and say which ones were deliberately left off — the first thing to get right on a new Nexus and the first thing to check on an old one.',
    inputs: [
      { id: 'role', label: 'Role', control: 'select', default: 'vxlan-leaf', options: [
        { value: 'vxlan-leaf', label: 'VXLAN EVPN leaf' },
        { value: 'vxlan-spine', label: 'VXLAN EVPN spine' },
        { value: 'vpc-access', label: 'vPC access pair' },
        { value: 'l3-core', label: 'Layer 3 core' },
      ] },
      { id: 'automation', label: 'Automation and telemetry', control: 'select', default: 'netconf', options: [
        { value: 'netconf', label: 'NETCONF and RESTCONF' },
        { value: 'telemetry', label: 'NETCONF, RESTCONF and streaming telemetry' },
        { value: 'none', label: 'None — CLI and SNMP only' },
      ] },
      { id: 'scp_server', label: 'SCP server for file transfer', control: 'toggle', default: true },
      { id: 'bash', label: 'Bash shell', control: 'toggle', default: false, hint: 'Off unless something genuinely needs it' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const role = str(values, 'role', 'vxlan-leaf');
      const automation = str(values, 'automation', 'netconf');
      const findings: Finding[] = [];
      if (bool(values, 'bash', false)) {
        findings.push(warning('network.nxos.bash', 'The bash shell is a full shell on the switch, outside the command authorisation the AAA configuration applies to exec commands. Anyone who can reach it can do things TACACS+ will never see.', { remediation: 'Leave it off, or restrict it to a role and account for it in the audit.', source: 'ArchToolKit' }));
      }

      const base = ['feature lacp', 'feature lldp', 'feature interface-vlan'];
      const byRole =
        role === 'vxlan-leaf'
          ? ['feature vpc', 'feature bgp', 'feature ospf', 'feature nv overlay', 'feature vn-segment-vlan-based', 'feature fabric forwarding', 'feature hsrp', 'nv overlay evpn']
          : role === 'vxlan-spine'
            ? ['feature bgp', 'feature ospf', 'feature nv overlay', 'nv overlay evpn']
            : role === 'vpc-access'
              ? ['feature vpc', 'feature hsrp', 'feature dhcp']
              : ['feature ospf', 'feature bgp', 'feature hsrp', 'feature bfd'];

      return {
        platform: PLATFORM,
        title: `Feature baseline for a ${role.replace(/-/g, ' ')}`,
        impact: 'brief',
        notes: [
          'Enabling a feature allocates resources and, on some platforms, changes the TCAM carving that needs a reload to take effect. Do this before the switch is in service, not after.',
          'Disabling a feature removes every line of configuration that depends on it, without asking. `no feature bgp` takes the whole BGP configuration with it and there is no undo.',
          'Everything here is additive. Nothing in the back-out disables a feature, because doing so on a live switch is how an entire routing configuration disappears.',
        ],
        before: ['show feature | include enabled', 'show running-config | include ^feature', 'show module', 'show version'],
        config: [
          ...base,
          ...byRole,
          ...(bool(values, 'scp_server', true) ? ['feature scp-server'] : []),
          ...(automation !== 'none' ? ['feature netconf', 'feature restconf'] : []),
          ...(automation === 'telemetry' ? ['feature telemetry'] : []),
          ...(bool(values, 'bash', false) ? ['feature bash-shell'] : []),
        ],
        verify: ['show feature | include enabled', 'show running-config | include ^feature', 'show hardware access-list resource utilization', 'show system resources'],
        backout: [`${'!'} Deliberately empty. Disabling a feature deletes every line that depends on it.`, `${'!'} To undo, disable only the feature that was added, and only when its configuration has been removed first.`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_fhrp',
    platform: PLATFORM,
    label: 'HSRP or anycast gateway',
    group: 'Routing',
    description: 'The default gateway for a VLAN: HSRP across a vPC pair, or the distributed anycast gateway a VXLAN fabric uses instead.',
    inputs: [
      { id: 'style', label: 'Gateway style', control: 'select', default: 'anycast', options: [
        { value: 'anycast', label: 'Anycast gateway — every leaf answers, no election' },
        { value: 'hsrp', label: 'HSRP — one active, one standby' },
      ] },
      { id: 'vlan_id', label: 'VLAN', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'gateway', label: 'Gateway address', control: 'text', default: '10.0.10.1/24' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the global table' },
      { id: 'group', label: 'HSRP group', control: 'number', default: 10, min: 0, max: 4095, showWhen: { input: 'style', equals: ['hsrp'] } },
      { id: 'priority', label: 'HSRP priority', control: 'number', default: 110, min: 1, max: 255, showWhen: { input: 'style', equals: ['hsrp'] } },
      { id: 'real_address', label: 'This switch’s address', control: 'text', default: '10.0.10.2/24', showWhen: { input: 'style', equals: ['hsrp'] } },
      { id: 'anycast_mac', label: 'Anycast gateway MAC', control: 'text', default: '0000.2222.3333', showWhen: { input: 'style', equals: ['anycast'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const anycast = str(values, 'style', 'anycast') === 'anycast';
      const vlan = num(values, 'vlan_id', 10);
      const gateway = str(values, 'gateway', '');
      const vrf = str(values, 'vrf', '');
      const findings: Finding[] = [];
      if (!parseCidr(gateway)) findings.push(error('network.nxos.bad-address', 'The gateway address is not a valid address and prefix.', { source: 'ArchToolKit' }));
      if (anycast) {
        findings.push(
          warning('network.nxos.anycast-mac', 'The anycast gateway MAC must be identical on every leaf in the fabric. A leaf with a different one gives hosts an ARP entry that stops working the moment they move.', {
            remediation: 'Set it once, in the fabric standard, and use the same value everywhere.',
            source: 'ArchToolKit',
          }),
        );
      } else {
        findings.push(
          warning('network.nxos.hsrp-vpc', 'Across a vPC pair both peers forward for the HSRP address regardless of which is active, so the priority only decides who answers ARP. Do not expect the standby to be idle.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: anycast ? `Anycast gateway on VLAN ${vlan}` : `HSRP group ${num(values, 'group', 10)} on VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          'Hosts keep the old gateway MAC in their ARP cache until it ages. Changing the style of gateway under a live VLAN means a period where some hosts are talking to a MAC that no longer answers.',
          ...(anycast ? ['`fabric forwarding mode anycast-gateway` on the SVI is what makes every leaf answer. Without it the SVI is an ordinary interface and only this leaf routes for the subnet.'] : []),
        ],
        before: [`show run interface Vlan${vlan}`, 'show hsrp brief', 'show fabric forwarding ip local-host-db', `show ip arp vlan ${vlan}`],
        config: [
          ...(anycast
            ? [
                `fabric forwarding anycast-gateway-mac ${str(values, 'anycast_mac', '0000.2222.3333')}`,
                '!',
                `interface Vlan${vlan}`,
                '  no shutdown',
                ...(vrf ? [`  vrf member ${vrf}`] : []),
                `  ip address ${gateway}`,
                '  fabric forwarding mode anycast-gateway',
                '!',
              ]
            : [
                `interface Vlan${vlan}`,
                '  no shutdown',
                ...(vrf ? [`  vrf member ${vrf}`] : []),
                `  ip address ${str(values, 'real_address', '')}`,
                `  hsrp ${num(values, 'group', 10)}`,
                `    ip ${parseCidr(gateway)?.address ?? gateway}`,
                `    priority ${num(values, 'priority', 110)}`,
                '    preempt delay minimum 180',
                '    timers 1 3',
                '!',
              ]),
        ],
        verify: [
          `show run interface Vlan${vlan}`,
          ...(anycast ? ['show fabric forwarding ip local-host-db', 'show nve peers'] : ['show hsrp brief', `show hsrp group ${num(values, 'group', 10)}`]),
          `ping ${parseCidr(gateway)?.address ?? gateway} source ${parseCidr(gateway)?.address ?? ''}`,
          `${'!'} From a host in the VLAN: ping the gateway, then something beyond it`,
        ],
        backout: [`interface Vlan${vlan}`, ...(anycast ? ['  no fabric forwarding mode anycast-gateway'] : [`  no hsrp ${num(values, 'group', 10)}`]), '  shutdown', '!'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_fex',
    platform: PLATFORM,
    label: 'Fabric extender',
    group: 'Platform',
    description: 'Associate a FEX with the port-channel that carries it, so its host ports appear on this switch as if they were local.',
    inputs: [
      { id: 'fex_id', label: 'FEX id', control: 'number', default: 101, min: 100, max: 199 },
      { id: 'fex_description', label: 'Description', control: 'text', default: 'Rack 12 top of rack' },
      { id: 'uplinks', label: 'Uplink interfaces', control: 'text', default: 'Ethernet1/31, Ethernet1/32' },
      { id: 'channel', label: 'Port-channel', control: 'number', default: 101, min: 1, max: 4096 },
      { id: 'pinning', label: 'Pinning max-links', control: 'number', default: 1, min: 1, max: 4, hint: '1 with a port-channel, which is the normal answer' },
      { id: 'dual_homed', label: 'Dual-homed to a vPC pair', control: 'toggle', default: true },
      { id: 'vpc_id', label: 'vPC id', control: 'number', default: 101, min: 1, max: 4096, showWhen: { input: 'dual_homed', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const fex = num(values, 'fex_id', 101);
      const uplinks = listOf(str(values, 'uplinks', ''));
      const channel = num(values, 'channel', 101);
      const dual = bool(values, 'dual_homed', true);
      const findings: Finding[] = [];
      if (uplinks.length === 0) findings.push(error('network.nxos.no-uplinks', 'A FEX with no uplink cannot come online.', { source: 'ArchToolKit' }));
      if (uplinks.length === 1) {
        findings.push(warning('network.nxos.fex-single-uplink', 'One uplink means every host on this FEX is behind a single fibre.', { source: 'ArchToolKit' }));
      }
      if (num(values, 'pinning', 1) > 1) {
        findings.push(warning('network.nxos.fex-pinning', 'With max-links above 1 each host port is pinned to one uplink, and losing that uplink takes those ports down rather than redistributing them. A port-channel with max-links 1 is almost always the better answer.', { source: 'ArchToolKit' }));
      }
      if (dual) {
        findings.push(warning('network.nxos.fex-aa', 'A dual-homed FEX must be configured identically on both vPC peers, including the FEX id. A mismatch leaves it stuck in "Discovered" and the host ports never appear.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `FEX ${fex} on port-channel ${channel}`,
        impact: 'outage',
        notes: [
          'The FEX downloads its image from this switch on first association and reloads. That takes several minutes, during which nothing plugged into it works.',
          'Host ports appear as Ethernet' + fex + '/1/x once the FEX is online. Configuring them before it is online is accepted and applied later.',
          ...(dual ? ['Both peers must agree about the FEX id, the vPC id and the port-channel members. Apply this change to both before expecting it to come up.'] : []),
        ],
        before: ['show fex', 'show fex detail', `show run interface port-channel ${channel}`, 'show port-channel summary'],
        config: [
          'feature-set fex',
          'install feature-set fex',
          '!',
          `fex ${fex}`,
          `  description ${str(values, 'fex_description', 'Fabric extender')}`,
          `  pinning max-links ${num(values, 'pinning', 1)}`,
          '  type N2348TQ',
          '!',
          ...uplinks.flatMap((iface) => [
            `interface ${iface}`,
            '  switchport',
            '  switchport mode fex-fabric',
            `  fex associate ${fex}`,
            `  channel-group ${channel}`,
            '  no shutdown',
            '!',
          ]),
          `interface port-channel ${channel}`,
          '  switchport mode fex-fabric',
          `  fex associate ${fex}`,
          ...(dual ? [`  vpc ${num(values, 'vpc_id', fex)}`] : []),
          '  no shutdown',
          '!',
        ],
        verify: ['show fex', `show fex ${fex} detail`, 'show port-channel summary', `show interface ethernet${fex}/1/1`, 'show vpc brief'],
        backout: [`interface port-channel ${channel}`, '  shutdown', '!', ...uplinks.flatMap((i) => [`interface ${i}`, `  no fex associate ${fex}`, '  shutdown', '!']), `no fex ${fex}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_copp',
    platform: PLATFORM,
    label: 'Control plane policing profile',
    group: 'Hardening',
    description: 'Choose the CoPP profile the switch runs, or copy it and adjust one class — which is the only safe way to change CoPP on NX-OS.',
    inputs: [
      { id: 'approach', label: 'Approach', control: 'select', default: 'copy', options: [
        { value: 'copy', label: 'Copy the strict profile and adjust one class' },
        { value: 'profile', label: 'Apply a built-in profile as it is' },
      ] },
      { id: 'profile', label: 'Built-in profile', control: 'select', default: 'strict', options: [
        { value: 'strict', label: 'Strict — the default, and the right answer for most' },
        { value: 'moderate', label: 'Moderate' },
        { value: 'lenient', label: 'Lenient' },
        { value: 'dense', label: 'Dense — for a switch with many FEX host ports' },
      ] },
      { id: 'adjust_class', label: 'Class to adjust', control: 'select', default: 'copp-system-p-class-normal', options: [
        { value: 'copp-system-p-class-normal', label: 'Normal — ARP and general control traffic' },
        { value: 'copp-system-p-class-critical', label: 'Critical — routing protocols' },
        { value: 'copp-system-p-class-management', label: 'Management — SSH, SNMP, NTP' },
        { value: 'copp-system-p-class-monitoring', label: 'Monitoring — ICMP and traceroute' },
      ], showWhen: { input: 'approach', equals: ['copy'] } },
      { id: 'new_rate', label: 'New rate (packets per second)', control: 'number', default: 2000, min: 50, max: 500000, showWhen: { input: 'approach', equals: ['copy'] } },
      { id: 'burst', label: 'Burst (packets)', control: 'number', default: 500, min: 50, max: 100000, showWhen: { input: 'approach', equals: ['copy'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const copy = str(values, 'approach', 'copy') === 'copy';
      const profile = str(values, 'profile', 'strict');
      const klass = str(values, 'adjust_class', 'copp-system-p-class-normal');
      const findings: Finding[] = [];
      findings.push(
        warning('network.nxos.copp-reload', 'Changing the CoPP profile with `copp profile` takes effect at the next reload on many platforms, and silently does nothing before then. Check the release notes for the switch in front of you rather than assuming it applied.', {
          source: 'ArchToolKit',
        }),
      );
      if (!copy && profile === 'lenient') {
        findings.push(warning('network.nxos.copp-lenient', 'The lenient profile raises the rates enough that a broadcast storm or an ARP scan can reach the CPU in volume. It is for a lab or a switch with an unusual protocol mix, not a default.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: copy ? `CoPP: raise ${klass} to ${num(values, 'new_rate', 2000)}pps` : `CoPP profile ${profile}`,
        impact: 'brief',
        notes: [
          'Read the drop counters before changing anything: `show policy-map interface control-plane` names the class that is actually dropping. Changing a class that was not dropping achieves nothing and removes a protection.',
          'CoPP protects the CPU from traffic destined to it. If management is slow but the drop counters are zero, CoPP is not the problem.',
          ...(copy ? ['Copying the profile makes a policy you own, which is the only way to change one class without inheriting the next release’s idea of the others.'] : []),
        ],
        before: ['show copp status', 'show policy-map interface control-plane', 'show policy-map interface control-plane | include dropped', 'show running-config copp all | head lines 40'],
        config: copy
          ? [
              `copp copy profile ${profile} prefix CUSTOM`,
              '!',
              `policy-map type control-plane CUSTOM-copp-policy-${profile}`,
              `  class ${klass.replace('copp-system-p', 'CUSTOM-copp')}`,
              `    police pps ${num(values, 'new_rate', 2000)} burst ${num(values, 'burst', 500)} packets conform transmit violate drop`,
              '!',
              'control-plane',
              `  service-policy input CUSTOM-copp-policy-${profile}`,
              '!',
            ]
          : [`copp profile ${profile}`, '!'],
        verify: [
          'show copp status',
          'show policy-map interface control-plane',
          `${'!'} Watch the drop counters over the next hour, not the next minute`,
          'show system internal access-list input statistics | include copp',
          'show processes cpu history',
        ],
        backout: copy ? ['control-plane', '  no service-policy input CUSTOM-copp-policy-' + profile, '!', `copp profile ${profile}`] : ['copp profile strict'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_ptp',
    platform: PLATFORM,
    label: 'Precision time (PTP)',
    group: 'Services',
    description: 'Distribute time accurately enough for trading, media or industrial equipment, where NTP’s millisecond is not good enough.',
    inputs: [
      { id: 'domain', label: 'PTP domain', control: 'number', default: 0, min: 0, max: 255 },
      { id: 'priority1', label: 'Priority 1', control: 'number', default: 128, min: 0, max: 255, hint: 'Lower wins the best-master election' },
      { id: 'priority2', label: 'Priority 2', control: 'number', default: 128, min: 0, max: 255 },
      { id: 'source_address', label: 'PTP source address', control: 'text', default: '10.255.0.11' },
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1/1-4' },
      { id: 'role', label: 'This switch is', control: 'select', default: 'boundary', options: [
        { value: 'boundary', label: 'A boundary clock — syncs up, serves down' },
        { value: 'transparent', label: 'A transparent clock — corrects and forwards' },
      ] },
      { id: 'announce_interval', label: 'Announce interval', control: 'number', default: 1, min: -3, max: 4, hint: 'Log 2 seconds: 1 means every 2s' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const domain = num(values, 'domain', 0);
      const ifaces = listOf(str(values, 'interfaces', ''));
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.nxos.no-interfaces', 'PTP was asked for with no interface to run it on.', { source: 'ArchToolKit' }));
      findings.push(
        warning('network.nxos.ptp-every-hop', 'PTP accuracy depends on every device in the path handling it. One ordinary switch in the middle that forwards PTP as normal multicast adds its own queuing delay to the measurement, and the error is invisible from either end.', {
          remediation: 'Confirm every hop between the grandmaster and the clients is a boundary or transparent clock.',
          source: 'ArchToolKit',
        }),
      );
      if (domain === 0) {
        findings.push(warning('network.nxos.ptp-domain-zero', 'Domain 0 is the default, which means any device that arrives with default settings joins this domain and takes part in the election.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `PTP ${str(values, 'role', 'boundary')} clock in domain ${domain}`,
        impact: 'brief',
        notes: [
          'The best-master election decides which clock the network follows. A device with a lower priority 1 than the grandmaster will take over, and nothing will report that as an error.',
          'Time can step when PTP takes over from NTP. Anything that dislikes a clock jumping — a database, a log correlation — should be considered before this is enabled on a switch it depends on.',
        ],
        before: ['show ptp brief', 'show ptp parent', 'show ptp clock', 'show ntp peer-status'],
        config: [
          'feature ptp',
          `ptp source ${str(values, 'source_address', '')}`,
          `ptp domain ${domain}`,
          `ptp priority1 ${num(values, 'priority1', 128)}`,
          `ptp priority2 ${num(values, 'priority2', 128)}`,
          '!',
          ...ifaces.flatMap((iface) => [
            `interface ${iface.includes('-') ? iface : iface}`,
            '  ptp',
            `  ptp announce interval ${num(values, 'announce_interval', 1)}`,
            '  ptp sync interval -3',
            '  ptp delay-request minimum interval -2',
            '!',
          ]),
        ],
        verify: ['show ptp brief', 'show ptp clock', 'show ptp parent', 'show ptp port interface ethernet1/1', 'show ptp corrections'],
        backout: [...ifaces.flatMap((i) => [`interface ${i}`, '  no ptp', '!']), `no ptp domain ${domain}`, 'no feature ptp'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_pim',
    platform: PLATFORM,
    label: 'Multicast (PIM)',
    group: 'Multicast',
    description: 'PIM sparse mode on the interfaces that carry multicast, with a rendezvous point and optional anycast RP across the pair.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Vlan10, Ethernet1/1', hint: 'Including the path to the RP' },
      { id: 'rp_address', label: 'RP address', control: 'text', default: '10.255.0.1' },
      { id: 'rp_style', label: 'RP style', control: 'select', default: 'static', options: [
        { value: 'static', label: 'Static RP' },
        { value: 'anycast', label: 'Anycast RP across the vPC pair' },
      ] },
      { id: 'anycast_peer', label: 'Anycast RP peer', control: 'text', default: '10.255.0.12', showWhen: { input: 'rp_style', equals: ['anycast'] } },
      { id: 'local_address', label: 'This switch’s RP-set address', control: 'text', default: '10.255.0.11', showWhen: { input: 'rp_style', equals: ['anycast'] } },
      { id: 'groups', label: 'Group range', control: 'text', default: '239.0.0.0/8' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the default VRF' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const rp = str(values, 'rp_address', '');
      const anycast = str(values, 'rp_style', 'static') === 'anycast';
      const groups = str(values, 'groups', '239.0.0.0/8');
      const vrf = str(values, 'vrf', '');
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.nxos.no-interfaces', 'No interface was named, so multicast would be routed nowhere.', { source: 'ArchToolKit' }));
      if (!parseCidr(groups)) findings.push(error('network.nxos.bad-groups', 'The group range is not a valid prefix.', { remediation: 'Write it as 239.0.0.0/8.', source: 'ArchToolKit' }));
      if (anycast) {
        findings.push(warning('network.nxos.anycast-rp-set', 'Every member of the anycast RP set has to list every other member, including itself. A missing entry gives an RP that works for some sources and not others, which looks like an intermittent fault.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `PIM sparse mode with ${anycast ? 'an anycast RP' : 'a static RP'}`,
        impact: 'brief',
        notes: [
          'On NX-OS the RP address is configured once globally with a group list, not per interface. Every switch in the domain needs the same answer.',
          'In a VXLAN fabric, tenant multicast is a different question from underlay multicast replication. This is the tenant side unless the VRF is left empty and the interfaces are underlay links.',
        ],
        before: ['show ip pim interface brief', 'show ip pim rp', 'show ip mroute summary', 'show ip igmp groups'],
        config: [
          'feature pim',
          ...(vrf ? [`vrf context ${vrf}`, `  ip pim rp-address ${rp} group-list ${groups}`, ...(anycast ? [`  ip pim anycast-rp ${rp} ${str(values, 'local_address', '')}`, `  ip pim anycast-rp ${rp} ${str(values, 'anycast_peer', '')}`] : []), '!'] : [
            `ip pim rp-address ${rp} group-list ${groups}`,
            ...(anycast ? [`ip pim anycast-rp ${rp} ${str(values, 'local_address', '')}`, `ip pim anycast-rp ${rp} ${str(values, 'anycast_peer', '')}`] : []),
          ]),
          '!',
          ...ifaces.flatMap((iface) => [`interface ${iface}`, '  ip pim sparse-mode', '!']),
        ],
        verify: ['show ip pim interface brief', 'show ip pim neighbor', 'show ip pim rp', ...(anycast ? ['show ip pim rp | include Anycast'] : []), 'show ip mroute', 'show ip igmp snooping groups'],
        backout: [...ifaces.flatMap((i) => [`interface ${i}`, '  no ip pim sparse-mode', '!']), `no ip pim rp-address ${rp} group-list ${groups}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_bfd',
    platform: PLATFORM,
    label: 'BFD',
    group: 'Routing',
    description: 'Sub-second failure detection on the fabric links, attached to OSPF, BGP or both.',
    inputs: [
      { id: 'interfaces', label: 'Interfaces', control: 'text', default: 'Ethernet1/1-4' },
      { id: 'interval', label: 'Transmit interval (ms)', control: 'number', default: 250, min: 50, max: 9000 },
      { id: 'min_rx', label: 'Minimum receive (ms)', control: 'number', default: 250, min: 50, max: 9000 },
      { id: 'multiplier', label: 'Multiplier', control: 'number', default: 3, min: 3, max: 50 },
      { id: 'protocols', label: 'Attach to', control: 'select', default: 'both', options: [
        { value: 'both', label: 'OSPF and BGP' },
        { value: 'ospf', label: 'OSPF only' },
        { value: 'bgp', label: 'BGP only' },
      ] },
      { id: 'ospf_tag', label: 'OSPF process tag', control: 'text', default: 'UNDERLAY', showWhen: { input: 'protocols', equals: ['both', 'ospf'] } },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65001, min: 1, showWhen: { input: 'protocols', equals: ['both', 'bgp'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const interval = num(values, 'interval', 250);
      const multiplier = num(values, 'multiplier', 3);
      const protocols = str(values, 'protocols', 'both');
      const findings: Finding[] = [];
      if (ifaces.length === 0) findings.push(error('network.nxos.no-interfaces', 'No interface was named to run BFD on.', { source: 'ArchToolKit' }));
      if (interval < 150) {
        findings.push(warning('network.nxos.bfd-aggressive', `${interval}ms × ${multiplier} declares a neighbour dead in ${(interval * multiplier) / 1000}s. Confirm the platform runs BFD in hardware before going this low — in software a control-plane spike will flap every adjacency at once.`, { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `BFD on ${ifaces.join(', ') || 'no interface'}`,
        impact: 'brief',
        notes: [
          'Both ends need BFD. Configured on one side only the session never comes up, and the protocol keeps its own timers — no harm done, and no benefit either.',
          'On a vPC pair, BFD on the peer-link is rarely what you want: the peer-keepalive already covers that failure and the two can interact badly.',
        ],
        before: ['show bfd neighbors', 'show ip ospf neighbors', 'show bgp ipv4 unicast summary'],
        config: [
          'feature bfd',
          ...ifaces.flatMap((iface) => [`interface ${iface}`, `  bfd interval ${interval} min_rx ${num(values, 'min_rx', 250)} multiplier ${multiplier}`, '!']),
          ...(protocols === 'both' || protocols === 'ospf' ? [`router ospf ${str(values, 'ospf_tag', 'UNDERLAY')}`, '  bfd', '!', ...ifaces.flatMap((i) => [`interface ${i}`, '  ip ospf bfd', '!'])] : []),
          ...(protocols === 'both' || protocols === 'bgp' ? [`router bgp ${num(values, 'local_as', 65001)}`, `  ${'!'} per neighbour: neighbor <address> / bfd`, '!'] : []),
        ],
        verify: ['show bfd neighbors details', 'show ip ospf neighbors', 'show bgp ipv4 unicast summary', `${'!'} Fail one link and time the reconvergence`],
        backout: [...ifaces.flatMap((i) => [`interface ${i}`, '  no ip ospf bfd', `  no bfd interval ${interval} min_rx ${num(values, 'min_rx', 250)} multiplier ${multiplier}`, '!'])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_dhcp_relay',
    platform: PLATFORM,
    label: 'DHCP relay',
    group: 'Services',
    description: 'Relay DHCP from an SVI to servers elsewhere, including the VXLAN case where the relay source has to be a loopback the server can route back to.',
    inputs: [
      { id: 'interfaces', label: 'SVIs', control: 'text', default: 'Vlan10, Vlan20' },
      { id: 'servers', label: 'DHCP servers', control: 'text', default: '10.0.1.10, 10.0.2.10' },
      { id: 'server_vrf', label: 'Server VRF', control: 'text', default: '', hint: 'Where the servers live, if not the same VRF as the clients' },
      { id: 'relay_source', label: 'Relay source interface', control: 'text', default: 'loopback0', hint: 'Required in a VXLAN fabric with anycast gateways' },
      { id: 'sub_option', label: 'Insert VPN option', control: 'toggle', default: false, hint: 'Option 82 sub-option 151, when clients are in a VRF' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const ifaces = listOf(str(values, 'interfaces', ''));
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'server_vrf', '');
      const source = str(values, 'relay_source', '');
      const findings: Finding[] = [];
      if (servers.length === 0) findings.push(error('network.nxos.no-servers', 'No DHCP server address was given.', { source: 'ArchToolKit' }));
      if (!source) {
        findings.push(
          warning('network.nxos.relay-source', 'With an anycast gateway, every leaf relays from the same address and the server’s reply can come back to the wrong one. A unique loopback as the relay source is what makes VXLAN DHCP work.', {
            remediation: 'Set a per-leaf loopback as the relay source, and make sure the server has a route back to it.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `DHCP relay to ${servers.join(', ')}`,
        impact: 'brief',
        notes: [
          'The server needs a scope selected by the giaddr and a route back to whatever the relay source is. Both are on the server side and neither is visible from the switch.',
          ...(vrf ? [`The servers are in VRF ${vrf} while the clients are not, so the relay crosses VRFs. The return path has to be leaked or routed accordingly.`] : []),
        ],
        before: ['show ip dhcp relay', 'show ip dhcp relay statistics', ...ifaces.map((i) => `show run interface ${i}`)],
        config: [
          'feature dhcp',
          'service dhcp',
          'ip dhcp relay',
          ...(bool(values, 'sub_option', false) ? ['ip dhcp relay information option', 'ip dhcp relay information option vpn'] : []),
          ...(source ? [`ip dhcp relay source-interface ${source}`] : []),
          '!',
          ...ifaces.flatMap((iface) => [
            `interface ${iface}`,
            ...servers.map((server) => `  ip dhcp relay address ${server}${vrf ? ` use-vrf ${vrf}` : ''}`),
            '!',
          ]),
        ],
        verify: ['show ip dhcp relay', 'show ip dhcp relay statistics', 'show ip dhcp relay address', `${'!'} From a client: release and renew, and confirm the address and gateway`],
        backout: ifaces.flatMap((iface) => [`interface ${iface}`, ...servers.map((s) => `  no ip dhcp relay address ${s}${vrf ? ` use-vrf ${vrf}` : ''}`), '!']),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_vrf_leak',
    platform: PLATFORM,
    label: 'Route leaking between VRFs',
    group: 'Routing',
    description: 'Let two tenants reach a shared service without merging them: import and export route targets, filtered to the prefixes that are meant to cross.',
    inputs: [
      { id: 'source_vrf', label: 'From VRF', control: 'text', default: 'TENANT-A' },
      { id: 'shared_vrf', label: 'To VRF', control: 'text', default: 'SHARED-SERVICES' },
      { id: 'source_rt', label: 'From VRF route target', control: 'text', default: '65001:10010' },
      { id: 'shared_rt', label: 'To VRF route target', control: 'text', default: '65001:10099' },
      { id: 'prefixes', label: 'Prefixes allowed to cross', control: 'textarea', default: '10.99.0.0/24', hint: 'One per line — the shared services, not the whole tenant' },
      { id: 'direction', label: 'Direction', control: 'select', default: 'both', options: [
        { value: 'both', label: 'Both — tenant reaches shared, shared replies' },
        { value: 'to-shared', label: 'One way — tenant reaches shared only' },
      ] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const from = str(values, 'source_vrf', 'TENANT-A');
      const to = str(values, 'shared_vrf', 'SHARED-SERVICES');
      const prefixes = str(values, 'prefixes', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const findings: Finding[] = [];
      if (prefixes.length === 0) {
        findings.push(error('network.nxos.leak-no-filter', 'Leaking with no prefix filter imports the whole VRF, which is the same as not having separated them.', { remediation: 'Name the shared service prefixes explicitly.', source: 'ArchToolKit' }));
      }
      for (const prefix of prefixes) if (!parseCidr(prefix)) findings.push(error('network.nxos.bad-prefix', `"${prefix}" is not a prefix.`, { source: 'ArchToolKit' }));
      findings.push(
        warning('network.nxos.leak-two-way', 'Leaking is per direction and per switch. A prefix that leaks one way gives a path out and no path back, which presents as a one-way ping and takes a long time to find. Apply this on every leaf that routes for either VRF.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `Leak ${prefixes.join(', ') || 'nothing'} between ${from} and ${to}`,
        impact: 'brief',
        notes: [
          'Route targets are what actually move prefixes between VRFs in an EVPN fabric. The route-map filters which of the imported prefixes are kept.',
          'Overlapping addresses between the two VRFs cannot be leaked. If both tenants use 10.0.0.0/8 this is not the change you need — that is NAT.',
        ],
        before: [`show vrf ${from} detail`, `show vrf ${to} detail`, `show bgp l2vpn evpn vni-id all | include ${from}`, `show ip route vrf ${from}`],
        config: [
          `ip prefix-list LEAK-${to} seq 5 permit ${prefixes[0] ?? '0.0.0.0/0'}`,
          ...prefixes.slice(1).map((prefix, index) => `ip prefix-list LEAK-${to} seq ${(index + 2) * 5} permit ${prefix}`),
          '!',
          `route-map LEAK-${to}-IN permit 10`,
          `  match ip address prefix-list LEAK-${to}`,
          '!',
          `vrf context ${from}`,
          '  address-family ipv4 unicast',
          `    route-target import ${str(values, 'shared_rt', '')}`,
          `    route-target import ${str(values, 'shared_rt', '')} evpn`,
          `    import map LEAK-${to}-IN`,
          '!',
          ...(str(values, 'direction', 'both') === 'both'
            ? [
                `vrf context ${to}`,
                '  address-family ipv4 unicast',
                `    route-target import ${str(values, 'source_rt', '')}`,
                `    route-target import ${str(values, 'source_rt', '')} evpn`,
                '!',
              ]
            : []),
        ],
        verify: [`show ip route vrf ${from}`, `show ip route vrf ${to}`, `show bgp l2vpn evpn route-type 5`, `${'!'} From a host in ${from}: reach a shared service, and confirm nothing else in ${to} answers`],
        backout: [
          `vrf context ${from}`,
          '  address-family ipv4 unicast',
          `    no route-target import ${str(values, 'shared_rt', '')}`,
          `    no route-target import ${str(values, 'shared_rt', '')} evpn`,
          `    no import map LEAK-${to}-IN`,
          '!',
          `no route-map LEAK-${to}-IN`,
          `no ip prefix-list LEAK-${to}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_breakout',
    platform: PLATFORM,
    label: 'Interface breakout',
    group: 'Platform',
    description: 'Split a 40G or 100G port into four, which needs a reload of the module and renames every interface on it.',
    inputs: [
      { id: 'module', label: 'Module', control: 'number', default: 1, min: 1, max: 18 },
      { id: 'ports', label: 'Ports to break out', control: 'text', default: '49-52', hint: 'A range on that module' },
      { id: 'mode', label: 'Breakout mode', control: 'select', default: '4x25g', options: [
        { value: '4x25g', label: '100G into 4 × 25G' },
        { value: '4x10g', label: '40G into 4 × 10G' },
        { value: '2x50g', label: '100G into 2 × 50G' },
      ] },
      { id: 'optics', label: 'Optics at both ends', control: 'select', default: 'breakout', options: [
        { value: 'breakout', label: 'Breakout optics and fan-out cables are fitted' },
        { value: 'unknown', label: 'Not checked yet' },
        { value: 'standard', label: 'Standard optics — no fan-out' },
      ] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const module = num(values, 'module', 1);
      const ports = str(values, 'ports', '');
      const mode = str(values, 'mode', '4x25g');
      const findings: Finding[] = [];
      const optics = str(values, 'optics', 'breakout');
      if (optics === 'standard') {
        findings.push(
          error('network.nxos.breakout-optics', 'Breakout needs a breakout-capable optic and a fan-out cable at both ends. With standard optics the ports come up after the reload and stay down, and the only way back is another reload.', {
            remediation: 'Fit breakout optics on the switch and at the far end before scheduling this.',
            source: 'ArchToolKit',
          }),
        );
      } else if (optics === 'unknown') {
        findings.push(
          warning('network.nxos.breakout-optics-unchecked', 'The optics have not been checked. This change reloads the module, so finding out afterwards means a second outage.', {
            remediation: 'Read `show interface transceiver details` on this switch and confirm the far end before the window.',
            source: 'ArchToolKit',
          }),
        );
      }
      findings.push(
        warning('network.nxos.breakout-rename', `Every interface on module ${module} is renamed: Ethernet${module}/49 becomes Ethernet${module}/49/1 to /4. Every port-channel, ACL, description and monitoring reference to the old names has to be rewritten.`, {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `Break out module ${module} ports ${ports} into ${mode}`,
        impact: 'outage',
        notes: [
          'This reloads the module. On a fixed switch that is the whole switch. Take it out of service first — drain the vPC, shut the uplinks, or do it before it carries anything.',
          'The configuration on the parent interface is discarded, not migrated. Capture it first: the back-out here restores the port but not what was on it.',
          'Not every port on every platform supports breakout. `show interface transceiver` and the platform’s port map decide, not this change.',
        ],
        before: [`show running-config interface ethernet${module}/1-54`, 'show interface transceiver', 'show interface brief', 'show port-channel summary', 'show module'],
        config: [`interface breakout module ${module} port ${ports} map ${mode}`, '!', `${'!'} The module reloads. Wait for it to come back before configuring the new interfaces.`],
        verify: ['show interface brief', `show interface ethernet${module}/49/1`, 'show interface transceiver details', 'show module', 'show port-channel summary'],
        backout: [`no interface breakout module ${module} port ${ports} map ${mode}`, `${'!'} The module reloads again, and the original configuration must be reapplied from the capture above.`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_snmpv3',
    platform: PLATFORM,
    label: 'SNMPv3',
    group: 'Management',
    description: 'An authenticated, encrypted SNMPv3 user in the management VRF, and the v2c communities gone.',
    inputs: [
      { id: 'user', label: 'User', control: 'text', default: 'monitoring' },
      { id: 'role', label: 'Role', control: 'select', default: 'network-operator', options: [
        { value: 'network-operator', label: 'network-operator — read only' },
        { value: 'network-admin', label: 'network-admin — read write' },
      ] },
      { id: 'auth', label: 'Authentication', control: 'select', default: 'sha', options: [
        { value: 'sha', label: 'SHA' },
        { value: 'md5', label: 'MD5 — only where something old demands it' },
      ] },
      { id: 'privacy', label: 'Encryption', control: 'select', default: 'aes-128', options: [
        { value: 'aes-128', label: 'AES-128' },
        { value: 'none', label: 'None — authenticated only' },
      ] },
      { id: 'host', label: 'Trap receiver', control: 'text', default: '10.0.1.50' },
      { id: 'vrf', label: 'Management VRF', control: 'text', default: 'management' },
      { id: 'remove_v2c', label: 'Remove the v2c strings', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const user = str(values, 'user', 'monitoring');
      const role = str(values, 'role', 'network-operator');
      const auth = str(values, 'auth', 'sha');
      const privacy = str(values, 'privacy', 'aes-128');
      const host = str(values, 'host', '');
      const vrf = str(values, 'vrf', 'management');
      const findings: Finding[] = [];
      if (auth === 'md5') findings.push(warning('network.nxos.snmp-md5', 'MD5 is broken as an authentication algorithm. Use SHA unless something genuinely cannot.', { source: 'ArchToolKit' }));
      if (privacy === 'none') findings.push(warning('network.nxos.snmp-noencrypt', 'authNoPriv sends every reply in clear, including the topology detail an attacker wants first.', { source: 'ArchToolKit' }));
      if (role === 'network-admin') {
        findings.push(warning('network.nxos.snmp-write', 'network-admin over SNMP is a write-capable path into the switch that bypasses command authorisation. Monitoring does not need it.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `SNMPv3 user ${user}`,
        impact: 'none',
        notes: [
          'Both passphrases are `<REQUIRED>` and are typed at apply time. They go in the vault the playbook reads, never in the change record.',
          'NX-OS stores SNMP users as local users with a role. Creating one here creates an account — check it cannot also log in over SSH if that matters.',
        ],
        before: ['show snmp user', 'show snmp host', 'show snmp community', 'show running-config | include snmp-server'],
        config: [
          `snmp-server user ${user} ${role} auth ${auth} ${SECRET}${privacy === 'none' ? '' : ` priv ${privacy} ${SECRET}`}`,
          ...(host ? [`snmp-server host ${host} version 3 ${privacy === 'none' ? 'auth' : 'priv'} ${user}`, `snmp-server host ${host} use-vrf ${vrf}`] : []),
          'snmp-server enable traps link',
          'snmp-server enable traps config',
          'snmp-server enable traps entity',
          'snmp-server enable traps vtp',
          '!',
          ...(bool(values, 'remove_v2c', true) ? [`${'!'} Remove every v2c string the device still has. The capture above lists them.`, `${'!'} no snmp-server community <name> group <group>`] : []),
        ],
        verify: ['show snmp user', 'show snmp host', 'show snmp community', `${'!'} From the manager: snmpwalk -v3 -l authPriv -u ${user} <device> sysName`],
        backout: [`no snmp-server user ${user}`, ...(host ? [`no snmp-server host ${host}`] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'nxos_ipv6_interface',
    platform: PLATFORM,
    label: 'IPv6 on an SVI or routed port',
    group: 'IPv6',
    description: 'Address an interface for IPv6 and decide what it advertises, including the anycast gateway case in a VXLAN fabric.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'Vlan10' },
      { id: 'address', label: 'IPv6 address', control: 'text', default: '2001:db8:0:10::1/64' },
      { id: 'link_local', label: 'Link-local address', control: 'text', default: 'fe80::1' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '' },
      { id: 'anycast', label: 'Anycast gateway', control: 'toggle', default: false, hint: 'Every leaf answers for this address' },
      { id: 'ra', label: 'Router advertisements', control: 'select', default: 'slaac', options: [
        { value: 'slaac', label: 'SLAAC' },
        { value: 'stateful', label: 'Stateful DHCPv6' },
        { value: 'suppress', label: 'Suppressed — routed link' },
      ] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const iface = str(values, 'interface', '');
      const address = str(values, 'address', '');
      const ra = str(values, 'ra', 'slaac');
      const anycast = bool(values, 'anycast', false);
      const vrf = str(values, 'vrf', '');
      const findings: Finding[] = [];
      if (!address.includes(':') || !address.includes('/')) {
        findings.push(error('network.nxos.bad-ipv6', 'The IPv6 address is not an address and prefix length.', { source: 'ArchToolKit' }));
      }
      if (ra === 'slaac' && !address.endsWith('/64')) {
        findings.push(error('network.nxos.slaac-prefix', 'SLAAC only works on a /64.', { source: 'ArchToolKit' }));
      }
      if (anycast && ra !== 'suppress') {
        findings.push(warning('network.nxos.anycast-ra', 'With an anycast gateway, every leaf sends router advertisements from the same address. That works, but the hosts see a router whose lifetime resets from several sources — worth confirming against the fabric standard.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `IPv6 on ${iface}`,
        impact: 'brief',
        notes: [
          'The `feature interface-vlan` and IPv6 routing have to be on first. Without them the address is accepted and nothing routes.',
          'Hosts hold an address until it expires. Changing a prefix does not withdraw the old one.',
        ],
        before: [`show run interface ${iface}`, 'show ipv6 interface brief', `show ipv6 interface ${iface}`],
        config: [
          'feature interface-vlan',
          '!',
          `interface ${iface}`,
          '  no shutdown',
          ...(vrf ? [`  vrf member ${vrf}`] : []),
          ...(str(values, 'link_local', '') ? [`  ipv6 link-local ${str(values, 'link_local', '')}`] : []),
          ...(address ? [`  ipv6 address ${address}`] : []),
          ...(anycast ? ['  fabric forwarding mode anycast-gateway'] : []),
          ...(ra === 'suppress' ? ['  ipv6 nd suppress-ra'] : []),
          ...(ra === 'stateful' ? ['  ipv6 nd managed-config-flag', '  ipv6 nd other-config-flag'] : []),
          '!',
        ],
        verify: [`show ipv6 interface ${iface}`, 'show ipv6 route', 'show ipv6 neighbor', ...(anycast ? ['show fabric forwarding ipv6 local-host-db'] : [])],
        backout: [`interface ${iface}`, ...(address ? [`  no ipv6 address ${address}`] : []), '  shutdown', '!'],
        findings,
      };
    },
  }),
];

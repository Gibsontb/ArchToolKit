/**
 * Cisco Secure Firewall (FTD via FMC): the device itself — interfaces,
 * routing, site-to-site VPN, platform settings, HA, registration and
 * deployment.
 *
 * Objects, access control and NAT are in fmc.ts, which lists these after its
 * own.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, isIpv4, listOf, netmask, parseCidrDual, type DeviceChange } from '../device.ts';
import { dualCidrs, dualFindings } from './nxos-eos-dual.ts';
import { addressRef, apiChange, fact, find, findAddress, findZone, IN_DOMAIN, objectName, PLATFORM, PREVIEW_NOTE, ref, refOne, SECRET, SRC, zoneRef, type Operation } from './fmc-common.ts';

const DOMAIN_UUID = '{{ domain[0].uuid }}';

/** The device, found by its name in FMC. */
function findDevice(name: string): Operation {
  return find('getAllDevice', name, fact('dev', name));
}

/** Path parameters for something that lives under a device record. */
function onDevice(name: string, extra: Record<string, string> = {}): Record<string, string> {
  return { containerUUID: `{{ ${fact('dev', name)}[0].id }}`, domainUUID: DOMAIN_UUID, ...extra };
}

const DEVICE: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'fmc_interface',
    platform: PLATFORM,
    label: 'Interface: physical or sub-interface',
    group: 'Device',
    description: 'A routed physical interface or VLAN sub-interface on a managed FTD: logical name, security zone, IPv4/IPv6 address and MTU.',
    inputs: [
      { id: 'device', label: 'Device (FMC name)', control: 'text', default: 'ftd-edge-01' },
      { id: 'kind', label: 'Kind', control: 'select', default: 'physical', options: [{ value: 'physical', label: 'Physical interface' }, { value: 'subinterface', label: 'Sub-interface' }] },
      { id: 'interface', label: 'Hardware interface', control: 'text', default: 'Ethernet1/2', hint: 'The parent for a sub-interface' },
      { id: 'vlan', label: 'VLAN / sub-interface id', control: 'number', default: 100, min: 1, max: 4094, showWhen: { input: 'kind', equals: ['subinterface'] } },
      { id: 'ifname', label: 'Logical name', control: 'text', default: 'inside' },
      { id: 'zone', label: 'Security zone', control: 'text', default: 'INSIDE' },
      { id: 'address', label: 'Address', control: 'text', default: '10.10.0.1/24', hint: 'IPv4, IPv6, or one of each' },
      { id: 'mtu', label: 'MTU', control: 'number', default: 1500, min: 64, max: 9198 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const device = str(values, 'device', 'ftd');
      const sub = str(values, 'kind', 'physical') === 'subinterface';
      const hw = str(values, 'interface', 'Ethernet1/2');
      const vlan = num(values, 'vlan', 100);
      const ifname = objectName(str(values, 'ifname', ''), 'inside').toLowerCase();
      const zone = str(values, 'zone', '');
      const dual = dualCidrs(str(values, 'address', ''));
      const findings: Finding[] = [...dualFindings('network.fmc.bad-address', 'the interface address', dual, '10.10.0.1/24 or 2001:db8:10::1/64')];
      if (!dual.v4 && !dual.v6) findings.push(warning('network.fmc.no-address', 'No address: the interface is named and zoned but routes nothing.', SRC));
      const intf = fact('intf', hw);
      const common = {
        ifname,
        enabled: true,
        MTU: num(values, 'mtu', 1500),
        mode: 'NONE',
        ...(zone ? { securityZone: zoneRef(zone) } : {}),
        ...(dual.v4 ? { ipv4: { static: { address: dual.v4.address, netmask: netmask(dual.v4.prefix) } } } : {}),
        ...(dual.v6 ? { ipv6: { enableIPV6: true, addresses: [{ address: dual.v6.address, prefix: String(dual.v6.prefix), enforceEUI64: false }] } } : {}),
      };
      const ops: Operation[] = [
        findDevice(device),
        ...(zone ? [findZone(zone)] : []),
        ...(sub
          ? [{ operation: 'createMultipleFTDSubInterface', data: { type: 'SubInterface', name: hw, subIntfId: vlan, vlanId: vlan, ...common }, path_params: onDevice(device), register_as: fact('subif', `${hw}.${vlan}`) }]
          : [
              { operation: 'getAllFTDPhysicalInterface', path_params: onDevice(device), filters: { name: hw }, register_as: intf },
              { operation: 'updateFTDPhysicalInterface', data: { type: 'PhysicalInterface', id: `{{ ${intf}[0].id }}`, name: hw, ...common }, path_params: onDevice(device, { objectId: `{{ ${intf}[0].id }}` }) },
            ]),
      ];
      const label = sub ? `${hw}.${vlan}` : hw;
      return apiChange(ops, {
        title: `Interface ${label} "${ifname}" on ${device}`,
        impact: sub ? 'none' : 'brief',
        notes: [
          ...(sub ? ['The parent interface has to be enabled, with no logical name or address of its own.'] : ['Updating a physical interface replaces its whole definition: anything not set here (hardware speed, LLDP, IPv6 options) goes back to the default. Capture it first and carry anything you need into the change.']),
          'The logical name is what routes, NAT and platform settings refer to. Renaming an interface that is in use breaks those references.',
          PREVIEW_NOTE,
        ],
        before: [`GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords/{deviceId}/${sub ? 'subinterfaces' : 'physicalinterfaces'}?expanded=true (${device})`, `FMC: Devices > Device Management > ${device} > Interfaces`, 'On the FTD: show interface ip brief'],
        verify: [`FMC: Devices > Device Management > ${device} > Interfaces shows ${label} as ${ifname} in ${zone || 'no zone'}`, `After deployment, on the FTD: show interface ${label}, show nameif`],
        backout: sub
          ? [`deleteFTDSubInterface (containerUUID = ${device}'s id, objectId = ${label}'s id), or delete it in Devices > Device Management > ${device} > Interfaces`, 'Then deploy.']
          : [`updateFTDPhysicalInterface with the definition captured before the change, or edit ${hw} back in Devices > Device Management > ${device} > Interfaces`, 'Then deploy.'],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_static_route',
    platform: PLATFORM,
    label: 'Static route',
    group: 'Device',
    description: 'A static route on a managed FTD: destination and gateway objects (created if missing), the egress interface and a metric.',
    inputs: [
      { id: 'device', label: 'Device (FMC name)', control: 'text', default: 'ftd-edge-01' },
      { id: 'destination', label: 'Destination', control: 'text', default: '10.50.0.0/16', hint: 'IPv4 or IPv6 prefix' },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '10.10.0.254' },
      { id: 'ifname', label: 'Egress interface (logical name)', control: 'text', default: 'inside' },
      { id: 'metric', label: 'Metric', control: 'number', default: 1, min: 1, max: 254 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const device = str(values, 'device', 'ftd');
      const dest = parseCidrDual(str(values, 'destination', ''));
      const gw = str(values, 'gateway', '');
      const ifname = str(values, 'ifname', 'inside');
      const findings: Finding[] = [];
      if (!dest) findings.push(error('network.fmc.bad-prefix', 'The destination is not a valid prefix.', SRC));
      const gwFamily = gw.includes(':') ? 6 : 4;
      if (!gw || (gwFamily === 4 && !isIpv4(gw))) findings.push(error('network.fmc.bad-gateway', `"${gw}" is not a gateway address.`, SRC));
      if (dest && dest.family !== gwFamily) findings.push(error('network.fmc.route-family', 'The destination and the gateway are different address families.', SRC));
      const v6 = dest?.family === 6;
      const prefix = dest ? `${dest.network}/${dest.prefix}` : str(values, 'destination', '');
      const dstName = objectName(`NET-${prefix.replace(/[/:]/g, '_')}`, 'ROUTE-DEST');
      const gwName = objectName(`GW-${gw.replace(/:/g, '_')}`, 'ROUTE-GW');
      const ops: Operation[] = [
        findDevice(device),
        { operation: 'upsertNetworkObject', data: { name: dstName, value: prefix, type: 'Network' }, path_params: IN_DOMAIN, register_as: 'route_destination' },
        { operation: 'upsertHostObject', data: { name: gwName, value: gw, type: 'Host' }, path_params: IN_DOMAIN, register_as: 'route_gateway' },
        {
          operation: v6 ? 'createMultipleIPv6StaticRouteModel' : 'createMultipleIPv4StaticRouteModel',
          data: {
            type: v6 ? 'IPv6StaticRoute' : 'IPv4StaticRoute',
            interfaceName: ifname,
            selectedNetworks: [refOne('route_destination', 'Network')],
            gateway: { object: refOne('route_gateway', 'Host') },
            metricValue: num(values, 'metric', 1),
            isTunneled: false,
          },
          path_params: onDevice(device),
        },
      ];
      return apiChange(ops, {
        title: `Static route ${prefix} via ${gw} on ${device}`,
        impact: 'brief',
        notes: ['The gateway has to be on the subnet of the egress interface. A static route overrides a dynamic one for the same prefix (distance 1).', PREVIEW_NOTE],
        before: [`GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords/{deviceId}/routing/${v6 ? 'ipv6staticroutes' : 'ipv4staticroutes'}?expanded=true (${device})`, `On the FTD: show route ${dest?.network ?? prefix}`],
        verify: [`FMC: Devices > Device Management > ${device} > Routing > Static Route shows ${prefix}`, `After deployment, on the FTD: show route ${dest?.network ?? prefix}`],
        backout: [`${v6 ? 'deleteIPv6StaticRouteModel' : 'deleteIPv4StaticRouteModel'} (containerUUID = ${device}'s id, objectId = the route's id), or delete it in Devices > Device Management > ${device} > Routing`, `Then deploy. The objects ${dstName} and ${gwName} can be deleted after.`],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_bgp',
    platform: PLATFORM,
    label: 'BGP neighbor',
    group: 'Device',
    description: 'BGP on a managed FTD: the AS and router id, and an IPv4 neighbor with a maximum-prefix limit and an optional password.',
    inputs: [
      { id: 'device', label: 'Device (FMC name)', control: 'text', default: 'ftd-edge-01' },
      { id: 'asn', label: 'Local AS', control: 'text', default: '65010' },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.10.1' },
      { id: 'neighbor', label: 'Neighbor address', control: 'text', default: '192.0.2.1' },
      { id: 'remote_as', label: 'Remote AS', control: 'text', default: '65000' },
      { id: 'neighbor_description', label: 'Description', control: 'text', default: 'upstream PE' },
      { id: 'max_prefix', label: 'Maximum prefixes', control: 'number', default: 1000, min: 0, max: 2147483647, hint: '0 for no limit' },
      { id: 'password', label: 'MD5 password', control: 'toggle', default: false },
      { id: 'bfd', label: 'BFD', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const device = str(values, 'device', 'ftd');
      const asn = str(values, 'asn', '65010');
      const rid = str(values, 'router_id', '');
      const neighbor = str(values, 'neighbor', '');
      const remote = str(values, 'remote_as', '');
      const maxPrefix = num(values, 'max_prefix', 1000);
      const findings: Finding[] = [];
      if (!isIpv4(neighbor)) findings.push(error('network.fmc.bad-neighbor', 'This blueprint writes an IPv4 neighbor; the address is not IPv4.', SRC));
      if (rid && !isIpv4(rid)) findings.push(error('network.fmc.router-id', 'The router id is written as a dotted IPv4 value.', SRC));
      if (maxPrefix <= 0) findings.push(warning('network.fmc.no-max-prefix', 'No maximum-prefix limit: a neighbor that leaks a full table fills the firewall’s route table.', SRC));
      const ops: Operation[] = [
        findDevice(device),
        { operation: 'createBGPGeneralSettingModel', data: { name: 'AsaBGPGeneralTable', asNumber: asn, ...(rid ? { routerId: rid } : {}), logNeighborChanges: true, fastExternalFallOver: true, enforceFirstAs: true }, path_params: onDevice(device) },
        {
          operation: 'createBGPIPvAddressFamilyModel',
          data: {
            type: 'bgp',
            name: 'bgp',
            asNumber: asn,
            addressFamilyIPv4: {
              type: 'afipv4',
              neighbors: [
                {
                  type: 'neighboripv4',
                  ipv4Address: neighbor,
                  remoteAs: remote,
                  neighborGeneral: { type: 'neighborgeneral', enableAddress: true, shutdown: false, description: description(str(values, 'neighbor_description', ''), `AS ${remote}`), ...(bool(values, 'bfd', false) ? { fallOverBFD: 'SINGLE_HOP' } : {}) },
                  ...(maxPrefix > 0 ? { neighborFiltering: { type: 'neighborfiltering', neighborMaximumPrefix: { type: 'neighbormaximumprefix', maxPrefixLimit: maxPrefix, thresholdValue: 75 } } } : {}),
                  ...(bool(values, 'password', false) ? { neighborAdvanced: { type: 'neighboradvanced', neighborSecret: SECRET } } : {}),
                },
              ],
            },
          },
          path_params: onDevice(device),
        },
      ];
      return apiChange(ops, {
        title: `BGP AS ${asn} neighbor ${neighbor} (AS ${remote}) on ${device}`,
        impact: 'brief',
        notes: [
          'VERIFY: the BGP payload follows the fmcansible operation docs (createBGPGeneralSettingModel, createBGPIPvAddressFamilyModel). Check the field names against the FMC API Explorer for the release in use before running it.',
          'The FTD advertises only networks added under the IPv4 address family (or redistributed): add them in Devices > Device Management > Routing > BGP > IPv4 > Networks. Filtering in and out is also set there.',
          'If BGP is already configured on the device, the general settings exist: use the update operations instead of create.',
          ...(bool(values, 'password', false) ? ['The neighbor password is `<REQUIRED>`: fill it in from the vault.'] : []),
          PREVIEW_NOTE,
        ],
        before: [`GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords/{deviceId}/routing/bgp (${device})`, 'On the FTD: show bgp summary'],
        verify: [`FMC: Devices > Device Management > ${device} > Routing > BGP`, 'After deployment, on the FTD: show bgp summary, show bgp neighbors ' + neighbor, 'show route bgp'],
        backout: [`deleteBGPIPvAddressFamilyModel (containerUUID = ${device}'s id, objectId = the BGP id), or remove the neighbor in Devices > Device Management > ${device} > Routing > BGP > IPv4`, 'Then deploy.'],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_s2s_vpn',
    platform: PLATFORM,
    label: 'Site-to-site VPN (IKEv2, pre-shared key)',
    group: 'VPN',
    description: 'A point-to-point IKEv2 topology between a managed FTD and an external peer, with protected networks on each side and a manual pre-shared key.',
    inputs: [
      { id: 'name', label: 'Topology name', control: 'text', default: 'S2S-BRANCH-50' },
      { id: 'device', label: 'Device (FMC name)', control: 'text', default: 'ftd-edge-01' },
      { id: 'interface', label: 'Device interface', control: 'text', default: 'Ethernet1/1', hint: 'The hardware name of the outside interface' },
      { id: 'local_networks', label: 'Local protected network', control: 'text', default: 'APP-NET', hint: 'Network object name' },
      { id: 'peer_name', label: 'Peer name', control: 'text', default: 'BRANCH-50' },
      { id: 'peer_address', label: 'Peer address', control: 'text', default: '198.51.100.50' },
      { id: 'remote_networks', label: 'Remote protected network', control: 'text', default: 'BRANCH-50-LAN', hint: 'Network object name' },
      { id: 'ike_policy', label: 'IKEv2 policy', control: 'text', default: 'AES-GCM-NULL-SHA-LATEST', hint: 'An IKEv2 policy object that exists in FMC' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = objectName(str(values, 'name', ''), 'S2S');
      const device = str(values, 'device', 'ftd');
      const hw = str(values, 'interface', 'Ethernet1/1');
      const local = listOf(str(values, 'local_networks', ''));
      const peer = objectName(str(values, 'peer_name', ''), 'PEER');
      const peerAddress = str(values, 'peer_address', '');
      const remote = listOf(str(values, 'remote_networks', ''));
      const ike = str(values, 'ike_policy', 'AES-GCM-NULL-SHA-LATEST');
      const findings: Finding[] = [];
      if (!isIpv4(peerAddress) && !peerAddress.includes(':')) findings.push(error('network.fmc.bad-peer', `"${peerAddress}" is not an address.`, SRC));
      if (local.length === 0 || remote.length === 0) findings.push(error('network.fmc.vpn-no-networks', 'Both sides need a protected network.', SRC));
      findings.push(info('network.fmc.vpn-access', 'Decrypted traffic is subject to the access policy unless "Bypass Access Control policy for decrypted traffic" is set on the topology: allow the protected networks in an access rule.', SRC));
      const vpn = fact('s2s', name);
      const intf = fact('vpnif', `${device}_${hw}`);
      const ikeSettings = fact('ike', name);
      const inTopology = (extra: Record<string, string> = {}) => ({ containerUUID: `{{ ${vpn}.id }}`, domainUUID: DOMAIN_UUID, ...extra });
      const ops: Operation[] = [
        findDevice(device),
        { operation: 'getAllFTDPhysicalInterface', path_params: onDevice(device), filters: { name: hw }, register_as: intf },
        ...[...local, ...remote].map(findAddress),
        find('getAllIkev2PolicyObject', ike, fact('ikepol', ike)),
        { operation: 'createFTDS2SVpnModel', data: { name, type: 'FTDS2SVpn', topologyType: 'POINT_TO_POINT', ikeV1Enabled: false, ikeV2Enabled: true }, path_params: IN_DOMAIN, register_as: vpn },
        {
          operation: 'createVpnEndpoint',
          data: { name: device, type: 'EndPoint', peerType: 'PEER', extranet: false, device: ref(fact('dev', device), 'Device'), interface: ref(intf, 'PhysicalInterface'), protectedNetworks: { networks: local.map(addressRef) }, connectionType: 'BIDIRECTIONAL' },
          path_params: inTopology(),
        },
        {
          operation: 'createVpnEndpoint',
          data: { name: peer, type: 'EndPoint', peerType: 'PEER', extranet: true, extranetInfo: { name: peer, ipAddress: peerAddress, isDynamicIP: false }, protectedNetworks: { networks: remote.map(addressRef) }, connectionType: 'BIDIRECTIONAL' },
          path_params: inTopology(),
        },
        { operation: 'getAllVpnIkeSettings', path_params: inTopology(), register_as: ikeSettings },
        {
          operation: 'updateVpnIkeSettings',
          data: {
            id: `{{ ${ikeSettings}[0].id }}`,
            type: 'IkeSettings',
            ikeV2Settings: { authenticationType: 'MANUAL_PRE_SHARED_KEY', manualPreSharedKey: SECRET, enforceHexBasedPreSharedKeyOnly: false, policies: [ref(fact('ikepol', ike), 'Ikev2Policy')] },
          },
          path_params: inTopology({ objectId: `{{ ${ikeSettings}[0].id }}` }),
        },
      ];
      return apiChange(ops, {
        title: `Site-to-site VPN ${name}: ${device} <-> ${peer} (${peerAddress})`,
        impact: 'none',
        notes: [
          'The pre-shared key is `<REQUIRED>`: fill it in from the vault. The peer needs the same key, the same IKEv2 proposal and mirror-image protected networks.',
          'The IPsec proposal is left at the topology default; set it under the topology’s IPsec tab if the peer needs something else.',
          'The protected-network objects must exist first (the network objects blueprint).',
          PREVIEW_NOTE,
        ],
        before: ['GET /api/fmc_config/v1/domain/{domainUUID}/policy/ftds2svpns', 'FMC: Devices > VPN > Site To Site', 'On the FTD: show crypto ikev2 sa'],
        verify: [`FMC: Devices > VPN > Site To Site shows ${name}`, 'After deployment, on the FTD: show crypto ikev2 sa, show crypto ipsec sa peer ' + peerAddress, 'FMC: Overview > Dashboards > Site to Site VPN'],
        backout: [`deleteFTDS2SVpnModel (objectId of ${name}), or delete the topology in Devices > VPN > Site To Site`, 'Then deploy: the tunnel and its crypto map are removed from the device.'],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_platform_settings',
    platform: PLATFORM,
    label: 'Platform settings: NTP, syslog, SNMP',
    group: 'Device',
    description: 'Host objects for the NTP, syslog and SNMP servers, and a platform settings policy assigned to the device; the settings inside it are GUI steps.',
    inputs: [
      { id: 'policy', label: 'Platform settings policy', control: 'text', default: 'FTD-PLATFORM' },
      { id: 'device', label: 'Device (FMC name)', control: 'text', default: 'ftd-edge-01' },
      { id: 'ntp', label: 'NTP servers', control: 'text', default: '192.0.2.123, 192.0.2.124' },
      { id: 'syslog', label: 'Syslog servers', control: 'text', default: '192.0.2.50' },
      { id: 'snmp', label: 'SNMP managers', control: 'text', default: '192.0.2.60' },
      { id: 'ifname', label: 'Interface they are reached on', control: 'text', default: 'inside' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const policy = str(values, 'policy', 'FTD-PLATFORM');
      const device = str(values, 'device', 'ftd');
      const ifname = str(values, 'ifname', 'inside');
      const groups = { NTP: listOf(str(values, 'ntp', '')), SYSLOG: listOf(str(values, 'syslog', '')), SNMP: listOf(str(values, 'snmp', '')) };
      const findings: Finding[] = [];
      for (const list of Object.values(groups)) for (const a of list) if (!isIpv4(a) && !a.includes(':')) findings.push(error('network.fmc.bad-server', `"${a}" is not an address.`, SRC));
      if (groups.NTP.length < 2) findings.push(warning('network.fmc.single-ntp', 'Fewer than two NTP servers: one bad clock cannot be outvoted.', SRC));
      findings.push(info('network.fmc.platform-settings-gui', 'The fmcansible collection documents only read operations for platform settings, syslog and SNMP, so the settings inside the policy are GUI steps in the notes. The objects and the assignment are API operations.', SRC));
      const hostName = (kind: string, a: string) => objectName(`${kind}-${a.replace(/:/g, '_')}`, kind);
      const psp = fact('psp', policy);
      const ops: Operation[] = [
        ...Object.entries(groups).flatMap(([kind, list]) => list.map((a) => ({ operation: 'upsertHostObject', data: { name: hostName(kind, a), value: a, type: 'Host', description: `${kind.toLowerCase()} server` }, path_params: IN_DOMAIN }))),
        find('getAllFTDPlatformSettingsPolicy', policy, psp),
        findDevice(device),
        { operation: 'createPolicyAssignment', data: { type: 'PolicyAssignment', policy: ref(psp, 'FTDPlatformSettingsPolicy', policy), targets: [ref(fact('dev', device), 'Device', device)] }, path_params: IN_DOMAIN },
      ];
      return apiChange(ops, {
        title: `Platform settings ${policy} on ${device}`,
        impact: 'none',
        notes: [
          `The platform settings policy ${policy} must exist (Devices > Platform Settings > New Policy > Threat Defense Settings). If it is already assigned to other devices, the assignment has to be updated instead (updatePolicyAssignment).`,
          `In Devices > Platform Settings > ${policy}: Time Synchronization > Via NTP from ${groups.NTP.map((a) => hostName('NTP', a)).join(', ') || '(none)'}.`,
          `Syslog > Logging Setup: enable logging; Syslog Servers: add ${groups.SYSLOG.map((a) => hostName('SYSLOG', a)).join(', ') || '(none)'} on the ${ifname} interface, UDP 514 or TCP 1470; Logging Destinations: syslog servers at informational.`,
          `SNMP: enable SNMP servers, add hosts ${groups.SNMP.map((a) => hostName('SNMP', a)).join(', ') || '(none)'} on ${ifname}, prefer SNMPv3 users (auth SHA, priv AES); a v2c community is <REQUIRED> from the vault, never typed into a ticket.`,
          PREVIEW_NOTE,
        ],
        before: ['GET /api/fmc_config/v1/domain/{domainUUID}/policy/ftdplatformsettingspolicies', `FMC: Devices > Platform Settings: which policy ${device} has now`, 'On the FTD: show ntp associations, show logging setting, show snmp-server host'],
        verify: ['After deployment, on the FTD: show ntp associations', 'show logging setting (the syslog hosts are listed)', 'show snmp-server host', `FMC: Devices > Platform Settings shows ${policy} targeting ${device}`],
        backout: [`Re-assign ${device}'s previous platform settings policy (Devices > Platform Settings > Policy Assignment) and deploy`, 'The host objects can be deleted afterwards (deleteHostObject), once nothing refers to them.'],
        findings,
      });
    },
  }),
];

const LIFECYCLE: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'fmc_ha_pair',
    platform: PLATFORM,
    label: 'High availability pair',
    group: 'Lifecycle',
    description: 'Joins two registered FTDs into an active/standby HA pair over a failover link, with an encrypted, keyed failover channel.',
    inputs: [
      { id: 'name', label: 'HA pair name', control: 'text', default: 'FTD-EDGE-HA' },
      { id: 'primary', label: 'Primary device', control: 'text', default: 'ftd-edge-01' },
      { id: 'secondary', label: 'Secondary device', control: 'text', default: 'ftd-edge-02' },
      { id: 'link', label: 'Failover link interface', control: 'text', default: 'Ethernet1/8', hint: 'Unconfigured (no logical name) on both' },
      { id: 'active_ip', label: 'Primary failover address', control: 'text', default: '169.254.8.1' },
      { id: 'standby_ip', label: 'Secondary failover address', control: 'text', default: '169.254.8.2' },
      { id: 'prefix', label: 'Failover link prefix length', control: 'number', default: 30, min: 8, max: 30 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = objectName(str(values, 'name', ''), 'FTD-HA');
      const primary = str(values, 'primary', '');
      const secondary = str(values, 'secondary', '');
      const link = str(values, 'link', 'Ethernet1/8');
      const active = str(values, 'active_ip', '');
      const standby = str(values, 'standby_ip', '');
      const mask = netmask(num(values, 'prefix', 30));
      const findings: Finding[] = [];
      if (!isIpv4(active) || !isIpv4(standby)) findings.push(error('network.fmc.ha-address', 'The failover addresses have to be IPv4 addresses.', SRC));
      if (primary && primary === secondary) findings.push(error('network.fmc.ha-same-device', 'The primary and the secondary are the same device.', SRC));
      findings.push(warning('network.fmc.ha-secondary-overwritten', `Forming the pair replaces ${secondary}’s configuration with ${primary}’s, and both devices deploy as part of it.`, SRC));
      const linkFact = fact('halink', `${primary}_${link}`);
      const failover = { useIPv6Address: false, subnetMask: mask, interfaceObject: { id: `{{ ${linkFact}[0].id }}`, type: 'PhysicalInterface', name: link }, activeIP: active, standbyIP: standby, logicalName: 'FAILOVER-LINK' };
      const ops: Operation[] = [
        findDevice(primary),
        findDevice(secondary),
        { operation: 'getAllFTDPhysicalInterface', path_params: onDevice(primary), filters: { name: link }, register_as: linkFact },
        {
          operation: 'createFTDHADeviceContainer',
          data: {
            type: 'DeviceHAPair',
            name,
            primary: { id: `{{ ${fact('dev', primary)}[0].id }}` },
            secondary: { id: `{{ ${fact('dev', secondary)}[0].id }}` },
            ftdHABootstrap: { isEncryptionEnabled: true, encKeyGenerationScheme: 'CUSTOM', sharedKey: SECRET, useSameLinkForFailovers: true, lanFailover: failover, statefulFailover: { ...failover, logicalName: 'FAILOVER-LINK' } },
          },
          path_params: IN_DOMAIN,
          register_as: fact('ha', name),
        },
      ];
      return apiChange(ops, {
        title: `HA pair ${name}: ${primary} (active) / ${secondary} (standby)`,
        impact: 'outage',
        notes: [
          'Both devices must be the same model, software version, licence tier, firewall mode and interface layout, registered to this FMC with no pending deployment.',
          `${link} must be cabled between them and unconfigured (no logical name) on both.`,
          'The failover key is `<REQUIRED>`: fill it in from the vault.',
          'Forming the pair is a task that takes several minutes: watch Notifications > Tasks. The secondary is unavailable while it syncs.',
        ],
        before: ['GET /api/fmc_config/v1/domain/{domainUUID}/devicehapairs/ftddevicehapairs', `FMC: Devices > Device Management: ${primary} and ${secondary} healthy, same version, nothing pending`, 'On both FTDs: show version, show interface ip brief'],
        verify: [`FMC: Devices > Device Management shows ${name} with ${primary} active and ${secondary} standby`, 'On the FTD: show failover, show failover state', 'GET /api/fmc_config/v1/domain/{domainUUID}/devicehapairs/ftddevicehapairs'],
        backout: [`Break the pair: Devices > Device Management > ${name} > Break (or updateFTDHADeviceContainer with action HA_BREAK), which keeps the configuration on the active unit`, `Or deleteFTDHADeviceContainer (objectId of ${name}) to remove it; the secondary then needs its own configuration and a deployment.`],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_device_registration',
    platform: PLATFORM,
    label: 'Device registration',
    group: 'Lifecycle',
    description: 'Registers an FTD with FMC: its address, registration key and NAT id, licences, performance tier and the access policy it starts with.',
    inputs: [
      { id: 'name', label: 'Display name', control: 'text', default: 'ftd-edge-03' },
      { id: 'host', label: 'FTD management address', control: 'text', default: '192.0.2.33', hint: 'Empty when the FTD is behind NAT and registers with a NAT id' },
      { id: 'nat_id', label: 'Use a NAT id', control: 'toggle', default: false },
      { id: 'access_policy', label: 'Initial access policy', control: 'text', default: 'EDGE-ACP' },
      { id: 'licenses', label: 'Licences', control: 'text', default: 'MALWARE, URLFilter, THREAT', hint: 'Essentials is included; MALWARE, URLFilter, THREAT (IPS), CARRIER' },
      {
        id: 'tier',
        label: 'Performance tier',
        control: 'select',
        default: 'Legacy',
        options: [
          { value: 'Legacy', label: 'Legacy / hardware appliance' },
          { value: 'FTDv5', label: 'FTDv5' },
          { value: 'FTDv10', label: 'FTDv10' },
          { value: 'FTDv20', label: 'FTDv20' },
          { value: 'FTDv30', label: 'FTDv30' },
          { value: 'FTDv50', label: 'FTDv50' },
          { value: 'FTDv100', label: 'FTDv100' },
        ],
      },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'name', 'ftd');
      const host = str(values, 'host', '');
      const natId = bool(values, 'nat_id', false);
      const acpName = str(values, 'access_policy', 'EDGE-ACP');
      const licenses = listOf(str(values, 'licenses', '')).map((l) => l.replace(/^(ESSENTIALS|BASE)$/i, 'BASE'));
      const tier = str(values, 'tier', 'Legacy');
      const findings: Finding[] = [];
      if (!host && !natId) findings.push(error('network.fmc.register-no-host', 'Give the FTD’s address, or register with a NAT id.', SRC));
      const acp = fact('acp', acpName);
      const ops: Operation[] = [
        find('getAllAccessPolicy', acpName, acp),
        {
          operation: 'createMultipleDevice',
          data: {
            name,
            hostName: host || 'DONTRESOLVE',
            regKey: SECRET,
            ...(natId ? { natID: SECRET } : {}),
            type: 'Device',
            license_caps: ['BASE', ...licenses.filter((l) => l !== 'BASE')],
            ...(tier !== 'Legacy' ? { performanceTier: tier } : {}),
            accessPolicy: ref(acp, 'AccessPolicy'),
          },
          path_params: IN_DOMAIN,
          register_as: fact('newdev', name),
        },
      ];
      return apiChange(ops, {
        title: `Register ${name}${host ? ` (${host})` : ''} with FMC`,
        impact: 'none',
        notes: [
          `On the FTD first: \`configure manager add ${host ? 'MANAGER-ADDRESS' : 'DONTRESOLVE'} <regkey>${natId ? ' <nat-id>' : ''}\`, with the same registration key${natId ? ' and NAT id' : ''} as here. Both are \`<REQUIRED>\` from the vault.`,
          'Registration is a task that takes minutes; the first deployment runs as part of it with the access policy named here.',
          'Smart licensing must have the licences available, or registration succeeds with the features disabled.',
        ],
        before: ['GET /api/fmc_config/v1/domain/{domainUUID}/devices/devicerecords', 'On the FTD: show managers'],
        verify: [`FMC: Devices > Device Management shows ${name}, healthy`, 'Notifications > Tasks: the registration task completed', 'On the FTD: show managers (Registration: Completed)'],
        backout: [`deleteDevice (objectId of ${name}), or Devices > Device Management > ${name} > Delete`, 'On the FTD: configure manager delete, to stop it trying to reconnect.'],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_deploy',
    platform: PLATFORM,
    label: 'Deploy pending changes',
    group: 'Lifecycle',
    description: 'Deploys the pending FMC changes to one device: finds it among the deployable devices and starts a deployment request.',
    inputs: [
      { id: 'device', label: 'Device (FMC name)', control: 'text', default: 'ftd-edge-01' },
      { id: 'note', label: 'Deployment note', control: 'text', default: 'CHG0000000' },
      { id: 'ignore_warnings', label: 'Ignore warnings', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const device = str(values, 'device', 'ftd');
      const ignore = bool(values, 'ignore_warnings', false);
      const deployable = fact('deployable', device);
      const findings: Finding[] = [info('network.fmc.deploy-snort', 'A deployment that changes intrusion, file or network analysis settings can restart Snort: traffic is dropped or passed uninspected for a moment, per the device’s settings.', SRC)];
      if (ignore) findings.push(warning('network.fmc.deploy-ignore-warnings', 'Warnings are ignored: FMC deploys even when it has flagged a problem with the configuration.', SRC));
      const ops: Operation[] = [
        { operation: 'getDeployableDevice', path_params: IN_DOMAIN, query_params: { expanded: true }, filters: { name: device }, register_as: deployable },
        {
          operation: 'createDeploymentRequest',
          data: {
            type: 'DeploymentRequest',
            version: `{{ ${deployable}[0].version }}`,
            forceDeploy: false,
            ignoreWarning: ignore,
            deviceList: [`{{ ${deployable}[0].device.id }}`],
            deploymentNote: description(str(values, 'note', ''), 'ArchToolKit change'),
          },
          path_params: IN_DOMAIN,
          register_as: fact('deployment', device),
        },
      ];
      return apiChange(ops, {
        title: `Deploy pending changes to ${device}`,
        impact: 'brief',
        notes: [
          'This is the step that makes every other FMC change live. Deploy in the change window.',
          `If ${device} has nothing pending it is not among the deployable devices and the request fails: that is the check that the earlier steps changed something.`,
          'Everything pending for the device deploys, including changes someone else made: read Deploy > Deployment > Preview first.',
        ],
        before: [`FMC: Deploy > Deployment: ${device} listed with the expected pending changes`, 'GET /api/fmc_config/v1/domain/{domainUUID}/deployment/deployabledevices?expanded=true', PREVIEW_NOTE],
        verify: ['FMC: Deploy > Deployment History: the job completed', `GET /api/fmc_config/v1/domain/{domainUUID}/deployment/jobhistories (${device})`, 'On the FTD: show running-config (spot-check what changed)'],
        backout: [`Deploy > Deployment History > (this job) > Rollback returns ${device} to the configuration of the previous deployment (FMC 7.2 and later)`, 'Otherwise, revert the changes in FMC and deploy again.'],
        findings,
      });
    },
  }),
];

export const FMC_DEVICES: readonly ChangeBlueprint[] = [...DEVICE, ...LIFECYCLE];

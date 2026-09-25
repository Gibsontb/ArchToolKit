/**
 * Fortinet FortiOS: the Security Fabric edge — FortiSwitch, FortiAP and ZTNA.
 *
 * The first three files make the FortiGate a firewall and a VPN head end. What
 * was missing is the FortiGate as a controller: FortiLink and the FortiSwitch
 * VLANs it serves, a managed FortiSwitch authorised and its ports assigned,
 * FortiAP profiles, SSIDs and authorised APs, and the ZTNA access proxy that
 * publishes an application to managed devices rather than to a network.
 *
 * FortiOS applies each block as its `end` is entered: there is no commit to
 * hold a change back, so each back-out is written to paste straight in.
 *
 * These are CLI only. The fortios collection has a module per table
 * (fortios_switch_controller_managed_switch, fortios_wireless_controller_vap
 * and the rest), but each of these changes is several tables in an order that
 * matters — a VAP before the profile that names it, a VLAN before the port —
 * and a playbook that is one of them would be a partial change.
 *
 * No key is written: a PSK or SAE password is `<REQUIRED>`.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { listOf, netmask, parseCidr,                   } from '../device.js';
import { isIp, isIpv4Address, overlapsAny } from '../../core/ip.js';

const PLATFORM = 'fortios'         ;
const SECRET = '<REQUIRED>';

const ipMask = (c                                     )         => `${c.address} ${netmask(c.prefix)}`;

/** "port1-port24, port48" as the port names a FortiSwitch has. */
function expandPorts(value        )           {
  const out           = [];
  for (const part of listOf(value)) {
    const range = /^([A-Za-z]+)(\d+)-(?:[A-Za-z]+)?(\d+)$/.exec(part);
    if (range) {
      const [, stem, from, to] = range;
      const a = Number(from);
      const b = Number(to);
      for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 256; i += 1) out.push(`${stem}${i}`);
      continue;
    }
    out.push(part);
  }
  return [...new Set(out)];
}

export const FORTIOS_EXTRA_3                             = [
  deviceBlueprint({
    id: 'fortios_fortilink',
    platform: PLATFORM,
    label: 'FortiLink and FortiSwitch VLANs',
    group: 'Switching and wireless',
    description: 'The FortiLink interface the FortiGate manages FortiSwitches through, and the VLANs it serves to them — each one a FortiGate interface with its own address, so routing and policy between them stay on the FortiGate.',
    inputs: [
      { id: 'fortilink', label: 'FortiLink interface', control: 'text', default: 'fortilink' },
      { id: 'create', label: 'Create it as a new aggregate', control: 'toggle', default: false, hint: 'Off edits the FortiLink interface the model ships with' },
      { id: 'members', label: 'Member ports', control: 'text', default: 'port9, port10', showWhen: { input: 'create', equals: ['true'] } },
      { id: 'fortilink_ip', label: 'FortiLink address', control: 'text', default: '10.255.1.1/24' },
      { id: 'vlans', label: 'VLANs', control: 'textarea', default: '20 DATA 10.20.0.1/24\n30 VOICE 10.30.0.1/24\n40 IOT 10.40.0.1/24', hint: 'One per line: VLAN-id name address/prefix' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const link = str(values, 'fortilink', 'fortilink').trim() || 'fortilink';
      const create = bool(values, 'create', false);
      const members = listOf(str(values, 'members', ''));
      const linkIp = parseCidr(str(values, 'fortilink_ip', ''));
      const vdom = str(values, 'vdom', 'root').trim() || 'root';
      const rows = str(values, 'vlans', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 3 && parts[0] !== '')
        .map(([id = '', vlanName = '', cidr = '']) => ({ id: Number(id), name: `VLAN${id}-${vlanName.toUpperCase()}`.slice(0, 15), cidr: parseCidr(cidr), typed: cidr }));
      const findings            = [];
      if (!linkIp) findings.push(error('network.fortios.bad-fortilink-ip', 'The FortiLink address is not an IPv4 address with a prefix. FortiLink is IPv4 only.', { source: 'ArchToolKit' }));
      if (create && members.length === 0) findings.push(error('network.fortios.fortilink-no-members', 'A new FortiLink aggregate needs at least one member port.', { source: 'ArchToolKit' }));
      if (create && members.length === 1) findings.push(warning('network.fortios.fortilink-single', 'One FortiLink port: if it fails, every switch behind it is unmanaged and, in the default mode, its VLANs lose their gateway.', { remediation: 'Use two ports, to two switches in an MCLAG pair or a stack.', source: 'ArchToolKit' }));
      const badId = rows.filter((r) => !Number.isInteger(r.id) || r.id < 1 || r.id > 4094);
      if (badId.length > 0) findings.push(error('network.fortios.bad-vlan-id', `Not a VLAN id: ${badId.map((r) => r.id).join(', ')}.`, { source: 'ArchToolKit' }));
      const badCidr = rows.filter((r) => !r.cidr);
      if (badCidr.length > 0) findings.push(error('network.fortios.bad-vlan-address', `Not an IPv4 address with a prefix: ${badCidr.map((r) => r.typed).join(', ')}.`, { remediation: 'Write it as 10.20.0.1/24. An IPv6 address is added afterwards on the interface (config ipv6).', source: 'ArchToolKit' }));
      const ids = rows.map((r) => r.id);
      const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupIds.length > 0) findings.push(error('network.fortios.duplicate-vlan', `VLAN ${[...new Set(dupIds)].join(', ')} is listed twice.`, { source: 'ArchToolKit' }));
      const nets = [...(linkIp ? [{ label: link, cidr: `${linkIp.address}/${linkIp.prefix}` }] : []), ...rows.filter((r) => r.cidr).map((r) => ({ label: r.name, cidr: `${r.cidr .address}/${r.cidr .prefix}` }))];
      for (let i = 0; i < nets.length; i += 1) {
        for (let j = i + 1; j < nets.length; j += 1) {
          if (overlapsAny(nets[i] .cidr, nets[j] .cidr)) {
            findings.push(error('network.fortios.vlan-overlap', `${nets[i] .label} (${nets[i] .cidr}) and ${nets[j] .label} (${nets[j] .cidr}) overlap. FortiOS refuses the second interface.`, { source: 'ArchToolKit' }));
          }
        }
      }
      const high = rows.filter((r) => r.id >= 4089);
      if (high.length > 0) {
        findings.push(warning('network.fortios.vlan-reserved-range', `VLAN ${high.map((r) => r.id).join(', ')} is in the range FortiOS uses for the default FortiSwitch VLANs (quarantine, RSPAN, voice, video, onboarding, NAC) on many releases.`, { remediation: 'Check `show system interface | grep vlanid` first, or pick an id below 4089.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `FortiLink ${link} with ${rows.length} FortiSwitch VLAN${rows.length === 1 ? '' : 's'}`,
        impact: create ? 'brief' : 'none',
        notes: [
          create
            ? `The member ports must not be in use: no address, no policy, no other aggregate. The interface type is fixed at creation, so if ${link} already exists this fails — edit it instead with the toggle off.`
            : `${link} is edited, not created. On most models it ships as FortiLink already; check with \`show system interface ${link}\`.`,
          'allowaccess fabric is what lets a FortiSwitch reach the FortiGate over FortiLink (CAPWAP and the Security Fabric). Without it switches are discovered and never come online.',
          'Each VLAN is a FortiGate interface: the FortiGate is its gateway, and traffic between VLANs goes through a firewall policy. Add the DHCP server and the policies next.',
          'The VLANs reach a switch port only when the port is assigned (the managed FortiSwitch step).',
        ],
        before: ['show system interface', `show system interface ${link}`, 'show switch-controller managed-switch', 'execute switch-controller get-conn-status'],
        config: [
          'config system interface',
          `    edit "${link}"`,
          `        set vdom "${vdom}"`,
          ...(create ? ['        set type aggregate', `        set member ${members.map((m) => `"${m}"`).join(' ')}`] : []),
          '        set fortilink enable',
          ...(linkIp ? [`        set ip ${ipMask(linkIp)}`] : []),
          '        set allowaccess ping fabric',
          '        set lldp-reception enable',
          '        set lldp-transmission enable',
          '    next',
          ...rows.flatMap((r) => [
            `    edit "${r.name}"`,
            `        set vdom "${vdom}"`,
            `        set interface "${link}"`,
            `        set vlanid ${r.id}`,
            ...(r.cidr ? [`        set ip ${ipMask(r.cidr)}`] : []),
            '        set allowaccess ping',
            '        set role lan',
            '        set device-identification enable',
            '    next',
          ]),
          'end',
        ],
        verify: [
          `show system interface ${link}`,
          ...rows.slice(0, 3).map((r) => `show system interface ${r.name}`),
          'execute switch-controller get-conn-status',
          'diagnose switch-controller switch-info mac-table',
        ],
        backout: [
          'config system interface',
          ...rows.map((r) => `    delete "${r.name}"`),
          ...(create ? [`    delete "${link}"`] : []),
          'end',
          ...(create ? [] : [`# ${link} itself is left as it was edited: set its address back if it changed.`]),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_managed_switch',
    platform: PLATFORM,
    label: 'Managed FortiSwitch and its ports',
    group: 'Switching and wireless',
    description: 'Authorise a FortiSwitch discovered over FortiLink and assign its access ports: the native VLAN, the tagged VLANs a phone or AP needs, and BPDU guard on the edge.',
    inputs: [
      { id: 'serial', label: 'FortiSwitch serial', control: 'text', default: 'S148EPTF18000001' },
      { id: 'description', label: 'Description', control: 'text', default: 'IDF-1 floor 1' },
      { id: 'fortilink', label: 'FortiLink interface', control: 'text', default: 'fortilink' },
      { id: 'ports', label: 'Access ports', control: 'text', default: 'port1-port24', hint: 'port1-port24, port30' },
      { id: 'native_vlan', label: 'Native (untagged) VLAN interface', control: 'text', default: 'VLAN20-DATA' },
      { id: 'tagged_vlans', label: 'Tagged VLAN interfaces', control: 'text', default: 'VLAN30-VOICE', hint: 'For phones and APs. Empty for none' },
      { id: 'bpdu_guard', label: 'BPDU guard on these ports', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const serial = str(values, 'serial', '').trim().toUpperCase();
      const link = str(values, 'fortilink', 'fortilink').trim() || 'fortilink';
      const ports = expandPorts(str(values, 'ports', ''));
      const native = str(values, 'native_vlan', '').trim();
      const tagged = listOf(str(values, 'tagged_vlans', ''));
      const bpdu = bool(values, 'bpdu_guard', true);
      const findings            = [];
      if (!/^S[A-Z0-9]{15}$/.test(serial)) {
        findings.push(error('network.fortios.bad-switch-serial', `"${serial}" does not look like a FortiSwitch serial number (S followed by 15 letters and digits).`, { remediation: 'Copy it from `show switch-controller managed-switch` or the switch label.', source: 'ArchToolKit' }));
      }
      if (ports.length === 0) findings.push(error('network.fortios.no-switch-ports', 'No ports to assign.', { source: 'ArchToolKit' }));
      if (!native) findings.push(error('network.fortios.no-native-vlan', 'An access port needs a native VLAN.', { source: 'ArchToolKit' }));
      if (tagged.includes(native)) findings.push(error('network.fortios.native-also-tagged', `${native} is both the native VLAN and a tagged one on the same ports.`, { source: 'ArchToolKit' }));
      if (!bpdu) {
        findings.push(warning('network.fortios.no-bpdu-guard', 'Access ports without BPDU guard: a switch plugged in under a desk can join spanning tree, or loop the VLAN, and take the floor down.', { remediation: 'Keep BPDU guard on for every port a user can reach.', source: 'ArchToolKit' }));
      }
      if (ports.some((p) => /^(port(4[89]|5[0-9])|internal|mgmt)$/i.test(p))) {
        findings.push(warning('network.fortios.uplink-as-access', 'The list includes a port numbered like an uplink (port48 and up). Making the FortiLink uplink an access port cuts the switch off from the FortiGate.', { remediation: 'Check which port the switch uses for FortiLink in its topology (WiFi & Switch Controller > FortiSwitch Ports) and leave it out.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Authorise FortiSwitch ${serial} and assign ${ports.length} port${ports.length === 1 ? '' : 's'} to ${native}`,
        impact: 'brief',
        notes: [
          'The switch has to be discovered first (FortiLink up, allowaccess fabric): it appears in `show switch-controller managed-switch` with fsw-wan1-admin discovered. Authorising it may upgrade and reboot it.',
          `The VLAN interfaces (${[native, ...tagged].join(', ')}) have to exist on ${link} first — the FortiLink step.`,
          'Changing a port’s native VLAN moves whatever is plugged into it: it drops its address and has to get a new one. Do it with the people on those ports told.',
          'Every port listed gets the same assignment. Leave the uplinks and any AP or server ports out, or give them their own run of this change.',
        ],
        before: ['show switch-controller managed-switch', `show switch-controller managed-switch ${serial}`, 'execute switch-controller get-conn-status', `diagnose switch-controller switch-info port-stats ${serial}`],
        config: [
          'config switch-controller managed-switch',
          `    edit "${serial}"`,
          `        set description "${str(values, 'description', '').replace(/"/g, '')}"`,
          `        set fsw-wan1-peer "${link}"`,
          '        set fsw-wan1-admin enable',
          '        config ports',
          ...ports.flatMap((port) => [
            `            edit "${port}"`,
            `                set vlan "${native}"`,
            ...(tagged.length > 0 ? [`                set allowed-vlans ${tagged.map((v) => `"${v}"`).join(' ')}`] : []),
            `                set stp-bpdu-guard ${bpdu ? 'enabled' : 'disabled'}`,
            '            next',
          ]),
          '        end',
          '    next',
          'end',
        ],
        verify: [
          'execute switch-controller get-conn-status',
          `show switch-controller managed-switch ${serial}`,
          `diagnose switch-controller switch-info port-properties ${serial} ${ports[0] ?? 'port1'}`,
          'diagnose switch-controller switch-info mac-table',
          'Check a client on one of the ports gets an address in the native VLAN.',
        ],
        backout: [
          'config switch-controller managed-switch',
          `    edit "${serial}"`,
          '        config ports',
          ...ports.flatMap((port) => [`            edit "${port}"`, '                set vlan "_default"', ...(tagged.length > 0 ? ['                unset allowed-vlans'] : []), '            next']),
          '        end',
          '    next',
          'end',
          `# To remove the switch from management altogether: config switch-controller managed-switch / delete "${serial}" / end`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_fortiap',
    platform: PLATFORM,
    label: 'FortiAP: SSID, profile and authorised APs',
    group: 'Switching and wireless',
    description: 'An SSID (VAP), the FortiAP profile that puts it on both radios, and the APs authorised to use that profile — tunnelled to the FortiGate or bridged to the local VLAN.',
    inputs: [
      { id: 'vap', label: 'VAP name', control: 'text', default: 'CORP-WIFI', hint: 'At most 15 characters: it becomes an interface' },
      { id: 'ssid', label: 'SSID', control: 'text', default: 'CORP' },
      { id: 'security', label: 'Security', control: 'select', default: 'wpa2-only-enterprise', options: [
        { value: 'wpa2-only-enterprise', label: 'WPA2 Enterprise (802.1X)' },
        { value: 'wpa3-enterprise', label: 'WPA3 Enterprise' },
        { value: 'wpa2-only-personal', label: 'WPA2 Personal (PSK)' },
        { value: 'wpa3-sae', label: 'WPA3 Personal (SAE)' },
      ] },
      { id: 'radius_server', label: 'RADIUS server object', control: 'text', default: 'NPS-RADIUS', showWhen: { input: 'security', equals: ['wpa2-only-enterprise', 'wpa3-enterprise'] } },
      { id: 'mode', label: 'Traffic', control: 'select', default: 'tunnel', options: [
        { value: 'tunnel', label: 'Tunnel — to the FortiGate, which is the gateway' },
        { value: 'bridge', label: 'Bridge — onto the AP’s local VLAN' },
      ] },
      { id: 'vap_ip', label: 'SSID interface address', control: 'text', default: '10.50.0.1/24', showWhen: { input: 'mode', equals: ['tunnel'] } },
      { id: 'bridge_vlan', label: 'Local VLAN id', control: 'number', default: 50, min: 0, max: 4094, showWhen: { input: 'mode', equals: ['bridge'] } },
      { id: 'profile', label: 'FortiAP profile name', control: 'text', default: 'FAP431F-CORP' },
      { id: 'platform', label: 'FortiAP model', control: 'combo', default: '431F', options: [
        { value: '231F', label: 'FortiAP 231F' },
        { value: '431F', label: 'FortiAP 431F' },
        { value: '231G', label: 'FortiAP 231G' },
        { value: '431G', label: 'FortiAP 431G' },
      ] },
      { id: 'aps', label: 'AP serials to authorise', control: 'textarea', default: 'FP431FTF21000001 AP-FLOOR1-01\nFP431FTF21000002 AP-FLOOR1-02', hint: 'One per line: serial name' },
      { id: 'client_isolation', label: 'Block traffic between clients', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const vap = str(values, 'vap', 'CORP-WIFI').trim().replace(/\s+/g, '-');
      const ssid = str(values, 'ssid', 'CORP');
      const security = str(values, 'security', 'wpa2-only-enterprise');
      const enterprise = security.endsWith('enterprise');
      const radius = str(values, 'radius_server', '').trim();
      const tunnel = str(values, 'mode', 'tunnel') === 'tunnel';
      const vapIp = parseCidr(str(values, 'vap_ip', ''));
      const bridgeVlan = num(values, 'bridge_vlan', 50);
      const profile = str(values, 'profile', 'FAP-PROFILE').trim().replace(/\s+/g, '-');
      const model = str(values, 'platform', '431F').trim().toUpperCase();
      const aps = str(values, 'aps', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts[0])
        .map(([serial = '', apName = '']) => ({ serial: serial.toUpperCase(), name: apName }));
      const findings            = [];
      if (vap.length > 15) findings.push(error('network.fortios.vap-name-length', `The VAP name "${vap}" is longer than 15 characters. It becomes an interface, and interface names are limited to 15.`, { source: 'ArchToolKit' }));
      if (ssid.length === 0 || ssid.length > 32) findings.push(error('network.fortios.bad-ssid', 'An SSID is 1 to 32 characters.', { source: 'ArchToolKit' }));
      if (enterprise && !radius) findings.push(error('network.fortios.no-radius', 'An Enterprise SSID needs a RADIUS server object.', { source: 'ArchToolKit' }));
      if (!enterprise) {
        findings.push(warning('network.fortios.wifi-psk', 'A pre-shared key is shared by every device on the SSID: it cannot be revoked for one of them, and it leaves with anyone who leaves.', { remediation: 'Use Enterprise for anything but devices that cannot do 802.1X.', source: 'ArchToolKit' }));
      }
      if (security.startsWith('wpa3')) {
        findings.push(warning('network.fortios.wpa3-only', 'WPA3 on its own refuses older clients. Check every client type supports it before switching a production SSID.', { source: 'ArchToolKit' }));
      }
      if (tunnel && !vapIp) findings.push(error('network.fortios.bad-vap-ip', 'A tunnelled SSID is a FortiGate interface and needs an IPv4 address with a prefix.', { source: 'ArchToolKit' }));
      if (!tunnel && bridgeVlan === 0) {
        findings.push(warning('network.fortios.bridge-native', 'Bridged with VLAN 0 puts clients on the AP’s own native VLAN — usually the management VLAN the APs are on.', { remediation: 'Give the SSID its own VLAN and trunk it to the AP.', source: 'ArchToolKit' }));
      }
      const badAps = aps.filter((a) => !/^F[A-Z0-9]{15}$/.test(a.serial));
      if (badAps.length > 0) findings.push(error('network.fortios.bad-ap-serial', `Not a FortiAP serial number: ${badAps.map((a) => a.serial).join(', ')}.`, { remediation: 'FortiAP serials start with FP and are 16 characters: `show wireless-controller wtp` lists the discovered ones.', source: 'ArchToolKit' }));
      if (!/^[0-9]{3}[A-Z]$/.test(model)) findings.push(error('network.fortios.bad-ap-model', `"${model}" is not a FortiAP platform type such as 431F.`, { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `SSID ${ssid} (${tunnel ? 'tunnel' : `bridged to VLAN ${bridgeVlan}`}) on profile ${profile}, ${aps.length} AP${aps.length === 1 ? '' : 's'}`,
        impact: 'brief',
        notes: [
          'The APs reach the FortiGate over CAPWAP: the interface they come in on needs allowaccess fabric (FortiLink does). They appear under `show wireless-controller wtp` before they are authorised.',
          'Assigning a new profile to an AP that is already serving clients restarts its radios.',
          ...(enterprise ? [`The RADIUS server object ${radius} has to exist (config user radius), with the FortiGate added as a client on the RADIUS server.`] : [`The key is ${SECRET} in the file. Type it on the device, never into a file that is kept.`]),
          ...(tunnel
            ? ['A tunnelled SSID is an interface on the FortiGate: add a DHCP server on it and a firewall policy from it, or clients associate and go nowhere.']
            : [`Bridged traffic goes onto VLAN ${bridgeVlan} at the AP’s switch port, which has to be a trunk carrying it. The FortiGate does not see or filter it unless it routes that VLAN.`]),
          'Country and regulatory settings come from the FortiGate (config wireless-controller setting, or the profile on newer releases). Check them before the radios go live.',
        ],
        before: ['show wireless-controller vap', 'show wireless-controller wtp-profile', 'show wireless-controller wtp', 'get wireless-controller wtp-status'],
        config: [
          'config wireless-controller vap',
          `    edit "${vap}"`,
          `        set ssid "${ssid.replace(/"/g, '')}"`,
          `        set security ${security}`,
          ...(enterprise
            ? ['        set auth radius', `        set radius-server "${radius}"`]
            : security === 'wpa3-sae'
              ? [`        set sae-password ${SECRET}`]
              : [`        set passphrase ${SECRET}`]),
          '        set schedule "always"',
          ...(tunnel ? [] : ['        set local-bridging enable', ...(bridgeVlan > 0 ? [`        set vlanid ${bridgeVlan}`] : [])]),
          ...(bool(values, 'client_isolation', false) ? ['        set intra-vap-privacy enable'] : []),
          '    next',
          'end',
          ...(tunnel && vapIp
            ? ['config system interface', `    edit "${vap}"`, `        set ip ${ipMask(vapIp)}`, '        set allowaccess ping', '        set role lan', '    next', 'end']
            : []),
          'config wireless-controller wtp-profile',
          `    edit "${profile}"`,
          '        config platform',
          `            set type ${model}`,
          '        end',
          '        config radio-1',
          '            set band 802.11ax,n,g-only',
          '            set vap-all manual',
          `            set vaps "${vap}"`,
          '        end',
          '        config radio-2',
          '            set band 802.11ax-5G',
          '            set vap-all manual',
          `            set vaps "${vap}"`,
          '        end',
          '    next',
          'end',
          'config wireless-controller wtp',
          ...aps.flatMap((ap) => [`    edit "${ap.serial}"`, '        set admin enable', ...(ap.name ? [`        set name "${ap.name}"`] : []), `        set wtp-profile "${profile}"`, '    next']),
          'end',
        ],
        verify: [
          'get wireless-controller wtp-status',
          'diagnose wireless-controller wlac -c wtp',
          `diagnose wireless-controller wlac -c vap`,
          'get wireless-controller rf-analysis',
          'Associate a test client and check it gets an address and passes the policy.',
        ],
        backout: [
          'config wireless-controller wtp',
          ...aps.map((ap) => `    delete "${ap.serial}"`),
          'end',
          'config wireless-controller wtp-profile',
          `    delete "${profile}"`,
          'end',
          'config wireless-controller vap',
          `    delete "${vap}"`,
          'end',
          '# Delete any DHCP server and firewall policy that name the SSID interface first, or the VAP cannot be deleted.',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_ztna',
    platform: PLATFORM,
    label: 'ZTNA access proxy',
    group: 'VPN',
    description: 'Publish an internal application through the FortiGate’s ZTNA access proxy, open only to devices that present a FortiClient certificate and carry the EMS tag the rule asks for.',
    inputs: [
      { id: 'name', label: 'Name', control: 'text', default: 'ZTNA-INTRANET' },
      { id: 'external_ip', label: 'External address', control: 'text', default: '203.0.113.50' },
      { id: 'external_interface', label: 'External interface', control: 'text', default: 'port1' },
      { id: 'external_port', label: 'External port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'certificate', label: 'Server certificate on the FortiGate', control: 'text', default: 'ztna-intranet' },
      { id: 'service', label: 'Application type', control: 'select', default: 'https', options: [
        { value: 'https', label: 'HTTPS application' },
        { value: 'http', label: 'HTTP application (re-encrypted to the client)' },
        { value: 'tcp-forwarding', label: 'TCP forwarding (RDP, SSH through FortiClient)' },
      ] },
      { id: 'real_servers', label: 'Real servers', control: 'text', default: '10.20.30.40, 10.20.30.41' },
      { id: 'real_port', label: 'Real server port', control: 'number', default: 443, min: 1, max: 65535 },
      { id: 'client_cert', label: 'Require the FortiClient device certificate', control: 'toggle', default: true },
      { id: 'ems_tag', label: 'EMS tag the device must carry', control: 'text', default: 'EMS1_ZTNA_Corporate', hint: 'Empty for none' },
      { id: 'user_group', label: 'User group', control: 'text', default: '', hint: 'Empty for device-only' },
    ],
    change: (values                 )               => {
      const name = str(values, 'name', 'ZTNA').trim().replace(/\s+/g, '-');
      const extIp = str(values, 'external_ip', '').trim();
      const extIntf = str(values, 'external_interface', 'port1').trim();
      const cert = str(values, 'certificate', '').trim();
      const service = str(values, 'service', 'https');
      const servers = listOf(str(values, 'real_servers', ''));
      const realPort = num(values, 'real_port', 443);
      const clientCert = bool(values, 'client_cert', true);
      const tag = str(values, 'ems_tag', '').trim();
      const group = str(values, 'user_group', '').trim();
      const findings            = [];
      if (!isIpv4Address(extIp)) findings.push(error('network.fortios.bad-ztna-address', `The external address "${extIp}" is not an IPv4 address.`, { source: 'ArchToolKit' }));
      const badServers = servers.filter((s) => !isIp(s));
      if (badServers.length > 0 || servers.length === 0) findings.push(error('network.fortios.bad-real-server', servers.length === 0 ? 'No real servers.' : `Not an address: ${badServers.join(', ')}.`, { source: 'ArchToolKit' }));
      if (!cert) findings.push(error('network.fortios.ztna-no-cert', 'The access proxy needs a server certificate that already exists on the FortiGate.', { source: 'ArchToolKit' }));
      if (!clientCert) {
        findings.push(warning('network.fortios.ztna-no-client-cert', 'Without the client certificate the FortiGate cannot tell a managed device from any other: this is a reverse proxy, not zero trust.', { remediation: 'Require the certificate, and match an EMS tag.', source: 'ArchToolKit' }));
      }
      if (!tag) {
        findings.push(warning('network.fortios.ztna-no-tag', 'No EMS tag: any device with a FortiClient certificate from this EMS gets in, whatever its posture.', { remediation: 'Match a tag EMS assigns only to compliant devices.', source: 'ArchToolKit' }));
      }
      if (service === 'http' && realPort === 443) findings.push(warning('network.fortios.ztna-http-443', 'The application type is HTTP but the real server port is 443. The proxy would speak plain HTTP to an HTTPS port.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `ZTNA access proxy ${name} on ${extIp}:${num(values, 'external_port', 443)}`,
        impact: 'none',
        notes: [
          'The FortiGate has to be connected to FortiClient EMS (config endpoint-control fctems) and the EMS CA trusted, or no device presents a certificate it accepts and every request is refused.',
          'The EMS tag is defined in EMS (Zero Trust Tagging rules) and appears on the FortiGate once EMS shares it. The name here has to match what `diagnose endpoint record list` shows.',
          'Written for FortiOS 7.0 to 7.4, where a ZTNA rule is a proxy-policy with proxy access-proxy. On later releases ZTNA rules may live in the firewall policy table instead: check `config firewall policy` for ztna-status before pasting the last block.',
          'Clients reach the application by name: publish a DNS record for it that resolves to the external address, and a certificate on the proxy that matches that name.',
        ],
        before: ['show firewall vip', 'show firewall access-proxy', 'show firewall proxy-policy', 'show endpoint-control fctems', 'diagnose endpoint record list | head -40'],
        config: [
          'config firewall vip',
          `    edit "${name}"`,
          '        set type access-proxy',
          `        set extip ${extIp}`,
          `        set extintf "${extIntf}"`,
          '        set server-type https',
          `        set extport ${num(values, 'external_port', 443)}`,
          `        set ssl-certificate "${cert}"`,
          '    next',
          'end',
          'config firewall access-proxy',
          `    edit "${name}"`,
          `        set vip "${name}"`,
          `        set client-cert ${clientCert ? 'enable' : 'disable'}`,
          '        config api-gateway',
          '            edit 1',
          '                set url-map "/"',
          `                set service ${service}`,
          '                config realservers',
          ...servers.flatMap((server, i) => [`                    edit ${i + 1}`, `                        set ip ${server}`, `                        set port ${realPort}`, '                    next']),
          '                end',
          '            next',
          '        end',
          '    next',
          'end',
          'config firewall proxy-policy',
          '    edit 0',
          `        set name "${name}"`,
          '        set proxy access-proxy',
          `        set access-proxy "${name}"`,
          `        set srcintf "${extIntf}"`,
          '        set srcaddr "all"',
          '        set dstaddr "all"',
          ...(tag ? [`        set ztna-ems-tag "${tag}"`] : []),
          ...(group ? [`        set groups "${group}"`] : []),
          '        set action accept',
          '        set schedule "always"',
          '        set logtraffic all',
          '    next',
          'end',
        ],
        verify: [
          `show firewall access-proxy ${name}`,
          'diagnose endpoint record list',
          'diagnose wad dev query',
          `diagnose sniffer packet any 'host ${extIp} and port ${num(values, 'external_port', 443)}' 4 10`,
          'From a managed device carrying the tag, open the application; from one without it, confirm it is refused.',
        ],
        backout: [
          'config firewall proxy-policy',
          `    delete <the id of the "${name}" rule, from show firewall proxy-policy>`,
          'end',
          'config firewall access-proxy',
          `    delete "${name}"`,
          'end',
          'config firewall vip',
          `    delete "${name}"`,
          'end',
        ],
        findings,
      };
    },
  }),
];

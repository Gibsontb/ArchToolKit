/**
 * Aruba AOS-CX network changes (6000, 6100, 6300, 6400, 8100, 8300, 8325,
 * 8360, 8400, 9300 and 10000).
 *
 * AOS-CX reads like an industry-standard CLI, with its own words for the same
 * things: `vlan access` and `vlan trunk allowed` rather than `switchport`, a
 * `lag` rather than a port-channel, VSX for a redundant pair of chassis and
 * VSF for a stack. Ports on the access switches are layer 2 by default and on
 * the 8xxx core switches routed by default, so every blueprint says
 * `routing` or `no routing` rather than trusting the default.
 *
 * The switch has its own safety net for a change that could cut the session
 * off: `checkpoint auto <minutes>` rolls the running configuration back unless
 * `checkpoint auto confirm` follows. The riskier blueprints say to use it.
 *
 * This file holds the system, interface and switching changes; high
 * availability, routing, security and EVPN are in aoscx-extra.ts.
 */

import { bool, num, str, type BlueprintValues, type BlueprintGroup } from '../../kit/blueprint.ts';
import { info, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, isIpAny, listOf, parseCidrDual, vlanIds, vlanRange, type DeviceChange } from '../device.ts';
import { containsAny } from '../../core/ip.ts';
import { AOSCX_EXTRA } from './aoscx-extra.ts';
import { bad, CHECKPOINT, pairs, PLATFORM, portFindings, portList, SECRET, SOURCE, warn } from './aoscx-common.ts';

const MTU_MAX = 9198;

/** The VLAN lines for a layer 2 port or LAG. */
function vlanLines(trunk: boolean, access: number, native: number, allowed: string, tagNative: boolean): string[] {
  if (!trunk) return [`    vlan access ${access}`];
  return [`    vlan trunk native ${native}${tagNative ? ' tag' : ''}`, `    vlan trunk allowed ${allowed}`];
}

/** What is wrong with a trunk's VLANs, the way every trunk blueprint checks them. */
function trunkFindings(native: number, allowedText: string, allowed: number[]): Finding[] {
  const out: Finding[] = [];
  if (native === 1) {
    out.push(
      warn('native-vlan-1', 'The trunk uses VLAN 1 as its native VLAN: untagged frames, and anything a misconfigured neighbour sends, land in the default VLAN.', 'Use an unused parking VLAN as the native VLAN (for example 999), or tag the native VLAN.'),
    );
  }
  if (allowedText.trim().toLowerCase() === 'all') {
    out.push(warn('trunk-all-vlans', 'The trunk allows every VLAN, so every VLAN created later is carried here too and its broadcast domain reaches the neighbour.', 'List the VLANs the neighbour needs.'));
  } else if (allowed.length === 0) {
    out.push(bad('trunk-no-vlans', 'The trunk allows no valid VLAN, so it carries nothing tagged.', 'List VLAN ids as 10,20,30-32.'));
  }
  return out;
}

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  /* ------------------------------------------------------------------------ *
   * System
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_management_baseline',
    platform: PLATFORM,
    label: 'Management baseline',
    group: 'System',
    description: 'Hostname, NTP, DNS, syslog, and SSH and the REST API on the management VRF, optionally with the out-of-band management address.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'sw-access-01' },
      { id: 'vrf', label: 'Management VRF', control: 'select', default: 'mgmt', options: [{ value: 'mgmt', label: 'mgmt (out-of-band port)' }, { value: 'default', label: 'default (in-band)' }] },
      { id: 'mgmt_address', label: 'Management port address', control: 'text', default: '', hint: 'e.g. 10.0.0.21/24; empty to leave the management port as it is', showWhen: { input: 'vrf', equals: ['mgmt'] } },
      { id: 'mgmt_gateway', label: 'Management gateway', control: 'text', default: '', showWhen: { input: 'vrf', equals: ['mgmt'] } },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.53' },
      { id: 'domain', label: 'DNS domain', control: 'text', default: 'example.net' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20' },
      { id: 'timezone', label: 'Time zone', control: 'text', default: 'UTC', hint: 'An AOS-CX zone name, e.g. UTC, us/eastern, europe/london' },
      { id: 'rest', label: 'Enable the REST API (HTTPS)', control: 'toggle', default: true, hint: 'The pyaoscx-based Ansible modules and NetEdit use it' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vrf = str(values, 'vrf', 'mgmt');
      const oob = vrf === 'mgmt';
      const inVrf = ` vrf ${vrf}`;
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const dns = listOf(str(values, 'dns_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const domain = str(values, 'domain', '');
      const mgmtText = oob ? str(values, 'mgmt_address', '') : '';
      const mgmt = mgmtText ? parseCidrDual(mgmtText) : null;
      const gateway = oob ? str(values, 'mgmt_gateway', '') : '';
      const rest = bool(values, 'rest', true);
      const findings: Finding[] = [];
      for (const [what, list] of [['NTP server', ntp], ['DNS server', dns]] as const) {
        for (const server of list) if (!isIpAny(server)) findings.push(bad('bad-server', `The ${what} "${server}" is not an IP address.`, `AOS-CX takes a ${what} by address here.`));
      }
      if (ntp.length === 1) findings.push(warn('single-ntp', 'Only one NTP server: if it fails or drifts, nothing corrects the clock, and certificates, logs and 802.1X all depend on it.', 'Give it two or more servers.'));
      if (mgmtText && !mgmt) findings.push(bad('bad-mgmt-address', `The management address "${mgmtText}" is not an address and prefix.`, 'Write it as 10.0.0.21/24.'));
      if (mgmt && gateway && !containsAny(`${mgmt.network}/${mgmt.prefix}`, gateway)) {
        findings.push(bad('mgmt-gateway', `The gateway ${gateway} is not in the management subnet ${mgmt.network}/${mgmt.prefix}.`));
      }

      return {
        platform: PLATFORM,
        title: `Management baseline for ${str(values, 'hostname', 'switch')}`,
        impact: mgmt ? 'outage' : 'none',
        notes: [
          ...(mgmt ? ['Changing the management address drops the session made through it. Make this change from the console, or from an in-band address.', CHECKPOINT] : []),
          'The hostname is not backed out: `show running-config` from the capture step has the old one.',
        ],
        findings,
        before: ['show running-config', 'show ntp status', 'show ip dns', 'show logging -r -n 20', ...(oob ? ['show interface mgmt'] : [])],
        config: [
          `hostname ${str(values, 'hostname', 'switch')}`,
          `clock timezone ${str(values, 'timezone', 'UTC')}`,
          '!',
          ...(mgmt ? ['interface mgmt', '    no shutdown', `    ip static ${mgmt.address}/${mgmt.prefix}`, ...(gateway ? [`    default-gateway ${gateway}`] : []), '!'] : []),
          ...ntp.map((server) => `ntp server ${server} iburst`),
          ...(ntp.length > 0 ? ['ntp enable', `ntp vrf ${vrf}`] : []),
          ...(domain ? [`ip dns domain-name ${domain}${inVrf}`] : []),
          ...dns.map((server) => `ip dns server-address ${server}${inVrf}`),
          ...syslog.map((server) => `logging ${server} severity info${inVrf}`),
          '!',
          `ssh server${inVrf}`,
          ...(rest ? [`https-server vrf ${vrf}`, 'https-server rest access-mode read-write'] : []),
          '!',
        ],
        verify: ['show ntp status', 'show ntp associations', 'show ip dns', 'show logging -r -n 20', 'show ssh server all-vrfs', ...(rest ? ['show https-server'] : []), ...(mgmt ? ['show interface mgmt'] : [])],
        backout: [
          ...ntp.map((server) => `no ntp server ${server}`),
          ...(domain ? [`no ip dns domain-name ${domain}${inVrf}`] : []),
          ...dns.map((server) => `no ip dns server-address ${server}${inVrf}`),
          ...syslog.map((server) => `no logging ${server}${inVrf}`),
          ...(rest ? ['no https-server rest access-mode', `no https-server vrf ${vrf}`] : []),
          ...(mgmt ? ['interface mgmt', `    no ip static ${mgmt.address}/${mgmt.prefix}`, ...(gateway ? [`    no default-gateway ${gateway}`] : []), '!'] : []),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_snmp',
    platform: PLATFORM,
    label: 'SNMPv3 monitoring',
    group: 'System',
    description: 'An SNMPv3 user with authentication and privacy, the location and contact, and a trap receiver, on the management VRF.',
    inputs: [
      { id: 'user', label: 'SNMPv3 user', control: 'text', default: 'monitor' },
      { id: 'location', label: 'Location', control: 'text', default: 'DC1 row 4 rack 12' },
      { id: 'contact', label: 'Contact', control: 'text', default: 'noc@example.net' },
      { id: 'trap_hosts', label: 'Trap receivers', control: 'text', default: '10.0.0.60' },
      { id: 'vrf', label: 'VRF', control: 'select', default: 'mgmt', options: [{ value: 'mgmt', label: 'mgmt' }, { value: 'default', label: 'default' }] },
      { id: 'v2c', label: 'Also allow SNMPv2c (read-only community)', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const user = str(values, 'user', 'monitor');
      const vrf = str(values, 'vrf', 'mgmt');
      const traps = listOf(str(values, 'trap_hosts', ''));
      const v2c = bool(values, 'v2c', false);
      const findings: Finding[] = traps.filter((t) => !isIpAny(t)).map((t) => bad('bad-trap-host', `The trap receiver "${t}" is not an IP address.`));
      if (v2c) findings.push(warn('snmp-v2c', 'SNMPv2c sends its community in clear text, and anyone who captures it can read the whole MIB.', 'Use SNMPv3 only, unless a collector cannot do v3.'));
      return {
        platform: PLATFORM,
        title: `SNMPv3 user ${user}`,
        impact: 'none',
        notes: [`Replace every ${SECRET} with the SNMP pass phrases from your vault (8 characters or more).`],
        findings,
        before: ['show snmp vrf', 'show snmpv3 users', 'show snmp trap'],
        config: [
          `snmp-server vrf ${vrf}`,
          `snmp-server system-location ${description(str(values, 'location', ''), 'unknown')}`,
          `snmp-server system-contact ${description(str(values, 'contact', ''), 'unknown')}`,
          `snmpv3 user ${user} auth sha auth-pass plaintext ${SECRET} priv aes priv-pass plaintext ${SECRET}`,
          ...traps.map((host) => `snmp-server host ${host} trap version v3 user ${user}`),
          ...(v2c ? [`snmp-server community ${SECRET}`] : []),
          '!',
        ],
        verify: ['show snmp vrf', 'show snmpv3 users', 'show snmp trap', 'show snmp system'],
        backout: [
          ...traps.map((host) => `no snmp-server host ${host} trap version v3 user ${user}`),
          `no snmpv3 user ${user}`,
          ...(v2c ? [`no snmp-server community ${SECRET}`] : []),
          `no snmp-server vrf ${vrf}`,
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_tacacs',
    platform: PLATFORM,
    label: 'TACACS+ device administration',
    group: 'System',
    description: 'TACACS+ servers in a server group, used for login with a local fallback, and for accounting of what administrators do.',
    inputs: [
      { id: 'servers', label: 'TACACS+ servers', control: 'text', default: '10.0.0.40, 10.0.0.41' },
      { id: 'group', label: 'Server group', control: 'text', default: 'TACACS' },
      { id: 'vrf', label: 'VRF', control: 'select', default: 'mgmt', options: [{ value: 'mgmt', label: 'mgmt' }, { value: 'default', label: 'default' }] },
      { id: 'local_fallback', label: 'Fall back to local accounts', control: 'toggle', default: true, hint: 'Only when no server answers' },
      { id: 'authorization', label: 'Authorise commands', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const servers = listOf(str(values, 'servers', ''));
      const group = str(values, 'group', 'TACACS').replace(/\s+/g, '_');
      const vrf = str(values, 'vrf', 'mgmt');
      const local = bool(values, 'local_fallback', true);
      const authorization = bool(values, 'authorization', false);
      const findings: Finding[] = servers.filter((s) => !isIpAny(s)).map((s) => bad('bad-tacacs-server', `The TACACS+ server "${s}" is not an IP address.`));
      if (servers.length === 0) findings.push(bad('no-tacacs-server', 'No TACACS+ server is given, so login would rely on a group with nothing in it.'));
      if (servers.length === 1) findings.push(warn('single-tacacs', 'One TACACS+ server: when it is down, every login falls back to local accounts or fails.', 'Add a second server.'));
      if (!local) findings.push(warn('no-local-fallback', 'Without a local fallback, an unreachable TACACS+ server locks every administrator out except on the console.', 'Keep `local` after the group.'));
      return {
        platform: PLATFORM,
        title: `TACACS+ login through ${group}`,
        impact: 'brief',
        notes: [
          `Replace ${SECRET} with the shared key from your vault.`,
          'Keep this session open and test a new login before you disconnect.',
          CHECKPOINT,
        ],
        findings,
        before: ['show tacacs-server detail', 'show aaa authentication', 'show aaa server-groups', 'show user-list'],
        config: [
          ...servers.map((s) => `tacacs-server host ${s} key plaintext ${SECRET} vrf ${vrf}`),
          `aaa group server tacacs ${group}`,
          ...servers.map((s) => `    server ${s} vrf ${vrf}`),
          '!',
          `aaa authentication login default group ${group}${local ? ' local' : ''}`,
          ...(authorization ? [`aaa authorization commands default group ${group} none`] : []),
          `aaa accounting all-mgmt default start-stop group ${group}`,
          '!',
        ],
        verify: ['show tacacs-server detail', 'show aaa authentication', 'show aaa accounting', 'show accounting log all'],
        backout: [
          'no aaa authentication login default',
          ...(authorization ? ['no aaa authorization commands default'] : []),
          'no aaa accounting all-mgmt default',
          `no aaa group server tacacs ${group}`,
          ...servers.map((s) => `no tacacs-server host ${s} vrf ${vrf}`),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_qos_trust',
    platform: PLATFORM,
    label: 'QoS trust and voice priority',
    group: 'System',
    description: 'Which marking the switch trusts, globally and on the ports that should not be trusted, with an optional class and policy that puts voice in the priority queue.',
    inputs: [
      { id: 'trust', label: 'Global trust', control: 'select', default: 'dscp', options: [{ value: 'dscp', label: 'DSCP' }, { value: 'cos', label: 'CoS (802.1p)' }, { value: 'none', label: 'None' }] },
      { id: 'untrusted', label: 'Untrusted ports', control: 'text', default: '1/1/1-1/1/4', hint: 'Ports whose markings are reset: guest or unmanaged devices' },
      { id: 'voice', label: 'Prioritise voice (DSCP EF)', control: 'toggle', default: true },
      { id: 'voice_ports', label: 'Ports the voice policy applies to', control: 'text', default: '1/1/5-1/1/8', showWhen: { input: 'voice', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const trust = str(values, 'trust', 'dscp');
      const untrusted = portList(str(values, 'untrusted', ''));
      const voice = bool(values, 'voice', true);
      const voicePorts = voice ? portList(str(values, 'voice_ports', '')) : { ports: [], invalid: [] };
      const findings: Finding[] = [...portFindings('the untrusted ports', untrusted.invalid), ...portFindings('the voice ports', voicePorts.invalid)];
      if (voice && trust === 'none') findings.push(warn('voice-untrusted', 'Voice is classified by DSCP, but the switch trusts no marking: the policy still matches, the queue it lands in is set by the policy alone.'));
      return {
        platform: PLATFORM,
        title: `QoS trust ${trust}${voice ? ' with voice priority' : ''}`,
        impact: 'brief',
        notes: ['Changing trust re-queues traffic already flowing; expect a moment of reordering, not loss.'],
        findings,
        before: ['show qos trust', 'show running-config | include qos', ...(voice ? ['show class ip', 'show policy'] : [])],
        config: [
          `qos trust ${trust}`,
          '!',
          ...(voice
            ? ['class ip VOICE', '    10 match any any any dscp EF', '!', 'policy VOICE_PRIORITY', '    10 class ip VOICE action local-priority 7', '!']
            : []),
          ...untrusted.ports.flatMap((p) => [`interface ${p}`, '    qos trust none', '!']),
          ...voicePorts.ports.flatMap((p) => [`interface ${p}`, '    apply policy VOICE_PRIORITY in', '!']),
        ],
        verify: ['show qos trust', ...(untrusted.ports[0] ? [`show interface ${untrusted.ports[0]} qos`] : []), ...(voice ? ['show policy hitcounts VOICE_PRIORITY'] : [])],
        backout: [
          ...voicePorts.ports.flatMap((p) => [`interface ${p}`, '    no apply policy VOICE_PRIORITY in', '!']),
          ...untrusted.ports.flatMap((p) => [`interface ${p}`, '    no qos trust', '!']),
          ...(voice ? ['no policy VOICE_PRIORITY', 'no class ip VOICE'] : []),
          'no qos trust',
        ],
      };
    },
  }),

  /* ------------------------------------------------------------------------ *
   * Interfaces
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_access_port',
    platform: PLATFORM,
    label: 'Access port',
    group: 'Interfaces',
    description: 'User ports in a VLAN, with an optional voice VLAN, and the edge protections: admin-edge, BPDU guard and loop protection.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: '1/1/1-1/1/4', hint: '1/1/1, a range 1/1/1-1/1/24' },
      { id: 'vlan_id', label: 'Data VLAN', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'voice_vlan', label: 'Voice VLAN', control: 'number', default: 0, min: 0, max: 4094, hint: '0 for none' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'user access' },
      { id: 'edge', label: 'Edge port protections', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const { ports, invalid } = portList(str(values, 'ports', ''));
      const vlan = num(values, 'vlan_id', 10);
      const voice = num(values, 'voice_vlan', 0);
      const edge = bool(values, 'edge', true);
      const text = description(str(values, 'port_description', ''), 'access');
      const findings: Finding[] = portFindings('the ports', invalid);
      if (ports.length === 0 && invalid.length === 0) findings.push(bad('no-ports', 'No ports are given.'));
      if (vlan === 1) findings.push(warn('access-vlan-1', 'The ports are put in VLAN 1, the default VLAN every unconfigured port is already in.', 'Use a dedicated user VLAN.'));
      if (voice > 0 && voice === vlan) findings.push(bad('voice-equals-data', 'The voice VLAN is the data VLAN.'));
      const body = voice > 0 ? [`    vlan trunk native ${vlan}`, `    vlan trunk allowed ${vlanRange([vlan, voice])}`] : [`    vlan access ${vlan}`];
      return {
        platform: PLATFORM,
        title: `Access ports in VLAN ${vlan}${voice > 0 ? ` with voice VLAN ${voice}` : ''}`,
        impact: 'brief',
        notes: [
          ...(voice > 0
            ? [`AOS-CX carries a voice VLAN as a tagged VLAN on a port whose native VLAN is the data VLAN. VLAN ${voice} is marked \`voice\` so LLDP-MED advertises it to the phones.`]
            : []),
          'Each port flaps as it moves VLAN: whatever is connected re-requests its address.',
        ],
        findings,
        before: ['show vlan', 'show interface brief', ...ports.slice(0, 4).map((p) => `show running-config interface ${p}`)],
        config: [
          ...(voice > 0 ? [`vlan ${voice}`, '    voice', '!'] : []),
          ...ports.flatMap((p) => [
            `interface ${p}`,
            '    no shutdown',
            `    description ${text}`,
            '    no routing',
            ...body,
            ...(edge ? ['    spanning-tree port-type admin-edge', '    spanning-tree bpdu-guard', '    loop-protect'] : []),
            '!',
          ]),
        ],
        verify: ['show interface brief', `show vlan ${vlan}`, ...(edge ? ['show spanning-tree summary port', 'show loop-protect'] : []), ...(voice > 0 ? ['show lldp neighbor-info detail'] : [])],
        backout: [
          ...ports.flatMap((p) => [
            `interface ${p}`,
            ...(voice > 0 ? ['    no vlan trunk allowed', '    no vlan trunk native'] : [`    no vlan access ${vlan}`]),
            ...(edge ? ['    no spanning-tree port-type', '    no spanning-tree bpdu-guard', '    no loop-protect'] : []),
            '    no description',
            '!',
          ]),
          ...(voice > 0 ? [`vlan ${voice}`, '    no voice', '!'] : []),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_trunk_port',
    platform: PLATFORM,
    label: 'Trunk port',
    group: 'Interfaces',
    description: 'A layer 2 uplink or downlink carrying a list of VLANs, with a parking native VLAN.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: '1/1/49' },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '10,20,30', hint: '10,20,30-32, or all' },
      { id: 'native', label: 'Native VLAN', control: 'number', default: 999, min: 1, max: 4094 },
      { id: 'tag_native', label: 'Tag the native VLAN', control: 'toggle', default: false },
      { id: 'port_description', label: 'Description', control: 'text', default: 'uplink to distribution' },
      { id: 'root_guard', label: 'Root guard (downlinks only)', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const { ports, invalid } = portList(str(values, 'ports', ''));
      const allowedText = str(values, 'allowed', '');
      const all = allowedText.trim().toLowerCase() === 'all';
      const ids = all ? [] : vlanIds(allowedText);
      const allowed = all ? 'all' : vlanRange(ids);
      const native = num(values, 'native', 999);
      const tagNative = bool(values, 'tag_native', false);
      const rootGuard = bool(values, 'root_guard', false);
      const text = description(str(values, 'port_description', ''), 'trunk');
      const findings: Finding[] = [...portFindings('the ports', invalid), ...trunkFindings(native, allowedText, ids)];
      if (!all && !tagNative && !ids.includes(native)) {
        findings.push(info('network.aoscx.native-not-allowed', `Native VLAN ${native} is not in the allowed list, so untagged frames on this trunk are dropped. That is what a parking native VLAN is for; add it to the list if untagged traffic has to pass.`, { source: SOURCE }));
      }
      return {
        platform: PLATFORM,
        title: `Trunk on ${ports.join(', ') || 'ports'} carrying ${allowed || 'no VLANs'}`,
        impact: 'brief',
        notes: ['A trunk that loses a VLAN the other side still uses cuts that VLAN off. Compare the allowed list with the neighbour before changing it.'],
        findings,
        before: ['show vlan', 'show interface brief', ...ports.map((p) => `show running-config interface ${p}`), 'show lldp neighbor-info'],
        config: ports.flatMap((p) => [
          `interface ${p}`,
          '    no shutdown',
          `    description ${text}`,
          '    no routing',
          ...vlanLines(true, 0, native, allowed, tagNative),
          ...(rootGuard ? ['    spanning-tree root-guard'] : []),
          '!',
        ]),
        verify: ['show interface brief', ...ports.map((p) => `show vlan port ${p}`), 'show spanning-tree', 'show lldp neighbor-info'],
        backout: ports.flatMap((p) => [`interface ${p}`, '    no vlan trunk allowed', '    no vlan trunk native', ...(rootGuard ? ['    no spanning-tree root-guard'] : []), '    no description', '!']),
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_lag',
    platform: PLATFORM,
    label: 'LACP link aggregation (LAG)',
    group: 'Interfaces',
    description: 'A LAG with LACP active and its member ports, as a trunk or an access link. For a LAG split across a VSX pair, use the multi-chassis LAG.',
    inputs: [
      { id: 'lag_id', label: 'LAG id', control: 'number', default: 1, min: 1, max: 256 },
      { id: 'members', label: 'Member ports', control: 'text', default: '1/1/49, 1/1/50' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'trunk', options: [{ value: 'trunk', label: 'Trunk' }, { value: 'access', label: 'Access' }] },
      { id: 'allowed', label: 'Allowed VLANs', control: 'text', default: '10,20,30', showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'native', label: 'Native VLAN', control: 'number', default: 999, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['trunk'] } },
      { id: 'vlan_id', label: 'Access VLAN', control: 'number', default: 10, min: 1, max: 4094, showWhen: { input: 'mode', equals: ['access'] } },
      { id: 'rate', label: 'LACP rate', control: 'select', default: 'slow', options: [{ value: 'slow', label: 'Slow (30 s)' }, { value: 'fast', label: 'Fast (1 s)' }] },
      { id: 'port_description', label: 'Description', control: 'text', default: 'uplink LAG' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const lag = num(values, 'lag_id', 1);
      const { ports, invalid } = portList(str(values, 'members', ''));
      const trunk = str(values, 'mode', 'trunk') === 'trunk';
      const allowedText = trunk ? str(values, 'allowed', '') : '';
      const all = allowedText.trim().toLowerCase() === 'all';
      const ids = all ? [] : vlanIds(allowedText);
      const native = num(values, 'native', 999);
      const fast = str(values, 'rate', 'slow') === 'fast';
      const text = description(str(values, 'port_description', ''), `LAG ${lag}`);
      const findings: Finding[] = [...portFindings('the members', invalid), ...(trunk ? trunkFindings(native, allowedText, ids) : [])];
      if (ports.length === 0) findings.push(bad('lag-no-members', 'The LAG has no member ports.'));
      if (ports.length === 1) findings.push(warn('lag-single-member', 'The LAG has one member: it aggregates nothing and gives no redundancy.', 'Add a second member, ideally on another module or VSF member.'));
      return {
        platform: PLATFORM,
        title: `LAG ${lag} with ${ports.length} member(s)`,
        impact: 'brief',
        notes: [
          'The member ports lose their own configuration when they join the LAG: the LAG carries the VLANs.',
          'Both ends must run LACP; the far end must be configured before, or together with, this side.',
        ],
        findings,
        before: ['show lacp interfaces', 'show interface brief', ...ports.map((p) => `show running-config interface ${p}`)],
        config: [
          `interface lag ${lag}`,
          '    no shutdown',
          `    description ${text}`,
          '    no routing',
          ...vlanLines(trunk, num(values, 'vlan_id', 10), native, all ? 'all' : vlanRange(ids), false),
          '    lacp mode active',
          ...(fast ? ['    lacp rate fast'] : []),
          '!',
          ...ports.flatMap((p) => [`interface ${p}`, '    no shutdown', `    description ${text} member`, `    lag ${lag}`, '!']),
        ],
        verify: [`show lacp interfaces`, `show interface lag${lag}`, 'show lacp aggregates', 'show interface brief'],
        backout: [...ports.flatMap((p) => [`interface ${p}`, `    no lag ${lag}`, '    no description', '!']), `no interface lag ${lag}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_routed_port',
    platform: PLATFORM,
    label: 'Routed port',
    group: 'Interfaces',
    description: 'A port as a layer 3 point-to-point link: address, jumbo MTU, and optionally OSPF on it.',
    inputs: [
      { id: 'port', label: 'Port', control: 'text', default: '1/1/49' },
      { id: 'address', label: 'Address', control: 'text', default: '10.0.12.0/31', hint: 'IPv4, IPv6, or both comma separated: 10.0.12.0/31, 2001:db8:12::/127' },
      { id: 'jumbo', label: `Jumbo frames (MTU ${MTU_MAX})`, control: 'toggle', default: true },
      { id: 'ospf_area', label: 'OSPF area', control: 'text', default: '', hint: 'e.g. 0.0.0.0; empty for no OSPF on this link' },
      { id: 'port_description', label: 'Description', control: 'text', default: 'p2p to core-01' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const { ports, invalid } = portList(str(values, 'port', ''));
      const port = ports[0] ?? str(values, 'port', '1/1/1');
      const addresses = listOf(str(values, 'address', '')).map((a) => ({ text: a, cidr: parseCidrDual(a) }));
      const v4 = addresses.find((a) => a.cidr?.family === 4)?.cidr ?? null;
      const v6 = addresses.find((a) => a.cidr?.family === 6)?.cidr ?? null;
      const areaText = str(values, 'ospf_area', '');
      const jumbo = bool(values, 'jumbo', true);
      const findings: Finding[] = [...portFindings('the port', invalid), ...addresses.filter((a) => !a.cidr).map((a) => bad('bad-address', `"${a.text}" is not an address and prefix.`))];
      if (ports.length > 1) findings.push(warn('one-routed-port', 'A routed port takes one address: only the first port is configured.'));
      if (!v4 && !v6) findings.push(bad('no-address', 'The routed port has no valid address.'));
      if (v4 && v4.prefix < 30) findings.push(warn('p2p-prefix', `A /${v4.prefix} on a point-to-point link wastes addresses and invites a third device onto it.`, 'Use a /31.'));
      return {
        platform: PLATFORM,
        title: `Routed port ${port}`,
        impact: 'brief',
        notes: ['`routing` removes the port from every VLAN. Check nothing layer 2 depends on it first.', ...(jumbo ? ['The MTU has to match on both ends, or OSPF stays in ExStart.'] : [])],
        findings,
        before: [`show running-config interface ${port}`, `show interface ${port}`, 'show ip interface brief'],
        config: [
          `interface ${port}`,
          '    no shutdown',
          `    description ${description(str(values, 'port_description', ''), 'routed link')}`,
          '    routing',
          ...(jumbo ? [`    mtu ${MTU_MAX}`, `    ip mtu ${MTU_MAX}`] : []),
          ...(v4 ? [`    ip address ${v4.address}/${v4.prefix}`] : []),
          ...(v6 ? [`    ipv6 address ${v6.address}/${v6.prefix}`] : []),
          ...(areaText ? [`    ip ospf 1 area ${areaText}`, '    ip ospf network point-to-point'] : []),
          '!',
        ],
        verify: [`show interface ${port}`, 'show ip interface brief', ...(v6 ? ['show ipv6 interface brief'] : []), ...(areaText ? ['show ip ospf neighbors'] : [])],
        backout: [
          `interface ${port}`,
          ...(areaText ? [`    no ip ospf 1 area ${areaText}`, '    no ip ospf network'] : []),
          ...(v4 ? [`    no ip address ${v4.address}/${v4.prefix}`] : []),
          ...(v6 ? [`    no ipv6 address ${v6.address}/${v6.prefix}`] : []),
          ...(jumbo ? ['    no ip mtu', '    no mtu'] : []),
          '    no description',
          '!',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_loopback',
    platform: PLATFORM,
    label: 'Loopback interface',
    group: 'Interfaces',
    description: 'A loopback for the router id, BGP sessions or a VTEP source, optionally in a VRF and in OSPF.',
    inputs: [
      { id: 'loopback_id', label: 'Loopback id', control: 'number', default: 0, min: 0, max: 255 },
      { id: 'address', label: 'Address', control: 'text', default: '10.255.0.11/32' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the default VRF' },
      { id: 'ospf_area', label: 'OSPF area', control: 'text', default: '0.0.0.0', hint: 'Empty to leave it out of OSPF' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'loopback_id', 0);
      const text = str(values, 'address', '');
      const cidr = parseCidrDual(text);
      const vrf = str(values, 'vrf', '');
      const area = str(values, 'ospf_area', '');
      const findings: Finding[] = [];
      if (!cidr) findings.push(bad('bad-address', `"${text}" is not an address and prefix.`));
      if (cidr && cidr.prefix !== (cidr.family === 4 ? 32 : 128)) findings.push(warn('loopback-prefix', `A loopback is normally a host route; /${cidr.prefix} advertises a whole subnet from one switch.`));
      const family = cidr?.family === 6 ? 'ipv6' : 'ip';
      return {
        platform: PLATFORM,
        title: `Loopback ${id} ${text}`,
        impact: 'none',
        findings,
        before: ['show interface loopback brief', 'show ip interface brief'],
        config: [
          `interface loopback ${id}`,
          ...(vrf ? [`    vrf attach ${vrf}`] : []),
          ...(cidr ? [`    ${family} address ${cidr.address}/${cidr.prefix}`] : []),
          ...(area && cidr?.family === 4 ? [`    ip ospf 1 area ${area}`] : []),
          '!',
        ],
        verify: [`show interface loopback${id}`, `show ${family} interface brief${vrf ? ` vrf ${vrf}` : ''}`, ...(area ? ['show ip ospf interface brief'] : [])],
        backout: [`no interface loopback ${id}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_poe',
    platform: PLATFORM,
    label: 'Power over Ethernet',
    group: 'Interfaces',
    description: 'PoE priority and allocation on ports feeding access points, phones or cameras, so the important ones keep power when the budget runs short.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: '1/1/41-1/1/44' },
      { id: 'priority', label: 'Priority', control: 'select', default: 'high', options: [{ value: 'critical', label: 'Critical' }, { value: 'high', label: 'High' }, { value: 'low', label: 'Low (default)' }] },
      { id: 'allocate', label: 'Allocate by', control: 'select', default: 'usage', options: [{ value: 'usage', label: 'Usage (default)' }, { value: 'class', label: 'Class' }] },
      { id: 'enabled', label: 'Power enabled', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const { ports, invalid } = portList(str(values, 'ports', ''));
      const priority = str(values, 'priority', 'high');
      const allocate = str(values, 'allocate', 'usage');
      const enabled = bool(values, 'enabled', true);
      const findings: Finding[] = portFindings('the ports', invalid);
      if (!enabled) findings.push(warn('poe-off', 'Power is turned off on these ports: whatever they feed goes down now.'));
      return {
        platform: PLATFORM,
        title: `PoE ${enabled ? `priority ${priority}` : 'off'} on ${ports.length} port(s)`,
        impact: enabled ? 'none' : 'outage',
        notes: ['Allocating by class reserves the class maximum for each device, which runs the budget out sooner but never takes power from a device already on.'],
        findings,
        before: ['show power-over-ethernet', 'show power-over-ethernet brief'],
        config: ports.flatMap((p) => [
          `interface ${p}`,
          ...(enabled ? ['    power-over-ethernet', `    power-over-ethernet priority ${priority}`, `    power-over-ethernet allocate-by ${allocate}`] : ['    no power-over-ethernet']),
          '!',
        ]),
        verify: ['show power-over-ethernet brief', ...(ports[0] ? [`show power-over-ethernet ${ports[0]}`] : [])],
        backout: ports.flatMap((p) => [`interface ${p}`, ...(enabled ? ['    no power-over-ethernet priority', '    no power-over-ethernet allocate-by'] : ['    power-over-ethernet']), '!']),
      };
    },
  }),

  /* ------------------------------------------------------------------------ *
   * Switching
   * ------------------------------------------------------------------------ */
  deviceBlueprint({
    id: 'aoscx_vlans',
    platform: PLATFORM,
    label: 'VLANs',
    group: 'Switching',
    description: 'Create a set of VLANs with names. Nothing is carried until a port or LAG allows them.',
    inputs: [{ id: 'vlans', label: 'VLANs', control: 'textarea', default: '10=USERS\n20=VOICE\n30=PRINTERS', hint: 'One per line or comma separated: id=NAME' }],
    change: (values: BlueprintValues): DeviceChange => {
      const entries = pairs(str(values, 'vlans', '').replace(/\n/g, ','));
      const findings: Finding[] = [];
      const vlans: { id: number; name: string }[] = [];
      for (const { key, value } of entries) {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 1 || id > 4094) {
          findings.push(bad('bad-vlan', `"${key}" is not a VLAN id from 1 to 4094.`));
          continue;
        }
        if (vlans.some((v) => v.id === id)) {
          findings.push(bad('duplicate-vlan', `VLAN ${id} is listed twice.`));
          continue;
        }
        if (id === 1) findings.push(warn('vlan-1', 'VLAN 1 always exists and cannot be removed; renaming it is all this does.'));
        vlans.push({ id, name: (value || `VLAN${id}`).replace(/\s+/g, '_').slice(0, 32) });
      }
      if (vlans.length === 0) findings.push(bad('no-vlans', 'No VLANs are given.'));
      const ids = vlans.map((v) => v.id);
      return {
        platform: PLATFORM,
        title: `VLANs ${vlanRange(ids) || '(none)'}`,
        impact: 'none',
        findings,
        before: ['show vlan'],
        config: vlans.flatMap((v) => [`vlan ${v.id}`, `    name ${v.name}`, '!']),
        verify: ['show vlan', ...ids.slice(0, 4).map((id) => `show vlan ${id}`)],
        backout: ids.filter((id) => id !== 1).map((id) => `no vlan ${id}`),
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_svi',
    platform: PLATFORM,
    label: 'VLAN interface (SVI)',
    group: 'Switching',
    description: 'A routed VLAN interface with an address, optionally in a VRF. For a gateway shared across a VSX pair, add the active gateway.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN id', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'vlan_name', label: 'VLAN name', control: 'text', default: 'USERS' },
      { id: 'address', label: 'Address', control: 'text', default: '10.1.10.2/24', hint: 'IPv4, IPv6, or both comma separated' },
      { id: 'vrf', label: 'VRF', control: 'text', default: '', hint: 'Empty for the default VRF' },
      { id: 'jumbo', label: 'Jumbo IP MTU', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'vlan_id', 10);
      const name = str(values, 'vlan_name', `VLAN${id}`).replace(/\s+/g, '_');
      const addresses = listOf(str(values, 'address', '')).map((a) => ({ text: a, cidr: parseCidrDual(a) }));
      const v4 = addresses.find((a) => a.cidr?.family === 4)?.cidr ?? null;
      const v6 = addresses.find((a) => a.cidr?.family === 6)?.cidr ?? null;
      const vrf = str(values, 'vrf', '');
      const jumbo = bool(values, 'jumbo', false);
      const findings: Finding[] = addresses.filter((a) => !a.cidr).map((a) => bad('bad-address', `"${a.text}" is not an address and prefix.`));
      if (!v4 && !v6) findings.push(bad('no-address', 'The VLAN interface has no valid address.'));
      if (v4 && v4.address === v4.network && v4.prefix < 31) findings.push(bad('network-address', `${v4.address} is the network address of its subnet, not a host address.`));
      return {
        platform: PLATFORM,
        title: `VLAN ${id} (${name}) interface`,
        impact: 'none',
        notes: vrf ? [`VRF ${vrf} has to exist first. \`vrf attach\` clears any address already on the interface, which is why it comes before the address.`] : [],
        findings,
        before: [`show vlan ${id}`, `show running-config interface vlan${id}`, 'show ip interface brief'],
        config: [
          `vlan ${id}`,
          `    name ${name}`,
          '!',
          `interface vlan ${id}`,
          `    description ${name}`,
          ...(vrf ? [`    vrf attach ${vrf}`] : []),
          ...(v4 ? [`    ip address ${v4.address}/${v4.prefix}`] : []),
          ...(v6 ? [`    ipv6 address ${v6.address}/${v6.prefix}`] : []),
          ...(jumbo ? [`    ip mtu ${MTU_MAX}`] : []),
          '    no shutdown',
          '!',
        ],
        verify: [`show interface vlan${id}`, `show ip interface brief${vrf ? ` vrf ${vrf}` : ''}`, ...(v6 ? ['show ipv6 interface brief'] : [])],
        backout: [`no interface vlan ${id}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_spanning_tree',
    platform: PLATFORM,
    label: 'Spanning tree',
    group: 'Switching',
    description: 'MSTP or Rapid PVST+, the bridge priority that decides the root, and the edge and root-guard protections on ports.',
    inputs: [
      { id: 'mode', label: 'Mode', control: 'select', default: 'mstp', options: [{ value: 'mstp', label: 'MSTP (default)' }, { value: 'rpvst', label: 'Rapid PVST+' }] },
      { id: 'priority', label: 'Priority multiplier', control: 'number', default: 8, min: 0, max: 15, hint: 'x 4096: 0 for the root, 1 for the backup root, 8 is the default' },
      { id: 'region', label: 'MST region name', control: 'text', default: 'CAMPUS', showWhen: { input: 'mode', equals: ['mstp'] } },
      { id: 'revision', label: 'MST revision', control: 'number', default: 1, min: 0, max: 65535, showWhen: { input: 'mode', equals: ['mstp'] } },
      { id: 'vlans', label: 'VLANs', control: 'text', default: '10,20,30', showWhen: { input: 'mode', equals: ['rpvst'] } },
      { id: 'edge_ports', label: 'Edge ports (BPDU guard)', control: 'text', default: '1/1/1-1/1/24' },
      { id: 'root_guard_ports', label: 'Root guard ports', control: 'text', default: '', hint: 'Downlinks to switches that must never become root' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const mode = str(values, 'mode', 'mstp');
      const priority = num(values, 'priority', 8);
      const edge = portList(str(values, 'edge_ports', ''));
      const guard = portList(str(values, 'root_guard_ports', ''));
      const vlans = vlanRange(vlanIds(str(values, 'vlans', '')));
      const findings: Finding[] = [...portFindings('the edge ports', edge.invalid), ...portFindings('the root guard ports', guard.invalid)];
      for (const p of edge.ports.filter((x) => guard.ports.includes(x))) findings.push(warn('edge-and-root-guard', `${p} is both an edge port and a root-guard port; an edge port should face a host, a root-guard port a switch.`));
      if (mode === 'rpvst' && !vlans) findings.push(bad('rpvst-no-vlans', 'Rapid PVST+ needs the VLANs it runs on.'));
      if (priority === 8) findings.push(info('network.aoscx.stp-default-priority', 'The bridge priority is left at the default, so the root is chosen by the lowest MAC. Set 0 on the intended root and 1 on its backup.', { source: SOURCE }));
      const prio = mode === 'rpvst' ? `spanning-tree vlan ${vlans} priority ${priority}` : `spanning-tree priority ${priority}`;
      return {
        platform: PLATFORM,
        title: `Spanning tree ${mode} priority ${priority * 4096}`,
        impact: 'brief',
        notes: ['A change of mode or of the root reconverges the whole layer 2 domain. Do it in a window.', 'The mode is not backed out: the capture step records what it was.'],
        findings,
        before: ['show spanning-tree', 'show spanning-tree summary root', ...(mode === 'mstp' ? ['show spanning-tree mst-config'] : [])],
        config: [
          `spanning-tree mode ${mode}`,
          'spanning-tree',
          ...(mode === 'mstp' ? [`spanning-tree config-name ${str(values, 'region', 'CAMPUS')}`, `spanning-tree config-revision ${num(values, 'revision', 1)}`] : []),
          prio,
          '!',
          ...edge.ports.flatMap((p) => [`interface ${p}`, '    spanning-tree port-type admin-edge', '    spanning-tree bpdu-guard', '!']),
          ...guard.ports.flatMap((p) => [`interface ${p}`, '    spanning-tree root-guard', '!']),
        ],
        verify: ['show spanning-tree', 'show spanning-tree summary root', 'show spanning-tree summary port', ...(mode === 'mstp' ? ['show spanning-tree mst-config'] : [])],
        backout: [
          ...edge.ports.flatMap((p) => [`interface ${p}`, '    no spanning-tree port-type', '    no spanning-tree bpdu-guard', '!']),
          ...guard.ports.flatMap((p) => [`interface ${p}`, '    no spanning-tree root-guard', '!']),
          `no ${prio}`,
          ...(mode === 'mstp' ? ['no spanning-tree config-name', 'no spanning-tree config-revision'] : []),
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_loop_protect_lldp',
    platform: PLATFORM,
    label: 'Loop protection and LLDP',
    group: 'Switching',
    description: 'Loop protection on access ports, which catches the loops spanning tree cannot see (an unmanaged switch that eats BPDUs), and LLDP for neighbour discovery.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'text', default: '1/1/1-1/1/24' },
      { id: 'vlans', label: 'VLANs to protect', control: 'text', default: '10,20', hint: 'Empty for the port’s untagged VLAN only' },
      { id: 'action', label: 'Action on a loop', control: 'select', default: 'tx-disable', options: [{ value: 'tx-disable', label: 'Disable the port' }, { value: 'tx-rx-disable', label: 'Disable send and receive' }, { value: 'do-not-disable', label: 'Log only' }] },
      { id: 'reenable', label: 'Re-enable after (seconds)', control: 'number', default: 300, min: 0, max: 604800, hint: '0 to leave the port down until someone enables it' },
      { id: 'lldp', label: 'Enable LLDP', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const { ports, invalid } = portList(str(values, 'ports', ''));
      const vlans = vlanRange(vlanIds(str(values, 'vlans', '')));
      const action = str(values, 'action', 'tx-disable');
      const reenable = num(values, 'reenable', 300);
      const lldp = bool(values, 'lldp', true);
      const findings: Finding[] = portFindings('the ports', invalid);
      if (action === 'do-not-disable') findings.push(warn('loop-log-only', 'Loop protection only logs: a loop it detects keeps melting the VLAN.'));
      return {
        platform: PLATFORM,
        title: `Loop protection on ${ports.length} port(s)`,
        impact: 'none',
        findings,
        before: ['show loop-protect', 'show lldp configuration'],
        config: [
          ...(lldp ? ['lldp'] : []),
          ...(reenable > 0 ? [`loop-protect re-enable-timer ${reenable}`] : []),
          ...ports.flatMap((p) => [`interface ${p}`, '    loop-protect', ...(vlans ? [`    loop-protect vlan ${vlans}`] : []), `    loop-protect action ${action}`, '!']),
        ],
        verify: ['show loop-protect', ...(lldp ? ['show lldp configuration', 'show lldp neighbor-info'] : [])],
        backout: [...ports.flatMap((p) => [`interface ${p}`, '    no loop-protect', '!']), ...(reenable > 0 ? ['no loop-protect re-enable-timer'] : [])],
      };
    },
  }),

  deviceBlueprint({
    id: 'aoscx_dhcp_relay',
    platform: PLATFORM,
    label: 'DHCP relay',
    group: 'Switching',
    description: 'Relay DHCP requests from a VLAN interface to the DHCP servers, optionally with option 82.',
    inputs: [
      { id: 'vlan_id', label: 'VLAN interface', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'servers', label: 'DHCP servers', control: 'text', default: '10.0.0.50, 10.0.0.51' },
      { id: 'server_vrf', label: 'Server VRF', control: 'text', default: '', hint: 'Only when the servers are in another VRF from the VLAN interface' },
      { id: 'option82', label: 'Insert option 82', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlan = num(values, 'vlan_id', 10);
      const servers = listOf(str(values, 'servers', ''));
      const vrf = str(values, 'server_vrf', '');
      const option82 = bool(values, 'option82', false);
      const findings: Finding[] = servers.filter((s) => !isIpAny(s)).map((s) => bad('bad-dhcp-server', `The DHCP server "${s}" is not an IP address.`));
      if (servers.length === 0) findings.push(bad('no-dhcp-server', 'No DHCP server is given.'));
      if (servers.length === 1) findings.push(warn('single-dhcp-server', 'One DHCP server: when it is down, nothing on this VLAN gets an address.'));
      const helper = (s: string) => `${s.includes(':') ? 'ipv6 helper-address unicast' : 'ip helper-address'} ${s}${vrf ? ` vrf ${vrf}` : ''}`;
      return {
        platform: PLATFORM,
        title: `DHCP relay on VLAN ${vlan}`,
        impact: 'none',
        findings,
        before: [`show running-config interface vlan${vlan}`, 'show dhcp-relay'],
        config: [
          ...(option82 ? ['dhcp-relay option 82 replace validate', '!'] : []),
          `interface vlan ${vlan}`,
          ...servers.map((s) => `    ${helper(s)}`),
          '!',
        ],
        verify: ['show dhcp-relay', `show ip helper-address interface vlan${vlan}`],
        backout: [`interface vlan ${vlan}`, ...servers.map((s) => `    no ${helper(s)}`), '!', ...(option82 ? ['no dhcp-relay option 82'] : [])],
      };
    },
  }),
];

const ALL: readonly ChangeBlueprint[] = [...BLUEPRINTS, ...AOSCX_EXTRA];

export const AOSCX_NETWORK: BlueprintGroup = {
  target: PLATFORM,
  label: 'Aruba AOS-CX',
  blueprints: ALL,
};

export const AOSCX_CHANGES: readonly ChangeBlueprint[] = ALL;

/**
 * Hand-written network playbooks: the multi-task plays a network engineer
 * actually runs — VLANs and ports, a device baseline, ACLs, routing, backups,
 * fact reports — for Cisco IOS / NX-OS / IOS XR, Arista EOS, VyOS, FortiOS,
 * F5 BIG-IP, Check Point, Infoblox and NetBox.
 *
 * CLI platforms connect with network_cli, the API ones with httpapi (or local
 * for F5, Infoblox and NetBox, whose modules make the REST calls themselves).
 * Passwords and tokens are always vault_ variables, listed in group_vars.
 */

import type { Blueprint, BlueprintInput, SelectOption, TemplateValues } from '../../kit/blueprint.ts';
import type { YamlValue } from '../yaml.ts';
import { items, on, pairs, playbookScenario } from './scenario.ts';

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Lines of `a | b | c` as trimmed columns; blank and # lines skipped. */
function rows(value: unknown): string[][] {
  return String(value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('|').map((c) => c.trim()));
}

/** 10.1.0.0/16 → address, prefix length, dotted mask and wildcard. */
function prefix(cidr: string): { address: string; len: number; mask: string; wildcard: string } {
  const [address = '', lenRaw] = cidr.trim().split('/');
  const len = lenRaw === undefined || lenRaw === '' ? 32 : Math.max(0, Math.min(32, Number(lenRaw)));
  const bits = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  const dotted = (n: number): string => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  return { address, len, mask: dotted(bits), wildcard: dotted(~bits >>> 0) };
}

const isIp = (s: string): boolean => /^[0-9a-fA-F:.]+$/.test(s) && /[.:]/.test(s);

/** Drop undefined keys (recursively) so the YAML carries only what was set. */
function compact(value: unknown): YamlValue {
  if (Array.isArray(value)) return value.map(compact) as YamlValue;
  if (value && typeof value === 'object') {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) if (v !== undefined) out[k] = compact(v);
    return out as YamlValue;
  }
  return value as YamlValue;
}

/** `10=users` lines as VLAN id + name. */
function vlanList(value: unknown): { vlan_id: number; name?: string }[] {
  return pairs(value)
    .filter(([id]) => /^\d+$/.test(id))
    .map(([id, name]) => ({ vlan_id: Number(id), name: name || undefined }));
}

interface Port {
  name: string;
  mode: 'access' | 'trunk';
  vlans: string[];
  description?: string;
  native?: number;
}

/** `Gi1/0/1 | access | 10 | Desk port` / `Gi1/0/48 | trunk | 10,20,30 | Uplink | 99`. */
function portList(value: unknown): Port[] {
  return rows(value).map(([name = '', mode = 'access', vlans = '', description = '', native = '']) => ({
    name,
    mode: mode.toLowerCase() === 'trunk' ? 'trunk' : 'access',
    vlans: items(vlans),
    description: description || undefined,
    native: /^\d+$/.test(native) ? Number(native) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Shared inputs and play pieces
// ---------------------------------------------------------------------------

const opts = (...values: string[]): SelectOption[] => values.map((v) => ({ value: v, label: v }));

const USER: BlueprintInput = {
  id: 'username',
  label: 'Device user',
  control: 'text',
  default: 'netadmin',
  hint: 'Password is vault_network_password',
};

const ENABLE: BlueprintInput = {
  id: 'enable_mode',
  label: 'Enter enable mode',
  control: 'toggle',
  default: true,
  help: 'Become privileged (enable) before configuring; the enable secret is vault_enable_password.',
};

const SAVE: BlueprintInput = {
  id: 'save_config',
  label: 'Save to startup-config',
  control: 'toggle',
  default: true,
  help: 'Resource modules change the running configuration only; this copies it to startup when it changed.',
};

const STATE_HELP =
  'merged adds to what is there; replaced makes each listed item exactly this; overridden also removes every item not listed; deleted removes the listed items.';

function stateInput(id = 'state', label = 'State', choices = ['merged', 'replaced', 'overridden', 'deleted']): BlueprintInput {
  return { id, label, control: 'select', options: opts(...choices), default: 'merged', help: STATE_HELP };
}

const LOG_LEVELS = opts('emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging');

/** Play vars for a network_cli device. */
function cliVars(os: string, v: TemplateValues, enable: 'password' | 'plain' | 'none' = 'none'): Obj {
  const vars: Obj = {
    ansible_connection: 'ansible.netcommon.network_cli',
    ansible_network_os: os,
    ansible_user: v.username,
    ansible_password: '{{ vault_network_password }}',
  };
  if (enable !== 'none' && on(v.enable_mode)) {
    vars.ansible_become = true;
    vars.ansible_become_method = 'enable';
    if (enable === 'password') vars.ansible_become_password = '{{ vault_enable_password }}';
  }
  return vars;
}

function cliNeeds(v: TemplateValues, enablePassword = false): Record<string, string> {
  const needs: Record<string, string> = { vault_network_password: 'Password of the device user' };
  if (enablePassword && on(v.enable_mode)) needs.vault_enable_password = 'Enable secret';
  return needs;
}

function play(name: string, hosts: string, vars: Obj, tasks: Obj[]): Obj {
  return { name, hosts, gather_facts: false, vars, tasks };
}

function saveTask(module: string, v: TemplateValues): Obj[] {
  if (!on(v.save_config)) return [];
  return [{ name: 'Save the running configuration to startup', [module]: { save_when: 'modified' } }];
}

// ---------------------------------------------------------------------------
// Cisco IOS
// ---------------------------------------------------------------------------

const IOS = 'Playbooks · Cisco IOS';
const IOS_OS = 'cisco.ios.ios';

const VLANS_INPUT: BlueprintInput = {
  id: 'vlans',
  label: 'VLANs',
  control: 'textarea',
  default: '10=users\n20=voice\n30=printers\n99=management',
  hint: 'One per line: id=name',
};

const PORTS_INPUT = (first: string, uplink: string): BlueprintInput => ({
  id: 'ports',
  label: 'Ports',
  control: 'textarea',
  default: `${first}1 | access | 10 | Desk port\n${first}2 | access | 10 | Desk port\n${uplink} | trunk | 10,20,30,99 | Uplink to core | 99`,
  hint: 'name | access or trunk | VLAN(s) | description | native VLAN (trunks)',
});

const IOS_VLANS = playbookScenario({
  id: 'net_ios_vlans',
  label: 'Cisco IOS – VLANs',
  group: IOS,
  description: 'Create, rename or remove VLANs on Catalyst switches with the ios_vlans resource module, then save.',
  inputs: [VLANS_INPUT, stateInput(), USER, ENABLE, SAVE],
  plays: (v) =>
    compact([
      play('Configure VLANs', 'ios', cliVars(IOS_OS, v, 'password'), [
        { name: 'VLANs', 'cisco.ios.ios_vlans': { config: vlanList(v.vlans), state: v.state } },
        ...saveTask('cisco.ios.ios_config', v),
      ]),
    ]),
  needs: (v) => cliNeeds(v, true),
});

const IOS_PORTS = playbookScenario({
  id: 'net_ios_access_trunk_ports',
  label: 'Cisco IOS – Access and trunk ports',
  group: IOS,
  description: 'Describe and enable switch ports, then make each an access port in a VLAN or a trunk carrying a VLAN list.',
  inputs: [
    PORTS_INPUT('GigabitEthernet1/0/', 'GigabitEthernet1/0/48'),
    { id: 'voice_vlan', label: 'Voice VLAN on access ports', control: 'text', default: '', placeholder: 'e.g. 20', hint: 'Blank for none' },
    { id: 'bpduguard', label: 'BPDU guard on access ports', control: 'toggle', default: true },
    stateInput(),
    USER,
    ENABLE,
    SAVE,
  ],
  plays: (v) => {
    const ports = portList(v.ports);
    const voice = /^\d+$/.test(String(v.voice_vlan ?? '').trim()) ? Number(v.voice_vlan) : undefined;
    return compact([
      play('Configure switch ports', 'ios', cliVars(IOS_OS, v, 'password'), [
        {
          name: 'Port description and admin state',
          'cisco.ios.ios_interfaces': {
            config: ports.map((p) => ({ name: p.name, description: p.description, enabled: true, mode: 'layer2' })),
            state: v.state,
          },
        },
        {
          name: 'Access and trunk settings',
          'cisco.ios.ios_l2_interfaces': {
            config: ports.map((p) =>
              p.mode === 'trunk'
                ? { name: p.name, mode: 'trunk', trunk: { allowed_vlans: p.vlans, native_vlan: p.native } }
                : {
                    name: p.name,
                    mode: 'access',
                    access: p.vlans[0] ? { vlan: Number(p.vlans[0]) } : undefined,
                    voice: voice ? { vlan: voice } : undefined,
                    spanning_tree: on(v.bpduguard) ? { bpduguard: { enabled: true } } : undefined,
                  },
            ),
            state: v.state,
          },
        },
        ...saveTask('cisco.ios.ios_config', v),
      ]),
    ]);
  },
  needs: (v) => cliNeeds(v, true),
});

const IOS_BASELINE = playbookScenario({
  id: 'net_ios_baseline',
  label: 'Cisco IOS – Device baseline',
  group: IOS,
  description: 'Hostname, NTP servers, syslog, SNMP and a login banner: the settings every IOS device gets on day one.',
  inputs: [
    { id: 'hostname', label: 'Hostname', control: 'text', default: '{{ inventory_hostname }}', hint: 'Jinja allowed; default is the inventory name' },
    { id: 'configure_ntp', label: 'Configure NTP', control: 'toggle', default: true, section: 'NTP' },
    { id: 'ntp_servers', label: 'NTP servers', control: 'textarea', default: '0.pool.ntp.org\n1.pool.ntp.org', hint: 'One per line', section: 'NTP', showWhen: { input: 'configure_ntp', equals: ['true'] } },
    { id: 'ntp_source', label: 'NTP source interface', control: 'text', default: '', placeholder: 'e.g. Loopback0', section: 'NTP', showWhen: { input: 'configure_ntp', equals: ['true'] } },
    { id: 'configure_logging', label: 'Configure syslog', control: 'toggle', default: true, section: 'Logging' },
    { id: 'syslog_hosts', label: 'Syslog servers', control: 'textarea', default: '10.0.99.50', hint: 'One per line', section: 'Logging', showWhen: { input: 'configure_logging', equals: ['true'] } },
    { id: 'log_level', label: 'Syslog level', control: 'select', options: LOG_LEVELS, default: 'informational', section: 'Logging', showWhen: { input: 'configure_logging', equals: ['true'] } },
    { id: 'log_buffer', label: 'Log buffer size (bytes)', control: 'number', default: 64000, section: 'Logging', showWhen: { input: 'configure_logging', equals: ['true'] } },
    { id: 'configure_snmp', label: 'Configure SNMP', control: 'toggle', default: true, section: 'SNMP' },
    { id: 'snmp_location', label: 'SNMP location', control: 'text', default: 'HQ – Comms room 1', section: 'SNMP', showWhen: { input: 'configure_snmp', equals: ['true'] } },
    { id: 'snmp_contact', label: 'SNMP contact', control: 'text', default: 'noc@example.com', section: 'SNMP', showWhen: { input: 'configure_snmp', equals: ['true'] } },
    { id: 'configure_banner', label: 'Login banner', control: 'toggle', default: true, section: 'Banner' },
    { id: 'banner_text', label: 'Banner text', control: 'textarea', default: 'Authorised access only.\nActivity on this device is logged and monitored.', hint: 'No empty lines', section: 'Banner', showWhen: { input: 'configure_banner', equals: ['true'] } },
    stateInput('state', 'State', ['merged', 'replaced']),
    USER,
    ENABLE,
    SAVE,
  ],
  plays: (v) => {
    const tasks: Obj[] = [{ name: 'Hostname', 'cisco.ios.ios_hostname': { config: { hostname: v.hostname }, state: v.state } }];
    if (on(v.configure_ntp)) {
      tasks.push({
        name: 'NTP',
        'cisco.ios.ios_ntp_global': {
          config: { servers: items(v.ntp_servers).map((server) => ({ server })), source: String(v.ntp_source ?? '').trim() || undefined },
          state: v.state,
        },
      });
    }
    if (on(v.configure_logging)) {
      tasks.push({
        name: 'Syslog',
        'cisco.ios.ios_logging_global': {
          config: {
            hosts: items(v.syslog_hosts).map((host) => ({ host })),
            trap: v.log_level,
            buffered: { size: Number(v.log_buffer) || 64000, severity: v.log_level },
          },
          state: v.state,
        },
      });
    }
    if (on(v.configure_snmp)) {
      tasks.push({
        name: 'SNMP (v2c read-only community from the vault)',
        'cisco.ios.ios_snmp_server': {
          config: {
            location: v.snmp_location,
            contact: v.snmp_contact,
            communities: [{ name: '{{ vault_snmp_community }}', ro: true }],
          },
          state: v.state,
        },
        no_log: true,
      });
    }
    if (on(v.configure_banner)) {
      tasks.push({ name: 'Login banner', 'cisco.ios.ios_banner': { banner: 'login', text: String(v.banner_text ?? ''), state: 'present' } });
    }
    tasks.push(...saveTask('cisco.ios.ios_config', v));
    return compact([play('Apply the device baseline', 'ios', cliVars(IOS_OS, v, 'password'), tasks)]);
  },
  needs: (v) => ({
    ...cliNeeds(v, true),
    ...(on(v.configure_snmp) ? { vault_snmp_community: 'SNMP v2c read-only community string' } : {}),
  }),
});

/** An ACL endpoint: any, a host, or a prefix as address + wildcard. */
function aclEnd(token: string): Obj {
  const t = token.trim();
  if (!t || t.toLowerCase() === 'any') return { any: true };
  if (!t.includes('/') || t.endsWith('/32')) return { host: t.replace(/\/32$/, '') };
  const p = prefix(t);
  return { address: p.address, wildcard_bits: p.wildcard };
}

const IOS_ACLS = playbookScenario({
  id: 'net_ios_acls',
  label: 'Cisco IOS – Extended ACL',
  group: IOS,
  description: 'Build a named extended access list entry by entry and apply it to interfaces in or out.',
  inputs: [
    { id: 'acl_name', label: 'ACL name', control: 'text', default: 'MGMT-IN' },
    {
      id: 'entries',
      label: 'Entries',
      control: 'textarea',
      default: 'permit | tcp | 10.0.99.0/24 | any | 22\npermit | udp | 10.0.99.0/24 | any | 161\npermit | icmp | any | any\ndeny | ip | any | any | | log',
      hint: 'permit/deny | protocol | source | destination | dest port | log — any, a host or a CIDR',
    },
    { id: 'apply_to', label: 'Apply to interfaces', control: 'textarea', default: 'Vlan99=in', hint: 'One per line: interface=in or out' },
    stateInput(),
    USER,
    ENABLE,
    SAVE,
  ],
  plays: (v) => {
    const aces = rows(v.entries).map(([grant = 'permit', protocol = 'ip', src = 'any', dst = 'any', port = '', log = ''], i) => {
      const destination = aclEnd(dst);
      if (port) destination.port_protocol = { eq: port };
      return {
        sequence: (i + 1) * 10,
        grant: grant.toLowerCase() === 'deny' ? 'deny' : 'permit',
        protocol: protocol || 'ip',
        source: aclEnd(src),
        destination,
        log: log.toLowerCase() === 'log' ? { set: true } : undefined,
      };
    });
    const bindings = pairs(v.apply_to).map(([name, dir]) => ({
      name,
      access_groups: [{ afi: 'ipv4', acls: [{ name: v.acl_name, direction: dir.toLowerCase() === 'out' ? 'out' : 'in' }] }],
    }));
    return compact([
      play('Configure the access list', 'ios', cliVars(IOS_OS, v, 'password'), [
        {
          name: 'Access list entries',
          'cisco.ios.ios_acls': { config: [{ afi: 'ipv4', acls: [{ name: v.acl_name, acl_type: 'extended', aces }] }], state: v.state },
        },
        ...(bindings.length > 0 ? [{ name: 'Apply to interfaces', 'cisco.ios.ios_acl_interfaces': { config: bindings, state: v.state } }] : []),
        ...saveTask('cisco.ios.ios_config', v),
      ]),
    ]);
  },
  needs: (v) => cliNeeds(v, true),
});

const IOS_STATIC = playbookScenario({
  id: 'net_ios_static_routes',
  label: 'Cisco IOS – Static routes',
  group: IOS,
  description: 'Static routes by next-hop address or exit interface, with optional distance and name, in the global table or a VRF.',
  inputs: [
    {
      id: 'routes',
      label: 'Routes',
      control: 'textarea',
      default: '0.0.0.0/0 | 203.0.113.1 | 1 | DEFAULT\n10.50.0.0/16 | 10.0.0.2 | 10 | DC-SUMMARY\n192.0.2.0/24 | Null0 | 250 | BLACKHOLE',
      hint: 'prefix | next hop or interface | distance | name',
    },
    { id: 'vrf', label: 'VRF', control: 'text', default: '', placeholder: 'blank for the global table' },
    stateInput(),
    USER,
    ENABLE,
    SAVE,
  ],
  plays: (v) => {
    const routes = rows(v.routes).map(([dest = '', hop = '', distance = '', name = '']) => ({
      dest,
      next_hops: [
        {
          ...(isIp(hop) ? { forward_router_address: hop } : { interface: hop }),
          distance_metric: /^\d+$/.test(distance) ? Number(distance) : undefined,
          name: name || undefined,
        },
      ],
    }));
    const vrf = String(v.vrf ?? '').trim() || undefined;
    return compact([
      play('Configure static routes', 'ios', cliVars(IOS_OS, v, 'password'), [
        { name: 'Static routes', 'cisco.ios.ios_static_routes': { config: [{ vrf, address_families: [{ afi: 'ipv4', routes }] }], state: v.state } },
        ...saveTask('cisco.ios.ios_config', v),
      ]),
    ]);
  },
  needs: (v) => cliNeeds(v, true),
});

const IOS_OSPF = playbookScenario({
  id: 'net_ios_ospf',
  label: 'Cisco IOS – OSPF',
  group: IOS,
  description: 'An OSPFv2 process: router ID, network statements per area, passive interfaces and an optional default route.',
  inputs: [
    { id: 'process_id', label: 'Process ID', control: 'number', default: 1, min: 1, max: 65535 },
    { id: 'router_id', label: 'Router ID', control: 'text', default: '10.255.0.1', hint: 'Usually the Loopback0 address' },
    { id: 'networks', label: 'Networks', control: 'textarea', default: '10.255.0.1/32=0\n10.0.0.0/30=0\n10.10.0.0/16=10', hint: 'One per line: prefix=area' },
    { id: 'passive_default', label: 'Passive by default', control: 'toggle', default: true, help: 'No hellos on any interface unless listed below.' },
    { id: 'active_interfaces', label: 'Interfaces that form adjacencies', control: 'textarea', default: 'GigabitEthernet0/0\nGigabitEthernet0/1', hint: 'One per line', showWhen: { input: 'passive_default', equals: ['true'] } },
    { id: 'reference_bandwidth', label: 'Reference bandwidth (Mbps)', control: 'number', default: 100000 },
    { id: 'default_originate', label: 'Originate a default route', control: 'toggle', default: false },
    stateInput(),
    USER,
    ENABLE,
    SAVE,
  ],
  plays: (v) => {
    const network = pairs(v.networks).map(([cidr, area]) => {
      const p = prefix(cidr);
      return { address: p.address, wildcard_bits: p.wildcard, area: area || '0' };
    });
    const active = items(v.active_interfaces);
    return compact([
      play('Configure OSPF', 'ios', cliVars(IOS_OS, v, 'password'), [
        {
          name: 'OSPF process',
          'cisco.ios.ios_ospfv2': {
            config: {
              processes: [
                {
                  process_id: Number(v.process_id) || 1,
                  router_id: v.router_id,
                  network,
                  auto_cost: { set: true, reference_bandwidth: Number(v.reference_bandwidth) || 100000 },
                  passive_interfaces: on(v.passive_default)
                    ? { default: true, interface: active.length > 0 ? { set_interface: false, name: active } : undefined }
                    : undefined,
                  default_information: on(v.default_originate) ? { originate: true } : undefined,
                },
              ],
            },
            state: v.state,
          },
        },
        ...saveTask('cisco.ios.ios_config', v),
      ]),
    ]);
  },
  needs: (v) => cliNeeds(v, true),
});

const NEIGHBORS_INPUT: BlueprintInput = {
  id: 'neighbors',
  label: 'Neighbours',
  control: 'textarea',
  default: '192.0.2.1 | 65001 | ISP-A\n198.51.100.1 | 65002 | ISP-B',
  hint: 'address | remote AS | description',
};
const BGP_NETWORKS_INPUT: BlueprintInput = {
  id: 'bgp_networks',
  label: 'Networks to advertise',
  control: 'textarea',
  default: '203.0.113.0/24',
  hint: 'One prefix per line',
};

const neighborRows = (value: unknown): { address: string; asn: string; description?: string }[] =>
  rows(value).map(([address = '', asn = '', description = '']) => ({ address, asn, description: description || undefined }));

const IOS_BGP = playbookScenario({
  id: 'net_ios_bgp',
  label: 'Cisco IOS – BGP',
  group: IOS,
  description: 'A BGP process with its neighbours, then the IPv4 unicast address family: neighbours activated and prefixes advertised.',
  inputs: [
    { id: 'local_as', label: 'Local AS', control: 'text', default: '65000' },
    { id: 'router_id', label: 'Router ID', control: 'text', default: '10.255.0.1' },
    NEIGHBORS_INPUT,
    BGP_NETWORKS_INPUT,
    stateInput('state', 'State', ['merged', 'replaced', 'deleted']),
    USER,
    ENABLE,
    SAVE,
  ],
  plays: (v) => {
    const neighbors = neighborRows(v.neighbors);
    return compact([
      play('Configure BGP', 'ios', cliVars(IOS_OS, v, 'password'), [
        {
          name: 'BGP process and neighbours',
          'cisco.ios.ios_bgp_global': {
            config: {
              as_number: String(v.local_as),
              bgp: { router_id: { address: v.router_id }, log_neighbor_changes: true },
              neighbors: neighbors.map((n) => ({ neighbor_address: n.address, remote_as: n.asn, description: n.description })),
            },
            state: v.state,
          },
        },
        {
          name: 'IPv4 unicast address family',
          'cisco.ios.ios_bgp_address_family': {
            config: {
              as_number: String(v.local_as),
              address_family: [
                {
                  afi: 'ipv4',
                  safi: 'unicast',
                  neighbors: neighbors.map((n) => ({ neighbor_address: n.address, activate: true })),
                  networks: items(v.bgp_networks).map((c) => {
                    const p = prefix(c);
                    return { address: p.address, mask: p.mask };
                  }),
                },
              ],
            },
            state: v.state,
          },
        },
        ...saveTask('cisco.ios.ios_config', v),
      ]),
    ]);
  },
  needs: (v) => cliNeeds(v, true),
});

const IOS_BACKUP = playbookScenario({
  id: 'net_ios_backup',
  label: 'Cisco IOS – Configuration backup',
  group: IOS,
  description: 'Copy every IOS device’s running configuration to a file on the control node, one folder per day.',
  inputs: [
    { id: 'backup_dir', label: 'Backup folder', control: 'text', default: 'backups', hint: 'On the control node, relative to the playbook' },
    { id: 'dated', label: 'One folder per day', control: 'toggle', default: true },
    {
      id: 'method',
      label: 'Method',
      control: 'select',
      options: [
        { value: 'ios_config', label: 'cisco.ios.ios_config backup' },
        { value: 'cli_backup', label: 'ansible.netcommon.cli_backup' },
      ],
      default: 'ios_config',
    },
    { id: 'include_defaults', label: 'Include default settings', control: 'toggle', default: false, help: 'show running-config all' },
    USER,
    ENABLE,
  ],
  plays: (v) => {
    const dir = on(v.dated) ? '{{ backup_dir }}/{{ backup_date }}' : '{{ backup_dir }}';
    const tasks: Obj[] = [];
    if (on(v.dated)) {
      tasks.push({ name: 'Today’s date for the folder', 'ansible.builtin.set_fact': { backup_date: "{{ now(fmt='%Y-%m-%d') }}" }, run_once: true });
    }
    tasks.push(
      v.method === 'cli_backup'
        ? { name: 'Back up the running configuration', 'ansible.netcommon.cli_backup': { dir_path: dir, filename: '{{ inventory_hostname }}.cfg', defaults: on(v.include_defaults) } }
        : {
            name: 'Back up the running configuration',
            'cisco.ios.ios_config': { backup: true, defaults: on(v.include_defaults), backup_options: { dir_path: dir, filename: '{{ inventory_hostname }}.cfg' } },
          },
    );
    return compact([play('Back up IOS configurations', 'ios', { ...cliVars(IOS_OS, v, 'password'), backup_dir: v.backup_dir }, tasks)]);
  },
  needs: (v) => cliNeeds(v, true),
});

const IOS_FACTS = playbookScenario({
  id: 'net_ios_facts_report',
  label: 'Cisco IOS – Facts report',
  group: IOS,
  description: 'Gather facts from every IOS device, write each one’s facts to a file and a one-line-per-device inventory CSV.',
  inputs: [
    { id: 'gather_subset', label: 'Facts to gather', control: 'select', options: opts('min', 'hardware', 'interfaces', 'config', 'all'), default: 'hardware' },
    { id: 'report_dir', label: 'Report folder', control: 'text', default: 'reports', hint: 'On the control node' },
    { id: 'format', label: 'Per-device format', control: 'select', options: opts('yaml', 'json'), default: 'yaml' },
    USER,
    ENABLE,
  ],
  plays: (v) => {
    const ext = v.format === 'json' ? 'json' : 'yml';
    const filter = v.format === 'json' ? 'to_nice_json' : 'to_nice_yaml';
    const csv = [
      'hostname,model,version,serial,image',
      '{% for h in ansible_play_hosts %}',
      "{{ h }},{{ hostvars[h].ansible_facts.net_model | default('') }},{{ hostvars[h].ansible_facts.net_version | default('') }},{{ hostvars[h].ansible_facts.net_serialnum | default('') }},{{ hostvars[h].ansible_facts.net_image | default('') }}",
      '{% endfor %}',
      '',
    ].join('\n');
    return compact([
      play('Report IOS device facts', 'ios', { ...cliVars(IOS_OS, v, 'password'), report_dir: v.report_dir }, [
        { name: 'Gather facts', 'cisco.ios.ios_facts': { gather_subset: [v.gather_subset] } },
        { name: 'Report folder', 'ansible.builtin.file': { path: '{{ report_dir }}', state: 'directory', mode: '0755' }, delegate_to: 'localhost', run_once: true },
        {
          name: 'Facts per device',
          'ansible.builtin.copy': { content: `{{ ansible_facts | ${filter} }}`, dest: `{{ report_dir }}/{{ inventory_hostname }}.${ext}`, mode: '0644' },
          delegate_to: 'localhost',
        },
        {
          name: 'Inventory CSV',
          'ansible.builtin.copy': { content: csv, dest: '{{ report_dir }}/inventory.csv', mode: '0644' },
          delegate_to: 'localhost',
          run_once: true,
        },
      ]),
    ]);
  },
  needs: (v) => cliNeeds(v, true),
});

// ---------------------------------------------------------------------------
// Cisco NX-OS
// ---------------------------------------------------------------------------

const NXOS_SWITCHING = playbookScenario({
  id: 'net_nxos_switching',
  label: 'Cisco NX-OS – Features, VLANs, ports and vPC',
  group: 'Playbooks · Cisco NX-OS',
  description: 'Enable NX-OS features, create VLANs, set access and trunk ports, and optionally build the vPC domain and peer link.',
  inputs: [
    { id: 'features', label: 'Features', control: 'text', default: 'interface-vlan, lacp, lldp', hint: 'Comma-separated' },
    VLANS_INPUT,
    PORTS_INPUT('Ethernet1/', 'Ethernet1/48'),
    stateInput(),
    { id: 'vpc', label: 'Configure vPC', control: 'toggle', default: false, section: 'vPC' },
    { id: 'vpc_domain', label: 'vPC domain', control: 'number', default: 10, section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    { id: 'vpc_role_priority', label: 'Role priority', control: 'number', default: 100, hint: 'Lower wins', section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    { id: 'pkl_src', label: 'Keepalive source', control: 'text', default: '10.0.254.1', section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    { id: 'pkl_dest', label: 'Keepalive peer', control: 'text', default: '10.0.254.2', section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    { id: 'pkl_vrf', label: 'Keepalive VRF', control: 'text', default: 'management', section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    { id: 'peer_link_po', label: 'Peer-link port-channel', control: 'number', default: 1, section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    { id: 'peer_link_members', label: 'Peer-link members', control: 'text', default: 'Ethernet1/53, Ethernet1/54', section: 'vPC', showWhen: { input: 'vpc', equals: ['true'] } },
    USER,
    SAVE,
  ],
  plays: (v) => {
    const ports = portList(v.ports);
    const features = [...new Set([...items(v.features), ...(on(v.vpc) ? ['vpc', 'lacp'] : [])])];
    const po = `port-channel${Number(v.peer_link_po) || 1}`;
    const tasks: Obj[] = [
      { name: 'Features', 'cisco.nxos.nxos_feature': { feature: '{{ item }}', state: 'enabled' }, loop: features },
      { name: 'VLANs', 'cisco.nxos.nxos_vlans': { config: vlanList(v.vlans), state: v.state } },
      {
        name: 'Port description and admin state',
        'cisco.nxos.nxos_interfaces': { config: ports.map((p) => ({ name: p.name, description: p.description, enabled: true, mode: 'layer2' })), state: v.state },
      },
      {
        name: 'Access and trunk settings',
        'cisco.nxos.nxos_l2_interfaces': {
          config: ports.map((p) =>
            p.mode === 'trunk'
              ? { name: p.name, mode: 'trunk', trunk: { allowed_vlans: p.vlans.join(','), native_vlan: p.native } }
              : { name: p.name, mode: 'access', access: p.vlans[0] ? { vlan: Number(p.vlans[0]) } : undefined },
          ),
          state: v.state,
        },
      },
    ];
    if (on(v.vpc)) {
      tasks.push(
        {
          name: 'vPC domain and keepalive',
          'cisco.nxos.nxos_vpc': {
            domain: String(v.vpc_domain),
            role_priority: String(v.vpc_role_priority),
            pkl_src: v.pkl_src,
            pkl_dest: v.pkl_dest,
            pkl_vrf: v.pkl_vrf,
            peer_gw: true,
            auto_recovery: true,
            state: 'present',
          },
        },
        {
          name: 'Peer-link port-channel members',
          'cisco.nxos.nxos_lag_interfaces': { config: [{ name: po, members: items(v.peer_link_members).map((member) => ({ member, mode: 'active' })) }], state: 'merged' },
        },
        { name: 'Peer-link trunk', 'cisco.nxos.nxos_l2_interfaces': { config: [{ name: po, mode: 'trunk' }], state: 'merged' } },
        { name: 'Peer link', 'cisco.nxos.nxos_vpc_interface': { portchannel: String(Number(v.peer_link_po) || 1), peer_link: true, state: 'present' } },
      );
    }
    tasks.push(...saveTask('cisco.nxos.nxos_config', v));
    return compact([play('Configure NX-OS switching', 'nxos', cliVars('cisco.nxos.nxos', v), tasks)]);
  },
  needs: (v) => cliNeeds(v),
});

// ---------------------------------------------------------------------------
// Arista EOS
// ---------------------------------------------------------------------------

const EOS_FABRIC = playbookScenario({
  id: 'net_eos_switching_bgp',
  label: 'Arista EOS – VLANs, ports and BGP',
  group: 'Playbooks · Arista EOS',
  description: 'VLANs, access and trunk ports, and optionally a BGP process with neighbours and advertised networks.',
  inputs: [
    VLANS_INPUT,
    PORTS_INPUT('Ethernet', 'Ethernet48'),
    stateInput(),
    { id: 'bgp', label: 'Configure BGP', control: 'toggle', default: true, section: 'BGP' },
    { id: 'local_as', label: 'Local AS', control: 'text', default: '65010', section: 'BGP', showWhen: { input: 'bgp', equals: ['true'] } },
    { id: 'router_id', label: 'Router ID', control: 'text', default: '10.255.0.11', section: 'BGP', showWhen: { input: 'bgp', equals: ['true'] } },
    { ...NEIGHBORS_INPUT, default: '10.0.0.0 | 65000 | spine-1\n10.0.0.2 | 65000 | spine-2', section: 'BGP', showWhen: { input: 'bgp', equals: ['true'] } },
    { ...BGP_NETWORKS_INPUT, default: '10.10.0.0/24\n10.255.0.11/32', section: 'BGP', showWhen: { input: 'bgp', equals: ['true'] } },
    { id: 'bgp_state', label: 'BGP state', control: 'select', options: opts('merged', 'replaced', 'overridden', 'deleted'), default: 'merged', section: 'BGP', showWhen: { input: 'bgp', equals: ['true'] } },
    USER,
    { ...ENABLE, help: 'Become privileged (enable) before configuring.' },
    SAVE,
  ],
  plays: (v) => {
    const ports = portList(v.ports);
    const tasks: Obj[] = [
      { name: 'VLANs', 'arista.eos.eos_vlans': { config: vlanList(v.vlans), state: v.state } },
      {
        name: 'Port description and admin state',
        'arista.eos.eos_interfaces': { config: ports.map((p) => ({ name: p.name, description: p.description, enabled: true, mode: 'layer2' })), state: v.state },
      },
      {
        name: 'Access and trunk settings',
        'arista.eos.eos_l2_interfaces': {
          config: ports.map((p) =>
            p.mode === 'trunk'
              ? { name: p.name, mode: 'trunk', trunk: { trunk_allowed_vlans: p.vlans, native_vlan: p.native } }
              : { name: p.name, mode: 'access', access: p.vlans[0] ? { vlan: Number(p.vlans[0]) } : undefined },
          ),
          state: v.state,
        },
      },
    ];
    if (on(v.bgp)) {
      tasks.push({
        name: 'BGP',
        'arista.eos.eos_bgp_global': {
          config: {
            as_number: String(v.local_as),
            router_id: v.router_id,
            neighbor: neighborRows(v.neighbors).map((n) => ({ neighbor_address: n.address, remote_as: n.asn, description: n.description })),
            network: items(v.bgp_networks).map((address) => ({ address })),
          },
          state: v.bgp_state,
        },
      });
    }
    tasks.push(...saveTask('arista.eos.eos_config', v));
    return compact([play('Configure EOS switching and routing', 'eos', cliVars('arista.eos.eos', v, 'plain'), tasks)]);
  },
  needs: (v) => cliNeeds(v),
});

// ---------------------------------------------------------------------------
// Cisco IOS XR
// ---------------------------------------------------------------------------

const IOSXR_ROUTING = playbookScenario({
  id: 'net_iosxr_routing',
  label: 'Cisco IOS XR – Interfaces, BGP and static routes',
  group: 'Playbooks · Cisco IOS XR',
  description: 'Address and enable IOS XR interfaces, then add BGP neighbours with route policies, static routes, or both.',
  inputs: [
    {
      id: 'interfaces',
      label: 'Interfaces',
      control: 'textarea',
      default: 'Loopback0 | 10.255.0.21/32 | Router ID\nGigabitEthernet0/0/0/0 | 10.0.1.1/30 | To core-1\nGigabitEthernet0/0/0/1 | 192.0.2.2/30 | To ISP-A',
      hint: 'name | address/prefix | description',
    },
    { id: 'interface_state', label: 'Interface state', control: 'select', options: opts('merged', 'replaced', 'overridden', 'deleted'), default: 'merged', help: STATE_HELP },
    {
      id: 'routing',
      label: 'Routing',
      control: 'select',
      options: [
        { value: 'bgp', label: 'BGP' },
        { value: 'static', label: 'Static routes' },
        { value: 'both', label: 'BGP and static routes' },
      ],
      default: 'bgp',
    },
    { id: 'local_as', label: 'Local AS', control: 'text', default: '65000', section: 'BGP', showWhen: { input: 'routing', equals: ['bgp', 'both'] } },
    { id: 'router_id', label: 'Router ID', control: 'text', default: '10.255.0.21', section: 'BGP', showWhen: { input: 'routing', equals: ['bgp', 'both'] } },
    { ...NEIGHBORS_INPUT, default: '192.0.2.1 | 65001 | ISP-A', section: 'BGP', showWhen: { input: 'routing', equals: ['bgp', 'both'] } },
    { id: 'policy_in', label: 'Inbound route policy', control: 'text', default: 'PASS', hint: 'Must already exist; eBGP needs one', section: 'BGP', showWhen: { input: 'routing', equals: ['bgp', 'both'] } },
    { id: 'policy_out', label: 'Outbound route policy', control: 'text', default: 'PASS', section: 'BGP', showWhen: { input: 'routing', equals: ['bgp', 'both'] } },
    { ...BGP_NETWORKS_INPUT, section: 'BGP', showWhen: { input: 'routing', equals: ['bgp', 'both'] } },
    {
      id: 'routes',
      label: 'Static routes',
      control: 'textarea',
      default: '0.0.0.0/0 | 192.0.2.1 | 1\n10.60.0.0/16 | 10.0.1.2 | 10',
      hint: 'prefix | next hop or interface | admin distance',
      section: 'Static routes',
      showWhen: { input: 'routing', equals: ['static', 'both'] },
    },
    stateInput('routing_state', 'Routing state', ['merged', 'replaced', 'overridden', 'deleted']),
    USER,
  ],
  plays: (v) => {
    const intfs = rows(v.interfaces).map(([name = '', address = '', description = '']) => ({ name, address, description: description || undefined }));
    const tasks: Obj[] = [
      {
        name: 'Interface description and admin state',
        'cisco.iosxr.iosxr_interfaces': { config: intfs.map((i) => ({ name: i.name, description: i.description, enabled: true })), state: v.interface_state },
      },
      {
        name: 'Interface addresses',
        'cisco.iosxr.iosxr_l3_interfaces': {
          config: intfs.filter((i) => i.address).map((i) => ({ name: i.name, ipv4: [{ address: i.address }] })),
          state: v.interface_state,
        },
      },
    ];
    if (v.routing !== 'static') {
      const neighbors = neighborRows(v.neighbors);
      tasks.push(
        {
          name: 'BGP process and neighbours',
          'cisco.iosxr.iosxr_bgp_global': {
            config: {
              as_number: String(v.local_as),
              bgp: { router_id: v.router_id },
              neighbors: neighbors.map((n) => ({ neighbor_address: n.address, remote_as: n.asn, description: n.description })),
            },
            state: v.routing_state,
          },
        },
        {
          name: 'IPv4 unicast networks',
          'cisco.iosxr.iosxr_bgp_address_family': {
            config: { as_number: String(v.local_as), address_family: [{ afi: 'ipv4', safi: 'unicast', networks: items(v.bgp_networks).map((network) => ({ network })) }] },
            state: v.routing_state,
          },
        },
        {
          name: 'Neighbour address family and route policies',
          'cisco.iosxr.iosxr_bgp_neighbor_address_family': {
            config: {
              as_number: String(v.local_as),
              neighbors: neighbors.map((n) => ({
                neighbor_address: n.address,
                address_family: [{ afi: 'ipv4', safi: 'unicast', route_policy: { inbound: v.policy_in, outbound: v.policy_out } }],
              })),
            },
            state: v.routing_state,
          },
        },
      );
    }
    if (v.routing !== 'bgp') {
      const routes = rows(v.routes).map(([dest = '', hop = '', distance = '']) => ({
        dest,
        next_hops: [{ ...(isIp(hop) ? { forward_router_address: hop } : { interface: hop }), admin_distance: /^\d+$/.test(distance) ? Number(distance) : undefined }],
      }));
      tasks.push({
        name: 'Static routes',
        'cisco.iosxr.iosxr_static_routes': { config: [{ address_families: [{ afi: 'ipv4', safi: 'unicast', routes }] }], state: v.routing_state },
      });
    }
    // IOS XR commits each resource module's change itself; there is no separate save.
    return compact([play('Configure IOS XR interfaces and routing', 'iosxr', cliVars('cisco.iosxr.iosxr', v), tasks)]);
  },
  needs: (v) => cliNeeds(v),
});

// ---------------------------------------------------------------------------
// VyOS
// ---------------------------------------------------------------------------

const VYOS_ROUTER = playbookScenario({
  id: 'net_vyos_router',
  label: 'VyOS – Interfaces, static routes and firewall',
  group: 'Playbooks · VyOS',
  description: 'Address VyOS interfaces, add static routes and optionally an inbound firewall rule set on the WAN interface (VyOS 1.3 syntax).',
  inputs: [
    {
      id: 'interfaces',
      label: 'Interfaces',
      control: 'textarea',
      default: 'eth0 | 203.0.113.2/30 | WAN\neth1 | 10.20.0.1/24 | LAN',
      hint: 'name | address/prefix | description',
    },
    { id: 'routes', label: 'Static routes', control: 'textarea', default: '0.0.0.0/0 | 203.0.113.1\n10.30.0.0/16 | 10.20.0.254', hint: 'prefix | next hop or interface | distance' },
    stateInput(),
    { id: 'firewall', label: 'Inbound WAN firewall', control: 'toggle', default: true, section: 'Firewall' },
    { id: 'fw_name', label: 'Rule set name', control: 'text', default: 'WAN-IN', section: 'Firewall', showWhen: { input: 'firewall', equals: ['true'] } },
    { id: 'wan_interface', label: 'Apply to interface', control: 'text', default: 'eth0', section: 'Firewall', showWhen: { input: 'firewall', equals: ['true'] } },
    {
      id: 'allow',
      label: 'Allowed in',
      control: 'textarea',
      default: 'tcp | 22 | 198.51.100.0/24 | SSH from office\nudp | 51820 | | WireGuard',
      hint: 'protocol | port | source (blank = any) | description',
      section: 'Firewall',
      showWhen: { input: 'firewall', equals: ['true'] },
    },
    { id: 'fw_default', label: 'Default action', control: 'select', options: opts('drop', 'reject'), default: 'drop', section: 'Firewall', showWhen: { input: 'firewall', equals: ['true'] } },
    USER,
    { ...SAVE, label: 'Save configuration', help: 'Resource modules commit; this also saves to /config/config.boot.' },
  ],
  plays: (v) => {
    const intfs = rows(v.interfaces).map(([name = '', address = '', description = '']) => ({ name, address, description: description || undefined }));
    const routes = rows(v.routes).map(([dest = '', hop = '', distance = '']) => ({
      dest,
      next_hops: [{ ...(isIp(hop) ? { forward_router_address: hop } : { interface: hop }), admin_distance: /^\d+$/.test(distance) ? Number(distance) : undefined }],
    }));
    const tasks: Obj[] = [
      { name: 'Interface description and admin state', 'vyos.vyos.vyos_interfaces': { config: intfs.map((i) => ({ name: i.name, description: i.description, enabled: true })), state: v.state } },
      {
        name: 'Interface addresses',
        'vyos.vyos.vyos_l3_interfaces': { config: intfs.filter((i) => i.address).map((i) => ({ name: i.name, ipv4: [{ address: i.address }] })), state: v.state },
      },
      { name: 'Static routes', 'vyos.vyos.vyos_static_routes': { config: [{ address_families: [{ afi: 'ipv4', routes }] }], state: v.state } },
    ];
    if (on(v.firewall)) {
      const rules: Obj[] = [
        { number: 10, action: 'accept', description: 'Return traffic', state: { established: true, related: true } },
        { number: 15, action: 'drop', description: 'Invalid', state: { invalid: true } },
        ...rows(v.allow).map(([protocol = 'tcp', port = '', source = '', description = ''], i) => ({
          number: 20 + i * 10,
          action: 'accept',
          protocol,
          description: description || undefined,
          destination: port ? { port } : undefined,
          source: source ? { address: source } : undefined,
        })),
      ];
      tasks.push(
        {
          name: 'Firewall rule set',
          'vyos.vyos.vyos_firewall_rules': {
            config: [{ afi: 'ipv4', rule_sets: [{ name: v.fw_name, default_action: v.fw_default, enable_default_log: true, rules }] }],
            state: 'merged',
          },
        },
        {
          name: 'Apply to the WAN interface',
          'vyos.vyos.vyos_firewall_interfaces': {
            config: [{ name: v.wan_interface, access_rules: [{ afi: 'ipv4', rules: [{ name: v.fw_name, direction: 'in' }] }] }],
            state: 'merged',
          },
        },
      );
    }
    if (on(v.save_config)) tasks.push({ name: 'Save the configuration', 'vyos.vyos.vyos_config': { save: true } });
    return compact([play('Configure the VyOS router', 'vyos', cliVars('vyos.vyos.vyos', v), tasks)]);
  },
  needs: (v) => cliNeeds(v),
});

// ---------------------------------------------------------------------------
// Fortinet FortiOS
// ---------------------------------------------------------------------------

const FORTIOS_POLICY = playbookScenario({
  id: 'net_fortios_address_policy',
  label: 'FortiGate – Address objects and firewall policy',
  group: 'Playbooks · Fortinet FortiOS',
  description: 'Create address objects on a FortiGate and a firewall policy between two interfaces that uses them, in a chosen VDOM.',
  inputs: [
    { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    { id: 'addresses', label: 'Address objects', control: 'textarea', default: 'web-01=10.20.0.10/32\nweb-02=10.20.0.11/32', hint: 'One per line: name=CIDR' },
    { id: 'policy_id', label: 'Policy ID', control: 'number', default: 100, min: 1 },
    { id: 'policy_name', label: 'Policy name', control: 'text', default: 'Allow-Web-In' },
    { id: 'srcintf', label: 'Incoming interface', control: 'text', default: 'port1' },
    { id: 'dstintf', label: 'Outgoing interface', control: 'text', default: 'port2' },
    { id: 'srcaddr', label: 'Source addresses', control: 'text', default: 'all', hint: 'Comma-separated object names' },
    { id: 'dstaddr', label: 'Destination addresses', control: 'text', default: '', placeholder: 'blank = the objects above', hint: 'Comma-separated' },
    { id: 'services', label: 'Services', control: 'text', default: 'HTTP, HTTPS', hint: 'Comma-separated' },
    { id: 'action', label: 'Action', control: 'select', options: opts('accept', 'deny'), default: 'accept' },
    { id: 'nat', label: 'Source NAT', control: 'toggle', default: false },
    { id: 'logtraffic', label: 'Log traffic', control: 'select', options: opts('all', 'utm', 'disable'), default: 'all' },
    { id: 'state', label: 'State', control: 'select', options: opts('present', 'absent'), default: 'present' },
    {
      id: 'auth',
      label: 'Authentication',
      control: 'select',
      options: [
        { value: 'token', label: 'REST API token (vault_fortios_api_token)' },
        { value: 'password', label: 'User and password (vault_network_password)' },
      ],
      default: 'token',
    },
    { ...USER, showWhen: { input: 'auth', equals: ['password'] }, default: 'admin' },
    { id: 'validate_certs', label: 'Validate the HTTPS certificate', control: 'toggle', default: true },
  ],
  plays: (v) => {
    const token = v.auth === 'token';
    const addresses = pairs(v.addresses).map(([name, cidr]) => {
      const p = prefix(cidr);
      return { name, subnet: `${p.address} ${p.mask}` };
    });
    const dstaddr = items(v.dstaddr).length > 0 ? items(v.dstaddr) : addresses.map((a) => a.name);
    const auth = token ? { access_token: '{{ vault_fortios_api_token }}' } : {};
    const vars: Obj = {
      ansible_connection: 'ansible.netcommon.httpapi',
      ansible_network_os: 'fortinet.fortios.fortios',
      ansible_httpapi_use_ssl: true,
      ansible_httpapi_validate_certs: on(v.validate_certs),
      ansible_httpapi_port: 443,
      vdom: v.vdom,
      ...(token ? {} : { ansible_user: v.username, ansible_password: '{{ vault_network_password }}' }),
    };
    const policy = {
      ...auth,
      vdom: '{{ vdom }}',
      state: v.state,
      firewall_policy: {
        policyid: Number(v.policy_id) || 100,
        name: v.policy_name,
        srcintf: items(v.srcintf).map((name) => ({ name })),
        dstintf: items(v.dstintf).map((name) => ({ name })),
        srcaddr: items(v.srcaddr).map((name) => ({ name })),
        dstaddr: dstaddr.map((name) => ({ name })),
        service: items(v.services).map((name) => ({ name })),
        action: v.action,
        schedule: 'always',
        nat: on(v.nat) ? 'enable' : 'disable',
        logtraffic: v.logtraffic,
        status: 'enable',
      },
    };
    const addressTask = {
      name: 'Address objects',
      'fortinet.fortios.fortios_firewall_address': {
        ...auth,
        vdom: '{{ vdom }}',
        state: v.state,
        firewall_address: { name: '{{ item.name }}', type: 'ipmask', subnet: '{{ item.subnet }}', comment: 'Managed by Ansible' },
      },
      loop: addresses,
    };
    const policyTask = { name: 'Firewall policy', 'fortinet.fortios.fortios_firewall_policy': policy };
    // Removing: the policy goes first, since it still refers to the addresses.
    const tasks = v.state === 'absent' ? [policyTask, addressTask] : [addressTask, policyTask];
    return compact([play('Configure FortiGate objects and policy', 'fortios', vars, tasks)]);
  },
  needs: (v) =>
    v.auth === 'token'
      ? { vault_fortios_api_token: 'FortiGate REST API administrator token' }
      : { vault_network_password: 'Password of the FortiGate administrator' },
});

// ---------------------------------------------------------------------------
// F5 BIG-IP
// ---------------------------------------------------------------------------

const F5_APP = playbookScenario({
  id: 'net_f5_ltm_app',
  label: 'F5 BIG-IP – Load-balanced application',
  group: 'Playbooks · F5 BIG-IP',
  description: 'An HTTP health monitor, a pool with its members and a virtual server in front of it, on BIG-IP LTM.',
  inputs: [
    { id: 'app_name', label: 'Application name', control: 'text', default: 'web', hint: 'Prefix for the monitor, pool and virtual server' },
    { id: 'partition', label: 'Partition', control: 'text', default: 'Common' },
    { id: 'vip', label: 'Virtual address', control: 'text', default: '10.1.20.100' },
    { id: 'vip_port', label: 'Virtual port', control: 'number', default: 443 },
    { id: 'members', label: 'Pool members', control: 'textarea', default: '10.1.10.11:80\n10.1.10.12:80', hint: 'One per line: address:port' },
    {
      id: 'lb_method',
      label: 'Load balancing',
      control: 'select',
      options: opts('round-robin', 'least-connections-member', 'ratio-member', 'observed-member', 'predictive-member'),
      default: 'least-connections-member',
    },
    { id: 'monitor_send', label: 'Monitor request', control: 'text', default: 'GET /health HTTP/1.1\\r\\nHost: web\\r\\nConnection: close\\r\\n\\r\\n' },
    { id: 'monitor_receive', label: 'Expected response', control: 'text', default: '200 OK' },
    { id: 'client_ssl', label: 'Terminate TLS (clientssl profile)', control: 'toggle', default: true },
    { id: 'snat', label: 'Source address translation', control: 'select', options: opts('Automap', 'None'), default: 'Automap' },
    {
      id: 'member_state',
      label: 'Member state',
      control: 'select',
      options: [
        { value: 'enabled', label: 'enabled – taking traffic' },
        { value: 'disabled', label: 'disabled – finish existing connections' },
        { value: 'forced_offline', label: 'forced offline – drop to zero now' },
      ],
      default: 'enabled',
    },
    { ...USER, default: 'admin', hint: 'Password is vault_f5_password' },
    { id: 'validate_certs', label: 'Validate the HTTPS certificate', control: 'toggle', default: true },
  ],
  plays: (v) => {
    const app = String(v.app_name || 'web');
    const members = items(v.members).map((m) => {
      const i = m.lastIndexOf(':');
      return { address: i > 0 ? m.slice(0, i) : m, port: i > 0 ? Number(m.slice(i + 1)) : 80 };
    });
    const common = { provider: '{{ f5_provider }}', partition: '{{ f5_partition }}' };
    const profiles: YamlValue[] = ['tcp', 'http'];
    if (on(v.client_ssl)) profiles.push({ name: 'clientssl', context: 'client-side' });
    return compact([
      play(
        'Publish the application on BIG-IP',
        'f5',
        {
          // F5 modules call the iControl REST API from the control node.
          ansible_connection: 'local',
          f5_partition: v.partition,
          f5_provider: {
            server: '{{ ansible_host | default(inventory_hostname) }}',
            server_port: 443,
            user: v.username,
            password: '{{ vault_f5_password }}',
            validate_certs: on(v.validate_certs),
          },
        },
        [
          {
            name: 'HTTP health monitor',
            'f5networks.f5_modules.bigip_monitor_http': {
              ...common,
              name: `${app}_http_monitor`,
              parent: '/Common/http',
              send: v.monitor_send,
              receive: v.monitor_receive,
              interval: 5,
              timeout: 16,
              state: 'present',
            },
          },
          {
            name: 'Pool',
            'f5networks.f5_modules.bigip_pool': {
              ...common,
              name: `${app}_pool`,
              lb_method: v.lb_method,
              monitors: [`${app}_http_monitor`],
              state: 'present',
            },
          },
          {
            name: 'Pool members',
            'f5networks.f5_modules.bigip_pool_member': {
              ...common,
              pool: `${app}_pool`,
              address: '{{ item.address }}',
              port: '{{ item.port }}',
              name: '{{ item.address }}',
              state: v.member_state,
            },
            loop: members,
          },
          {
            name: 'Virtual server',
            'f5networks.f5_modules.bigip_virtual_server': {
              ...common,
              name: `${app}_vs`,
              destination: v.vip,
              port: String(v.vip_port),
              pool: `${app}_pool`,
              profiles,
              snat: v.snat,
              description: `${app} – managed by Ansible`,
              state: 'present',
            },
          },
        ],
      ),
    ]);
  },
  needs: () => ({ vault_f5_password: 'Password of the BIG-IP administrator' }),
});

// ---------------------------------------------------------------------------
// Check Point
// ---------------------------------------------------------------------------

const CHECKPOINT_RULE = playbookScenario({
  id: 'net_checkpoint_access_rule',
  label: 'Check Point – Host objects, access rule and publish',
  group: 'Playbooks · Check Point',
  description: 'Create host objects and an access rule that uses them on the Management Server, publish the session and optionally install policy.',
  inputs: [
    { id: 'hosts_list', label: 'Host objects', control: 'textarea', default: 'web-01=10.20.0.10\nweb-02=10.20.0.11', hint: 'One per line: name=IP' },
    { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Allow web servers' },
    { id: 'layer', label: 'Access layer', control: 'text', default: 'Network' },
    { id: 'position', label: 'Position', control: 'text', default: 'top', hint: 'top, bottom or a rule number' },
    { id: 'source', label: 'Source', control: 'text', default: 'Any', hint: 'Comma-separated object names' },
    { id: 'destination', label: 'Destination', control: 'text', default: '', placeholder: 'blank = the host objects above' },
    { id: 'service', label: 'Services', control: 'text', default: 'http, https' },
    { id: 'action', label: 'Action', control: 'select', options: opts('Accept', 'Drop', 'Reject'), default: 'Accept' },
    { id: 'track', label: 'Track', control: 'select', options: opts('Log', 'Extended Log', 'Detailed Log', 'None'), default: 'Log' },
    { id: 'install_policy', label: 'Install policy after publish', control: 'toggle', default: false },
    { id: 'policy_package', label: 'Policy package', control: 'text', default: 'Standard', showWhen: { input: 'install_policy', equals: ['true'] } },
    { id: 'targets', label: 'Install on gateways', control: 'text', default: 'gw-01', hint: 'Comma-separated', showWhen: { input: 'install_policy', equals: ['true'] } },
    { ...USER, default: 'ansible', hint: 'Password is vault_checkpoint_password' },
    { id: 'validate_certs', label: 'Validate the HTTPS certificate', control: 'toggle', default: true },
  ],
  plays: (v) => {
    const hostObjs = pairs(v.hosts_list).map(([name, ip]) => ({ name, ip }));
    const destination = items(v.destination).length > 0 ? items(v.destination) : hostObjs.map((h) => h.name);
    const tasks: Obj[] = [
      {
        name: 'Host objects',
        'check_point.mgmt.cp_mgmt_host': { name: '{{ item.name }}', ip_address: '{{ item.ip }}', comments: 'Managed by Ansible', state: 'present' },
        loop: hostObjs,
      },
      {
        name: 'Access rule',
        'check_point.mgmt.cp_mgmt_access_rule': {
          name: v.rule_name,
          layer: v.layer,
          position: String(v.position),
          source: items(v.source),
          destination,
          service: items(v.service),
          action: v.action,
          track: { type: v.track },
          enabled: true,
          state: 'present',
        },
      },
      { name: 'Publish the session', 'check_point.mgmt.cp_mgmt_publish': {} },
    ];
    if (on(v.install_policy)) {
      tasks.push({ name: 'Install policy', 'check_point.mgmt.cp_mgmt_install_policy': { policy_package: v.policy_package, targets: items(v.targets), access: true } });
    }
    return compact([
      play(
        'Add objects and an access rule',
        'checkpoint',
        {
          ansible_connection: 'ansible.netcommon.httpapi',
          ansible_network_os: 'check_point.mgmt.checkpoint',
          ansible_httpapi_use_ssl: true,
          ansible_httpapi_validate_certs: on(v.validate_certs),
          ansible_user: v.username,
          ansible_password: '{{ vault_checkpoint_password }}',
        },
        tasks,
      ),
    ]);
  },
  needs: () => ({ vault_checkpoint_password: 'Password of the Management API user' }),
});

// ---------------------------------------------------------------------------
// Multi-vendor
// ---------------------------------------------------------------------------

const NETWORK_OS_OPTIONS: SelectOption[] = [
  { value: 'inventory', label: 'Set per host in the inventory (mixed fleet)' },
  { value: 'cisco.ios.ios', label: 'Cisco IOS / IOS XE' },
  { value: 'cisco.nxos.nxos', label: 'Cisco NX-OS' },
  { value: 'cisco.iosxr.iosxr', label: 'Cisco IOS XR' },
  { value: 'arista.eos.eos', label: 'Arista EOS' },
  { value: 'vyos.vyos.vyos', label: 'VyOS' },
];

const FLEET_INPUTS: BlueprintInput[] = [
  { id: 'device_group', label: 'Inventory group', control: 'text', default: 'network', hint: 'The group holding every device' },
  {
    id: 'network_os',
    label: 'Platform',
    control: 'select',
    options: NETWORK_OS_OPTIONS,
    default: 'inventory',
    help: 'For a mixed fleet set ansible_network_os on each host or group in the inventory (e.g. cisco.ios.ios) and install that platform’s collection.',
  },
];

function fleetVars(v: TemplateValues): Obj {
  const vars: Obj = {
    ansible_connection: 'ansible.netcommon.network_cli',
    ansible_user: v.username,
    ansible_password: '{{ vault_network_password }}',
  };
  if (v.network_os !== 'inventory') vars.ansible_network_os = v.network_os;
  if (on(v.enable_mode)) {
    vars.ansible_become = true;
    vars.ansible_become_method = 'enable';
    vars.ansible_become_password = '{{ vault_enable_password }}';
  }
  return vars;
}

const fleetHosts = (v: TemplateValues): string => String(v.device_group || 'network').trim() || 'network';

const MULTI_BACKUP = playbookScenario({
  id: 'net_multi_backup',
  label: 'Multi-vendor – Configuration backup',
  group: 'Playbooks · Multi-vendor',
  description: 'Back up the running configuration of every device in a group, whatever the vendor, to dated files on the control node.',
  inputs: [
    ...FLEET_INPUTS,
    { id: 'backup_dir', label: 'Backup folder', control: 'text', default: 'backups' },
    {
      id: 'layout',
      label: 'File layout',
      control: 'select',
      options: [
        { value: 'folder', label: 'backups/2026-09-25/host.cfg' },
        { value: 'name', label: 'backups/host_2026-09-25.cfg' },
      ],
      default: 'folder',
    },
    { id: 'keep_days', label: 'Delete backups older than (days)', control: 'number', default: 90, hint: '0 keeps everything' },
    USER,
    { ...ENABLE, default: false, help: 'For IOS devices whose user lands in user EXEC; the enable secret is vault_enable_password.' },
  ],
  plays: (v) => {
    const folder = v.layout === 'folder';
    const keep = Number(v.keep_days) || 0;
    const tasks: Obj[] = [
      { name: 'Today’s date', 'ansible.builtin.set_fact': { backup_date: "{{ now(fmt='%Y-%m-%d') }}" }, run_once: true },
      {
        name: 'Back up the running configuration',
        'ansible.netcommon.cli_backup': {
          dir_path: folder ? '{{ backup_dir }}/{{ backup_date }}' : '{{ backup_dir }}',
          filename: folder ? '{{ inventory_hostname }}.cfg' : '{{ inventory_hostname }}_{{ backup_date }}.cfg',
        },
      },
    ];
    if (keep > 0) {
      tasks.push(
        {
          name: 'Find old backups',
          'ansible.builtin.find': { paths: '{{ backup_dir }}', age: `${keep}d`, recurse: true, patterns: '*.cfg' },
          register: 'old_backups',
          delegate_to: 'localhost',
          run_once: true,
        },
        {
          name: 'Remove old backups',
          'ansible.builtin.file': { path: '{{ item.path }}', state: 'absent' },
          loop: '{{ old_backups.files }}',
          loop_control: { label: '{{ item.path }}' },
          delegate_to: 'localhost',
          run_once: true,
        },
      );
    }
    return compact([play('Back up network device configurations', fleetHosts(v), { ...fleetVars(v), backup_dir: v.backup_dir }, tasks)]);
  },
  needs: (v) => cliNeeds(v, true),
});

const MULTI_PING = playbookScenario({
  id: 'net_multi_reachability',
  label: 'Multi-vendor – Reachability check',
  group: 'Playbooks · Multi-vendor',
  description: 'From every device, ping a list of targets and fail the run where one is not reachable (or, for a firewall test, is).',
  inputs: [
    ...FLEET_INPUTS,
    { id: 'targets', label: 'Targets', control: 'textarea', default: '10.0.99.1\n10.0.99.50\n8.8.8.8', hint: 'One address or name per line' },
    { id: 'count', label: 'Packets', control: 'number', default: 5, min: 1 },
    { id: 'vrf', label: 'VRF', control: 'text', default: 'default' },
    { id: 'source', label: 'Source address', control: 'text', default: '', placeholder: 'blank = outgoing interface' },
    {
      id: 'expect',
      label: 'Expect',
      control: 'select',
      options: [
        { value: 'present', label: 'Reachable' },
        { value: 'absent', label: 'Unreachable (prove a block)' },
      ],
      default: 'present',
    },
    USER,
    { ...ENABLE, default: false, help: 'For IOS devices whose user lands in user EXEC; the enable secret is vault_enable_password.' },
  ],
  plays: (v) =>
    compact([
      play('Check reachability from each device', fleetHosts(v), fleetVars(v), [
        {
          name: 'Ping',
          'ansible.netcommon.net_ping': {
            dest: '{{ item }}',
            count: String(Number(v.count) || 5),
            vrf: String(v.vrf || 'default'),
            source: String(v.source ?? '').trim() || undefined,
            state: v.expect,
          },
          loop: items(v.targets),
        },
      ]),
    ]),
  needs: (v) => cliNeeds(v, true),
});

// ---------------------------------------------------------------------------
// Infoblox and NetBox (API, from the control node)
// ---------------------------------------------------------------------------

const INFOBLOX_RECORDS = playbookScenario({
  id: 'net_infoblox_dns_records',
  label: 'Infoblox NIOS – DNS host records',
  group: 'Playbooks · Infoblox',
  description: 'Create or remove DNS host or A records in Infoblox NIOS through the WAPI, from a list of names and addresses.',
  inputs: [
    { id: 'nios_host', label: 'Grid Master', control: 'text', default: 'infoblox.example.com' },
    { id: 'nios_user', label: 'WAPI user', control: 'text', default: 'ansible', hint: 'Password is vault_nios_password' },
    { id: 'wapi_version', label: 'WAPI version', control: 'text', default: '2.12' },
    { id: 'records', label: 'Records', control: 'textarea', default: 'web01.example.com=10.20.0.10\nweb02.example.com=10.20.0.11', hint: 'One per line: fqdn=IPv4' },
    {
      id: 'record_type',
      label: 'Record type',
      control: 'select',
      options: [
        { value: 'host', label: 'Host record (A + PTR, IPAM-aware)' },
        { value: 'a', label: 'A record only' },
      ],
      default: 'host',
    },
    { id: 'view', label: 'DNS view', control: 'text', default: 'default' },
    { id: 'ttl', label: 'TTL (seconds)', control: 'number', default: 3600 },
    { id: 'state', label: 'State', control: 'select', options: opts('present', 'absent'), default: 'present' },
    { id: 'validate_certs', label: 'Validate the HTTPS certificate', control: 'toggle', default: true },
  ],
  plays: (v) => {
    const records = pairs(v.records).map(([name, ip]) => ({ name, ip }));
    const common = { view: v.view, ttl: Number(v.ttl) || 3600, comment: 'Managed by Ansible', state: v.state, provider: '{{ nios_provider }}' };
    const task =
      v.record_type === 'a'
        ? { name: 'A records', 'infoblox.nios_modules.nios_a_record': { name: '{{ item.name }}', ipv4addr: '{{ item.ip }}', ...common }, loop: records }
        : {
            name: 'Host records',
            'infoblox.nios_modules.nios_host_record': { name: '{{ item.name }}', ipv4addrs: [{ ipv4addr: '{{ item.ip }}' }], configure_for_dns: true, ...common },
            loop: records,
          };
    return compact([
      {
        name: 'Manage DNS records in Infoblox',
        hosts: 'localhost',
        connection: 'local',
        gather_facts: false,
        vars: {
          nios_provider: {
            host: v.nios_host,
            username: v.nios_user,
            password: '{{ vault_nios_password }}',
            wapi_version: v.wapi_version,
            validate_certs: on(v.validate_certs),
          },
        },
        tasks: [task],
      },
    ]);
  },
  needs: () => ({ vault_nios_password: 'Password of the Infoblox WAPI user' }),
});

const NETBOX_DEVICES = playbookScenario({
  id: 'net_netbox_devices',
  label: 'NetBox – Devices',
  group: 'Playbooks · NetBox',
  description: 'Register network devices in NetBox with their role, type, site and status, so the source of truth matches the rack.',
  inputs: [
    { id: 'netbox_url', label: 'NetBox URL', control: 'text', default: 'https://netbox.example.com' },
    {
      id: 'devices',
      label: 'Devices',
      control: 'textarea',
      default: 'sw-core-01 | Core Switch | C9500-48Y4C | HQ\nsw-acc-01 | Access Switch | C9300-48P | HQ\nfw-edge-01 | Firewall | FortiGate-100F | HQ',
      hint: 'name | role | device type | site (all must exist in NetBox)',
    },
    { id: 'status', label: 'Status', control: 'select', options: opts('active', 'planned', 'staged', 'offline', 'decommissioning'), default: 'active' },
    { id: 'tags', label: 'Tags', control: 'text', default: 'ansible', hint: 'Comma-separated; must exist' },
    { id: 'state', label: 'State', control: 'select', options: opts('present', 'absent'), default: 'present' },
    { id: 'validate_certs', label: 'Validate the HTTPS certificate', control: 'toggle', default: true },
  ],
  plays: (v) => {
    const devices = rows(v.devices).map(([name = '', role = '', type = '', site = '']) => ({ name, role, type, site }));
    const tags = items(v.tags);
    return compact([
      {
        name: 'Register devices in NetBox',
        hosts: 'localhost',
        connection: 'local',
        gather_facts: false,
        tasks: [
          {
            name: 'Devices',
            'netbox.netbox.netbox_device': {
              netbox_url: v.netbox_url,
              netbox_token: '{{ vault_netbox_token }}',
              validate_certs: on(v.validate_certs),
              data: {
                name: '{{ item.name }}',
                device_role: '{{ item.role }}',
                device_type: '{{ item.type }}',
                site: '{{ item.site }}',
                status: v.status,
                tags: tags.length > 0 ? tags : undefined,
              },
              state: v.state,
            },
            loop: devices,
            loop_control: { label: '{{ item.name }}' },
          },
        ],
      },
    ]);
  },
  needs: () => ({ vault_netbox_token: 'NetBox API token with write access' }),
});

export const NETWORK_PLAYBOOKS: readonly Blueprint[] = [
  IOS_VLANS,
  IOS_PORTS,
  IOS_BASELINE,
  IOS_ACLS,
  IOS_STATIC,
  IOS_OSPF,
  IOS_BGP,
  IOS_BACKUP,
  IOS_FACTS,
  NXOS_SWITCHING,
  EOS_FABRIC,
  IOSXR_ROUTING,
  VYOS_ROUTER,
  FORTIOS_POLICY,
  F5_APP,
  CHECKPOINT_RULE,
  MULTI_BACKUP,
  MULTI_PING,
  INFOBLOX_RECORDS,
  NETBOX_DEVICES,
];

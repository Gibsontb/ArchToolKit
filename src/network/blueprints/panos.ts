/**
 * Palo Alto PAN-OS.
 *
 * Two things make PAN-OS different from a switch. Configuration is staged and
 * then committed, so nothing takes effect until `commit` — which is a gift for
 * safety and a trap for anyone who walks away thinking they are done. And its
 * Ansible modules are object-shaped (`panos_address_object`, `panos_security_rule`)
 * rather than a config-lines module, so the push half names the real module for
 * each change instead of pasting CLI.
 *
 * The configuration emitted here is `set` format, which is what you paste into
 * a CLI session and what Panorama accepts as a bulk import.
 */

import { bool, num, str, type BlueprintValues, type BlueprintGroup } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { PANOS_EXTRA } from './panos-extra.ts';
import { PANOS_EXTRA_2 } from './panos-extra2.ts';
import { listOf, parseCidr, type DeviceChange } from '../device.ts';

const PLATFORM = 'panos' as const;

/** Every push task takes the same provider block, read from the inventory. */
const PROVIDER = '{{ provider }}';

const BLUEPRINTS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'panos_address_objects',
    platform: PLATFORM,
    label: 'Address objects and a group',
    group: 'Objects',
    description: 'Create address objects from a list of prefixes and collect them into a group, so rules refer to names rather than addresses.',
    inputs: [
      { id: 'group_name', label: 'Group name', control: 'text', default: 'GRP-APP-SERVERS' },
      { id: 'addresses', label: 'Addresses', control: 'textarea', default: 'APP-WEB-01 10.20.30.11/32\nAPP-WEB-02 10.20.30.12/32', hint: 'One per line: NAME prefix' },
      { id: 'tag', label: 'Tag', control: 'text', default: 'app-tier', hint: 'Applied to every object; empty for none' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '', hint: 'Empty when configuring a firewall directly' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const group = str(values, 'group_name', 'GRP').toUpperCase().replace(/\s+/g, '-');
      const tag = str(values, 'tag', '');
      const dg = str(values, 'device_group', '');
      const prefix = dg ? `set device-group ${dg}` : 'set';
      const findings: Finding[] = [];

      const entries = str(values, 'addresses', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map(([name, cidr]) => ({ name: String(name), cidr: String(cidr) }));

      for (const entry of entries) {
        if (!parseCidr(entry.cidr)) {
          findings.push(error('network.panos.bad-address', `"${entry.cidr}" for ${entry.name} is not a valid prefix.`, { remediation: 'Write it as 10.20.30.11/32.', source: 'ArchToolKit' }));
        }
      }
      if (entries.length === 0) {
        findings.push(error('network.panos.no-addresses', 'No address objects were given, so this change creates nothing.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `${entries.length} address object(s) and the group ${group}`,
        impact: 'none',
        notes: [
          'Nothing takes effect until the configuration is committed. Objects on their own change no traffic.',
          ...(tag ? [`The tag ${tag} has to exist, or the commit fails. Create it first if it does not.`] : []),
        ],
        before: [`show object address${dg ? ` device-group ${dg}` : ''}`, `show object address-group ${group}`],
        config: [
          ...entries.map((entry) => `${prefix} address ${entry.name} ip-netmask ${entry.cidr}${tag ? ` tag ${tag}` : ''}`),
          `${prefix} address-group ${group} static [ ${entries.map((e) => e.name).join(' ')} ]`,
        ],
        verify: [`show object address-group ${group}`, 'show config diff', 'commit force description "address objects"'],
        backout: [`${prefix.replace('set', 'delete')} address-group ${group}`, ...entries.map((entry) => `${prefix.replace('set', 'delete')} address ${entry.name}`)],
        push: {
          module: 'paloaltonetworks.panos.panos_address_object',
          args: {
            provider: PROVIDER,
            name: '{{ item.name }}',
            value: '{{ item.value }}',
            address_type: 'ip-netmask',
            ...(tag ? { tag: [tag] } : {}),
            ...(dg ? { device_group: dg } : {}),
            state: 'present',
          },
          after: [
            {
              name: `Put the objects in ${group}`,
              module: 'paloaltonetworks.panos.panos_address_group',
              args: { provider: PROVIDER, name: group, static_value: entries.map((e) => e.name), ...(dg ? { device_group: dg } : {}), state: 'present' },
            },
            {
              name: 'Commit the candidate configuration',
              module: 'paloaltonetworks.panos.panos_commit_firewall',
              args: { provider: PROVIDER, description: 'address objects' },
            },
          ],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_security_rule',
    platform: PLATFORM,
    label: 'Security rule',
    group: 'Policy',
    description: 'A security policy rule with zones, addresses, applications and logging — written the App-ID way rather than by port alone.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Allow-App-Web' },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'trust' },
      { id: 'dest_zone', label: 'Destination zone', control: 'text', default: 'dmz' },
      { id: 'source', label: 'Source addresses', control: 'text', default: 'GRP-USERS', hint: 'Object or group names, or "any"' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: 'GRP-APP-SERVERS' },
      { id: 'application', label: 'Applications', control: 'text', default: 'ssl, web-browsing', hint: 'App-IDs, not ports' },
      { id: 'service', label: 'Service', control: 'text', default: 'application-default', hint: 'application-default, or a service object' },
      { id: 'action', label: 'Action', control: 'select', default: 'allow', options: [{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }, { value: 'drop', label: 'Drop' }] },
      { id: 'log_end', label: 'Log at session end', control: 'toggle', default: true },
      { id: 'profile_group', label: 'Security profile group', control: 'text', default: 'default', hint: 'Antivirus, anti-spyware, URL filtering; empty for none' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'rule_name', 'Rule');
      const dg = str(values, 'device_group', '');
      const prefix = dg ? `set device-group ${dg} pre-rulebase` : 'set rulebase';
      const apps = listOf(str(values, 'application', 'any'));
      const source = listOf(str(values, 'source', 'any'));
      const destination = listOf(str(values, 'destination', 'any'));
      const action = str(values, 'action', 'allow');
      const profiles = str(values, 'profile_group', '');
      const logEnd = bool(values, 'log_end', true);
      const findings: Finding[] = [];

      if (apps.includes('any') && action === 'allow') {
        findings.push(
          warning('network.panos.any-application', 'This rule allows any application. That is a hole the size of the zone pair it sits between.', {
            remediation: 'Name the App-IDs the traffic actually uses.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (action === 'allow' && !profiles) {
        findings.push(
          warning('network.panos.no-profiles', 'An allow rule with no security profile group passes the traffic without inspecting it.', {
            remediation: 'Attach the profile group your standard uses.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!logEnd) {
        findings.push(warning('network.panos.no-logging', 'Without log-at-session-end there is no record of what this rule passed.', { source: 'ArchToolKit' }));
      }

      const list = (items: readonly string[]) => `[ ${items.join(' ')} ]`;

      return {
        platform: PLATFORM,
        title: `Security rule ${name}: ${str(values, 'source_zone', '')} → ${str(values, 'dest_zone', '')}`,
        impact: 'brief',
        notes: [
          'Rules are evaluated in order. This is added at the end of the rulebase; move it above whatever would otherwise match first.',
          'Nothing changes until the commit. Check `show config diff` before committing.',
        ],
        before: [`show running security-policy`, `show config diff`],
        config: [
          `${prefix} security rules ${name} from ${list([str(values, 'source_zone', 'any')])}`,
          `${prefix} security rules ${name} to ${list([str(values, 'dest_zone', 'any')])}`,
          `${prefix} security rules ${name} source ${list(source)}`,
          `${prefix} security rules ${name} destination ${list(destination)}`,
          `${prefix} security rules ${name} application ${list(apps)}`,
          `${prefix} security rules ${name} service ${list([str(values, 'service', 'application-default')])}`,
          `${prefix} security rules ${name} action ${action}`,
          `${prefix} security rules ${name} log-end ${logEnd ? 'yes' : 'no'}`,
          ...(profiles ? [`${prefix} security rules ${name} profile-setting group ${list([profiles])}`] : []),
          `${prefix} security rules ${name} description ""`,
        ],
        verify: ['show config diff', `test security-policy-match from ${str(values, 'source_zone', '')} to ${str(values, 'dest_zone', '')} source 10.0.0.1 destination 10.0.0.2 protocol 6 destination-port 443`, 'commit description "security rule"'],
        backout: [`${prefix.replace('set', 'delete')} security rules ${name}`],
        push: {
          module: 'paloaltonetworks.panos.panos_security_rule',
          args: {
            provider: PROVIDER,
            rule_name: name,
            source_zone: [str(values, 'source_zone', 'any')],
            destination_zone: [str(values, 'dest_zone', 'any')],
            source_ip: source,
            destination_ip: destination,
            application: apps,
            service: [str(values, 'service', 'application-default')],
            action,
            log_end: logEnd,
            ...(profiles ? { group_profile: profiles } : {}),
            ...(dg ? { device_group: dg } : {}),
            description: '',
            state: 'present',
          },
          after: [
            { name: 'Commit the candidate configuration', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'security rule' } },
          ],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_nat_rule',
    platform: PLATFORM,
    label: 'NAT rule',
    group: 'Policy',
    description: 'A source NAT (hide behind the interface address) or a destination NAT to publish a server.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'NAT-Outbound' },
      { id: 'nat_type', label: 'Type', control: 'select', default: 'source', options: [{ value: 'source', label: 'Source NAT (outbound)' }, { value: 'destination', label: 'Destination NAT (publish a server)' }] },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'trust' },
      { id: 'dest_zone', label: 'Destination zone', control: 'text', default: 'untrust' },
      { id: 'source', label: 'Source addresses', control: 'text', default: 'GRP-USERS' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: 'any' },
      { id: 'translated', label: 'Translated address', control: 'text', default: '', hint: 'Destination NAT: the internal server. Source NAT: leave empty for interface address' },
      { id: 'translated_port', label: 'Translated port', control: 'number', default: 0, min: 0, max: 65535, hint: '0 for none', showWhen: { input: 'nat_type', equals: ['destination'] } },
      { id: 'interface', label: 'Egress interface', control: 'text', default: 'ethernet1/1', showWhen: { input: 'nat_type', equals: ['source'] } },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = str(values, 'rule_name', 'NAT');
      const type = str(values, 'nat_type', 'source');
      const dg = str(values, 'device_group', '');
      const prefix = dg ? `set device-group ${dg} pre-rulebase` : 'set rulebase';
      const translated = str(values, 'translated', '');
      const port = num(values, 'translated_port', 0);
      const iface = str(values, 'interface', 'ethernet1/1');
      const findings: Finding[] = [];
      if (type === 'destination' && !translated) {
        findings.push(error('network.panos.no-translation', 'A destination NAT needs the internal address to translate to.', { source: 'ArchToolKit' }));
      }

      const common = [
        `${prefix} nat rules ${name} from [ ${str(values, 'source_zone', 'any')} ]`,
        `${prefix} nat rules ${name} to [ ${str(values, 'dest_zone', 'any')} ]`,
        `${prefix} nat rules ${name} source [ ${listOf(str(values, 'source', 'any')).join(' ')} ]`,
        `${prefix} nat rules ${name} destination [ ${listOf(str(values, 'destination', 'any')).join(' ')} ]`,
        `${prefix} nat rules ${name} service any`,
      ];

      const body =
        type === 'source'
          ? [`${prefix} nat rules ${name} source-translation dynamic-ip-and-port interface-address interface ${iface}`]
          : [
              `${prefix} nat rules ${name} destination-translation translated-address ${translated}`,
              ...(port > 0 ? [`${prefix} nat rules ${name} destination-translation translated-port ${port}`] : []),
            ];

      return {
        platform: PLATFORM,
        title: `${type === 'source' ? 'Source' : 'Destination'} NAT ${name}`,
        impact: 'brief',
        notes: [
          'NAT is evaluated before security policy, and the security rule that permits the traffic uses the pre-NAT address with the post-NAT zone. A NAT rule alone passes nothing.',
          'Nothing takes effect until the commit.',
        ],
        before: ['show running nat-policy', 'show config diff'],
        config: [...common, ...body, `${prefix} nat rules ${name} description ""`],
        verify: ['show running nat-policy', 'show session all filter nat-rule ' + name, 'commit description "NAT rule"'],
        backout: [`${prefix.replace('set', 'delete')} nat rules ${name}`],
        push: {
          module: 'paloaltonetworks.panos.panos_nat_rule2',
          args: {
            provider: PROVIDER,
            name,
            source_zone: [str(values, 'source_zone', 'any')],
            destination_zone: str(values, 'dest_zone', 'any'),
            source_address: listOf(str(values, 'source', 'any')),
            destination_address: listOf(str(values, 'destination', 'any')),
            ...(type === 'source'
              ? { source_translation_type: 'dynamic-ip-and-port', source_translation_address_type: 'interface-address', source_translation_interface: iface }
              : { destination_translated_address: translated, ...(port > 0 ? { destination_translated_port: port } : {}) }),
            ...(dg ? { device_group: dg } : {}),
            state: 'present',
          },
          after: [{ name: 'Commit the candidate configuration', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'NAT rule' } }],
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_interface_zone',
    platform: PLATFORM,
    label: 'Layer 3 interface and zone',
    group: 'Network',
    description: 'A layer 3 interface with an address, put into a zone and a virtual router, with a management profile that allows only what it should.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'ethernet1/2' },
      { id: 'address', label: 'Address', control: 'text', default: '10.20.30.1/24' },
      { id: 'zone', label: 'Zone', control: 'text', default: 'dmz' },
      { id: 'virtual_router', label: 'Virtual router', control: 'text', default: 'default' },
      { id: 'mgmt_profile', label: 'Interface management profile', control: 'text', default: '', hint: 'Empty means no management on this interface, which is usually right' },
      { id: 'comment', label: 'Comment', control: 'text', default: 'DMZ' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const iface = str(values, 'interface', 'ethernet1/2');
      const cidr = parseCidr(str(values, 'address', ''));
      const zone = str(values, 'zone', 'dmz');
      const vr = str(values, 'virtual_router', 'default');
      const profile = str(values, 'mgmt_profile', '');
      const findings: Finding[] = [];
      if (!cidr) findings.push(error('network.panos.bad-interface-address', 'The interface address is not a valid address and prefix.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `Interface ${iface} in zone ${zone}`,
        impact: 'brief',
        notes: [
          'A new zone has no security rules, so nothing passes through it until a rule is written. That is the safe order: interface, zone, then policy.',
          ...(profile ? [`The management profile ${profile} decides what answers on this interface. Make sure it does not allow anything you would not want exposed there.`] : []),
        ],
        before: [`show interface ${iface}`, 'show running security-policy'],
        config: [
          `set network interface ethernet ${iface} layer3 ip ${cidr ? `${cidr.address}/${cidr.prefix}` : '<REQUIRED>'}`,
          `set network interface ethernet ${iface} comment "${str(values, 'comment', 'Managed')}"`,
          ...(profile ? [`set network interface ethernet ${iface} layer3 interface-management-profile ${profile}`] : []),
          `set zone ${zone} network layer3 [ ${iface} ]`,
          `set network virtual-router ${vr} interface [ ${iface} ]`,
        ],
        verify: [`show interface ${iface}`, `show routing route virtual-router ${vr}`, 'commit description "interface and zone"'],
        backout: [`delete network virtual-router ${vr} interface ${iface}`, `delete zone ${zone} network layer3 ${iface}`, `delete network interface ethernet ${iface}`],
        push: {
          module: 'paloaltonetworks.panos.panos_interface',
          args: {
            provider: PROVIDER,
            if_name: iface,
            mode: 'layer3',
            ip: [cidr ? `${cidr.address}/${cidr.prefix}` : ''],
            zone_name: zone,
            vr_name: vr,
            ...(profile ? { management_profile: profile } : {}),
            comment: str(values, 'comment', 'Managed'),
            state: 'present',
          },
          after: [{ name: 'Commit the candidate configuration', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'interface' } }],
        },
        findings,
      };
    },
  }),
];

/** The rest of the platform's changes live in panos-extra.ts. */
const ALL: readonly ChangeBlueprint[] = [...BLUEPRINTS, ...PANOS_EXTRA, ...PANOS_EXTRA_2];

export const PANOS_NETWORK: BlueprintGroup = { target: PLATFORM, label: 'Palo Alto PAN-OS', blueprints: ALL };
export const PANOS_CHANGES: readonly ChangeBlueprint[] = ALL;

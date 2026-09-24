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
import { listOf, parseCidrDual, type DeviceChange } from '../device.ts';
import { badAddresses, badAddressFinding, familiesOf, ipv6Unsupported, PANOS_VERSION, testAddresses } from './panos-ip.ts';

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
      { id: 'addresses', label: 'Addresses', control: 'textarea', default: 'APP-WEB-01 10.20.30.11/32\nAPP-WEB-02 10.20.30.12/32', hint: 'One per line: NAME prefix (IPv4 or IPv6)' },
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

      // ip-netmask takes either family, and one group can hold both.
      for (const entry of entries) {
        if (!parseCidrDual(entry.cidr)) {
          findings.push(error('network.panos.bad-address', `"${entry.cidr}" for ${entry.name} is not a valid prefix.`, { remediation: 'Write it as 10.20.30.11/32 or 2001:db8::11/128.', source: 'ArchToolKit' }));
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
      { id: 'source', label: 'Source addresses', control: 'text', default: 'GRP-USERS', hint: 'Object or group names, IPv4 or IPv6 prefixes, or "any"' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: 'GRP-APP-SERVERS', hint: 'Object or group names, IPv4 or IPv6 prefixes, or "any"' },
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
      // A security rule may name IPv4 and IPv6 addresses side by side; each
      // session matches the entries of its own family.
      const bad = badAddresses([...source, ...destination]);
      if (bad.length > 0) findings.push(badAddressFinding('Source and destination', bad));

      const list = (items: readonly string[]) => `[ ${items.join(' ')} ]`;
      const probe = testAddresses(source, destination);

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
        verify: ['show config diff', `test security-policy-match from ${str(values, 'source_zone', '')} to ${str(values, 'dest_zone', '')} source ${probe.source} destination ${probe.destination} protocol 6 destination-port 443`, 'commit description "security rule"'],
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
      { id: 'nat_type', label: 'Type', control: 'select', default: 'source', options: [
        { value: 'source', label: 'Source NAT (outbound, IPv4)' },
        { value: 'destination', label: 'Destination NAT (publish a server, IPv4)' },
        { value: 'nptv6', label: 'NPTv6 (IPv6 prefix translation)' },
      ] },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'trust' },
      { id: 'dest_zone', label: 'Destination zone', control: 'text', default: 'untrust' },
      { id: 'source', label: 'Source addresses', control: 'text', default: 'GRP-USERS', hint: 'NPTv6: the internal IPv6 prefix' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: 'any' },
      { id: 'translated', label: 'Translated address', control: 'text', default: '', hint: 'Destination NAT: the internal server. Source NAT: leave empty for interface address. NPTv6: the external IPv6 prefix, same length as the internal one' },
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
      const source = listOf(str(values, 'source', 'any'));
      const destination = listOf(str(values, 'destination', 'any'));
      const findings: Finding[] = [];
      if (type === 'destination' && !translated) {
        findings.push(error('network.panos.no-translation', 'A destination NAT needs the internal address to translate to.', { source: 'ArchToolKit' }));
      }
      const bad = badAddresses([...source, ...destination, ...(translated ? [translated] : [])]);
      if (bad.length > 0) findings.push(badAddressFinding('NAT addresses', bad));

      // A NAT rule translates one family. nat-type ipv4 (the default, and what
      // source and destination NAT here are) is IPv4 only: IPv6-to-IPv6 is
      // NPTv6, IPv6-to-IPv4 is NAT64, and neither is dynamic-IP-and-port.
      const families = familiesOf([...source, ...destination, ...(translated ? [translated] : [])]);
      const nptv6 = type === 'nptv6';
      if (!nptv6 && families.has(6)) {
        findings.push(
          ipv6Unsupported('network.panos.nat-ipv6', `${type === 'source' ? 'Source NAT (dynamic IP and port)' : 'Destination NAT (nat-type ipv4)'}`, 'Use NPTv6 for IPv6-to-IPv6 prefix translation. NAT64 is supported by the firewall but not generated here.'),
        );
      }
      const translatedPrefix = nptv6 ? parseCidrDual(translated) : null;
      if (nptv6) {
        if (families.has(4)) findings.push(error('network.panos.nptv6-ipv4', 'An NPTv6 rule translates IPv6 prefixes only; it cannot also name IPv4 addresses.', { source: 'ArchToolKit' }));
        if (!translatedPrefix || translatedPrefix.family !== 6) {
          findings.push(error('network.panos.nptv6-translated', 'NPTv6 needs the external IPv6 prefix to translate to, such as 2001:db8:ffff::/48.', { source: 'ArchToolKit' }));
        }
        // RFC 6296 translation is checksum-neutral only between prefixes of one length.
        for (const item of source) {
          const inside = parseCidrDual(item);
          if (inside && inside.family === 6 && translatedPrefix && inside.prefix !== translatedPrefix.prefix) {
            findings.push(error('network.panos.nptv6-length', `NPTv6 maps a prefix to one of the same length: ${item} is a /${inside.prefix} and ${translated} is a /${translatedPrefix.prefix}.`, { source: 'ArchToolKit' }));
          }
        }
        if (source.includes('any')) {
          findings.push(warning('network.panos.nptv6-any', 'An NPTv6 rule should name the internal IPv6 prefix it translates, not "any".', { source: 'ArchToolKit' }));
        }
      }

      const common = [
        ...(nptv6 ? [`${prefix} nat rules ${name} nat-type nptv6`] : []),
        `${prefix} nat rules ${name} from [ ${str(values, 'source_zone', 'any')} ]`,
        `${prefix} nat rules ${name} to [ ${str(values, 'dest_zone', 'any')} ]`,
        `${prefix} nat rules ${name} source [ ${source.join(' ')} ]`,
        `${prefix} nat rules ${name} destination [ ${destination.join(' ')} ]`,
        `${prefix} nat rules ${name} service any`,
      ];

      const body =
        type === 'source'
          ? [`${prefix} nat rules ${name} source-translation dynamic-ip-and-port interface-address interface ${iface}`]
          : nptv6
            ? [
                `${prefix} nat rules ${name} source-translation static-ip translated-address ${translatedPrefix ? `${translatedPrefix.network}/${translatedPrefix.prefix}` : '<REQUIRED>'}`,
                `${prefix} nat rules ${name} source-translation static-ip bi-directional yes`,
              ]
            : [
                `${prefix} nat rules ${name} destination-translation translated-address ${translated}`,
                ...(port > 0 ? [`${prefix} nat rules ${name} destination-translation translated-port ${port}`] : []),
              ];

      return {
        platform: PLATFORM,
        title: `${type === 'source' ? 'Source' : type === 'nptv6' ? 'NPTv6' : 'Destination'} NAT ${name}`,
        impact: 'brief',
        notes: [
          'NAT is evaluated before security policy, and the security rule that permits the traffic uses the pre-NAT address with the post-NAT zone. A NAT rule alone passes nothing.',
          'Nothing takes effect until the commit.',
          ...(nptv6
            ? [
                'NPTv6 rewrites the prefix only, statelessly, so the translation is one to one. Bi-directional lets the outside reach the inside by the translated prefix as well — the security rule still decides whether it may.',
                `VERIFY: the egress interface must answer neighbour discovery for the translated prefix (NDP proxy on the interface), and ${PANOS_VERSION} limits the prefix lengths NPTv6 accepts. Check both against the release before committing.`,
              ]
            : []),
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
            source_address: source,
            destination_address: destination,
            ...(type === 'source'
              ? { source_translation_type: 'dynamic-ip-and-port', source_translation_address_type: 'interface-address', source_translation_interface: iface }
              : nptv6
                ? {
                    nat_type: 'nptv6',
                    source_translation_type: 'static-ip',
                    source_translation_static_translated_address: translatedPrefix ? `${translatedPrefix.network}/${translatedPrefix.prefix}` : '',
                    source_translation_static_bi_directional: true,
                  }
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
      { id: 'address', label: 'Address', control: 'text', default: '10.20.30.1/24', hint: 'IPv4, IPv6 or both for dual stack, comma separated: 10.20.30.1/24, 2001:db8:30::1/64' },
      { id: 'zone', label: 'Zone', control: 'text', default: 'dmz' },
      { id: 'virtual_router', label: 'Virtual router', control: 'text', default: 'default' },
      { id: 'mgmt_profile', label: 'Interface management profile', control: 'text', default: '', hint: 'Empty means no management on this interface, which is usually right' },
      { id: 'comment', label: 'Comment', control: 'text', default: 'DMZ' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const iface = str(values, 'interface', 'ethernet1/2');
      const typed = listOf(str(values, 'address', ''));
      const cidrs = typed.map((text) => parseCidrDual(text));
      const v4 = cidrs.filter((c) => c !== null && c.family === 4).map((c) => `${c!.address}/${c!.prefix}`);
      const v6 = cidrs.filter((c) => c !== null && c.family === 6).map((c) => `${c!.address}/${c!.prefix}`);
      const zone = str(values, 'zone', 'dmz');
      const vr = str(values, 'virtual_router', 'default');
      const profile = str(values, 'mgmt_profile', '');
      const findings: Finding[] = [];
      if (typed.length === 0 || cidrs.some((c) => c === null)) {
        findings.push(error('network.panos.bad-interface-address', 'The interface address is not a valid address and prefix.', { remediation: 'Write it as 10.20.30.1/24, 2001:db8:30::1/64, or both separated by a comma.', source: 'ArchToolKit' }));
      }
      const base = `set network interface ethernet ${iface} layer3`;

      return {
        platform: PLATFORM,
        title: `Interface ${iface} in zone ${zone}`,
        impact: 'brief',
        notes: [
          'A new zone has no security rules, so nothing passes through it until a rule is written. That is the safe order: interface, zone, then policy.',
          ...(profile ? [`The management profile ${profile} decides what answers on this interface. Make sure it does not allow anything you would not want exposed there.`] : []),
          ...(v6.length > 0
            ? [
                'IPv6 is enabled on the interface with its global address; the link-local address is derived automatically. Hosts on the segment still need router advertisements or DHCPv6 from somewhere to learn their default route.',
                'The zone and every rule it takes part in apply to IPv6 as well. Check that the rules name the IPv6 prefixes too, or IPv6 traffic falls through to the default deny.',
              ]
            : []),
        ],
        before: [`show interface ${iface}`, 'show running security-policy'],
        config: [
          ...(v4.length > 0 ? v4.map((address) => `${base} ip ${address}`) : v6.length > 0 ? [] : [`${base} ip <REQUIRED>`]),
          ...(v6.length > 0 ? [`${base} ipv6 enabled yes`, ...v6.map((address) => `${base} ipv6 address ${address} enable-on-interface yes`)] : []),
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
            ip: v4.length > 0 ? v4 : v6.length > 0 ? [] : [''],
            zone_name: zone,
            vr_name: vr,
            ...(profile ? { management_profile: profile } : {}),
            comment: str(values, 'comment', 'Managed'),
            state: 'present',
          },
          after: [
            // panos_interface takes IPv4 addresses only, so the IPv6 half is
            // set at its XPath: enabled, and each address enabled on the interface.
            ...(v6.length > 0
              ? [
                  {
                    name: `IPv6 on ${iface}`,
                    module: 'paloaltonetworks.panos.panos_type_cmd',
                    args: {
                      provider: PROVIDER,
                      cmd: 'set',
                      xpath: `/config/devices/entry[@name='localhost.localdomain']/network/interface/ethernet/entry[@name='${iface}']/layer3/ipv6`,
                      element: `<enabled>yes</enabled><address>${v6.map((address) => `<entry name="${address}"><enable-on-interface>yes</enable-on-interface></entry>`).join('')}</address>`,
                    },
                  },
                ]
              : []),
            { name: 'Commit the candidate configuration', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'interface' } },
          ],
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

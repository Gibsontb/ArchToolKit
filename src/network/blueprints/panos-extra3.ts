/**
 * Palo Alto PAN-OS: Panorama.
 *
 * The other files build a firewall's own configuration, and several of them
 * take a device group so the same objects and rules can be written on
 * Panorama instead. What was missing is Panorama itself: the device group
 * those changes name, the template and template stack that carry the network
 * and device settings, and the firewall side of the connection that makes a
 * firewall managed at all.
 *
 * Panorama is configured with the same `set` syntax as a firewall, with the
 * firewall's configuration nested under `device-group <name>` (policy and
 * objects) or `template <name> config` (network and device). A commit on
 * Panorama changes Panorama only; nothing reaches a firewall until it is
 * pushed (`commit-all`), which each change here says.
 *
 * Nothing here writes a credential: the firewall's Panorama auth key is an
 * operational command, and it is `<REQUIRED>`.
 */

import { bool, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { listOf, type DeviceChange } from '../device.ts';
import { isIp } from '../../core/ip.ts';

const PLATFORM = 'panos' as const;
const PROVIDER = '{{ provider }}';
const SECRET = '<REQUIRED>';

/** A Panorama object name: no spaces, and not one PAN-OS keeps for itself. */
const objectName = (value: string, fallback: string): string => (value.trim() || fallback).replace(/\s+/g, '-');

/** Hardware serials are 12 digits; VM-Series 15. */
const isSerial = (value: string): boolean => /^\d{12,15}$/.test(value);

function serialFindings(serials: readonly string[], code: string): Finding[] {
  const bad = serials.filter((s) => !isSerial(s));
  return bad.length > 0
    ? [error(code, `Not a firewall serial number: ${bad.join(', ')}.`, { remediation: 'A hardware firewall serial is 12 digits, a VM-Series one 15: `show system info | match serial` on the firewall.', source: 'ArchToolKit' })]
    : [];
}

export const PANOS_EXTRA_3: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'panos_panorama_device_group',
    platform: PLATFORM,
    label: 'Panorama device group',
    group: 'Panorama',
    description: 'A device group on Panorama — where the policy and objects for a set of firewalls live — with its firewalls added as managed devices and the User-ID master that group mapping reads from.',
    inputs: [
      { id: 'device_group', label: 'Device group name', control: 'text', default: 'DG-BRANCH' },
      { id: 'description', label: 'Description', control: 'text', default: 'Branch firewalls' },
      { id: 'parent', label: 'Parent device group', control: 'text', default: '', hint: 'Empty for Shared. Set with an operational command after the commit' },
      { id: 'serials', label: 'Firewall serial numbers', control: 'textarea', default: '012801012345\n012801012346', hint: 'One per line or comma separated' },
      { id: 'add_managed', label: 'Add them as managed devices too', control: 'toggle', default: true },
      { id: 'master_device', label: 'User-ID master device', control: 'text', default: '', hint: 'The serial whose group mapping policy uses. Empty for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const dg = objectName(str(values, 'device_group', ''), 'DG');
      const parent = str(values, 'parent', '').trim().replace(/\s+/g, '-');
      const serials = listOf(str(values, 'serials', '').replace(/\n/g, ','));
      const master = str(values, 'master_device', '').trim();
      const findings: Finding[] = [...serialFindings(serials, 'network.panos.bad-serial')];
      if (/^(shared|predefined)$/i.test(dg)) findings.push(error('network.panos.reserved-dg', `"${dg}" is reserved on Panorama and cannot be a device group name.`, { source: 'ArchToolKit' }));
      if (dg.length > 31) findings.push(error('network.panos.dg-name-length', 'A device group name is at most 31 characters.', { source: 'ArchToolKit' }));
      if (parent && parent === dg) findings.push(error('network.panos.dg-own-parent', 'A device group cannot be its own parent.', { source: 'ArchToolKit' }));
      if (serials.length === 0) {
        findings.push(warning('network.panos.dg-empty', 'A device group with no firewalls pushes to nothing. That is fine while building, but a commit-all to it does nothing.', { source: 'ArchToolKit' }));
      }
      if (master && !serials.includes(master)) {
        findings.push(error('network.panos.master-not-member', `The User-ID master device ${master} is not one of the firewalls in this device group.`, { source: 'ArchToolKit' }));
      }
      const prefix = `set device-group ${dg}`;

      return {
        platform: PLATFORM,
        title: `Panorama device group ${dg} with ${serials.length} firewall${serials.length === 1 ? '' : 's'}`,
        impact: 'none',
        notes: [
          'This is Panorama configuration. Paste it into Panorama in configure mode, not into a firewall.',
          'Each firewall has to point at Panorama too (the Panorama connection step), and show as connected, before a push reaches it.',
          'A firewall is in exactly one device group. Adding one that is already in another moves it, and its next push replaces its policy with this group’s.',
          parent
            ? `The parent is set after the commit, from operational mode: \`request move-dg element ${dg} new-parent-dg ${parent}\`. A device group inherits the parent’s objects and rules.`
            : 'With no parent it sits directly under Shared, and inherits only Shared objects and rules.',
          `Nothing reaches the firewalls until the push: \`commit\` on Panorama, then \`commit-all shared-policy device-group ${dg}\`. Push to one firewall first with \`include-template yes\` off and look at the result.`,
          'To bring an existing firewall’s rules in rather than start empty, use Panorama > Setup > Operations > Import device configuration, not this.',
        ],
        before: ['show devicegroups', 'show devices all', 'show config running xpath devices/entry/device-group'],
        config: [
          ...(bool(values, 'add_managed', true) ? serials.map((s) => `set mgt-config devices ${s}`) : []),
          `${prefix} description "${str(values, 'description', '').replace(/"/g, '')}"`,
          ...serials.map((s) => `${prefix} devices ${s}`),
          ...(master ? [`${prefix} master-device device ${master}`] : []),
        ],
        verify: [
          'show config diff',
          `show devicegroups name ${dg}`,
          'commit description "device group"',
          ...(parent ? [`request move-dg element ${dg} new-parent-dg ${parent}`] : []),
          `commit-all shared-policy device-group ${dg}`,
          'show jobs all',
          'On a firewall: show config pushed-shared-policy',
        ],
        backout: [
          `delete device-group ${dg}`,
          ...(bool(values, 'add_managed', true) ? serials.map((s) => `delete mgt-config devices ${s}`) : []),
          '# then commit on Panorama. The firewalls keep the policy last pushed until something else is pushed to them.',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_panorama_template',
    platform: PLATFORM,
    label: 'Panorama template and template stack',
    group: 'Panorama',
    description: 'A template carrying the network and device settings — DNS, NTP, time zone, an interface and its zone — and the template stack that combines it with others and assigns it to firewalls.',
    inputs: [
      { id: 'template', label: 'Template name', control: 'text', default: 'T-BRANCH' },
      { id: 'stack', label: 'Template stack name', control: 'text', default: 'TS-BRANCH' },
      { id: 'other_templates', label: 'Other templates in the stack, below this one', control: 'text', default: 'T-GLOBAL', hint: 'Lower priority than this one. Empty for none' },
      { id: 'serials', label: 'Firewall serial numbers', control: 'textarea', default: '012801012345\n012801012346' },
      { id: 'dns_primary', label: 'Primary DNS', control: 'text', default: '10.0.0.53' },
      { id: 'dns_secondary', label: 'Secondary DNS', control: 'text', default: '10.0.0.54' },
      { id: 'ntp_primary', label: 'Primary NTP', control: 'text', default: '10.0.0.10' },
      { id: 'ntp_secondary', label: 'Secondary NTP', control: 'text', default: '10.0.0.11' },
      { id: 'timezone', label: 'Time zone', control: 'text', default: 'UTC' },
      { id: 'use_variables', label: 'Use template variables for DNS', control: 'toggle', default: true, hint: 'So one firewall can override the value without its own template' },
      { id: 'interface', label: 'Interface to define', control: 'text', default: 'ethernet1/2', hint: 'Empty for none' },
      { id: 'interface_ip', label: 'Interface address', control: 'text', default: '10.20.30.1/24', showWhen: { input: 'interface', notEquals: [''] } },
      { id: 'zone', label: 'Zone for it', control: 'text', default: 'trust', showWhen: { input: 'interface', notEquals: [''] } },
      { id: 'virtual_router', label: 'Virtual router', control: 'text', default: 'default', showWhen: { input: 'interface', notEquals: [''] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const template = objectName(str(values, 'template', ''), 'T');
      const stack = objectName(str(values, 'stack', ''), 'TS');
      const others = listOf(str(values, 'other_templates', '')).map((t) => objectName(t, 'T'));
      const serials = listOf(str(values, 'serials', '').replace(/\n/g, ','));
      const dns1 = str(values, 'dns_primary', '').trim();
      const dns2 = str(values, 'dns_secondary', '').trim();
      const ntp1 = str(values, 'ntp_primary', '').trim();
      const ntp2 = str(values, 'ntp_secondary', '').trim();
      const vars = bool(values, 'use_variables', true);
      const iface = str(values, 'interface', '').trim();
      const ifaceIp = str(values, 'interface_ip', '').trim();
      const zone = str(values, 'zone', 'trust').trim();
      const vr = str(values, 'virtual_router', 'default').trim();
      const findings: Finding[] = [...serialFindings(serials, 'network.panos.bad-serial')];
      if (template === stack) findings.push(error('network.panos.template-stack-same', 'A template and a template stack share one namespace on Panorama: they cannot have the same name.', { source: 'ArchToolKit' }));
      if (others.includes(template)) findings.push(error('network.panos.template-twice', 'The template is listed twice in the stack.', { source: 'ArchToolKit' }));
      for (const [label, value] of [['primary DNS', dns1], ['secondary DNS', dns2], ['primary NTP', ntp1]] as const) {
        if (value && !isIp(value) && !(label.includes('NTP') && /^[A-Za-z0-9.-]+$/.test(value))) findings.push(error('network.panos.bad-template-server', `The ${label} "${value}" is not an address.`, { source: 'ArchToolKit' }));
      }
      if (!ntp2) findings.push(warning('network.panos.single-ntp', 'One NTP server: log times, certificate checks and User-ID all depend on the clock.', { source: 'ArchToolKit' }));
      if (serials.length === 0) findings.push(warning('network.panos.stack-empty', 'The stack is assigned to no firewalls, so a push does nothing yet.', { source: 'ArchToolKit' }));
      if (iface && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(ifaceIp)) {
        findings.push(error('network.panos.bad-template-interface-ip', `The interface address "${ifaceIp}" is not an IPv4 address with a prefix.`, { remediation: 'Write it as 10.20.30.1/24, or give each firewall its own address with a template variable.', source: 'ArchToolKit' }));
      }
      if (iface && serials.length > 1) {
        findings.push(warning('network.panos.template-shared-ip', `The interface address ${ifaceIp} is in a template shared by ${serials.length} firewalls: every one of them gets the same address.`, { remediation: 'Use a template variable for the address and override it per device (Panorama > Managed Devices > Variables), or keep per-site addressing in a per-site template.', source: 'ArchToolKit' }));
      }

      const t = `set template ${template}`;
      const dnsValue = (which: 'primary' | 'secondary', value: string) => (vars ? `$dns-${which}` : value);
      const config = [
        `${t} description "Built for ${stack}"`,
        `${t} settings default-vsys vsys1`,
        ...(vars && dns1 ? [`${t} variable $dns-primary type ip-netmask ${dns1}`] : []),
        ...(vars && dns2 ? [`${t} variable $dns-secondary type ip-netmask ${dns2}`] : []),
        ...(dns1 ? [`${t} config deviceconfig system dns-setting servers primary ${dnsValue('primary', dns1)}`] : []),
        ...(dns2 ? [`${t} config deviceconfig system dns-setting servers secondary ${dnsValue('secondary', dns2)}`] : []),
        ...(ntp1 ? [`${t} config deviceconfig system ntp-servers primary-ntp-server ntp-server-address ${ntp1}`] : []),
        ...(ntp2 ? [`${t} config deviceconfig system ntp-servers secondary-ntp-server ntp-server-address ${ntp2}`] : []),
        `${t} config deviceconfig system timezone ${str(values, 'timezone', 'UTC').trim() || 'UTC'}`,
        ...(iface
          ? [
              `${t} config network interface ethernet ${iface} layer3 ip ${ifaceIp}`,
              `${t} config network virtual-router ${vr} interface ${iface}`,
              `${t} config vsys vsys1 zone ${zone} network layer3 ${iface}`,
              `${t} config vsys vsys1 import network interface ${iface}`,
            ]
          : []),
        `set template-stack ${stack} templates [ ${[template, ...others].join(' ')} ]`,
        `set template-stack ${stack} settings default-vsys vsys1`,
        ...serials.map((s) => `set template-stack ${stack} devices ${s}`),
      ];

      return {
        platform: PLATFORM,
        title: `Panorama template ${template} in stack ${stack}`,
        impact: iface ? 'brief' : 'none',
        notes: [
          'This is Panorama configuration: paste it into Panorama in configure mode.',
          `Templates higher in the stack win. ${template} is first, so its values override ${others.length > 0 ? others.join(', ') : 'anything added below it later'}.`,
          'A value configured locally on a firewall overrides the template. If the push appears not to take, check for a local override (the green gear icon is the template; anything else is local).',
          ...(vars ? ['The DNS servers are template variables: override one per firewall under Panorama > Managed Devices > Summary > Variables without a template of its own.'] : []),
          ...(iface ? [`Pushing an interface and a zone to a firewall that already has ${iface} configured locally leaves the local one in force. Remove the local configuration, or import it, before the first push.`] : []),
          `Nothing reaches the firewalls until the push: \`commit\` on Panorama, then \`commit-all template-stack ${stack}\`.`,
          'The objects, policy and security profiles that go with this belong in the device group, not the template.',
        ],
        before: ['show template-stack', 'show templates', 'show devices all', 'On a firewall: show config pushed-template'],
        config,
        verify: [
          'show config diff',
          `show template-stack ${stack}`,
          `show template ${template}`,
          'commit description "template"',
          `commit-all template-stack ${stack}`,
          'show jobs all',
          'On a firewall: show config pushed-template | match dns-setting',
        ],
        backout: [
          `delete template-stack ${stack}`,
          `delete template ${template}`,
          '# then commit on Panorama and push. Removing a template removes what it pushed from the firewalls on the next push, so re-create anything they still need locally first.',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_panorama_connect',
    platform: PLATFORM,
    label: 'Connect a firewall to Panorama',
    group: 'Panorama',
    description: 'The firewall side of Panorama management: the Panorama servers it connects to, and the auth key that lets it register.',
    inputs: [
      { id: 'panorama_primary', label: 'Panorama', control: 'text', default: '10.0.0.50' },
      { id: 'panorama_secondary', label: 'Panorama HA peer', control: 'text', default: '10.0.0.51', hint: 'Empty for a single Panorama' },
      { id: 'version', label: 'PAN-OS version on the firewall', control: 'select', default: '10', options: [
        { value: '10', label: '10.0 or later (local-panorama)' },
        { value: '9', label: '9.1 or earlier' },
      ] },
      { id: 'auth_key', label: 'Register with a device auth key', control: 'toggle', default: true, hint: 'Required from 10.1 on' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const primary = str(values, 'panorama_primary', '').trim();
      const secondary = str(values, 'panorama_secondary', '').trim();
      const modern = str(values, 'version', '10') === '10';
      const authKey = bool(values, 'auth_key', true);
      const findings: Finding[] = [];
      if (!isIp(primary) && !/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(primary)) findings.push(error('network.panos.bad-panorama', `"${primary}" is not an address or a name.`, { source: 'ArchToolKit' }));
      if (secondary && secondary === primary) findings.push(error('network.panos.same-panorama', 'The primary and the HA peer are the same Panorama.', { source: 'ArchToolKit' }));
      if (!secondary) findings.push(warning('network.panos.single-panorama', 'One Panorama: while it is down the firewalls keep running, but nothing can be pushed and logs queue on the firewall until it is back.', { source: 'ArchToolKit' }));
      if (modern && !authKey) {
        findings.push(warning('network.panos.no-auth-key', 'From PAN-OS 10.1 a firewall has to present a device registration auth key generated on Panorama, or Panorama refuses the connection.', { remediation: 'Generate one on Panorama (request authkey add name <name> lifetime <minutes> count <n>) and set it on the firewall.', source: 'ArchToolKit' }));
      }
      const base = modern ? 'set deviceconfig system panorama local-panorama' : 'set deviceconfig system';

      return {
        platform: PLATFORM,
        title: `Manage this firewall from Panorama ${primary}${secondary ? ` / ${secondary}` : ''}`,
        impact: 'none',
        notes: [
          'This is firewall configuration. Panorama has to know the firewall too: add its serial as a managed device (the device group step) before the commit here.',
          'The firewall connects out to Panorama on TCP 3978 from its management interface (or a service route). The firewall rules in between have to allow it.',
          ...(authKey ? [`Before the commit, set the auth key from operational mode: \`request authkey set ${SECRET}\`, the key generated on Panorama. It is used once, at registration.`] : []),
          'Connecting does not change the firewall’s policy. That changes when Panorama first pushes a device group or template to it — do the import (Panorama > Setup > Operations > Import device configuration) before that first push, or the push replaces what the firewall has.',
        ],
        before: ['show panorama-status', 'show config running xpath deviceconfig/system/panorama', 'show system info | match serial'],
        config: [
          `${base} panorama-server ${primary}`,
          ...(secondary ? [`${base} panorama-server-2 ${secondary}`] : []),
        ],
        verify: ['show config diff', 'commit description "panorama connection"', 'show panorama-status', 'On Panorama: show devices connected'],
        backout: [modern ? 'delete deviceconfig system panorama' : 'delete deviceconfig system panorama-server', ...(secondary && !modern ? ['delete deviceconfig system panorama-server-2'] : [])],
        push: {
          module: 'paloaltonetworks.panos.panos_mgtconfig',
          args: { provider: PROVIDER, panorama_primary: primary, ...(secondary ? { panorama_secondary: secondary } : {}), commit: false },
          after: [{ name: 'Commit', module: 'paloaltonetworks.panos.panos_commit_firewall', args: { provider: PROVIDER, description: 'panorama connection' } }],
        },
        findings,
      };
    },
  }),
];

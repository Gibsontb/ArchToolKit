/**
 * F5 BIG-IP: onboarding, the part AS3 cannot do.
 *
 * AS3 configures applications inside tenants. Everything a tenant stands on —
 * the hostname, DNS and NTP, which modules are provisioned, the VLANs, self IPs
 * and routes, route domains, and the HA pair — lives in /Common and is out of
 * AS3's reach. F5's own answer for that is Declarative Onboarding (DO).
 *
 * These are written as tmsh, not as DO declarations, on purpose:
 *
 *   - a DO declaration is a different document from AS3 (class Device, not
 *     ADC). The change list's whole-device file merges AS3 declarations by
 *     tenant, and a DO document fed into that merge would put /Common network
 *     objects into an AS3 declaration that AS3 would reject. As a tmsh script
 *     the step is a `.sh` file of its own, and the merge leaves it out with a
 *     warning rather than corrupting the declaration;
 *   - onboarding is done once per device and in a set order (provision, then
 *     network, then HA), which is what a script says and a single declaration
 *     hides;
 *   - each line can be read against `tmsh list` output, and each has an exact
 *     inverse for the back-out.
 *
 * Where a playbook is generated it uses f5networks.f5_modules.bigip_command,
 * which runs the same tmsh (it strips the `tmsh` prefix itself), or
 * bigip_provision for provisioning, which waits for the module restart. The HA
 * pair has no playbook: it is built on two units in a set order, one side of
 * the trust from one unit only, and a play against the whole group would do it
 * twice.
 *
 * The APM access profile is the exception: it is an application object, and
 * AS3 carries it (Access_Profile imported from an exported policy).
 *
 * No credential is written. Where tmsh needs one it is `<REQUIRED>`.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { listOf, netmask, parseCidrDual, type DeviceChange } from '../device.ts';
import { familyOf, formatHostPort, isIp, parseCidrAny } from '../../core/ip.ts';
import { as3Members, parseMembers, virtualFindings } from './f5-common.ts';

const PLATFORM = 'f5' as const;
const SECRET = '<REQUIRED>';

/** A tmsh object name: letters, digits, dot, dash, underscore. */
const name = (value: string, fallback: string): string => (value.trim() || fallback).replace(/[^A-Za-z0-9_.-]/g, '_');

/** A UCS taken first is the one back-out that covers everything in /Common. */
const ucs = (label: string): string => `pre-${label}`;
const saveUcs = (label: string): string => `tmsh save sys ucs ${ucs(label)}.ucs`;
const loadUcs = (label: string): string => `tmsh load sys ucs ${ucs(label)}.ucs no-license`;

/** The tmsh lines of a script, as bigip_command takes them (it adds `tmsh` itself). */
function tmshCommands(config: readonly string[]): string[] {
  return config
    .map((line) => line.trim())
    .filter((line) => line.startsWith('tmsh ') && !line.startsWith('tmsh -c'))
    .map((line) => line.slice('tmsh '.length));
}

const commandPush = (config: readonly string[]): DeviceChange['push'] => ({
  module: 'f5networks.f5_modules.bigip_command',
  args: { provider: '{{ provider }}', commands: tmshCommands(config) },
  hosts: 'bigips',
});

/** "10.0.0.0/24" as the address/netmask form sshd (tcp_wrappers) and httpd both accept. */
function allowEntry(cidr: string): string | null {
  const c = parseCidrAny(cidr);
  if (!c || !cidr.includes('/')) return null;
  return c.family === 4 ? `${c.network}/${netmask(c.prefix)}` : `${c.network}/${c.prefix}`;
}

/** An address in a route domain: 10.0.0.1%2, or unchanged in the default one. */
const inRd = (address: string, rd: number): string => (rd > 0 ? `${address}%${rd}` : address);

/** A CIDR in a route domain: 10.0.0.5%2/24. */
function cidrInRd(cidr: string, rd: number): string {
  const [address = '', prefix = ''] = cidr.split('/');
  return `${inRd(address, rd)}/${prefix}`;
}

const DO_NOTE = 'Declarative Onboarding would do the same as one declaration (f5networks.f5_bigip.bigip_do_deploy). It is written as tmsh here because a DO document is not AS3, and the whole-device file only merges AS3.';

export const F5_EXTRA_3: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'f5_system_baseline',
    platform: PLATFORM,
    label: 'System baseline: hostname, DNS, NTP, syslog',
    group: 'Onboarding',
    description: 'The /Common settings every BIG-IP needs before an application goes on it: an FQDN hostname, resolvers, time, remote syslog and who may reach the management GUI and SSH.',
    inputs: [
      { id: 'hostname', label: 'Hostname (FQDN)', control: 'text', default: 'bigip1.example.com' },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.53, 10.0.0.54' },
      { id: 'search_domains', label: 'Search domains', control: 'text', default: 'example.com' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'timezone', label: 'Time zone', control: 'text', default: 'UTC', hint: 'An Olson name: UTC, Europe/London, America/New_York' },
      { id: 'syslog_server', label: 'Remote syslog server', control: 'text', default: '10.0.0.20', hint: 'Empty for none' },
      { id: 'mgmt_allow', label: 'Networks allowed to the GUI and SSH', control: 'text', default: '10.0.0.0/24', hint: 'Prefixes, comma separated. Empty leaves the lists as they are' },
      { id: 'skip_wizard', label: 'Mark the setup wizard as done', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const hostname = str(values, 'hostname', '').trim();
      const dns = listOf(str(values, 'dns_servers', ''));
      const search = listOf(str(values, 'search_domains', ''));
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const tz = str(values, 'timezone', 'UTC').trim() || 'UTC';
      const syslog = str(values, 'syslog_server', '').trim();
      const allowTyped = listOf(str(values, 'mgmt_allow', ''));
      const allow = allowTyped.map(allowEntry);
      const findings: Finding[] = [];

      if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(hostname)) {
        findings.push(error('network.f5.hostname-not-fqdn', `"${hostname}" is not a fully qualified name. A BIG-IP refuses a hostname without a domain, and the device trust in an HA pair is built on it.`, { remediation: 'Write it as bigip1.example.com.', source: 'ArchToolKit' }));
      }
      const badDns = dns.filter((a) => !isIp(a));
      if (badDns.length > 0) findings.push(error('network.f5.bad-dns-server', `Not an address: ${badDns.join(', ')}.`, { source: 'ArchToolKit' }));
      const badNtp = ntp.filter((a) => !isIp(a) && !/^[A-Za-z0-9.-]+$/.test(a));
      if (badNtp.length > 0) findings.push(error('network.f5.bad-ntp-server', `Not an address or a name: ${badNtp.join(', ')}.`, { source: 'ArchToolKit' }));
      if (ntp.length === 1) {
        findings.push(warning('network.f5.single-ntp', 'One NTP server is a single point of failure for time, and an HA pair whose clocks drift apart fails config sync and certificate checks.', { remediation: 'Give it at least two, ideally three.', source: 'ArchToolKit' }));
      }
      if (ntp.length === 0) findings.push(error('network.f5.no-ntp', 'No NTP server. HA, GSLB (iQuery) and every log correlation depend on the clock.', { source: 'ArchToolKit' }));
      if (syslog && !isIp(syslog)) findings.push(error('network.f5.bad-syslog', `The syslog server "${syslog}" is not an address.`, { source: 'ArchToolKit' }));
      if (allow.some((a) => a === null)) {
        findings.push(error('network.f5.bad-allow', `Not a prefix: ${allowTyped.filter((_, i) => allow[i] === null).join(', ')}.`, { remediation: 'Write each as 10.0.0.0/24.', source: 'ArchToolKit' }));
      }
      if (allowTyped.some((a) => /^(0\.0\.0\.0\/0|::\/0)$/.test(a))) {
        findings.push(warning('network.f5.mgmt-open', 'The management GUI and SSH open to every address. The management port is the most attacked part of a BIG-IP.', { remediation: 'Limit it to the admin networks.', source: 'ArchToolKit' }));
      }
      const allowed = allow.filter((a): a is string => a !== null);

      const config = [
        saveUcs('baseline'),
        `tmsh modify sys global-settings hostname ${hostname}`,
        ...(bool(values, 'skip_wizard', true) ? ['tmsh modify sys global-settings gui-setup disabled'] : []),
        `tmsh modify sys dns name-servers replace-all-with { ${dns.join(' ')} }${search.length > 0 ? ` search replace-all-with { ${search.join(' ')} }` : ''}`,
        `tmsh modify sys ntp servers replace-all-with { ${ntp.join(' ')} } timezone ${tz}`,
        ...(syslog ? [`tmsh modify sys syslog remote-servers replace-all-with { remote-1 { host ${syslog} remote-port 514 } }`] : []),
        ...(allowed.length > 0
          ? [`tmsh modify sys httpd allow replace-all-with { ${allowed.join(' ')} }`, `tmsh modify sys sshd allow replace-all-with { ${allowed.join(' ')} }`]
          : []),
        'tmsh save sys config',
      ];

      return {
        platform: PLATFORM,
        title: `System baseline for ${hostname || 'the BIG-IP'}`,
        impact: allowed.length > 0 ? 'brief' : 'none',
        notes: [
          'Run it from a session that comes from one of the allowed networks: replacing the httpd and sshd allow lists applies at once, and a list without your own address locks you out of the GUI and SSH (the console still works).',
          'The hostname is what the device trust and config sync know the unit by. Set it before HA is built, not after.',
          'NTP matters more here than on most devices: config sync, iQuery and certificate validity all fail on a clock that is wrong.',
          'The UCS saved first is the complete back-out; the per-setting lines put back only what you captured.',
          DO_NOTE,
        ],
        before: [
          'tmsh list sys global-settings hostname',
          'tmsh list sys dns',
          'tmsh list sys ntp',
          'tmsh list sys syslog remote-servers',
          'tmsh list sys httpd allow',
          'tmsh list sys sshd allow',
        ],
        config,
        verify: [
          'tmsh list sys global-settings hostname',
          'tmsh list sys dns',
          'ntpq -pn',
          'tmsh show sys clock',
          ...(syslog ? ['logger -p local0.notice "syslog test from BIG-IP"', `tcpdump -ni mgmt host ${syslog} and port 514 -c 1`] : []),
          'Open the GUI and an SSH session from an allowed network, and confirm a disallowed one is refused.',
        ],
        backout: [
          'tmsh modify sys global-settings hostname <previous hostname>',
          'tmsh modify sys dns name-servers replace-all-with { <previous servers> }',
          'tmsh modify sys ntp servers replace-all-with { <previous servers> }',
          ...(syslog ? ['tmsh modify sys syslog remote-servers none'] : []),
          ...(allowed.length > 0 ? ['tmsh modify sys httpd allow replace-all-with { All }', 'tmsh modify sys sshd allow replace-all-with { ALL }'] : []),
          '# Or put everything back from the archive taken first:',
          loadUcs('baseline'),
        ],
        push: commandPush(config),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_provisioning',
    platform: PLATFORM,
    label: 'Module provisioning and licence',
    group: 'Onboarding',
    description: 'Which modules run (LTM, Advanced WAF, APM, DNS, AFM, AVR) and at what level, and the licence activation that has to come before any of them.',
    inputs: [
      { id: 'ltm', label: 'LTM', control: 'select', default: 'nominal', options: [
        { value: 'nominal', label: 'Nominal' },
        { value: 'minimum', label: 'Minimum' },
        { value: 'none', label: 'None' },
      ] },
      { id: 'asm', label: 'Advanced WAF (asm)', control: 'select', default: 'none', options: [
        { value: 'none', label: 'None' },
        { value: 'nominal', label: 'Nominal' },
        { value: 'minimum', label: 'Minimum' },
        { value: 'dedicated', label: 'Dedicated' },
      ] },
      { id: 'apm', label: 'Access Policy Manager (apm)', control: 'select', default: 'none', options: [
        { value: 'none', label: 'None' },
        { value: 'nominal', label: 'Nominal' },
        { value: 'minimum', label: 'Minimum' },
        { value: 'dedicated', label: 'Dedicated' },
      ] },
      { id: 'gtm', label: 'DNS / GSLB (gtm)', control: 'select', default: 'none', options: [
        { value: 'none', label: 'None' },
        { value: 'nominal', label: 'Nominal' },
        { value: 'minimum', label: 'Minimum' },
        { value: 'dedicated', label: 'Dedicated' },
      ] },
      { id: 'afm', label: 'Advanced Firewall Manager (afm)', control: 'select', default: 'none', options: [
        { value: 'none', label: 'None' },
        { value: 'nominal', label: 'Nominal' },
        { value: 'minimum', label: 'Minimum' },
      ] },
      { id: 'avr', label: 'Analytics (avr)', control: 'select', default: 'nominal', options: [
        { value: 'nominal', label: 'Nominal' },
        { value: 'none', label: 'None' },
        { value: 'minimum', label: 'Minimum' },
      ] },
      { id: 'license', label: 'Activate a registration key now', control: 'toggle', default: false, hint: 'Needs the BIG-IP to reach activate.f5.com' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const modules = ['ltm', 'asm', 'apm', 'gtm', 'afm', 'avr'].map((m) => ({ module: m, level: str(values, m, m === 'ltm' || m === 'avr' ? 'nominal' : 'none') }));
      const on = modules.filter((m) => m.level !== 'none');
      const dedicated = on.filter((m) => m.level === 'dedicated');
      const license = bool(values, 'license', false);
      const findings: Finding[] = [];
      if (dedicated.length > 0 && on.length > 1) {
        findings.push(error('network.f5.dedicated-with-others', `${dedicated.map((m) => m.module).join(', ')} is set to dedicated, which gives it the whole device: nothing else can be provisioned beside it.`, { remediation: 'Use nominal for every module that shares the device.', source: 'ArchToolKit' }));
      }
      const ltm = modules.find((m) => m.module === 'ltm')!.level;
      if (ltm === 'none' && on.some((m) => m.module === 'asm' || m.module === 'apm')) {
        findings.push(warning('network.f5.waf-without-ltm', 'Advanced WAF and APM attach to LTM virtual servers. Without LTM provisioned there is nothing for them to sit on, unless this really is a standalone APM or DNS device.', { source: 'ArchToolKit' }));
      }
      if (on.filter((m) => m.level === 'nominal' && m.module !== 'avr').length >= 3) {
        findings.push(warning('network.f5.provisioning-memory', 'Three or more modules at nominal is more memory than smaller platforms and VEs have. Provisioning fails, or TMM starves, when it does not fit.', { remediation: 'Check `tmsh show sys provision` for the memory each would take on this platform before applying.', source: 'ArchToolKit' }));
      }

      const config = [
        ...(license ? [`tmsh install sys license registration-key ${SECRET}`] : []),
        saveUcs('provisioning'),
        // One transaction, so the modules restart once rather than once per module.
        `tmsh -c "create cli transaction; ${modules.map((m) => `modify sys provision ${m.module} level ${m.level}`).join('; ')}; submit cli transaction"`,
        'tmsh save sys config',
      ];

      return {
        platform: PLATFORM,
        title: `Provision ${on.map((m) => `${m.module} (${m.level})`).join(', ') || 'no modules'}`,
        impact: 'outage',
        notes: [
          'Changing provisioning restarts TMM and the module daemons, and can reboot the device. Everything it is passing stops until it is back. On an HA pair, do the standby first, fail over, then the other.',
          'Every module is set, including the ones set to None: a module that is provisioned now and set to None here is deprovisioned, and its configuration stops working. Check the capture first and set each to what it should be.',
          'Every module has to be in the licence. Provisioning something the licence does not include fails.',
          license
            ? 'The registration key is a placeholder: paste it in on the device. Activation needs HTTPS to activate.f5.com; without it, use the manual (dossier) method from the GUI.'
            : 'The licence is not touched. A new device needs `tmsh install sys license registration-key <key>` (or the manual dossier method) before anything here will provision.',
          'The modules are set in one transaction so they restart once. The playbook uses bigip_provision instead, which sets one module at a time and waits for each.',
          DO_NOTE,
        ],
        before: ['tmsh show sys license', 'tmsh list sys provision', 'tmsh show sys provision', 'tmsh show sys memory', 'tmsh show cm failover-status'],
        config,
        verify: ['tmsh list sys provision', 'tmsh show sys mcp-state field-fmt', 'tmsh show sys ready', 'tmsh show sys license detail | grep -i active', 'tmsh show ltm virtual | grep -i availability'],
        backout: [
          `tmsh -c "create cli transaction; ${modules.map((m) => `modify sys provision ${m.module} level <previous ${m.module} level>`).join('; ')}; submit cli transaction"`,
          '# Or restore the archive taken first (it restarts services too):',
          loadUcs('provisioning'),
        ],
        push: {
          module: 'f5networks.f5_modules.bigip_provision',
          // bigip_provision takes nominal, minimum or dedicated; "none" is state absent.
          args: { provider: '{{ provider }}', module: '{{ item.module }}', level: '{{ item.level }}', state: '{{ item.state }}' },
          loop: `{{ [${modules.map((m) => `{'module': '${m.module}', 'level': '${m.level === 'none' ? 'nominal' : m.level}', 'state': '${m.level === 'none' ? 'absent' : 'present'}'}`).join(', ')}] }}`,
          hosts: 'bigips',
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_vlan_self_ip',
    platform: PLATFORM,
    label: 'VLAN and self IPs with port lockdown',
    group: 'Onboarding',
    description: 'A VLAN on an interface or trunk, the unit’s own self IP on it, an optional floating self IP for an HA pair, and the port lockdown that decides what the BIG-IP itself answers on that VLAN.',
    inputs: [
      { id: 'vlan', label: 'VLAN name', control: 'text', default: 'internal' },
      { id: 'interface', label: 'Interface or trunk', control: 'text', default: '1.2', hint: '1.1, 1.2, or a trunk name' },
      { id: 'tagged', label: 'Tagged', control: 'toggle', default: false },
      { id: 'tag', label: '802.1Q tag', control: 'number', default: 20, min: 1, max: 4094, showWhen: { input: 'tagged', equals: ['true'] } },
      { id: 'mtu', label: 'MTU', control: 'number', default: 1500, min: 576, max: 9198 },
      { id: 'self_ip', label: 'Self IP', control: 'text', default: '10.20.0.11/24', hint: 'IPv4 or IPv6, with the prefix' },
      { id: 'floating_ip', label: 'Floating self IP', control: 'text', default: '', hint: 'For an HA pair: the address the servers route to. Empty for none' },
      { id: 'route_domain', label: 'Route domain id', control: 'number', default: 0, min: 0, max: 65534, hint: '0 is the default route domain' },
      { id: 'lockdown', label: 'Port lockdown', control: 'select', default: 'none', options: [
        { value: 'none', label: 'Allow none — the BIG-IP answers nothing on this VLAN' },
        { value: 'default', label: 'Allow default — the HA, iQuery, DNS and routing ports' },
        { value: 'custom', label: 'Allow these ports' },
        { value: 'all', label: 'Allow all' },
      ] },
      { id: 'custom_ports', label: 'Ports', control: 'text', default: 'tcp:443, tcp:4353, udp:1026', showWhen: { input: 'lockdown', equals: ['custom'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const vlan = name(str(values, 'vlan', 'internal'), 'internal');
      const iface = str(values, 'interface', '1.1').trim();
      const tagged = bool(values, 'tagged', false);
      const tag = num(values, 'tag', 20);
      const rd = num(values, 'route_domain', 0);
      const self = parseCidrDual(str(values, 'self_ip', ''));
      const floatTyped = str(values, 'floating_ip', '').trim();
      const float = floatTyped ? parseCidrDual(floatTyped.includes('/') || !self ? floatTyped : `${floatTyped}/${self.prefix}`) : null;
      const lockdown = str(values, 'lockdown', 'none');
      const ports = listOf(str(values, 'custom_ports', ''));
      const findings: Finding[] = [];

      if (!self) findings.push(error('network.f5.bad-self-ip', 'The self IP is not an address with a prefix.', { remediation: 'Write it as 10.20.0.11/24 or 2001:db8:20::11/64.', source: 'ArchToolKit' }));
      if (floatTyped && !float) findings.push(error('network.f5.bad-floating-ip', `The floating self IP "${floatTyped}" is not an address.`, { source: 'ArchToolKit' }));
      if (self && float && (self.family !== float.family || self.network !== float.network || self.prefix !== float.prefix)) {
        findings.push(error('network.f5.floating-other-subnet', 'The floating self IP is not in the same subnet as the self IP. A floating address has to sit on the network the unit already has an address in.', { source: 'ArchToolKit' }));
      }
      if (self && float && self.address === float.address) findings.push(error('network.f5.floating-same', 'The floating self IP is the same address as the self IP.', { source: 'ArchToolKit' }));
      if (lockdown === 'all') {
        findings.push(warning('network.f5.lockdown-all', 'Allow all exposes every service the BIG-IP runs — SSH, the configuration utility, SNMP — on this VLAN. On an external VLAN that is the management plane on the internet.', { remediation: 'Use allow none on external VLANs, and allow default only on the HA and internal ones.', source: 'ArchToolKit' }));
      }
      if (lockdown === 'custom' && ports.some((p) => !/^(tcp|udp|ospf|igmp|pim|gre|[0-9]+):(\d{1,5}|0)$/.test(p))) {
        findings.push(error('network.f5.bad-lockdown-port', `Not a protocol:port pair: ${ports.filter((p) => !/^(tcp|udp|ospf|igmp|pim|gre|[0-9]+):(\d{1,5}|0)$/.test(p)).join(', ')}.`, { remediation: 'Write them as tcp:443, udp:1026.', source: 'ArchToolKit' }));
      }
      if (lockdown === 'custom' && ports.length === 0) findings.push(error('network.f5.no-lockdown-ports', 'Allow these ports with no ports is allow none.', { source: 'ArchToolKit' }));

      const allowService = lockdown === 'custom' ? `allow-service replace-all-with { ${ports.join(' ')} }` : `allow-service ${lockdown}`;
      const selfCidr = self ? cidrInRd(`${self.address}/${self.prefix}`, rd) : '<self-ip>/<prefix>';
      const config = [
        `tmsh create net vlan ${vlan} interfaces add { ${iface} { ${tagged ? 'tagged' : 'untagged'} } }${tagged ? ` tag ${tag}` : ''} mtu ${num(values, 'mtu', 1500)}`,
        ...(rd > 0 ? [`tmsh modify net route-domain /Common/rd${rd} vlans add { ${vlan} }`] : []),
        `tmsh create net self ${vlan}-self address ${selfCidr} vlan ${vlan} ${allowService}`,
        ...(float ? [`tmsh create net self ${vlan}-float address ${cidrInRd(`${float.address}/${float.prefix}`, rd)} vlan ${vlan} traffic-group traffic-group-1 ${allowService}`] : []),
        'tmsh save sys config',
      ];

      return {
        platform: PLATFORM,
        title: `VLAN ${vlan} on ${iface}${tagged ? ` (tag ${tag})` : ''} with self IP ${self ? `${self.address}/${self.prefix}` : '?'}`,
        impact: 'brief',
        notes: [
          'The switch port has to match: untagged here means an access port in the same VLAN, tagged means a trunk carrying this tag.',
          float
            ? 'The floating self IP belongs to traffic-group-1 and moves with it on failover. It is what the servers use as their gateway, and what SNAT automap takes on this VLAN. Create the non-floating self IP on the peer too, with its own address.'
            : 'No floating address: on an HA pair, the servers need one to route through whichever unit is active.',
          'Port lockdown decides what the BIG-IP itself answers on this address, not what passes through it. Virtual servers are not affected.',
          'Allow default opens the ports HA needs (UDP 1026 failover, TCP 4353 sync and iQuery) and a few routing and DNS ones. The VLAN that carries config sync and network failover needs it, or its own list with those ports.',
          ...(rd > 0 ? [`The route domain ${rd} has to exist first (the route domain step), and the addresses carry %${rd}.`] : []),
          DO_NOTE,
        ],
        before: ['tmsh list net vlan', 'tmsh list net self', 'tmsh show net interface', 'tmsh list net route-domain'],
        config,
        verify: [
          `tmsh list net vlan ${vlan}`,
          `tmsh list net self ${vlan}-self`,
          ...(float ? [`tmsh list net self ${vlan}-float`] : []),
          `tmsh show net interface ${iface}`,
          `${rd > 0 ? `rdexec ${rd} ` : ''}ping -c 3 <an address on ${self ? `${self.network}/${self.prefix}` : 'the subnet'}>`,
          'tmsh show net arp',
        ],
        backout: [
          ...(float ? [`tmsh delete net self ${vlan}-float`] : []),
          `tmsh delete net self ${vlan}-self`,
          ...(rd > 0 ? [`tmsh modify net route-domain /Common/rd${rd} vlans delete { ${vlan} }`] : []),
          `tmsh delete net vlan ${vlan}`,
          'tmsh save sys config',
        ],
        push: commandPush(config),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_static_routes',
    platform: PLATFORM,
    label: 'Default and static routes',
    group: 'Onboarding',
    description: 'The data-plane default route and the static routes to internal networks, in the default route domain or another one.',
    inputs: [
      { id: 'default_gateway', label: 'Default gateway', control: 'text', default: '203.0.113.1', hint: 'Empty for no default route' },
      { id: 'routes', label: 'Static routes', control: 'textarea', default: '10.50.0.0/16 10.20.0.1\n10.60.0.0/16 10.20.0.1', hint: 'One per line: prefix gateway' },
      { id: 'route_domain', label: 'Route domain id', control: 'number', default: 0, min: 0, max: 65534 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const rd = num(values, 'route_domain', 0);
      const gw = str(values, 'default_gateway', '').trim();
      const routes = str(values, 'routes', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2 && parts[0] !== '');
      const findings: Finding[] = [];
      if (gw && !isIp(gw)) findings.push(error('network.f5.bad-gateway', `The default gateway "${gw}" is not an address.`, { source: 'ArchToolKit' }));
      const bad = routes.filter(([prefix, via]) => !parseCidrDual(prefix ?? '') || !isIp(via ?? '') || familyOf(via ?? '') !== parseCidrDual(prefix ?? '')?.family);
      if (bad.length > 0) {
        findings.push(error('network.f5.bad-route', `Not a prefix and a gateway of the same family: ${bad.map((p) => p.join(' ')).join('; ')}.`, { remediation: 'One per line: 10.50.0.0/16 10.20.0.1.', source: 'ArchToolKit' }));
      }
      const hosts = routes.filter(([prefix]) => {
        const c = parseCidrDual(prefix ?? '');
        return c !== null && c.address !== c.network;
      });
      if (hosts.length > 0) {
        findings.push(error('network.f5.route-not-network', `A route has to name a network, not an address inside one: ${hosts.map((p) => p[0]).join(', ')}.`, { source: 'ArchToolKit' }));
      }
      if (!gw && routes.length === 0) findings.push(error('network.f5.no-routes', 'There is nothing to add.', { source: 'ArchToolKit' }));
      const good = routes.filter((r) => !bad.includes(r) && !hosts.includes(r));
      const routeName = (prefix: string) => `rt_${prefix.replace(/[^A-Za-z0-9]/g, '_')}${rd > 0 ? `_rd${rd}` : ''}`;
      const defaultName = `default_gw${rd > 0 ? `_rd${rd}` : ''}`;
      const defaultNetwork = familyOf(gw) === 6 ? 'default-inet6' : 'default';

      const config = [
        ...(gw && isIp(gw) ? [`tmsh create net route ${defaultName} network ${inRd(defaultNetwork, rd)} gw ${inRd(gw, rd)}`] : []),
        ...good.map(([prefix, via]) => `tmsh create net route ${routeName(prefix!)} network ${cidrInRd(prefix!, rd)} gw ${inRd(via!, rd)}`),
        'tmsh save sys config',
      ];

      return {
        platform: PLATFORM,
        title: `${gw ? 'Default route' : ''}${gw && good.length > 0 ? ' and ' : ''}${good.length > 0 ? `${good.length} static route${good.length === 1 ? '' : 's'}` : ''}${rd > 0 ? ` in route domain ${rd}` : ''}`,
        impact: gw ? 'brief' : 'none',
        notes: [
          'These are data-plane routes (net route). The management port has its own table: `tmsh list sys management-route`. A route added here does not carry management traffic, and one there does not carry application traffic.',
          'Each gateway has to be on a directly connected self IP subnet in the same route domain, or the route is created but never used.',
          'Servers reply through the BIG-IP only if they route back through it (a floating self IP as their gateway) or the virtual server uses SNAT.',
          DO_NOTE,
        ],
        before: ['tmsh list net route', 'tmsh show net route', 'tmsh list net self'],
        config,
        verify: ['tmsh show net route', ...(gw ? [rd > 0 ? `rdexec ${rd} ping -c 3 ${gw}` : `ping -c 3 ${gw}`] : []), ...good.slice(0, 2).map(([prefix]) => `tmsh show net route | grep '${cidrInRd(prefix!, rd)}'`)],
        backout: [
          ...good.map(([prefix]) => `tmsh delete net route ${routeName(prefix!)}`),
          ...(gw && isIp(gw) ? [`tmsh delete net route ${defaultName}`] : []),
          'tmsh save sys config',
        ],
        push: commandPush(config),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_route_domain',
    platform: PLATFORM,
    label: 'Route domain',
    group: 'Onboarding',
    description: 'A separate routing table on the same BIG-IP, for a tenant whose addresses overlap another’s or must not reach it, with the partition that uses it by default.',
    inputs: [
      { id: 'id', label: 'Route domain id', control: 'number', default: 2, min: 1, max: 65534 },
      { id: 'vlans', label: 'VLANs in it', control: 'text', default: 'tenant2_internal, tenant2_external' },
      { id: 'strict', label: 'Strict isolation', control: 'toggle', default: true, hint: 'Traffic cannot cross into another route domain' },
      { id: 'parent', label: 'Parent route domain', control: 'number', default: 0, min: 0, max: 65534, hint: '0 for none. A parent is where unmatched routes are looked up (only when strict is off)' },
      { id: 'bgp', label: 'Enable BGP in it (ZebOS)', control: 'toggle', default: false },
      { id: 'partition', label: 'Partition (AS3 tenant) that uses it by default', control: 'text', default: 'Tenant2', hint: 'Empty for none' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const id = num(values, 'id', 2);
      const vlans = listOf(str(values, 'vlans', '')).map((v) => name(v, 'vlan'));
      const strict = bool(values, 'strict', true);
      const parent = num(values, 'parent', 0);
      const partition = str(values, 'partition', '').trim().replace(/[^A-Za-z0-9_]/g, '_');
      const bgp = bool(values, 'bgp', false);
      const rd = `/Common/rd${id}`;
      const findings: Finding[] = [];
      if (id < 1) findings.push(error('network.f5.rd-zero', 'Route domain 0 is the default one and always exists; it cannot be created.', { source: 'ArchToolKit' }));
      if (vlans.length === 0) findings.push(warning('network.f5.rd-no-vlans', 'A route domain with no VLANs carries no traffic.', { source: 'ArchToolKit' }));
      if (parent > 0 && strict) {
        findings.push(warning('network.f5.rd-parent-strict', 'A parent route domain is only consulted when strict isolation is off, so with strict on the parent does nothing.', { source: 'ArchToolKit' }));
      }
      if (parent === id) findings.push(error('network.f5.rd-parent-self', 'A route domain cannot be its own parent.', { source: 'ArchToolKit' }));
      if (!strict) {
        findings.push(warning('network.f5.rd-not-strict', 'Without strict isolation, traffic can cross into the parent and other route domains. If the reason for the route domain is separation, that defeats it.', { source: 'ArchToolKit' }));
      }

      const config = [
        `tmsh create net route-domain ${rd} id ${id}${vlans.length > 0 ? ` vlans add { ${vlans.join(' ')} }` : ''} strict ${strict ? 'enabled' : 'disabled'}${parent > 0 ? ` parent /Common/rd${parent}` : ''}${bgp ? ' routing-protocol add { BGP }' : ''}`,
        ...(partition ? [`tmsh modify auth partition ${partition} default-route-domain ${id}`] : []),
        'tmsh save sys config',
      ];

      return {
        platform: PLATFORM,
        title: `Route domain ${id}${vlans.length > 0 ? ` with ${vlans.join(', ')}` : ''}`,
        impact: 'brief',
        notes: [
          'A VLAN belongs to exactly one route domain. Moving one that already has self IPs in another route domain means deleting and re-creating those self IPs with the new %id.',
          `Every address in this route domain is written with %${id} (10.0.0.1%${id}) in tmsh. In a partition whose default route domain is ${id}, the suffix can be left off — which is why the partition setting is here.`,
          partition
            ? `The partition ${partition} has to exist before this: AS3 creates it when the tenant is first deployed, or \`tmsh create auth partition ${partition}\`. An AS3 tenant can also say defaultRouteDomain: ${id} itself.`
            : 'No partition is pointed at it, so every address in it has to carry the %id suffix.',
          ...(bgp ? ['BGP runs in the route domain\'s own ZebOS instance: `imish -r ' + id + '` to configure it. The routing module has to be licensed.'] : []),
          DO_NOTE,
        ],
        before: ['tmsh list net route-domain', 'tmsh list net vlan', 'tmsh list net self', ...(partition ? [`tmsh list auth partition ${partition}`] : [])],
        config,
        verify: [`tmsh list net route-domain ${rd}`, `tmsh show net route-domain ${rd}`, ...(partition ? [`tmsh list auth partition ${partition} default-route-domain`] : []), `tmsh show net route | grep %${id}`],
        backout: [
          ...(partition ? [`tmsh modify auth partition ${partition} default-route-domain 0`] : []),
          '# Delete or move every self IP, route and virtual address that carries %' + id + ' first:',
          ...(vlans.length > 0 ? [`tmsh modify net route-domain ${rd} vlans delete { ${vlans.join(' ')} }`] : []),
          `tmsh delete net route-domain ${rd}`,
          'tmsh save sys config',
        ],
        push: commandPush(config),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_ha_pair',
    platform: PLATFORM,
    label: 'HA pair: device trust, sync-failover group',
    group: 'Onboarding',
    description: 'Two BIG-IPs as an active/standby pair: the addresses each uses for config sync, failover and mirroring, the device trust, the sync-failover device group, and the first sync.',
    inputs: [
      { id: 'local_name', label: 'This unit’s device name', control: 'text', default: 'bigip1.example.com', hint: 'As `tmsh list cm device` shows it — usually the hostname' },
      { id: 'peer_name', label: 'Peer device name', control: 'text', default: 'bigip2.example.com' },
      { id: 'peer_mgmt', label: 'Peer management address', control: 'text', default: '192.0.2.12' },
      { id: 'local_ha', label: 'This unit’s HA self IP', control: 'text', default: '10.255.0.1', hint: 'The non-floating self IP on the HA VLAN' },
      { id: 'peer_ha', label: 'Peer HA self IP', control: 'text', default: '10.255.0.2' },
      { id: 'local_mgmt', label: 'This unit’s management address', control: 'text', default: '192.0.2.11', hint: 'A second failover path. Empty for none' },
      { id: 'peer_mgmt_unicast', label: 'Peer management address for failover', control: 'text', default: '192.0.2.12', hint: 'Empty for none' },
      { id: 'group', label: 'Device group', control: 'text', default: 'dg-failover' },
      { id: 'mirroring', label: 'Connection mirroring address', control: 'toggle', default: true },
      { id: 'auto_sync', label: 'Automatic sync', control: 'toggle', default: false },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const local = name(str(values, 'local_name', ''), 'bigip1');
      const peer = name(str(values, 'peer_name', ''), 'bigip2');
      const peerMgmt = str(values, 'peer_mgmt', '').trim();
      const localHa = str(values, 'local_ha', '').trim();
      const peerHa = str(values, 'peer_ha', '').trim();
      const localMgmt = str(values, 'local_mgmt', '').trim();
      const peerMgmtUni = str(values, 'peer_mgmt_unicast', '').trim();
      const group = name(str(values, 'group', 'dg-failover'), 'dg-failover');
      const mirror = bool(values, 'mirroring', true);
      const autoSync = bool(values, 'auto_sync', false);
      const findings: Finding[] = [];
      for (const [label, value] of [['peer management', peerMgmt], ['this unit’s HA', localHa], ['peer HA', peerHa]] as const) {
        if (!isIp(value)) findings.push(error('network.f5.bad-ha-address', `The ${label} address "${value}" is not an address.`, { source: 'ArchToolKit' }));
      }
      if (local === peer) findings.push(error('network.f5.ha-same-name', 'Both units have the same device name. Device trust identifies each unit by it, so the pair cannot form.', { remediation: 'Give each unit its own FQDN hostname first (the system baseline).', source: 'ArchToolKit' }));
      if (isIp(localHa) && localHa === peerHa) findings.push(error('network.f5.ha-same-address', 'Both units have the same HA address.', { source: 'ArchToolKit' }));
      if (isIp(localHa) && isIp(peerHa) && familyOf(localHa) !== familyOf(peerHa)) findings.push(error('network.f5.ha-family', 'The two HA addresses are different families.', { source: 'ArchToolKit' }));
      const secondPath = isIp(localMgmt) && isIp(peerMgmtUni);
      if (!secondPath) {
        findings.push(warning('network.f5.ha-single-path', 'Network failover over the HA VLAN alone: if that one link fails, each unit thinks the other is dead and both go active.', { remediation: 'Add the management addresses as a second unicast failover path, or a serial/hardwired failover cable.', source: 'ArchToolKit' }));
      }
      if (autoSync) {
        findings.push(warning('network.f5.ha-auto-sync', 'Automatic sync pushes every change on one unit to the other the moment it is made — including a mistake. With AS3, deploy to the active unit and let AS3 sync (syncToGroup), or sync by hand after checking.', { source: 'ArchToolKit' }));
      }

      const unicast = (ha: string, mgmt: string, both: boolean) => `unicast-address { { ip ${ha} port 1026 }${both ? ` { ip ${mgmt} port 1026 }` : ''} }`;
      const deviceLine = (dev: string, ha: string, mgmt: string) => `tmsh modify cm device ${dev} configsync-ip ${ha} ${unicast(ha, mgmt, secondPath)}${mirror ? ` mirror-ip ${ha}` : ''}`;

      return {
        platform: PLATFORM,
        title: `HA pair ${local} and ${peer} in ${group}`,
        impact: 'brief',
        notes: [
          'Both units need the same software version, the same provisioning and licence modules, an FQDN hostname each, NTP in step, and the HA VLAN and its non-floating self IP (port lockdown allow default) before this starts.',
          'The order matters: set the addresses on each unit, build the trust from one unit only, create the group on that same unit, then sync from the unit whose configuration you want to keep. Syncing from the empty one erases the other.',
          `The trust step asks the peer for an administrator login. It is ${SECRET} here: type it on the device, never into a file.`,
          'Floating self IPs and virtual addresses go in traffic-group-1 so they move on failover. The VLAN and self IP step makes a floating self IP.',
          'There is no playbook for this one: the trust and the group are made from one unit only, and a play against the whole bigips group would try from both.',
          DO_NOTE,
        ],
        before: ['tmsh list cm device', 'tmsh show cm sync-status', 'tmsh show cm failover-status', 'tmsh list cm trust-domain', 'tmsh show sys version', 'tmsh list net self'],
        config: [
          saveUcs('ha'),
          `# 1. On ${local}:`,
          deviceLine(local, localHa, localMgmt),
          `# 2. On ${peer} (run there):`,
          `# ${deviceLine(peer, peerHa, peerMgmtUni)}`,
          `# 3. Back on ${local}: trust the peer, then build the group`,
          `tmsh modify cm trust-domain Root ca-devices add { ${peerMgmt} } name ${peer} username admin password ${SECRET}`,
          `tmsh create cm device-group ${group} devices add { ${local} ${peer} } type sync-failover auto-sync ${autoSync ? 'enabled' : 'disabled'} network-failover enabled`,
          `tmsh run cm config-sync to-group ${group}`,
          'tmsh save sys config',
        ],
        verify: [
          'tmsh show cm sync-status',
          'tmsh show cm failover-status',
          'tmsh show cm traffic-group',
          `tmsh list cm device-group ${group}`,
          '# Then prove it: on the active unit, tmsh run sys failover standby, and watch the floating addresses move',
        ],
        backout: [
          `tmsh delete cm device-group ${group}`,
          '# On each unit, reset the trust (this takes the unit out of every device group):',
          'tmsh delete cm trust-domain Root',
          `tmsh modify cm device ${local} configsync-ip none unicast-address none${mirror ? ' mirror-ip any6' : ''}`,
          'tmsh save sys config',
          '# Or restore the archive taken first, on each unit:',
          loadUcs('ha'),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_gslb_infrastructure',
    platform: PLATFORM,
    label: 'GSLB data centres, servers and DNS listener',
    group: 'DNS',
    description: 'What a GSLB wide IP stands on: the data centres, the BIG-IP servers in them with virtual server discovery, the DNS listener that answers, and the sync group that keeps GSLB devices in step.',
    inputs: [
      { id: 'datacenters', label: 'Data centres', control: 'textarea', default: 'DC-LONDON London\nDC-DUBLIN Dublin', hint: 'One per line: name location' },
      { id: 'servers', label: 'BIG-IP servers', control: 'textarea', default: 'bigip-lon DC-LONDON bigip1.example.com 10.10.0.11\nbigip-dub DC-DUBLIN bigip3.example.com 10.30.0.11', hint: 'One per line: server-name data-centre device-name self-IP' },
      { id: 'listener', label: 'DNS listener address', control: 'text', default: '203.0.113.53' },
      { id: 'tcp_listener', label: 'Also listen on TCP 53', control: 'toggle', default: true },
      { id: 'sync_group', label: 'GSLB sync group', control: 'text', default: 'gslb-prod', hint: 'Empty for a single GSLB device' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const dcs = str(values, 'datacenters', '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [dcName = '', ...rest] = line.split(/\s+/);
          return { name: name(dcName, 'DC'), location: rest.join(' ') };
        });
      const servers = str(values, 'servers', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 4)
        .map(([server = '', dc = '', device = '', address = '']) => ({ server: name(server, 'server'), dc: name(dc, 'DC'), device: name(device, 'device'), address }));
      const listener = str(values, 'listener', '').trim();
      const tcp = bool(values, 'tcp_listener', true);
      const sync = str(values, 'sync_group', '').trim().replace(/[^A-Za-z0-9_.-]/g, '_');
      const findings: Finding[] = [];
      if (dcs.length === 0) findings.push(error('network.f5.no-datacenters', 'No data centres. Every GSLB server and pool member is placed in one.', { source: 'ArchToolKit' }));
      if (dcs.length === 1) findings.push(warning('network.f5.single-datacenter', 'GSLB across one data centre chooses between nothing. It is worth it only when there is a second site to send clients to.', { source: 'ArchToolKit' }));
      const unknownDc = servers.filter((s) => !dcs.some((d) => d.name === s.dc));
      if (unknownDc.length > 0) findings.push(error('network.f5.server-unknown-dc', `These servers name a data centre that is not in the list: ${unknownDc.map((s) => `${s.server} (${s.dc})`).join(', ')}.`, { source: 'ArchToolKit' }));
      const badServer = servers.filter((s) => !isIp(s.address));
      if (badServer.length > 0) findings.push(error('network.f5.bad-gtm-server', `Not an address: ${badServer.map((s) => s.address).join(', ')}.`, { source: 'ArchToolKit' }));
      if (!isIp(listener)) findings.push(error('network.f5.bad-listener', `The DNS listener "${listener}" is not an address.`, { source: 'ArchToolKit' }));

      const listenerName = (proto: string) => `dns_listener_${proto}`;
      const config = [
        ...dcs.map((d) => `tmsh create gtm datacenter /Common/${d.name}${d.location ? ` location "${d.location}"` : ''}`),
        ...servers.map((s) => `tmsh create gtm server /Common/${s.server} datacenter /Common/${s.dc} product bigip devices add { ${s.device} { addresses add { ${s.address} { translation none } } } } virtual-server-discovery enabled monitor /Common/bigip`),
        `tmsh create gtm listener /Common/${listenerName('udp')} address ${listener} port 53 ip-protocol udp profiles add { /Common/dns /Common/udp_gtm_dns }`,
        ...(tcp ? [`tmsh create gtm listener /Common/${listenerName('tcp')} address ${listener} port 53 ip-protocol tcp profiles add { /Common/dns /Common/tcp }`] : []),
        ...(sync ? [`tmsh modify gtm global-settings general synchronization yes synchronization-group-name ${sync}`] : []),
        ...(sync ? ['# Then, on each other GSLB device, from bash (it asks for the peer login): gtm_add <this device self IP>'] : []),
        'tmsh save sys config',
      ];

      return {
        platform: PLATFORM,
        title: `GSLB infrastructure: ${dcs.length} data centre${dcs.length === 1 ? '' : 's'}, ${servers.length} server${servers.length === 1 ? '' : 's'}, listener ${formatHostPort(listener, 53)}`,
        impact: 'none',
        notes: [
          'BIG-IP DNS (gtm) has to be provisioned: see the provisioning step.',
          'iQuery (TCP 4353) runs between every GSLB device and every BIG-IP server. The self IPs named here need port lockdown allowing it (allow default does), and the firewalls between the sites need it open.',
          'Each BIG-IP server has to trust this device\'s iQuery certificate: run `bigip_add <server self IP>` from bash on this device for every LTM listed, or the servers stay red.',
          'The DNS listener answers only once the parent zone delegates the GSLB subdomain to it (NS records pointing at the listener address).',
          'Wide IPs and GSLB pools come after this, in the GSLB wide IP step (AS3).',
        ],
        before: ['tmsh list sys provision gtm', 'tmsh list gtm datacenter', 'tmsh list gtm server', 'tmsh list gtm listener', 'tmsh list gtm global-settings general'],
        config,
        verify: [
          'tmsh show gtm datacenter',
          'tmsh show gtm server',
          'tmsh show gtm iquery',
          `dig @${listener} <wide IP name> +short`,
          ...(sync ? ['tmsh show gtm sync-status'] : []),
        ],
        backout: [
          ...(tcp ? [`tmsh delete gtm listener /Common/${listenerName('tcp')}`] : []),
          `tmsh delete gtm listener /Common/${listenerName('udp')}`,
          ...servers.map((s) => `tmsh delete gtm server /Common/${s.server}`),
          ...dcs.map((d) => `tmsh delete gtm datacenter /Common/${d.name}`),
          ...(sync ? ['tmsh modify gtm global-settings general synchronization no'] : []),
          'tmsh save sys config',
        ],
        push: commandPush(config),
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_apm_access',
    platform: PLATFORM,
    label: 'APM access profile on a virtual server',
    group: 'Applications',
    description: 'Put an APM access policy — pre-authentication, MFA, SSO to the application — in front of an HTTPS application, imported from a policy exported from a reference BIG-IP.',
    inputs: [
      { id: 'tenant', label: 'Tenant (partition)', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'portal' },
      { id: 'virtual_address', label: 'Virtual address', control: 'text', default: '203.0.113.60' },
      { id: 'pool_members', label: 'Pool members', control: 'textarea', default: '10.20.60.11:443\n10.20.60.12:443' },
      { id: 'certificate', label: 'Certificate on the device', control: 'text', default: '/Common/wildcard-corp' },
      { id: 'policy_url', label: 'Exported access policy URL', control: 'text', default: 'https://artifacts.example.com/f5/portal_access.tar.gz', hint: 'The .tar.gz from Access > Profiles > Export (ng_export)' },
      { id: 'ignore_changes', label: 'Import once, then leave it to the GUI', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const tenant = str(values, 'tenant', 'Prod').replace(/[^A-Za-z0-9_]/g, '_');
      const app = str(values, 'application', 'portal').replace(/[^A-Za-z0-9_]/g, '_');
      const address = str(values, 'virtual_address', '').trim();
      const pool = parseMembers(str(values, 'pool_members', ''), 443);
      const url = str(values, 'policy_url', '').trim();
      const ignore = bool(values, 'ignore_changes', true);
      const checked = virtualFindings(address, pool, 'auto');
      const findings: Finding[] = [...checked.findings];
      if (pool.servers.length === 0) findings.push(error('network.f5.no-members', 'The pool has no members.', { source: 'ArchToolKit' }));
      if (!/^https?:\/\/\S+\.tar\.gz$/i.test(url)) {
        findings.push(error('network.f5.bad-apm-url', 'The access policy has to be an exported .tar.gz that the BIG-IP can fetch over HTTP(S).', { remediation: 'Export it from a reference BIG-IP (Access > Profiles / Policies > Export) and publish it where the BIG-IP can reach it.', source: 'ArchToolKit' }));
      } else if (/^http:/i.test(url)) {
        findings.push(warning('network.f5.apm-url-http', 'The access policy is fetched over plain HTTP. Anyone on the path can replace the policy that decides who gets in.', { remediation: 'Serve it over HTTPS.', source: 'ArchToolKit' }));
      }
      if (!ignore) {
        findings.push(warning('network.f5.apm-reimport', 'With ignoreChanges off, every AS3 post re-imports the policy and overwrites any change made to it in the Visual Policy Editor since.', { remediation: 'Keep it on and change the policy in the GUI, or keep it off and only ever change the exported file.', source: 'ArchToolKit' }));
      }

      const body: Record<string, unknown> = {
        [`${app}_access`]: { class: 'Access_Profile', url, ignoreChanges: ignore },
        [`${app}_monitor`]: { class: 'Monitor', monitorType: 'https', interval: 5, timeout: 16, send: 'GET /health HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: Close\\r\\n\\r\\n', receive: '200' },
        [`${app}_pool`]: { class: 'Pool', loadBalancingMode: 'least-connections-member', monitors: [{ use: `${app}_monitor` }], members: as3Members(pool, { shareNodes: true }) },
        [`${app}_serverssl`]: { class: 'TLS_Client' },
        service: {
          class: 'Service_HTTPS',
          virtualAddresses: [address],
          virtualPort: 443,
          pool: `${app}_pool`,
          snat: 'auto',
          serverTLS: { bigip: str(values, 'certificate', '/Common/default.crt') },
          clientTLS: `${app}_serverssl`,
          profileAccess: { use: `${app}_access` },
          redirect80: true,
        },
      };
      const declaration = {
        $schema: 'https://raw.githubusercontent.com/F5Networks/f5-appsvcs-extension/main/schema/latest/as3-schema.json',
        class: 'AS3',
        action: 'deploy',
        persist: true,
        declaration: {
          class: 'ADC',
          schemaVersion: '3.45.0',
          id: `vcf-${app.toLowerCase()}`,
          label: `${app} behind APM`,
          remark: ' review before deploying.',
          [tenant]: { class: 'Tenant', [app]: { class: 'Application', template: 'generic', ...body } },
        },
      };

      return {
        platform: PLATFORM,
        title: `APM access profile on ${formatHostPort(address, 443)} for ${app}`,
        impact: 'brief',
        notes: [
          'APM has to be provisioned and licensed (the provisioning step), and each concurrent session uses an access session licence.',
          'The access policy itself — the logon page, the AAA server, MFA, SSO — is built and tested on a reference BIG-IP and exported. AS3 imports it; it does not build it. AAA server objects it names (AD, RADIUS, SAML IdP) must exist on this device first, with their credentials entered there.',
          'AS3 replaces the whole tenant: capture the current declaration first.',
          'The pool is reached over TLS again (re-encrypt). Use Service_HTTPS without clientTLS if the servers speak plain HTTP.',
          ...checked.notes,
        ],
        before: ['tmsh list sys provision apm', `curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`, 'tmsh list apm profile access'],
        config: JSON.stringify(declaration, null, 2).split('\n'),
        verify: [
          `tmsh list apm profile access /${tenant}/${app}/${app}_access`,
          `tmsh show ltm virtual /${tenant}/${app}/service`,
          'tmsh show apm access-session',
          `curl -skI https://${formatHostPort(address, 443)}/ | grep -i -E 'location|MRHSession'`,
          'Log on through a browser, then check the session in Access > Overview > Active Sessions.',
        ],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: {
          module: 'f5networks.f5_bigip.bigip_as3_deploy',
          args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' },
          hosts: 'bigips',
        },
        findings,
      };
    },
  }),
];

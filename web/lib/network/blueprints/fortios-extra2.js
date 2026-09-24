/**
 * Fortinet FortiOS: the rest of the gaps.
 *
 * The first two files cover addressing, policy, NAT, routing, SD-WAN, IPsec,
 * logging, administrative access and HA. What was missing is everything a
 * policy points *at* rather than the policy itself: the security profiles,
 * zones, the users and groups a policy names, traffic shaping, SSL VPN, the
 * local-in policy that protects the FortiGate's own services, and dynamic
 * routing.
 *
 * Every block applies as its `end` is entered — there is no commit holding it
 * back — so each back-out here is written to be pasted immediately.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { listOf, netmask, parseCidr,                   } from '../device.js';
import { isAnyNetwork,              } from '../../core/ip.js';
import { addressBody, compareHosts, fgtCidr, fgtHost, fgtInterfaceAddress, fgtSubnet, looksLikeAddress, noIpv6, nthHost, splitFamilies, v6Name } from './fortios-ip.js';

const PLATFORM = 'fortios'         ;
const SECRET = '<REQUIRED>';

export const FORTIOS_EXTRA_2                             = [
  deviceBlueprint({
    id: 'fortios_security_profiles',
    platform: PLATFORM,
    label: 'Security profiles',
    group: 'Profiles',
    description: 'The inspection a policy applies once it has decided to allow the traffic: antivirus, web filtering, application control, IPS and DNS filtering, as one consistent set.',
    inputs: [
      { id: 'profile_set', label: 'Profile name', control: 'text', default: 'CORPORATE' },
      { id: 'inspection_mode', label: 'Inspection', control: 'select', default: 'certificate', options: [
        { value: 'certificate', label: 'Certificate inspection — sees the name, not the content' },
        { value: 'deep', label: 'Deep inspection — decrypts and inspects fully' },
      ] },
      { id: 'av_action', label: 'Antivirus', control: 'select', default: 'block', options: [
        { value: 'block', label: 'Block infected files' },
        { value: 'monitor', label: 'Log only' },
      ] },
      { id: 'blocked_categories', label: 'Blocked web categories', control: 'text', default: '26, 61, 86, 88', hint: 'FortiGuard category ids — 26 malicious, 61 phishing, 86 newly registered, 88 spam' },
      { id: 'app_block', label: 'Blocked application categories', control: 'text', default: 'P2P, Proxy, Botnet' },
      { id: 'ips_profile', label: 'IPS profile', control: 'select', default: 'protect_client', options: [
        { value: 'protect_client', label: 'Client protection' },
        { value: 'protect_http_server', label: 'Server protection' },
        { value: 'all_default', label: 'All default signatures' },
      ] },
      { id: 'dns_filter', label: 'DNS filtering', control: 'toggle', default: true },
      { id: 'botnet_block', label: 'Block outbound botnet connections', control: 'toggle', default: true },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const name = str(values, 'profile_set', 'CORPORATE').toUpperCase().replace(/\s+/g, '-');
      const deep = str(values, 'inspection_mode', 'certificate') === 'deep';
      const categories = listOf(str(values, 'blocked_categories', ''));
      const apps = listOf(str(values, 'app_block', ''));
      const findings            = [];
      if (categories.length === 0) findings.push(error('network.fortios.no-categories', 'No web category is blocked, so the web filter logs and permits everything.', { source: 'ArchToolKit' }));
      if (deep) {
        findings.push(
          warning('network.fortios.deep-inspection', 'Deep inspection re-signs every TLS session. Every client must trust the FortiGate’s CA, and anything that pins a certificate — banking apps, software updaters, some cloud agents — will break until it is excluded.', {
            remediation: 'Deploy the CA first, build an exemption list, and turn deep inspection on for one group before everyone.',
            source: 'ArchToolKit',
          }),
        );
      } else {
        findings.push(
          warning('network.fortios.certificate-inspection-limits', 'Certificate inspection sees the server name and nothing else. Antivirus and IPS cannot examine the content of an encrypted session, so those profiles are largely inert on HTTPS traffic.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Security profile set ${name}`,
        impact: 'none',
        notes: [
          'The profiles do nothing until a firewall policy references them. Creating them is safe; attaching them is the change that affects traffic.',
          'FortiGuard ratings have to be reachable for web and DNS filtering to work. A FortiGate that cannot reach FortiGuard fails according to its rating-error setting, which is worth checking before this goes live.',
          'Inspection costs throughput. On a busy FortiGate confirm the model has headroom before enabling IPS and antivirus on every policy.',
        ],
        before: ['show antivirus profile', 'show webfilter profile', 'show application list', 'show ips sensor', 'diagnose firewall iprope list | head -20', 'get system performance status'],
        config: [
          'config antivirus profile',
          `  edit "${name}-AV"`,
          '    set feature-set proxy',
          '    config http',
          `      set av-scan ${str(values, 'av_action', 'block')}`,
          '    end',
          '    config https',
          `      set av-scan ${str(values, 'av_action', 'block')}`,
          '    end',
          '    config smtp',
          `      set av-scan ${str(values, 'av_action', 'block')}`,
          '    end',
          '  next',
          'end',
          '',
          'config webfilter profile',
          `  edit "${name}-WEB"`,
          '    set feature-set proxy',
          '    config ftgd-wf',
          '      config filters',
          ...categories.flatMap((category, index) => [`        edit ${index + 1}`, `          set category ${category}`, '          set action block', '        next']),
          '      end',
          '    end',
          '    set log-all-url enable',
          '    set web-content-log enable',
          '  next',
          'end',
          '',
          'config application list',
          `  edit "${name}-APP"`,
          '    config entries',
          ...apps.flatMap((app, index) => [`      edit ${index + 1}`, `        set category ${app}`, '        set action block', '      next']),
          `      edit ${apps.length + 1}`,
          '        set action pass',
          '      next',
          '    end',
          '  next',
          'end',
          '',
          ...(bool(values, 'dns_filter', true)
            ? [
                'config dnsfilter profile',
                `  edit "${name}-DNS"`,
                '    config ftgd-dns',
                '      config filters',
                ...categories.flatMap((category, index) => [`        edit ${index + 1}`, `          set category ${category}`, '          set action block', '        next']),
                '      end',
                '    end',
                ...(bool(values, 'botnet_block', true) ? ['    set block-botnet enable'] : []),
                '  next',
                'end',
                '',
              ]
            : []),
          'config firewall ssl-ssh-profile',
          `  edit "${name}-SSL"`,
          '    config https',
          `      set ports 443`,
          `      set status ${deep ? 'deep-inspection' : 'certificate-inspection'}`,
          '    end',
          ...(deep ? ['    set untrusted-caname "Fortinet_CA_Untrusted"', '    set server-cert-mode re-sign'] : []),
          '  next',
          'end',
          '',
          `${'!'} Then reference them from a policy:`,
          `${'!'} set utm-status enable / set av-profile "${name}-AV" / set webfilter-profile "${name}-WEB"`,
          `${'!'} set application-list "${name}-APP" / set ips-sensor "${str(values, 'ips_profile', 'protect_client')}" / set ssl-ssh-profile "${name}-SSL"`,
        ],
        verify: [
          `show antivirus profile ${name}-AV`,
          `show webfilter profile ${name}-WEB`,
          'diagnose webfilter fortiguard statistics list',
          `${'!'} Attach to one policy, then browse to a blocked category from an inside host`,
          'execute log filter category 2',
          'execute log display',
        ],
        backout: [
          'config firewall ssl-ssh-profile',
          `  delete "${name}-SSL"`,
          'end',
          'config application list',
          `  delete "${name}-APP"`,
          'end',
          'config webfilter profile',
          `  delete "${name}-WEB"`,
          'end',
          'config antivirus profile',
          `  delete "${name}-AV"`,
          'end',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_ssl_vpn',
    platform: PLATFORM,
    label: 'SSL VPN',
    group: 'VPN',
    description: 'Remote access in tunnel mode: the listening interface and port, the address pool, the portal, and the policy that says where those users may go.',
    inputs: [
      { id: 'interface', label: 'Listening interface', control: 'text', default: 'port1' },
      { id: 'port', label: 'Port', control: 'number', default: 10443, min: 1, max: 65535, hint: 'Not 443 if the interface also serves administration' },
      { id: 'pool_name', label: 'Address pool name', control: 'text', default: 'SSLVPN-POOL' },
      { id: 'pool_range', label: 'Address range', control: 'text', default: '10.212.134.200-10.212.134.250', hint: 'first-last, IPv4 or IPv6' },
      { id: 'pool_range6', label: 'IPv6 address range', control: 'text', default: '', hint: 'Optional, for dual-stack tunnels: fd00:212:134::200-fd00:212:134::250' },
      { id: 'portal_name', label: 'Portal name', control: 'text', default: 'full-access' },
      { id: 'split_tunnel', label: 'Split tunnel', control: 'select', default: 'split', options: [
        { value: 'split', label: 'Split — only the corporate networks' },
        { value: 'full', label: 'Full — everything through the FortiGate' },
      ] },
      { id: 'split_networks', label: 'Networks through the tunnel', control: 'text', default: 'CORP-NETWORKS', hint: 'An existing address or group object', showWhen: { input: 'split_tunnel', equals: ['split'] } },
      { id: 'split_networks6', label: 'IPv6 networks through the tunnel', control: 'text', default: '', hint: 'An existing address6 or addrgrp6 object — needed for IPv6 split tunnelling', showWhen: { input: 'split_tunnel', equals: ['split'] } },
      { id: 'user_group', label: 'User group allowed', control: 'text', default: 'GRP-VPN-USERS' },
      { id: 'dest_interface', label: 'Destination interface', control: 'text', default: 'port2' },
      { id: 'certificate', label: 'Server certificate', control: 'text', default: 'CERT-SSLVPN', hint: 'An imported certificate for the name users connect to — never a Fortinet_ factory one' },
      { id: 'mfa', label: 'Require two-factor', control: 'toggle', default: true },
      { id: 'idle_timeout', label: 'Idle timeout (seconds)', control: 'number', default: 300, min: 0, max: 259200 },
    ],
    change: (values                 )               => {
      const port = num(values, 'port', 10443);
      const pool = str(values, 'pool_name', 'SSLVPN-POOL');
      const range = str(values, 'pool_range', '');
      const split = str(values, 'split_tunnel', 'split') === 'split';
      const certificate = str(values, 'certificate', 'CERT-SSLVPN');
      const findings            = [];
      // Tunnel pools are per family: ip-pools/tunnel-ip-pools take IPv4
      // address objects, ipv6-pools/tunnel-ipv6-pools take address6 ones.
      const ranges = [range, str(values, 'pool_range6', '')].filter((r) => r.includes('-')).map((r) => {
        const [first = '', last = ''] = r.split('-').map((s) => s.trim());
        const a = fgtHost(first);
        const b = fgtHost(last);
        if (!a || !b) findings.push(error('network.fortios.bad-range', `"${r}" is not a range of two IPv4 or two IPv6 addresses.`, { source: 'ArchToolKit' }));
        else if (a.family !== b.family) findings.push(error('network.fortios.range-mixed-family', `"${r}" starts in one family and ends in the other.`, { source: 'ArchToolKit' }));
        else if (compareHosts(a.address, b.address) === 1) findings.push(error('network.fortios.range-inverted', `"${r}" ends before it starts.`, { source: 'ArchToolKit' }));
        return { first, last, family: a && b && a.family === b.family ? a.family : null };
      });
      const range4 = ranges.filter((r) => r.family === 4);
      const range6 = ranges.filter((r) => r.family === 6);
      if (range4.length > 1 || range6.length > 1) findings.push(error('network.fortios.sslvpn-two-pools', 'Both ranges are the same family. Give one IPv4 range and, optionally, one IPv6 range.', { source: 'ArchToolKit' }));
      // An IPv4 range as typed keeps the IPv4 output exactly as it was; an
      // IPv6 one in the first field makes an IPv6-only tunnel.
      const v4 = range4.length > 0 || range6.length === 0;
      const v6 = range6[0];
      const pool6 = v6Name(pool, v4 && !!v6);
      const split6 = str(values, 'split_networks6', '');
      if (v6 && split && !split6) {
        findings.push(error('network.fortios.sslvpn-split6', 'IPv6 split tunnelling needs the IPv6 networks through the tunnel: an address6 or addrgrp6 object.', { source: 'ArchToolKit' }));
      }
      if (!v6 && split && split6) {
        findings.push(warning('network.fortios.sslvpn-split6-no-pool', 'IPv6 split networks were given but no IPv6 address range, so clients get no IPv6 address and the IPv6 routes are not pushed.', { source: 'ArchToolKit' }));
      }
      const first4 = range4[0]?.first ?? range.split('-')[0] ?? '';
      const last4 = range4[0]?.last ?? range.split('-')[1] ?? '';
      if (port === 443) {
        findings.push(warning('network.fortios.sslvpn-443', 'Port 443 on the same interface as administrative HTTPS means the two compete, and a mistake in either exposes the other. Move administration off this interface or move SSL VPN off 443.', { source: 'ArchToolKit' }));
      }
      if (certificate.startsWith('Fortinet_')) {
        findings.push(
          error('network.fortios.factory-certificate', 'The factory certificate is self-signed and shared across every FortiGate ever made. Users get a warning, and anyone can present the same certificate.', {
            remediation: 'Import a certificate for the name users connect to before this is published.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!range.includes('-') && !v6) findings.push(error('network.fortios.bad-range', 'The address pool is not a range. Write it as 10.212.134.200-10.212.134.250.', { source: 'ArchToolKit' }));
      if (!bool(values, 'mfa', true)) {
        findings.push(warning('network.fortios.sslvpn-no-mfa', 'SSL VPN with a single factor is the most commonly exploited path into a network with a FortiGate on it. Require a second factor.', { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.fortios.sslvpn-patching', 'SSL VPN has been the subject of repeatedly exploited vulnerabilities. Anything published here must be on a current firmware version and must stay on one.', {
          remediation: 'Check the current build against Fortinet’s advisories before publishing, and have a patching plan.',
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `SSL VPN on ${str(values, 'interface', 'port1')}:${port}`,
        impact: 'brief',
        notes: [
          'The user group must already exist with its members and authentication source. This change references it.',
          'The firewall policy is what decides where connected users may go. Without it they authenticate, get an address, and reach nothing.',
          'The internal network needs a route back to the pool, via the FortiGate.',
          ...(v6 ? [`IPv6 clients get an address from ${pool6} (ipv6-pools / tunnel-ipv6-pools), and the policy carries it in srcaddr6/dstaddr6. The internal IPv6 network needs its own route back to that range.`] : []),
        ],
        before: ['show vpn ssl settings', 'show vpn ssl web portal', 'get vpn ssl monitor', 'show firewall policy | grep ssl', 'show firewall address'],
        config: [
          ...(v4 ? ['config firewall address', `  edit "${pool}"`, '    set type iprange', `    set start-ip ${first4}`, `    set end-ip ${last4}`, '  next', 'end', ''] : []),
          ...(v6 ? ['config firewall address6', `  edit "${pool6}"`, '    set type iprange', `    set start-ip ${fgtHost(v6.first)?.address ?? v6.first}`, `    set end-ip ${fgtHost(v6.last)?.address ?? v6.last}`, '  next', 'end', ''] : []),
          'config vpn ssl web portal',
          `  edit "${str(values, 'portal_name', 'full-access')}"`,
          '    set tunnel-mode enable',
          '    set web-mode disable',
          ...(v4
            ? [
                `    set ip-pools "${pool}"`,
                ...(split
                  ? ['    set split-tunneling enable', `    set split-tunneling-routing-address "${str(values, 'split_networks', '')}"`]
                  : ['    set split-tunneling disable']),
                '    set dns-server1 10.0.1.10',
              ]
            : []),
          ...(v6
            ? [
                '    set ipv6-tunnel-mode enable',
                `    set ipv6-pools "${pool6}"`,
                ...(split ? ['    set ipv6-split-tunneling enable', `    set ipv6-split-tunneling-routing-address "${split6}"`] : ['    set ipv6-split-tunneling disable']),
              ]
            : []),
          '  next',
          'end',
          '',
          'config vpn ssl settings',
          `  set servercert "${certificate}"`,
          `  set port ${port}`,
          `  set source-interface "${str(values, 'interface', 'port1')}"`,
          '  set source-address "all"',
          ...(v4 ? [`  set tunnel-ip-pools "${pool}"`] : []),
          ...(v6 ? [`  set tunnel-ipv6-pools "${pool6}"`] : []),
          `  set idle-timeout ${num(values, 'idle_timeout', 300)}`,
          '  set ssl-min-proto-ver tls1-2',
          '  set ciphersuite high',
          '  set login-attempt-limit 3',
          '  set login-block-time 300',
          '  config authentication-rule',
          '    edit 1',
          `      set groups "${str(values, 'user_group', 'GRP-VPN-USERS')}"`,
          `      set portal "${str(values, 'portal_name', 'full-access')}"`,
          ...(bool(values, 'mfa', true) ? ['      set auth any'] : []),
          '    next',
          '  end',
          'end',
          '',
          'config firewall policy',
          '  edit 0',
          '    set name "SSLVPN-TO-INTERNAL"',
          '    set srcintf "ssl.root"',
          `    set dstintf "${str(values, 'dest_interface', 'port2')}"`,
          ...(v4 ? [`    set srcaddr "${pool}"`, `    set dstaddr ${split ? `"${str(values, 'split_networks', '')}"` : '"all"'}`] : []),
          ...(v6 ? [`    set srcaddr6 "${pool6}"`, `    set dstaddr6 ${split ? `"${split6}"` : '"all"'}`] : []),
          `    set groups "${str(values, 'user_group', 'GRP-VPN-USERS')}"`,
          '    set action accept',
          '    set schedule "always"',
          '    set service "ALL"',
          '    set logtraffic all',
          '  next',
          'end',
        ],
        verify: [
          'show vpn ssl settings',
          'get vpn ssl monitor',
          'diagnose vpn ssl list',
          `${'!'} From outside: connect a client, confirm the address from the pool and reachability to one internal service`,
          'execute log filter category 0',
          'execute log display',
        ],
        backout: [
          'config firewall policy',
          `  ${'!'} delete the policy id shown by: show firewall policy | grep -f SSLVPN-TO-INTERNAL`,
          'end',
          'config vpn ssl settings',
          '  unset source-interface',
          'end',
          'config vpn ssl web portal',
          `  delete "${str(values, 'portal_name', 'full-access')}"`,
          'end',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_users_groups',
    platform: PLATFORM,
    label: 'Users, LDAP and groups',
    group: 'Identity',
    description: 'Where user identity comes from — LDAP, RADIUS or local — and the groups a policy or an SSL VPN rule can then name.',
    inputs: [
      { id: 'source', label: 'Identity source', control: 'select', default: 'ldap', options: [
        { value: 'ldap', label: 'LDAP or Active Directory' },
        { value: 'radius', label: 'RADIUS' },
        { value: 'local', label: 'Local users' },
      ] },
      { id: 'server_name', label: 'Server object name', control: 'text', default: 'LDAP-AD' },
      { id: 'servers', label: 'Servers', control: 'text', default: '10.0.5.10, 10.0.5.11', hint: 'Primary, secondary — IPv4, IPv6 or names' },
      { id: 'base_dn', label: 'Base DN', control: 'text', default: 'DC=example,DC=com', showWhen: { input: 'source', equals: ['ldap'] } },
      { id: 'bind_dn', label: 'Bind DN', control: 'text', default: 'CN=svc-fgt,OU=Service,DC=example,DC=com', showWhen: { input: 'source', equals: ['ldap'] } },
      { id: 'group_name', label: 'Group name', control: 'text', default: 'GRP-VPN-USERS' },
      { id: 'group_dn', label: 'Directory group', control: 'text', default: 'CN=vpn-users,OU=Groups,DC=example,DC=com', showWhen: { input: 'source', notEquals: ['local'] } },
      { id: 'local_users', label: 'Local users', control: 'textarea', default: '', hint: 'One name per line — passwords are set separately', showWhen: { input: 'source', equals: ['local'] } },
      { id: 'fsso', label: 'Also enable single sign-on', control: 'toggle', default: false },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const source = str(values, 'source', 'ldap');
      const serverName = str(values, 'server_name', 'LDAP-AD');
      const servers = listOf(str(values, 'servers', ''));
      const group = str(values, 'group_name', 'GRP-VPN-USERS');
      const users = str(values, 'local_users', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const findings            = [];
      if (source !== 'local' && servers.length === 0) findings.push(error('network.fortios.no-auth-servers', 'No authentication server was given.', { source: 'ArchToolKit' }));
      if (source !== 'local' && servers.length === 1) {
        findings.push(warning('network.fortios.single-auth-server', 'One authentication server means nobody can authenticate while it is down.', { source: 'ArchToolKit' }));
      }
      if (source === 'ldap') {
        findings.push(warning('network.fortios.ldaps', 'Use LDAPS on 636. Plain LDAP sends the bind and the user credentials in clear on the wire.', { source: 'ArchToolKit' }));
      }
      if (source === 'local') {
        findings.push(
          warning('network.fortios.local-users', 'Local users are not disabled when someone leaves and are invisible to whatever reviews access elsewhere. They are for break-glass and for service accounts, not for people.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${source === 'local' ? 'Local users' : source.toUpperCase()} and group ${group}`,
        impact: 'none',
        notes: [
          'The bind password or shared secret is `<REQUIRED>` and typed at apply time. It belongs in the vault the playbook reads, never in the change record.',
          'Test before relying on it: `diagnose test authserver ldap <server> <user> <password>` answers whether the bind, the base DN and the search all work, which no amount of reading the configuration will.',
          ...(bool(values, 'fsso', false) ? ['Single sign-on maps logged-in users to addresses. It needs a collector agent or polling configured separately — this only enables the FortiGate side.'] : []),
          ...(source !== 'local' && servers.some((s) => fgtHost(s)?.family === 6)
            ? ['An IPv6 server address is written as-is in `set server`. VERIFY on the running build that the server answers over IPv6 (the diagnose test below proves it), and that a route to it exists in `get router info6 routing-table`.']
            : []),
        ],
        before: ['show user ldap', 'show user radius', 'show user group', 'show user local', 'diagnose test authserver ldap'],
        config: [
          ...(source === 'ldap'
            ? [
                'config user ldap',
                `  edit "${serverName}"`,
                `    set server "${servers[0] ?? ''}"`,
                ...(servers[1] ? [`    set secondary-server "${servers[1]}"`] : []),
                `    set cnid "sAMAccountName"`,
                `    set dn "${str(values, 'base_dn', '')}"`,
                '    set type regular',
                `    set username "${str(values, 'bind_dn', '')}"`,
                `    set password ${SECRET}`,
                '    set secure ldaps',
                '    set port 636',
                '    set server-identity-check enable',
                '  next',
                'end',
              ]
            : source === 'radius'
              ? [
                  'config user radius',
                  `  edit "${serverName}"`,
                  `    set server "${servers[0] ?? ''}"`,
                  `    set secret ${SECRET}`,
                  ...(servers[1] ? [`    set secondary-server "${servers[1]}"`, `    set secondary-secret ${SECRET}`] : []),
                  '    set auth-type auto',
                  '    set nas-ip 0.0.0.0',
                  '  next',
                  'end',
                ]
              : [
                  'config user local',
                  ...users.flatMap((user) => [`  edit "${user}"`, '    set type password', `    set passwd ${SECRET}`, '    set status enable', '  next']),
                  'end',
                ]),
          '',
          'config user group',
          `  edit "${group}"`,
          '    set group-type firewall',
          ...(source === 'local'
            ? ['    set member ' + users.map((u) => `"${u}"`).join(' ')]
            : [
                `    set member "${serverName}"`,
                '    config match',
                '      edit 1',
                `        set server-name "${serverName}"`,
                `        set group-name "${str(values, 'group_dn', '')}"`,
                '      next',
                '    end',
              ]),
          '  next',
          'end',
          '',
          ...(bool(values, 'fsso', false)
            ? ['config user fsso', '  edit "FSSO-COLLECTOR"', '    set server "10.0.5.20"', `    set password ${SECRET}`, '  next', 'end', '']
            : []),
        ],
        verify: [
          `show user group ${group}`,
          ...(source === 'ldap' ? [`diagnose test authserver ldap ${serverName} <user> <password>`] : source === 'radius' ? [`diagnose test authserver radius ${serverName} pap <user> <password>`] : ['show user local']),
          'diagnose debug application fnbamd -1',
          `${'!'} Then attempt one login, read the output, and: diagnose debug disable`,
        ],
        backout: [
          'config user group',
          `  delete "${group}"`,
          'end',
          ...(source !== 'local' ? [`config user ${source}`, `  delete "${serverName}"`, 'end'] : ['config user local', ...users.map((u) => `  delete "${u}"`), 'end']),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_traffic_shaping',
    platform: PLATFORM,
    label: 'Traffic shaping',
    group: 'Policies',
    description: 'Guarantee or cap bandwidth per application, per policy or per user, on a circuit where there is not enough to go round.',
    inputs: [
      { id: 'shaper_name', label: 'Shaper name', control: 'text', default: 'SHAPER-BUSINESS' },
      { id: 'kind', label: 'Shaper kind', control: 'select', default: 'shared', options: [
        { value: 'shared', label: 'Shared — one budget across everything that matches' },
        { value: 'per-ip', label: 'Per IP — the same budget for each address' },
      ] },
      { id: 'guaranteed', label: 'Guaranteed bandwidth (kbps)', control: 'number', default: 10000, min: 0, max: 100000000 },
      { id: 'maximum', label: 'Maximum bandwidth (kbps)', control: 'number', default: 50000, min: 1, max: 100000000 },
      { id: 'priority', label: 'Priority', control: 'select', default: 'high', options: [
        { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' },
        { value: 'low', label: 'Low' },
      ] },
      { id: 'dscp', label: 'Set DSCP', control: 'text', default: '', hint: 'e.g. 101110 for EF — empty to leave it alone' },
      { id: 'policy_kind', label: 'Apply by', control: 'select', default: 'application', options: [
        { value: 'application', label: 'Application category' },
        { value: 'address', label: 'Source and destination' },
      ] },
      { id: 'ip_version', label: 'Traffic family', control: 'select', default: '4', options: [
        { value: '4', label: 'IPv4 (srcaddr/dstaddr)' },
        { value: '6', label: 'IPv6 (srcaddr6/dstaddr6)' },
      ] },
      { id: 'applications', label: 'Applications', control: 'text', default: 'Video/Audio, Collaboration', showWhen: { input: 'policy_kind', equals: ['application'] } },
      { id: 'source', label: 'Source', control: 'text', default: 'all', showWhen: { input: 'policy_kind', equals: ['address'] } },
      { id: 'destination', label: 'Destination', control: 'text', default: 'all', showWhen: { input: 'policy_kind', equals: ['address'] } },
      { id: 'interface', label: 'Outgoing interface', control: 'text', default: 'port1' },
    ],
    change: (values                 )               => {
      const name = str(values, 'shaper_name', 'SHAPER').toUpperCase().replace(/\s+/g, '-');
      const perIp = str(values, 'kind', 'shared') === 'per-ip';
      const guaranteed = num(values, 'guaranteed', 10000);
      const maximum = num(values, 'maximum', 50000);
      const six = str(values, 'ip_version', '4') === '6';
      const findings            = [];
      if (str(values, 'policy_kind', 'application') === 'address') {
        for (const name of [str(values, 'source', 'all'), str(values, 'destination', 'all')].filter(looksLikeAddress)) {
          findings.push(error('network.fortios.shaping-literal-address', `"${name}" is an address, but a shaping policy names ${six ? 'address6' : 'address'} objects. Create the object first and name it here.`, { source: 'ArchToolKit' }));
        }
      }
      if (guaranteed > maximum) {
        findings.push(error('network.fortios.shaper-inverted', 'The guaranteed bandwidth is above the maximum, which the FortiGate accepts and then behaves unpredictably about.', { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.fortios.shaping-egress', 'Shaping controls what leaves this interface. Inbound saturation has to be handled by the far end or the carrier — a shaper here cannot stop traffic that has already crossed the circuit.', { source: 'ArchToolKit' }),
      );
      if (perIp) {
        findings.push(warning('network.fortios.per-ip-scale', 'A per-IP shaper holds state for every address it sees. On a large user population that is a memory cost worth checking on the model in front of you.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Traffic shaper ${name}`,
        impact: 'brief',
        notes: [
          'A shaping policy is matched separately from the firewall policy. Traffic can be allowed by one and shaped by another, and the two lists are edited in different places.',
          'Guarantees only bind under congestion. On an idle circuit nothing changes, which makes this difficult to test before it matters.',
          'Set the interface’s outbandwidth to the real circuit speed, not the port speed, or the shaper has nothing meaningful to divide up.',
          ...(six ? ['This shaping policy matches IPv6 (`set ip-version 6` with srcaddr6/dstaddr6 naming address6 objects). VERIFY: if the running build rejects `ip-version` in shaping-policy, drop that line — srcaddr6/dstaddr6 alone carry the IPv6 match.'] : []),
        ],
        before: ['show firewall shaper traffic-shaper', 'show firewall shaping-policy', 'diagnose firewall shaper traffic-shaper list', 'get system interface'],
        config: [
          `config firewall shaper ${perIp ? 'per-ip-shaper' : 'traffic-shaper'}`,
          `  edit "${name}"`,
          ...(perIp
            ? [`    set max-bandwidth ${maximum}`, '    set max-concurrent-session 0']
            : [
                `    set guaranteed-bandwidth ${guaranteed}`,
                `    set maximum-bandwidth ${maximum}`,
                `    set priority ${str(values, 'priority', 'high')}`,
                '    set bandwidth-unit kbps',
                ...(str(values, 'dscp', '') ? ['    set diffserv enable', `    set diffservcode ${str(values, 'dscp', '')}`] : []),
              ]),
          '  next',
          'end',
          '',
          'config firewall shaping-policy',
          '  edit 0',
          `    set name "SHAPE-${name}"`,
          '    set status enable',
          ...(six ? ['    set ip-version 6'] : []),
          ...(str(values, 'policy_kind', 'application') === 'application'
            ? [`    set app-category ${listOf(str(values, 'applications', '')).map((a) => `"${a}"`).join(' ')}`, `    set srcaddr${six ? '6' : ''} "all"`, `    set dstaddr${six ? '6' : ''} "all"`]
            : [`    set srcaddr${six ? '6' : ''} "${str(values, 'source', 'all')}"`, `    set dstaddr${six ? '6' : ''} "${str(values, 'destination', 'all')}"`]),
          `    set dstintf "${str(values, 'interface', 'port1')}"`,
          '    set service "ALL"',
          ...(perIp ? [`    set per-ip-shaper "${name}"`] : [`    set traffic-shaper "${name}"`, `    set traffic-shaper-reverse "${name}"`]),
          '  next',
          'end',
          '',
          `${'!'} Set the real circuit speed on the interface, or the shaper divides up the port speed:`,
          `${'!'} config system interface / edit "${str(values, 'interface', 'port1')}" / set outbandwidth <kbps> / next / end`,
        ],
        verify: [
          'diagnose firewall shaper traffic-shaper list',
          `diagnose firewall shaper traffic-shaper stats`,
          'show firewall shaping-policy',
          `${'!'} Generate congestion deliberately and confirm the guaranteed class holds`,
          'get system performance status',
        ],
        backout: ['config firewall shaping-policy', `  ${'!'} delete the policy id for SHAPE-${name}`, 'end', `config firewall shaper ${perIp ? 'per-ip-shaper' : 'traffic-shaper'}`, `  delete "${name}"`, 'end'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_local_in_policy',
    platform: PLATFORM,
    label: 'Local-in policy',
    group: 'Hardening',
    description: 'Restrict who may reach the FortiGate’s own services — management, SSL VPN, IPsec, BGP — which ordinary firewall policy does not govern at all.',
    inputs: [
      { id: 'interface', label: 'Interface', control: 'text', default: 'port1' },
      { id: 'service', label: 'Service to restrict', control: 'select', default: 'HTTPS', options: [
        { value: 'HTTPS', label: 'HTTPS — administration and SSL VPN' },
        { value: 'SSH', label: 'SSH' },
        { value: 'IKE', label: 'IKE — IPsec' },
        { value: 'BGP', label: 'BGP' },
        { value: 'SNMP', label: 'SNMP' },
      ] },
      { id: 'allowed', label: 'Allowed source object', control: 'text', default: 'MGMT-NETWORKS', hint: 'An existing address or group object' },
      { id: 'allowed_addresses', label: 'Create the object from', control: 'text', default: '10.0.1.0/24, 10.0.2.0/24', hint: 'IPv4 and/or IPv6 prefixes — empty if the object already exists. IPv6 ones become an addrgrp6 and a local-in-policy6' },
      { id: 'allowed6', label: 'Allowed IPv6 source object', control: 'text', default: '', hint: 'An existing address6/addrgrp6 object — or empty to take it from the IPv6 prefixes above' },
      { id: 'action', label: 'Everything else', control: 'select', default: 'deny', options: [
        { value: 'deny', label: 'Deny' },
        { value: 'accept', label: 'Accept — count only, for a dry run' },
      ] },
      { id: 'log', label: 'Log denied attempts', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const iface = str(values, 'interface', 'port1');
      const service = str(values, 'service', 'HTTPS');
      const object = str(values, 'allowed', 'MGMT-NETWORKS');
      const deny = str(values, 'action', 'deny') === 'deny';
      const log = bool(values, 'log', true);
      const findings            = [];
      const all = listOf(str(values, 'allowed_addresses', ''));
      for (const address of all) if (!fgtCidr(address)) findings.push(error('network.fortios.bad-prefix', `"${address}" is not a valid IPv4 or IPv6 prefix.`, { source: 'ArchToolKit' }));
      // IPv4 and IPv6 local-in rules are separate tables on 7.0–7.4
      // (local-in-policy and local-in-policy6), each naming its own family's objects.
      const addresses = all.filter((a) => fgtCidr(a)?.family !== 6);
      const addresses6 = all.filter((a) => fgtCidr(a)?.family === 6);
      const has4 = addresses.length > 0 || addresses6.length === 0;
      const object6 = str(values, 'allowed6', '') || v6Name(object, has4);
      const has6 = addresses6.length > 0 || str(values, 'allowed6', '') !== '';
      for (const any of all.filter((a) => isAnyNetwork(a))) {
        findings.push(warning('network.fortios.local-in-any', `${any} allows every address, so the permit rule restricts nothing.`, { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.fortios.local-in-lockout', 'A local-in policy that does not include the address you are connecting from will disconnect you the moment it applies, and there is no commit timer to save you. Confirm your own address is inside the allowed object, and have console access.', {
          remediation: 'Apply it from the console, or from an address you have verified is in the list.',
          source: 'ArchToolKit',
        }),
      );
      // One permit and one catch-all for a table. local-in-policy6 is not
      // given logtraffic: it is not a documented option there on every 7.x build.
      const rules = (table        , allowed        , withLog         )           => [
        `config firewall ${table}`,
        '  edit 0',
        `    set intf "${iface}"`,
        `    set srcaddr "${allowed}"`,
        '    set dstaddr "all"',
        `    set service "${service}"`,
        '    set action accept',
        '    set schedule "always"',
        '    set status enable',
        `    set comments "Permit ${service} from ${allowed}"`,
        '  next',
        '  edit 0',
        `    set intf "${iface}"`,
        '    set srcaddr "all"',
        '    set dstaddr "all"',
        `    set service "${service}"`,
        `    set action ${deny ? 'deny' : 'accept'}`,
        '    set schedule "always"',
        '    set status enable',
        ...(withLog && log ? ['    set logtraffic enable'] : []),
        `    set comments "Deny everything else"`,
        '  next',
        'end',
      ];
      if (!deny) {
        findings.push(warning('network.fortios.local-in-dry-run', 'With the action set to accept this policy counts matches and blocks nothing. That is the safe way to see what would be denied — but remember to come back and set it to deny.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Local-in policy: ${service} on ${iface} from ${[...(has4 ? [object] : []), ...(has6 ? [object6] : [])].join(' and ')} only`,
        impact: 'brief',
        notes: [
          'Ordinary firewall policy governs traffic *through* the FortiGate. Traffic *to* the FortiGate — its administration, its VPN listeners, its routing protocols — is governed only by local-in policy and the interface’s allowaccess. Both need to be right.',
          'Local-in policies are evaluated in order and the list is not visible in the web interface on every version. Keep the ordering deliberate.',
          ...(has4 && !has6 ? ['This restricts IPv4 only. If the interface has an IPv6 address and ip6-allowaccess, the same service is still reachable over IPv6 — add IPv6 prefixes to cover it.'] : []),
          ...(has6
            ? [
                `IPv6 is restricted in its own table, local-in-policy6, naming ${object6}.`,
                'VERIFY: local-in-policy6 is the IPv6 table on FortiOS 7.0–7.4. On a later build that has merged it into local-in-policy, move the IPv6 rules there with srcaddr6/dstaddr6. Denied IPv6 attempts are logged only if that build offers logtraffic on the IPv6 rule.',
              ]
            : []),
        ],
        before: ['show firewall local-in-policy', ...(has6 ? ['show firewall local-in-policy6'] : []), `show system interface ${iface}`, 'diagnose firewall iprope list 100024', 'get system admin list'],
        config: [
          ...(has4 && addresses.length > 0
            ? [
                'config firewall addrgrp',
                `  ${'!'} If ${object} does not exist yet, create its members first:`,
                'end',
                'config firewall address',
                ...addresses.flatMap((address, index) => {
                  const cidr = parseCidr(address);
                  return [`  edit "${object}-${index + 1}"`, '    set subnet ' + (cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : address), '  next'];
                }),
                'end',
                'config firewall addrgrp',
                `  edit "${object}"`,
                `    set member ${addresses.map((_, index) => `"${object}-${index + 1}"`).join(' ')}`,
                '  next',
                'end',
                '',
              ]
            : []),
          ...(has4 ? rules('local-in-policy', object, true) : []),
          ...(has6
            ? [
                ...(has4 ? [''] : []),
                ...(addresses6.length > 0
                  ? [
                      'config firewall address6',
                      ...addresses6.flatMap((address, index) => [`  edit "${object6}-${index + 1}"`, ...addressBody(fgtCidr(address) , '    '), '  next']),
                      'end',
                      'config firewall addrgrp6',
                      `  edit "${object6}"`,
                      `    set member ${addresses6.map((_, index) => `"${object6}-${index + 1}"`).join(' ')}`,
                      '  next',
                      'end',
                      '',
                    ]
                  : []),
                ...rules('local-in-policy6', object6, false),
              ]
            : []),
        ],
        verify: [
          ...(has4 ? ['show firewall local-in-policy', 'diagnose firewall iprope list 100024'] : []),
          ...(has6 ? ['show firewall local-in-policy6'] : []),
          `${'!'} From an allowed address: connect. From somewhere else: confirm it is refused.`,
          'execute log filter category 1',
          'execute log display',
        ],
        // Delete by id, never `purge`: purge empties the whole table, every
        // local-in rule on the box, not just the two added here.
        backout: [
          ...(has4 ? ['config firewall local-in-policy', `  ${'!'} delete both rule ids shown by: show firewall local-in-policy`, 'end'] : []),
          ...(has6 ? ['config firewall local-in-policy6', `  ${'!'} delete both rule ids shown by: show firewall local-in-policy6`, 'end'] : []),
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_zones',
    platform: PLATFORM,
    label: 'Zones',
    group: 'Network',
    description: 'Group interfaces into a zone so one policy covers all of them — and decide whether traffic may cross between members without a policy.',
    inputs: [
      { id: 'zone_name', label: 'Zone name', control: 'text', default: 'ZONE-INTERNAL' },
      { id: 'interfaces', label: 'Member interfaces', control: 'text', default: 'port3, port4, port5' },
      { id: 'intrazone', label: 'Traffic between members', control: 'select', default: 'deny', options: [
        { value: 'deny', label: 'Deny — a policy is needed even inside the zone' },
        { value: 'allow', label: 'Allow — members can talk freely' },
      ] },
      { id: 'zone_description', label: 'Description', control: 'text', default: 'Internal user networks' },
      { id: 'vdom', label: 'VDOM', control: 'text', default: 'root' },
    ],
    change: (values                 )               => {
      const zone = str(values, 'zone_name', 'ZONE').toUpperCase().replace(/\s+/g, '-');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const intrazone = str(values, 'intrazone', 'deny');
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.fortios.no-members', 'A zone with no members matches nothing.', { source: 'ArchToolKit' }));
      findings.push(
        warning('network.fortios.zone-breaks-policies', 'An interface cannot be in a zone and named directly in a policy at the same time. Every existing policy that names one of these interfaces must be rewritten to name the zone first, or adding the interface to the zone will fail — and any policy that does get orphaned stops matching.', {
          remediation: 'List the affected policies before the change: show firewall policy | grep -f <interface>.',
          source: 'ArchToolKit',
        }),
      );
      if (intrazone === 'allow') {
        findings.push(
          warning('network.fortios.intrazone-allow', 'With intra-zone traffic allowed, anything on one member interface reaches anything on another without a policy and without a log. That is convenient and it is also a segment boundary that exists only on the diagram.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Zone ${zone} with ${ifaces.length} member${ifaces.length === 1 ? '' : 's'}`,
        impact: 'outage',
        notes: [
          'Policies naming a member interface directly have to be moved to the zone first. The FortiGate refuses to add an interface that is still referenced, which is a helpful failure — the unhelpful one is a policy that silently stops matching.',
          'Existing sessions are not re-evaluated. The effect appears for new sessions, which can make this look fine for several minutes.',
        ],
        before: ['show system zone', 'show system interface', ...ifaces.map((i) => `show firewall policy | grep -f "${i}"`), 'diagnose sys session list | head -20'],
        config: [
          'config system zone',
          `  edit "${zone}"`,
          `    set description "${str(values, 'zone_description', '')}"`,
          `    set intrazone ${intrazone}`,
          `    set interface ${ifaces.map((i) => `"${i}"`).join(' ')}`,
          '  next',
          'end',
          '',
          `${'!'} Then rewrite every policy that named a member interface to name "${zone}" instead.`,
        ],
        verify: ['show system zone', `diagnose sys vd list | grep ${zone}`, 'show firewall policy', `${'!'} Confirm traffic across each member still passes, and that the policy hit counters move`, 'diagnose firewall iprope show 100004'],
        backout: ['config system zone', `  delete "${zone}"`, 'end', `${'!'} Then restore the policies that named the interfaces directly.`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_dynamic_routing',
    platform: PLATFORM,
    label: 'BGP or OSPF',
    group: 'Routing',
    description: 'Make the FortiGate a routing peer rather than something pointed at statically, with the redistribution filtered to what is meant to leave.',
    inputs: [
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'bgp', options: [
        { value: 'bgp', label: 'BGP' },
        { value: 'ospf', label: 'OSPF' },
      ] },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.2.1', hint: 'A 32-bit id in dotted form, also for IPv6' },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65020, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer', label: 'Peer address', control: 'text', default: '10.0.12.1', hint: 'IPv4 or IPv6', showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer_as', label: 'Peer AS', control: 'number', default: 65010, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'area', label: 'OSPF area', control: 'text', default: '0.0.0.0', showWhen: { input: 'protocol', equals: ['ospf'] } },
      { id: 'ospf_networks', label: 'Networks in the area', control: 'text', default: '10.0.12.0/30', hint: 'IPv4 (OSPFv2 network statements)', showWhen: { input: 'protocol', equals: ['ospf'] } },
      { id: 'ospf6_interfaces', label: 'OSPFv3 (IPv6) interfaces', control: 'text', default: '', hint: 'Interface names to run OSPFv3 on in the same area — empty for no IPv6', showWhen: { input: 'protocol', equals: ['ospf'] } },
      { id: 'advertise', label: 'Prefixes to advertise', control: 'textarea', default: '10.20.0.0/16', hint: 'One per line, IPv4 (network) or IPv6 (network6)' },
      { id: 'authentication', label: 'Authenticate the adjacency', control: 'toggle', default: true },
      { id: 'graceful_restart', label: 'Graceful restart', control: 'toggle', default: true, hint: 'Keeps forwarding through an HA failover' },
    ],
    change: (values                 )               => {
      const protocol = str(values, 'protocol', 'bgp');
      const advertise = str(values, 'advertise', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const findings            = [];
      for (const prefix of advertise) if (!fgtCidr(prefix)) findings.push(error('network.fortios.bad-prefix', `"${prefix}" is not a prefix.`, { source: 'ArchToolKit' }));
      // IPv4 prefixes go in `config network`, IPv6 in `config network6` with
      // prefix6; an IPv6 neighbour or IPv6 prefix needs activate6 on the peer.
      const adv4 = advertise.filter((p) => fgtCidr(p)?.family !== 6);
      const adv6 = advertise.filter((p) => fgtCidr(p)?.family === 6);
      const peerText = str(values, 'peer', '');
      const peer = fgtHost(peerText);
      if (protocol === 'bgp' && peerText && !peer) findings.push(error('network.fortios.bad-peer', `The peer "${peerText}" is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      const peerAddress = peer?.address ?? peerText;
      const peer6 = peer?.family === 6;
      const routerId = str(values, 'router_id', '');
      if (fgtHost(routerId)?.family === 6) {
        findings.push(error('network.fortios.router-id-ipv6', 'The router id is a 32-bit number written as dotted IPv4, even for IPv6 routing. An IPv6 address is not accepted here.', { source: 'ArchToolKit' }));
      }
      if (protocol === 'bgp' && ((peer6 && adv4.length > 0) || (!peer6 && peer && adv6.length > 0))) {
        findings.push(
          warning('network.fortios.bgp-cross-family', `IPv${peer6 ? 4 : 6} prefixes are advertised over an IPv${peer6 ? 6 : 4} session. VERIFY the peer negotiates that address family and that the next hop it receives is reachable — a cross-family next hop is dropped unless both ends handle it.`, { source: 'ArchToolKit' }),
        );
      }
      const ospf6 = listOf(str(values, 'ospf6_interfaces', ''));
      const ospfNetworks = listOf(str(values, 'ospf_networks', ''));
      if (protocol === 'ospf') {
        for (const network of ospfNetworks.filter((n) => fgtCidr(n)?.family === 6)) {
          findings.push({ ...noIpv6('ospf-network-ipv6', `An OSPF (v2) network statement ("${network}")`), remediation: 'OSPFv3 carries IPv6 and is enabled per interface: name the interfaces in "OSPFv3 (IPv6) interfaces" instead.' });
        }
        if (ospf6.length > 0 && bool(values, 'authentication', true)) {
          findings.push(
            warning('network.fortios.ospf6-unauthenticated', 'OSPFv3 has no MD5 option: it is authenticated with IPsec (AH or ESP) keys per area or interface, which this change does not generate. The OSPFv3 adjacency is unauthenticated until that is added.', { source: 'ArchToolKit' }),
          );
        }
      }
      if (advertise.length === 0) {
        findings.push(warning('network.fortios.no-advertisements', 'Nothing is being advertised, so this peers and receives only. That is a valid design and an easy mistake — confirm it is deliberate.', { source: 'ArchToolKit' }));
      }
      if (!bool(values, 'authentication', true)) {
        findings.push(warning('network.fortios.routing-unauthenticated', 'An unauthenticated adjacency lets anything on the segment inject a route and pull traffic around the policy.', { remediation: 'The key is `<REQUIRED>` here and belongs in the vault.', source: 'ArchToolKit' }));
      }
      if (!bool(values, 'graceful_restart', true)) {
        findings.push(warning('network.fortios.no-graceful-restart', 'Without graceful restart, an HA failover withdraws every route and the network reconverges around it — which turns a sub-second failover into a routing event.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `${protocol.toUpperCase()} on the FortiGate`,
        impact: 'brief',
        notes: [
          'Routes learned here still have to pass policy. A route arriving does not make the traffic permitted.',
          'A firewall that peers withdraws routes when it reboots, so a maintenance window now moves traffic for the wider network rather than only for this device.',
          ...(protocol === 'bgp' ? ['The BGP password is `<REQUIRED>` and must match the peer exactly. It belongs in the vault.'] : []),
        ],
        before: [`get router info ${protocol} summary`, 'get router info routing-table all', 'show router ' + protocol, 'get system ha status'],
        config:
          protocol === 'bgp'
            ? [
                'config router bgp',
                `  set as ${num(values, 'local_as', 65020)}`,
                `  set router-id ${str(values, 'router_id', '')}`,
                '  set ebgp-multipath enable',
                ...(bool(values, 'graceful_restart', true) ? ['  set graceful-restart enable', '  set graceful-restart-time 120'] : []),
                '  config neighbor',
                `    edit "${peerAddress}"`,
                `      set remote-as ${num(values, 'peer_as', 65010)}`,
                ...(peer6 || adv6.length > 0 ? ['      set activate6 enable'] : []),
                ...(peer6 && adv4.length === 0 ? ['      set activate disable'] : []),
                '      set soft-reconfiguration enable',
                ...(peer6 || adv6.length > 0 ? ['      set soft-reconfiguration6 enable'] : []),
                '      set connect-timer 10',
                ...(bool(values, 'authentication', true) ? [`      set password ${SECRET}`] : []),
                ...(bool(values, 'graceful_restart', true) ? ['      set capability-graceful-restart enable'] : []),
                ...(bool(values, 'graceful_restart', true) && (peer6 || adv6.length > 0) ? ['      set capability-graceful-restart6 enable'] : []),
                '    next',
                '  end',
                ...(adv4.length > 0 || adv6.length === 0
                  ? [
                      '  config network',
                      ...adv4.flatMap((prefix, index) => {
                        const cidr = parseCidr(prefix);
                        return [`    edit ${index + 1}`, `      set prefix ${cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : prefix}`, '    next'];
                      }),
                      '  end',
                    ]
                  : []),
                ...(adv6.length > 0
                  ? ['  config network6', ...adv6.flatMap((prefix, index) => [`    edit ${index + 1}`, `      set prefix6 ${fgtSubnet(fgtCidr(prefix) )}`, '    next']), '  end']
                  : []),
                'end',
              ]
            : [
                'config router ospf',
                `  set router-id ${str(values, 'router_id', '')}`,
                '  set default-information-originate disable',
                '  config area',
                `    edit ${str(values, 'area', '0.0.0.0')}`,
                ...(bool(values, 'authentication', true) ? ['      set authentication md5'] : []),
                '    next',
                '  end',
                '  config network',
                ...ospfNetworks
                  .filter((network) => fgtCidr(network)?.family !== 6)
                  .flatMap((network, index) => {
                    const cidr = parseCidr(network);
                    return [`    edit ${index + 1}`, `      set prefix ${cidr ? `${cidr.address} ${netmask(cidr.prefix)}` : network}`, `      set area ${str(values, 'area', '0.0.0.0')}`, '    next'];
                  }),
                '  end',
                'end',
                // OSPFv3: the same router id and area, enabled per interface.
                ...(ospf6.length > 0
                  ? [
                      '',
                      'config router ospf6',
                      `  set router-id ${routerId}`,
                      '  config area',
                      `    edit ${str(values, 'area', '0.0.0.0')}`,
                      '    next',
                      '  end',
                      '  config ospf6-interface',
                      ...ospf6.flatMap((iface) => [`    edit "${iface}"`, `      set interface "${iface}"`, `      set area-id ${str(values, 'area', '0.0.0.0')}`, '    next']),
                      '  end',
                      'end',
                    ]
                  : []),
              ],
        verify: [
          `get router info ${protocol} ${protocol === 'bgp' ? 'summary' : 'neighbor'}`,
          ...(protocol === 'bgp' ? ['get router info bgp neighbors', 'get router info bgp network'] : ['get router info ospf neighbor', 'get router info ospf interface']),
          ...(protocol === 'bgp' && (peer6 || adv6.length > 0) ? ['get router info6 bgp summary', 'get router info6 bgp network'] : []),
          ...(protocol === 'ospf' && ospf6.length > 0 ? ['get router info6 ospf neighbor', 'get router info6 ospf interface'] : []),
          'get router info routing-table all',
          ...((protocol === 'bgp' && (peer6 || adv6.length > 0)) || (protocol === 'ospf' && ospf6.length > 0) ? ['get router info6 routing-table'] : []),
          `${'!'} From the peer: confirm only the intended prefixes arrived`,
        ],
        backout:
          protocol === 'bgp'
            ? [
                'config router bgp',
                '  config neighbor',
                `    delete "${peerAddress}"`,
                '  end',
                ...(adv6.length > 0 ? ['  config network6', ...adv6.map((_, index) => `    delete ${index + 1}`), '  end'] : []),
                'end',
              ]
            : [
                'config router ospf',
                '  unset router-id',
                '  purge',
                'end',
                ...(ospf6.length > 0
                  ? ['config router ospf6', '  config ospf6-interface', ...ospf6.map((iface) => `    delete "${iface}"`), '  end', '  config area', `    delete ${str(values, 'area', '0.0.0.0')}`, '  end', 'end']
                  : []),
              ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'fortios_vdom',
    platform: PLATFORM,
    label: 'VDOM',
    group: 'Platform',
    description: 'Split one FortiGate into separate virtual firewalls with their own policies, routing and administrators — and the inter-VDOM link if they need to talk.',
    inputs: [
      { id: 'vdom_name', label: 'VDOM name', control: 'text', default: 'CUSTOMER-A' },
      { id: 'mode', label: 'VDOM mode', control: 'select', default: 'split-task', options: [
        { value: 'split-task', label: 'Split-task — one VDOM for management, one for traffic' },
        { value: 'multi-vdom', label: 'Multi-VDOM — several independent firewalls' },
      ] },
      { id: 'interfaces', label: 'Interfaces to move', control: 'text', default: 'port3, port4', hint: 'Moving an interface clears its configuration' },
      { id: 'inspection', label: 'Inspection mode', control: 'select', default: 'flow', options: [
        { value: 'flow', label: 'Flow-based — faster' },
        { value: 'proxy', label: 'Proxy-based — more inspection features' },
      ] },
      { id: 'intervdom_link', label: 'Inter-VDOM link to', control: 'text', default: '', hint: 'Another VDOM name, or empty for none' },
      { id: 'link_subnet', label: 'Link subnet', control: 'text', default: '10.254.1.0/30', hint: 'IPv4, IPv6 or both: 10.254.1.0/30, fd00:254:1::/64', showWhen: { input: 'intervdom_link', notEquals: [''] } },
      { id: 'resource_limits', label: 'Set resource limits', control: 'toggle', default: false },
      { id: 'session_limit', label: 'Maximum sessions', control: 'number', default: 100000, min: 0, showWhen: { input: 'resource_limits', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const vdom = str(values, 'vdom_name', 'CUSTOMER-A').toUpperCase().replace(/\s+/g, '-');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const link = str(values, 'intervdom_link', '');
      const findings            = [];
      const linkFam = link ? splitFamilies(listOf(str(values, 'link_subnet', '')), 'the link subnet', findings) : { v4: [], v6: [] };
      const linkCidr = linkFam.v4[0] ? fgtCidr(linkFam.v4[0]) : null;
      const linkCidr6 = linkFam.v6[0] ? fgtCidr(linkFam.v6[0]) : null;
      if (linkFam.v4.length > 1 || linkFam.v6.length > 1) findings.push(error('network.fortios.link-subnets', 'Give one IPv4 and at most one IPv6 link subnet.', { source: 'ArchToolKit' }));
      // Each end takes a host address from the subnet: the first two usable
      // (both addresses of a /31 or /127, which have no network address to skip).
      const ends = (c         )                   => {
        const pointToPoint = c.prefix === (c.family === 4 ? 31 : 127);
        return pointToPoint ? [nthHost(c, 0), nthHost(c, 1)] : [nthHost(c, 1), nthHost(c, 2)];
      };
      for (const c of [linkCidr, linkCidr6]) {
        if (c && c.prefix > (c.family === 4 ? 30 : 126) && c.prefix !== (c.family === 4 ? 31 : 127)) {
          findings.push(error('network.fortios.link-subnet-small', `${c.network}/${c.prefix} has no room for two link addresses.`, { source: 'ArchToolKit' }));
        }
      }
      if (ifaces.length > 0) {
        findings.push(
          warning('network.fortios.vdom-clears-interface', 'Moving an interface to another VDOM removes its addressing, its policies and everything that referenced it. This is not a reversible edit — capture the full interface and policy configuration first.', {
            remediation: 'Run `show system interface` and `show firewall policy` and keep the output with the change record.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (link && !linkCidr && !linkCidr6) findings.push(error('network.fortios.bad-link-subnet', 'The inter-VDOM link subnet is not a valid IPv4 or IPv6 prefix.', { source: 'ArchToolKit' }));
      findings.push(
        warning('network.fortios.vdom-licensing', 'Beyond the included count, additional VDOMs need a licence. The FortiGate will refuse to create one past the limit, which is a better failure than most but still one to know about before the window.', { source: 'ArchToolKit' }),
      );

      return {
        platform: PLATFORM,
        title: `VDOM ${vdom}`,
        impact: ifaces.length > 0 ? 'outage' : 'brief',
        notes: [
          'Enabling VDOM mode for the first time restarts the FortiGate and moves everything into the root VDOM. That is an outage on its own, before any interface moves.',
          'Every command afterwards is VDOM-scoped: `config vdom` then `edit <name>` before anything else, or the change lands in the wrong firewall.',
          ...(link ? [`The inter-VDOM link is a pair of virtual interfaces. Traffic across it still needs a policy in both VDOMs — creating the link permits nothing.`] : []),
        ],
        before: ['get system status | grep -i vdom', 'show system vdom', 'show system interface', 'show firewall policy', 'diagnose sys vd list'],
        config: [
          'config system global',
          `  set vdom-mode ${str(values, 'mode', 'split-task')}`,
          'end',
          '',
          'config vdom',
          `  edit ${vdom}`,
          '  next',
          'end',
          '',
          'config vdom',
          `  edit ${vdom}`,
          '    config system settings',
          `      set inspection-mode ${str(values, 'inspection', 'flow')}`,
          `      set comments ""`,
          '    end',
          '  next',
          'end',
          '',
          ...ifaces.flatMap((iface) => ['config system interface', `  edit "${iface}"`, `    set vdom "${vdom}"`, '  next', 'end']),
          '',
          ...(link && (linkCidr || linkCidr6)
            ? [
                'config system vdom-link',
                `  edit "LINK1"`,
                '  next',
                'end',
                'config system interface',
                ...(['LINK10', 'LINK11']         ).flatMap((end, i) => [
                  `  edit "${end}"`,
                  `    set vdom "${i === 0 ? vdom : link}"`,
                  ...(linkCidr ? [`    set ip ${ends(linkCidr)[i]} ${netmask(linkCidr.prefix)}`, '    set allowaccess ping'] : []),
                  ...(linkCidr6
                    ? ['    config ipv6', `      set ip6-address ${fgtInterfaceAddress({ ...linkCidr6, address: ends(linkCidr6)[i] })}`, '      set ip6-allowaccess ping', '    end']
                    : []),
                  '  next',
                ]),
                'end',
              ]
            : []),
          '',
          ...(bool(values, 'resource_limits', false)
            ? ['config global', '  config system vdom-property', `    edit "${vdom}"`, `      set session ${num(values, 'session_limit', 100000)} ${num(values, 'session_limit', 100000)}`, '    next', '  end', 'end']
            : []),
        ],
        verify: ['diagnose sys vd list', 'show system vdom', `config vdom`, `  edit ${vdom}`, '    get system status', '  next', 'end', 'show system interface', `${'!'} Confirm traffic through the moved interfaces still passes, with the new VDOM’s policies`],
        backout: [
          ...ifaces.flatMap((iface) => ['config system interface', `  edit "${iface}"`, '    set vdom "root"', '  next', 'end']),
          'config vdom',
          `  delete ${vdom}`,
          'end',
          `${'!'} Then restore the interface addressing and policies from the capture above.`,
        ],
        findings,
      };
    },
  }),
];

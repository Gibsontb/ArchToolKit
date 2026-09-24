/**
 * Palo Alto PAN-OS: the rest of the gaps.
 *
 * The first two files build objects, rules, NAT, routing, profiles, logging,
 * tunnels and the management baseline. What was still missing is everything
 * that decides *who* and *what*, rather than *where*: User-ID and the group
 * mapping a user-based rule depends on, the authentication profile behind an
 * administrator login, the administrator roles themselves, URL filtering with
 * a custom category and an external dynamic list, application override, QoS,
 * and GlobalProtect.
 *
 * Every change is `set` commands with a commit at the end, because that is how
 * a PAN-OS change is actually made and how it can be reviewed before it takes
 * effect. Nothing here writes a credential.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { listOf, parseCidrDual,                   } from '../device.js';
import { anyRoute, familyOf, isIp, isIpv4Address } from '../../core/ip.js';
import { badAddresses, badAddressFinding, ipv6Unverified, looksLikeAddress, testAddresses } from './panos-ip.js';

const PLATFORM = 'panos'         ;
const SECRET = '<REQUIRED>';

/** Panorama puts everything under a device group; a firewall does not. */
const prefixFor = (dg        )         => (dg ? `set device-group ${dg}` : 'set');

export const PANOS_EXTRA_2                             = [
  deviceBlueprint({
    id: 'panos_url_filtering',
    platform: PLATFORM,
    label: 'URL filtering with a custom category',
    group: 'Profiles',
    description: 'A URL filtering profile, a custom category for the sites this organisation decides about itself, and an external dynamic list for the ones somebody else maintains.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'URL-CORPORATE' },
      { id: 'blocked_categories', label: 'Blocked categories', control: 'text', default: 'malware, phishing, command-and-control, ransomware, dynamic-dns, newly-registered-domain' },
      { id: 'alerted_categories', label: 'Alerted categories', control: 'text', default: 'unknown, parked, high-risk' },
      { id: 'custom_category', label: 'Custom category name', control: 'text', default: 'UC-BLOCKED-SITES' },
      { id: 'custom_sites', label: 'Sites in the custom category', control: 'textarea', default: 'example-bad-site.com/\n*.example-bad-site.com/', hint: 'One per line, PAN-OS URL syntax' },
      { id: 'edl_name', label: 'External dynamic list name', control: 'text', default: '', hint: 'Empty for none' },
      { id: 'edl_url', label: 'List URL', control: 'text', default: 'https://lists.example.com/urls.txt', showWhen: { input: 'edl_name', notEquals: [''] } },
      { id: 'credential_detection', label: 'Credential submission detection', control: 'select', default: 'block', options: [
        { value: 'block', label: 'Block — stop corporate credentials reaching other sites' },
        { value: 'alert', label: 'Alert only' },
        { value: 'disabled', label: 'Off' },
      ] },
      { id: 'safe_search', label: 'Enforce safe search', control: 'toggle', default: false },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const profile = str(values, 'profile_name', 'URL-CORPORATE');
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);
      const blocked = listOf(str(values, 'blocked_categories', ''));
      const alerted = listOf(str(values, 'alerted_categories', ''));
      const custom = str(values, 'custom_category', '');
      const sites = str(values, 'custom_sites', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const edl = str(values, 'edl_name', '');
      const findings            = [];
      if (blocked.length === 0) findings.push(error('network.panos.no-blocked', 'No category is blocked, so this profile logs and permits everything.', { source: 'ArchToolKit' }));
      if (str(values, 'credential_detection', 'block') === 'block') {
        findings.push(
          warning('network.panos.credential-detection', 'Credential submission detection needs User-ID and a credential source — group mapping, the agent, or domain credential filter. Without one it is configured and inert.', {
            remediation: 'Confirm User-ID is working before relying on this.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (edl && !str(values, 'edl_url', '').startsWith('https://')) {
        findings.push(warning('network.panos.edl-http', 'An external dynamic list fetched over plain HTTP can be rewritten in transit by anyone on the path, and it decides what the firewall blocks.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `URL filtering profile ${profile}`,
        impact: 'none',
        notes: [
          'The profile does nothing until a security rule references it. Creating it is safe; attaching it to a rule is the change that affects traffic.',
          'A blocked category with no exception process generates help desk calls on day one. Decide who can ask for an exception and where the custom allow category lives before this goes live.',
          ...(edl ? ['The firewall re-fetches the list on its own schedule. A list that becomes unreachable keeps its last contents, silently, so the fetch needs monitoring.'] : []),
        ],
        before: [
          `show running security-policy | match ${profile}`,
          `show profiles url-filtering`,
          ...(edl ? [`request system external-list show type url name ${edl}`] : []),
          'show system info | match sw-version',
        ],
        config: [
          ...(custom && sites.length > 0
            ? [
                ...sites.map((site) => `${prefix} profiles custom-url-category ${custom} list ${site}`),
                `${prefix} profiles custom-url-category ${custom} type "URL List"`,
              ]
            : []),
          ...(edl
            ? [
                `${prefix} external-list ${edl} type url url ${str(values, 'edl_url', '')}`,
                `${prefix} external-list ${edl} type url recurring hourly`,
                `${prefix} external-list ${edl} type url description "Maintained outside this firewall"`,
              ]
            : []),
          ...blocked.map((category) => `${prefix} profiles url-filtering ${profile} block ${category}`),
          ...alerted.map((category) => `${prefix} profiles url-filtering ${profile} alert ${category}`),
          ...(custom ? [`${prefix} profiles url-filtering ${profile} block ${custom}`] : []),
          ...(edl ? [`${prefix} profiles url-filtering ${profile} block ${edl}`] : []),
          `${prefix} profiles url-filtering ${profile} log-container-page-only yes`,
          `${prefix} profiles url-filtering ${profile} log-http-hdr-xff yes`,
          `${prefix} profiles url-filtering ${profile} log-http-hdr-user-agent yes`,
          ...(str(values, 'credential_detection', 'block') !== 'disabled'
            ? [
                `${prefix} profiles url-filtering ${profile} credential-enforcement mode group-mapping`,
                ...blocked.map((category) => `${prefix} profiles url-filtering ${profile} credential-enforcement ${str(values, 'credential_detection', 'block')} ${category}`),
              ]
            : []),
          ...(bool(values, 'safe_search', false) ? [`${prefix} profiles url-filtering ${profile} safe-search-enforcement yes`] : []),
          'commit description "URL filtering profile"',
        ],
        verify: [
          `show profiles url-filtering ${profile}`,
          ...(edl ? [`request system external-list show type url name ${edl}`] : []),
          `${'!'} Attach the profile to a rule, then browse to a blocked site from an inside host`,
          'show log url direction equal backward',
          'show running security-policy',
        ],
        backout: [
          `delete profiles url-filtering ${profile}`,
          ...(custom ? [`delete profiles custom-url-category ${custom}`] : []),
          ...(edl ? [`delete external-list ${edl}`] : []),
          'commit description "Back out URL filtering profile"',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_userid',
    platform: PLATFORM,
    label: 'User-ID and group mapping',
    group: 'Identity',
    description: 'Teach the firewall who is behind an address, so rules can name a group rather than a subnet — and decide which zones it is allowed to do that in.',
    inputs: [
      { id: 'source', label: 'Where identity comes from', control: 'select', default: 'agentless', options: [
        { value: 'agentless', label: 'Agentless — the firewall reads the domain controllers itself' },
        { value: 'agent', label: 'A User-ID agent on a Windows server' },
        { value: 'syslog', label: 'Syslog from another system' },
      ] },
      { id: 'servers', label: 'Domain controllers or agents', control: 'textarea', default: 'DC01 10.0.5.10\nDC02 10.0.5.11', hint: 'One per line: NAME address' },
      { id: 'ldap_profile', label: 'LDAP server profile name', control: 'text', default: 'LDAP-AD' },
      { id: 'ldap_servers', label: 'LDAP servers', control: 'text', default: '10.0.5.10, 10.0.5.11' },
      { id: 'base_dn', label: 'Base DN', control: 'text', default: 'DC=example,DC=com' },
      { id: 'bind_dn', label: 'Bind DN', control: 'text', default: 'CN=svc-panos,OU=Service,DC=example,DC=com' },
      { id: 'group_include', label: 'Groups to map', control: 'textarea', default: 'cn=vpn-users,ou=groups,dc=example,dc=com\ncn=admins,ou=groups,dc=example,dc=com', hint: 'Only the groups rules will actually use' },
      { id: 'enable_zones', label: 'Zones where User-ID is enabled', control: 'text', default: 'INSIDE', hint: 'Never an untrusted zone' },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const source = str(values, 'source', 'agentless');
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);
      const typedServers = str(values, 'servers', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/));
      const ldapProfile = str(values, 'ldap_profile', 'LDAP-AD');
      const ldapServers = listOf(str(values, 'ldap_servers', ''));
      // LDAP server profiles take IPv6 addresses. Server monitoring and the
      // User-ID agent are written for IPv4 addresses and hostnames only, so an
      // IPv6 entry there is left out and said so (ipv6Unverified).
      const v6Servers = typedServers.filter(([, address]) => familyOf(String(address ?? '')) === 6 && isIp(String(address ?? '')));
      const servers = typedServers.filter((entry) => !v6Servers.includes(entry));
      const badServers = [...typedServers.map(([, address]) => String(address ?? '')), ...ldapServers].filter((address) => !address || (looksLikeAddress(address) && !isIp(address)));
      const groups = str(values, 'group_include', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const zones = listOf(str(values, 'enable_zones', ''));
      const findings            = [];
      if (typedServers.length === 0) findings.push(error('network.panos.no-userid-source', 'No identity source was given, so User-ID would map nobody.', { source: 'ArchToolKit' }));
      if (badServers.length > 0) findings.push(badAddressFinding('Identity and LDAP servers', badServers.map((b) => b || '(missing address)')));
      if (v6Servers.length > 0) {
        findings.push(ipv6Unverified('network.panos.userid-server-ipv6', `${source === 'agent' ? 'The User-ID agent' : 'Server monitoring'} for ${v6Servers.map(([name]) => name).join(', ')} over IPv6`));
      }
      if (groups.length === 0) {
        findings.push(warning('network.panos.userid-all-groups', 'With no include list the firewall maps every group in the directory, which on a large domain is slow, large, and mostly groups no rule will ever name.', { remediation: 'List only the groups rules use.', source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.panos.userid-untrusted-zone', 'User-ID must never be enabled on an untrusted zone. A host there can send crafted mappings and become whoever it likes, and every user-based rule then applies to it.', {
          remediation: 'Enable it only on internal zones, and confirm the list here contains nothing facing the internet.',
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `User-ID from ${source === 'agentless' ? 'the domain controllers' : source === 'agent' ? 'a User-ID agent' : 'syslog'}`,
        impact: 'none',
        notes: [
          'Every other zone must be left with user identification off. (PAN-OS has no comment syntax, so this is a note rather than a line in the file.)',
          'The bind password is `<REQUIRED>` and typed at apply time. It goes in the vault the playbook reads, never in the change record.',
          'The service account needs read access and, for agentless mapping, the rights to read the security event log on every domain controller. A missing right shows up as "no mappings" and nothing more specific.',
          'Group mapping and user mapping are two separate things. Groups come from LDAP; addresses come from the domain controllers or the agent. Either can work while the other does not.',
          ...(v6Servers.length > 0 ? [`VERIFY: ${source === 'agent' ? 'User-ID agent' : 'server monitoring'} over IPv6 on this release, or use each server’s hostname. ${v6Servers.map(([name]) => name).join(', ')} ${v6Servers.length === 1 ? 'was' : 'were'} left out.`] : []),
        ],
        before: ['show user user-id-agent statistics', 'show user group-mapping statistics', 'show user ip-user-mapping all | match ""', 'show user group list'],
        config: [
          `${prefix} shared server-profile ldap ${ldapProfile} ldap-type active-directory`,
          ...ldapServers.map((server, index) => `${prefix} shared server-profile ldap ${ldapProfile} server LDAP${index + 1} address ${server} port 636`),
          `${prefix} shared server-profile ldap ${ldapProfile} ssl yes`,
          `${prefix} shared server-profile ldap ${ldapProfile} base "${str(values, 'base_dn', '')}"`,
          `${prefix} shared server-profile ldap ${ldapProfile} bind-dn "${str(values, 'bind_dn', '')}"`,
          `${prefix} shared server-profile ldap ${ldapProfile} bind-password ${SECRET}`,
          '',
          `${prefix} user-id-collector group-mapping AD-GROUPS server-profile ${ldapProfile}`,
          `${prefix} user-id-collector group-mapping AD-GROUPS update-interval 3600`,
          ...groups.map((group) => `${prefix} user-id-collector group-mapping AD-GROUPS group-include-list "${group}"`),
          '',
          ...(source === 'agentless'
            ? servers.flatMap(([name, address]) => [
                `${prefix} user-id-collector server-monitor ${name} address ${address}`,
                `${prefix} user-id-collector server-monitor ${name} enabled yes`,
              ])
            : source === 'agent'
              ? servers.flatMap(([name, address]) => [`${prefix} user-id-agent ${name} host ${address}`, `${prefix} user-id-agent ${name} port 5007`])
              : servers.flatMap(([name, address]) => [`${prefix} user-id-collector server-monitor ${name} address ${address}`, `${prefix} user-id-collector server-monitor ${name} proto syslog`])),
          '',
          ...zones.map((zone) => `set zone ${zone} enable-user-identification yes`),
          'commit description "User-ID and group mapping"',
        ],
        verify: [
          'show user group-mapping statistics',
          'show user group list',
          'show user ip-user-mapping all',
          'show user server-monitor statistics',
          `${'!'} Confirm a known user appears against the address they are actually on`,
          'show running security-policy | match source-user',
        ],
        backout: [
          'delete user-id-collector group-mapping AD-GROUPS',
          ...servers.map(([name]) => `delete user-id-collector server-monitor ${name}`),
          ...zones.map((zone) => `set zone ${zone} enable-user-identification no`),
          `delete shared server-profile ldap ${ldapProfile}`,
          'commit description "Back out User-ID"',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_admin_roles',
    platform: PLATFORM,
    label: 'Administrator roles and authentication',
    group: 'Management',
    description: 'Named roles with only the access each job needs, and administrators authenticated against the directory rather than by local passwords.',
    inputs: [
      { id: 'role_name', label: 'Role name', control: 'text', default: 'ROLE-NETWORK-READONLY' },
      { id: 'role_type', label: 'Role shape', control: 'select', default: 'readonly', options: [
        { value: 'readonly', label: 'Read only — everything visible, nothing changeable' },
        { value: 'operator', label: 'Operator — policy and objects, no device settings' },
        { value: 'security', label: 'Security — policy, objects and logs, no network settings' },
        { value: 'audit', label: 'Audit — logs and reports only' },
      ] },
      { id: 'auth_profile', label: 'Authentication profile name', control: 'text', default: 'AUTH-ADMINS' },
      { id: 'auth_source', label: 'Authenticate against', control: 'select', default: 'ldap', options: [
        { value: 'ldap', label: 'LDAP or Active Directory' },
        { value: 'radius', label: 'RADIUS' },
        { value: 'saml', label: 'SAML' },
        { value: 'local', label: 'Local accounts only' },
      ] },
      { id: 'server_profile', label: 'Server profile name', control: 'text', default: 'LDAP-AD', showWhen: { input: 'auth_source', notEquals: ['local'] } },
      { id: 'allow_list', label: 'Groups allowed to log in', control: 'text', default: 'cn=firewall-admins,ou=groups,dc=example,dc=com', showWhen: { input: 'auth_source', notEquals: ['local'] } },
      { id: 'mfa', label: 'Require multi-factor', control: 'toggle', default: true },
      { id: 'idle_timeout', label: 'Idle timeout (minutes)', control: 'number', default: 15, min: 1, max: 1440 },
      { id: 'lockout_attempts', label: 'Failed attempts before lockout', control: 'number', default: 5, min: 0, max: 10 },
    ],
    change: (values                 )               => {
      const role = str(values, 'role_name', 'ROLE-READONLY');
      const shape = str(values, 'role_type', 'readonly');
      const authProfile = str(values, 'auth_profile', 'AUTH-ADMINS');
      const source = str(values, 'auth_source', 'ldap');
      const findings            = [];
      if (source === 'local') {
        findings.push(warning('network.panos.local-admins', 'Local administrator accounts are not disabled when someone leaves, are not covered by the directory’s password policy, and are invisible to whatever reviews access elsewhere.', { remediation: 'Keep one break-glass local account and authenticate everyone else against the directory.', source: 'ArchToolKit' }));
      }
      if (!bool(values, 'mfa', true)) {
        findings.push(warning('network.panos.no-mfa', 'An administrator login to a firewall without a second factor is one phished password away from a rule change.', { source: 'ArchToolKit' }));
      }
      if (num(values, 'lockout_attempts', 5) === 0) {
        findings.push(warning('network.panos.no-lockout', 'With lockout disabled there is nothing to stop an unlimited password guessing attempt against the management interface.', { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.panos.keep-break-glass', 'Do not remove the last working local administrator in the same change as this. If the directory or the profile is wrong, that account is the only way back in.', { source: 'ArchToolKit' }),
      );

      const grants =
        shape === 'readonly'
          ? ['set shared admin-role ' + role + ' role device webui monitor enable', 'set shared admin-role ' + role + ' role device webui policies enable', 'set shared admin-role ' + role + ' role device webui objects enable', 'set shared admin-role ' + role + ' role device webui network enable', 'set shared admin-role ' + role + ' role device webui device enable', `${'!'} Then set every one of these to read-only in the web interface, which the CLI expresses per node.`]
          : shape === 'operator'
            ? [`set shared admin-role ${role} role device webui policies enable`, `set shared admin-role ${role} role device webui objects enable`, `set shared admin-role ${role} role device webui monitor enable`, `set shared admin-role ${role} role device webui network disable`, `set shared admin-role ${role} role device webui device disable`]
            : shape === 'security'
              ? [`set shared admin-role ${role} role device webui policies enable`, `set shared admin-role ${role} role device webui objects enable`, `set shared admin-role ${role} role device webui monitor enable`, `set shared admin-role ${role} role device webui network disable`]
              : [`set shared admin-role ${role} role device webui monitor enable`, `set shared admin-role ${role} role device webui policies disable`, `set shared admin-role ${role} role device webui objects disable`, `set shared admin-role ${role} role device webui network disable`, `set shared admin-role ${role} role device webui device disable`];

      return {
        platform: PLATFORM,
        title: `Administrator role ${role} and profile ${authProfile}`,
        impact: 'none',
        notes: [
          'Test the new profile with a second browser session before closing the one you are using. A wrong allow-list entry locks everyone out at the same moment.',
          'Roles are evaluated at login. An administrator already signed in keeps what they had until they sign out.',
          ...(source === 'saml' ? ['SAML needs the identity provider metadata imported separately. This change references the profile; it does not create the trust.'] : []),
        ],
        before: ['show admins', 'show running authentication-profile', 'show shared admin-role', 'show system setting logging'],
        config: [
          ...grants,
          `set shared admin-role ${role} role device xmlapi report enable`,
          `set shared admin-role ${role} role device xmlapi log enable`,
          `set shared admin-role ${role} role device xmlapi config ${shape === 'readonly' || shape === 'audit' ? 'disable' : 'enable'}`,
          '',
          ...(source !== 'local'
            ? [
                `set shared authentication-profile ${authProfile} method ${source} server-profile ${str(values, 'server_profile', 'LDAP-AD')}`,
                `set shared authentication-profile ${authProfile} allow-list "${str(values, 'allow_list', '')}"`,
                ...(bool(values, 'mfa', true) ? [`set shared authentication-profile ${authProfile} multi-factor-auth mfa-enable yes`] : []),
                `set shared authentication-profile ${authProfile} lockout failed-attempts ${num(values, 'lockout_attempts', 5)}`,
                `set shared authentication-profile ${authProfile} lockout lockout-time 30`,
              ]
            : [`set shared authentication-profile ${authProfile} method none`]),
          '',
          `set deviceconfig setting management idle-timeout ${num(values, 'idle_timeout', 15)}`,
          'set deviceconfig setting management admin-lockout failed-attempts ' + num(values, 'lockout_attempts', 5),
          `${'!'} Then attach the profile and role to each administrator:`,
          `${'!'} set mgt-config users <name> authentication-profile ${authProfile}`,
          `${'!'} set mgt-config users <name> permissions role-based custom profile ${role}`,
          'commit description "Administrator roles and authentication"',
        ],
        verify: [
          'show admins',
          `show shared admin-role ${role}`,
          `show shared authentication-profile ${authProfile}`,
          `${'!'} From a second browser: log in as a member of the allowed group and confirm what they can and cannot see`,
          'show log system direction equal backward | match auth',
        ],
        backout: [`delete shared authentication-profile ${authProfile}`, `delete shared admin-role ${role}`, 'commit description "Back out administrator roles"'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_globalprotect',
    platform: PLATFORM,
    label: 'GlobalProtect portal and gateway',
    group: 'VPN',
    description: 'Remote access: the portal clients connect to first, the gateway that carries the traffic, and the address pool and split tunnel they get.',
    inputs: [
      { id: 'portal_name', label: 'Portal name', control: 'text', default: 'GP-PORTAL' },
      { id: 'gateway_name', label: 'Gateway name', control: 'text', default: 'GP-GATEWAY' },
      { id: 'external_interface', label: 'External interface', control: 'text', default: 'ethernet1/1' },
      { id: 'external_address', label: 'External address', control: 'text', default: '203.0.113.20', hint: 'IPv4, IPv6, or one of each for a dual-stack gateway' },
      { id: 'tunnel_interface', label: 'Tunnel interface', control: 'text', default: 'tunnel.10' },
      { id: 'pool', label: 'Client address pool', control: 'text', default: '10.200.0.0/22', hint: 'IPv4, IPv6 or both, comma separated: 10.200.0.0/22, 2001:db8:200::/64' },
      { id: 'auth_profile', label: 'Authentication profile', control: 'text', default: 'AUTH-VPN' },
      { id: 'certificate', label: 'Server certificate name', control: 'text', default: 'CERT-VPN' },
      { id: 'split_tunnel', label: 'Split tunnel', control: 'select', default: 'corporate', options: [
        { value: 'none', label: 'Full tunnel — everything goes through the firewall' },
        { value: 'corporate', label: 'Split — only the corporate networks' },
      ] },
      { id: 'include_routes', label: 'Networks to send through the tunnel', control: 'text', default: '10.0.0.0/8, 172.16.0.0/12', hint: 'IPv4 and IPv6 prefixes', showWhen: { input: 'split_tunnel', equals: ['corporate'] } },
      { id: 'dns', label: 'DNS servers for clients', control: 'text', default: '10.0.1.10, 10.0.2.10', hint: 'IPv4 or IPv6' },
      { id: 'hip', label: 'Require a host information check', control: 'toggle', default: false },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const portal = str(values, 'portal_name', 'GP-PORTAL');
      const gateway = str(values, 'gateway_name', 'GP-GATEWAY');
      // The pool, the gateway address, the access routes and the DNS servers
      // all take either family; a dual-stack pool gives each client one of each.
      const poolText = listOf(str(values, 'pool', ''));
      const pools = poolText.map((text) => parseCidrDual(text));
      const pool4 = pools.filter((c) => c !== null && c.family === 4);
      const pool6 = pools.filter((c) => c !== null && c.family === 6);
      const split = str(values, 'split_tunnel', 'corporate') === 'corporate';
      const includes = listOf(str(values, 'include_routes', ''));
      const dns = listOf(str(values, 'dns', ''));
      const external = listOf(str(values, 'external_address', ''));
      const external4 = external.find((address) => familyOf(address) === 4 && isIp(address));
      const external6 = external.find((address) => familyOf(address) === 6 && isIp(address));
      const addressFamily = external4 && external6 ? 'ipv4_ipv6' : external6 ? 'ipv6' : 'ipv4';
      const findings            = [];
      if (poolText.length === 0 || pools.some((c) => c === null)) {
        findings.push(error('network.panos.bad-pool', 'The client address pool is not a valid prefix.', { remediation: 'Write it as 10.200.0.0/22, 2001:db8:200::/64, or both separated by a comma.', source: 'ArchToolKit' }));
      }
      const pool = pool4[0];
      if (pool && pool.prefix > 24) {
        findings.push(warning('network.panos.small-pool', `A /${pool.prefix} gives about ${2 ** (32 - pool.prefix) - 2} concurrent clients. Remote access demand is rarely what it was planned for.`, { source: 'ArchToolKit' }));
      }
      if (split && includes.length === 0) {
        findings.push(error('network.panos.split-no-routes', 'Split tunnelling was chosen with no networks to include, so clients would connect and route nothing through the tunnel.', { source: 'ArchToolKit' }));
      }
      const badRoutes = includes.filter((route) => familyOf(route) === null);
      if (split && badRoutes.length > 0) findings.push(badAddressFinding('Networks to send through the tunnel', badRoutes));
      const badDns = dns.filter((server) => !isIp(server));
      if (badDns.length > 0) findings.push(badAddressFinding('DNS servers for clients', badDns));
      if (external.length === 0 || external.some((address) => !isIp(address))) {
        findings.push(error('network.panos.bad-gp-address', 'The external address must be an IPv4 address, an IPv6 address, or one of each.', { source: 'ArchToolKit' }));
      }
      // An IPv6 route or DNS server is useless to a client that gets no IPv6 address.
      if (pool6.length === 0 && ((split && includes.some((route) => familyOf(route) === 6)) || dns.some((server) => familyOf(server) === 6))) {
        findings.push(
          warning('network.panos.gp-ipv6-no-pool', 'IPv6 access routes or DNS servers were given, but the pool has no IPv6 prefix, so clients get no IPv6 address to use them with.', {
            remediation: 'Add an IPv6 prefix to the client address pool, such as 2001:db8:200::/64.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (pool4.length === 0 && ((split && includes.some((route) => familyOf(route) === 4)) || dns.some((server) => familyOf(server) === 4))) {
        findings.push(warning('network.panos.gp-ipv4-no-pool', 'IPv4 access routes or DNS servers were given, but the pool has no IPv4 prefix, so clients get no IPv4 address to use them with.', { source: 'ArchToolKit' }));
      }
      const routes = split ? includes : [...(pool4.length > 0 || pool6.length === 0 ? [anyRoute(4)] : []), ...(pool6.length > 0 ? [anyRoute(6)] : [])];
      if (split) {
        findings.push(
          warning('network.panos.split-tunnel-visibility', 'With a split tunnel the firewall sees only the corporate traffic. Everything else leaves the laptop directly, unfiltered and unlogged, which is a deliberate trade and should be a recorded decision.', { source: 'ArchToolKit' }),
        );
      }
      findings.push(
        warning('network.panos.gp-certificate', 'The certificate must be trusted by the clients and must match the name they connect to. A self-signed certificate gives every user a warning to click through, which trains them to click through warnings.', {
          source: 'ArchToolKit',
        }),
      );

      return {
        platform: PLATFORM,
        title: `GlobalProtect portal ${portal} and gateway ${gateway}`,
        impact: 'brief',
        notes: [
          'The authentication profile and the certificate must already exist. This change references them; it does not create them.',
          'The tunnel interface needs to be in a zone, and a security rule has to allow that zone to reach whatever the clients need. Without the rule they connect successfully and reach nothing.',
          'Return routing matters: the internal network needs a route back to the client pool, via this firewall.',
          ...(bool(values, 'hip', false) ? ['Host information profile checks fail closed. A client that cannot report — a new operating system version, an agent that did not start — is denied, and the message is not specific.'] : []),
          ...(pool6.length > 0 ? ['Clients get an IPv6 address from the pool as well. The internal network needs a route back to the IPv6 pool too, and the security rules must name IPv6 destinations.'] : []),
          ...(!split && pool6.length === 0 ? ['This is a full tunnel for IPv4 only. With no IPv6 pool, a client’s native IPv6 traffic does not enter the tunnel.'] : []),
          'VERIFY: the portal’s external gateway entry (ip and priority-rule) against the release; the gateway list layout has changed between PAN-OS versions.',
        ],
        before: ['show global-protect-gateway gateway', 'show global-protect-portal portal', 'show running security-policy | match GP', 'show interface tunnel.10', 'show routing route'],
        config: [
          `set network interface tunnel units ${str(values, 'tunnel_interface', 'tunnel.10')} comment "GlobalProtect clients"`,
          '',
          `set global-protect global-protect-gateway ${gateway} local-address interface ${str(values, 'external_interface', 'ethernet1/1')}`,
          `set global-protect global-protect-gateway ${gateway} local-address ip-address-family ${addressFamily}`,
          ...(external4 ? [`set global-protect global-protect-gateway ${gateway} local-address ip ipv4 ${external4}`] : []),
          ...(external6 ? [`set global-protect global-protect-gateway ${gateway} local-address ip ipv6 ${external6}`] : []),
          `set global-protect global-protect-gateway ${gateway} ssl-tls-service-profile ${str(values, 'certificate', 'CERT-VPN')}`,
          `set global-protect global-protect-gateway ${gateway} client-auth AUTH authentication-profile ${str(values, 'auth_profile', 'AUTH-VPN')}`,
          `set global-protect global-protect-gateway ${gateway} client-auth AUTH os Any`,
          `set global-protect global-protect-gateway ${gateway} remote-user-tunnel ${str(values, 'tunnel_interface', 'tunnel.10')}`,
          ...(pool4.length + pool6.length > 0
            ? [`set global-protect global-protect-gateway ${gateway} remote-user-tunnel-configs TUNNEL-CONFIG ip-pool [ ${[...pool4, ...pool6].map((c) => `${c .network}/${c .prefix}`).join(' ')} ]`]
            : []),
          ...(dns.length > 0 ? [`set global-protect global-protect-gateway ${gateway} remote-user-tunnel-configs TUNNEL-CONFIG dns-server [ ${dns.join(' ')} ]`] : []),
          ...(routes.length > 0 ? [`set global-protect global-protect-gateway ${gateway} remote-user-tunnel-configs TUNNEL-CONFIG split-tunneling access-route [ ${routes.join(' ')} ]`] : []),
          ...(bool(values, 'hip', false) ? [`set global-protect global-protect-gateway ${gateway} remote-user-tunnel-configs TUNNEL-CONFIG hip-notification HIP-CHECK`] : []),
          '',
          `set global-protect global-protect-portal ${portal} local-address interface ${str(values, 'external_interface', 'ethernet1/1')}`,
          `set global-protect global-protect-portal ${portal} local-address ip-address-family ${addressFamily}`,
          ...(external4 ? [`set global-protect global-protect-portal ${portal} local-address ip ipv4 ${external4}`] : []),
          ...(external6 ? [`set global-protect global-protect-portal ${portal} local-address ip ipv6 ${external6}`] : []),
          `set global-protect global-protect-portal ${portal} portal-config ssl-tls-service-profile ${str(values, 'certificate', 'CERT-VPN')}`,
          `set global-protect global-protect-portal ${portal} portal-config client-auth AUTH authentication-profile ${str(values, 'auth_profile', 'AUTH-VPN')}`,
          ...(external4 ? [`set global-protect global-protect-portal ${portal} client-config configs DEFAULT gateways external list ${gateway} ip ipv4 ${external4}`] : []),
          ...(external6 ? [`set global-protect global-protect-portal ${portal} client-config configs DEFAULT gateways external list ${gateway} ip ipv6 ${external6}`] : []),
          `set global-protect global-protect-portal ${portal} client-config configs DEFAULT gateways external list ${gateway} priority-rule Any priority 1`,
          '',
          'commit description "GlobalProtect"',
        ],
        verify: [
          'show global-protect-gateway gateway',
          `show global-protect-gateway current-user gateway ${gateway}`,
          'show global-protect-portal portal',
          `show interface ${str(values, 'tunnel_interface', 'tunnel.10')}`,
          `${'!'} From outside: connect a client, then confirm it reaches an internal service and that the traffic appears in the logs`,
          'show log traffic direction equal backward | match global-protect',
        ],
        backout: [
          `delete global-protect global-protect-portal ${portal}`,
          `delete global-protect global-protect-gateway ${gateway}`,
          `delete network interface tunnel units ${str(values, 'tunnel_interface', 'tunnel.10')}`,
          'commit description "Back out GlobalProtect"',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_app_override',
    platform: PLATFORM,
    label: 'Application override',
    group: 'Policies',
    description: 'Stop App-ID inspecting one specific flow — the escape hatch for a custom application that App-ID identifies wrongly or takes too long to identify at all.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'OVERRIDE-TRADING-APP' },
      { id: 'custom_app', label: 'Custom application name', control: 'text', default: 'custom-trading-app' },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'INSIDE' },
      { id: 'destination_zone', label: 'Destination zone', control: 'text', default: 'DMZ' },
      { id: 'source', label: 'Source addresses', control: 'text', default: '10.10.0.0/24' },
      { id: 'destination', label: 'Destination addresses', control: 'text', default: '10.20.0.50' },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'tcp', options: [
        { value: 'tcp', label: 'TCP' },
        { value: 'udp', label: 'UDP' },
      ] },
      { id: 'ports', label: 'Destination ports', control: 'text', default: '9000-9010' },
      { id: 'timeout', label: 'Session timeout (seconds)', control: 'number', default: 3600, min: 1, max: 604800 },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const rule = str(values, 'rule_name', 'OVERRIDE');
      const app = str(values, 'custom_app', 'custom-app').toLowerCase().replace(/\s+/g, '-');
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);
      const source = str(values, 'source', '');
      const destination = str(values, 'destination', '');
      // Either family on either side; a list is written as one bracketed member list.
      const sources = listOf(source);
      const destinations = listOf(destination);
      const members = (items                   , typed        ) => (items.length > 1 ? `[ ${items.join(' ')} ]` : typed);
      const probe = testAddresses(sources, destinations);
      const findings            = [];
      const bad = badAddresses([...sources, ...destinations]);
      if (bad.length > 0) findings.push(badAddressFinding('Override addresses', bad));
      findings.push(
        warning('network.panos.app-override-bypasses-inspection', 'An application override turns off App-ID for the matched flow, and with it every content inspection that depends on identifying the application — threat prevention, file blocking, data filtering. The traffic is permitted and unexamined.', {
          remediation: 'Scope it as narrowly as the flow allows: exact sources, exact destinations, exact ports. Review it on a schedule, because it will outlive the reason for it.',
          source: 'ArchToolKit',
        }),
      );
      if (source === 'any' || destination === 'any' || !source || !destination) {
        findings.push(error('network.panos.override-too-broad', 'An override with "any" on either side disables inspection for far more than the one application it was written for.', { remediation: 'Name the exact addresses.', source: 'ArchToolKit' }));
      }
      if (str(values, 'ports', '').includes('0-65535')) {
        findings.push(error('network.panos.override-all-ports', 'An override across every port disables inspection between these hosts entirely.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Application override ${rule} for ${app}`,
        impact: 'brief',
        notes: [
          'Existing sessions keep their current application until they end. The override applies to new sessions.',
          'The custom application is created here so the traffic has a name in the logs. Without it the override produces traffic logged as the port number, which nobody can search for later.',
          'Write down why this exists and when it should be reviewed. An override with no stated reason is never removed.',
        ],
        before: ['show running security-policy', 'show running application-override-policy', `show log traffic direction equal backward | match ${destination}`],
        config: [
          `${prefix} application ${app} category business-systems`,
          `${prefix} application ${app} subcategory general-business`,
          `${prefix} application ${app} technology client-server`,
          `${prefix} application ${app} risk 2`,
          `${prefix} application ${app} description "Override — App-ID disabled for this flow. Review annually."`,
          '',
          `${prefix} rulebase application-override rules ${rule} from ${str(values, 'source_zone', 'INSIDE')}`,
          `${prefix} rulebase application-override rules ${rule} to ${str(values, 'destination_zone', 'DMZ')}`,
          `${prefix} rulebase application-override rules ${rule} source ${members(sources, source)}`,
          `${prefix} rulebase application-override rules ${rule} destination ${members(destinations, destination)}`,
          `${prefix} rulebase application-override rules ${rule} protocol ${str(values, 'protocol', 'tcp')}`,
          `${prefix} rulebase application-override rules ${rule} port ${str(values, 'ports', '')}`,
          `${prefix} rulebase application-override rules ${rule} application ${app}`,
          `${prefix} rulebase application-override rules ${rule} description " — App-ID bypassed for this flow"`,
          '',
          `${'!'} A security rule must still permit ${app} between these zones, or the traffic is renamed and then dropped.`,
          'commit description "Application override"',
        ],
        verify: [
          'show running application-override-policy',
          `test security-policy-match from ${str(values, 'source_zone', 'INSIDE')} to ${str(values, 'destination_zone', 'DMZ')} source ${probe.source} destination ${probe.destination} protocol 6 destination-port ${str(values, 'ports', '9000').split('-')[0]}`,
          `show session all filter application ${app}`,
          'show log traffic direction equal backward | match ' + app,
        ],
        backout: [`delete ${dg ? `device-group ${dg} ` : ''}rulebase application-override rules ${rule}`, `delete ${dg ? `device-group ${dg} ` : ''}application ${app}`, 'commit description "Back out application override"'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_virtual_router',
    platform: PLATFORM,
    label: 'Virtual router with OSPF or BGP',
    group: 'Routing',
    description: 'A routing instance on the firewall that peers rather than being pointed at statically — and the redistribution rules that decide what it tells the rest of the network.',
    inputs: [
      { id: 'router_name', label: 'Virtual router name', control: 'text', default: 'VR-DEFAULT' },
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'ospf', options: [
        { value: 'ospf', label: 'OSPF (OSPFv2, IPv4)' },
        { value: 'ospfv3', label: 'OSPFv3 (IPv6)' },
        { value: 'bgp', label: 'BGP (IPv4 or IPv6 peer)' },
      ] },
      { id: 'router_id', label: 'Router id', control: 'text', default: '10.255.1.1', hint: 'Dotted IPv4 form, for OSPFv3 and IPv6 BGP too' },
      { id: 'interfaces', label: 'Interfaces in the router', control: 'text', default: 'ethernet1/1, ethernet1/2' },
      { id: 'area', label: 'OSPF area', control: 'text', default: '0.0.0.0', showWhen: { input: 'protocol', equals: ['ospf', 'ospfv3'] } },
      { id: 'ospf_interfaces', label: 'OSPF-enabled interfaces', control: 'text', default: 'ethernet1/2', showWhen: { input: 'protocol', equals: ['ospf', 'ospfv3'] } },
      { id: 'local_as', label: 'Local AS', control: 'number', default: 65010, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer_address', label: 'Peer address', control: 'text', default: '10.0.12.2', hint: 'IPv4, or IPv6 for an IPv6 unicast (MP-BGP) session', showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'local_interface', label: 'Local interface for the session', control: 'text', default: '', hint: 'Empty to leave the local address to be set by hand', showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'local_address', label: 'Local address on that interface', control: 'text', default: '', hint: 'With its prefix, same family as the peer: 10.0.12.1/30 or 2001:db8:12::1/64', showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'peer_as', label: 'Peer AS', control: 'number', default: 65020, min: 1, showWhen: { input: 'protocol', equals: ['bgp'] } },
      { id: 'redistribute', label: 'Redistribute', control: 'select', default: 'connected', options: [
        { value: 'connected', label: 'Connected networks only' },
        { value: 'static', label: 'Connected and static' },
        { value: 'none', label: 'Nothing — receive only' },
      ] },
      { id: 'authentication', label: 'Protocol authentication', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const vr = str(values, 'router_name', 'VR-DEFAULT');
      const protocol = str(values, 'protocol', 'ospf');
      const ifaces = listOf(str(values, 'interfaces', ''));
      const redistribute = str(values, 'redistribute', 'connected');
      const routerId = str(values, 'router_id', '');
      const area = str(values, 'area', '0.0.0.0');
      const peer = str(values, 'peer_address', '');
      const localInterface = str(values, 'local_interface', '');
      const localAddress = str(values, 'local_address', '');
      const local = localAddress ? parseCidrDual(localAddress) : null;
      const ospf = protocol === 'ospf' || protocol === 'ospfv3';
      // The address family the session carries: OSPFv3 and an IPv6 BGP peer
      // are IPv6; OSPFv2 and an IPv4 BGP peer are IPv4.
      const v6 = protocol === 'ospfv3' || (protocol === 'bgp' && familyOf(peer) === 6);
      const auth = bool(values, 'authentication', true);
      const findings            = [];
      if (ifaces.length === 0) findings.push(error('network.panos.no-interfaces', 'A virtual router with no interfaces routes nothing.', { source: 'ArchToolKit' }));
      // Router ids and areas are 32-bit identifiers written as dotted quads, in
      // OSPFv3 and IPv6 BGP as much as in IPv4.
      if (!isIpv4Address(routerId)) findings.push(error('network.panos.bad-router-id', `The router id "${routerId}" must be a 32-bit id in dotted IPv4 form, such as 10.255.1.1 — also for OSPFv3 and IPv6 BGP.`, { source: 'ArchToolKit' }));
      if (ospf && !isIpv4Address(area)) findings.push(error('network.panos.bad-area', `The OSPF area "${area}" must be in dotted form, such as 0.0.0.0.`, { source: 'ArchToolKit' }));
      if (protocol === 'bgp' && !isIp(peer)) findings.push(error('network.panos.bad-bgp-peer', `The peer address "${peer}" is not an IPv4 or IPv6 address.`, { source: 'ArchToolKit' }));
      if (protocol === 'bgp' && localAddress && !local) findings.push(error('network.panos.bad-bgp-local', `The local address "${localAddress}" is not a valid address and prefix.`, { source: 'ArchToolKit' }));
      if (protocol === 'bgp' && local && familyOf(peer) !== null && local.family !== familyOf(peer)) {
        findings.push(error('network.panos.bgp-family-mismatch', `The peer is IPv${familyOf(peer)} and the local address is IPv${local.family}. A BGP session runs between two addresses of the same family.`, { source: 'ArchToolKit' }));
      }
      if (protocol === 'bgp' && (!localInterface || !local)) {
        findings.push(warning('network.panos.bgp-no-local-address', 'The peer has no local interface and address, and the firewall needs both to open the session. Set them here or by hand before the commit.', { source: 'ArchToolKit' }));
      }
      if (protocol === 'ospfv3' && auth) {
        findings.push(ipv6Unverified('network.panos.ospfv3-auth', 'OSPFv3 authentication (an IPsec AH or ESP auth profile, not MD5)'));
      }
      if (!bool(values, 'authentication', true)) {
        findings.push(warning('network.panos.routing-unauthenticated', 'An unauthenticated routing protocol on a firewall lets anything on the segment inject a route and redirect traffic around the policy.', { remediation: 'Authenticate the adjacency. The key is `<REQUIRED>` here and belongs in the vault.', source: 'ArchToolKit' }));
      }
      if (redistribute !== 'none') {
        findings.push(
          warning('network.panos.redistribution-scope', 'Redistributing connected networks advertises every interface on this router, including any management or DMZ segment that was not meant to be reachable from the peer.', {
            remediation: 'Filter the redistribution profile to the prefixes that are meant to leave.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Virtual router ${vr} running ${protocol.toUpperCase()}`,
        impact: 'brief',
        notes: [
          'A firewall that peers will also withdraw routes when it fails over or reboots, which is usually the point — but it means a maintenance window now moves traffic for the whole network, not just for the firewall.',
          'Routes learned here still have to pass policy. A route arriving does not mean the traffic will be permitted.',
          ...(protocol === 'bgp' ? ['The BGP password is `<REQUIRED>` and must match the peer. It belongs in the vault, not the change record.'] : []),
          ...(protocol === 'ospfv3' ? ['OSPFv3 runs over the interfaces’ IPv6 link-local addresses, so each OSPFv3 interface needs IPv6 enabled. The router id stays a dotted 32-bit id.'] : []),
          ...(protocol === 'ospfv3' && auth ? ['VERIFY: OSPFv3 authentication uses an IPsec AH or ESP auth profile on this release; it is not generated here, so the adjacency comes up unauthenticated until one is added.'] : []),
          ...(protocol === 'bgp' && v6 ? ['The IPv6 peer is configured for multiprotocol BGP with the IPv6 unicast address family. IPv6 routes are exchanged only with this peer; IPv4 routes need an IPv4 session.'] : []),
        ],
        before: [`show routing protocol ${protocol} summary`, `show routing route${v6 ? ' afi ipv6' : ''}`, `show routing resource`, 'show interface all'],
        config: [
          ...ifaces.map((iface) => `set network virtual-router ${vr} interface ${iface}`),
          '',
          ...(protocol === 'ospfv3'
            ? [
                `set network virtual-router ${vr} protocol ospfv3 enable yes`,
                `set network virtual-router ${vr} protocol ospfv3 router-id ${routerId}`,
                ...listOf(str(values, 'ospf_interfaces', '')).flatMap((iface) => [
                  `set network virtual-router ${vr} protocol ospfv3 area ${area} interface ${iface} enable yes`,
                  `set network virtual-router ${vr} protocol ospfv3 area ${area} interface ${iface} link-type broadcast`,
                ]),
              ]
            : protocol === 'ospf'
            ? [
                `set network virtual-router ${vr} protocol ospf enable yes`,
                `set network virtual-router ${vr} protocol ospf router-id ${str(values, 'router_id', '')}`,
                ...listOf(str(values, 'ospf_interfaces', '')).flatMap((iface) => [
                  `set network virtual-router ${vr} protocol ospf area ${str(values, 'area', '0.0.0.0')} interface ${iface} enable yes`,
                  `set network virtual-router ${vr} protocol ospf area ${str(values, 'area', '0.0.0.0')} interface ${iface} link-type broadcast`,
                  ...(bool(values, 'authentication', true) ? [`set network virtual-router ${vr} protocol ospf area ${str(values, 'area', '0.0.0.0')} interface ${iface} authentication OSPF-AUTH`] : []),
                ]),
                ...(bool(values, 'authentication', true)
                  ? [`set network virtual-router ${vr} protocol ospf auth-profile OSPF-AUTH md5 1 key ${SECRET}`, `set network virtual-router ${vr} protocol ospf auth-profile OSPF-AUTH md5 1 preferred yes`]
                  : []),
              ]
            : [
                `set network virtual-router ${vr} protocol bgp enable yes`,
                `set network virtual-router ${vr} protocol bgp router-id ${str(values, 'router_id', '')}`,
                `set network virtual-router ${vr} protocol bgp local-as ${num(values, 'local_as', 65010)}`,
                `set network virtual-router ${vr} protocol bgp peer-group PG-1 type ebgp`,
                `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 peer-address ip ${str(values, 'peer_address', '')}`,
                `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 peer-as ${num(values, 'peer_as', 65020)}`,
                `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 enable yes`,
                ...(localInterface && local && local.family === familyOf(peer)
                  ? [
                      `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 local-address interface ${localInterface}`,
                      `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 local-address ip ${local.address}/${local.prefix}`,
                    ]
                  : []),
                // An IPv6 peer carries IPv6 unicast through multiprotocol BGP.
                ...(v6
                  ? [
                      `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 enable-mp-bgp yes`,
                      `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 address-family-identifier ipv6`,
                      `set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 subsequent-address-family-identifier unicast yes`,
                    ]
                  : []),
                ...(auth ? [`set network virtual-router ${vr} protocol bgp peer-group PG-1 peer PEER-1 connection-options authentication ${SECRET}`] : []),
              ]),
          '',
          // IPv6 routes are redistributed through an IPv6 redistribution profile.
          ...(redistribute !== 'none'
            ? v6
              ? [
                  `set network virtual-router ${vr} redist-profile-ipv6 REDIST-OUT-V6 priority 1`,
                  `set network virtual-router ${vr} redist-profile-ipv6 REDIST-OUT-V6 action redist`,
                  `set network virtual-router ${vr} redist-profile-ipv6 REDIST-OUT-V6 filter type connect`,
                  ...(redistribute === 'static' ? [`set network virtual-router ${vr} redist-profile-ipv6 REDIST-OUT-V6 filter type static`] : []),
                  `${'!'} Add destination prefixes to REDIST-OUT-V6 so only the intended networks are advertised.`,
                  ...(protocol === 'ospfv3'
                    ? [`set network virtual-router ${vr} protocol ospfv3 export-rules REDIST-OUT-V6 new-path-type ext-2`]
                    : [
                        `set network virtual-router ${vr} protocol bgp redist-rules REDIST-OUT-V6 address-family-identifier ipv6`,
                        `set network virtual-router ${vr} protocol bgp redist-rules REDIST-OUT-V6 enable yes`,
                      ]),
                ]
              : [
                  `set network virtual-router ${vr} redist-profile REDIST-OUT priority 1`,
                  `set network virtual-router ${vr} redist-profile REDIST-OUT action redist`,
                  `set network virtual-router ${vr} redist-profile REDIST-OUT filter type connect`,
                  ...(redistribute === 'static' ? [`set network virtual-router ${vr} redist-profile REDIST-OUT filter type static`] : []),
                  `${'!'} Add destination prefixes to REDIST-OUT so only the intended networks are advertised.`,
                  ...(protocol === 'ospf'
                    ? [`set network virtual-router ${vr} protocol ospf export-rules REDIST-OUT new-path-type ext-2`]
                    : [`set network virtual-router ${vr} protocol bgp redist-rules REDIST-OUT enable yes`]),
                ]
            : []),
          '',
          'commit description "Virtual router routing"',
        ],
        verify: [
          `show routing protocol ${protocol} summary`,
          ...(ospf ? [`show routing protocol ${protocol} neighbor`, `show routing protocol ${protocol} interface`] : ['show routing protocol bgp summary', 'show routing protocol bgp peer']),
          `show routing route${v6 ? ' afi ipv6' : ''}`,
          `${'!'} Confirm only the intended prefixes are being advertised, from the peer’s side`,
        ],
        backout: [`set network virtual-router ${vr} protocol ${protocol} enable no`, 'commit description "Back out dynamic routing on the firewall"'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_qos',
    platform: PLATFORM,
    label: 'QoS profile and policy',
    group: 'Policies',
    description: 'Guarantee bandwidth to what matters and cap what does not, on an interface where the circuit is the constraint.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'QOS-WAN' },
      { id: 'interface', label: 'Interface', control: 'text', default: 'ethernet1/1' },
      { id: 'egress_max', label: 'Circuit speed (Mbps)', control: 'number', default: 100, min: 1, max: 100000 },
      { id: 'realtime_apps', label: 'Real-time applications', control: 'text', default: 'sip, rtp, ms-teams, zoom' },
      { id: 'realtime_guaranteed', label: 'Real-time guaranteed (Mbps)', control: 'number', default: 20, min: 0 },
      { id: 'business_apps', label: 'Business applications', control: 'text', default: 'ms-office365, salesforce, ssl' },
      { id: 'business_guaranteed', label: 'Business guaranteed (Mbps)', control: 'number', default: 40, min: 0 },
      { id: 'bulk_apps', label: 'Bulk or low priority', control: 'text', default: 'ftp, bittorrent, ms-update, apple-update' },
      { id: 'bulk_max', label: 'Bulk capped at (Mbps)', control: 'number', default: 10, min: 0 },
      { id: 'device_group', label: 'Panorama device group', control: 'text', default: '' },
    ],
    change: (values                 )               => {
      const profile = str(values, 'profile_name', 'QOS-WAN');
      const iface = str(values, 'interface', 'ethernet1/1');
      const dg = str(values, 'device_group', '');
      const prefix = prefixFor(dg);
      const max = num(values, 'egress_max', 100);
      const realtime = num(values, 'realtime_guaranteed', 20);
      const business = num(values, 'business_guaranteed', 40);
      const findings            = [];
      if (realtime + business > max) {
        findings.push(error('network.panos.qos-oversubscribed', `The guarantees add up to ${realtime + business}Mbps on a ${max}Mbps circuit. They cannot all be met, and the firewall will not warn about it at commit.`, { source: 'ArchToolKit' }));
      }
      findings.push(
        warning('network.panos.qos-egress-only', 'QoS on a firewall shapes traffic leaving this interface. It cannot control what arrives — an inbound-saturated circuit needs the far end or the carrier to shape it.', { source: 'ArchToolKit' }),
      );
      if (max > 1000) {
        findings.push(warning('network.panos.qos-throughput', 'QoS processing has a throughput cost on some platforms. On a fast circuit confirm the model can shape at this rate before assuming it will.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `QoS profile ${profile} on ${iface}`,
        impact: 'brief',
        notes: [
          'Classes are evaluated in order and traffic lands in the first match. An application named in two classes is shaped by the first one.',
          'Guarantees only bind during congestion. On an uncongested circuit nothing changes, which makes this hard to test until the circuit is busy.',
          'The egress maximum must match the circuit, not the interface. A 100Mbps service on a gigabit port shapes at a gigabit unless this number says otherwise, and the carrier drops the difference.',
        ],
        before: [`show qos interface ${iface}`, `show qos interface ${iface} throughput`, 'show running security-policy', 'show interface ' + iface],
        config: [
          `${prefix} network qos profile ${profile} aggregate-bandwidth egress-max ${max}`,
          `${prefix} network qos profile ${profile} class-bandwidth-type mbps class class1 priority real-time`,
          `${prefix} network qos profile ${profile} class-bandwidth-type mbps class class1 class-bandwidth egress-guaranteed ${realtime}`,
          `${prefix} network qos profile ${profile} class-bandwidth-type mbps class class2 priority high`,
          `${prefix} network qos profile ${profile} class-bandwidth-type mbps class class2 class-bandwidth egress-guaranteed ${business}`,
          `${prefix} network qos profile ${profile} class-bandwidth-type mbps class class4 priority low`,
          `${prefix} network qos profile ${profile} class-bandwidth-type mbps class class4 class-bandwidth egress-max ${num(values, 'bulk_max', 10)}`,
          '',
          `set network qos interface ${iface} regulated-interface ${iface}`,
          `set network qos interface ${iface} default-group qos-profile ${profile}`,
          `set network qos interface ${iface} enabled yes`,
          '',
          `${prefix} rulebase qos rules QOS-REALTIME application [ ${listOf(str(values, 'realtime_apps', '')).join(' ')} ]`,
          `${prefix} rulebase qos rules QOS-REALTIME action class 1`,
          `${prefix} rulebase qos rules QOS-BUSINESS application [ ${listOf(str(values, 'business_apps', '')).join(' ')} ]`,
          `${prefix} rulebase qos rules QOS-BUSINESS action class 2`,
          `${prefix} rulebase qos rules QOS-BULK application [ ${listOf(str(values, 'bulk_apps', '')).join(' ')} ]`,
          `${prefix} rulebase qos rules QOS-BULK action class 4`,
          '',
          'commit description "QoS"',
        ],
        verify: [
          `show qos interface ${iface}`,
          `show qos interface ${iface} throughput 1`,
          'show running qos-policy',
          `${'!'} Generate congestion deliberately and confirm the real-time class holds its guarantee`,
          'show session all filter qos-class 1',
        ],
        backout: [`set network qos interface ${iface} enabled no`, `delete network qos profile ${profile}`, 'commit description "Back out QoS"'],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'panos_auth_profile',
    platform: PLATFORM,
    label: 'Authentication profile and sequence',
    group: 'Identity',
    description: 'How users prove who they are — LDAP, RADIUS, SAML or a sequence that tries more than one — for VPN, captive portal or administrator login.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'AUTH-VPN' },
      { id: 'method', label: 'Method', control: 'select', default: 'ldap', options: [
        { value: 'ldap', label: 'LDAP or Active Directory' },
        { value: 'radius', label: 'RADIUS' },
        { value: 'saml', label: 'SAML' },
        { value: 'kerberos', label: 'Kerberos' },
      ] },
      { id: 'server_profile', label: 'Server profile name', control: 'text', default: 'LDAP-AD' },
      { id: 'servers', label: 'Servers', control: 'text', default: '10.0.5.10, 10.0.5.11' },
      { id: 'base_dn', label: 'Base DN', control: 'text', default: 'DC=example,DC=com', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'bind_dn', label: 'Bind DN', control: 'text', default: 'CN=svc-panos,OU=Service,DC=example,DC=com', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'login_attribute', label: 'Login attribute', control: 'select', default: 'sAMAccountName', options: [
        { value: 'sAMAccountName', label: 'sAMAccountName — Active Directory' },
        { value: 'userPrincipalName', label: 'userPrincipalName' },
        { value: 'uid', label: 'uid — OpenLDAP' },
      ], showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'allow_groups', label: 'Groups allowed', control: 'textarea', default: 'cn=vpn-users,ou=groups,dc=example,dc=com' },
      { id: 'mfa', label: 'Require multi-factor', control: 'toggle', default: true },
      { id: 'sequence', label: 'Also build a sequence with a fallback', control: 'toggle', default: false },
      { id: 'fallback_profile', label: 'Fallback profile', control: 'text', default: 'AUTH-LOCAL', showWhen: { input: 'sequence', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const profile = str(values, 'profile_name', 'AUTH-VPN');
      const method = str(values, 'method', 'ldap');
      const serverProfile = str(values, 'server_profile', 'LDAP-AD');
      const servers = listOf(str(values, 'servers', ''));
      const groups = str(values, 'allow_groups', '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const findings            = [];
      if (servers.length === 0) findings.push(error('network.panos.no-auth-servers', 'No authentication server was given.', { source: 'ArchToolKit' }));
      // LDAP, RADIUS and Kerberos server profiles take IPv4 or IPv6 addresses, or hostnames.
      const badServers = servers.filter((server) => looksLikeAddress(server) && !isIp(server));
      if (badServers.length > 0) findings.push(badAddressFinding('Authentication servers', badServers));
      if (servers.length === 1) {
        findings.push(warning('network.panos.single-auth-server', 'One authentication server means nobody can log in while it is down — including, depending on where this profile is used, the administrators.', { source: 'ArchToolKit' }));
      }
      if (groups.length === 0) {
        findings.push(error('network.panos.auth-allow-all', 'With no allow list, every account in the directory can authenticate against this profile — service accounts, disabled-but-not-deleted accounts, everything.', { remediation: 'Name the groups that are meant to have access.', source: 'ArchToolKit' }));
      }
      if (method === 'ldap') {
        findings.push(warning('network.panos.ldaps', 'Use LDAPS on 636 or StartTLS. Plain LDAP sends the bind and the user’s credentials in clear on the wire.', { source: 'ArchToolKit' }));
      }
      if (!bool(values, 'mfa', true)) {
        findings.push(warning('network.panos.no-mfa', 'Remote access with a single factor is one phished password away from an authenticated session inside the network.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Authentication profile ${profile} using ${method.toUpperCase()}`,
        impact: 'none',
        notes: [
          'The bind password or shared secret is `<REQUIRED>` and typed at apply time. It goes in the vault, never in the change record.',
          'Test the profile from the CLI before attaching it to anything: `test authentication authentication-profile <name> username <user>`. That is the difference between finding a wrong base DN now and finding it when nobody can connect.',
          ...(bool(values, 'sequence', false) ? ['A sequence tries each profile in order. A slow first profile delays every login by its timeout, so order matters more than it looks.'] : []),
        ],
        before: ['show running authentication-profile', 'show running server-profile', 'show log system direction equal backward | match auth'],
        config: [
          ...(method === 'ldap'
            ? [
                `set shared server-profile ldap ${serverProfile} ldap-type active-directory`,
                ...servers.map((server, index) => `set shared server-profile ldap ${serverProfile} server SRV${index + 1} address ${server} port 636`),
                `set shared server-profile ldap ${serverProfile} ssl yes`,
                `set shared server-profile ldap ${serverProfile} verify-server-certificate yes`,
                `set shared server-profile ldap ${serverProfile} base "${str(values, 'base_dn', '')}"`,
                `set shared server-profile ldap ${serverProfile} bind-dn "${str(values, 'bind_dn', '')}"`,
                `set shared server-profile ldap ${serverProfile} bind-password ${SECRET}`,
                `set shared server-profile ldap ${serverProfile} timelimit 30`,
              ]
            : method === 'radius'
              ? [
                  ...servers.map((server, index) => `set shared server-profile radius ${serverProfile} server SRV${index + 1} ip-address ${server} port 1812 secret ${SECRET}`),
                  `set shared server-profile radius ${serverProfile} protocol EAP-TTLS-with-PAP`,
                  `set shared server-profile radius ${serverProfile} timeout 10`,
                ]
              : method === 'kerberos'
                ? servers.map((server, index) => `set shared server-profile kerberos ${serverProfile} server SRV${index + 1} host ${server} port 88`)
                : [`${'!'} SAML needs the identity provider metadata imported first:`, `${'!'} request certificate fetch / import the IdP metadata file, then reference it below`]),
          '',
          `set shared authentication-profile ${profile} method ${method} server-profile ${serverProfile}`,
          ...(method === 'ldap' ? [`set shared authentication-profile ${profile} method ldap login-attribute ${str(values, 'login_attribute', 'sAMAccountName')}`] : []),
          ...groups.map((group) => `set shared authentication-profile ${profile} allow-list "${group}"`),
          ...(bool(values, 'mfa', true) ? [`set shared authentication-profile ${profile} multi-factor-auth mfa-enable yes`] : []),
          `set shared authentication-profile ${profile} lockout failed-attempts 5`,
          `set shared authentication-profile ${profile} lockout lockout-time 30`,
          '',
          ...(bool(values, 'sequence', false)
            ? [
                `set shared authentication-sequence SEQ-${profile} authentication-profiles ${profile}`,
                `set shared authentication-sequence SEQ-${profile} authentication-profiles ${str(values, 'fallback_profile', 'AUTH-LOCAL')}`,
                `set shared authentication-sequence SEQ-${profile} use-domain-find-profile no`,
              ]
            : []),
          '',
          'commit description "Authentication profile"',
        ],
        verify: [
          `show shared authentication-profile ${profile}`,
          `test authentication authentication-profile ${profile} username <a real user> password`,
          'show log system direction equal backward | match auth',
          `${'!'} Confirm a user outside the allowed groups is refused`,
        ],
        backout: [
          ...(bool(values, 'sequence', false) ? [`delete shared authentication-sequence SEQ-${profile}`] : []),
          `delete shared authentication-profile ${profile}`,
          `delete shared server-profile ${method === 'ldap' ? 'ldap' : method === 'radius' ? 'radius' : 'kerberos'} ${serverProfile}`,
          'commit description "Back out authentication profile"',
        ],
        findings,
      };
    },
  }),
];

/**
 * Junos system changes: the management baseline, users, AAA, and the root
 * password and configuration archive every box needs before anything else.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { isIp } from '../../core/ip.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { listOf, type DeviceChange } from '../device.ts';
import { COMMIT_CONFIRMED, ident, PLATFORM, q, SECRET, SRC } from './junos-common.ts';

/** An error for each entry that looks like an address but is not one. */
function hostFindings(code: string, label: string, hosts: readonly string[]): Finding[] {
  return hosts
    .filter((h) => (/^[\d.]+$/.test(h) || h.includes(':')) && !isIp(h))
    .map((h) => error(code, `"${h}" in ${label} is not a valid IPv4 or IPv6 address.`, { remediation: 'Write an address (10.0.0.10, 2001:db8::10) or a host name.', ...SRC }));
}

export const JUNOS_SYSTEM: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'junos_system_baseline',
    platform: PLATFORM,
    label: 'Management baseline',
    group: 'System',
    description: 'Host name, DNS, NTP, syslog, SNMPv3, a login banner, and SSH with NETCONF over SSH — which is what Ansible and every automation tool connects to.',
    inputs: [
      { id: 'hostname', label: 'Host name', control: 'text', default: 'ex-access-01' },
      { id: 'domain', label: 'Domain name', control: 'text', default: 'example.net' },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '10.0.0.53', hint: 'IPv4 or IPv6, comma separated' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11' },
      { id: 'syslog_servers', label: 'Syslog servers', control: 'text', default: '10.0.0.20' },
      { id: 'time_zone', label: 'Time zone', control: 'text', default: 'UTC' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor', hint: 'Empty for no SNMP' },
      { id: 'banner', label: 'Login banner', control: 'text', default: 'Authorised access only. Activity is logged.' },
      { id: 'netconf', label: 'NETCONF over SSH', control: 'toggle', default: true, hint: 'junos_config connects over NETCONF (port 830)' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const hostname = ident(str(values, 'hostname', 'junos-01'), 'junos-01');
      const dns = listOf(str(values, 'dns_servers', ''));
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const syslog = listOf(str(values, 'syslog_servers', ''));
      const user = str(values, 'snmp_user', '') === '' ? '' : ident(str(values, 'snmp_user', ''), 'monitor');
      const banner = str(values, 'banner', '');
      const netconf = bool(values, 'netconf', true);
      const findings: Finding[] = [
        ...hostFindings('network.junos.bad-dns', 'the DNS servers', dns),
        ...hostFindings('network.junos.bad-ntp', 'the NTP servers', ntp),
        ...hostFindings('network.junos.bad-syslog', 'the syslog servers', syslog),
      ];
      if (ntp.length === 1) findings.push(warning('network.junos.single-ntp', 'One NTP server is a single point of failure for every log timestamp. Give it two or more.', SRC));
      if (!netconf) findings.push(warning('network.junos.no-netconf', 'Without `system services netconf ssh`, junos_config and most automation cannot reach the device. The playbook generated here will not connect.', SRC));

      return {
        platform: PLATFORM,
        title: `Management baseline on ${hostname}`,
        impact: 'none',
        notes: [
          COMMIT_CONFIRMED,
          ...(user ? [`Replace each ${SECRET} with the SNMPv3 keys from your vault (eight characters or more). Junos stores them hashed.`] : []),
          'The previous host name is in `show configuration system host-name`; the back-out puts it back from there.',
        ],
        findings,
        before: ['show configuration system | display set', 'show ntp associations', 'show system services', ...(user ? ['show snmp v3'] : [])],
        config: [
          `set system host-name ${hostname}`,
          `set system domain-name ${q(str(values, 'domain', 'example.net'))}`,
          `set system time-zone ${q(str(values, 'time_zone', 'UTC'))}`,
          ...dns.map((s) => `set system name-server ${s}`),
          ...ntp.map((s) => `set system ntp server ${s}`),
          ...syslog.flatMap((s) => [`set system syslog host ${s} any notice`, `set system syslog host ${s} authorization info`, `set system syslog host ${s} interactive-commands any`]),
          'set system syslog time-format millisecond',
          'set system syslog file interactive-commands interactive-commands any',
          'set system services ssh root-login deny',
          'set system services ssh protocol-version v2',
          'set system services ssh connection-limit 10',
          'set system services ssh rate-limit 5',
          ...(netconf ? ['set system services netconf ssh'] : []),
          ...(banner ? [`set system login message ${q(banner)}`] : []),
          ...(user
            ? [
                `set snmp v3 usm local-engine user ${user} authentication-sha authentication-password "${SECRET}"`,
                `set snmp v3 usm local-engine user ${user} privacy-aes128 privacy-password "${SECRET}"`,
                `set snmp v3 vacm security-to-group security-model usm security-name ${user} group MONITOR`,
                'set snmp v3 vacm access group MONITOR default-context-prefix security-model usm security-level privacy read-view ALL',
                'set snmp view ALL oid .1 include',
              ]
            : []),
        ],
        verify: ['show system information', 'show ntp associations', 'show system connections | match "22|830"', ...(user ? ['show snmp v3 general'] : []), 'show log messages | last 20'],
        backout: [
          'set system host-name <previous host-name>',
          ...dns.map((s) => `delete system name-server ${s}`),
          ...ntp.map((s) => `delete system ntp server ${s}`),
          ...syslog.map((s) => `delete system syslog host ${s}`),
          ...(banner ? ['delete system login message'] : []),
          ...(netconf ? ['delete system services netconf'] : []),
          ...(user ? [`delete snmp v3 usm local-engine user ${user}`, `delete snmp v3 vacm security-to-group security-model usm security-name ${user}`, 'delete snmp v3 vacm access group MONITOR'] : []),
          'commit',
        ],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_local_user',
    platform: PLATFORM,
    label: 'Local user and login class',
    group: 'System',
    description: 'A local account with a login class — the break-glass account that still works when RADIUS or TACACS+ does not.',
    inputs: [
      { id: 'username', label: 'User name', control: 'text', default: 'netops' },
      { id: 'full_name', label: 'Full name', control: 'text', default: 'Network operations' },
      {
        id: 'class',
        label: 'Login class',
        control: 'select',
        default: 'super-user',
        options: [
          { value: 'super-user', label: 'super-user (everything)' },
          { value: 'operator', label: 'operator (clear, network, reset, trace, view)' },
          { value: 'read-only', label: 'read-only (view)' },
          { value: 'unauthorized', label: 'unauthorized (nothing)' },
        ],
      },
      {
        id: 'auth',
        label: 'Authentication',
        control: 'select',
        default: 'password',
        options: [
          { value: 'password', label: 'Password (hash from your vault)' },
          { value: 'ssh-ed25519', label: 'SSH key (Ed25519)' },
          { value: 'ssh-rsa', label: 'SSH key (RSA)' },
        ],
      },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const user = ident(str(values, 'username', 'netops'), 'netops').toLowerCase();
      const klass = str(values, 'class', 'super-user');
      const auth = str(values, 'auth', 'password');
      const findings: Finding[] = [];
      if (user === 'root') findings.push(error('network.junos.root-user', '`root` is not a login user on Junos; its password is `system root-authentication`.', SRC));
      if (klass === 'super-user') findings.push(warning('network.junos.super-user', `${user} gets super-user: every command, including \`request system zeroize\`. Keep that to the break-glass account.`, SRC));
      if (auth === 'ssh-rsa') findings.push(warning('network.junos.rsa-key', 'RSA keys under 2048 bits are rejected by current Junos releases, and Ed25519 is preferred.', SRC));

      return {
        platform: PLATFORM,
        title: `Local user ${user} (${klass})`,
        impact: 'none',
        notes: [
          auth === 'password'
            ? `Replace ${SECRET} with an encrypted-password hash ($6$…) generated off the box, never the password itself. Or type \`set system login user ${user} authentication plain-text-password\` interactively.`
            : `Replace ${SECRET} with the public key line, for example "ssh-ed25519 AAAAC3… user@host".`,
        ],
        findings,
        before: [`show configuration system login user ${user} | display set`, 'show system users'],
        config: [
          `set system login user ${user} full-name ${q(str(values, 'full_name', user))}`,
          `set system login user ${user} class ${klass}`,
          auth === 'password'
            ? `set system login user ${user} authentication encrypted-password "${SECRET}"`
            : `set system login user ${user} authentication ${auth} "${SECRET}"`,
        ],
        verify: [`show configuration system login user ${user}`, `show system login lockout`, `ssh ${user}@<device> (from a second session, before you close this one)`],
        backout: [`delete system login user ${user}`, 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_aaa',
    platform: PLATFORM,
    label: 'RADIUS or TACACS+ authentication',
    group: 'System',
    description: 'Remote authentication and command accounting against RADIUS or TACACS+, with local accounts as the fallback when no server answers.',
    inputs: [
      { id: 'protocol', label: 'Protocol', control: 'select', default: 'tacplus', options: [{ value: 'tacplus', label: 'TACACS+' }, { value: 'radius', label: 'RADIUS' }] },
      { id: 'servers', label: 'Servers', control: 'text', default: '10.0.0.40, 10.0.0.41' },
      { id: 'source_address', label: 'Source address', control: 'text', default: '10.0.0.2', hint: 'The management address the server knows this device by; empty for the egress interface' },
      { id: 'timeout', label: 'Timeout (seconds)', control: 'number', default: 5, min: 1, max: 90 },
      { id: 'template_class', label: 'Class for remote users', control: 'select', default: 'operator', options: [{ value: 'operator', label: 'operator' }, { value: 'read-only', label: 'read-only' }, { value: 'super-user', label: 'super-user' }] },
      { id: 'accounting', label: 'Command accounting', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const protocol = str(values, 'protocol', 'tacplus');
      const servers = listOf(str(values, 'servers', ''));
      const source = str(values, 'source_address', '');
      const accounting = bool(values, 'accounting', true);
      const node = protocol === 'radius' ? 'radius-server' : 'tacplus-server';
      const findings: Finding[] = [
        ...servers.filter((s) => !isIp(s)).map((s) => error('network.junos.bad-aaa-server', `"${s}" is not an address. Junos takes the server as an address.`, SRC)),
        ...(source && !isIp(source) ? [error('network.junos.bad-source-address', `The source address "${source}" is not an address.`, SRC)] : []),
      ];
      if (servers.length === 0) findings.push(error('network.junos.no-aaa-server', 'No servers: the authentication order would name a method with nothing behind it.', SRC));
      if (servers.length === 1) findings.push(warning('network.junos.single-aaa', 'One server: when it is down, logins fall to the local accounts.', SRC));

      return {
        platform: PLATFORM,
        title: `${protocol === 'radius' ? 'RADIUS' : 'TACACS+'} authentication${accounting ? ' and accounting' : ''}`,
        impact: 'none',
        notes: [
          COMMIT_CONFIRMED,
          `Replace each ${SECRET} with the shared secret from your vault.`,
          'Users the server accepts but that have no local account log in as the template user `remote`, with its class — unless the server returns a local user name (Juniper-Local-User-Name / local-user-name).',
          'With only the remote method in the authentication order, Junos still falls back to local accounts when no server answers, but not when a server rejects the user. To also try local accounts after a rejection, add it to the end of the order yourself: `set system authentication-order [ ' + protocol + ' password ]`.',
          'Keep a local break-glass user (the local user blueprint), and test from a second session before closing this one.',
        ],
        findings,
        before: ['show configuration system authentication-order', `show configuration system ${node} | display set`, 'show configuration system accounting'],
        config: [
          ...servers.flatMap((s) => [
            `set system ${node} ${s} secret "${SECRET}"`,
            `set system ${node} ${s} timeout ${num(values, 'timeout', 5)}`,
            ...(source ? [`set system ${node} ${s} source-address ${source}`] : []),
            ...(protocol === 'tacplus' ? [`set system ${node} ${s} single-connection`] : [`set system ${node} ${s} retry 2`]),
          ]),
          'delete system authentication-order',
          `set system authentication-order ${protocol}`,
          `set system login user remote class ${str(values, 'template_class', 'operator')}`,
          ...(accounting
            ? ['set system accounting events [ login change-log interactive-commands ]', ...servers.map((s) => `set system accounting destination ${protocol} server ${s} secret "${SECRET}"`)]
            : []),
        ],
        verify: ['show configuration system authentication-order', 'show system users', 'ssh <server-only user>@<device> from a second session', 'show log messages | match "tac|radius|authd"'],
        backout: ['delete system authentication-order', ...servers.map((s) => `delete system ${node} ${s}`), 'delete system login user remote', ...(accounting ? ['delete system accounting'] : []), 'commit'],
      };
    },
  }),

  deviceBlueprint({
    id: 'junos_root_rescue',
    platform: PLATFORM,
    label: 'Root password, commit and rescue configuration',
    group: 'System',
    description: 'The root password (required before the first commit), commit synchronize for two routing engines or a virtual chassis, configuration archive on every commit, and a rescue configuration.',
    inputs: [
      { id: 'archive_url', label: 'Archive site', control: 'text', default: 'sftp://backup@10.0.0.30/junos/', hint: 'scp:// or sftp://; empty for none. Never put the password in the URL' },
      { id: 'synchronize', label: 'Commit synchronize', control: 'toggle', default: false, hint: 'Dual routing engines, or a virtual chassis' },
      { id: 'max_configs', label: 'Rollback files kept on flash', control: 'number', default: 49, min: 3, max: 49 },
      { id: 'root_password', label: 'Set the root password', control: 'toggle', default: true },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const url = str(values, 'archive_url', '');
      const sync = bool(values, 'synchronize', false);
      const root = bool(values, 'root_password', true);
      const findings: Finding[] = [];
      if (/:\/\/[^/@]+:[^/@]+@/.test(url)) findings.push(error('network.junos.password-in-url', 'The archive URL carries a password. It would be stored in the configuration in clear text: give it as the archive-site password instead.', SRC));
      if (/^ftp:\/\//i.test(url)) findings.push(warning('network.junos.ftp-archive', 'FTP sends the configuration, and its hashes, in clear text. Use scp:// or sftp://.', SRC));

      return {
        platform: PLATFORM,
        title: 'Root password, archive and rescue configuration',
        impact: 'none',
        notes: [
          ...(root ? [`Replace ${SECRET} with the root password hash ($6$…) from your vault. Junos refuses the first commit of a factory configuration without one.`] : []),
          ...(url ? [`Replace the archive-site ${SECRET} with the transfer password from your vault, and add the server's host key: \`set security ssh-known-hosts fetch-from-server <host>\`.`] : []),
          'After the commit, save this as the rescue configuration from operational mode: `request system configuration rescue save`. `rollback rescue` loads it when nothing else will.',
        ],
        findings,
        before: ['show system commit', 'show configuration system archival', 'file list /config/'],
        config: [
          ...(root ? [`set system root-authentication encrypted-password "${SECRET}"`] : []),
          ...(sync ? ['set system commit synchronize'] : []),
          `set system max-configurations-on-flash ${num(values, 'max_configs', 49)}`,
          ...(url ? ['set system archival configuration transfer-on-commit', `set system archival configuration archive-sites ${q(url)} password "${SECRET}"`] : []),
        ],
        verify: ['show system commit', 'show configuration system archival', 'file list /config/rescue.conf.gz', 'show log messages | match archiv'],
        backout: [...(url ? ['delete system archival'] : []), ...(sync ? ['delete system commit synchronize'] : []), 'delete system max-configurations-on-flash', 'commit', 'request system configuration rescue delete (only if the rescue file was new)'],
      };
    },
  }),
];

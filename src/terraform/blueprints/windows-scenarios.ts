/**
 * Hand-written Windows scenario blueprints: several resources built together.
 *
 * Active Directory structure and Group Policy through the ad provider (WinRM to
 * a domain controller), AD-integrated DNS through the dns provider (GSS-TSIG),
 * and everything that has to happen on the server itself — roles, domain join,
 * IIS, local accounts — as PowerShell over WinRM from `terraform_data`.
 *
 * Every script is uploaded to C:/Windows/Temp, deletes itself as its first
 * statement (some hold a password) and is written to be safe to run twice.
 * Passwords are sensitive variables or random_password results, never text.
 *
 * Every scenario is run through `terraform validate` with the real providers by
 * tools/validate-terraform-blueprints.mjs.
 */

import type { Blueprint, BlueprintInput } from '../../kit/blueprint.ts';
import { warning, type Finding } from '../../core/findings.ts';
import { ident, items, n, on, pairs, q, scenario, YES_NO_OPTIONS } from './scenario-common.ts';

const GROUP = 'Windows · Scenarios (several resources together)';
const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

// --- helpers -----------------------------------------------------------------

/** Non-empty, non-comment lines of a textarea. */
function lines(value: unknown): string[] {
  return String(value ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Text placed verbatim in an HCL heredoc: only `${` and `%{` need escaping. */
function hcl(text: string): string {
  return text.replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
}

/** A PowerShell single-quoted literal, safe inside an HCL heredoc. */
function ps(value: unknown): string {
  return `'${hcl(String(value ?? '').trim().replace(/'/g, "''"))}'`;
}

/** `@('a', 'b')` */
function psArray(values: readonly string[]): string {
  return `@(${values.map(ps).join(', ')})`;
}

/**
 * A secret interpolated into a script as a PowerShell single-quoted literal.
 * It only ever becomes a SecureString on the host — never a command-line
 * argument — and the script file it sits in deletes itself first thing.
 */
function psSecret(expr: string): string {
  return `'\${replace(${expr}, "'", "''")}'`;
}

/** An FQDN with its trailing dot. */
function dotted(name: unknown): string {
  const s = String(name ?? '').trim();
  return s === '' || s.endsWith('.') ? s : `${s}.`;
}

function isIpv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** The /24 reverse zone and record name for an IPv4 address. */
function reverse(ip: string): { zone: string; name: string } {
  const [a, b, c, d] = ip.split('.');
  return { zone: `${c}.${b}.${a}.in-addr.arpa.`, name: String(d) };
}

/** Terraform identifiers, unique within one scenario. */
function namer(): (value: unknown, fallback?: string) => string {
  const used = new Set<string>();
  return (value, fallback = 'this') => {
    const base = ident(value, fallback);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
    used.add(id);
    return id;
  };
}

function sensitiveVariable(name: string, description: string): string {
  return `variable "${name}" {
  type        = string
  description = ${q(description)}
  sensitive   = true
}`;
}

// --- WinRM + PowerShell ------------------------------------------------------

const WINRM = 'WinRM connection';

function winrmInputs(user: { id: string; default: string; hint?: string }): BlueprintInput[] {
  return [
    { id: user.id, label: 'WinRM user', control: 'text', default: user.default, hint: user.hint ?? 'DOMAIN\\user, user@domain or a local account', section: WINRM },
    { id: 'winrm_https', label: 'HTTPS listener (5986)', control: 'toggle', default: true, hint: 'off = HTTP on 5985, lab only', section: WINRM },
    { id: 'winrm_insecure', label: 'Skip certificate check', control: 'toggle', default: false, hint: 'for a self-signed listener certificate', section: WINRM, showWhen: { input: 'winrm_https', equals: ['true'] } },
    { id: 'winrm_timeout', label: 'Connect timeout', control: 'text', default: '10m', section: WINRM },
  ];
}

/** A resource-level WinRM connection block (NTLM), password from var.winrm_password. */
function connection(v: Record<string, unknown>, host: string, userId = 'winrm_user', timeout?: string): string {
  const https = on(v.winrm_https);
  return `  connection {
    type     = "winrm"
    host     = ${host}
    user     = ${q(v[userId])}
    password = var.winrm_password
    https    = ${https}
    port     = ${https ? 5986 : 5985}
    use_ntlm = true${https ? `
    insecure = ${on(v.winrm_insecure)}` : ''}
    timeout  = ${q(timeout ?? (String(v.winrm_timeout ?? '').trim() || '10m'))}
  }`;
}

const WINRM_PASSWORD = sensitiveVariable('winrm_password', 'Password for the WinRM user');

interface PsRun {
  readonly name: string;
  readonly forEach?: string;
  readonly script: readonly string[];
  readonly triggers: string;
  readonly connection: string;
  readonly continueOnError?: boolean;
  /** Provisioners that run before the script is uploaded. */
  readonly before?: string;
}

/**
 * A terraform_data that uploads a PowerShell script and runs it with -File —
 * a real script with variables and blocks, not a line of cmd.exe quoting.
 */
function psRun(r: PsRun): string {
  const path = `C:/Windows/Temp/terraform-${r.name.replace(/_/g, '-')}.ps1`;
  const script = [
    '# Delete the uploaded copy before anything else: it can hold a secret.',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    `$ErrorActionPreference = '${r.continueOnError ? 'Continue' : 'Stop'}'`,
    "$ProgressPreference = 'SilentlyContinue'",
    '',
    ...r.script,
  ];
  const body = script.map((l) => (l === '' ? '' : `      ${l}`)).join('\n');
  return `resource "terraform_data" "${r.name}" {${r.forEach ? `
  for_each = ${r.forEach}
` : ''}
  triggers_replace = ${r.triggers}

${r.connection}
${r.before ? `\n${r.before}\n` : ''}
  provisioner "file" {
    content     = <<-EOT
${body}
    EOT
    destination = "${path}"
  }

  provisioner "remote-exec" {
    inline = ["powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${path}"]
  }
}`;
}

// --- PowerShell over WinRM ---------------------------------------------------

const winrmExec = scenario('null', {
  id: 'windows_null_winrm_exec',
  label: 'Run PowerShell on a Windows host (WinRM)',
  description:
    'Runs PowerShell on a Windows host over WinRM (HTTPS, NTLM): the lines are uploaded as one script, so variables and blocks carry across lines, and it runs again whenever they change. The WinRM password is a sensitive variable.',
  group: GROUP,
  inputs: [
    { id: 'host', label: 'Target host', control: 'text', default: 'srv01.example.com', hint: 'DNS name or IP' },
    {
      id: 'inline_command',
      label: 'PowerShell',
      control: 'textarea',
      default:
        "Set-TimeZone -Id 'Eastern Standard Time'\nSet-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections -Value 0\nEnable-NetFirewallRule -DisplayGroup 'Remote Desktop'",
      hint: 'one statement per line, run as one script',
    },
    { id: 'stop_on_error', label: 'Stop at the first error', control: 'toggle', default: true, hint: "$ErrorActionPreference = 'Stop'" },
    ...winrmInputs({ id: 'user', default: 'EXAMPLE\\svc-terraform' }),
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const commands = String(v.inline_command ?? '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
    return `${psRun({
      name: 'powershell',
      connection: connection(v, q(v.host), 'user'),
      triggers: `[\n${commands.map((c) => `    ${q(c)},`).join('\n')}\n  ]`,
      continueOnError: !on(v.stop_on_error),
      script: commands.map(hcl),
    })}

${WINRM_PASSWORD}`;
  },
});

// --- Active Directory structure ----------------------------------------------

const SCOPES = [
  { value: 'global', label: 'Global' },
  { value: 'domainlocal', label: 'Domain local' },
  { value: 'universal', label: 'Universal' },
];
const CATEGORIES = [
  { value: 'security', label: 'Security' },
  { value: 'distribution', label: 'Distribution' },
];

/** `Example/Servers` under DC=example,DC=com → OU=Servers,OU=Example,DC=example,DC=com */
function ouDn(path: string, domainDn: string): string {
  const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
  return [...parts.reverse().map((p) => `OU=${p}`), domainDn].join(',');
}

const adStructure = scenario('ad', {
  id: 'windows_ad_structure',
  label: 'AD structure: OUs, groups, users and memberships',
  description:
    'Builds an OU tree, security groups and user accounts in Active Directory and puts the users in their groups. Initial passwords are random per user (a sensitive output) or one sensitive variable; users can be made to change it at first logon.',
  group: GROUP,
  alsoUses: ['random'],
  inputs: [
    { id: 'domain_dn', label: 'Domain DN', control: 'text', default: 'DC=example,DC=com' },
    { id: 'upn_suffix', label: 'UPN suffix', control: 'text', default: 'example.com', hint: 'user@<suffix>' },
    {
      id: 'ous',
      label: 'OUs',
      control: 'textarea',
      default: 'Example\nExample/Servers\nExample/Workstations\nExample/Users\nExample/Groups',
      hint: 'one path per line, / between levels, parents first',
    },
    {
      id: 'groups',
      label: 'Groups',
      control: 'textarea',
      default: 'GG-Server-Admins, Example/Groups\nGG-App-Users, Example/Groups\nDL-Share-Finance-RW, Example/Groups, domainlocal',
      hint: 'name, OU path or DN[, scope[, category]]',
    },
    { id: 'group_scope', label: 'Default group scope', control: 'select', options: SCOPES, default: 'global' },
    { id: 'group_category', label: 'Default group category', control: 'select', options: CATEGORIES, default: 'security' },
    {
      id: 'users',
      label: 'Users',
      control: 'textarea',
      default: 'jdoe=Jane Doe, Example/Users, GG-Server-Admins; GG-App-Users\nasmith=Alex Smith, Example/Users, GG-App-Users',
      hint: 'sam=Display Name, OU path or DN, group; group',
    },
    {
      id: 'password_mode',
      label: 'Initial passwords',
      control: 'select',
      options: [
        { value: 'random', label: 'Random per user (sensitive output)' },
        { value: 'variable', label: 'One password from a sensitive variable' },
      ],
      default: 'random',
    },
    { id: 'password_length', label: 'Password length', control: 'number', default: 20, min: 12, max: 128, showWhen: { input: 'password_mode', equals: ['random'] } },
    { id: 'change_at_logon', label: 'Change password at next logon', control: 'toggle', default: true, help: 'The ad provider cannot set this flag, so a Set-ADUser runs once per new user over the provider’s own WinRM connection to the domain controller.' },
    { id: 'users_enabled', label: 'Accounts enabled', control: 'toggle', default: true },
    { id: 'ou_protected', label: 'Protect OUs from accidental deletion', control: 'toggle', default: true, section: 'Options' },
  ],
  emits: ['ad_ou', 'ad_group', 'ad_group_membership', 'ad_user', 'random_password', 'terraform_data'],
  body: (v) => {
    const findings: Finding[] = [];
    const domainDn = String(v.domain_dn ?? '').trim() || 'DC=example,DC=com';
    const id = namer();
    const out: string[] = [];

    // OUs: idents first, so a child can reference its parent in any order.
    const ous = lines(v.ous).map((path) => path.split('/').map((p) => p.trim()).filter(Boolean).join('/'));
    const ouIds = new Map(ous.map((p) => [p.toLowerCase(), id(p.replace(/\//g, '_'), 'ou')]));
    const where = (field: string, fallback: string): string => {
      const s = field.trim();
      if (s === '') return q(fallback);
      if (s.includes('=')) return q(s);
      const known = ouIds.get(s.split('/').map((p) => p.trim()).join('/').toLowerCase());
      return known ? `ad_ou.${known}.dn` : q(ouDn(s, domainDn));
    };
    for (const path of ous) {
      const parts = path.split('/');
      const parent = parts.slice(0, -1).join('/');
      out.push(`resource "ad_ou" "${ouIds.get(path.toLowerCase())}" {
  name        = ${q(parts[parts.length - 1])}
  path        = ${parent ? where(parent, domainDn) : q(domainDn)}
  description = "Managed by Terraform"
  protected   = ${on(v.ou_protected)}
}`);
    }

    // Groups.
    const groupIds = new Map<string, string>();
    for (const line of lines(v.groups)) {
      const [name = '', ou = '', scope = '', category = ''] = line.split(',').map((s) => s.trim());
      if (!name) continue;
      const scopeValue = SCOPES.some((s) => s.value === scope.toLowerCase()) ? scope.toLowerCase() : String(v.group_scope ?? 'global');
      const categoryValue = CATEGORIES.some((c) => c.value === category.toLowerCase()) ? category.toLowerCase() : String(v.group_category ?? 'security');
      const gid = id(name, 'group');
      groupIds.set(name.toLowerCase(), gid);
      out.push(`resource "ad_group" "${gid}" {
  name             = ${q(name)}
  sam_account_name = ${q(name)}
  container        = ${where(ou, `CN=Users,${domainDn}`)}
  scope            = ${q(scopeValue)}
  category         = ${q(categoryValue)}
}`);
    }

    // Users.
    const members = new Map<string, string[]>();
    const users: string[] = [];
    for (const line of lines(v.users)) {
      const eq = line.indexOf('=');
      const sam = (eq === -1 ? line.split(',')[0] : line.slice(0, eq))?.trim() ?? '';
      if (!sam) continue;
      const [display = sam, ou = '', groups = ''] = (eq === -1 ? line.split(',').slice(1).join(',') : line.slice(eq + 1)).split(',').map((s) => s.trim());
      const [given, ...rest] = (display || sam).split(/\s+/);
      users.push(`    ${q(sam)} = {
      display_name = ${q(display || sam)}
      given_name   = ${q(given)}
      surname      = ${rest.length ? q(rest.join(' ')) : 'null'}
      container    = ${where(ou, `CN=Users,${domainDn}`)}
    }`);
      for (const g of groups.split(';').map((s) => s.trim()).filter(Boolean)) {
        if (!groupIds.has(g.toLowerCase())) {
          findings.push(warning('windows.ad.group-not-managed', `User ${sam} names group ${g}, which this scenario does not create; that membership was left out.`, {
            remediation: 'Add the group to the Groups list. ad_group_membership owns a group’s whole member list, so it is not pointed at an existing group.',
          }));
          continue;
        }
        members.set(g.toLowerCase(), [...(members.get(g.toLowerCase()) ?? []), sam]);
      }
    }

    if (users.length) {
      const random = v.password_mode !== 'variable';
      out.push(`locals {
  users = {
${users.join('\n')}
  }
}`);
      if (random) {
        out.push(`resource "random_password" "user" {
  for_each = local.users

  length           = ${n(v.password_length, 20)}
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
  override_special = "!#%*-_=+?"
}`);
      }
      out.push(`resource "ad_user" "user" {
  for_each = local.users

  sam_account_name = each.key
  principal_name   = "\${each.key}@${hcl(String(v.upn_suffix ?? '').trim())}"
  display_name     = each.value.display_name
  given_name       = each.value.given_name
  surname          = each.value.surname
  container        = each.value.container
  initial_password = ${random ? 'random_password.user[each.key].result' : 'var.initial_password'}
  enabled          = ${on(v.users_enabled)}
}`);
      for (const [group, sams] of members) {
        const gid = groupIds.get(group) as string;
        out.push(`resource "ad_group_membership" "${gid}" {
  group_id      = ad_group.${gid}.id
  group_members = [${sams.map((s) => `ad_user.user[${q(s)}].id`).join(', ')}]
}`);
      }
      if (on(v.change_at_logon)) {
        const https = String(v['p.winrm_proto'] ?? 'https') === 'https';
        out.push(`# The ad provider has no "must change password" argument; set it once per new
# user over the same WinRM connection the provider uses.
resource "terraform_data" "change_password_at_logon" {
  for_each = ad_user.user

  triggers_replace = each.value.id

  connection {
    type     = "winrm"
    host     = ${q(v['p.winrm_hostname'] ?? 'dc01.example.com')}
    user     = ${q(v['p.winrm_username'] ?? 'EXAMPLE\\svc-terraform')}
    password = var.ad_password
    https    = ${https}
    port     = ${n(v['p.winrm_port'], https ? 5986 : 5985)}
    use_ntlm = ${v['p.winrm_use_ntlm'] === undefined ? true : on(v['p.winrm_use_ntlm'])}
    insecure = ${on(v['p.winrm_insecure'])}
  }

  provisioner "remote-exec" {
    inline = ["powershell.exe -NoProfile -NonInteractive -Command Set-ADUser -Identity '\${each.value.sam_account_name}' -ChangePasswordAtLogon $true"]
  }
}`);
      }
      out.push(
        random
          ? `output "initial_passwords" {
  description = "Initial password per user — hand over securely"
  value       = { for sam, p in random_password.user : sam => p.result }
  sensitive   = true
}`
          : sensitiveVariable('initial_password', 'Initial password for every new user'),
      );
    }
    return { hcl: out.join('\n\n'), findings };
  },
});

// --- Group Policy: password and lockout policy -------------------------------

const AUDIT: Record<string, Record<string, number>> = {
  // 0 none, 1 success, 2 failure, 3 both
  baseline: { audit_account_logon: 3, audit_account_manage: 3, audit_ds_access: 2, audit_logon_events: 3, audit_object_access: 2, audit_policy_change: 3, audit_privilege_use: 2, audit_process_tracking: 0, audit_system_events: 3 },
  full: { audit_account_logon: 3, audit_account_manage: 3, audit_ds_access: 3, audit_logon_events: 3, audit_object_access: 3, audit_policy_change: 3, audit_privilege_use: 3, audit_process_tracking: 3, audit_system_events: 3 },
};

const gpoPolicy = scenario('ad', {
  id: 'windows_ad_gpo_password_policy',
  label: 'Group Policy: password, lockout, Kerberos and audit policy',
  description:
    'Creates a GPO with password, account lockout and optionally Kerberos and audit settings, and links it to the domain or an OU with its enforced, enabled and order settings. Domain account password policy only applies from a GPO linked at the domain root.',
  group: GROUP,
  inputs: [
    { id: 'gpo_name', label: 'GPO name', control: 'text', default: 'Example - Password and Lockout Policy' },
    { id: 'domain', label: 'Domain', control: 'text', default: 'example.com' },
    {
      id: 'status',
      label: 'GPO status',
      control: 'select',
      options: [
        { value: 'UserSettingsDisabled', label: 'Computer settings only' },
        { value: 'AllSettingsEnabled', label: 'All settings enabled' },
        { value: 'ComputerSettingsDisabled', label: 'User settings only' },
        { value: 'AllSettingsDisabled', label: 'All settings disabled' },
      ],
      default: 'UserSettingsDisabled',
    },
    { id: 'min_length', label: 'Minimum password length', control: 'number', default: 14, min: 0, max: 14, hint: 'the classic policy caps at 14' },
    { id: 'complexity', label: 'Complexity required', control: 'toggle', default: true },
    { id: 'max_age', label: 'Maximum password age (days)', control: 'number', default: 90, min: -1, max: 999, hint: '-1 = never expires' },
    { id: 'min_age', label: 'Minimum password age (days)', control: 'number', default: 1, min: 0, max: 998 },
    { id: 'history', label: 'Password history', control: 'number', default: 24, min: 0, max: 24, hint: 'remembered passwords' },
    { id: 'lockout_threshold', label: 'Lockout threshold', control: 'number', default: 5, min: 0, max: 999, hint: 'failed attempts; 0 = never lock' },
    { id: 'lockout_duration', label: 'Lockout duration (minutes)', control: 'number', default: 15, min: 0 },
    { id: 'lockout_reset', label: 'Reset counter after (minutes)', control: 'number', default: 15, min: 1, hint: '≤ lockout duration' },
    { id: 'kerberos', label: 'Set Kerberos policy', control: 'toggle', default: false, section: 'Kerberos and audit' },
    { id: 'max_ticket_age', label: 'TGT lifetime (hours)', control: 'number', default: 10, min: 1, section: 'Kerberos and audit', showWhen: { input: 'kerberos', equals: ['true'] } },
    { id: 'max_renew_age', label: 'TGT renewal (days)', control: 'number', default: 7, min: 1, section: 'Kerberos and audit', showWhen: { input: 'kerberos', equals: ['true'] } },
    { id: 'max_service_age', label: 'Service ticket lifetime (minutes)', control: 'number', default: 600, min: 10, section: 'Kerberos and audit', showWhen: { input: 'kerberos', equals: ['true'] } },
    { id: 'max_clock_skew', label: 'Maximum clock skew (minutes)', control: 'number', default: 5, min: 0, section: 'Kerberos and audit', showWhen: { input: 'kerberos', equals: ['true'] } },
    {
      id: 'audit',
      label: 'Audit policy',
      control: 'select',
      options: [
        { value: 'none', label: 'Leave as is' },
        { value: 'baseline', label: 'Baseline (success+failure on logon, accounts, policy; failures on object/DS access)' },
        { value: 'full', label: 'Success and failure on every category' },
      ],
      default: 'none',
      section: 'Kerberos and audit',
    },
    { id: 'target_dn', label: 'Link to', control: 'text', default: 'DC=example,DC=com', hint: 'domain root or an OU DN' },
    { id: 'link_enabled', label: 'Link enabled', control: 'toggle', default: true },
    { id: 'link_enforced', label: 'Enforced', control: 'toggle', default: false },
    { id: 'link_order', label: 'Link order', control: 'number', default: 1, min: 1, hint: '1 = highest precedence' },
  ],
  emits: ['ad_gpo', 'ad_gpo_security', 'ad_gplink'],
  body: (v) => {
    const s = (x: number) => q(String(x));
    const audit = AUDIT[String(v.audit)];
    const kerberos = on(v.kerberos)
      ? `

  kerberos_policy {
    max_ticket_age   = ${s(n(v.max_ticket_age, 10))}
    max_renew_age    = ${s(n(v.max_renew_age, 7))}
    max_service_age  = ${s(n(v.max_service_age, 600))}
    max_clock_skew   = ${s(n(v.max_clock_skew, 5))}
  }`
      : '';
    const events = audit
      ? `

  # 0 = no auditing, 1 = success, 2 = failure, 3 = success and failure
  event_audit {
${Object.entries(audit).map(([k, x]) => `    ${k.padEnd(22)} = ${s(x)}`).join('\n')}
  }`
      : '';
    return `resource "ad_gpo" "policy" {
  name        = ${q(v.gpo_name)}
  domain      = ${q(v.domain)}
  description = ${q(`${['Password', 'lockout', ...(on(v.kerberos) ? ['Kerberos'] : []), ...(audit ? ['audit'] : [])].join(', ').replace(/, ([^,]+)$/, ' and $1')} policy. Managed by Terraform.`)}
  status      = ${q(v.status)}
}

resource "ad_gpo_security" "policy" {
  gpo_container = ad_gpo.policy.id

  password_policies {
    minimum_password_length = ${s(n(v.min_length, 14))}
    password_complexity     = ${q(on(v.complexity) ? '1' : '0')}
    maximum_password_age    = ${s(n(v.max_age, 90))}
    minimum_password_age    = ${s(n(v.min_age, 1))}
    password_history_size   = ${s(n(v.history, 24))}
    clear_text_password     = "0"
  }

  account_lockout {
    lockout_bad_count   = ${s(n(v.lockout_threshold, 5))}
    lockout_duration    = ${s(n(v.lockout_duration, 15))}
    reset_lockout_count = ${s(n(v.lockout_reset, 15))}
  }${kerberos}${events}
}

resource "ad_gplink" "policy" {
  gpo_guid  = ad_gpo.policy.id
  target_dn = ${q(v.target_dn)}
  enabled   = ${on(v.link_enabled)}
  enforced  = ${on(v.link_enforced)}
  order     = ${n(v.link_order, 1)}
}`;
  },
});

// --- Pre-staged computer accounts --------------------------------------------

const computerPrestage = scenario('ad', {
  id: 'windows_ad_computer_prestage',
  label: 'Pre-staged computer accounts in an OU, with a server group',
  description:
    'Creates computer accounts ahead of the build in the right OU, so the servers land there when they join, and optionally a group holding them all (for GPO filtering, delegation or firewall rules).',
  group: GROUP,
  inputs: [
    { id: 'container', label: 'OU', control: 'text', default: 'OU=Servers,OU=Example,DC=example,DC=com' },
    { id: 'computers', label: 'Computers', control: 'textarea', default: 'APP01=Application server\nAPP02=Application server\nSQL01=SQL Server', hint: 'NAME=description, one per line, 15 characters max' },
    {
      id: 'group_mode',
      label: 'Server group',
      control: 'select',
      options: [
        { value: 'new', label: 'Create a group holding them' },
        { value: 'none', label: 'No group' },
      ],
      default: 'new',
    },
    { id: 'group_name', label: 'Group name', control: 'text', default: 'GG-Servers-App', showWhen: { input: 'group_mode', equals: ['new'] } },
    { id: 'group_container', label: 'Group OU', control: 'text', default: 'OU=Groups,OU=Example,DC=example,DC=com', showWhen: { input: 'group_mode', equals: ['new'] } },
    { id: 'group_scope', label: 'Group scope', control: 'select', options: SCOPES, default: 'global', showWhen: { input: 'group_mode', equals: ['new'] } },
  ],
  emits: ['ad_computer', 'ad_group', 'ad_group_membership'],
  body: (v) => {
    const findings: Finding[] = [];
    const id = namer();
    const computers = pairs(v.computers).map(([name, description]) => {
      if (name.length > 15) findings.push(warning('windows.ad.computer-name-too-long', `${name} is longer than 15 characters; its NetBIOS name will be cut short.`));
      return { rid: id(name, 'computer'), name: name.toUpperCase(), description };
    });
    const blocks = computers.map(
      (c) => `resource "ad_computer" "${c.rid}" {
  name        = ${q(c.name)}
  container   = ${q(v.container)}
  description = ${q(c.description || 'Managed by Terraform')}
}`,
    );
    if (v.group_mode === 'new' && computers.length) {
      blocks.push(`resource "ad_group" "servers" {
  name             = ${q(v.group_name)}
  sam_account_name = ${q(v.group_name)}
  container        = ${q(v.group_container)}
  scope            = ${q(v.group_scope)}
  category         = "security"
}

resource "ad_group_membership" "servers" {
  group_id      = ad_group.servers.id
  group_members = [${computers.map((c) => `ad_computer.${c.rid}.id`).join(', ')}]
}`);
    }
    blocks.push(`output "computer_dns" {
  value = { ${computers.map((c) => `${q(c.name)} = ad_computer.${c.rid}.dn`).join(', ')} }
}`);
    return { hcl: blocks.join('\n\n'), findings };
  },
});

// --- DNS records (GSS-TSIG) --------------------------------------------------

const dnsRecords = scenario('dns', {
  id: 'windows_dns_records',
  label: 'Windows DNS records: A, CNAME, PTR, SRV, TXT, MX',
  description:
    'Writes records into an AD-integrated zone with secure dynamic updates signed with Kerberos (GSS-TSIG). A records can bring their PTR records with them, in the /24 reverse zone of each address. The zones must exist and allow secure updates.',
  group: GROUP,
  inputs: [
    { id: 'zone', label: 'Zone', control: 'text', default: 'example.com.', hint: 'trailing dot added if missing' },
    { id: 'ttl', label: 'TTL (seconds)', control: 'number', default: 3600, min: 0 },
    { id: 'a_records', label: 'A records', control: 'textarea', default: 'app01=10.10.20.21\nweb=10.10.20.30, 10.10.20.31', hint: 'name=IPv4[, IPv4]; @ = the zone itself' },
    { id: 'ptr_from_a', label: 'PTR records for the A records', control: 'toggle', default: true, hint: 'in <c>.<b>.<a>.in-addr.arpa.' },
    { id: 'cname_records', label: 'CNAME records', control: 'textarea', default: 'www=web', hint: 'alias=target; a bare target is in the zone' },
    { id: 'ptr_records', label: 'Other PTR records', control: 'textarea', default: '', placeholder: '10.10.30.5=legacy01.example.com.', hint: 'IPv4=FQDN' },
    { id: 'srv_records', label: 'SRV records', control: 'textarea', default: '_https._tcp=10 100 443 web.example.com.', hint: 'name=priority weight port target; repeat a name for more targets' },
    { id: 'txt_records', label: 'TXT records', control: 'textarea', default: '@=v=spf1 mx -all', hint: 'name=text; repeat a name for more strings' },
    { id: 'mx_records', label: 'MX records', control: 'textarea', default: '', placeholder: '@=10 mail.example.com.', hint: 'name=preference exchange' },
  ],
  emits: ['dns_a_record_set', 'dns_cname_record', 'dns_ptr_record', 'dns_srv_record_set', 'dns_txt_record_set', 'dns_mx_record_set'],
  body: (v) => {
    const findings: Finding[] = [];
    const zone = dotted(v.zone) || 'example.com.';
    const ttl = n(v.ttl, 3600);
    const id = namer();
    const fqdn = (t: string) => (t.endsWith('.') ? t : t.includes('.') ? `${t}.` : `${t}.${zone}`);
    const nameLine = (name: string, pad = '  ') => (name === '@' ? '' : `\n  name${pad}= ${q(name)}`);
    const grouped = (value: unknown) => {
      const map = new Map<string, string[]>();
      for (const [name, rest] of pairs(value)) map.set(name, [...(map.get(name) ?? []), rest]);
      return map;
    };
    const out: string[] = [];
    const ptrs = new Map<string, string>();

    for (const [name, rest] of pairs(v.a_records)) {
      const ips = items(rest).filter((ip) => {
        if (!isIpv4(ip)) findings.push(warning('windows.dns.bad-ipv4', `A record ${name}: ${ip} is not an IPv4 address and was left out.`));
        return isIpv4(ip);
      });
      if (!ips.length) continue;
      out.push(`resource "dns_a_record_set" "${id(name === '@' ? 'apex' : name)}" {
  zone      = ${q(zone)}${nameLine(name, '      ')}
  addresses = [${ips.map(q).join(', ')}]
  ttl       = ${ttl}
}`);
      if (on(v.ptr_from_a)) for (const ip of ips) if (!ptrs.has(ip)) ptrs.set(ip, name === '@' ? zone : `${name}.${zone}`);
    }
    for (const [ip, target] of pairs(v.ptr_records)) {
      if (!isIpv4(ip)) {
        findings.push(warning('windows.dns.bad-ipv4', `PTR record ${ip} is not an IPv4 address and was left out.`));
        continue;
      }
      ptrs.set(ip, fqdn(target));
    }
    for (const [ip, target] of ptrs) {
      const r = reverse(ip);
      out.push(`resource "dns_ptr_record" "${id(`ptr_${ip}`)}" {
  zone = ${q(r.zone)}
  name = ${q(r.name)}
  ptr  = ${q(target)}
  ttl  = ${ttl}
}`);
    }
    for (const [name, target] of pairs(v.cname_records)) {
      if (name === '@' || !target) {
        findings.push(warning('windows.dns.bad-cname', `CNAME ${name} needs a name other than the zone apex and a target; it was left out.`));
        continue;
      }
      out.push(`resource "dns_cname_record" "${id(name)}" {
  zone  = ${q(zone)}
  name  = ${q(name)}
  cname = ${q(fqdn(target))}
  ttl   = ${ttl}
}`);
    }
    for (const [name, entries] of grouped(v.srv_records)) {
      const srv = entries
        .map((e) => e.split(/\s+/))
        .filter((p) => p.length === 4 && p.slice(0, 3).every((x) => /^\d+$/.test(x)))
        .map(([priority, weight, port, target]) => `
  srv {
    priority = ${priority}
    weight   = ${weight}
    port     = ${port}
    target   = ${q(fqdn(String(target)))}
  }`);
      if (srv.length !== entries.length) findings.push(warning('windows.dns.bad-srv', `SRV ${name}: a line is not "priority weight port target" and was left out.`));
      if (!srv.length) continue;
      out.push(`resource "dns_srv_record_set" "${id(name)}" {
  zone = ${q(zone)}
  name = ${q(name)}
  ttl  = ${ttl}
${srv.join('\n')}
}`);
    }
    for (const [name, texts] of grouped(v.txt_records)) {
      out.push(`resource "dns_txt_record_set" "${id(name === '@' ? 'apex_txt' : `${name}_txt`)}" {
  zone  = ${q(zone)}${nameLine(name)}
  txt   = [${texts.map(q).join(', ')}]
  ttl   = ${ttl}
}`);
    }
    for (const [name, entries] of grouped(v.mx_records)) {
      const mx = entries
        .map((e) => e.split(/\s+/))
        .filter((p) => p.length === 2 && /^\d+$/.test(p[0] as string))
        .map(([pref, exchange]) => `
  mx {
    preference = ${pref}
    exchange   = ${q(fqdn(String(exchange)))}
  }`);
      if (!mx.length) continue;
      out.push(`resource "dns_mx_record_set" "${id(name === '@' ? 'apex_mx' : `${name}_mx`)}" {
  zone = ${q(zone)}${nameLine(name, ' ')}
  ttl  = ${ttl}
${mx.join('\n')}
}`);
    }
    if (!out.length) out.push('# No records given.');
    return { hcl: out.join('\n\n'), findings };
  },
});

// --- Roles and features ------------------------------------------------------

const FEATURES = [
  ['Web-Server', 'IIS web server'],
  ['RSAT-AD-Tools', 'AD DS and AD LDS tools'],
  ['RSAT-DNS-Server', 'DNS server tools'],
  ['AD-Domain-Services', 'AD Domain Services'],
  ['DNS', 'DNS Server'],
  ['DHCP', 'DHCP Server'],
  ['Failover-Clustering', 'Failover Clustering'],
  ['FS-FileServer', 'File Server'],
  ['FS-DFS-Namespace', 'DFS Namespaces'],
  ['FS-DFS-Replication', 'DFS Replication'],
  ['FS-Data-Deduplication', 'Data Deduplication'],
  ['Hyper-V', 'Hyper-V'],
  ['NET-Framework-45-Core', '.NET Framework 4.x'],
  ['NET-Framework-Core', '.NET Framework 3.5 (may need a source)'],
  ['Windows-Server-Backup', 'Windows Server Backup'],
  ['SNMP-Service', 'SNMP Service'],
  ['Telnet-Client', 'Telnet Client'],
  ['Containers', 'Containers'],
].map(([value, label]) => ({ value: value as string, label: `${label} (${value})` }));

const REMOVABLE = [
  ['FS-SMB1', 'SMB 1.0/CIFS'],
  ['PowerShell-v2', 'Windows PowerShell 2.0 engine'],
  ['Telnet-Client', 'Telnet Client'],
  ['XPS-Viewer', 'XPS Viewer'],
].map(([value, label]) => ({ value: value as string, label: `${label} (${value})` }));

const rolesFeatures = scenario('null', {
  id: 'windows_roles_features',
  label: 'Install Windows roles and features (WinRM)',
  description:
    'Installs the ticked roles and features on one or more servers with Install-WindowsFeature, removes the unwanted ones, and restarts only when Windows says it has to. Features already in the wanted state are left alone.',
  group: GROUP,
  inputs: [
    { id: 'hosts', label: 'Servers', control: 'textarea', default: 'srv01.example.com\nsrv02.example.com', hint: 'one per line' },
    { id: 'features', label: 'Install', control: 'checklist', options: FEATURES, default: 'FS-FileServer,RSAT-AD-Tools' },
    { id: 'extra_features', label: 'More features', control: 'text', default: '', placeholder: 'Web-Asp-Net45, Web-Mgmt-Console', hint: 'Get-WindowsFeature names, comma-separated' },
    { id: 'remove', label: 'Remove', control: 'checklist', options: REMOVABLE, default: 'FS-SMB1,PowerShell-v2' },
    { id: 'management_tools', label: 'Include management tools', control: 'toggle', default: true },
    { id: 'restart', label: 'Restart when needed', control: 'toggle', default: true, hint: 'in 30 s, after the script returns' },
    { id: 'source', label: 'Feature source', control: 'text', default: '', placeholder: 'D:\\sources\\sxs', hint: 'optional, for .NET 3.5 offline', section: 'Options' },
    ...winrmInputs({ id: 'winrm_user', default: 'EXAMPLE\\svc-terraform' }),
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const install = [...new Set([...items(v.features), ...items(v.extra_features)])];
    const remove = items(v.remove).filter((f) => !install.includes(f));
    const source = String(v.source ?? '').trim();
    const script = [
      'Import-Module ServerManager',
      '$restart = $false',
      '',
      `$wanted = ${psArray(install)}`,
      '$found = @(Get-WindowsFeature -Name $wanted)',
      '$unknown = @($wanted | Where-Object { $found.Name -notcontains $_ })',
      "if ($unknown.Count -gt 0) { throw \"Unknown feature name(s): $($unknown -join ', ')\" }",
      '$missing = @($found | Where-Object { -not $_.Installed } | ForEach-Object { $_.Name })',
      'if ($missing.Count -gt 0) {',
      `  $result = Install-WindowsFeature -Name $missing${on(v.management_tools) ? ' -IncludeManagementTools' : ''}${source ? ` -Source ${ps(source)}` : ''}`,
      "  if (-not $result.Success) { throw \"Install-WindowsFeature failed: $($missing -join ', ')\" }",
      "  if ($result.RestartNeeded -eq 'Yes') { $restart = $true }",
      "  Write-Output \"Installed: $($missing -join ', ')\"",
      '} else {',
      "  Write-Output 'Every requested feature is already installed.'",
      '}',
      ...(remove.length
        ? [
            '',
            `$present = @(Get-WindowsFeature -Name ${psArray(remove)} | Where-Object { $_.Installed } | ForEach-Object { $_.Name })`,
            'if ($present.Count -gt 0) {',
            '  $result = Uninstall-WindowsFeature -Name $present',
            "  if (-not $result.Success) { throw \"Uninstall-WindowsFeature failed: $($present -join ', ')\" }",
            "  if ($result.RestartNeeded -eq 'Yes') { $restart = $true }",
            "  Write-Output \"Removed: $($present -join ', ')\"",
            '}',
          ]
        : []),
      '',
      'if ($restart) {',
      ...(on(v.restart)
        ? ["  # Delayed, so this script returns and WinRM reports success before the reboot.", "  shutdown.exe /r /t 30 /c 'Terraform: restart after role and feature changes'", "  Write-Output 'Restart scheduled in 30 seconds.'"]
        : ["  Write-Warning 'A restart is needed to finish the feature changes.'"]),
      '}',
    ];
    return `locals {
  feature_hosts = toset([${lines(v.hosts).map(q).join(', ')}])
}

${psRun({
  name: 'windows_features',
  forEach: 'local.feature_hosts',
  connection: connection(v, 'each.key'),
  triggers: `{
    install          = [${install.map(q).join(', ')}]
    remove           = [${remove.map(q).join(', ')}]
    management_tools = ${on(v.management_tools)}
  }`,
  script,
})}

${WINRM_PASSWORD}`;
  },
});

// --- Domain join -------------------------------------------------------------

const WAIT_RUNNERS = [
  { value: 'powershell', label: 'Windows (PowerShell Start-Sleep)' },
  { value: 'sh', label: 'Linux or macOS (sleep)' },
  { value: 'none', label: 'Do not wait' },
];

function localSleep(runner: unknown, seconds: number): string {
  if (runner === 'none') return '';
  return runner === 'sh'
    ? `  # Give the restart time to start, so the check below does not reach the old session.
  provisioner "local-exec" {
    command = "sleep ${seconds}"
  }`
    : `  # Give the restart time to start, so the check below does not reach the old session.
  provisioner "local-exec" {
    command     = "Start-Sleep -Seconds ${seconds}"
    interpreter = ["PowerShell", "-NoProfile", "-Command"]
  }`;
}

const domainJoin = scenario('null', {
  id: 'windows_domain_join',
  label: 'Join a server to the domain (WinRM)',
  description:
    'Joins a server to Active Directory with Add-Computer — into a chosen OU, optionally renaming it in the same step — then restarts it, waits and checks the secure channel once it is back. Skips the join if the server is already a member.',
  group: GROUP,
  inputs: [
    { id: 'host', label: 'Server', control: 'text', default: '10.10.20.21', hint: 'IP or name reachable before the join' },
    { id: 'domain', label: 'Domain', control: 'text', default: 'example.com' },
    { id: 'ou_path', label: 'OU', control: 'text', default: 'OU=Servers,OU=Example,DC=example,DC=com', hint: 'blank = the default Computers container' },
    { id: 'join_user', label: 'Join account', control: 'text', default: 'svc-join@example.com', hint: 'needs rights to create/join computers in the OU' },
    { id: 'new_name', label: 'New computer name', control: 'text', default: '', placeholder: 'APP01', hint: 'optional, 15 characters max' },
    { id: 'dns_servers', label: 'Point DNS at', control: 'text', default: '', placeholder: '10.10.0.10, 10.10.0.11', hint: 'optional: the domain controllers, set before the join' },
    { id: 'restart', label: 'Restart after joining', control: 'toggle', default: true },
    { id: 'wait_runner', label: 'Terraform runs on', control: 'select', options: WAIT_RUNNERS, default: 'powershell', hint: 'how to wait for the restart', showWhen: { input: 'restart', equals: ['true'] } },
    { id: 'wait_seconds', label: 'Wait before checking (s)', control: 'number', default: 90, min: 0, section: 'Options', showWhen: { input: 'restart', equals: ['true'] } },
    ...winrmInputs({ id: 'winrm_user', default: 'Administrator', hint: 'a local administrator — the server is not in the domain yet' }),
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings: Finding[] = [];
    const domain = String(v.domain ?? '').trim();
    const newName = String(v.new_name ?? '').trim();
    const ou = String(v.ou_path ?? '').trim();
    const dns = items(v.dns_servers);
    if (newName.length > 15) findings.push(warning('windows.join.name-too-long', `${newName} is longer than 15 characters; Windows will refuse it.`));
    const script = [
      `$domain = ${ps(domain)}`,
      '$cs = Get-CimInstance Win32_ComputerSystem',
      'if ($cs.PartOfDomain -and $cs.Domain -eq $domain) {',
      '  Write-Output "$env:COMPUTERNAME is already a member of $domain."',
      '  exit 0',
      '}',
      ...(dns.length
        ? [
            '',
            '$nic = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq \'Up\' } | Select-Object -First 1',
            `Set-DnsClientServerAddress -InterfaceIndex $nic.InterfaceIndex -ServerAddresses ${psArray(dns)}`,
          ]
        : []),
      '',
      '# The password comes from a sensitive variable and only ever exists here as a',
      '# SecureString inside a PSCredential — it is never passed on a command line.',
      `$secure = ConvertTo-SecureString ${psSecret('var.domain_join_password')} -AsPlainText -Force`,
      `$credential = New-Object System.Management.Automation.PSCredential (${ps(v.join_user)}, $secure)`,
      '$join = @{ DomainName = $domain; Credential = $credential; Force = $true }',
      ...(ou ? [`$join.OUPath = ${ps(ou)}`] : []),
      ...(newName ? [`if ($env:COMPUTERNAME -ne ${ps(newName)}) { $join.NewName = ${ps(newName)} }`] : []),
      'Add-Computer @join',
      ...(on(v.restart)
        ? ['Write-Output "Joined $domain; restarting in 15 seconds."', "shutdown.exe /r /t 15 /c 'Terraform: domain join'"]
        : ['Write-Warning "Joined $domain; restart the server to finish."']),
    ];
    const join = psRun({
      name: 'domain_join',
      connection: connection(v, q(v.host)),
      triggers: `[${q(domain)}, ${q(ou)}, ${q(newName)}]`,
      script,
    });
    const verify = on(v.restart)
      ? `

# Reconnects after the restart (the connect timeout covers the reboot) and
# fails the apply if the server did not come back as a working member.
${psRun({
  name: 'domain_join_check',
  connection: connection(v, q(v.host), 'winrm_user', '20m'),
  triggers: 'terraform_data.domain_join.id',
  before: localSleep(v.wait_runner, n(v.wait_seconds, 90)),
  script: [
    '$cs = Get-CimInstance Win32_ComputerSystem',
    `if (-not $cs.PartOfDomain -or $cs.Domain -ne ${ps(domain)}) { throw "$env:COMPUTERNAME is not a member of ${hcl(domain.replace(/"/g, ''))} yet." }`,
    'if (-not (Test-ComputerSecureChannel)) { throw "The secure channel to $($cs.Domain) is broken." }',
    '$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime',
    'Write-Output "$env:COMPUTERNAME is a member of $($cs.Domain), up since $boot."',
  ],
})}`
      : '';
    return {
      hcl: `${join}${verify}

${WINRM_PASSWORD}

${sensitiveVariable('domain_join_password', 'Password for the domain join account')}`,
      findings,
    };
  },
});

// --- IIS site ----------------------------------------------------------------

const iisSite = scenario('null', {
  id: 'windows_iis_site',
  label: 'IIS website with its app pool, bindings and certificate (WinRM)',
  description:
    'Installs IIS, creates an application pool (.NET CLR version, pipeline, identity) and a website with HTTP and/or HTTPS bindings on a host header, binds a self-signed or existing certificate, and opens the firewall. Safe to re-run: existing pieces are updated, not duplicated.',
  group: GROUP,
  inputs: [
    { id: 'host', label: 'Server', control: 'text', default: 'web01.example.com' },
    { id: 'site_name', label: 'Site name', control: 'text', default: 'intranet' },
    { id: 'host_header', label: 'Host name', control: 'text', default: 'intranet.example.com', hint: 'blank = all names (no SNI)' },
    { id: 'physical_path', label: 'Content folder', control: 'text', default: 'C:\\inetpub\\intranet' },
    { id: 'app_pool', label: 'Application pool', control: 'text', default: 'intranet' },
    {
      id: 'clr',
      label: '.NET CLR version',
      control: 'select',
      options: [
        { value: 'v4.0', label: '.NET CLR v4.0 (ASP.NET 4.x)' },
        { value: 'none', label: 'No managed code (ASP.NET Core, static)' },
      ],
      default: 'v4.0',
    },
    { id: 'pipeline', label: 'Managed pipeline', control: 'select', options: opts(['Integrated', 'Classic']), default: 'Integrated' },
    { id: 'identity', label: 'Pool identity', control: 'select', options: opts(['ApplicationPoolIdentity', 'NetworkService', 'LocalService']), default: 'ApplicationPoolIdentity' },
    {
      id: 'bindings',
      label: 'Bindings',
      control: 'select',
      options: [
        { value: 'both', label: 'HTTP and HTTPS' },
        { value: 'https', label: 'HTTPS only' },
        { value: 'http', label: 'HTTP only' },
      ],
      default: 'both',
    },
    {
      id: 'certificate',
      label: 'Certificate',
      control: 'select',
      options: [
        { value: 'self_signed', label: 'Self-signed, made on the server' },
        { value: 'existing', label: 'Already in LocalMachine\\My' },
      ],
      default: 'self_signed',
      showWhen: { input: 'bindings', equals: ['both', 'https'] },
    },
    { id: 'thumbprint', label: 'Certificate thumbprint', control: 'text', default: '', placeholder: '3F2A…', showWhen: { input: 'certificate', equals: ['existing'] } },
    { id: 'http_port', label: 'HTTP port', control: 'number', default: 80, min: 1, max: 65535, section: 'Options' },
    { id: 'https_port', label: 'HTTPS port', control: 'number', default: 443, min: 1, max: 65535, section: 'Options' },
    { id: 'stop_default_site', label: 'Stop the Default Web Site', control: 'toggle', default: true, section: 'Options' },
    { id: 'firewall', label: 'Open the firewall', control: 'toggle', default: true },
    {
      id: 'firewall_profile',
      label: 'Firewall profiles',
      control: 'select',
      options: [
        { value: 'Domain', label: 'Domain' },
        { value: 'Domain,Private', label: 'Domain and private' },
        { value: 'Any', label: 'Any' },
      ],
      default: 'Domain',
      showWhen: { input: 'firewall', equals: ['true'] },
    },
    ...winrmInputs({ id: 'winrm_user', default: 'EXAMPLE\\svc-terraform' }),
  ],
  emits: ['terraform_data'],
  body: (v) => {
    const findings: Finding[] = [];
    const http = v.bindings !== 'https';
    const https = v.bindings !== 'http';
    const hostHeader = String(v.host_header ?? '').trim();
    const httpPort = n(v.http_port, 80);
    const httpsPort = n(v.https_port, 443);
    const clr = v.clr === 'none' ? '' : 'v4.0';
    const sni = hostHeader ? 1 : 0;
    const thumb = String(v.thumbprint ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (https && v.certificate === 'existing' && !thumb) {
      findings.push(warning('windows.iis.no-thumbprint', 'HTTPS with an existing certificate needs its thumbprint.'));
    }
    const features = ['Web-Server', 'Web-Mgmt-Console', ...(clr ? ['Web-Asp-Net45'] : [])];
    const ports = [...(http ? [httpPort] : []), ...(https ? [httpsPort] : [])];
    const script = [
      `$features = ${psArray(features)}`,
      '$missing = @(Get-WindowsFeature -Name $features | Where-Object { -not $_.Installed } | ForEach-Object { $_.Name })',
      'if ($missing.Count -gt 0) { Install-WindowsFeature -Name $missing | Out-Null }',
      'Import-Module WebAdministration',
      '',
      `$site = ${ps(v.site_name)}`,
      `$pool = ${ps(v.app_pool)}`,
      `$path = ${ps(v.physical_path)}`,
      `$hostHeader = ${ps(hostHeader)}`,
      '',
      'New-Item -ItemType Directory -Path $path -Force | Out-Null',
      "if (-not (Get-ChildItem -Path $path)) { Set-Content -Path (Join-Path $path 'index.html') -Value \"<h1>$site</h1>\" }",
      '',
      '$poolPath = "IIS:\\AppPools\\$pool"',
      'if (-not (Test-Path $poolPath)) { New-WebAppPool -Name $pool | Out-Null }',
      `Set-ItemProperty $poolPath -Name managedRuntimeVersion -Value ${ps(clr)}`,
      `Set-ItemProperty $poolPath -Name managedPipelineMode -Value ${ps(v.pipeline)}`,
      `Set-ItemProperty $poolPath -Name processModel.identityType -Value ${ps(v.identity)}`,
      ...(on(v.stop_default_site)
        ? [
            '',
            "if (Test-Path 'IIS:\\Sites\\Default Web Site') {",
            "  Set-ItemProperty 'IIS:\\Sites\\Default Web Site' -Name serverAutoStart -Value $false",
            "  if ((Get-WebsiteState -Name 'Default Web Site').Value -ne 'Stopped') { Stop-Website -Name 'Default Web Site' }",
            '}',
          ]
        : []),
      '',
      'if (-not (Test-Path "IIS:\\Sites\\$site")) {',
      http
        ? `  New-Website -Name $site -PhysicalPath $path -ApplicationPool $pool -Port ${httpPort} -HostHeader $hostHeader | Out-Null`
        : `  New-Website -Name $site -PhysicalPath $path -ApplicationPool $pool -Ssl -Port ${httpsPort} -HostHeader $hostHeader -SslFlags ${sni} | Out-Null`,
      '} else {',
      '  Set-ItemProperty "IIS:\\Sites\\$site" -Name physicalPath -Value $path',
      '  Set-ItemProperty "IIS:\\Sites\\$site" -Name applicationPool -Value $pool',
      '}',
      ...(http
        ? [`if (-not (Get-WebBinding -Name $site -Protocol http -Port ${httpPort} -HostHeader $hostHeader)) { New-WebBinding -Name $site -Protocol http -Port ${httpPort} -HostHeader $hostHeader }`]
        : []),
      ...(https
        ? [
            `if (-not (Get-WebBinding -Name $site -Protocol https -Port ${httpsPort} -HostHeader $hostHeader)) { New-WebBinding -Name $site -Protocol https -Port ${httpsPort} -HostHeader $hostHeader -SslFlags ${sni} }`,
            '',
            ...(v.certificate === 'existing'
              ? [`$thumbprint = ${ps(thumb)}`, "if (-not (Test-Path \"Cert:\\LocalMachine\\My\\$thumbprint\")) { throw \"Certificate $thumbprint is not in LocalMachine\\My.\" }"]
              : [
                  `$certName = ${hostHeader ? '$hostHeader' : '([System.Net.Dns]::GetHostEntry($env:COMPUTERNAME).HostName)'}`,
                  "$cert = Get-ChildItem -Path 'Cert:\\LocalMachine\\My' | Where-Object { $_.Subject -eq \"CN=$certName\" -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Sort-Object NotAfter -Descending | Select-Object -First 1",
                  "if (-not $cert) { $cert = New-SelfSignedCertificate -DnsName $certName -CertStoreLocation 'Cert:\\LocalMachine\\My' -NotAfter (Get-Date).AddYears(2) }",
                  '$thumbprint = $cert.Thumbprint',
                ]),
            `$binding = Get-WebBinding -Name $site -Protocol https -Port ${httpsPort} -HostHeader $hostHeader`,
            'if ($binding.certificateHash -ne $thumbprint) {',
            '  if ($binding.certificateHash) { $binding.RemoveSslCertificate() }',
            "  $binding.AddSslCertificate($thumbprint, 'My')",
            '}',
          ]
        : []),
      "if ((Get-WebsiteState -Name $site).Value -ne 'Started') { Start-Website -Name $site }",
      ...(on(v.firewall)
        ? [
            '',
            `$rule = ${ps(`IIS-${v.site_name}`)}`,
            'Remove-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue',
            `New-NetFirewallRule -Name $rule -DisplayName "IIS $site (TCP ${ports.join(', ')})" -Direction Inbound -Protocol TCP -LocalPort ${ports.join(', ')} -Action Allow -Profile ${String(v.firewall_profile ?? 'Domain')} | Out-Null`,
          ]
        : []),
      "Write-Output \"Site $site is $((Get-WebsiteState -Name $site).Value).\"",
    ];
    return {
      hcl: `${psRun({
        name: 'iis_site',
        connection: connection(v, q(v.host)),
        triggers: `sha256(jsonencode(${JSON.stringify(
          [v.site_name, hostHeader, v.physical_path, v.app_pool, clr, v.pipeline, v.identity, v.bindings, v.certificate, thumb, httpPort, httpsPort, on(v.firewall), v.firewall_profile].map((x) => String(x ?? '')),
        ).replace(/\$\{/g, '$${').replace(/%\{/g, '%%{')}))`,
        script,
      })}

output "site_url" {
  value = ${q(`${https ? 'https' : 'http'}://${hostHeader || String(v.host ?? '')}${https ? (httpsPort === 443 ? '' : `:${httpsPort}`) : httpPort === 80 ? '' : `:${httpPort}`}/`)}
}

${WINRM_PASSWORD}`,
      findings,
    };
  },
});

// --- Local accounts (LAPS-lite) ----------------------------------------------

const localAccounts = scenario('random', {
  id: 'windows_local_accounts',
  label: 'Local Administrator password and local users per server (WinRM)',
  description:
    'Gives every server its own random local Administrator password (found by its -500 SID, so a renamed account works) and creates local users in local groups, each with a random password. The passwords are a sensitive output; change the rotation marker to rotate them all.',
  group: GROUP,
  inputs: [
    { id: 'hosts', label: 'Servers', control: 'textarea', default: 'srv01.example.com\nsrv02.example.com', hint: 'one per line' },
    { id: 'password_length', label: 'Password length', control: 'number', default: 24, min: 14, max: 128 },
    { id: 'rotation', label: 'Rotation marker', control: 'text', default: '2026-09', hint: 'change it to rotate every password' },
    {
      id: 'local_users',
      label: 'Local users',
      control: 'textarea',
      default: 'svc-backup=Backup Operators\nsvc-monitor=Performance Monitor Users; Event Log Readers',
      hint: 'name=group; group — blank for none',
    },
    ...winrmInputs({ id: 'winrm_user', default: 'EXAMPLE\\svc-terraform', hint: 'not the local Administrator whose password this changes' }),
  ],
  emits: ['random_password', 'terraform_data'],
  body: (v) => {
    const users = pairs(v.local_users).map(([name, groups]) => ({ name, groups: groups.split(';').map((g) => g.trim()).filter(Boolean) }));
    const passwordBlock = (name: string, forEach: string) => `resource "random_password" "${name}" {
  for_each = ${forEach}

  length           = ${n(v.password_length, 24)}
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
  min_special      = 1
  override_special = "!#%*-_=+?"

  keepers = {
    rotation = ${q(v.rotation)}
  }
}`;
    const script = [
      '# Passwords are interpolated from random_password and turned straight into',
      '# SecureStrings; none is passed on a command line.',
      "$admin = Get-LocalUser | Where-Object { $_.SID.Value -like 'S-1-5-21-*-500' }",
      `Set-LocalUser -InputObject $admin -Password (ConvertTo-SecureString ${psSecret('random_password.admin[each.key].result')} -AsPlainText -Force)`,
      'Write-Output "Password set for $($admin.Name)."',
      ...(users.length
        ? [
            '',
            'function Set-TerraformLocalUser([string]$Name, [securestring]$Secret, [string[]]$Groups) {',
            '  if (Get-LocalUser -Name $Name -ErrorAction SilentlyContinue) {',
            '    Set-LocalUser -Name $Name -Password $Secret -PasswordNeverExpires $true',
            '  } else {',
            "    New-LocalUser -Name $Name -Password $Secret -PasswordNeverExpires -AccountNeverExpires -Description 'Managed by Terraform' | Out-Null",
            '  }',
            '  foreach ($group in $Groups) {',
            '    $sid = (Get-LocalUser -Name $Name).SID.Value',
            '    if (-not (Get-LocalGroupMember -Group $group | Where-Object { $_.SID.Value -eq $sid })) { Add-LocalGroupMember -Group $group -Member $Name }',
            '  }',
            '  Write-Output "Local user $Name is in: $($Groups -join \', \')"',
            '}',
            ...users.map(
              (u) =>
                `Set-TerraformLocalUser -Name ${ps(u.name)} -Secret (ConvertTo-SecureString ${psSecret(`random_password.local_user["\${each.key}/${hcl(u.name)}"].result`)} -AsPlainText -Force) -Groups ${psArray(u.groups)}`,
            ),
          ]
        : []),
    ];
    return `locals {
  account_hosts = toset([${lines(v.hosts).map(q).join(', ')}])
  local_users   = toset([${users.map((u) => q(u.name)).join(', ')}])
  host_users = {
    for pair in setproduct(local.account_hosts, local.local_users) : "\${pair[0]}/\${pair[1]}" => pair
  }
}

${passwordBlock('admin', 'local.account_hosts')}

${passwordBlock('local_user', 'local.host_users')}

${psRun({
  name: 'local_accounts',
  forEach: 'local.account_hosts',
  connection: connection(v, 'each.key'),
  triggers: `sha256(join(",", concat([random_password.admin[each.key].result], [for k, p in random_password.local_user : p.result if startswith(k, "\${each.key}/")])))`,
  script,
})}

output "local_admin_passwords" {
  description = "Local Administrator password per server"
  value       = { for host, p in random_password.admin : host => p.result }
  sensitive   = true
}

output "local_user_passwords" {
  description = "Password per server/user"
  value       = { for key, p in random_password.local_user : key => p.result }
  sensitive   = true
}

${WINRM_PASSWORD}`;
  },
});

// --- Ansible over WinRM ------------------------------------------------------

const ansibleWinrm = scenario('ansible', {
  id: 'windows_ansible_winrm',
  label: 'Run an Ansible playbook against Windows hosts (WinRM)',
  description:
    'Puts Windows hosts in an Ansible inventory group with the WinRM connection variables (HTTPS, NTLM, Kerberos or CredSSP) and runs a playbook against each. The password is a sensitive variable; the inventory is also readable by the cloud.terraform inventory plugin.',
  group: GROUP,
  inputs: [
    { id: 'group_name', label: 'Inventory group', control: 'text', default: 'windows' },
    { id: 'hosts', label: 'Hosts', control: 'textarea', default: 'srv01.example.com=10.10.20.21\nsrv02.example.com', hint: 'name[=address], one per line' },
    { id: 'ansible_user', label: 'User', control: 'text', default: 'svc-ansible@EXAMPLE.COM', hint: 'Kerberos: user@REALM in capitals' },
    {
      id: 'transport',
      label: 'WinRM transport',
      control: 'select',
      options: [
        { value: 'ntlm', label: 'NTLM' },
        { value: 'kerberos', label: 'Kerberos (needs pywinrm[kerberos])' },
        { value: 'credssp', label: 'CredSSP (needs pywinrm[credssp])' },
      ],
      default: 'ntlm',
    },
    { id: 'validate_cert', label: 'Validate the WinRM certificate', control: 'toggle', default: true },
    { id: 'port', label: 'WinRM port', control: 'number', default: 5986, min: 1, max: 65535, section: 'Options' },
    { id: 'run_playbook', label: 'Run a playbook from Terraform', control: 'toggle', default: true },
    { id: 'playbook', label: 'Playbook', control: 'text', default: 'playbooks/windows-baseline.yml', showWhen: { input: 'run_playbook', equals: ['true'] } },
    { id: 'tags', label: 'Tags', control: 'text', default: '', placeholder: 'baseline, patching', showWhen: { input: 'run_playbook', equals: ['true'] } },
    { id: 'extra_vars', label: 'Extra variables', control: 'textarea', default: 'timezone=Eastern Standard Time', hint: 'name=value, one per line', showWhen: { input: 'run_playbook', equals: ['true'] } },
    { id: 'check_mode', label: 'Check mode (dry run)', control: 'toggle', default: false, showWhen: { input: 'run_playbook', equals: ['true'] } },
    { id: 'diff_mode', label: 'Show diffs', control: 'toggle', default: false, showWhen: { input: 'run_playbook', equals: ['true'] } },
    { id: 'replayable', label: 'Run on every apply', control: 'toggle', default: true, showWhen: { input: 'run_playbook', equals: ['true'] } },
    { id: 'verbosity', label: 'Verbosity', control: 'number', default: 0, min: 0, max: 6, section: 'Options' },
  ],
  emits: ['ansible_group', 'ansible_host', 'ansible_playbook'],
  body: (v) => {
    const hosts = pairs(v.hosts).map(([name, address]) => [name, address || name] as const);
    const group = ident(v.group_name, 'windows');
    const extra = pairs(v.extra_vars);
    const tags = items(v.tags);
    const playbook = on(v.run_playbook)
      ? `

# ansible_playbook builds its own one-host inventory, so the connection
# variables travel as extra vars. They reach ansible-playbook as -e arguments
# on the Terraform runner; use Kerberos or a vault file where that matters.
resource "ansible_playbook" "run" {
  for_each = local.ansible_hosts

  name       = each.key
  playbook   = ${q(v.playbook)}
  groups     = [ansible_group.${group}.name]
  replayable = ${on(v.replayable)}
  check_mode = ${on(v.check_mode)}
  diff_mode  = ${on(v.diff_mode)}
  verbosity  = ${n(v.verbosity, 0)}${tags.length ? `
  tags       = [${tags.map(q).join(', ')}]` : ''}

  extra_vars = merge(local.winrm_vars, {
    ansible_host = each.value${extra.map(([k, x]) => `\n    ${ident(k, 'var')} = ${q(x)}`).join('')}
  })
}`
      : '';
    return `locals {
  ansible_hosts = {
${hosts.map(([name, address]) => `    ${q(name)} = ${q(address)}`).join('\n')}
  }

  winrm_vars = {
    ansible_connection                   = "winrm"
    ansible_winrm_transport              = ${q(v.transport)}
    ansible_winrm_scheme                 = "https"
    ansible_port                         = ${q(String(n(v.port, 5986)))}
    ansible_winrm_server_cert_validation = ${q(on(v.validate_cert) ? 'validate' : 'ignore')}
    ansible_user                         = ${q(v.ansible_user)}
    ansible_password                     = var.ansible_password
  }
}

resource "ansible_group" "${group}" {
  name      = ${q(v.group_name)}
  variables = local.winrm_vars
}

resource "ansible_host" "host" {
  for_each = local.ansible_hosts

  name   = each.key
  groups = [ansible_group.${group}.name]
  variables = {
    ansible_host = each.value
  }
}${playbook}

${sensitiveVariable('ansible_password', 'Password for the Ansible WinRM user')}`;
  },
});

// --- New server onboarding: AD + DNS -----------------------------------------

const serverOnboarding = scenario('ad', {
  id: 'windows_server_onboarding',
  label: 'New server onboarding: computer account plus A and PTR records',
  description:
    'Prepares a new server before it is built: its computer account pre-staged in the right OU, and its A record and PTR record written into AD-integrated DNS with Kerberos, so it resolves both ways from the first boot.',
  group: GROUP,
  alsoUses: ['dns'],
  inputs: [
    { id: 'hostname', label: 'Computer name', control: 'text', default: 'APP01', hint: '15 characters max' },
    { id: 'ip', label: 'IPv4 address', control: 'text', default: '10.10.20.21' },
    { id: 'description', label: 'Description', control: 'text', default: 'Application server' },
    { id: 'container', label: 'OU', control: 'text', default: 'OU=Servers,OU=Example,DC=example,DC=com' },
    { id: 'zone', label: 'DNS zone', control: 'text', default: 'example.com.' },
    { id: 'ttl', label: 'TTL (seconds)', control: 'number', default: 3600, min: 0 },
    { id: 'create_ptr', label: 'PTR record', control: 'toggle', default: true, hint: 'in the /24 reverse zone' },
  ],
  emits: ['ad_computer', 'dns_a_record_set', 'dns_ptr_record'],
  body: (v) => {
    const findings: Finding[] = [];
    const name = String(v.hostname ?? '').trim();
    const ip = String(v.ip ?? '').trim();
    const zone = dotted(v.zone) || 'example.com.';
    const ttl = n(v.ttl, 3600);
    if (name.length > 15) findings.push(warning('windows.ad.computer-name-too-long', `${name} is longer than 15 characters.`));
    if (!isIpv4(ip)) findings.push(warning('windows.dns.bad-ipv4', `${ip} is not an IPv4 address.`));
    const r = isIpv4(ip) ? reverse(ip) : { zone: 'in-addr.arpa.', name: '' };
    const ptr = on(v.create_ptr)
      ? `

resource "dns_ptr_record" "server" {
  zone = ${q(r.zone)}
  name = ${q(r.name)}
  ptr  = "\${dns_a_record_set.server.name}.${hcl(zone)}"
  ttl  = ${ttl}
}`
      : '';
    return {
      hcl: `resource "ad_computer" "server" {
  name        = ${q(name.toUpperCase())}
  container   = ${q(v.container)}
  description = ${q(v.description)}
}

resource "dns_a_record_set" "server" {
  zone      = ${q(zone)}
  name      = ${q(name.toLowerCase())}
  addresses = [${q(ip)}]
  ttl       = ${ttl}
}${ptr}

output "fqdn" {
  value = "\${dns_a_record_set.server.name}.${hcl(zone.replace(/\.$/, ''))}"
}

output "computer_dn" {
  value = ad_computer.server.dn
}`,
      findings,
    };
  },
});

// --- Service certificate (tls + local) ---------------------------------------

const serviceCertificate = scenario('tls', {
  id: 'windows_service_certificate',
  label: 'Certificate for an internal service: key, CSR for AD CS or a signed certificate',
  description:
    'Generates a private key and either a CSR to submit to an AD CS template with certreq, a self-signed certificate, or a certificate signed by a small internal CA made here. Writes PEM files ready to combine into a PFX for IIS or any Windows service.',
  group: GROUP,
  alsoUses: ['local'],
  inputs: [
    { id: 'common_name', label: 'Common name', control: 'text', default: 'intranet.example.com' },
    { id: 'dns_names', label: 'DNS names (SAN)', control: 'textarea', default: 'intranet.example.com\nintranet', hint: 'one per line' },
    { id: 'ip_addresses', label: 'IP addresses (SAN)', control: 'text', default: '', placeholder: '10.10.20.30', hint: 'comma-separated, optional' },
    { id: 'organization', label: 'Organization', control: 'text', default: 'Example Corp' },
    {
      id: 'mode',
      label: 'Certificate',
      control: 'select',
      options: [
        { value: 'csr', label: 'CSR for AD CS (certreq)' },
        { value: 'self_signed', label: 'Self-signed' },
        { value: 'internal_ca', label: 'Signed by an internal CA created here' },
      ],
      default: 'csr',
    },
    { id: 'template', label: 'AD CS template', control: 'text', default: 'WebServer', showWhen: { input: 'mode', equals: ['csr'] } },
    { id: 'algorithm', label: 'Key algorithm', control: 'select', options: opts(['RSA', 'ECDSA']), default: 'RSA' },
    { id: 'rsa_bits', label: 'RSA key size', control: 'select', options: opts(['2048', '3072', '4096']), default: '3072', showWhen: { input: 'algorithm', equals: ['RSA'] } },
    { id: 'ecdsa_curve', label: 'ECDSA curve', control: 'select', options: opts(['P256', 'P384']), default: 'P256', showWhen: { input: 'algorithm', equals: ['ECDSA'] } },
    { id: 'validity_days', label: 'Valid for (days)', control: 'number', default: 397, min: 1, showWhen: { input: 'mode', equals: ['self_signed', 'internal_ca'] } },
    { id: 'output_dir', label: 'Write files to', control: 'text', default: 'certs', hint: 'relative to the configuration' },
  ],
  emits: ['tls_private_key', 'tls_cert_request', 'tls_self_signed_cert', 'tls_locally_signed_cert', 'local_file', 'local_sensitive_file'],
  body: (v) => {
    const rsa = v.algorithm !== 'ECDSA';
    const key = (name: string) => `resource "tls_private_key" "${name}" {
  algorithm${rsa ? '' : '  '} = ${q(rsa ? 'RSA' : 'ECDSA')}${rsa ? `
  rsa_bits  = ${n(v.rsa_bits, 3072)}` : `
  ecdsa_curve = ${q(v.ecdsa_curve)}`}
}`;
    const dir = String(v.output_dir ?? '').trim().replace(/[\\/]+$/, '') || 'certs';
    const file = (f: string) => `"\${path.module}/${hcl(dir)}/${f}"`;
    const hours = n(v.validity_days, 397) * 24;
    const cn = String(v.common_name ?? '').trim();
    const subject = `  subject {
    common_name  = ${q(cn)}
    organization = ${q(v.organization)}
  }`;
    const sans = `  dns_names    = [${lines(v.dns_names).map(q).join(', ')}]
  ip_addresses = [${items(v.ip_addresses).map(q).join(', ')}]`;
    const serverUses = `  allowed_uses = ["digital_signature", "key_encipherment", "server_auth"]`;
    const out = [
      key('service'),
      `resource "local_sensitive_file" "key" {
  content         = tls_private_key.service.private_key_pem
  filename        = ${file('service.key.pem')}
  file_permission = "0600"
}`,
    ];
    const pfx = `openssl pkcs12 -export -in ${dir}/service.crt.pem -inkey ${dir}/service.key.pem -out ${dir}/service.pfx`;
    if (v.mode === 'csr') {
      out.push(`resource "tls_cert_request" "service" {
  private_key_pem = tls_private_key.service.private_key_pem

${subject}

${sans}
}

resource "local_file" "csr" {
  content  = tls_cert_request.service.cert_request_pem
  filename = ${file('service.csr')}
}

output "next_steps" {
  value = [
    ${q(`certreq -submit -attrib CertificateTemplate:${String(v.template ?? 'WebServer').trim()} ${dir}/service.csr ${dir}/service.crt.pem`)},
    ${q(pfx)},
  ]
}`);
    } else if (v.mode === 'self_signed') {
      out.push(`resource "tls_self_signed_cert" "service" {
  private_key_pem       = tls_private_key.service.private_key_pem
  validity_period_hours = ${hours}
${serverUses}

${subject}

${sans}
}

resource "local_file" "certificate" {
  content  = tls_self_signed_cert.service.cert_pem
  filename = ${file('service.crt.pem')}
}

output "pfx_command" {
  value = ${q(pfx)}
}`);
    } else {
      out.push(`${key('ca')}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = ${Math.max(hours * 5, 43800)}
  allowed_uses          = ["cert_signing", "crl_signing", "digital_signature"]

  subject {
    common_name  = ${q(`${String(v.organization ?? 'Example').trim()} Internal CA`)}
    organization = ${q(v.organization)}
  }
}

resource "tls_cert_request" "service" {
  private_key_pem = tls_private_key.service.private_key_pem

${subject}

${sans}
}

resource "tls_locally_signed_cert" "service" {
  cert_request_pem      = tls_cert_request.service.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = ${hours}
${serverUses}
}

resource "local_sensitive_file" "ca_key" {
  content         = tls_private_key.ca.private_key_pem
  filename        = ${file('ca.key.pem')}
  file_permission = "0600"
}

resource "local_file" "ca" {
  content  = tls_self_signed_cert.ca.cert_pem
  filename = ${file('ca.crt.pem')}
}

resource "local_file" "certificate" {
  content  = "\${tls_locally_signed_cert.service.cert_pem}\${tls_self_signed_cert.ca.cert_pem}"
  filename = ${file('service.crt.pem')}
}

output "next_steps" {
  value = [
    "Import ${hcl(dir)}/ca.crt.pem into Trusted Root Certification Authorities (by GPO for the domain).",
    ${q(pfx)},
  ]
}`);
    }
    return out.join('\n\n');
  },
});

export const WINDOWS_SCENARIOS: readonly Blueprint[] = [
  winrmExec,
  adStructure,
  gpoPolicy,
  computerPrestage,
  serverOnboarding,
  dnsRecords,
  rolesFeatures,
  domainJoin,
  iisSite,
  localAccounts,
  ansibleWinrm,
  serviceCertificate,
];

/**
 * Splunk management: who can log in, what they can see, how the wire is
 * protected, how the machine's CPU is shared, and the day-2 chores done through
 * REST instead of by hand in the UI.
 *
 * These are the settings that fail open. An LDAP bind in clear text works. A
 * role that can read every index works. A forwarder that accepts any
 * certificate works. Workload management with no ingest share works — until a
 * heavy search starves the pipeline. Nothing errors; the problem is found in an
 * audit, or an incident.
 *
 * No generated file holds a credential. Bind passwords, certificate
 * passphrases and tokens are read by the scripts from mode-600 files and sent
 * on stdin or from a private header file — never on a command line, where
 * every user on the host can read them from the process list.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, listOf, splunkName, spreadCron,                } from '../splunk.js';

const TIER = 'management'         ;

// --- helpers ---------------------------------------------------------------

/**
 * A shell script as a template, with bash's own `${...}` written `\${...}`.
 *
 * String.raw keeps backslashes as they are, so `\n` in a printf stays `\n`;
 * the one thing it cannot leave alone is `${`, which is interpolation. Writing
 * it escaped and un-escaping it here keeps both languages readable.
 */
function script(strings                      , ...values           )           {
  return String.raw(strings, ...values)
    .replace(/\\\$\{/g, '${')
    .replace(/^\n/, '')
    .split('\n');
}

/** A value safe inside bash single quotes. */
function shq(value        )         {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A value safe inside PowerShell single quotes. */
function psq(value        )         {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Lines of a textarea, with comments and blanks dropped. */
function rows(value        )           {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** The shared bash prelude: private files, a private work dir, and one curl. */
function bashPrelude()           {
  return script`
die() { printf 'error: %s\n' "$*" >&2; exit 2; }
note() { printf '%s\n' "$*" >&2; }

# A secret file must be readable by its owner only. Anything looser and this
# script refuses, because the secret has already leaked to whoever else can read it.
check_private() {
  local f=$1 mode
  [ -f "$f" ] || die "not found: $f"
  mode=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
  case "$mode" in
    600|400) ;;
    *) die "$f is mode $mode. Run: chmod 600 $f  (refusing to use a secret other users can read)" ;;
  esac
}

command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CURL_TLS=()
[ -n "$CA_FILE" ] && CURL_TLS=(--cacert "$CA_FILE")

# The Authorization header goes in a private file and reaches curl through -H @file,
# so the token is never an argument and never shows up in ps or shell history.
load_token() {
  check_private "$TOKEN_FILE"
  local t=""
  IFS= read -r t < "$TOKEN_FILE" || true
  t=\${t%$'\r'}
  [ -n "$t" ] || die "$TOKEN_FILE is empty"
  printf 'Authorization: Bearer %s\n' "$t" > "$WORK/auth.h"
}

# api METHOD PATH [curl args...]  - prints the JSON body, fails on HTTP errors.
api() {
  local method=$1 path=$2; shift 2
  curl -sS --fail -X "$method" -H @"$WORK/auth.h" \${CURL_TLS[@]+"\${CURL_TLS[@]}"} \
    "$SPLUNK_URL$path" "$@"
}

enc() { jq -rn --arg v "$1" '$v|@uri'; }
`;
}

const BROAD_GROUP = /^(domain users|everyone|authenticated users|all users|all[_ ]employees|all[_ ]staff|users|employees|staff|\*)$/i;

// --- blueprints ------------------------------------------------------------

export const MANAGEMENT_SECURITY_BLUEPRINTS                             = [
  // 1. Authentication -------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_auth',
    tier: TIER,
    label: 'Authentication: LDAP or SAML',
    group: 'Access',
    description: 'LDAPS against Active Directory, or SAML from Entra ID, Okta or Ping, with group-to-role mapping written out — and the bind password set through REST from a private file, never in the conf.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_auth' },
      { id: 'method', label: 'Method', control: 'select', default: 'ldap', options: [
        { value: 'ldap', label: 'LDAP (Active Directory or OpenLDAP)' },
        { value: 'saml', label: 'SAML single sign-on' },
      ] },
      // LDAP
      { id: 'strategy', label: 'LDAP strategy name', control: 'text', default: 'corp_ad', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'ldap_host', label: 'LDAP host', control: 'text', default: 'ldap.corp.example.com', hint: 'A load-balanced name or one DC — Splunk takes one host per strategy', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'ldap_ssl', label: 'LDAPS (TLS on 636)', control: 'toggle', default: true, showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'ldap_port', label: 'Port', control: 'number', default: 636, min: 1, max: 65535, showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'bind_dn', label: 'Bind DN', control: 'text', default: 'CN=svc-splunk-ldap,OU=Service Accounts,DC=corp,DC=example,DC=com', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'user_base_dn', label: 'User base DN', control: 'text', default: 'OU=Users,DC=corp,DC=example,DC=com', hint: 'Several separated by ;', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'user_filter', label: 'User filter', control: 'text', default: '(objectclass=user)', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'user_name_attr', label: 'User name attribute', control: 'select', default: 'samaccountname', options: [
        { value: 'samaccountname', label: 'sAMAccountName (Active Directory)' },
        { value: 'userprincipalname', label: 'userPrincipalName (AD, user@domain)' },
        { value: 'uid', label: 'uid (OpenLDAP)' },
      ], showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'group_base_dn', label: 'Group base DN', control: 'text', default: 'OU=Splunk,OU=Groups,DC=corp,DC=example,DC=com', hint: 'Narrow it: only the groups that map to roles', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'group_filter', label: 'Group filter', control: 'text', default: '(objectclass=group)', showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'group_member_attr', label: 'Group member attribute', control: 'select', default: 'member', options: [
        { value: 'member', label: 'member (AD, groupOfNames)' },
        { value: 'uniquemember', label: 'uniqueMember (groupOfUniqueNames)' },
        { value: 'memberuid', label: 'memberUid (posixGroup)' },
      ], showWhen: { input: 'method', equals: ['ldap'] } },
      { id: 'nested_groups', label: 'Expand nested groups', control: 'toggle', default: false, hint: 'AD only; slow on large directories', showWhen: { input: 'method', equals: ['ldap'] } },
      // SAML
      { id: 'idp', label: 'Identity provider', control: 'select', default: 'entra', options: [
        { value: 'entra', label: 'Microsoft Entra ID' },
        { value: 'okta', label: 'Okta' },
        { value: 'ping', label: 'Ping Identity' },
      ], showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'entity_id', label: 'Splunk entity ID', control: 'text', default: 'splunk-prod-sh', hint: 'Must match the identifier registered at the IdP', showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'sso_url', label: 'IdP SSO URL', control: 'text', default: 'https://login.microsoftonline.com/<tenant-id>/saml2', showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'slo_url', label: 'IdP logout URL', control: 'text', default: '', showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'idp_cert', label: 'IdP signing certificate path', control: 'text', default: '$SPLUNK_HOME/etc/auth/idpCerts/idpCert.pem', showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'sh_fqdn', label: 'Search head URL (as users reach it)', control: 'text', default: 'https://splunk.corp.example.com', hint: 'The load balancer name for a cluster', showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'sign_authn', label: 'Sign authentication requests', control: 'toggle', default: true, showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'signed_assertion', label: 'Require signed assertions', control: 'toggle', default: true, showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'attribute_query', label: 'Use SAML attribute query (Ping only — Entra and Okta do not support it)', control: 'toggle', default: false, showWhen: { input: 'method', equals: ['saml'] } },
      { id: 'attribute_query_url', label: 'Attribute query URL', control: 'text', default: '', showWhen: { input: 'attribute_query', equals: ['true'] } },
      // Both
      { id: 'role_map', label: 'Role map', control: 'textarea', default: 'admin = Splunk-Admins\npower = Splunk-Power\nuser = Splunk-Users', hint: 'role = group;group — LDAP group names (the cn), or SAML group values (object IDs for Entra)' },
      { id: 'splunk_url', label: 'Management URL for the bind-password script', control: 'text', default: 'https://localhost:8089', showWhen: { input: 'method', equals: ['ldap'] } },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_auth'), 'org_auth');
      const method = str(values, 'method', 'ldap');
      const strategy = splunkName(str(values, 'strategy', 'corp_ad'), 'corp_ad');
      const ssl = bool(values, 'ldap_ssl', true);
      const port = num(values, 'ldap_port', 636);
      const idp = str(values, 'idp', 'entra');
      const findings            = [];

      const roleMap                                       = [];
      for (const line of rows(str(values, 'role_map', ''))) {
        const [role, groups] = line.split('=').map((part) => part.trim());
        if (!role || !groups) continue;
        roleMap.push({ role: splunkName(role, role), groups: groups.split(';').map((g) => g.trim()).filter(Boolean) });
      }

      if (method === 'ldap' && !ssl) {
        findings.push(
          error('splunk.ldap-cleartext', 'LDAP without TLS sends the bind password and every user’s password across the network in clear text on each login.', {
            remediation: 'Use LDAPS on 636 (SSLEnabled = 1) with the directory’s CA in $SPLUNK_HOME/etc/openldap/ldap.conf and TLS_REQCERT demand.',
            source: 'Splunk Securing Splunk Enterprise: secure LDAP',
          }),
        );
      }
      if (method === 'ldap' && ssl && port === 389) {
        findings.push(warning('splunk.ldaps-port-389', 'SSLEnabled with port 389 expects TLS on the plain LDAP port, which most directories do not offer there. LDAPS is 636 (3269 for the AD global catalog).', { source: 'ArchToolKit' }));
      }
      for (const { role, groups } of roleMap) {
        const broad = groups.filter((g) => BROAD_GROUP.test(g));
        if (broad.length > 0 && (role === 'admin' || role === 'sc_admin' || role === 'power')) {
          findings.push(
            error('splunk.broad-group-to-admin', `The role map gives ${role} to ${broad.join(', ')} — effectively everyone in the directory.`, {
              remediation: 'Map admin to a small, dedicated group whose membership is reviewed. Everyone else gets user or a scoped role.',
              source: 'ArchToolKit',
            }),
          );
        } else if (broad.length > 0) {
          findings.push(warning('splunk.broad-group-mapping', `${role} is mapped to ${broad.join(', ')}. Anyone in the directory can log in and read whatever ${role} can read.`, { source: 'ArchToolKit' }));
        }
      }
      if (!roleMap.some((r) => r.role === 'admin')) {
        findings.push(info('splunk.no-admin-mapping', 'No group maps to admin. Keep the local admin account working (and its password in a vault) — it is the way back in when the directory is down.', { source: 'ArchToolKit' }));
      }
      if (method === 'saml' && !bool(values, 'signed_assertion', true)) {
        findings.push(error('splunk.saml-unsigned-assertion', 'Accepting unsigned SAML assertions lets anyone who can reach the search head forge a login as any user and role.', { source: 'Splunk authentication.conf spec: signedAssertion' }));
      }
      if (method === 'saml' && idp !== 'ping' && bool(values, 'attribute_query', false)) {
        findings.push(warning('splunk.saml-attrquery-unsupported', 'Entra ID and Okta do not implement the SAML attribute query. Use an authentication extension script for user info instead.', { source: 'Splunk: Configure SSO with Microsoft Entra ID / Okta' }));
      }
      if (method === 'saml' && !/^https:\/\//.test(str(values, 'sh_fqdn', ''))) {
        findings.push(warning('splunk.saml-http', 'SAML with Splunk Web on plain HTTP sends the assertion — a bearer credential — unencrypted. Enable Splunk Web TLS first.', { source: 'ArchToolKit' }));
      }

      const mapLines = (stanza        )           => [`[${stanza}]`, ...roleMap.map(({ role, groups }) => `${role} = ${groups.join(';')}`)];

      const ldapConf = [
        '[authentication]',
        '# LDAP first, then local accounts. The local admin stays usable, which is the',
        '# way back in when the directory is unreachable.',
        'authType = LDAP',
        `authSettings = ${strategy}`,
        '',
        `[${strategy}]`,
        `host = ${str(values, 'ldap_host', '')}`,
        `port = ${port}`,
        '# 1 = LDAPS. The CA that signed the directory certificate goes in',
        '# $SPLUNK_HOME/etc/openldap/ldap.conf (TLS_CACERT, TLS_REQCERT demand), which',
        '# is outside any app — see ops/ldap.conf.',
        `SSLEnabled = ${ssl ? 1 : 0}`,
        '',
        '# The account Splunk binds as to look users up. Read-only, no interactive login.',
        `bindDN = ${str(values, 'bind_dn', '')}`,
        '# Left empty on purpose. Set it with ops/set-ldap-bind-password.sh (REST, from a',
        '# mode-600 file) or in Settings > Authentication methods. Splunk encrypts it with',
        '# splunk.secret into local/authentication.conf.',
        'bindDNpassword =',
        '',
        '# Where users are, how to find them and which attribute is the login name.',
        `userBaseDN = ${str(values, 'user_base_dn', '')}`,
        `userBaseFilter = ${str(values, 'user_filter', '(objectclass=user)')}`,
        `userNameAttribute = ${str(values, 'user_name_attr', 'samaccountname')}`,
        'realNameAttribute = displayname',
        'emailAttribute = mail',
        '',
        '# Groups. A narrow groupBaseDN is the biggest single performance setting here:',
        '# Splunk reads every group under it on each cache refresh.',
        `groupBaseDN = ${str(values, 'group_base_dn', '')}`,
        `groupBaseFilter = ${str(values, 'group_filter', '(objectclass=group)')}`,
        'groupNameAttribute = cn',
        `groupMemberAttribute = ${str(values, 'group_member_attr', 'member')}`,
        `# What the member attribute holds: a DN (AD, groupOfNames) or a user name (posixGroup).`,
        `groupMappingAttribute = ${str(values, 'group_member_attr', 'member') === 'memberuid' ? 'uid' : 'dn'}`,
        `# Nested group expansion is AD-only (LDAP_MATCHING_RULE_IN_CHAIN) and slow on big trees.`,
        `nestedGroups = ${bool(values, 'nested_groups', false) ? 1 : 0}`,
        '',
        '# Do not let one slow DC hang every login.',
        'network_timeout = 20',
        'sizelimit = 1000',
        'timelimit = 15',
        'anonymous_referrals = 0',
        '',
        '# Splunk role = group name (the groupNameAttribute value, not the DN); several with ;',
        ...mapLines(`roleMap_${strategy}`),
      ];

      const idpLabel = idp === 'entra' ? 'Microsoft Entra ID' : idp === 'okta' ? 'Okta' : 'Ping Identity';
      const samlAttrMap =
        idp === 'entra'
          ? [
              '[authenticationResponseAttrMap_SAML]',
              '# Entra sends groups as object IDs unless the app registration emits names.',
              'role = http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
              'realName = http://schemas.microsoft.com/identity/claims/displayname',
              'mail = http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
            ]
          : ['[authenticationResponseAttrMap_SAML]', '# Attribute statement names as configured in the IdP application.', 'role = role', 'realName = realName', 'mail = mail'];

      const samlConf = [
        '[authentication]',
        'authType = SAML',
        'authSettings = saml_idp',
        '',
        `# ${idpLabel}`,
        '[saml_idp]',
        `entityId = ${str(values, 'entity_id', '')}`,
        `idpSSOUrl = ${str(values, 'sso_url', '')}`,
        ...(str(values, 'slo_url', '') ? [`idpSLOUrl = ${str(values, 'slo_url', '')}`] : ['# idpSLOUrl not set: logging out of Splunk does not end the IdP session.']),
        '# The IdP signing certificate (or a directory of them for rollover). Rotate it',
        '# here before the IdP rolls its certificate, or every login fails at once.',
        `idpCertPath = ${str(values, 'idp_cert', '')}`,
        `fqdn = ${str(values, 'sh_fqdn', '')}`,
        'redirectPort = 443',
        `signAuthnRequest = ${bool(values, 'sign_authn', true)}`,
        '# Never false: an unsigned assertion is a login anyone can forge.',
        `signedAssertion = ${bool(values, 'signed_assertion', true)}`,
        'signatureAlgorithm = RSA-SHA256',
        'inboundSignatureAlgorithm = RSA-SHA256;RSA-SHA384;RSA-SHA512',
        'ssoBinding = HTTPPost',
        'nameIdFormat = urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
        '# In a search head cluster, copy the IdP cert to every member.',
        'replicateCertificates = true',
        ...(bool(values, 'attribute_query', false)
          ? [
              '',
              '# SAML attribute query: lets Splunk look up a user who is not logged in —',
              '# needed for scheduled searches owned by SAML users.',
              `attributeQueryUrl = ${str(values, 'attribute_query_url', '')}`,
              'attributeQueryRequestSigned = true',
              'attributeQueryResponseSigned = true',
              '# The SOAP credentials are set in Settings > Authentication methods > SAML,',
              '# which encrypts them. Not here.',
              'attributeQuerySoapUsername = <REQUIRED: set in Settings>',
              'attributeQuerySoapPassword =',
            ]
          : [
              '',
              '# No attribute query. Without some way to look up SAML users, scheduled',
              '# searches and alerts owned by a SAML user fail with "user not found" once',
              '# the user’s cached session info expires. Splunk’s answer for Entra and Okta is',
              '# an authentication extension script (scriptPath / scriptFunctions =',
              '# getUserInfo; the Entra and Okta scripts ship in $SPLUNK_HOME/share/splunk/',
              '# authScriptSamples — VERIFY the script names for your version). Its API key',
              '# goes in scriptSecureArguments, set through Settings, never in this file.',
              `# scriptPath = ${idp === 'okta' ? 'SAML_script_okta.py' : idp === 'entra' ? 'SAML_script_azure.py' : '<script>.py'}`,
              '# scriptFunctions = getUserInfo',
              '# scriptTimeout = 10s',
            ]),
        '',
        ...samlAttrMap,
        '',
        '# Splunk role = IdP group value; several with ;',
        ...mapLines('roleMap_SAML'),
      ];

      const bindScript = [
        '#!/usr/bin/env bash',
        `# Set the LDAP bind password for strategy "${strategy}" through REST, from a file.`,
        '#',
        '# usage: set-ldap-bind-password.sh --token-file ~/.splunk/admin.token \\',
        '#          --password-file ~/.splunk/ldap-bind.pw [--url https://sh:8089] [--cacert ca.pem] [--dry-run]',
        '#',
        '# Both files must be mode 600. The password reaches curl in a config on stdin',
        '# (curl -K -), so it is never on a command line, in ps, or in shell history.',
        '# Splunk encrypts it with splunk.secret on write.',
        'set -euo pipefail',
        `SPLUNK_URL=${shq(str(values, 'splunk_url', 'https://localhost:8089'))}`,
        `STRATEGY=${shq(strategy)}`,
        `APP=${shq(app)}`,
        'TOKEN_FILE=""; PASSWORD_FILE=""; CA_FILE=""; EXECUTE=1',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --url) SPLUNK_URL=$2; shift 2 ;;',
        '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
        '    --password-file) PASSWORD_FILE=$2; shift 2 ;;',
        '    --cacert) CA_FILE=$2; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        '',
        ...bashPrelude(),
        '[ -n "$TOKEN_FILE" ] || die "--token-file is required"',
        '[ -n "$PASSWORD_FILE" ] || die "--password-file is required"',
        'load_token',
        'check_private "$PASSWORD_FILE"',
        '',
        '# Writing through the app namespace keeps the encrypted value in the app’s',
        '# local/authentication.conf, beside the stanza it belongs to.',
        'EP="/servicesNS/nobody/$APP/authentication/providers/LDAP/$(enc "$STRATEGY")"',
        'note "Strategy: $STRATEGY at $SPLUNK_URL$EP"',
        'api GET "$EP?output_mode=json" | jq -r \'.entry[0].content | "host=\\(.host) port=\\(.port) SSLEnabled=\\(.SSLEnabled) bindDN=\\(.bindDN)"\' >&2',
        '',
        'if [ "$EXECUTE" != 1 ]; then',
        '  note "Dry run: would set bindDNpassword for $STRATEGY from $PASSWORD_FILE. Nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        '',
        '# Build the curl config in memory: header and form field, escaped for curl’s',
        '# quoted-string syntax. printf is a shell builtin, so nothing here is an argv.',
        'cfg_escape() { local s=$1; s=${s//\\\\/\\\\\\\\}; s=${s//\\"/\\\\\\"}; printf \'%s\' "$s"; }',
        'PW=""; IFS= read -r PW < "$PASSWORD_FILE" || true',
        'PW=${PW%$\'\\r\'}',
        '[ -n "$PW" ] || die "$PASSWORD_FILE is empty"',
        'IFS= read -r TOKEN < "$TOKEN_FILE" || [[ -n "${TOKEN:-}" ]]  # a last line with no newline still reads',
        'TOKEN=${TOKEN%$\'\\r\'}',
        '{',
        '  printf \'header = "Authorization: Bearer %s"\\n\' "$(cfg_escape "$TOKEN")"',
        '  printf \'data-urlencode = "bindDNpassword=%s"\\n\' "$(cfg_escape "$PW")"',
        '} | curl -sS --fail -K - ${CURL_TLS[@]+"${CURL_TLS[@]}"} -X POST "$SPLUNK_URL$EP" -o /dev/null',
        'unset PW TOKEN',
        'note "bindDNpassword set. Reloading authentication."',
        'api POST "/services/authentication/providers/services/_reload" -o /dev/null',
        'note "Done. Verify: splunk login with a directory account, and | rest /services/authentication/users splunk_server=local | search type=LDAP"',
      ];

      const ldapClientConf = [
        '# $SPLUNK_HOME/etc/openldap/ldap.conf — the OpenLDAP client Splunk uses for LDAPS.',
        '# This file is outside any app: copy it into place on every search head (and the',
        '# cluster manager, deployer and deployment server if people log in there).',
        '',
        '# Refuse a directory certificate that does not chain to this CA or does not',
        '# match the host name. "never" is what makes LDAPS pointless.',
        'TLS_REQCERT demand',
        'TLS_CACERT /opt/splunk/etc/auth/ldap/directory-ca.pem',
        'TLS_PROTOCOL_MIN 3.3',
      ];

      return {
        tier: TIER,
        title: method === 'ldap' ? `LDAP authentication: ${strategy} (${ssl ? 'LDAPS' : 'clear text'})` : `SAML authentication: ${idpLabel}`,
        app,
        activation: 'reload',
        notes: [
          'Goes on every search head (through the deployer for a cluster), and on the management nodes people log in to. Indexers do not authenticate users for searches; they trust the search head.',
          method === 'ldap'
            ? 'bindDNpassword is empty in the app on purpose. Set it once per search head with ops/set-ldap-bind-password.sh, or in Settings > Authentication methods. In a search head cluster, set it on one member; the encrypted value replicates only if every member shares the same splunk.secret (VERIFY on your version).'
            : `Register the search head at ${idpLabel} with the entity ID and the ACS URL ${str(values, 'sh_fqdn', '')}/saml/acs. Export the Splunk SP metadata from Settings > Authentication methods > SAML after deploying.`,
          'Multi-factor: with SAML, MFA is enforced at the IdP (Entra Conditional Access, Okta sign-on policy, PingFederate policy) and Splunk never sees it — which is the recommended arrangement. With LDAP there is no MFA unless you add one; Splunk’s built-in Duo and RSA integrations are configured in authentication.conf ([authentication] externalTwoFactorAuthVendor) — VERIFY they are still supported on your version before relying on them.',
          'Test with a second browser session still logged in as local admin. A broken role map locks everyone out; the open admin session is how you fix it.',
          'REST automation and scheduled searches keep working through an auth change only for local accounts and tokens. Service integrations should use authentication tokens (see the token lifecycle blueprint), not a directory user’s password.',
        ],
        before: [
          'splunk cmd btool authentication list --debug',
          '| rest /services/authentication/providers/services splunk_server=local',
          '| rest /services/authentication/users splunk_server=local | stats count by type',
          method === 'ldap'
            ? `openssl s_client -connect ${str(values, 'ldap_host', '')}:${port} -showcerts </dev/null | openssl x509 -noout -subject -issuer -enddate`
            : `curl -sS -o /dev/null -w '%{http_code}\\n' ${str(values, 'sso_url', '')}`,
        ],
        files: {
          'default/authentication.conf': method === 'ldap' ? ldapConf : samlConf,
          ...(method === 'ldap' ? { 'ops/set-ldap-bind-password.sh': bindScript, 'ops/ldap.conf': ldapClientConf } : {}),
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          'splunk cmd btool authentication list --debug | grep -v bindDNpassword',
          ...(method === 'ldap'
            ? [
                `| rest /services/authentication/providers/LDAP splunk_server=local | table title, host, port, SSLEnabled, bindDN`,
                'index=_internal sourcetype=splunkd (component=AuthenticationManagerLDAP OR component=ScopedLDAPConnection) log_level!=INFO | head 20',
              ]
            : [
                '| rest /services/admin/SAML-sp-metadata splunk_server=local   # VERIFY endpoint name',
                'index=_internal sourcetype=splunkd component=Saml* log_level!=INFO | head 20',
              ]),
          '| rest /services/authentication/users splunk_server=local | table title, type, roles',
          '| rest /services/authentication/current-context splunk_server=local | table username, roles',
        ],
        backout: [
          `# Remove the app (or set authType = Splunk in its local/) and reload:`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}`,
          'curl -sS -H @auth.h -X POST https://localhost:8089/services/authentication/providers/services/_reload',
          '# The local admin account keeps working throughout — use it to reach the box.',
        ],
        findings,
      };
    },
  }),

  // 2. Roles ----------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_roles',
    tier: TIER,
    label: 'Roles, index access and search quotas',
    group: 'Access',
    description: 'authorize.conf roles from a matrix — which indexes, which capabilities, how many searches — with the grants that turn a user into an admin called out.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_roles' },
      { id: 'matrix', label: 'Role matrix', control: 'textarea', default: 'app_readers | app_prod;app_nonprod | | 3\nsoc_analyst | wineventlog;linux_secure;firewall;notable | schedule_search;rtsearch | 10\nnoc_ops | network;infra_metrics | schedule_search;list_inputs | 6', hint: 'role | index;index | capability;capability | concurrent search quota' },
      { id: 'import', label: 'Every role inherits from', control: 'select', default: 'user', options: [
        { value: 'user', label: 'user' },
        { value: 'power', label: 'power (can share objects and schedule)' },
        { value: '', label: 'Nothing — capabilities listed only' },
      ] },
      { id: 'time_window_days', label: 'Longest search window (days, 0 = unlimited)', control: 'number', default: 90, min: 0, max: 3650 },
      { id: 'disk_quota_mb', label: 'Search disk quota per user (MB)', control: 'number', default: 500, min: 10, max: 100000 },
      { id: 'rt_quota', label: 'Real-time searches per user', control: 'number', default: 0, min: 0, max: 50 },
      { id: 'cumulative_quota', label: 'Concurrent searches for the whole role (0 = no cap)', control: 'number', default: 0, min: 0, max: 1000 },
      { id: 'search_filter', label: 'Search filter for every role', control: 'text', default: '', hint: 'e.g. NOT sourcetype=secret:* — applied to all their searches' },
      { id: 'grantable', label: 'Roles a delegated admin may grant', control: 'text', default: '', hint: 'Sets grantableRoles; empty = not a user-admin role' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_roles'), 'org_roles');
      const importRole = str(values, 'import', 'user');
      const windowDays = num(values, 'time_window_days', 90);
      const diskMb = num(values, 'disk_quota_mb', 500);
      const rtQuota = num(values, 'rt_quota', 0);
      const cumulative = num(values, 'cumulative_quota', 0);
      const filter = str(values, 'search_filter', '');
      const grantable = listOf(str(values, 'grantable', ''));
      const findings            = [];

      const DANGEROUS = new Set(['admin_all_objects', 'edit_user', 'edit_roles', 'edit_roles_grantable', 'delete_by_keyword', 'change_authentication', 'edit_tokens_all', 'edit_server', 'run_script_input', 'edit_scripted', 'rest_apps_management', 'install_apps', 'edit_authentication_extensions', 'restart_splunkd', 'edit_cmd']);
      const BUILTIN = new Set(['admin', 'power', 'user', 'can_delete', 'splunk-system-role', 'sc_admin']);

      const roles = rows(str(values, 'matrix', '')).map((line) => {
        const [role = '', indexes = '', caps = '', quota = '', importOverride = ''] = line.split('|').map((c) => c.trim());
        return {
          name: splunkName(role, ''),
          raw: role,
          indexes: indexes.split(/[;\s]+/).map((i) => i.trim()).filter(Boolean),
          caps: caps.split(/[;\s]+/).map((c) => c.trim()).filter(Boolean),
          quota: Number(quota) || 3,
          imports: importOverride ? importOverride.split(';').map((r) => r.trim()).filter(Boolean) : importRole ? [importRole] : [],
        };
      }).filter((r) => r.name);

      if (roles.length === 0) {
        findings.push(error('splunk.roles-empty', 'The role matrix is empty.', { source: 'ArchToolKit' }));
      }

      for (const role of roles) {
        if (role.raw !== role.name) {
          findings.push(warning('splunk.role-name-changed', `Role "${role.raw}" is written as "${role.name}": Splunk role names are lowercase, without spaces.`, { source: 'Splunk authorize.conf spec' }));
        }
        if (BUILTIN.has(role.name)) {
          findings.push(warning('splunk.role-redefines-builtin', `"${role.name}" is a built-in role. Redefining it in an app merges with the system definition in ways that are hard to see; make a new role that imports it instead.`, { source: 'ArchToolKit' }));
        }
        if (role.imports.includes('admin') || role.imports.includes('sc_admin')) {
          findings.push(error('splunk.role-imports-admin', `${role.name} imports admin, which makes it admin — every capability and every index, whatever else this stanza says.`, { remediation: 'Import user or power and add the specific capabilities the role needs.', source: 'ArchToolKit' }));
        }
        if (role.indexes.some((i) => i === '*' || i === '_*')) {
          findings.push(error('splunk.role-all-indexes', `${role.name} can search ${role.indexes.includes('_*') ? 'every internal index' : 'every index'} (srchIndexesAllowed = ${role.indexes.join(';')}). New indexes — including sensitive ones added later — become readable without anyone deciding so.`, { remediation: 'List the indexes, or a prefix wildcard that matches only this team’s naming (app_*).', source: 'ArchToolKit' }));
        }
        if (role.indexes.length === 0) {
          findings.push(warning('splunk.role-no-indexes', `${role.name} lists no indexes, so it can read only what it inherits${role.imports.length ? ` from ${role.imports.join(', ')}` : ' — nothing'}.`, { source: 'ArchToolKit' }));
        }
        const dangerous = role.caps.filter((c) => DANGEROUS.has(c));
        if (dangerous.length > 0) {
          findings.push(error('splunk.role-admin-capability', `${role.name} gets ${dangerous.join(', ')}. Each of these is admin in practice: editing any object, any user, any role, or deleting indexed data.`, { remediation: 'Keep these on admin only. For user management, use grantableRoles with edit_user limited to named roles.', source: 'Splunk: About defining roles with capabilities' }));
        }
        if (role.caps.includes('can_delete') || role.imports.includes('can_delete')) {
          findings.push(warning('splunk.role-can-delete', `${role.name} inherits can_delete. The delete command hides events permanently and does not free disk; give it to nobody by default and to one break-glass account when needed.`, { source: 'ArchToolKit' }));
        }
        if (role.caps.includes('rtsearch') && rtQuota === 0) {
          findings.push(info('splunk.rtsearch-no-quota', `${role.name} has rtsearch but the real-time quota is 0, so it cannot run any.`, { source: 'ArchToolKit' }));
        }
        if (role.quota > 20) {
          findings.push(warning('splunk.role-high-quota', `${role.name} may run ${role.quota} searches at once per user. A handful of users at that level exhausts a search head’s concurrency and scheduled searches start being skipped.`, { source: 'ArchToolKit' }));
        }
      }
      if (grantable.length > 0) {
        findings.push(info('splunk.grantable-roles', `A role with edit_user and grantableRoles = ${grantable.join(';')} can create users only with those roles. Without grantableRoles, edit_user can grant admin.`, { source: 'Splunk authorize.conf spec' }));
      }
      if (windowDays === 0) {
        findings.push(info('splunk.no-time-window', 'No srchTimeWin: users can search all time, which on a large deployment is the search that gets everyone else skipped.', { source: 'ArchToolKit' }));
      }

      const stanzas           = [];
      for (const role of roles) {
        stanzas.push(
          `[role_${role.name}]`,
          ...(role.imports.length ? [`# Inherits capabilities and indexes from ${role.imports.join(', ')}.`, `importRoles = ${role.imports.join(';')}`] : ['# Inherits nothing: only what is listed here.']),
          '',
          '# The indexes this role may search, and the ones searched when no index= is given.',
          `srchIndexesAllowed = ${role.indexes.join(';')}`,
          `srchIndexesDefault = ${role.indexes.filter((i) => !i.includes('*')).slice(0, 1).join(';')}`,
          ...(filter ? ['# Appended to every search this role runs — a row-level restriction.', `srchFilter = ${filter}`] : []),
          '',
          '# Longest time range one search may cover, in seconds (-1 = unlimited).',
          `srchTimeWin = ${windowDays === 0 ? -1 : windowDays * 86400}`,
          '# Concurrent historical searches per user, real-time per user, and for the role as a whole.',
          `srchJobsQuota = ${role.quota}`,
          `rtSrchJobsQuota = ${rtQuota}`,
          `cumulativeSrchJobsQuota = ${cumulative}`,
          '# Disk the user’s search artifacts may take in the dispatch directory, in MB.',
          `srchDiskQuota = ${diskMb}`,
          '# Longest a search may run before it is finalised, e.g. 8h (0 = unlimited).',
          'srchMaxTime = 8h',
          ...(grantable.length ? ['', '# A delegated admin can grant only these roles.', `grantableRoles = ${grantable.join(';')}`] : []),
          '',
          ...(role.caps.length ? ['# Capabilities beyond what is inherited.', ...role.caps.map((c) => `${c} = enabled`)] : ['# No capabilities beyond what is inherited.']),
          '',
        );
      }

      const capabilityRef = [
        '# Common capabilities, for editing the matrix:',
        '#',
        '#   search                     run searches',
        '#   schedule_search            save scheduled searches and alerts',
        '#   rtsearch                   real-time searches (also needs rtSrchJobsQuota > 0)',
        '#   accelerate_search          report and data model acceleration',
        '#   list_inputs                see configured inputs (Settings > Data inputs)',
        '#   get_metadata               the metadata command',
        '#   run_collect                write to a summary index with collect',
        '#   output_file                outputcsv / write files on the search head',
        '#   edit_search_schedule_window, edit_search_schedule_priority',
        '#   export_results_is_visible  the Export button',
        '#   edit_tokens_own            create authentication tokens for yourself',
        '#',
        '# Admin in practice — keep on admin only:',
        '#   admin_all_objects  edit_user  edit_roles  change_authentication',
        '#   delete_by_keyword (the can_delete role)  edit_tokens_all  edit_server',
        '#   install_apps  rest_apps_management  run_script_input  restart_splunkd',
      ];

      return {
        tier: TIER,
        title: `Roles: ${roles.map((r) => r.name).join(', ') || 'none'}`,
        app,
        activation: 'restart',
        notes: [
          'Roles live on the search heads (through the deployer in a cluster). Index access is enforced where the search is planned, so the indexers need nothing.',
          'Capabilities and indexes are additive across every role a user holds and every role they import. A user with both app_readers and power gets the union. There is no deny.',
          'srchFilter is combined with OR across a user’s roles — a user with one filtered and one unfiltered role is effectively unfiltered.',
          'A role defined in an app merges with any definition of the same role in system/local. Check btool before and after; a stale system/local stanza is the usual reason a change "did not apply".',
          'Role names from the directory are mapped in authentication.conf (the authentication blueprint); these roles must exist first.',
        ],
        before: [
          'splunk cmd btool authorize list --debug | grep -E "^\\S+\\s+\\[role_"',
          '| rest /services/authorization/roles splunk_server=local | table title, imported_roles, srchIndexesAllowed, srchJobsQuota, capabilities',
          '| rest /services/authentication/users splunk_server=local | table title, roles',
        ],
        files: {
          'default/authorize.conf': [...capabilityRef, '', ...stanzas],
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          ...roles.map((r) => `splunk cmd btool authorize list role_${r.name} --debug`),
          '| rest /services/authorization/roles splunk_server=local | search title IN (' + roles.map((r) => r.name).join(', ') + ') | table title, imported_roles, srchIndexesAllowed, srchTimeWin, srchJobsQuota, capabilities',
          '| rest /services/authorization/roles splunk_server=local | eval all_idx=if(match(srchIndexesAllowed,"^\\*$"),1,0) | where all_idx=1 AND title!="admin" | table title',
          'index=_audit action=search info=granted user=<a user in the role> | head 5',
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app}    # or push the removal from the deployer`,
          'splunk restart',
          '# Users keep their other roles. A user whose only role was one of these can no longer search until given another.',
        ],
        findings,
      };
    },
  }),

  // 3. TLS ------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_tls',
    tier: TIER,
    label: 'TLS for splunkd, Splunk Web and forwarding',
    group: 'Encryption',
    description: 'Your own certificates in place of the defaults every Splunk install shares, TLS 1.2 minimum, verification switched on, and scripts to make the CSR and to watch expiry.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_tls' },
      { id: 'cert_dir', label: 'Certificate directory', control: 'text', default: '$SPLUNK_HOME/etc/auth/mycerts' },
      { id: 'server_cert', label: 'Server certificate file (cert + key + chain)', control: 'text', default: 'splunk-server.pem' },
      { id: 'ca_file', label: 'CA bundle', control: 'text', default: 'ca-chain.pem' },
      { id: 'key_encrypted', label: 'Private key is passphrase-protected', control: 'toggle', default: true },
      { id: 'tls13', label: 'Also allow TLS 1.3', control: 'toggle', default: false, hint: 'Splunk 10.4 and later; TLS 1.0 and 1.1 are removed in 10.4' },
      { id: 'verify_cert', label: 'Verify peer certificates', control: 'toggle', default: true },
      { id: 'verify_name', label: 'Verify peer host names', control: 'toggle', default: true },
      { id: 'require_client', label: 'Require client certificates (mutual TLS) on splunkd and receiving', control: 'toggle', default: false },
      { id: 'web_ssl', label: 'Enable HTTPS on Splunk Web', control: 'toggle', default: true },
      { id: 'receiving', label: 'Encrypted receiving port (indexers)', control: 'number', default: 9997, min: 0, max: 65535, hint: '0 = not an indexer' },
      { id: 'indexers', label: 'Indexers (for the forwarder outputs.conf)', control: 'textarea', default: 'idx1.corp.example.com:9997\nidx2.corp.example.com:9997' },
      { id: 'cert_cn', label: 'Certificate common name', control: 'text', default: 'splunk-sh1.corp.example.com' },
      { id: 'cert_sans', label: 'Subject alternative names', control: 'text', default: 'splunk-sh1.corp.example.com, splunk.corp.example.com' },
      { id: 'default_certs', label: 'Some hosts still use the Splunk default certificates', control: 'toggle', default: false },
      { id: 'check_hosts', label: 'Hosts for the expiry check', control: 'textarea', default: 'splunk-sh1.corp.example.com:8089\nsplunk-sh1.corp.example.com:8000\nidx1.corp.example.com:9997' },
      { id: 'warn_days', label: 'Warn when a certificate expires within (days)', control: 'number', default: 30, min: 1, max: 365 },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_tls'), 'org_tls');
      const dir = str(values, 'cert_dir', '$SPLUNK_HOME/etc/auth/mycerts').replace(/\/+$/, '');
      const serverCert = `${dir}/${str(values, 'server_cert', 'splunk-server.pem')}`;
      const caFile = `${dir}/${str(values, 'ca_file', 'ca-chain.pem')}`;
      const encrypted = bool(values, 'key_encrypted', true);
      const tls13 = bool(values, 'tls13', false);
      const verifyCert = bool(values, 'verify_cert', true);
      const verifyName = bool(values, 'verify_name', true);
      const mutual = bool(values, 'require_client', false);
      const webSsl = bool(values, 'web_ssl', true);
      const receiving = num(values, 'receiving', 9997);
      const indexers = listOf(str(values, 'indexers', ''));
      const cn = str(values, 'cert_cn', '');
      const sans = listOf(str(values, 'cert_sans', ''));
      const warnDays = num(values, 'warn_days', 30);
      const checkHosts = listOf(str(values, 'check_hosts', ''));
      const findings            = [];

      const versions = tls13 ? 'tls1.2, tls1.3' : 'tls1.2';
      const cipherSuite = 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
      const passwordLine = encrypted ? 'sslPassword = <REQUIRED: set in local/ on each host; splunkd encrypts it on restart>' : 'sslPassword =';

      if (!verifyCert) {
        findings.push(error('splunk.tls-no-verify', 'sslVerifyServerCert = false encrypts the connection but accepts any certificate, so anyone in the path can intercept it — forwarder traffic, cluster replication and REST alike.', { remediation: 'Deploy certificates from your CA with the chain in sslRootCAPath and turn verification on.', source: 'Splunk: Configure TLS certificate host name validation' }));
      } else if (!verifyName) {
        findings.push(warning('splunk.tls-no-name-check', 'Certificates are verified against the CA but not the host name, so any certificate your CA ever issued is accepted for any Splunk host.', { source: 'ArchToolKit' }));
      }
      if (bool(values, 'default_certs', false)) {
        findings.push(error('splunk.tls-default-certs', 'The default Splunk certificates are signed by a CA whose private key ships in every Splunk download. Anyone can mint a certificate your instances will trust.', { remediation: 'Replace $SPLUNK_HOME/etc/auth/server.pem, cacert.pem and the splunkweb cert with your own; the check script flags any that remain.', source: 'Splunk: About securing Splunk with TLS' }));
      }
      if (mutual) {
        findings.push(warning('splunk.tls-mutual', 'requireClientCert on splunkd means every client — the CLI, REST scripts, forwarders, the monitoring console — must present a certificate. Roll it out after everything has one.', { source: 'ArchToolKit' }));
      }
      if (receiving > 0 && indexers.length === 0) {
        findings.push(warning('splunk.tls-no-indexers', 'No indexers are listed, so the forwarder outputs.conf has no servers.', { source: 'ArchToolKit' }));
      }

      const serverConf = [
        '[sslConfig]',
        '# splunkd management port (8089): REST, CLI, clustering, deployment server.',
        'enableSplunkdSSL = true',
        '# Protocol floor. Splunk 10.4 removed TLS 1.0 and 1.1; tls1.2 is what every',
        '# supported build and forwarder agrees on.' + (tls13 ? ' tls1.3 needs 10.4 or later.' : ''),
        `sslVersions = ${versions}`,
        `sslVersionsForClient = ${versions}`,
        '# ECDHE with AES-GCM only: forward secrecy, authenticated encryption.',
        `cipherSuite = ${cipherSuite}`,
        'ecdhCurves = prime256v1, secp384r1, secp521r1',
        '',
        '# One PEM: server certificate, then its private key, then intermediates.',
        `serverCert = ${serverCert}`,
        passwordLine,
        '# The CA chain every peer certificate must lead to.',
        `sslRootCAPath = ${caFile}`,
        '',
        '# Verification is what makes TLS mean anything. Without it the channel is',
        '# encrypted to whoever answered.',
        `sslVerifyServerCert = ${verifyCert}`,
        `sslVerifyServerName = ${verifyName}`,
        `cliVerifyServerName = ${verifyName}`,
        `requireClientCert = ${mutual}`,
        '',
        '[kvstore]',
        '# The KV store (MongoDB) uses the [sslConfig] serverCert by default. It needs',
        '# the key in the same PEM and fails to start on a certificate without',
        '# clientAuth in its extended key usage — the CSR script requests both.',
        '# Check after restart: splunk show kvstore-status. 10.4 adds a',
        '# [kvstoreSslClientConfig] stanza for the KV store client side; VERIFY its',
        '# settings in the 10.4 server.conf.spec before relying on these two.',
        `sslVerifyServerCert = ${verifyCert}`,
        `sslVerifyServerName = ${verifyName}`,
      ];

      const webConf = [
        '[settings]',
        '# Splunk Web (8000) over HTTPS. The certificate and key are separate files here,',
        '# unlike serverCert in server.conf. Paths are absolute or relative to $SPLUNK_HOME.',
        `enableSplunkWebSSL = ${webSsl}`,
        `serverCert = ${dir}/splunkweb-cert.pem`,
        `privKeyPath = ${dir}/splunkweb-key.pem`,
        encrypted ? 'sslPassword = <REQUIRED: set in local/web.conf; encrypted on restart>' : 'sslPassword =',
        `sslVersions = ${versions}`,
        `cipherSuite = ${cipherSuite}`,
        'ecdhCurves = prime256v1, secp384r1, secp521r1',
        '# HSTS once HTTPS is known good — browsers then refuse plain HTTP.',
        'sendStrictTransportSecurityHeader = true',
      ];

      const inputsConf = [
        `# Encrypted receiving from forwarders. Indexers (and heavy forwarders that`,
        `# receive) only. Remove any plain [splunktcp://${receiving}] stanza — two`,
        `# listeners cannot share the port.`,
        `[splunktcp-ssl:${receiving}]`,
        'disabled = 0',
        '# Splunk-to-Splunk compression, matching compressed = true on the forwarders.',
        'compressed = true',
        '',
        '[SSL]',
        `serverCert = ${serverCert}`,
        passwordLine,
        `requireClientCert = ${mutual}`,
        `sslVersions = ${versions}`,
        `cipherSuite = ${cipherSuite}`,
        '# The CA chain comes from sslRootCAPath in server.conf [sslConfig].',
      ];

      const outputsConf = [
        '# outputs.conf for the forwarders — deploy it in the forwarders’ outputs app,',
        '# not this one. The CA chain each forwarder trusts is sslRootCAPath in its',
        '# server.conf [sslConfig]; outputs.conf no longer takes it.',
        '[tcpout]',
        'defaultGroup = primary_indexers',
        '',
        '[tcpout:primary_indexers]',
        `server = ${indexers.join(', ')}`,
        '# The forwarder’s certificate and key in one PEM (presented to the indexers',
        '# when they set requireClientCert).',
        `clientCert = ${dir}/forwarder-client.pem`,
        ...(encrypted ? ['# sslPassword for that key: set it in local/outputs.conf on each forwarder.'] : []),
        `sslVersions = ${versions}`,
        `sslVerifyServerCert = ${verifyCert}`,
        `sslVerifyServerName = ${verifyName}`,
        '# Splunk-to-Splunk compression; TLS-level compression is deprecated.',
        'compressed = true',
        'useACK = true',
      ];

      const csrScript = [
        '#!/usr/bin/env bash',
        '# Make a private key and a CSR for a Splunk host. The key is written mode 600',
        '# and never printed. The passphrase, if any, is read from a mode-600 file.',
        '#',
        '# usage: make-csr.sh [--cn host] [--san a,b] [--out-dir dir] [--passphrase-file f] [--dry-run]',
        '#        make-csr.sh assemble --cert signed.pem --key key.pem --chain chain.pem --out splunk-server.pem',
        'set -euo pipefail',
        'umask 077',
        `CN=${shq(cn)}`,
        `SANS=${shq(sans.join(','))}`,
        'OUT_DIR=.',
        'PASS_FILE=""',
        'EXECUTE=1',
        'die() { printf "error: %s\\n" "$*" >&2; exit 2; }',
        'check_private() { local m; m=$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"); case $m in 600|400) ;; *) die "$1 is mode $m; chmod 600 it" ;; esac; }',
        'command -v openssl >/dev/null || die "openssl is required"',
        '',
        'if [ "${1:-}" = assemble ]; then',
        '  shift; CERT=""; KEY=""; CHAIN=""; OUT=""',
        '  while [ $# -gt 0 ]; do case $1 in --cert) CERT=$2; shift 2;; --key) KEY=$2; shift 2;; --chain) CHAIN=$2; shift 2;; --out) OUT=$2; shift 2;; *) die "unknown $1";; esac; done',
        '  [ -n "$CERT" ] && [ -n "$KEY" ] && [ -n "$OUT" ] || die "--cert, --key and --out are required"',
        '  check_private "$KEY"',
        '  # Order matters to splunkd: certificate, key, then the chain.',
        '  cat "$CERT" "$KEY" ${CHAIN:+"$CHAIN"} > "$OUT"',
        '  chmod 600 "$OUT"',
        '  openssl x509 -in "$OUT" -noout -subject -issuer -enddate',
        '  exit 0',
        'fi',
        '',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --cn) CN=$2; shift 2 ;;',
        '    --san) SANS=$2; shift 2 ;;',
        '    --out-dir) OUT_DIR=$2; shift 2 ;;',
        '    --passphrase-file) PASS_FILE=$2; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) die "unknown option: $1" ;;',
        '  esac',
        'done',
        '[ -n "$CN" ] || die "--cn is required"',
        'KEY="$OUT_DIR/$CN.key"; CSR="$OUT_DIR/$CN.csr"',
        '[ -e "$KEY" ] && die "$KEY exists; refusing to overwrite a private key"',
        'SAN_EXT=$(printf "%s" "$SANS" | tr -d " " | tr "," "\\n" | sed "/^$/d; s/^/DNS:/" | paste -sd, -)',
        '[ -n "$SAN_EXT" ] || SAN_EXT="DNS:$CN"',
        '',
        'echo "Would create: $KEY (RSA 2048, mode 600)$([ -n "$PASS_FILE" ] && echo ", AES-256 with the passphrase in $PASS_FILE")"',
        'echo "             $CSR  CN=$CN  SAN=$SAN_EXT  EKU=serverAuth,clientAuth"',
        '[ "$EXECUTE" = 1 ] || { echo "Dry run: nothing was changed. Run it without --dry-run to apply."; exit 0; }',
        '',
        'mkdir -p "$OUT_DIR"',
        'if [ -n "$PASS_FILE" ]; then',
        '  check_private "$PASS_FILE"',
        '  # -pass file: reads the passphrase from the file, not from argv.',
        '  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -aes256 -pass "file:$PASS_FILE" -out "$KEY"',
        '  KEY_PASS=(-passin "file:$PASS_FILE")',
        'else',
        '  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY"',
        '  KEY_PASS=()',
        'fi',
        'chmod 600 "$KEY"',
        '# clientAuth as well as serverAuth: splunkd is a client too (forwarding,',
        '# clustering, KV store replication). Needs OpenSSL 1.1.1+ for -addext.',
        'openssl req -new -key "$KEY" ${KEY_PASS[@]+"${KEY_PASS[@]}"} -out "$CSR" -subj "/CN=$CN" \\',
        '  -addext "subjectAltName=$SAN_EXT" \\',
        '  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \\',
        '  -addext "extendedKeyUsage=serverAuth,clientAuth"',
        'openssl req -in "$CSR" -noout -subject -verify',
        'echo "Send $CSR to your CA. Keep $KEY where it is; then run: $0 assemble --cert <signed> --key $KEY --chain <chain> --out splunk-server.pem"',
      ];

      const checkScript = [
        '#!/usr/bin/env bash',
        '# Check the certificate each Splunk port presents: expiry, issuer, whether it',
        '# is still a default Splunk certificate, and whether it is SHA-1 signed.',
        '#',
        '# usage: check-cert-expiry.sh [--days N] [host:port ...]',
        '# exit: 0 all good, 1 something expires within N days, 2 expired, SHA-1 or a',
        '#       default Splunk certificate, 3 a host could not be reached.',
        'set -uo pipefail',
        `DAYS=${warnDays}`,
        `HOSTS=(${checkHosts.map(shq).join(' ')})`,
        'if [ "${1:-}" = --days ]; then DAYS=$2; shift 2; fi',
        '[ $# -gt 0 ] && HOSTS=("$@")',
        'command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 3; }',
        'RC=0',
        'worst() { [ "$1" -gt "$RC" ] && RC=$1; }',
        'NOW=$(date +%s)',
        'for hp in "${HOSTS[@]}"; do',
        '  host=${hp%:*}; port=${hp##*:}',
        '  # s_client prints the server certificate even when the handshake then fails on',
        '  # a missing client certificate, so this works against requireClientCert too.',
        '  pem=$(timeout 10 openssl s_client -connect "$host:$port" -servername "$host" </dev/null 2>/dev/null | openssl x509 2>/dev/null)',
        '  if [ -z "$pem" ]; then printf "%-45s UNREACHABLE\\n" "$hp"; [ "$RC" -lt 3 ] && RC=3; continue; fi',
        '  end=$(printf "%s\\n" "$pem" | openssl x509 -noout -enddate | cut -d= -f2)',
        '  issuer=$(printf "%s\\n" "$pem" | openssl x509 -noout -issuer)',
        '  end_s=$(date -d "$end" +%s 2>/dev/null || date -j -f "%b %e %T %Y %Z" "$end" +%s)',
        '  left=$(( (end_s - NOW) / 86400 ))',
        '  sig=$(printf "%s\\n" "$pem" | openssl x509 -noout -text | grep -m1 "Signature Algorithm")',
        '  status=OK',
        '  if printf "%s" "$issuer" | grep -qiE "SplunkCommonCA|O ?= ?Splunk"; then status="DEFAULT-SPLUNK-CERT"; worst 2',
        '  # Splunk 10.4 rejects SHA-1 signed certificates.',
        '  elif printf "%s" "$sig" | grep -qi sha1; then status="SHA1-SIGNED"; worst 2',
        '  elif [ "$left" -lt 0 ]; then status=EXPIRED; worst 2',
        '  elif [ "$left" -lt "$DAYS" ]; then status="EXPIRES-SOON"; worst 1',
        '  fi',
        '  printf "%-45s %-20s %5s days  %s\\n" "$hp" "$status" "$left" "$issuer"',
        'done',
        'exit $RC',
      ];

      return {
        tier: TIER,
        title: `TLS: ${versions}, verification ${verifyCert ? 'on' : 'off'}${mutual ? ', mutual' : ''}`,
        app,
        activation: 'restart',
        notes: [
          'server.conf goes on every Splunk Enterprise instance (search heads, indexers, management nodes, heavy forwarders). web.conf on anything with Splunk Web. inputs.conf on indexers and receiving heavy forwarders. ops/forwarder-outputs.conf is for the forwarders’ outputs app, through the deployment server.',
          'Order of rollout: certificates and CA chain on every host first, with verification still off; then turn on sslVerifyServerCert everywhere; then, if wanted, requireClientCert. Turning verification on before every peer has a valid certificate breaks clustering and forwarding at once.',
          `Private keys and passphrases stay on the host. ${encrypted ? 'sslPassword is a <REQUIRED> placeholder in default/: set the real value in local/server.conf, local/web.conf and local/inputs.conf on each host, and splunkd encrypts it with splunk.secret on the next restart.' : 'The key is unencrypted, so sslPassword is empty; protect the file with mode 600, owned by the splunk user.'}`,
          'Indexer cluster peers get server.conf and inputs.conf through the cluster manager bundle (manager-apps), not by hand.',
          `Written for Splunk Enterprise 10.4: sslVersions ${versions} (TLS 1.0 and 1.1 are removed${tls13 ? '; tls1.3 is accepted from 10.4, so older forwarders negotiate 1.2' : ''}), and SHA-1 signed certificates are rejected — ops/check-cert-expiry.sh flags them. Compression is Splunk-to-Splunk (compressed = true on both ends), not TLS compression.`,
          'Splunk Cloud Platform manages its own certificates; this app is for Splunk Enterprise and for the forwarders that send to either.',
        ],
        before: [
          'splunk cmd btool server list sslConfig --debug',
          'splunk cmd btool inputs list SSL --debug',
          'splunk cmd btool web list settings --debug | grep -iE "ssl|cert|priv"',
          `openssl x509 -in ${serverCert.replace('$SPLUNK_HOME', '/opt/splunk')} -noout -subject -issuer -enddate -ext subjectAltName,extendedKeyUsage`,
          `openssl verify -CAfile ${caFile.replace('$SPLUNK_HOME', '/opt/splunk')} ${serverCert.replace('$SPLUNK_HOME', '/opt/splunk')}`,
          'bash ops/check-cert-expiry.sh',
        ],
        files: {
          'default/server.conf': serverConf,
          'default/web.conf': webConf,
          ...(receiving > 0 ? { 'default/inputs.conf': inputsConf } : {}),
          'ops/forwarder-outputs.conf': outputsConf,
          'ops/make-csr.sh': csrScript,
          'ops/check-cert-expiry.sh': checkScript,
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          'bash ops/check-cert-expiry.sh; echo "exit $?"',
          `openssl s_client -connect localhost:8089 -tls1_1 </dev/null   # must fail`,
          'index=_internal sourcetype=splunkd (component=SSLCommon OR component=TcpInputProc OR component=TcpOutputProc) log_level=ERROR | stats count by host, component, message',
          'index=_internal sourcetype=splunkd component=TcpInputProc "SSL" | stats count by host',
          'splunk show kvstore-status',
          '| rest /services/server/info splunk_server=* | table splunk_server, version',
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app} && splunk restart    # back to whatever system/local and the defaults say`,
          '# Forwarders: redeploy the previous outputs app from the deployment server before removing TLS from the indexers, or they stop sending.',
          '# If verification broke clustering: set sslVerifyServerCert = false in local/server.conf on the affected peers, restart, fix the certificates, then turn it back on.',
        ],
        findings,
      };
    },
  }),

  // 4. Workload management --------------------------------------------------
  splunkBlueprint({
    id: 'splunk_workload',
    tier: TIER,
    label: 'Workload management: pools and rules',
    group: 'Workload',
    description: 'CPU and memory shares for search, ingest and everything else on Linux cgroups, with rules that place, move, warn about and abort searches — and a check that the host can actually enforce them.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_workload' },
      { id: 'search_cpu', label: 'Search share of CPU (%)', control: 'number', default: 70, min: 1, max: 98 },
      { id: 'search_mem', label: 'Search share of memory (%)', control: 'number', default: 70, min: 1, max: 98 },
      { id: 'ingest_cpu', label: 'Ingest share of CPU (%)', control: 'number', default: 20, min: 1, max: 98 },
      { id: 'ingest_mem', label: 'Ingest share of memory (%)', control: 'number', default: 20, min: 1, max: 98 },
      { id: 'misc_cpu', label: 'Misc share of CPU (%)', control: 'number', default: 10, min: 1, max: 98 },
      { id: 'misc_mem', label: 'Misc share of memory (%)', control: 'number', default: 10, min: 1, max: 98 },
      { id: 'pools', label: 'Search pools', control: 'textarea', default: 'high_perf | 50 | 50\nstandard_perf | 35 | 35 | default\nlimited_perf | 15 | 15', hint: 'name | cpu% of search | mem% of search | default' },
      { id: 'rules', label: 'Rules (evaluated in order)', control: 'textarea', default: 'admins_high | role=admin | place | high_perf |\nalltime_warn | search_time_range=alltime AND runtime>10m | alert | | This all-time search has run for 10 minutes and will be stopped at 30.\nalltime_abort | search_time_range=alltime AND runtime>30m AND NOT role=admin | abort | | All-time searches are stopped after 30 minutes. Narrow the time range.\nlong_adhoc_move | search_type=adhoc AND runtime>15m | move | limited_perf | Moved to the limited pool after 15 minutes.', hint: 'name | predicate | place/move/alert/abort | pool | message' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_workload'), 'org_workload');
      const cat = {
        search: { cpu: num(values, 'search_cpu', 70), mem: num(values, 'search_mem', 70) },
        ingest: { cpu: num(values, 'ingest_cpu', 20), mem: num(values, 'ingest_mem', 20) },
        misc: { cpu: num(values, 'misc_cpu', 10), mem: num(values, 'misc_mem', 10) },
      };
      const findings            = [];

      const pools = rows(str(values, 'pools', '')).map((line) => {
        const [name = '', cpu = '', mem = '', def = ''] = line.split('|').map((c) => c.trim());
        return { name: splunkName(name, ''), cpu: Number(cpu) || 0, mem: Number(mem) || 0, isDefault: /^(default|yes|true|1)$/i.test(def) };
      }).filter((p) => p.name);
      if (pools.length > 0 && !pools.some((p) => p.isDefault)) pools[0] = { ...pools[0] , isDefault: true };
      const defaultPool = pools.find((p) => p.isDefault)?.name ?? 'standard_perf';
      const poolNames = new Set([...pools.map((p) => p.name), 'ingest', 'misc']);

      const rules = rows(str(values, 'rules', '')).map((line) => {
        const [name = '', predicate = '', action = 'place', pool = '', message = ''] = line.split('|').map((c) => c.trim());
        return { name: splunkName(name, ''), predicate, action: action.toLowerCase(), pool: splunkName(pool, ''), message };
      }).filter((r) => r.name && r.predicate);

      const cpuSum = cat.search.cpu + cat.ingest.cpu + cat.misc.cpu;
      const memSum = cat.search.mem + cat.ingest.mem + cat.misc.mem;
      if (cpuSum !== 100 || memSum !== 100) {
        findings.push(error('splunk.wlm-weights-sum', `Category weights add up to ${cpuSum}% CPU and ${memSum}% memory. They are shares of the whole machine and must total 100.`, { source: 'Splunk workload_pools.conf spec' }));
      }
      if (cat.ingest.cpu < 10 || cat.ingest.mem < 10) {
        findings.push(error('splunk.wlm-ingest-starved', `Ingest gets ${cat.ingest.cpu}% CPU and ${cat.ingest.mem}% memory. Under search load, parsing and indexing slow down, queues fill, and forwarders block — data arrives late or not at all.`, { remediation: 'Keep ingest at 20% or more on an indexer; on a search head that indexes nothing it can be lower but not near zero.', source: 'ArchToolKit' }));
      } else if (cat.ingest.cpu < 15) {
        findings.push(warning('splunk.wlm-ingest-low', `Ingest has ${cat.ingest.cpu}% CPU. Watch the indexing queues (Monitoring Console > Indexing performance) after enabling.`, { source: 'ArchToolKit' }));
      }
      const poolCpu = pools.reduce((a, p) => a + p.cpu, 0);
      const poolMem = pools.reduce((a, p) => a + p.mem, 0);
      if (pools.length > 0 && (poolCpu !== 100 || poolMem !== 100)) {
        findings.push(warning('splunk.wlm-pool-sum', `Search pools add up to ${poolCpu}% CPU and ${poolMem}% memory of the search category; they are shares of it and should total 100.`, { source: 'ArchToolKit' }));
      }
      if (pools.filter((p) => p.isDefault).length > 1) {
        findings.push(error('splunk.wlm-two-defaults', 'More than one search pool is marked default.', { source: 'Splunk workload_pools.conf spec' }));
      }

      const hasAlert = rules.some((r) => r.action === 'alert');
      for (const r of rules) {
        if (!['place', 'move', 'alert', 'abort'].includes(r.action)) {
          findings.push(error('splunk.wlm-bad-action', `Rule ${r.name}: action "${r.action}" is not one of place, move, alert, abort.`, { source: 'Splunk workload_rules.conf spec' }));
          continue;
        }
        if (r.action !== 'place' && !/runtime\s*>/.test(r.predicate)) {
          findings.push(error('splunk.wlm-needs-runtime', `Rule ${r.name}: ${r.action} applies to running searches, so its predicate must include runtime>… .`, { source: 'Splunk: Configure workload rules' }));
        }
        if ((r.action === 'place' || r.action === 'move') && !poolNames.has(r.pool)) {
          findings.push(error('splunk.wlm-unknown-pool', `Rule ${r.name} names pool "${r.pool}", which is not defined.`, { source: 'ArchToolKit' }));
        }
        if (r.action === 'abort' && !r.message) {
          findings.push(warning('splunk.wlm-abort-silent', `Rule ${r.name} aborts searches with no user_message. The user sees a search that stopped, and a ticket follows.`, { source: 'ArchToolKit' }));
        }
        if (r.action === 'abort' && !hasAlert) {
          findings.push(warning('splunk.wlm-abort-no-alert', `Rule ${r.name} aborts searches but no alert rule warns first. An alert rule on the same predicate at a shorter runtime gives the user a chance to narrow the search — and shows you how often the abort would fire before it does.`, { source: 'ArchToolKit' }));
        }
        if (r.action === 'abort' && !/role\s*!?=|NOT\s+role/i.test(r.predicate)) {
          findings.push(warning('splunk.wlm-abort-all-roles', `Rule ${r.name} aborts matching searches for every role, including admin and splunk-system-user — the account scheduled searches and accelerations run as.`, { source: 'ArchToolKit' }));
        }
      }

      const poolsConf = [
        '[general]',
        '# Takes effect only on Linux with splunkd run by systemd (see ops/check-wlm-prereqs.sh).',
        'enabled = true',
        `default_pool = ${defaultPool}`,
        'ingest_pool = ingest',
        'workload_pool_base_dir_name = splunk',
        '',
        '# The three categories share the machine. Each weight is a percentage of all',
        '# CPU/memory available to Splunk; together they make 100.',
        '[workload_category:search]',
        `cpu_weight = ${cat.search.cpu}`,
        `mem_weight = ${cat.search.mem}`,
        '',
        '# Parsing, indexing and forwarding. Starve this and data backs up to the forwarders.',
        '[workload_category:ingest]',
        `cpu_weight = ${cat.ingest.cpu}`,
        `mem_weight = ${cat.ingest.mem}`,
        '',
        '# Scripted and modular inputs and other helper processes.',
        '[workload_category:misc]',
        `cpu_weight = ${cat.misc.cpu}`,
        `mem_weight = ${cat.misc.mem}`,
        '',
        '# Search pools: shares of the search category. CPU weight is a floor under',
        '# contention, not a cap; mem_weight is a hard limit for the pool.',
        ...pools.flatMap((p) => [
          `[workload_pool:${p.name}]`,
          'category = search',
          `cpu_weight = ${p.cpu}`,
          `mem_weight = ${p.mem}`,
          `default_category_pool = ${p.isDefault ? 1 : 0}`,
          '',
        ]),
        '[workload_pool:ingest]',
        'category = ingest',
        'cpu_weight = 100',
        'mem_weight = 100',
        'default_category_pool = 1',
        '',
        '[workload_pool:misc]',
        'category = misc',
        'cpu_weight = 100',
        'mem_weight = 100',
        'default_category_pool = 1',
      ];

      const rulesConf = [
        '# Rules are checked in this order and the first match wins for placement.',
        '# Predicates: app, role, user, index, search_type (adhoc, scheduled,',
        '# datamodel_acceleration, report_acceleration, summary_index), search_mode',
        '# (realtime, historical), search_time_range (e.g. >4h, =alltime), runtime',
        '# (e.g. >10m), joined with AND, OR, NOT and parentheses.',
        '[workload_rules_order]',
        `rules = ${rules.map((r) => r.name).join(',')}`,
        '',
        ...rules.flatMap((r) => [
          `[workload_rule:${r.name}]`,
          `predicate = ${r.predicate}`,
          ...(r.action === 'place'
            ? ['# Placement when the search starts.', `workload_pool = ${r.pool}`]
            : r.action === 'move'
              ? ['# Moved while running, once the predicate matches.', 'action = move', `workload_pool = ${r.pool}`]
              : r.action === 'alert'
                ? ['# Tells the user (and logs) without touching the search.', 'action = alert']
                : ['# Stops the search. The user gets the message below.', 'action = abort']),
          ...(r.message ? [`user_message = ${r.message}`] : []),
          'schedule = always_on',
          'disabled = 0',
          '',
        ]),
      ];

      const prereqScript = [
        '#!/usr/bin/env bash',
        '# Can this host enforce workload management? Read-only; changes nothing.',
        '# exit 0 ready, 1 not ready.',
        'set -uo pipefail',
        'SPLUNK_HOME=${SPLUNK_HOME:-/opt/splunk}',
        'UNIT=${SPLUNK_UNIT:-Splunkd}',
        'FAIL=0',
        'ok()   { printf "  ok    %s\\n" "$*"; }',
        'bad()  { printf "  FAIL  %s\\n" "$*"; FAIL=1; }',
        'warn() { printf "  warn  %s\\n" "$*"; }',
        '',
        '[ "$(uname -s)" = Linux ] && ok "Linux" || bad "workload management needs Linux cgroups"',
        '',
        'fs=$(stat -fc %T /sys/fs/cgroup 2>/dev/null)',
        'case "$fs" in',
        '  cgroup2fs) ok "cgroup v2 (unified). Supported on recent Splunk versions — VERIFY yours in the release notes." ;;',
        '  tmpfs) ok "cgroup v1" ;;',
        '  *) bad "no cgroup filesystem at /sys/fs/cgroup ($fs)" ;;',
        'esac',
        '',
        'if systemctl is-active --quiet "$UNIT"; then ok "systemd unit $UNIT is active"',
        'else bad "splunkd is not running under systemd unit $UNIT. Run: $SPLUNK_HOME/bin/splunk enable boot-start -systemd-managed 1 -user splunk (then start it with systemctl)"; fi',
        '',
        'if [ "$(systemctl show "$UNIT" -p Delegate --value 2>/dev/null)" = yes ]; then ok "Delegate=yes (splunkd may manage its own cgroups)"',
        'else bad "Delegate is not yes on $UNIT; the unit generated by enable boot-start -systemd-managed sets it"; fi',
        '',
        'cg=$(systemctl show "$UNIT" -p ControlGroup --value 2>/dev/null)',
        '[ -n "$cg" ] && ok "control group $cg" || warn "could not read the unit control group"',
        'if [ "$fs" = cgroup2fs ] && [ -n "$cg" ]; then',
        '  ctrl=$(cat "/sys/fs/cgroup$cg/cgroup.controllers" 2>/dev/null)',
        '  for c in cpu memory; do',
        '    printf "%s" "$ctrl" | grep -qw "$c" && ok "$c controller available to the unit" || bad "$c controller not delegated to $cg"',
        '  done',
        'fi',
        '',
        '"$SPLUNK_HOME/bin/splunk" btool workload_pools list general --debug 2>/dev/null | sed "s/^/        /"',
        '',
        '[ "$FAIL" = 0 ] && echo "Ready." || echo "Not ready: workload_pools.conf will be read but not enforced."',
        'exit $FAIL',
      ];

      return {
        tier: TIER,
        title: `Workload management: search ${cat.search.cpu}% / ingest ${cat.ingest.cpu}% / misc ${cat.misc.cpu}% CPU`,
        app,
        activation: 'restart',
        notes: [
          'Enforced only on Linux, with splunkd run by systemd (splunk enable boot-start -systemd-managed 1). Run ops/check-wlm-prereqs.sh on each host first; on a host that fails it the conf is read and silently not enforced.',
          'Deploy to the search heads (through the deployer, same config on every member) and to the indexers (through the cluster manager). Rules act where the search runs; pools are per host.',
          'CPU weights are proportions under contention: an idle category’s share is lent to the others. Memory weights are limits — a search pool at 15% memory has its searches killed when they exceed it.',
          'Admission rules ([search_filter_rule:...], action = filter) can reject searches before they start, e.g. index=* over all time. They are not generated here; add them once the alert rules have shown what they would catch.',
          'Splunk Cloud Platform has its own workload management in the Cloud Monitoring Console; this conf is for Splunk Enterprise.',
        ],
        before: [
          'bash ops/check-wlm-prereqs.sh',
          'splunk cmd btool workload_pools list --debug',
          'splunk cmd btool workload_rules list --debug',
          '| rest /services/workloads/status splunk_server=*   # VERIFY endpoint on your version',
          'index=_introspection sourcetype=splunk_resource_usage component=Hostwide | timechart avg(data.cpu_system_pct) avg(data.cpu_user_pct) by host',
        ],
        files: {
          'default/workload_pools.conf': poolsConf,
          'default/workload_rules.conf': rulesConf,
          'ops/check-wlm-prereqs.sh': prereqScript,
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          '| rest /services/workloads/pools splunk_server=* | table splunk_server, title, category, cpu_weight, mem_weight   # VERIFY endpoint',
          '| rest /services/workloads/rules splunk_server=local | table title, predicate, action, workload_pool',
          'index=_introspection sourcetype=splunk_resource_usage component=PerProcess data.workload_pool=* | stats dc(data.search_props.sid) by data.workload_pool',
          'index=_internal sourcetype=splunkd component=WorkloadManager log_level!=INFO | head 20',
          'index=_internal sourcetype=splunkd component=WorkloadManager (abort OR move OR alert) | stats count by rule, action',
          'index=_internal source=*metrics.log group=queue name=indexqueue | timechart perc95(current_size_kb) by host',
        ],
        backout: [
          '# Fastest: splunk disable workload-management (or Settings > Workload management > disable) — pools stop being enforced at once. VERIFY CLI verb on your version.',
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then push from the deployer / cluster manager and restart`,
        ],
        findings,
      };
    },
  }),

  // 5. REST operations kit --------------------------------------------------
  splunkBlueprint({
    id: 'splunk_rest_ops',
    tier: TIER,
    label: 'REST automation kit for day-2 admin',
    group: 'Automation',
    description: 'Bash and PowerShell scripts for the chores done by hand in the UI — enable and disable searches, change schedules, reassign orphaned objects, rotate a HEC token, create an index — applied when run (--dry-run previews), with an undo log.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_rest_ops' },
      { id: 'splunk_url', label: 'Management URL', control: 'text', default: 'https://splunk-sh1.corp.example.com:8089' },
      { id: 'token_file', label: 'Token file', control: 'text', default: '~/.splunk/ops.token', hint: 'A Splunk authentication token, mode 600' },
      { id: 'ca_file', label: 'CA bundle for the management port', control: 'text', default: '', hint: 'Empty = the system trust store' },
      { id: 'default_app', label: 'Default app scope', control: 'text', default: 'search', hint: 'Operations touch only this app unless --app or --all-apps is given' },
      { id: 'log_dir', label: 'Change log directory', control: 'text', default: '~/.splunk/ops-log' },
      { id: 'shells', label: 'Scripts', control: 'select', default: 'both', options: [
        { value: 'both', label: 'Bash and PowerShell' },
        { value: 'bash', label: 'Bash only' },
        { value: 'pwsh', label: 'PowerShell only' },
      ] },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_rest_ops'), 'org_rest_ops');
      const url = str(values, 'splunk_url', 'https://localhost:8089').replace(/\/+$/, '');
      const tokenFile = str(values, 'token_file', '~/.splunk/ops.token');
      const caFile = str(values, 'ca_file', '');
      const defaultApp = str(values, 'default_app', '');
      const logDir = str(values, 'log_dir', '~/.splunk/ops-log');
      const shells = str(values, 'shells', 'both');
      const findings            = [];

      if (!/^https:\/\//.test(url)) {
        findings.push(error('splunk.rest-cleartext', 'The management URL is not HTTPS, so the bearer token crosses the network in clear text on every call.', { source: 'ArchToolKit' }));
      }
      if (!defaultApp) {
        findings.push(warning('splunk.rest-wildcard-scope', 'No default app scope: a pattern like --name "*" would match objects in every app. The scripts refuse that without --all-apps, but a scope makes the safe path the default one.', { source: 'ArchToolKit' }));
      }
      if (/^\/tmp\/|^\/var\/tmp\//.test(tokenFile)) {
        findings.push(warning('splunk.rest-token-in-tmp', 'The token file is in a shared temporary directory. Keep it under the operator’s home directory, mode 600.', { source: 'ArchToolKit' }));
      }
      findings.push(info('splunk.rest-token-perms', 'Both scripts refuse a token file that anyone but its owner can read (mode other than 600/400, or a Windows ACL granting Everyone, Users or Authenticated Users).', { source: 'ArchToolKit' }));

      const usage = [
        '# Commands (apply when run; --dry-run previews):',
        '#   list-searches   [--app A|--all-apps] [--scheduled]',
        '#   disable-search  --name PATTERN [--app A|--all-apps]     (PATTERN may use * and ?)',
        '#   enable-search   --name PATTERN [--app A|--all-apps]',
        '#   set-schedule    --name NAME --cron "5 * * * *" [--app A]',
        '#   orphans         [--app A|--all-apps]                    (objects whose owner no longer exists)',
        '#   reassign        --new-owner U (--orphans | --from-owner U) [--type savedsearch|view|macro] [--app A|--all-apps]',
        '#   rotate-hec      --name TOKEN_NAME --out FILE            (creates NAME_YYYYMMDD; old token left running)',
        '#   retire-hec      --name TOKEN_NAME                       (disables it once senders have moved)',
        '#   create-index    --name I [--max-mb N] [--retention-days D] [--datatype event|metric]  (standalone only)',
      ];

      const bash = [
        '#!/usr/bin/env bash',
        '# Splunk day-2 REST operations. Every change is logged before and after, with',
        '# the command that undoes it, to $LOG_DIR.',
        '#',
        '# usage: splunk-rest-ops.sh COMMAND [options] [--dry-run]',
        ...usage,
        '#',
        '# Common options: --url URL  --token-file F (mode 600)  --cacert F  --log-dir D',
        'set -euo pipefail',
        `SPLUNK_URL=${shq(url)}`,
        `TOKEN_FILE=${shq(tokenFile)}`,
        `CA_FILE=${shq(caFile)}`,
        `APP=${shq(defaultApp)}`,
        `LOG_DIR=${shq(logDir)}`,
        'CMD=${1:-help}; [ $# -gt 0 ] && shift',
        'EXECUTE=1; ALL_APPS=0;NAME=""; CRON=""; NEW_OWNER=""; FROM_OWNER=""; ORPHANS=0; TYPE=savedsearch',
        'OUT=""; MAX_MB=""; RETENTION_DAYS=""; DATATYPE=event; SCHEDULED=0',
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --url) SPLUNK_URL=$2; shift 2 ;;',
        '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
        '    --cacert) CA_FILE=$2; shift 2 ;;',
        '    --log-dir) LOG_DIR=$2; shift 2 ;;',
        '    --app) APP=$2; shift 2 ;;',
        '    --all-apps) ALL_APPS=1; shift ;;',
        '    --name) NAME=$2; shift 2 ;;',
        '    --cron) CRON=$2; shift 2 ;;',
        '    --new-owner) NEW_OWNER=$2; shift 2 ;;',
        '    --from-owner) FROM_OWNER=$2; shift 2 ;;',
        '    --orphans) ORPHANS=1; shift ;;',
        '    --type) TYPE=$2; shift 2 ;;',
        '    --out) OUT=$2; shift 2 ;;',
        '    --max-mb) MAX_MB=$2; shift 2 ;;',
        '    --retention-days) RETENTION_DAYS=$2; shift 2 ;;',
        '    --datatype) DATATYPE=$2; shift 2 ;;',
        '    --scheduled) SCHEDULED=1; shift ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        'TOKEN_FILE=${TOKEN_FILE/#\\~/$HOME}; LOG_DIR=${LOG_DIR/#\\~/$HOME}',
        '[ "$ALL_APPS" = 1 ] && APP=""',
        '',
        ...bashPrelude(),
        'case "$CMD" in help|-h|--help) sed -n "2,20p" "$0"; exit 0 ;; esac',
        'load_token',
        'mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"',
        'LOG="$LOG_DIR/$(date +%Y%m%d-%H%M%S)-$CMD.log"',
        'log() { printf "%s %s\\n" "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }',
        'mode() { [ "$EXECUTE" = 1 ] && echo EXECUTE || echo DRY-RUN; }',
        '',
        '# A wildcard is refused across all apps unless it was asked for by name.',
        'guard_scope() {',
        '  case "$NAME" in',
        '    *[*?]*) [ -n "$APP" ] || [ "$ALL_APPS" = 1 ] || die "a pattern needs --app, or --all-apps to mean it" ;;',
        '  esac',
        '  if [ -z "$APP" ] && [ "$ALL_APPS" != 1 ]; then die "no app scope: give --app, or --all-apps to mean every app"; fi',
        '}',
        'app_ns() { [ -n "$APP" ] && enc "$APP" || echo "-"; }',
        '',
        'endpoint_for() {',
        '  case "$1" in',
        '    savedsearch) echo saved/searches ;;',
        '    view) echo data/ui/views ;;',
        '    macro) echo admin/macros ;;',
        '    *) die "unknown --type $1 (savedsearch, view, macro)" ;;',
        '  esac',
        '}',
        '',
        '# TSV: name app owner sharing disabled cron link. An empty field is written as',
        '# "-": a tab is IFS whitespace to read, so an empty cron would otherwise',
        '# collapse and shift the link into the cron column.',
        '# /servicesNS/-/APP/... also returns objects that OTHER apps share globally',
        '# (sharing=global, e.g. every ES correlation search). --app means objects that',
        '# live IN that app, so anything whose acl.app differs is dropped here, before',
        '# any command can act on it. --all-apps (APP empty) keeps everything.',
        '# The body goes to a file first so an HTTP or JSON error stops the script',
        '# instead of vanishing inside a pipe or a process substitution.',
        'objects() {',
        '  local ep; ep=$(endpoint_for "$1")',
        '  api GET "/servicesNS/-/$(app_ns)/$ep?count=0&output_mode=json" > "$WORK/objects.json"',
        '  jq -r --arg app "$APP" \'.entry[] | select($app == "" or .acl.app == $app) | [.name, .acl.app, .acl.owner, .acl.sharing, (.content.disabled|tostring), (.content.cron_schedule // ""), .links.alternate] | map(if . == null or . == "" then "-" else tostring end) | @tsv\' "$WORK/objects.json"',
        '}',
        '',
        'matches() { [ -z "$NAME" ] && return 0; [[ $1 == $NAME ]]; }',
        '',
        'toggle_search() {',
        '  local want=$1 n a o s d c link hits=0',
        '  [ -n "$NAME" ] || die "--name is required"',
        '  guard_scope',
        '  objects savedsearch > "$WORK/searches.tsv"',
        '  while IFS=$\'\\t\' read -r n a o s d c link; do',
        '    matches "$n" || continue',
        '    hits=$((hits+1))',
        '    local target; [ "$want" = disable ] && target=true || target=false',
        '    if [ "$d" = "$target" ]; then echo "unchanged  $a/$n (already ${want}d)"; continue; fi',
        '    echo "$(mode)  $want  $a/$n  owner=$o"',
        '    log "before $a/$n disabled=$d"',
        '    if [ "$EXECUTE" = 1 ]; then',
        '      api POST "$link/$want" -o /dev/null',
        '      log "after  $a/$n disabled=$target"',
        '      log "undo   $0 $([ "$want" = disable ] && echo enable-search || echo disable-search) --app $(printf %q "$a") --name $(printf %q "$n")"',
        '    fi',
        '  done < "$WORK/searches.tsv"',
        '  [ "$hits" -gt 0 ] || die "no saved search matches $NAME"',
        '}',
        '',
        'orphans() {',
        '  local ep; ep=$(endpoint_for "$TYPE")',
        '  api GET "/services/authentication/users?count=0&output_mode=json" | jq -r \'.entry[].name\' > "$WORK/users"',
        '  echo nobody >> "$WORK/users"',
        '  objects "$TYPE" > "$WORK/owned.tsv"',
        '  while IFS=$\'\\t\' read -r n a o s d c link; do',
        '    grep -qxF "$o" "$WORK/users" || printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$n" "$a" "$o" "$s" "$d" "$c" "$link"',
        '  done < "$WORK/owned.tsv"',
        '}',
        '',
        'case "$CMD" in',
        '  list-searches)',
        '    objects savedsearch | if [ "$SCHEDULED" = 1 ]; then awk -F"\\t" \'$6 != "-"\'; else cat; fi |',
        '      awk -F"\\t" \'BEGIN{printf "%-40s %-20s %-15s %-8s %s\\n","NAME","APP","OWNER","DISABLED","CRON"} {printf "%-40s %-20s %-15s %-8s %s\\n",$1,$2,$3,$5,$6}\'',
        '    ;;',
        '  disable-search) toggle_search disable ;;',
        '  enable-search) toggle_search enable ;;',
        '  set-schedule)',
        '    [ -n "$NAME" ] && [ -n "$CRON" ] || die "--name and --cron are required"',
        '    case "$NAME" in *[*?]*) die "set-schedule takes one exact name" ;; esac',
        '    guard_scope',
        '    found=0',
        '    objects savedsearch > "$WORK/searches.tsv"',
        '    while IFS=$\'\\t\' read -r n a o s d c link; do',
        '      [ "$n" = "$NAME" ] || continue; found=1',
        '      echo "$(mode)  $a/$n  cron: \'$c\' -> \'$CRON\'"',
        '      log "before $a/$n cron_schedule=$c"',
        '      if [ "$EXECUTE" = 1 ]; then',
        '        api POST "$link" --data-urlencode "cron_schedule=$CRON" -o /dev/null',
        '        log "after  $a/$n cron_schedule=$CRON"',
        '        if [ "$c" = - ]; then log "undo   (it had no cron_schedule) curl -X POST <url>$link --data-urlencode cron_schedule="',
        '        else log "undo   $0 set-schedule --app $(printf %q "$a") --name $(printf %q "$n") --cron $(printf %q "$c")"; fi',
        '      fi',
        '    done < "$WORK/searches.tsv"',
        '    [ "$found" = 1 ] || die "no saved search named $NAME"',
        '    ;;',
        '  orphans)',
        '    orphans | awk -F"\\t" \'BEGIN{printf "%-40s %-20s %-20s %s\\n","NAME","APP","MISSING OWNER","SHARING"} {printf "%-40s %-20s %-20s %s\\n",$1,$2,$3,$4}\'',
        '    ;;',
        '  reassign)',
        '    [ -n "$NEW_OWNER" ] || die "--new-owner is required"',
        '    [ "$ORPHANS" = 1 ] || [ -n "$FROM_OWNER" ] || die "give --orphans or --from-owner USER"',
        '    guard_scope',
        '    api GET "/services/authentication/users/$(enc "$NEW_OWNER")?output_mode=json" -o /dev/null || die "user $NEW_OWNER does not exist"',
        '    if [ "$ORPHANS" = 1 ]; then orphans; else objects "$TYPE" | awk -F"\\t" -v u="$FROM_OWNER" \'$3 == u\'; fi > "$WORK/targets"',
        '    [ -s "$WORK/targets" ] || { echo "nothing to reassign"; exit 0; }',
        '    while IFS=$\'\\t\' read -r n a o s d c link; do',
        '      matches "$n" || continue',
        '      # A private (user) object cannot move to a new owner as private and stay',
        '      # visible to anyone else; it becomes app-shared. The undo records the original.',
        '      share=$s; [ "$share" = user ] && share=app',
        '      echo "$(mode)  $TYPE $a/$n  owner $o -> $NEW_OWNER  sharing $s -> $share"',
        '      log "before $TYPE $a/$n owner=$o sharing=$s"',
        '      if [ "$EXECUTE" = 1 ]; then',
        '        api POST "$link/acl" --data-urlencode "owner=$NEW_OWNER" --data-urlencode "sharing=$share" -o /dev/null',
        '        log "after  $TYPE $a/$n owner=$NEW_OWNER sharing=$share"',
        '        log "undo   curl -X POST <url>$link/acl -d owner=$o -d sharing=$s   (restores the previous owner; a deleted owner makes it orphaned again)"',
        '      fi',
        '    done < "$WORK/targets"',
        '    ;;',
        '  rotate-hec)',
        '    [ -n "$NAME" ] && [ -n "$OUT" ] || die "--name and --out are required"',
        '    [ -e "$OUT" ] && die "$OUT exists; refusing to overwrite"',
        '    api GET "/services/data/inputs/http/$(enc "$NAME")?output_mode=json" > "$WORK/old.json" || die "no HEC token named $NAME"',
        '    NEW="\${NAME}_$(date +%Y%m%d)"',
        '    jq -r \'.entry[0].content | "index=\\(.index // "") indexes=\\((.indexes // []) | join(",")) sourcetype=\\(.sourcetype // "") useACK=\\(.useACK // false)"\' "$WORK/old.json" | sed "s/^/  current: /"',
        '    echo "$(mode)  create HEC token $NEW with the same index, indexes, sourcetype and useACK"',
        '    log "before hec $NAME exists; new $NEW"',
        '    if [ "$EXECUTE" = 1 ]; then',
        '      args=(--data-urlencode "name=$NEW")',
        '      while IFS= read -r kv; do [ -n "$kv" ] && args+=(--data-urlencode "$kv"); done < <(jq -r \'.entry[0].content | (if .index then "index=\\(.index)" else empty end), (if (.indexes|length) > 0 then "indexes=\\(.indexes|join(","))" else empty end), (if .sourcetype then "sourcetype=\\(.sourcetype)" else empty end), "useACK=\\(if .useACK then 1 else 0 end)"\' "$WORK/old.json")',
        '      api POST "/services/data/inputs/http?output_mode=json" "${args[@]}" > "$WORK/new.json"',
        '      # The new token value goes straight from the response to a mode-600 file.',
        '      # jq -e with // empty fails on a missing or null token instead of writing',
        '      # the word "null"; the value lands in a private temp file next to $OUT and',
        '      # is only renamed into place once it is known to be non-empty.',
        '      tmp_out=$(mktemp "$(dirname -- "$OUT")/.hec-token.XXXXXX")',
        '      chmod 600 "$tmp_out"',
        '      if ! jq -er \'.entry[0].content.token // empty\' "$WORK/new.json" > "$tmp_out" || [ ! -s "$tmp_out" ]; then',
        '        rm -f "$tmp_out"',
        '        log "error  hec $NEW: create returned no token value; check it with GET /services/data/inputs/http/$NEW"',
        '        die "Splunk did not return a token value for $NEW (it may still have been created: check GET /services/data/inputs/http/$NEW)"',
        '      fi',
        '      mv -f -- "$tmp_out" "$OUT"',
        '      log "after  hec $NEW created; value written to $OUT"',
        '      log "undo   curl -X DELETE <url>/services/data/inputs/http/$NEW"',
        '      echo "New token $NEW written to $OUT. Move the senders, then: $0 retire-hec --name $(printf %q "$NAME")"',
        '    fi',
        '    ;;',
        '  retire-hec)',
        '    [ -n "$NAME" ] || die "--name is required"',
        '    echo "$(mode)  disable HEC token $NAME"',
        '    log "before hec $NAME enabled"',
        '    if [ "$EXECUTE" = 1 ]; then',
        '      api POST "/services/data/inputs/http/$(enc "$NAME")/disable" -o /dev/null',
        '      log "after  hec $NAME disabled"',
        '      log "undo   curl -X POST <url>/services/data/inputs/http/$NAME/enable"',
        '    fi',
        '    ;;',
        '  create-index)',
        '    [ -n "$NAME" ] || die "--name is required"',
        '    # A missing mode is an error, not "standalone": creating an index through REST on',
        '    # a cluster peer or manager puts it outside the bundle.',
        '    api GET "/services/cluster/config?output_mode=json" > "$WORK/cluster.json"',
        '    cm=$(jq -er \'.entry[0].content.mode // empty\' "$WORK/cluster.json") || die "could not read the clustering mode from /services/cluster/config"',
        '    case "$cm" in disabled) ;; *) die "this instance is a cluster $cm: indexes go in the cluster bundle (manager-apps), not through REST" ;; esac',
        '    if api GET "/services/data/indexes/$(enc "$NAME")?output_mode=json" -o /dev/null 2>/dev/null; then die "index $NAME already exists"; fi',
        '    args=(--data-urlencode "name=$NAME" --data-urlencode "datatype=$DATATYPE")',
        '    [ -n "$MAX_MB" ] && args+=(--data-urlencode "maxTotalDataSizeMB=$MAX_MB")',
        '    [ -n "$RETENTION_DAYS" ] && args+=(--data-urlencode "frozenTimePeriodInSecs=$((RETENTION_DAYS*86400))")',
        '    echo "$(mode)  create $DATATYPE index $NAME max=\${MAX_MB:-default}MB retention=\${RETENTION_DAYS:-default}d in app \${APP:-search}"',
        '    if [ "$EXECUTE" = 1 ]; then',
        '      api POST "/servicesNS/nobody/$(enc "\${APP:-search}")/data/indexes" "${args[@]}" -o /dev/null',
        '      log "after  index $NAME created"',
        '      log "undo   (removing an index deletes its data) curl -X DELETE <url>/services/data/indexes/$NAME"',
        '    fi',
        '    ;;',
        '  *) die "unknown command $CMD (try --help)" ;;',
        'esac',
        '[ -s "$LOG" ] && echo "Logged to $LOG"',
        '[ "$EXECUTE" = 1 ] || echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        'exit 0',
      ];

      const pwsh = [
        '#Requires -Version 7.0',
        '<#',
        '  Splunk day-2 REST operations (PowerShell 7). Same commands as splunk-rest-ops.sh.',
        '  Applies when run; -DryRun previews. Every change is logged with its undo to -LogDir.',
        '',
        '  ./SplunkRestOps.ps1 -Command list-searches -App search',
        '  ./SplunkRestOps.ps1 -Command disable-search -App search -Name "Old *" -DryRun',
        '  ./SplunkRestOps.ps1 -Command reassign -Orphans -NewOwner svc_splunk -App search',
        '#>',
        '[CmdletBinding()]',
        'param(',
        '  [Parameter(Mandatory)][ValidateSet("list-searches","disable-search","enable-search","set-schedule","orphans","reassign","rotate-hec","retire-hec","create-index")][string]$Command,',
        `  [string]$Url = ${psq(url)},`,
        `  [string]$TokenFile = ${psq(tokenFile)},`,
        `  [string]$App = ${psq(defaultApp)},`,
        `  [string]$LogDir = ${psq(logDir)},`,
        '  [switch]$AllApps,',
        '  [string]$Name,',
        '  [string]$Cron,',
        '  [string]$NewOwner,',
        '  [string]$FromOwner,',
        '  [switch]$Orphans,',
        '  [ValidateSet("savedsearch","view","macro")][string]$Type = "savedsearch",',
        '  [string]$Out,',
        '  [int]$MaxMB,',
        '  [int]$RetentionDays,',
        '  [ValidateSet("event","metric")][string]$Datatype = "event",',
        '  [switch]$Scheduled,',
        '  [switch]$DryRun',
        ')',
        'Set-StrictMode -Version Latest',
        '$ErrorActionPreference = "Stop"',
        '$Execute = -not $DryRun',
        'if ($AllApps) { $App = "" }',
        '$TokenFile = $TokenFile -replace "^~", $HOME',
        '$LogDir = $LogDir -replace "^~", $HOME',
        '',
        '# Refuse a token file anyone else can read.',
        'function Assert-Private([string]$Path) {',
        '  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "not found: $Path" }',
        '  if ($IsWindows) {',
        '    $open = (Get-Acl -LiteralPath $Path).Access | Where-Object { $_.AccessControlType -eq "Allow" -and $_.IdentityReference -match "Everyone|BUILTIN\\\\Users|Authenticated Users" }',
        '    if ($open) { throw "$Path is readable by $($open[0].IdentityReference). Restrict it to your account first." }',
        '  } else {',
        '    $mode = (& stat -c %a $Path 2>$null)',
        '    if (-not $mode) { $mode = (& stat -f %Lp $Path) }',
        '    if ($mode -notin @("600","400")) { throw "$Path is mode $mode. Run: chmod 600 $Path" }',
        '  }',
        '}',
        '',
        'Assert-Private $TokenFile',
        '$token = (Get-Content -LiteralPath $TokenFile -TotalCount 1).Trim()',
        'if (-not $token) { throw "$TokenFile is empty" }',
        '# The header lives in memory only — never a command-line argument.',
        '$Headers = @{ Authorization = "Bearer $token" }',
        'Remove-Variable token',
        '',
        'New-Item -ItemType Directory -Force -Path $LogDir | Out-Null',
        '$Log = Join-Path $LogDir ("{0}-{1}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $Command)',
        'function Write-Log([string]$Text) { Add-Content -LiteralPath $Log -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString("s"), $Text) }',
        '$Mode = if ($Execute) { "EXECUTE" } else { "DRY-RUN" }',
        '',
        'function Invoke-Splunk([string]$Method, [string]$Path, [hashtable]$Body) {',
        '  $uri = if ($Path -match "^https?://") { $Path } else { "$Url$Path" }',
        '  $p = @{ Method = $Method; Uri = $uri; Headers = $Headers }',
        '  if ($Body) { $p.Body = $Body; $p.ContentType = "application/x-www-form-urlencoded" }',
        '  Invoke-RestMethod @p',
        '}',
        '',
        'function Assert-Scope {',
        '  if (-not $App -and -not $AllApps) { throw "no app scope: give -App, or -AllApps to mean every app" }',
        '}',
        '',
        'function Get-Objects([string]$Kind) {',
        '  $ep = @{ savedsearch = "saved/searches"; view = "data/ui/views"; macro = "admin/macros" }[$Kind]',
        '  $ns = if ($App) { [uri]::EscapeDataString($App) } else { "-" }',
        '  # /servicesNS/-/APP also returns objects other apps share globally; -App means',
        '  # objects that live IN that app, so the rest are dropped before anything acts.',
        '  (Invoke-Splunk GET "/servicesNS/-/$ns/$($ep)?count=0&output_mode=json").entry | Where-Object { -not $App -or $_.acl.app -eq $App } | ForEach-Object {',
        '    [pscustomobject]@{',
        '      Name = $_.name; App = $_.acl.app; Owner = $_.acl.owner; Sharing = $_.acl.sharing',
        '      Disabled = [bool]$_.content.disabled',
        '      Cron = if ($_.content.PSObject.Properties["cron_schedule"]) { $_.content.cron_schedule } else { "" }',
        '      Link = $_.links.alternate',
        '    }',
        '  }',
        '}',
        '',
        'function Get-Orphans {',
        '  $users = @((Invoke-Splunk GET "/services/authentication/users?count=0&output_mode=json").entry.name) + "nobody"',
        '  Get-Objects $Type | Where-Object { $_.Owner -notin $users }',
        '}',
        '',
        'function Test-Name([string]$n) { -not $Name -or $n -like $Name }',
        '',
        'switch ($Command) {',
        '  "list-searches" {',
        '    Get-Objects savedsearch | Where-Object { -not $Scheduled -or $_.Cron } | Format-Table Name, App, Owner, Disabled, Cron -AutoSize',
        '  }',
        '  { $_ -in "disable-search","enable-search" } {',
        '    if (-not $Name) { throw "-Name is required" }',
        '    Assert-Scope',
        '    $want = $Command.Split("-")[0]',
        '    $hits = @(Get-Objects savedsearch | Where-Object { Test-Name $_.Name })',
        '    if (-not $hits) { throw "no saved search matches $Name" }',
        '    foreach ($o in $hits) {',
        '      if ($o.Disabled -eq ($want -eq "disable")) { "unchanged  $($o.App)/$($o.Name)"; continue }',
        '      "$Mode  $want  $($o.App)/$($o.Name)  owner=$($o.Owner)"',
        '      Write-Log "before $($o.App)/$($o.Name) disabled=$($o.Disabled)"',
        '      if ($Execute) {',
        '        Invoke-Splunk POST "$($o.Link)/$want" | Out-Null',
        '        $undo = if ($want -eq "disable") { "enable-search" } else { "disable-search" }',
        '        Write-Log "after  $($o.App)/$($o.Name) disabled=$($want -eq \'disable\')"',
        '        Write-Log "undo   ./SplunkRestOps.ps1 -Command $undo -App \'$($o.App)\' -Name \'$($o.Name)\'"',
        '      }',
        '    }',
        '  }',
        '  "set-schedule" {',
        '    if (-not $Name -or -not $Cron) { throw "-Name and -Cron are required" }',
        '    if ($Name -match "[*?]") { throw "set-schedule takes one exact name" }',
        '    Assert-Scope',
        '    $o = Get-Objects savedsearch | Where-Object Name -eq $Name | Select-Object -First 1',
        '    if (-not $o) { throw "no saved search named $Name" }',
        '    "$Mode  $($o.App)/$($o.Name)  cron: \'$($o.Cron)\' -> \'$Cron\'"',
        '    Write-Log "before $($o.App)/$($o.Name) cron_schedule=$($o.Cron)"',
        '    if ($Execute) {',
        '      Invoke-Splunk POST $o.Link @{ cron_schedule = $Cron } | Out-Null',
        '      Write-Log "after  $($o.App)/$($o.Name) cron_schedule=$Cron"',
        '      Write-Log "undo   ./SplunkRestOps.ps1 -Command set-schedule -App \'$($o.App)\' -Name \'$($o.Name)\' -Cron \'$($o.Cron)\'"',
        '    }',
        '  }',
        '  "orphans" { Get-Orphans | Format-Table Name, App, Owner, Sharing -AutoSize }',
        '  "reassign" {',
        '    if (-not $NewOwner) { throw "-NewOwner is required" }',
        '    if (-not $Orphans -and -not $FromOwner) { throw "give -Orphans or -FromOwner" }',
        '    Assert-Scope',
        '    Invoke-Splunk GET "/services/authentication/users/$([uri]::EscapeDataString($NewOwner))?output_mode=json" | Out-Null',
        '    $targets = if ($Orphans) { Get-Orphans } else { Get-Objects $Type | Where-Object Owner -eq $FromOwner }',
        '    foreach ($o in @($targets | Where-Object { Test-Name $_.Name })) {',
        '      $share = if ($o.Sharing -eq "user") { "app" } else { $o.Sharing }',
        '      "$Mode  $Type $($o.App)/$($o.Name)  owner $($o.Owner) -> $NewOwner  sharing $($o.Sharing) -> $share"',
        '      Write-Log "before $Type $($o.App)/$($o.Name) owner=$($o.Owner) sharing=$($o.Sharing)"',
        '      if ($Execute) {',
        '        Invoke-Splunk POST "$($o.Link)/acl" @{ owner = $NewOwner; sharing = $share } | Out-Null',
        '        Write-Log "after  $Type $($o.App)/$($o.Name) owner=$NewOwner sharing=$share"',
        '        Write-Log "undo   POST $($o.Link)/acl owner=$($o.Owner) sharing=$($o.Sharing)"',
        '      }',
        '    }',
        '  }',
        '  "rotate-hec" {',
        '    if (-not $Name -or -not $Out) { throw "-Name and -Out are required" }',
        '    if (Test-Path -LiteralPath $Out) { throw "$Out exists; refusing to overwrite" }',
        '    $old = (Invoke-Splunk GET "/services/data/inputs/http/$([uri]::EscapeDataString($Name))?output_mode=json").entry[0].content',
        '    $new = "{0}_{1}" -f $Name, (Get-Date -Format "yyyyMMdd")',
        '    $body = @{ name = $new; useACK = [int][bool]$old.useACK }',
        '    if ($old.index) { $body.index = $old.index }',
        '    if ($old.indexes) { $body.indexes = ($old.indexes -join ",") }',
        '    if ($old.sourcetype) { $body.sourcetype = $old.sourcetype }',
        '    "$Mode  create HEC token $new  index=$($body.index) indexes=$($body.indexes) sourcetype=$($body.sourcetype)"',
        '    Write-Log "before hec $Name exists; new $new"',
        '    if ($Execute) {',
        '      $resp = Invoke-Splunk POST "/services/data/inputs/http?output_mode=json" $body',
        '      $value = $null',
        '      if ($resp -and $resp.PSObject.Properties["entry"] -and @($resp.entry).Count -gt 0 -and $resp.entry[0].content.PSObject.Properties["token"]) { $value = [string]$resp.entry[0].content.token }',
        '      if ([string]::IsNullOrWhiteSpace($value)) {',
        '        Write-Log "error  hec $($new): create returned no token value"',
        '        throw "Splunk did not return a token value for $new (it may still have been created: check GET /services/data/inputs/http/$new). Nothing written to $Out."',
        '      }',
        '      # Straight to a file only its owner can read; never to the console.',
        '      New-Item -ItemType File -Path $Out | Out-Null',
        '      if (-not $IsWindows) { & chmod 600 $Out }',
        '      else { $acl = Get-Acl $Out; $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")); Set-Acl $Out $acl }',
        '      Set-Content -LiteralPath $Out -Value $value -NoNewline',
        '      Write-Log "after  hec $new created; value written to $Out"',
        '      Write-Log "undo   DELETE /services/data/inputs/http/$new"',
        '      "New token $new written to $Out. Move the senders, then retire-hec -Name $Name"',
        '    }',
        '  }',
        '  "retire-hec" {',
        '    if (-not $Name) { throw "-Name is required" }',
        '    "$Mode  disable HEC token $Name"',
        '    if ($Execute) {',
        '      Invoke-Splunk POST "/services/data/inputs/http/$([uri]::EscapeDataString($Name))/disable" | Out-Null',
        '      Write-Log "after  hec $Name disabled"',
        '      Write-Log "undo   POST /services/data/inputs/http/$Name/enable"',
        '    }',
        '  }',
        '  "create-index" {',
        '    if (-not $Name) { throw "-Name is required" }',
        '    $cm = (Invoke-Splunk GET "/services/cluster/config?output_mode=json").entry[0].content.mode',
        '    if (-not $cm) { throw "could not read the clustering mode from /services/cluster/config" }',
        '    if ($cm -ne "disabled") { throw "this instance is a cluster $($cm): indexes go in the cluster bundle, not through REST" }',
        '    $body = @{ name = $Name; datatype = $Datatype }',
        '    if ($MaxMB) { $body.maxTotalDataSizeMB = $MaxMB }',
        '    if ($RetentionDays) { $body.frozenTimePeriodInSecs = $RetentionDays * 86400 }',
        '    $ns = if ($App) { $App } else { "search" }',
        '    "$Mode  create $Datatype index $Name in app $ns"',
        '    if ($Execute) {',
        '      Invoke-Splunk POST "/servicesNS/nobody/$([uri]::EscapeDataString($ns))/data/indexes" $body | Out-Null',
        '      Write-Log "after  index $Name created"',
        '      Write-Log "undo   (deletes the data) DELETE /services/data/indexes/$Name"',
        '    }',
        '  }',
        '}',
        'if ((Test-Path -LiteralPath $Log)) { "Logged to $Log" }',
        'if ($DryRun) { "Dry run: nothing was changed. Run it without -DryRun to apply." }',
      ];

      const orphanReport = [
        '[Orphaned scheduled searches]',
        'description = Scheduled searches whose owner no longer exists. They stop running (or run as nobody) and nobody is told. Reassign with ops/splunk-rest-ops.sh reassign --orphans.',
        '# add_orphan_field flags objects whose owner is not a current user — VERIFY on your version.',
        '# Report only; not scheduled.',
        'search = | rest /servicesNS/-/-/saved/searches splunk_server=local add_orphan_field=yes count=0 \\',
        '    | search orphan=1 is_scheduled=1 \\',
        '    | table title, eai:acl.app, eai:acl.owner, eai:acl.sharing, disabled, cron_schedule, next_scheduled_time',
        'dispatch.earliest_time = -1m',
        'dispatch.latest_time = now',
        'enableSched = 0',
        '',
        '[Knowledge objects by owner]',
        'description = Who owns what, before a user is removed. Anything owned by a leaving user is next month’s orphan.',
        'search = | rest /servicesNS/-/-/directory splunk_server=local count=0 \\',
        '    | stats count by eai:acl.owner, eai:acl.app, eai:type \\',
        '    | sort - count',
        'dispatch.earliest_time = -1m',
        'dispatch.latest_time = now',
        'enableSched = 0',
      ];

      return {
        tier: TIER,
        title: `REST operations kit for ${url.replace(/^https?:\/\//, '')}`,
        app,
        activation: 'reload',
        notes: [
          'The scripts run from an operator workstation or a jump host, not inside Splunk. The app itself carries only two reports (orphaned searches, objects by owner) for the search head.',
          'Authentication is a Splunk authentication token (Settings > Tokens, or the token lifecycle blueprint) in a mode-600 file. The header reaches curl through -H @file from a private temp directory, so the token never appears in ps output or shell history.',
          'Every command applies when run; add --dry-run (-DryRun) first to preview. Changes are logged before and after with the command that reverses them; keep the log with the change record.',
          'A name pattern (--name "Nightly *") across all apps is refused unless --all-apps is given — the same pattern in a dozen apps is how a quick clean-up disables someone else’s alert.',
          'HEC rotation creates a second token with the same settings and leaves the old one running, because senders cannot all switch at the same instant. retire-hec disables the old one once _internal shows no traffic on it. On a HEC tier behind a load balancer, tokens are distributed by the deployment server instead; rotate there.',
          'create-index refuses on a clustered indexer: cluster indexes go in the manager bundle (see the indexer blueprints).',
          'Minimum capabilities for the token’s user: list_settings, edit_search_schedule_*, admin_all_objects for reassigning, edit_token_http for HEC, indexes_edit for create-index. Give the ops account exactly what the commands you use need.',
        ],
        before: [
          `curl -sS -H @auth.h ${url}/services/server/info?output_mode=json | jq '.entry[0].content | {serverName, version}'`,
          '| rest /services/authentication/current-context splunk_server=local | table username, roles, capabilities',
          ...(shells !== 'pwsh' ? ['bash ops/splunk-rest-ops.sh list-searches --app search'] : []),
          ...(shells !== 'bash' ? ['pwsh ops/SplunkRestOps.ps1 -Command list-searches -App search'] : []),
        ],
        files: {
          ...(shells !== 'pwsh' ? { 'ops/splunk-rest-ops.sh': bash } : {}),
          ...(shells !== 'bash' ? { 'ops/SplunkRestOps.ps1': pwsh } : {}),
          'default/savedsearches.conf': orphanReport,
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          'bash ops/splunk-rest-ops.sh orphans --all-apps',
          `ls -l ${logDir}   # one log per executed command, with undo lines`,
          'index=_audit action=edit_* OR action=change_* user=<ops user> | table _time, user, action, object, info',
          'index=_internal sourcetype=splunkd_access method=POST uri_path=/servicesNS/* | stats count by user, uri_path',
        ],
        backout: [
          '# Each executed command wrote its own undo line: grep "^.* undo" <log-dir>/*.log and run them in reverse order.',
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # removes only the two reports`,
        ],
        findings,
      };
    },
  }),

  // 6. Authentication tokens ------------------------------------------------
  splunkBlueprint({
    id: 'splunk_tokens',
    tier: TIER,
    label: 'Authentication token lifecycle',
    group: 'Access',
    description: 'Token authentication switched on, tokens for service users created with an expiry and an audience and written straight to a mode-600 file, a daily report of what is about to expire, and revocation — without the token ever appearing on screen.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_tokens' },
      { id: 'splunk_url', label: 'Management URL', control: 'text', default: 'https://splunk-sh1.corp.example.com:8089' },
      { id: 'service_user', label: 'Service user', control: 'text', default: 'svc_automation' },
      { id: 'audience', label: 'Audience (what the token is for)', control: 'text', default: 'ci-pipeline' },
      { id: 'expires', label: 'Expires after', control: 'select', default: '+90d', options: [
        { value: '+30d', label: '30 days' },
        { value: '+90d', label: '90 days' },
        { value: '+180d', label: '180 days' },
        { value: '+365d', label: '1 year' },
        { value: 'never', label: 'Never' },
      ] },
      { id: 'not_before', label: 'Valid from', control: 'text', default: '', hint: 'Empty = now; or a relative time like +1d' },
      { id: 'warn_days', label: 'Report tokens expiring within (days)', control: 'number', default: 14, min: 1, max: 180 },
      { id: 'default_expiry', label: 'Default expiry for tokens created in the UI', control: 'select', default: '+30d', options: [
        { value: '+30d', label: '30 days' },
        { value: '+90d', label: '90 days' },
        { value: 'never', label: 'Never' },
      ] },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_tokens'), 'org_tokens');
      const url = str(values, 'splunk_url', 'https://localhost:8089').replace(/\/+$/, '');
      const user = str(values, 'service_user', 'svc_automation');
      const audience = str(values, 'audience', '');
      const expires = str(values, 'expires', '+90d');
      const notBefore = str(values, 'not_before', '');
      const warnDays = num(values, 'warn_days', 14);
      const defaultExpiry = str(values, 'default_expiry', '+30d');
      const findings            = [];

      if (expires === 'never') {
        findings.push(error('splunk.token-never-expires', 'A token that never expires is a password nobody rotates. When it leaks — in a CI log, a config repo — it works until someone happens to notice.', { remediation: 'Give it an expiry and rotate on a schedule; the expiring-tokens report tells you when.', source: 'ArchToolKit' }));
      } else if (expires === '+365d') {
        findings.push(warning('splunk.token-long-lived', 'A one-year token outlives most people’s memory of where it was put. 90 days with a rotation job is easier to live with.', { source: 'ArchToolKit' }));
      }
      if (defaultExpiry === 'never') {
        findings.push(warning('splunk.token-default-never', 'Tokens created in Settings > Tokens will not expire unless the creator remembers to set it.', { source: 'ArchToolKit' }));
      }
      if (!audience) {
        findings.push(warning('splunk.token-no-audience', 'No audience: the token’s purpose is not recorded, and a year from now nobody will know which system it belongs to or whether revoking it is safe.', { source: 'ArchToolKit' }));
      }
      if (/^(admin|splunk-system-user)$/i.test(user)) {
        findings.push(error('splunk.token-for-admin', `A token for ${user} carries every capability. A service integration should have its own user, with a role that holds only what it calls.`, { source: 'ArchToolKit' }));
      }
      if (!/^https:\/\//.test(url)) {
        findings.push(error('splunk.token-cleartext', 'The management URL is not HTTPS; a bearer token sent over it is readable by anyone on the path.', { source: 'ArchToolKit' }));
      }

      const script_ = [
        '#!/usr/bin/env bash',
        '# Splunk authentication tokens: enable, create, list, revoke. The token value',
        '# only ever goes from the REST response to a mode-600 file.',
        '#',
        '# usage: splunk-tokens.sh COMMAND [options] [--dry-run]',
        '#   enable                                    turn on token authentication',
        '#   create  --user U --audience A [--expires +90d] [--not-before +0d] --out FILE',
        '#   list    [--user U] [--expiring-days N]    exit 1 if any listed token expires within N days',
        '#   disable --user U --id TOKEN_ID            reversible',
        '#   revoke  --user U --id TOKEN_ID            deletes the token; not reversible',
        '#',
        '# Authenticate with --token-file F (an existing admin token, mode 600), or',
        '# --login-file F (mode 600: line 1 user name, line 2 password) for the first token.',
        'set -euo pipefail',
        `SPLUNK_URL=${shq(url)}`,
        'TOKEN_FILE=""; LOGIN_FILE=""; CA_FILE=""',
        'CMD=${1:-help}; [ $# -gt 0 ] && shift',
        `T_USER=${shq(user)}; AUDIENCE=${shq(audience)}; EXPIRES=${shq(expires)}; NOT_BEFORE=${shq(notBefore)}`,
        `OUT=""; ID=""; EXPIRING_DAYS=${warnDays}; EXECUTE=1; USER_FILTER=""`,
        'while [ $# -gt 0 ]; do',
        '  case $1 in',
        '    --url) SPLUNK_URL=$2; shift 2 ;;',
        '    --token-file) TOKEN_FILE=$2; shift 2 ;;',
        '    --login-file) LOGIN_FILE=$2; shift 2 ;;',
        '    --cacert) CA_FILE=$2; shift 2 ;;',
        '    --user) T_USER=$2; USER_FILTER=$2; shift 2 ;;',
        '    --audience) AUDIENCE=$2; shift 2 ;;',
        '    --expires) EXPIRES=$2; shift 2 ;;',
        '    --not-before) NOT_BEFORE=$2; shift 2 ;;',
        '    --out) OUT=$2; shift 2 ;;',
        '    --id) ID=$2; shift 2 ;;',
        '    --expiring-days) EXPIRING_DAYS=$2; shift 2 ;;',
        '    --dry-run) EXECUTE=0; shift ;;',
        '    *) printf "unknown option: %s\\n" "$1" >&2; exit 2 ;;',
        '  esac',
        'done',
        '',
        ...bashPrelude(),
        'case "$CMD" in help|-h|--help) sed -n "2,16p" "$0"; exit 0 ;; esac',
        '',
        '# Either a bearer token in a private header file, or basic credentials in a',
        '# private curl config — both read by curl from a file, never from argv.',
        'if [ -n "$TOKEN_FILE" ]; then',
        '  load_token',
        '  AUTH=(-H @"$WORK/auth.h")',
        'elif [ -n "$LOGIN_FILE" ]; then',
        '  check_private "$LOGIN_FILE"',
        '  { IFS= read -r LU; IFS= read -r LP; } < "$LOGIN_FILE" || true',
        '  LU=${LU%$\'\\r\'}; LP=${LP%$\'\\r\'}',
        '  [ -n "$LU" ] && [ -n "$LP" ] || die "$LOGIN_FILE needs a user name line and a password line"',
        '  esc() { local s=$1; s=${s//\\\\/\\\\\\\\}; s=${s//\\"/\\\\\\"}; printf \'%s\' "$s"; }',
        '  printf \'user = "%s:%s"\\n\' "$(esc "$LU")" "$(esc "$LP")" > "$WORK/login.cfg"',
        '  unset LU LP',
        '  AUTH=(-K "$WORK/login.cfg")',
        'else',
        '  die "give --token-file or --login-file"',
        'fi',
        'sapi() {',
        '  local method=$1 path=$2; shift 2',
        '  curl -sS --fail -X "$method" "${AUTH[@]}" ${CURL_TLS[@]+"${CURL_TLS[@]}"} "$SPLUNK_URL$path" "$@"',
        '}',
        'mode() { [ "$EXECUTE" = 1 ] && echo EXECUTE || echo DRY-RUN; }',
        '',
        'case "$CMD" in',
        '  enable)',
        '    sapi GET "/services/admin/token-auth/tokens_auth?output_mode=json" > "$WORK/state.json"',
        '    # A missing field is an error, not "not enabled".',
        '    state=$(jq -er \'.entry[0].content.disabled | if . == null then error("no disabled field in tokens_auth") else tostring end\' "$WORK/state.json") || die "could not read the token-auth state"',
        '    echo "token authentication disabled=$state"',
        '    [ "$state" = false ] && { echo "already enabled"; exit 0; }',
        '    echo "$(mode)  enable token authentication"',
        '    if [ "$EXECUTE" = 1 ]; then',
        '      sapi POST "/services/admin/token-auth/tokens_auth" --data-urlencode "disabled=false" -o /dev/null',
        '      echo "enabled"',
        '    fi',
        '    ;;',
        '  create)',
        '    [ -n "$T_USER" ] && [ -n "$AUDIENCE" ] && [ -n "$OUT" ] || die "--user, --audience and --out are required"',
        '    [ -e "$OUT" ] && die "$OUT exists; refusing to overwrite (revoke the old token after the new one is in use)"',
        '    [ "$EXPIRES" = never ] && note "warning: this token will never expire"',
        '    echo "$(mode)  create token for $T_USER  audience=$AUDIENCE  expires_on=$EXPIRES  not_before=\${NOT_BEFORE:-now}  -> $OUT"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    args=(--data-urlencode "name=$T_USER" --data-urlencode "audience=$AUDIENCE")',
        '    [ "$EXPIRES" != never ] && args+=(--data-urlencode "expires_on=$EXPIRES")',
        '    [ -n "$NOT_BEFORE" ] && args+=(--data-urlencode "not_before=$NOT_BEFORE")',
        '    sapi POST "/services/authorization/tokens?output_mode=json" "${args[@]}" > "$WORK/resp.json"',
        '    # Straight from the response to the file. Nothing is echoed. jq -e with',
        '    # // empty fails on a missing or null token instead of writing the word',
        '    # "null"; the value goes to a private temp file beside $OUT and is renamed',
        '    # into place only once it is known to be non-empty.',
        '    tmp_out=$(mktemp "$(dirname -- "$OUT")/.splunk-token.XXXXXX")',
        '    chmod 600 "$tmp_out"',
        '    if ! jq -er \'.entry[0].content.token // empty\' "$WORK/resp.json" > "$tmp_out" || [ ! -s "$tmp_out" ]; then',
        '      rm -f "$tmp_out"',
        '      die "no token value in the response (a token may still have been created: run list --user $T_USER and revoke it)"',
        '    fi',
        '    mv -f -- "$tmp_out" "$OUT"',
        '    jq -r \'.entry[0].content | "created id=\\(.id // "?")"\' "$WORK/resp.json"',
        '    echo "token written to $OUT (mode 600)"',
        '    ;;',
        '  list)',
        '    sapi GET "/services/authorization/tokens?count=0&output_mode=json" > "$WORK/list.json"',
        '    now=$(date +%s)',
        '    jq -r --arg u "$USER_FILTER" --argjson now "$now" --argjson days "$EXPIRING_DAYS" \'',
        '      .entry[] | .content as $c',
        '      | select($u == "" or $c.claims.sub == $u)',
        '      | ($c.claims.exp // 0) as $exp',
        '      | [.name, $c.claims.sub, ($c.claims.aud // ""), (if $exp == 0 then "never" else ($exp | todate) end),',
        '         (if $exp == 0 then "" elif $exp < $now then "EXPIRED" elif $exp < ($now + $days*86400) then "EXPIRING" else "" end),',
        '         ($c.status // ""), ($c.lastUsed // 0 | if . == 0 then "never" else todate end)] | @tsv\' "$WORK/list.json" > "$WORK/rows"',
        '    printf "%-36s %-18s %-16s %-21s %-9s %-9s %s\\n" ID USER AUDIENCE EXPIRES FLAG STATUS LAST_USED',
        '    awk -F"\\t" \'{printf "%-36s %-18s %-16s %-21s %-9s %-9s %s\\n",$1,$2,$3,$4,$5,$6,$7}\' "$WORK/rows"',
        '    # Column 5 is the flag. awk splits on a real tab (grep -E has no \\t).',
        '    awk -F"\\t" \'$5 == "EXPIRED" || $5 == "EXPIRING" { f = 1 } END { exit f ? 0 : 1 }\' "$WORK/rows" && exit 1',
        '    exit 0',
        '    ;;',
        '  disable|revoke)',
        '    [ -n "$T_USER" ] && [ -n "$ID" ] || die "--user and --id are required"',
        '    echo "$(mode)  $CMD token $ID of $T_USER"',
        '    [ "$EXECUTE" = 1 ] || exit 0',
        '    if [ "$CMD" = disable ]; then',
        '      sapi POST "/services/authorization/tokens/$(enc "$T_USER")" --data-urlencode "id=$ID" --data-urlencode "status=disabled" -o /dev/null',
        '      echo "disabled; re-enable with status=enabled"',
        '    else',
        '      sapi DELETE "/services/authorization/tokens/$(enc "$T_USER")?id=$(enc "$ID")" -o /dev/null',
        '      echo "revoked"',
        '    fi',
        '    ;;',
        '  *) die "unknown command $CMD (try --help)" ;;',
        'esac',
      ];

      const cron = spreadCron('Authentication tokens expiring soon', 1440);

      return {
        tier: TIER,
        title: `Authentication tokens: ${user} (${audience || 'no audience'}), expiry ${expires}`,
        app,
        activation: 'reload',
        notes: [
          'Tokens are JSON Web Tokens signed by the search head. Each carries its user, audience and expiry; revoking one takes effect at once. The user must exist and hold the role the integration needs — the token grants exactly that user’s capabilities.',
          `Creating a token for another user needs edit_tokens_all; for yourself, edit_tokens_own. The first token has to come from a password login: use --login-file (mode 600) once, then switch to a token file.`,
          'The token value is shown once. The script writes it from the response straight into a mode-600 file; move it into the consuming system’s secret store and delete the file.',
          'Rotation: create the new token with --out, update the consumer, confirm lastUsed moves to the new id (list), then revoke the old id. Two valid tokens at once is the normal state during rotation.',
          'In a search head cluster, tokens created on one member are valid on all (VERIFY that token-auth settings and the signing key are identical across members on your version).',
          'Splunk Cloud Platform: tokens are managed the same way on the search head REST port (8089 must be allowed through the IP allow list), or through ACS (acs tokens create).',
        ],
        before: [
          `curl -sS -H @auth.h ${url}/services/admin/token-auth/tokens_auth?output_mode=json | jq '.entry[0].content.disabled'`,
          `| rest /services/authentication/users/${user} splunk_server=local | table title, roles`,
          '| rest /services/authorization/tokens splunk_server=local count=0 | table title, claims.sub, claims.aud, claims.exp, status, lastUsed',
        ],
        files: {
          'default/authorize.conf': [
            '# Token authentication on, and a default lifetime for tokens created in',
            '# Settings > Tokens without an explicit expiry. VERIFY the setting names',
            '# against authorize.conf.spec for your version.',
            '[tokens_auth]',
            'disabled = false',
            `expiration = ${defaultExpiry}`,
          ],
          'default/savedsearches.conf': [
            '[Authentication tokens expiring soon]',
            `description = Enabled tokens that expire within ${warnDays} days, or have already expired. Rotate with ops/splunk-tokens.sh create, then revoke the old id.`,
            '# Field names from the tokens endpoint — VERIFY with | rest /services/authorization/tokens | fieldsummary.',
            'search = | rest /services/authorization/tokens splunk_server=local count=0 \\',
            '    | rename "claims.sub" as user, "claims.aud" as audience, "claims.exp" as exp \\',
            '    | where status="enabled" AND exp>0 \\',
            '    | eval days_left=round((exp-now())/86400,1), expires=strftime(exp,"%F %T") \\',
            `    | where days_left < ${warnDays} \\`,
            '    | table title, user, audience, expires, days_left, lastUsed \\',
            '    | sort days_left',
            'dispatch.earliest_time = -1m',
            'dispatch.latest_time = now',
            'enableSched = 1',
            `cron_schedule = ${cron}`,
            'counttype = number of events',
            'relation = greater than',
            'quantity = 0',
            'alert.track = 1',
            'alert.severity = 3',
            'alert.suppress = 1',
            'alert.suppress.period = 23h',
            '# Add an email or webhook action for the owning team.',
          ],
          'ops/splunk-tokens.sh': script_,
          'metadata/default.meta': defaultMeta(['admin'], ['admin']),
        },
        verify: [
          `bash ops/splunk-tokens.sh list --token-file ~/.splunk/admin.token --user ${user}; echo "exit $?"`,
          `curl -sS -H @<(printf 'Authorization: Bearer %s\\n' "$(cat /path/to/new.token)") ${url}/services/authentication/current-context?output_mode=json | jq -r '.entry[0].content.username'`,
          '| rest /services/authorization/tokens splunk_server=local count=0 | stats count by status',
          'index=_audit action=*token* | table _time, user, action, info',
          'index=_internal sourcetype=splunkd component=JsonWebToken log_level!=INFO | head 20',
        ],
        backout: [
          `bash ops/splunk-tokens.sh revoke --token-file ~/.splunk/admin.token --user ${user} --id <token id>`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # removes the report; token auth stays as set in system/local unless disabled there`,
          '# Disabling token authentication (tokens_auth disabled = true) stops every token at once — HEC is separate and unaffected.',
        ],
        findings,
      };
    },
  }),
];

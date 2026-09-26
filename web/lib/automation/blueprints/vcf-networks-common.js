/**
 * Shared pieces for the VCF Operations for Networks blueprints.
 *
 * Nothing here imports another blueprint file, so any Networks file can use it
 * without an import cycle. The login and the `ni` call helper live in
 * vcf-networks-logs.ts (networksApi), because the flow check and vcf-ops-build
 * already use them from there.
 *
 * Paths and bodies follow the VCF Operations for Networks API reference
 * (developer.broadcom.com/xapis/vcf-operations-for-networks-api, 9.0 / 9.1 /
 * 9.1.1 operation index).
 */

import { str,                                                              } from '../../kit/blueprint.js';
import { warning,              } from '../../core/findings.js';
import { listOf } from '../automation.js';

export const NET = 'vcf-operations-networks'         ;
export const NET_SRC = 'VCF Operations for Networks API reference';

/** The API reference, for IMPORT.md source lists. */
export const API_REF = 'VCF Operations for Networks API reference, operation index (developer.broadcom.com/xapis/vcf-operations-for-networks-api/latest/operation-index/), 9.1 and 9.1.1.';

/** A CSV cell: quoted when it holds a comma, quote or newline. */
export function csvCell(value        )         {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A value for a single-quoted shell word. */
export function shq(value        )         {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIpv4(text        )          {
  return IPV4.test(text.trim());
}

/** An IPv6 address, loosely: hex groups and colons, at most one "::". */
export function isIpv6(text        )          {
  const t = text.trim();
  if (!t.includes(':') || !/^[0-9a-fA-F:.]+$/.test(t)) return false;
  if ((t.match(/::/g) ?? []).length > 1) return false;
  const groups = t.split(':');
  return groups.length >= 3 && groups.length <= 8 && groups.every((g) => g.length <= 4 || IPV4.test(g));
}

export function isIp(text        )          {
  return isIpv4(text) || isIpv6(text);
}

/** A CIDR of either family, e.g. 10.0.0.0/8 or 2001:db8::/32. */
export function isCidr(text        )          {
  const [addr, bits, extra] = text.trim().split('/');
  if (extra !== undefined || addr === undefined || bits === undefined || !/^\d+$/.test(bits)) return false;
  if (isIpv4(addr)) return Number(bits) <= 32;
  if (isIpv6(addr)) return Number(bits) <= 128;
  return false;
}

/** An environment variable name derived from a value. */
export function envName(prefix        , value        )         {
  return `${prefix}_${value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/**
 * Rows of a " | " textarea. Blank lines and # comments are skipped; "-" in a
 * cell means empty (the grid editor needs something in every cell).
 */
export function pipeRows(text        , columns        )             {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      while (cells.length < columns) cells.push('');
      return cells.slice(0, columns).map((cell) => (cell === '-' ? '' : cell));
    });
}

export const SEVERITY_OPTIONS                          = [
  { value: 'Critical', label: 'Critical' },
  { value: 'Moderate', label: 'Moderate' },
  { value: 'Warning', label: 'Warning' },
  { value: 'Info', label: 'Info' },
];

// ---------------------------------------------------------------------------
// Notifications: e-mail, SNMP trap profile, syslog target, webhook (databus)
// ---------------------------------------------------------------------------

/**
 * The notification inputs every alert-raising Networks blueprint takes.
 *
 * Networks sends a user-defined alert by e-mail or SNMP trap
 * (notification_settings type EMAIL / SNMP), to any configured syslog target,
 * and — for a webhook — through a databus subscription on the "problems"
 * message group, which posts every problem event as JSON.
 */
export function notificationInputs(section = 'Notification')                   {
  return [
    { id: 'notify_email', label: 'E-mail to', control: 'text', default: 'netops@example.com', hint: 'Comma-separated addresses. Needs the mail server set in Networks', section },
    {
      id: 'email_frequency',
      label: 'E-mail frequency',
      control: 'select',
      options: [
        { value: 'IMMEDIATE', label: 'Immediately' },
        { value: 'DAILY', label: 'Daily digest' },
      ],
      default: 'IMMEDIATE',
      section,
    },
    { id: 'notify_snmp', label: 'SNMP trap receiver', control: 'text', default: '', hint: 'IP or FQDN (IPv6 accepted). Empty: no trap', section },
    { id: 'snmp_port', label: 'SNMP trap port', control: 'number', default: 162, min: 1, max: 65535, section },
    {
      id: 'snmp_version',
      label: 'SNMP version',
      control: 'select',
      options: [
        { value: 'v2c', label: 'v2c (community from VCFNET_TRAP_COMMUNITY)' },
        { value: 'v3', label: 'v3 (user, auth and privacy)' },
      ],
      default: 'v3',
      section,
    },
    { id: 'snmp_user', label: 'SNMP v3 user', control: 'text', default: 'vcfnet-traps', section, showWhen: { input: 'snmp_version', equals: ['v3'] } },
    { id: 'snmp_auth', label: 'SNMP v3 authentication', control: 'select', options: SNMP_AUTH, default: 'SHA', section, showWhen: { input: 'snmp_version', equals: ['v3'] } },
    { id: 'snmp_priv', label: 'SNMP v3 privacy', control: 'select', options: SNMP_PRIV, default: 'AES256', section, showWhen: { input: 'snmp_version', equals: ['v3'] } },
    { id: 'notify_syslog', label: 'Syslog target', control: 'text', default: '', hint: 'IP or FQDN, UDP 514. Empty: none', section },
    { id: 'notify_webhook', label: 'Webhook URL', control: 'text', default: '', hint: 'Posted every problem event (databus "problems"). Empty: none', section },
  ];
}

export const SNMP_AUTH                          = [
  { value: 'SHA', label: 'SHA' },
  { value: 'MD5', label: 'MD5 (weak)' },
  { value: 'NO_AUTH', label: 'None (noAuthNoPriv)' },
];

export const SNMP_PRIV                          = [
  { value: 'AES256', label: 'AES-256' },
  { value: 'AES192', label: 'AES-192' },
  { value: 'AES128', label: 'AES-128' },
  { value: '3DES', label: '3DES (weak)' },
  { value: 'DES', label: 'DES (weak)' },
  { value: 'NO_PRIV', label: 'None (authNoPriv)' },
];

                             
                            
                             
                                                                                                                                                                    
                          
                           
                                                                             
                         
                               
 

export function notifyPlan(values                 )             {
  const emails = listOf(str(values, 'notify_email', ''));
  const snmpTarget = str(values, 'notify_snmp', '');
  const version = str(values, 'snmp_version', 'v3');
  const auth = str(values, 'snmp_auth', 'SHA');
  const priv = str(values, 'snmp_priv', 'AES256');
  const syslog = str(values, 'notify_syslog', '');
  const webhook = str(values, 'notify_webhook', '');
  const findings            = [];
  const env           = [];
  if (snmpTarget) {
    if (!isIp(snmpTarget)) {
      findings.push(warning('vcfnet.notify.snmp-fqdn', `The trap profile's target_ip is documented as an IP address; "${snmpTarget}" is a name. Use the receiver's address if Networks rejects it.`, { source: NET_SRC }));
    }
    if (version === 'v2c') env.push('VCFNET_TRAP_COMMUNITY');
    else {
      if (auth !== 'NO_AUTH') env.push('VCFNET_TRAP_AUTH_PASSWORD');
      if (auth !== 'NO_AUTH' && priv !== 'NO_PRIV') env.push('VCFNET_TRAP_PRIV_PASSWORD');
    }
    if (version === 'v2c' || auth === 'MD5' || ['DES', '3DES'].includes(priv) || auth === 'NO_AUTH' || priv === 'NO_PRIV') {
      findings.push(warning('vcfnet.notify.weak-snmp', `The trap profile uses ${version === 'v2c' ? 'SNMP v2c (a clear-text community)' : `${auth}/${priv}`}. Traps carry object names and alert text.`, { remediation: 'SNMP v3 with SHA and AES is what the trap receiver should accept.', source: NET_SRC }));
    }
  }
  if (webhook && !/^https:\/\//i.test(webhook)) findings.push(warning('vcfnet.notify.webhook-http', 'The webhook is not HTTPS: every problem event would cross the network in clear text.', { source: NET_SRC }));
  if (/[?&](token|key|secret|sig|code)=/i.test(webhook)) findings.push(warning('vcfnet.notify.secret-in-url', 'The webhook URL carries a secret in its query string; it is stored in Networks and visible to every admin.', { source: NET_SRC }));
  return {
    emails,
    frequency: str(values, 'email_frequency', 'IMMEDIATE'),
    snmp: snmpTarget ? { target: snmpTarget, port: Number(values['snmp_port'] ?? 162) || 162, version, user: str(values, 'snmp_user', 'vcfnet-traps'), auth, priv } : undefined,
    syslog,
    webhook,
    env,
    findings,
  };
}

export function notifyDescribe(plan            )           {
  return [
    ...(plan.emails.length > 0 ? [`E-mail (${plan.frequency.toLowerCase()}) to ${plan.emails.join(', ')}.`] : []),
    ...(plan.snmp ? [`SNMP ${plan.snmp.version} trap to ${plan.snmp.target}:${plan.snmp.port}.`] : []),
    ...(plan.syslog ? [`Syslog to ${plan.syslog} (UDP 514).`] : []),
    ...(plan.webhook ? [`Every problem event posted to ${plan.webhook} (databus subscription, message group "problems").`] : []),
  ];
}

export function notifyAny(plan            )          {
  return plan.emails.length > 0 || plan.snmp !== undefined || plan.syslog !== '' || plan.webhook !== '';
}

/** The JSON a script reads to set the destinations up; no secret in it. */
export function notifyJson(plan            , nick        )                          {
  return {
    email: { receivers: plan.emails, frequency: plan.frequency },
    snmp_profile: plan.snmp
      ? {
          nick_name: nick,
          target_ip: plan.snmp.target,
          target_port: plan.snmp.port,
          snmp_version: plan.snmp.version,
          ...(plan.snmp.version === 'v3' ? { snmp_v3: { username: plan.snmp.user, context_name: '', authentication_type: plan.snmp.auth, privacy_type: plan.snmp.priv } } : { snmp_v2c: {} }),
        }
      : null,
    syslog: plan.syslog ? { ip_or_fqdn: plan.syslog, port: 514, protocol: 'UDP', nick_name: nick } : null,
    databus: plan.webhook ? { message_group: 'problems', url: plan.webhook } : null,
  };
}

/**
 * Shell functions that create the SNMP profile, syslog target and databus
 * subscription named in notify.json (each only when it does not exist), and
 * print the notification_settings array for the alert body on stdout.
 *
 * `camel` writes notificationSettings entries as the intent API spells them.
 */
export function notifyShell(file = 'notify.json')           {
  return [
    '# --- notification destinations ------------------------------------------',
    '# Each is looked up first and created only when missing, so a rerun changes',
    '# nothing. Secrets come from the environment through jq $ENV, never argv.',
    'setup_notify() {',
    `  local spec=${file} snmp_id=""`,
    '  if jq -e \'.snmp_profile\' "$spec" >/dev/null; then',
    '    local nick; nick=$(jq -r \'.snmp_profile.nick_name\' "$spec")',
    '    snmp_id=$(ni GET /settings/snmp/profiles | jq -r --arg n "$nick" \'[.. | objects | select(.nick_name? == $n) | (.entity_id // .id)] | first // empty\')',
    '    if [[ -z "$snmp_id" ]]; then',
    '      if (( DRY_RUN )); then echo "DRY RUN: would add SNMP trap profile $nick" >&2; snmp_id="<new>"; else',
    '        snmp_id=$(jq \'.snmp_profile',
    '          | if .snmp_version == "v2c" then .snmp_v2c.community_string = $ENV.VCFNET_TRAP_COMMUNITY',
    '            else (if .snmp_v3.authentication_type != "NO_AUTH" then .snmp_v3.authentication_password = $ENV.VCFNET_TRAP_AUTH_PASSWORD else . end)',
    '               | (if .snmp_v3.privacy_type != "NO_PRIV" and .snmp_v3.authentication_type != "NO_AUTH" then .snmp_v3.privacy_password = $ENV.VCFNET_TRAP_PRIV_PASSWORD else . end) end\' "$spec" \\',
    '          | ni POST /settings/snmp/profiles --data @- | jq -r \'.entity_id // .id // empty\')',
    '        echo "SNMP trap profile $nick: $snmp_id" >&2',
    '        ni POST /settings/snmp/profiles/send-test-trap --data "$(jq -n --arg id "$snmp_id" \'{entity_id: $id}\')" >/dev/null 2>&1 \\',
    '          && echo "  test trap sent" >&2 || echo "  VERIFY: test trap not sent; send one from Settings > SNMP" >&2',
    '      fi',
    '    else echo "SNMP trap profile $nick exists: $snmp_id" >&2; fi',
    '  fi',
    '  if jq -e \'.syslog\' "$spec" >/dev/null; then',
    '    local host; host=$(jq -r \'.syslog.ip_or_fqdn\' "$spec")',
    '    if ni GET /settings/syslog | jq -e --arg h "$host" \'[.. | objects | select(.ip_or_fqdn? == $h)] | length > 0\' >/dev/null; then',
    '      echo "syslog target $host exists" >&2',
    '    elif (( DRY_RUN )); then echo "DRY RUN: would add syslog target $host" >&2',
    '    else jq \'.syslog\' "$spec" | ni POST /settings/syslog --data @- >/dev/null && echo "syslog target $host added" >&2',
    '      ni POST /settings/syslog/send-test-log --data "$(jq \'.syslog | {ip_or_fqdn, port, protocol}\' "$spec")" >/dev/null 2>&1 || true',
    '    fi',
    '  fi',
    '  if jq -e \'.databus\' "$spec" >/dev/null; then',
    '    local url; url=$(jq -r \'.databus.url\' "$spec")',
    '    if ni GET /settings/databus/subscribers | jq -e --arg u "$url" \'[.. | objects | select(.url? == $u and .message_group? == "problems")] | length > 0\' >/dev/null; then',
    '      echo "webhook subscription exists" >&2',
    '    elif (( DRY_RUN )); then echo "DRY RUN: would subscribe $url to problems" >&2',
    '    else jq \'.databus\' "$spec" | ni POST /settings/databus/subscribers --data @- >/dev/null && echo "webhook subscribed to problems" >&2',
    '    fi',
    '  fi',
    '  # The notification_settings array for the alert body.',
    '  jq -c --arg snmp "$snmp_id" \'[',
    '      (if (.email.receivers | length) > 0 then {type: "EMAIL", frequency: .email.frequency, receivers: .email.receivers, enabled: true} else empty end),',
    '      (if $snmp != "" then {type: "SNMP", frequency: "IMMEDIATE", receivers: [$snmp], enabled: true} else empty end)',
    '    ]\' "$spec"',
    '}',
  ];
}

/**
 * check_query and upsert_alert: run a search once to prove it parses, then
 * create or update a search-based alert by name and enable it.
 * POST/PUT /settings/alerts/search-based-alerts, POST .../{id}/enable.
 */
export function searchAlertShell()           {
  return [
    '# check_query QUERY: run it once (POST /search/ql); a query the search bar',
    '# rejects stops here, before any alert is written from it.',
    'check_query() {',
    '  local n',
    '  n=$(ni POST /search/ql --data "$(jq -n --arg q "$1" \'{query: $q, size: 1}\')" | jq -r \'.entity_list_response.total_count // .total_count // 0\') \\',
    '    || { echo "The search was rejected: $1" >&2; exit 2; }',
    '  echo "search \\"$1\\": ${n} result(s) now" >&2',
    '}',
    '# find_alert NAME: the id of the search-based alert with that name, or empty.',
    'find_alert() {',
    '  local list id',
    '  list=$(ni GET /settings/alerts/search-based-alerts)',
    '  id=$(jq -r --arg n "$1" \'[.. | objects | select(.alert_name? == $n) | .entity_id] | first // empty\' <<<"$list")',
    '  if [[ -z "$id" ]]; then',
    '    for c in $(jq -r \'.results[]?.entity_id // empty\' <<<"$list"); do',
    '      if ni GET "/settings/alerts/search-based-alerts/$c" | jq -e --arg n "$1" \'.alert_name == $n\' >/dev/null; then id="$c"; break; fi',
    '    done',
    '  fi',
    '  echo "$id"',
    '}',
    '# upsert_alert BODY.json NOTIFICATION_SETTINGS_JSON',
    'upsert_alert() {',
    '  local name id full',
    '  name=$(jq -r .alert_name "$1")',
    '  check_query "$(jq -r .search_criteria "$1")"',
    '  id=$(find_alert "$name")',
    '  full=$(jq --argjson ns "$2" \'. + {notification_settings: $ns}\' "$1")',
    '  if (( DRY_RUN )); then',
    '    echo "DRY RUN: would $([[ -n "$id" ]] && echo "update $id" || echo create) the alert \\"$name\\", enabled:"; echo "$full"; return 0',
    '  fi',
    '  if [[ -n "$id" ]]; then',
    '    ni PUT "/settings/alerts/search-based-alerts/$id" --data "$full" >/dev/null',
    '  else',
    '    id=$(ni POST /settings/alerts/search-based-alerts --data "$full" | jq -r \'.entity_id // empty\')',
    '    [[ -n "$id" ]] || id=$(find_alert "$name")',
    '  fi',
    '  ni POST "/settings/alerts/search-based-alerts/$id/enable" >/dev/null',
    '  echo "alert \\"$name\\": $id, enabled"',
    '  echo "$id" >> created-alert-ids.txt',
    '}',
  ];
}

/** Every secret the notification setup reads, checked before anything is sent. */
export function envCheck(vars                   )           {
  if (vars.length === 0) return [];
  return [
    'MISSING=()',
    `for v in ${vars.join(' ')}; do if [[ -n "\${!v:-}" ]]; then export "$v"; elif (( ! DRY_RUN )); then MISSING+=("$v"); fi; done`,
    '(( ${#MISSING[@]} == 0 )) || { printf "Set from your vault: %s\\n" "${MISSING[@]}" >&2; exit 2; }',
  ];
}

/** The manual step for e-mail: there is no mail-server API. */
export function mailServerStep(plan            )                                                   {
  if (plan.emails.length === 0) return undefined;
  return {
    heading: 'Mail server (once, by hand — there is no API for it)',
    lines: ['The API has no mail-server (SMTP) call. Once per instance: Settings > Mail Server (SMTP) > enter the relay, port, TLS and sender, then Send Test Mail. The e-mail notification above sends nothing until this is set.'],
  };
}

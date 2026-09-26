/**
 * DNS for the cutover (addendum A.7.2 step 9, A.7.1 DNS readiness, A.7.4):
 * `dns/records.csv`, `dns/dns.sh` and `ansible/windows-dns.yml`.
 *
 * `records.csv` has one row per record set:
 *   fqdn,type,old,new,ttl,provider,zone,private,item,zone_id,view
 * `new` is `@target` (the item's last `cutover` event: `data.targetIpv4`,
 * `targetIpv6` or `targetFqdn`) or fixed values; several values are
 * separated by `;`. Every workload with a name in a DNS zone of the settings
 * gets an A and an AAAA row; the AAAA row is skipped at run time when the
 * target has no IPv6 address. CNAME rows can be added by hand.
 *
 * `dns.sh check | ttl --set N | switch | revert` (options: --wave, --item,
 * --dry-run, --timeout). One function set per provider:
 *
 * | Provider | Read | Write |
 * |---|---|---|
 * | route53 | list-resource-record-sets | change-resource-record-sets UPSERT / DELETE from stdin, get-change until INSYNC |
 * | azure-dns, azure-private-dns | record-set <t> show | add-record / remove-record (--keep-empty-record-set), update --set ttl |
 * | cloud-dns | record-sets describe | record-sets create / update / delete (trailing dot) |
 * | oci-dns | record rrset get | record rrset update --items / delete (--scope PRIVATE --view-id) |
 * | windows-dns | dig @WINDOWS_DNS_SERVER | ansible/windows-dns.yml (ansible.windows.win_dns_record on the windows_dns group) |
 * | bind | dig @BIND_SERVER | nsupdate (TSIG from BIND_TSIG_KEYFILE, or atk_secret BIND_TSIG_KEY on stdin) |
 * | infoblox | WAPI GET record:a / aaaa / cname (record:host as a fallback) | PUT <_ref>, POST, DELETE; credentials only in `curl --config -` on stdin |
 *
 * Before a switch, the current values are recorded in
 * `status/dns/<wave>.json` (once: a re-run keeps the first record);
 * `revert` restores exactly those (and deletes a record that did not exist).
 *
 * Pure: no DOM, no file system.
 */

import { familyOf } from '../../../../core/ip.js';
import { info, warning,              } from '../../../../core/findings.js';
                                                  
import { renderYaml,                } from '../../../../ansible/yaml.js';
import { EXIT_CODES } from '../contract.js';
import { code, libPathFrom } from '../lib-sh.js';
                                               
import { CORE_PATHS,                  } from './common.js';

/** The DNS providers dns.sh drives: the settings' seven plus BIND (nsupdate), which `DnsProvider` does not list yet. */
                                                 
export const DNS_PROVIDERS                           = Object.freeze(['route53', 'azure-dns', 'azure-private-dns', 'cloud-dns', 'oci-dns', 'windows-dns', 'infoblox', 'bind']);

export const DNS_SOURCES                                          = Object.freeze({
  route53: 'https://docs.aws.amazon.com/cli/latest/reference/route53/change-resource-record-sets.html',
  'azure-dns': 'https://learn.microsoft.com/en-us/cli/azure/network/dns/record-set/a',
  'azure-private-dns': 'https://learn.microsoft.com/en-us/cli/azure/network/private-dns/record-set/a',
  'cloud-dns': 'https://docs.cloud.google.com/sdk/gcloud/reference/dns/record-sets/update',
  'oci-dns': 'https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/dns/record/rrset/update.html',
  'windows-dns': 'ansible.windows.win_dns_record (ansible.windows 3.8.0)',
  infoblox: 'https://ipam.illinois.edu/wapidoc/objects/record.a.html (a mirror of the WAPI reference; the WAPI version is a setting: verify on the NIOS release)',
  bind: 'https://bind9.readthedocs.io/en/latest/manpages.html#nsupdate-dynamic-dns-update-utility',
});

                                                   
                               
                        
                               
                                  
                                  
                       
                                   
                        
                            
                        
                           
                         
 

export const RECORDS_COLUMNS = Object.freeze(['fqdn', 'type', 'old', 'new', 'ttl', 'provider', 'zone', 'private', 'item', 'zone_id', 'view']         );
/** The TTL the cutover runs at (A.7.1: at or under 300 s, lowered at T−48 h). */
export const CUTOVER_TTL = 300;

const csvSafe = (s        )         => s.replace(/[,\r\n]+/g, ' ').trim();

/** The DNS rows for every workload of the manifest with a name in a configured zone. */
export function dnsRecords(ctx             )                                                {
  const rows                 = [];
  const findings            = [];
  const zones = ctx.settings.dnsZones;
  const noZone           = [];
  for (const i of ctx.manifest.items) {
    if (i.kind !== 'workload' || i.wave === null || CORE_PATHS.has(i.path)) continue;
    for (const d of i.dns) {
      if (!d.provider || !d.zone) { noZone.push(i.name); continue; }
      const z = zones.find((x) => x.zone.toLowerCase() === d.zone .toLowerCase() && x.provider === d.provider);
      const ips = i.source.ips ?? [];
      const base = {
        fqdn: d.fqdn.toLowerCase().replace(/\.$/, ''), ttl: CUTOVER_TTL, provider: d.provider                 , zone: d.zone.toLowerCase(),
        private: d.private ?? z?.private ?? false, item: i.id, ...(z?.zoneId ? { zoneId: z.zoneId } : {}), ...(z?.view ? { view: z.view } : {}),
      };
      rows.push({ ...base, type: 'A', old: ips.filter((ip) => familyOf(ip) === 4), new: ['@target'] });
      rows.push({ ...base, type: 'AAAA', old: ips.filter((ip) => familyOf(ip) === 6), new: ['@target'] });
    }
  }
  if (noZone.length) {
    findings.push(warning('exec.dns.no-zone', `${noZone.length} server name(s) are in no DNS zone of the execution settings, so dns/records.csv has no row for them: ${noZone.slice(0, 5).join(', ')}${noZone.length > 5 ? ' …' : ''}.`, { remediation: 'Add the zone (with its provider) in Execute › Settings, or add the rows to dns/records.csv by hand.' }));
  }
  const providers = [...new Set(rows.map((r) => r.provider))];
  if (providers.includes('infoblox')) findings.push(info('exec.dns.infoblox-wapi', 'Infoblox rows use WAPI v2.13.7 by default (INFOBLOX_WAPI_VERSION); verify the version your NIOS release serves.', { source: DNS_SOURCES.infoblox }));
  return { rows, findings };
}

export function renderRecordsCsv(rows                         )         {
  const sorted = [...rows].sort((a, b) => a.item.localeCompare(b.item) || a.fqdn.localeCompare(b.fqdn) || a.type.localeCompare(b.type));
  const lines = sorted.map((r) => [
    r.fqdn, r.type, r.old.join(';'), r.new.join(';'), String(r.ttl), r.provider, r.zone, r.private ? 'true' : 'false', r.item, r.zoneId ?? '', r.view ?? '',
  ].map(csvSafe).join(','));
  return `${[RECORDS_COLUMNS.join(','), ...lines].join('\n')}\n`;
}

/** What the controller needs for the providers in use. */
export function dnsNeeds(rows                         )             {
  const p = new Set(rows.map((r) => r.provider));
  const out             = [];
  if (p.has('route53')) out.push({ kind: 'command', name: 'aws', min: '2', why: 'Route 53 records' });
  if (p.has('azure-dns') || p.has('azure-private-dns')) out.push({ kind: 'command', name: 'az', why: 'Azure DNS records' });
  if (p.has('cloud-dns')) out.push({ kind: 'command', name: 'gcloud', why: 'Cloud DNS records' });
  if (p.has('oci-dns')) out.push({ kind: 'command', name: 'oci', why: 'OCI DNS records' });
  if (p.has('infoblox')) out.push({ kind: 'command', name: 'curl', why: 'the Infoblox WAPI' });
  if (p.has('windows-dns') || p.has('bind')) out.push({ kind: 'command', name: 'dig', why: 'reading Windows DNS and BIND records', install: 'dnf install bind-utils / apt install dnsutils' });
  if (p.has('bind')) out.push({ kind: 'command', name: 'nsupdate', why: 'BIND dynamic updates', install: 'dnf install bind-utils / apt install dnsutils' });
  if (p.has('windows-dns')) out.push({ kind: 'ansible-collection', name: 'ansible.windows', why: 'Windows DNS records (win_dns_record)' });
  return out;
}

// ---------------------------------------------------------------------------
// dns/dns.sh
// ---------------------------------------------------------------------------

const DNS_FILE = 'dns/dns.sh';

/** The text of `dns/dns.sh`. */
export function renderDnsSh()         {
  const lib = libPathFrom(DNS_FILE, 'atk.sh');
  return code`#!/usr/bin/env bash
# dns/dns.sh: the DNS records of the cutover (records.csv), for Route 53, Azure DNS and Private DNS, Cloud DNS,
# OCI DNS, Windows DNS (through Ansible on a DNS server), BIND (nsupdate) and Infoblox (WAPI).
#   dns.sh check  [--wave N] [--item ID]     every record exists and its TTL is at or under ${CUTOVER_TTL} s (exit 5 if not)
#   dns.sh ttl --set SECONDS [--wave N]       lower the TTL of the existing records (T-48 h), values unchanged
#   dns.sh switch --wave N [--item ID]        record the current values in status/dns/<wave>.json, then write the new ones
#   dns.sh revert --wave N [--item ID]        restore exactly the recorded values
# A and AAAA are both written when both exist; "@target" is the address the item's cutover reported.
# Credentials: cloud CLIs use their own chains; Infoblox INFOBLOX_HOST, INFOBLOX_USER and INFOBLOX_PASSWORD (atk_secret),
# sent to curl in a config on stdin, never as arguments; BIND BIND_SERVER and BIND_TSIG_KEYFILE, or BIND_TSIG_KEY
# (atk_secret, "hmac-sha256:name:secret") on nsupdate's stdin; Windows DNS WINDOWS_DNS_SERVER (for reading) and the
# windows_dns inventory group (for writing).
# Changes are made by default; --dry-run prints each change instead. Exit codes: 0 ok, 2 usage, 3 missing tool or
# credential, 5 check failed, 10 some records failed, 1 other.
set -Eeuo pipefail
DNS_VERB=""
DNS_SET_TTL=""
WAVE_ARGS=()
while (( $# )); do
  case "$1" in
    check|ttl|switch|revert)
      if [[ -z "$DNS_VERB" ]]; then DNS_VERB="$1"; else WAVE_ARGS+=("$1"); fi
      shift ;;
    --set)
      [[ "$\{2:-}" =~ ^[0-9]+$ ]] || { echo "--set needs seconds" >&2; exit ${EXIT_CODES.usage}; }
      DNS_SET_TTL="$2"; shift 2 ;;
    --wave|--item|--gate-override|--timeout)
      WAVE_ARGS+=("$1" "$\{2:-}"); shift
      if (( $# )); then shift; fi ;;
    *) WAVE_ARGS+=("$1"); shift ;;
  esac
done
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/${lib}"
atk_init_tool dns "$\{WAVE_ARGS[@]}"
[[ -n "$DNS_VERB" ]] || atk_usage "a verb is needed: check, ttl, switch or revert"
if [[ "$DNS_VERB" == ttl && -z "$DNS_SET_TTL" ]]; then atk_usage "ttl needs --set SECONDS"; fi
if [[ ( "$DNS_VERB" == switch || "$DNS_VERB" == revert ) && -z "$ATK_WAVE" ]]; then atk_usage "$DNS_VERB needs --wave"; fi
atk_need jq
if [[ -n "$ATK_WAVE" ]]; then atk_lock "dns-$ATK_WAVE"; fi

DNS_RECORDS="$\{ATK_DNS_RECORDS:-$ATK_HOME/dns/records.csv}"
DNS_STATE="$ATK_STATUS/dns/$\{ATK_WAVE:-all}.json"
DNS_INVENTORY="$\{ATK_ANSIBLE_INVENTORY:-$ATK_ROOT/ansible/inventory}"
DNS_ROWS=()
DNS_F=()
DNS_CUR=""
DNS_CUR_TTL=""
DNS_WHY=""
DNS_DATA=()
DNS_ERR=""
IB_READY=""
IB_PASS=""
IB_REFS=""
IB_HOST_REF=""

# ---------------------------------------------------------------- rows

dns_split() {
  local rest="$1"
  DNS_F=()
  while [[ "$rest" == *,* ]]; do
    DNS_F+=("$\{rest%%,*}")
    rest="$\{rest#*,}"
  done
  DNS_F+=("$rest")
}

dns_load() {
  [[ -f "$DNS_RECORDS" ]] || atk_die 1 "no $DNS_RECORDS: regenerate the kit"
  local -a lines=()
  local line item f matched lname
  local -A hit=()
  mapfile -t lines < "$DNS_RECORDS"
  for line in "$\{lines[@]}"; do
    line="$\{line%$'\r'}"
    [[ -n "$line" && "$line" != \#* && "$line" != fqdn,* ]] || continue
    dns_split "$line"
    (( $\{#DNS_F[@]} >= 9 )) || atk_die 1 "records.csv has a short row: $line"
    item="$\{DNS_F[8]:--}"
    if [[ -n "$ATK_WAVE" && "$\{ATK_ITEM_WAVE[$item]:-}" != "$ATK_WAVE" ]]; then continue; fi
    if (( $\{#ATK_ITEM_FILTER[@]} )); then
      matched=0
      lname="$\{ATK_NAME[$item]:-}"
      for f in "$\{ATK_ITEM_FILTER[@]}"; do
        if [[ "$f" == "$item" || ( -n "$lname" && "$\{f,,}" == "$\{lname,,}" ) ]]; then matched=1; hit[$f]=1; fi
      done
      (( matched )) || continue
    fi
    DNS_ROWS+=("$line")
  done
  for f in "$\{ATK_ITEM_FILTER[@]}"; do
    [[ -n "$\{hit[$f]:-}" ]] || atk_log "no DNS record for \"$f\"$\{ATK_WAVE:+ in wave $ATK_WAVE}"
  done
  return 0
}

# dns_row LINE: the ROW_* variables of one records.csv row.
dns_row() {
  dns_split "$1"
  ROW_FQDN="$\{DNS_F[0],,}"
  ROW_FQDN="$\{ROW_FQDN%.}"
  ROW_TYPE="$\{DNS_F[1]^^}"
  ROW_OLD="$\{DNS_F[2]}"
  ROW_NEW="$\{DNS_F[3]}"
  ROW_TTL="$\{DNS_F[4]:-${CUTOVER_TTL}}"
  ROW_PROVIDER="$\{DNS_F[5]}"
  ROW_ZONE="$\{DNS_F[6],,}"
  ROW_ZONE="$\{ROW_ZONE%.}"
  ROW_PRIVATE=false
  if [[ "$\{DNS_F[7],,}" == true || "$\{DNS_F[7]}" == 1 ]]; then ROW_PRIVATE=true; fi
  ROW_ITEM="$\{DNS_F[8]:--}"
  ROW_ZONE_ID="$\{DNS_F[9]:-}"
  ROW_VIEW="$\{DNS_F[10]:-}"
  [[ "$ROW_TTL" =~ ^[0-9]+$ ]] || ROW_TTL=${CUTOVER_TTL}
  ROW_KEY="$ROW_FQDN|$ROW_TYPE|$ROW_PROVIDER"
  ROW_EV_ITEM="-"
  if [[ -n "$\{ATK_NAME[$ROW_ITEM]:-}" ]]; then ROW_EV_ITEM="$ROW_ITEM"; fi
}

# dns_norm: stdin values (one per line, or separated by spaces or ;) -> sorted, unique, lower case, no trailing dot, space separated.
dns_norm() {
  tr ' ;' '\n\n' | awk 'NF { v = tolower($1); sub(/\.$/, "", v); print v }' | sort -u | paste -sd' ' -
}

# dns_rel: the record's name relative to its zone ("@" for the apex).
dns_rel() {
  if [[ "$ROW_FQDN" == "$ROW_ZONE" ]]; then printf '@'; else printf '%s' "$\{ROW_FQDN%.$ROW_ZONE}"; fi
}

# dns_try VAR CMD...: stdout into VAR, stderr into DNS_ERR; the command's exit code.
dns_try() {
  local _var="$1" _err _out _rc=0
  shift
  atk_tmpfile _err
  _out="$("$@" 2> "$_err")" || _rc=$?
  DNS_ERR="$(head -c 400 "$_err")"
  printf -v "$_var" '%s' "$_out"
  return "$_rc"
}
dns_not_found() { [[ "$\{DNS_ERR,,}" =~ (not[[:space:]_-]?found|does[[:space:]]not[[:space:]]exist|404|no[[:space:]]such) ]]; }

# dns_target ITEM TYPE: the address the item's cutover reported (latest succeeded cutover event; a dry run's only in a dry run).
dns_target() {
  local key file="$ATK_STATUS/events.jsonl"
  case "$2" in A) key=targetIpv4 ;; AAAA) key=targetIpv6 ;; CNAME) key=targetFqdn ;; *) return 0 ;; esac
  [[ -f "$file" ]] || return 0
  jq -r --arg id "$1" --arg key "$key" --argjson dry "$ATK_DRY_RUN" \
    'select(.item == $id and .step == "cutover" and .outcome == "succeeded" and (.dryRun == false or $dry == 1) and ((.data // {})[$key] // null) != null) | .data[$key] | tostring' \
    "$file" | tail -n 1
}

dns_need() {
  case "$ROW_PROVIDER" in
    route53) atk_need aws ;;
    azure-dns|azure-private-dns) atk_need az ;;
    cloud-dns) atk_need gcloud ;;
    oci-dns) atk_need oci ;;
    windows-dns)
      atk_need dig
      if (( ! ATK_DRY_RUN )) && [[ "$DNS_VERB" != check ]]; then
        atk_need ansible-playbook
      fi ;;
    bind)
      atk_need dig
      if (( ! ATK_DRY_RUN )) && [[ "$DNS_VERB" != check ]]; then
        atk_need nsupdate
      fi ;;
    infoblox) atk_need curl ;;
    *) atk_log "unknown DNS provider \"$ROW_PROVIDER\" for $ROW_FQDN"; return 1 ;;
  esac
}

# ---------------------------------------------------------------- Route 53

r53_zone() {
  if [[ -n "$ROW_ZONE_ID" ]]; then printf '%s' "$\{ROW_ZONE_ID##*/}"; return 0; fi
  aws route53 list-hosted-zones-by-name --dns-name "$ROW_ZONE." --output json \
    | jq -r --arg z "$ROW_ZONE." --argjson p "$ROW_PRIVATE" '[.HostedZones[] | select((.Name | ascii_downcase) == $z and .Config.PrivateZone == $p)][0].Id // empty' \
    | sed 's#.*/##'
}
route53_get() {
  local zone out
  zone="$(r53_zone)" || return 1
  [[ -n "$zone" ]] || { DNS_ERR="no Route 53 hosted zone $ROW_ZONE"; return 1; }
  dns_try out aws route53 list-resource-record-sets --hosted-zone-id "$zone" --start-record-name "$ROW_FQDN." --start-record-type "$ROW_TYPE" --max-items 1 --output json || return 1
  DNS_CUR="$(jq -r --arg n "$ROW_FQDN." --arg t "$ROW_TYPE" '.ResourceRecordSets[] | select((.Name | ascii_downcase) == $n and .Type == $t) | .ResourceRecords[]?.Value' <<< "$out" | dns_norm)"
  DNS_CUR_TTL="$(jq -r --arg n "$ROW_FQDN." --arg t "$ROW_TYPE" '[.ResourceRecordSets[] | select((.Name | ascii_downcase) == $n and .Type == $t) | .TTL][0] // empty' <<< "$out")"
}
r53_insync() { [[ "$(aws route53 get-change --id "$1" --query ChangeInfo.Status --output text)" == INSYNC ]]; }
route53_change() {
  local action="$1" ttl="$2" values="$3" zone id
  zone="$(r53_zone)" || return 1
  [[ -n "$zone" ]] || { DNS_ERR="no Route 53 hosted zone $ROW_ZONE"; return 1; }
  id="$(jq -n --arg a "$action" --arg n "$ROW_FQDN." --arg t "$ROW_TYPE" --argjson ttl "$ttl" --arg v "$values" \
    '{Comment: "cutover", Changes: [{Action: $a, ResourceRecordSet: {Name: $n, Type: $t, TTL: $ttl, ResourceRecords: ($v | split(" ") | map(select(length > 0)) | map({Value: .}))}}]}' \
    | atk_run aws route53 change-resource-record-sets --hosted-zone-id "$zone" --change-batch file:///dev/stdin --query ChangeInfo.Id --output text)" || return 1
  if (( ATK_DRY_RUN )) || [[ -z "$id" ]]; then return 0; fi
  atk_wait_until 10 5 r53_insync "$id"
}
route53_put() { route53_change UPSERT "$1" "$2"; }
route53_del() { route53_change DELETE "$\{DNS_CUR_TTL:-${CUTOVER_TTL}}" "$DNS_CUR"; }

# ---------------------------------------------------------------- Azure DNS and Azure Private DNS

az_rg() {
  local z="$ROW_ZONE_ID"
  if [[ "$\{z,,}" == */resourcegroups/* ]]; then
    z="$(printf '%s' "$z" | sed -E 's#.*/[rR][eE][sS][oO][uU][rR][cC][eE][gG][rR][oO][uU][pP][sS]/([^/]+).*#\1#')"
    printf '%s' "$z"
  else
    printf '%s' "$\{z:-$\{AZURE_DNS_RESOURCE_GROUP:-}}"
  fi
}
az_kind() { if [[ "$ROW_PROVIDER" == azure-private-dns || "$ROW_PRIVATE" == true ]]; then printf 'private-dns'; else printf 'dns'; fi; }
az_value_flag() { case "$ROW_TYPE" in A) printf -- '--ipv4-address' ;; AAAA) printf -- '--ipv6-address' ;; CNAME) printf -- '--cname' ;; esac; }
azure_get() {
  local rg out t="$\{ROW_TYPE,,}"
  rg="$(az_rg)"
  [[ -n "$rg" ]] || { DNS_ERR="no resource group for zone $ROW_ZONE (zone_id in records.csv, or AZURE_DNS_RESOURCE_GROUP)"; return 1; }
  if ! dns_try out az network "$(az_kind)" record-set "$t" show -g "$rg" -z "$ROW_ZONE" -n "$(dns_rel)" -o json; then
    if dns_not_found; then DNS_CUR=""; DNS_CUR_TTL=""; return 0; fi
    return 1
  fi
  DNS_CUR="$(jq -r '((.aRecords // .arecords // []) | map(.ipv4Address)) + ((.aaaaRecords // .aaaarecords // []) | map(.ipv6Address)) + ([(.cnameRecord // .cnamerecord // {}).cname] | map(select(. != null))) | .[]' <<< "$out" | dns_norm)"
  DNS_CUR_TTL="$(jq -r '.ttl // .TTL // empty' <<< "$out")"
}
azure_put() {
  local ttl="$1" want="$2" rg kind t="$\{ROW_TYPE,,}" flag v
  rg="$(az_rg)"
  kind="$(az_kind)"
  flag="$(az_value_flag)"
  if [[ "$ROW_TYPE" == CNAME ]]; then
    atk_run az network "$kind" record-set cname set-record -g "$rg" -z "$ROW_ZONE" -n "$(dns_rel)" --cname "$want" -o none || return 1
  else
    for v in $want; do
      if [[ " $DNS_CUR " != *" $v "* ]]; then atk_run az network "$kind" record-set "$t" add-record -g "$rg" -z "$ROW_ZONE" -n "$(dns_rel)" "$flag" "$v" -o none || return 1; fi
    done
    for v in $DNS_CUR; do
      if [[ " $want " != *" $v "* ]]; then atk_run az network "$kind" record-set "$t" remove-record -g "$rg" -z "$ROW_ZONE" -n "$(dns_rel)" "$flag" "$v" --keep-empty-record-set -o none || return 1; fi
    done
  fi
  if [[ "$DNS_CUR_TTL" != "$ttl" ]]; then
    atk_run az network "$kind" record-set "$t" update -g "$rg" -z "$ROW_ZONE" -n "$(dns_rel)" --set "ttl=$ttl" -o none || return 1
  fi
}
azure_del() {
  local rg kind t="$\{ROW_TYPE,,}" flag v
  rg="$(az_rg)"
  kind="$(az_kind)"
  flag="$(az_value_flag)"
  for v in $DNS_CUR; do
    atk_run az network "$kind" record-set "$t" remove-record -g "$rg" -z "$ROW_ZONE" -n "$(dns_rel)" "$flag" "$v" -o none || return 1
  done
}

# ---------------------------------------------------------------- Cloud DNS

gcp_zone() {
  if [[ -n "$ROW_ZONE_ID" ]]; then printf '%s' "$ROW_ZONE_ID"; return 0; fi
  local vis=public
  if [[ "$ROW_PRIVATE" == true ]]; then vis=private; fi
  gcloud dns managed-zones list --filter="dnsName=$ROW_ZONE. AND visibility=$vis" --format='value(name)' | head -n 1
}
gcp_values() {
  local v out=""
  for v in $1; do
    if [[ "$ROW_TYPE" == CNAME ]]; then v="$v."; fi
    out+="$\{out:+,}$v"
  done
  printf '%s' "$out"
}
google_get() {
  local zone out
  zone="$(gcp_zone)" || return 1
  [[ -n "$zone" ]] || { DNS_ERR="no Cloud DNS managed zone for $ROW_ZONE"; return 1; }
  if ! dns_try out gcloud dns record-sets describe "$ROW_FQDN." --type="$ROW_TYPE" --zone="$zone" --format=json; then
    if dns_not_found; then DNS_CUR=""; DNS_CUR_TTL=""; return 0; fi
    return 1
  fi
  DNS_CUR="$(jq -r '.rrdatas[]?' <<< "$out" | dns_norm)"
  DNS_CUR_TTL="$(jq -r '.ttl // empty' <<< "$out")"
}
google_put() {
  local zone
  zone="$(gcp_zone)" || return 1
  if [[ -z "$DNS_CUR" ]]; then
    atk_run gcloud dns record-sets create "$ROW_FQDN." --type="$ROW_TYPE" --ttl="$1" --rrdatas="$(gcp_values "$2")" --zone="$zone"
  else
    atk_run gcloud dns record-sets update "$ROW_FQDN." --type="$ROW_TYPE" --ttl="$1" --rrdatas="$(gcp_values "$2")" --zone="$zone"
  fi
}
google_del() {
  local zone
  zone="$(gcp_zone)" || return 1
  atk_run gcloud dns record-sets delete "$ROW_FQDN." --type="$ROW_TYPE" --zone="$zone"
}

# ---------------------------------------------------------------- OCI DNS

oci_args() {
  OCI_ARGS=(--zone-name-or-id "$\{ROW_ZONE_ID:-$ROW_ZONE}" --domain "$ROW_FQDN" --rtype "$ROW_TYPE")
  if [[ "$ROW_PRIVATE" == true ]]; then
    OCI_ARGS+=(--scope PRIVATE)
    if [[ -n "$ROW_VIEW" ]]; then OCI_ARGS+=(--view-id "$ROW_VIEW"); fi
  fi
  if [[ -z "$ROW_ZONE_ID" && -n "$\{OCI_COMPARTMENT_ID:-}" ]]; then OCI_ARGS+=(--compartment-id "$OCI_COMPARTMENT_ID"); fi
  return 0
}
oci_get() {
  local out
  oci_args
  if ! dns_try out oci dns record rrset get "$\{OCI_ARGS[@]}"; then
    if dns_not_found; then DNS_CUR=""; DNS_CUR_TTL=""; return 0; fi
    return 1
  fi
  DNS_CUR="$(jq -r '.data.items[]?.rdata' <<< "$out" | dns_norm)"
  DNS_CUR_TTL="$(jq -r '.data.items[0].ttl // empty' <<< "$out")"
}
oci_put() {
  local items
  oci_args
  items="$(jq -nc --arg d "$ROW_FQDN" --arg t "$ROW_TYPE" --argjson ttl "$1" --arg v "$2" '$v | split(" ") | map(select(length > 0)) | map({domain: $d, rtype: $t, ttl: $ttl, rdata: .})')"
  atk_run oci dns record rrset update "$\{OCI_ARGS[@]}" --items "$items" --force
}
oci_del() {
  oci_args
  atk_run oci dns record rrset delete "$\{OCI_ARGS[@]}" --force
}

# ---------------------------------------------------------------- Windows DNS and BIND (read with dig)

dig_get() {
  local server="$1" out
  [[ -n "$server" ]] || { DNS_ERR="no DNS server to read from ($2 is not set)"; return 1; }
  dns_try out dig +noall +answer +norecurse @"$server" "$ROW_FQDN." "$ROW_TYPE" || return 1
  DNS_CUR="$(awk -v t="$ROW_TYPE" '$4 == t { print $5 }' <<< "$out" | dns_norm)"
  DNS_CUR_TTL="$(awk -v t="$ROW_TYPE" '$4 == t { print $2; exit }' <<< "$out")"
}
windows_get() { dig_get "$\{WINDOWS_DNS_SERVER:-}" WINDOWS_DNS_SERVER; }
windows_apply() {
  local state="$1" ttl="$2" want="$3" vars
  atk_tmpfile vars
  jq -n --arg zone "$ROW_ZONE" --arg name "$(dns_rel)" --arg type "$ROW_TYPE" --argjson ttl "$ttl" --arg v "$want" --arg state "$state" \
    '{dns_records: [{zone: $zone, name: $name, type: $type, ttl: $ttl, state: $state, values: ($v | split(" ") | map(select(length > 0)))}]}' > "$vars"
  atk_run ansible-playbook -i "$DNS_INVENTORY" "$ATK_HOME/ansible/windows-dns.yml" -e "@$vars" --limit "$\{ATK_WINDOWS_DNS_HOSTS:-windows_dns}"
}
windows_put() { windows_apply present "$1" "$2"; }
windows_del() { windows_apply absent "$\{DNS_CUR_TTL:-${CUTOVER_TTL}}" "$DNS_CUR"; }

bind_get() { dig_get "$\{BIND_SERVER:-}" BIND_SERVER; }
bind_update() {
  local ttl="$1" want="$2" key="" v
  local -a args=()
  [[ -n "$\{BIND_SERVER:-}" ]] || { DNS_ERR="BIND_SERVER is not set"; return 1; }
  if [[ -n "$\{BIND_TSIG_KEYFILE:-}" ]]; then args=(-k "$BIND_TSIG_KEYFILE"); else atk_secret_to key BIND_TSIG_KEY; fi
  {
    printf 'server %s\n' "$BIND_SERVER"
    printf 'zone %s.\n' "$ROW_ZONE"
    if [[ -n "$key" ]]; then printf 'key %s %s\n' "$\{key%:*}" "$\{key##*:}"; fi
    printf 'update delete %s. %s\n' "$ROW_FQDN" "$ROW_TYPE"
    for v in $want; do
      if [[ "$ROW_TYPE" == CNAME ]]; then v="$v."; fi
      printf 'update add %s. %s %s %s\n' "$ROW_FQDN" "$ttl" "$ROW_TYPE" "$v"
    done
    printf 'send\n'
  } | atk_run nsupdate "$\{args[@]}"
}
bind_put() { bind_update "$1" "$2"; }
bind_del() { bind_update "$\{DNS_CUR_TTL:-${CUTOVER_TTL}}" ""; }

# ---------------------------------------------------------------- Infoblox (WAPI)

ib_init() {
  if [[ -n "$IB_READY" ]]; then return 0; fi
  [[ -n "$\{INFOBLOX_HOST:-}" ]] || atk_die ${EXIT_CODES.missing} "INFOBLOX_HOST is not set"
  [[ -n "$\{INFOBLOX_USER:-}" ]] || atk_die ${EXIT_CODES.missing} "INFOBLOX_USER is not set"
  atk_secret_to IB_PASS INFOBLOX_PASSWORD
  IB_READY=1
}
ib_base() { printf 'https://%s/wapi/%s' "$INFOBLOX_HOST" "$\{INFOBLOX_WAPI_VERSION:-v2.13.7}"; }
ib_uri() { jq -rn --arg v "$1" '$v | @uri'; }
ib_view() { if [[ -n "$ROW_VIEW" ]]; then printf '&view=%s' "$(ib_uri "$ROW_VIEW")"; fi; }
ib_quote() {
  local s="$1"
  s="$\{s//\\/\\\\}"
  s="$\{s//\"/\\\"}"
  printf '"%s"' "$s"
}
# ib_config METHOD URL [BODY]: curl's config on stdout. It holds the credentials, so it only ever goes to curl's stdin.
ib_config() {
  printf 'silent\nshow-error\nfail\n'
  printf 'user = %s\n' "$(ib_quote "$INFOBLOX_USER:$IB_PASS")"
  printf 'url = %s\n' "$(ib_quote "$2")"
  printf 'request = %s\n' "$(ib_quote "$1")"
  if [[ -n "$\{INFOBLOX_CACERT:-}" ]]; then printf 'cacert = %s\n' "$(ib_quote "$INFOBLOX_CACERT")"; fi
  if [[ -n "$\{3:-}" ]]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data = %s\n' "$(ib_quote "$3")"
  fi
}
ib_get() { ib_config GET "$1" | curl --config -; }
ib_send() {
  atk_log "Infoblox $1 $\{2#"$(ib_base)"/}$\{3:+ $3}"
  ib_config "$@" | atk_run curl --config -
}
ib_obj() { case "$ROW_TYPE" in A) printf 'record:a ipv4addr' ;; AAAA) printf 'record:aaaa ipv6addr' ;; CNAME) printf 'record:cname canonical' ;; esac; }
infoblox_get() {
  ib_init
  local obj field out spec
  spec="$(ib_obj)"
  obj="$\{spec% *}"
  field="$\{spec#* }"
  IB_REFS=""
  IB_HOST_REF=""
  dns_try out ib_get "$(ib_base)/$obj?name=$(ib_uri "$ROW_FQDN")$(ib_view)&_return_fields%2B=ttl,use_ttl" || return 1
  if [[ "$(jq 'length' <<< "$out")" == 0 && "$ROW_TYPE" != CNAME ]]; then
    dns_try out ib_get "$(ib_base)/record:host?name=$(ib_uri "$ROW_FQDN")$(ib_view)&_return_fields%2B=ipv4addrs,ipv6addrs,ttl,use_ttl" || return 1
    if [[ "$(jq 'length' <<< "$out")" != 0 ]]; then
      IB_HOST_REF="$(jq -r '.[0]._ref' <<< "$out")"
      if [[ "$ROW_TYPE" == A ]]; then field=ipv4addrs; else field=ipv6addrs; fi
      DNS_CUR="$(jq -r --arg f "$field" '.[0][$f][]? | (.ipv4addr // .ipv6addr)' <<< "$out" | dns_norm)"
      DNS_CUR_TTL="$(jq -r 'if .[0].use_ttl then .[0].ttl else empty end' <<< "$out")"
      return 0
    fi
  fi
  IB_REFS="$(jq -r '.[]._ref' <<< "$out")"
  DNS_CUR="$(jq -r --arg f "$field" '.[][$f]' <<< "$out" | dns_norm)"
  DNS_CUR_TTL="$(jq -r 'if length > 0 and .[0].use_ttl then .[0].ttl else empty end' <<< "$out")"
}
infoblox_put() {
  ib_init
  local ttl="$1" want="$2" obj field spec i body
  spec="$(ib_obj)"
  obj="$\{spec% *}"
  field="$\{spec#* }"
  local -a refs=() values=()
  if [[ -n "$IB_HOST_REF" ]]; then
    if [[ "$ROW_TYPE" == A ]]; then field=ipv4addrs; else field=ipv6addrs; fi
    body="$(jq -nc --arg f "$field" --arg v "$want" --argjson ttl "$ttl" '{($f): ($v | split(" ") | map(select(length > 0)) | map({(if $f == "ipv4addrs" then "ipv4addr" else "ipv6addr" end): .})), ttl: $ttl, use_ttl: true}')"
    ib_send PUT "$(ib_base)/$IB_HOST_REF" "$body"
    return
  fi
  if [[ -n "$IB_REFS" ]]; then mapfile -t refs <<< "$IB_REFS"; fi
  for i in $want; do values+=("$i"); done
  local n=$(( $\{#refs[@]} > $\{#values[@]} ? $\{#refs[@]} : $\{#values[@]} ))
  for (( i = 0; i < n; i++ )); do
    if (( i < $\{#refs[@]} && i < $\{#values[@]} )); then
      body="$(jq -nc --arg f "$field" --arg v "$\{values[$i]}" --argjson ttl "$ttl" '{($f): $v, ttl: $ttl, use_ttl: true}')"
      ib_send PUT "$(ib_base)/$\{refs[$i]}" "$body" || return 1
    elif (( i < $\{#refs[@]} )); then
      ib_send DELETE "$(ib_base)/$\{refs[$i]}" || return 1
    else
      body="$(jq -nc --arg f "$field" --arg n "$ROW_FQDN" --arg v "$\{values[$i]}" --argjson ttl "$ttl" --arg view "$ROW_VIEW" '{name: $n, ($f): $v, ttl: $ttl, use_ttl: true} + (if $view == "" then {} else {view: $view} end)')"
      ib_send POST "$(ib_base)/$obj" "$body" || return 1
    fi
  done
}
infoblox_del() {
  ib_init
  local r
  local -a refs=()
  if [[ -n "$IB_HOST_REF" ]]; then ib_send DELETE "$(ib_base)/$IB_HOST_REF"; return; fi
  if [[ -n "$IB_REFS" ]]; then mapfile -t refs <<< "$IB_REFS"; fi
  for r in "$\{refs[@]}"; do
    if [[ -n "$r" ]]; then ib_send DELETE "$(ib_base)/$r" || return 1; fi
  done
}

# ---------------------------------------------------------------- dispatch

dns_fn() {
  case "$ROW_PROVIDER" in
    route53) printf 'route53' ;;
    azure-dns|azure-private-dns) printf 'azure' ;;
    cloud-dns) printf 'google' ;;
    oci-dns) printf 'oci' ;;
    windows-dns) printf 'windows' ;;
    bind) printf 'bind' ;;
    infoblox) printf 'infoblox' ;;
  esac
}
dns_get() { local p; p="$(dns_fn)"; DNS_CUR=""; DNS_CUR_TTL=""; "$\{p}_get"; }
dns_put() { local p; p="$(dns_fn)"; "$\{p}_put" "$@"; }
dns_del() { local p; p="$(dns_fn)"; "$\{p}_del"; }

# ---------------------------------------------------------------- the recorded values

dns_state_get() {
  [[ -f "$DNS_STATE" ]] || return 0
  jq -c --arg k "$1" '.[$k] // empty' "$DNS_STATE"
}
dns_state_put() {
  if (( ATK_DRY_RUN )); then atk_log "dry-run: would record the current values of $1 in $\{DNS_STATE#"$ATK_ROOT"/}"; return 0; fi
  mkdir -p "$(dirname "$DNS_STATE")"
  [[ -f "$DNS_STATE" ]] || printf '{}\n' > "$DNS_STATE"
  local next="$DNS_STATE.$BASHPID"
  jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$DNS_STATE" > "$next" || return 1
  mv -f "$next" "$DNS_STATE"
}

# ---------------------------------------------------------------- verbs (0 done, 75 skipped, anything else failed)

row_check() {
  dns_get || return 1
  DNS_DATA=(check=dns fqdn="$ROW_FQDN" type="$ROW_TYPE")
  if [[ -z "$DNS_CUR" ]]; then
    if [[ "$ROW_TYPE" == AAAA && -z "$ROW_OLD" ]]; then DNS_WHY="no AAAA record today (none expected)"; return 75; fi
    DNS_ERR="the record does not exist"
    return 1
  fi
  if [[ -z "$DNS_CUR_TTL" ]]; then DNS_ERR="the record uses the zone's default TTL: set ${CUTOVER_TTL} s with dns.sh ttl --set ${CUTOVER_TTL}"; return 1; fi
  DNS_DATA+=(ttl="$DNS_CUR_TTL")
  if (( DNS_CUR_TTL > ${CUTOVER_TTL} )); then DNS_ERR="TTL $DNS_CUR_TTL s is over ${CUTOVER_TTL} s: run dns.sh ttl --set ${CUTOVER_TTL} at T-48 h"; return 1; fi
  DNS_WHY="TTL $DNS_CUR_TTL s"
}

row_ttl() {
  dns_get || return 1
  DNS_DATA=(action=ttl fqdn="$ROW_FQDN" type="$ROW_TYPE" ttl="$DNS_SET_TTL")
  if [[ -z "$DNS_CUR" ]]; then DNS_WHY="no record to lower"; return 75; fi
  if [[ -n "$DNS_CUR_TTL" ]] && (( DNS_CUR_TTL <= DNS_SET_TTL )); then DNS_WHY="TTL already $DNS_CUR_TTL s"; return 75; fi
  dns_put "$DNS_SET_TTL" "$DNS_CUR" || return 1
  DNS_WHY="TTL $\{DNS_CUR_TTL:-default} -> $DNS_SET_TTL s"
}

row_switch() {
  local tok val want="" rec
  DNS_DATA=(fqdn="$ROW_FQDN" type="$ROW_TYPE")
  for tok in $\{ROW_NEW//;/ }; do
    if [[ "$tok" == @target ]]; then
      val="$(dns_target "$ROW_ITEM" "$ROW_TYPE")"
      if [[ -z "$val" ]]; then
        if [[ "$ROW_TYPE" == AAAA ]]; then DNS_WHY="the target has no IPv6 address"; return 75; fi
        if (( ATK_DRY_RUN )); then DNS_WHY="the target address is known after the cutover: $ROW_TYPE $ROW_FQDN would point at it"; return 75; fi
        DNS_ERR="no target address: the item's cutover event has no $ROW_TYPE address"
        return 1
      fi
      want+=" $val"
    else
      want+=" $tok"
    fi
  done
  want="$(dns_norm <<< "$want")"
  dns_get || return 1
  rec="$(dns_state_get "$ROW_KEY")"
  if [[ -z "$rec" ]]; then
    rec="$(jq -nc --arg v "$DNS_CUR" --arg ttl "$DNS_CUR_TTL" '{existed: ($v != ""), values: ($v | split(" ") | map(select(length > 0))), ttl: (if $ttl == "" then null else ($ttl | tonumber) end)}')"
    dns_state_put "$ROW_KEY" "$rec" || { DNS_ERR="could not record the current values in $DNS_STATE"; return 1; }
  fi
  DNS_DATA+=(old="$\{DNS_CUR:-none}" new="$want")
  if [[ "$DNS_CUR" == "$want" && "$DNS_CUR_TTL" == "$ROW_TTL" ]]; then DNS_WHY="already $want"; return 75; fi
  dns_put "$ROW_TTL" "$want" || return 1
  DNS_WHY="$\{DNS_CUR:-none} -> $want"
}

row_revert() {
  local rec existed values ttl
  DNS_DATA=(fqdn="$ROW_FQDN" type="$ROW_TYPE" revert=true)
  rec="$(dns_state_get "$ROW_KEY")"
  if [[ -z "$rec" ]]; then DNS_WHY="nothing recorded for this record in wave $ATK_WAVE (never switched)"; return 75; fi
  existed="$(jq -r '.existed' <<< "$rec")"
  values="$(jq -r '.values[]' <<< "$rec" | dns_norm)"
  ttl="$(jq -r '.ttl // empty' <<< "$rec")"
  dns_get || return 1
  DNS_DATA+=(old="$\{DNS_CUR:-none}" new="$\{values:-none}")
  if [[ "$existed" != true ]]; then
    if [[ -z "$DNS_CUR" ]]; then DNS_WHY="already absent"; return 75; fi
    dns_del || return 1
    DNS_WHY="removed (it did not exist before the switch)"
    return 0
  fi
  if [[ "$DNS_CUR" == "$values" && "$DNS_CUR_TTL" == "$\{ttl:-$DNS_CUR_TTL}" ]]; then DNS_WHY="already $values"; return 75; fi
  dns_put "$\{ttl:-${CUTOVER_TTL}}" "$values" || return 1
  DNS_WHY="$\{DNS_CUR:-none} -> $values (restored)"
}

dns_each() {
  local fn="$1" step="$2" row rc ok=0 failed=0 skipped=0
  for row in "$\{DNS_ROWS[@]}"; do
    dns_row "$row"
    DNS_WHY=""
    DNS_ERR=""
    DNS_DATA=()
    if ! dns_need; then
      atk_event "$ROW_EV_ITEM" "$step" failed "" "$ROW_TYPE $ROW_FQDN: unknown provider $ROW_PROVIDER" fqdn="$ROW_FQDN"
      failed=$(( failed + 1 ))
      continue
    fi
    rc=0
    "$fn" || rc=$?
    case "$rc" in
      0) atk_event "$ROW_EV_ITEM" "$step" succeeded "" "$ROW_TYPE $ROW_FQDN: $DNS_WHY" provider="$ROW_PROVIDER" "$\{DNS_DATA[@]}"; ok=$(( ok + 1 )) ;;
      75) atk_event "$ROW_EV_ITEM" "$step" skipped "" "$ROW_TYPE $ROW_FQDN: $DNS_WHY" provider="$ROW_PROVIDER" "$\{DNS_DATA[@]}"; skipped=$(( skipped + 1 )) ;;
      ${EXIT_CODES.missing}) exit ${EXIT_CODES.missing} ;;
      *) atk_event "$ROW_EV_ITEM" "$step" failed "" "$ROW_TYPE $ROW_FQDN: $\{DNS_ERR:-failed}" provider="$ROW_PROVIDER" "$\{DNS_DATA[@]}"; failed=$(( failed + 1 )) ;;
    esac
  done
  atk_log "dns $DNS_VERB: $ok done, $skipped skipped, $failed failed"
  if (( failed > 0 )); then
    if [[ "$DNS_VERB" == check ]]; then exit ${EXIT_CODES.precheck}; fi
    exit ${EXIT_CODES.partial}
  fi
  return 0
}

dns_load
if (( $\{#DNS_ROWS[@]} == 0 )); then
  atk_log "no DNS records$\{ATK_WAVE:+ for wave $ATK_WAVE} in records.csv"
  exit 0
fi
case "$DNS_VERB" in
  check) dns_each row_check precheck ;;
  ttl) dns_each row_ttl dns-switch ;;
  switch) dns_each row_switch dns-switch ;;
  revert) dns_each row_revert dns-switch ;;
esac
`;
}

// ---------------------------------------------------------------------------
// ansible/windows-dns.yml
// ---------------------------------------------------------------------------

/** `ansible/windows-dns.yml`: the records dns.sh passes, written on a Windows DNS server (the windows_dns group). */
export function renderWindowsDnsYml()         {
  const play            = [{
    name: 'Windows DNS records for the cutover',
    hosts: 'windows_dns',
    gather_facts: false,
    tasks: [
      {
        name: 'Check that dns.sh passed the records',
        'ansible.builtin.assert': {
          that: ['dns_records is defined', 'dns_records | length > 0'],
          fail_msg: 'Run this play through dns/dns.sh, which passes dns_records.',
        },
        run_once: true,
      },
      {
        name: 'Write or remove the records',
        'ansible.windows.win_dns_record': {
          zone: '{{ item.zone }}',
          name: '{{ item.name }}',
          type: '{{ item.type }}',
          value: "{{ item['values'] if item.state == 'present' else omit }}",
          ttl: "{{ (item.ttl | int) if item.state == 'present' else omit }}",
          state: '{{ item.state }}',
          computer_name: '{{ windows_dns_computer | default(omit) }}',
        },
        loop: '{{ dns_records }}',
        loop_control: { label: '{{ item.type }} {{ item.name }}.{{ item.zone }} {{ item.state }}' },
        run_once: true,
      },
    ],
  }];
  return renderYaml(play, { header: 'windows-dns.yml: A, AAAA and CNAME records on a Windows DNS server (run by dns/dns.sh with -e @<records>).\nThe windows_dns inventory group holds the DNS server (a domain controller); only the first host writes.' });
}

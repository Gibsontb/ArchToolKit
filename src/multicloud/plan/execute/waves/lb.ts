/**
 * Load balancers for the cutover (addendum A.7.2 steps 3 and 9, A.7.4):
 * `lb/members.csv` and `lb/lb.sh`.
 *
 * `members.csv` has one row per app, load balancer and member item:
 *   app,kind,pool,port,item,source,target,scope
 * `source` is the item's address today (several separated by `;`), `target`
 * is `@target` (the item's cutover event: `data.targetIpv4`, `targetIpv6`,
 * and `targetName` for a Google Cloud (GCP) instance endpoint) or fixed
 * addresses. The pool and scope per kind:
 *
 * | Kind | pool | scope | Drain | Switch | Revert |
 * |---|---|---|---|---|---|
 * | aws-elbv2 | target group ARN | | deregister-targets (the source; deregistration delay drains it) | register-targets (target), deregister the source | register the source, deregister the target |
 * | azure-lb | `<resource-group>/<lb>/<pool>` | VNet resource id | address-pool address remove | address add (target), remove the source | add the source back, remove the target |
 * | gcp-neg | NEG name | zone | network-endpoint-groups update --remove-endpoint | --add-endpoint (target) | the reverse |
 * | oci-lb | `<lb-ocid>/<backend-set>` | | backend update --drain true | backend create (target), delete the source | re-create or undrain the source, delete the target |
 * | f5-bigip | pool (`/Partition/pool` or `pool`) | | PATCH member `{"session":"user-disabled"}` | POST member (target), DELETE the source | enable the source, DELETE the target |
 * | avi | pool uuid | | GET the pool, server `enabled: false`, PUT | server added (target), source removed, PUT | the reverse, PUT |
 *
 * F5 and VMware Avi Load Balancer credentials (F5_USER / F5_PASSWORD,
 * AVI_USER / AVI_PASSWORD, via atk_secret) go to curl in a config on
 * stdin, never as arguments.
 *
 * Pure: no DOM, no file system.
 */

import { familyOf } from '../../../../core/ip.ts';
import { warning, type Finding } from '../../../../core/findings.ts';
import type { LbKind } from '../../types.ts';
import { EXIT_CODES } from '../contract.ts';
import { code, libPathFrom } from '../lib-sh.ts';
import type { ToolNeed } from '../registry.ts';
import { CORE_PATHS, type WaveContext } from './common.ts';

export const LB_SOURCES: Readonly<Record<Exclude<LbKind, 'none'>, string>> = Object.freeze({
  'aws-elbv2': 'https://docs.aws.amazon.com/cli/latest/reference/elbv2/deregister-targets.html',
  'azure-lb': 'https://learn.microsoft.com/en-us/cli/azure/network/lb/address-pool/address',
  'gcp-neg': 'https://docs.cloud.google.com/sdk/gcloud/reference/compute/network-endpoint-groups/update',
  'oci-lb': 'https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/lb/backend/update.html',
  'f5-bigip': 'https://clouddocs.f5.com/api/icontrol-rest/APIRef_tm_ltm_pool_members.html',
  avi: 'https://avinetworks.com/docs/latest/api-guide/ (pool object; verify PUT semantics and basic authentication on your release)',
});

export interface LbMemberRow {
  readonly app: string;
  readonly kind: Exclude<LbKind, 'none'>;
  readonly pool: string;
  readonly port: number;
  readonly item: string;
  readonly source: readonly string[];
  readonly target: readonly string[];
  readonly scope?: string;
}

export const MEMBERS_COLUMNS = Object.freeze(['app', 'kind', 'pool', 'port', 'item', 'source', 'target', 'scope'] as const);

const csvSafe = (s: string): string => s.replace(/[,\r\n]+/g, ' ').trim();

/** One row per workload of an app with a load balancer in the settings. */
export function lbMembers(ctx: WaveContext): { rows: LbMemberRow[]; findings: Finding[] } {
  const rows: LbMemberRow[] = [];
  const findings: Finding[] = [];
  const noAddress: string[] = [];
  for (const i of ctx.manifest.items) {
    if (i.kind !== 'workload' || i.wave === null || CORE_PATHS.has(i.path)) continue;
    for (const lb of i.lb) {
      if (lb.kind === 'none') continue;
      const ips = i.source.ips ?? [];
      const v4 = ips.filter((ip) => familyOf(ip) === 4);
      if (!ips.length) noAddress.push(i.name);
      rows.push({ app: i.app, kind: lb.kind, pool: lb.pool, port: lb.port, item: i.id, source: v4.length ? v4.slice(0, 1) : ips.slice(0, 1), target: ['@target'] });
    }
  }
  if (noAddress.length) {
    findings.push(warning('exec.lb.no-source-address', `${noAddress.length} load-balancer member(s) have no known address today, so lb.sh cannot drain them: ${noAddress.slice(0, 5).join(', ')}.`, { remediation: 'Fill the source column of lb/members.csv.' }));
  }
  const needsScope = rows.filter((r) => (r.kind === 'azure-lb' || r.kind === 'gcp-neg') && !r.scope);
  if (needsScope.length) {
    findings.push(warning('exec.lb.scope', `${needsScope.length} load-balancer row(s) need a scope in lb/members.csv (the VNet resource id for an Azure load balancer, the zone for a Google Cloud (GCP) NEG).`, { remediation: 'Fill the scope column before the cutover.' }));
  }
  return { rows, findings };
}

export function renderMembersCsv(rows: readonly LbMemberRow[]): string {
  const sorted = [...rows].sort((a, b) => a.app.localeCompare(b.app) || a.pool.localeCompare(b.pool) || a.item.localeCompare(b.item));
  const lines = sorted.map((r) => [r.app, r.kind, r.pool, String(r.port), r.item, r.source.join(';'), r.target.join(';'), r.scope ?? ''].map(csvSafe).join(','));
  return `${[MEMBERS_COLUMNS.join(','), ...lines].join('\n')}\n`;
}

export function lbNeeds(rows: readonly LbMemberRow[]): ToolNeed[] {
  const k = new Set(rows.map((r) => r.kind));
  const out: ToolNeed[] = [];
  if (k.has('aws-elbv2')) out.push({ kind: 'command', name: 'aws', min: '2', why: 'Elastic Load Balancing targets' });
  if (k.has('azure-lb')) out.push({ kind: 'command', name: 'az', why: 'Azure Load Balancer backend addresses' });
  if (k.has('gcp-neg')) out.push({ kind: 'command', name: 'gcloud', why: 'network endpoint groups' });
  if (k.has('oci-lb')) out.push({ kind: 'command', name: 'oci', why: 'OCI load balancer backends' });
  if (k.has('f5-bigip') || k.has('avi')) out.push({ kind: 'command', name: 'curl', why: 'the F5 iControl REST and Avi APIs' });
  return out;
}

const LB_FILE = 'lb/lb.sh';

/** The text of `lb/lb.sh`. */
export function renderLbSh(): string {
  const lib = libPathFrom(LB_FILE, 'atk.sh');
  return code`#!/usr/bin/env bash
# lb/lb.sh: load-balancer members for the cutover (members.csv): AWS Elastic Load Balancing target groups, Azure Load
# Balancer backend pools, Google Cloud (GCP) network endpoint groups, OCI load balancers, F5 BIG-IP (iControl REST) and
# VMware Avi Load Balancer.
#   lb.sh drain  --wave N [--item ID]    take the sources out of rotation (the freeze, step 3)
#   lb.sh switch --wave N [--item ID]    add the targets, remove the drained sources (step 9)
#   lb.sh revert --wave N [--item ID]    put the sources back, remove the targets (rollback)
#   lb.sh check  [--wave N]              read the members (read-only)
# Credentials: cloud CLIs use their own chains; F5_HOST, F5_USER, F5_PASSWORD and AVI_HOST, AVI_USER, AVI_PASSWORD
# (atk_secret) go to curl in a config on stdin, never as arguments.
# Changes are made by default; --dry-run prints each change instead. Exit codes: 0 ok, 2 usage, 3 missing tool or
# credential, 10 some members failed, 1 other.
set -Eeuo pipefail
LB_VERB=""
WAVE_ARGS=()
while (( $# )); do
  case "$1" in
    drain|switch|revert|check)
      if [[ -z "$LB_VERB" ]]; then LB_VERB="$1"; else WAVE_ARGS+=("$1"); fi
      shift ;;
    --wave|--item|--gate-override|--timeout)
      WAVE_ARGS+=("$1" "$\{2:-}"); shift
      if (( $# )); then shift; fi ;;
    *) WAVE_ARGS+=("$1"); shift ;;
  esac
done
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/${lib}"
atk_init_tool lb "$\{WAVE_ARGS[@]}"
[[ -n "$LB_VERB" ]] || atk_usage "a verb is needed: drain, switch, revert or check"
if [[ "$LB_VERB" != check && -z "$ATK_WAVE" ]]; then atk_usage "$LB_VERB needs --wave"; fi
atk_need jq
if [[ -n "$ATK_WAVE" ]]; then atk_lock "lb-$ATK_WAVE"; fi

LB_MEMBERS="$\{ATK_LB_MEMBERS:-$ATK_HOME/lb/members.csv}"
LB_ROWS=()
LB_F=()
LB_WHY=""
LB_ERR=""
HTTP_USER=""
HTTP_PASS=""

lb_split() {
  local rest="$1"
  LB_F=()
  while [[ "$rest" == *,* ]]; do
    LB_F+=("$\{rest%%,*}")
    rest="$\{rest#*,}"
  done
  LB_F+=("$rest")
}

lb_load() {
  [[ -f "$LB_MEMBERS" ]] || { atk_log "no $LB_MEMBERS"; return 0; }
  local -a lines=()
  local line item f matched lname
  local -A hit=()
  mapfile -t lines < "$LB_MEMBERS"
  for line in "$\{lines[@]}"; do
    line="$\{line%$'\r'}"
    [[ -n "$line" && "$line" != \#* && "$line" != app,* ]] || continue
    lb_split "$line"
    (( $\{#LB_F[@]} >= 7 )) || atk_die 1 "members.csv has a short row: $line"
    item="$\{LB_F[4]:--}"
    if [[ -n "$ATK_WAVE" && "$\{ATK_ITEM_WAVE[$item]:-}" != "$ATK_WAVE" ]]; then continue; fi
    if (( $\{#ATK_ITEM_FILTER[@]} )); then
      matched=0
      lname="$\{ATK_NAME[$item]:-}"
      for f in "$\{ATK_ITEM_FILTER[@]}"; do
        if [[ "$f" == "$item" || ( -n "$lname" && "$\{f,,}" == "$\{lname,,}" ) ]]; then matched=1; hit[$f]=1; fi
      done
      (( matched )) || continue
    fi
    LB_ROWS+=("$line")
  done
  return 0
}

lb_row() {
  lb_split "$1"
  ROW_APP="$\{LB_F[0]}"
  ROW_KIND="$\{LB_F[1]}"
  ROW_POOL="$\{LB_F[2]}"
  ROW_PORT="$\{LB_F[3]}"
  ROW_ITEM="$\{LB_F[4]:--}"
  ROW_SOURCE="$\{LB_F[5]//;/ }"
  ROW_TARGET_SPEC="$\{LB_F[6]}"
  ROW_SCOPE="$\{LB_F[7]:-}"
  ROW_EV_ITEM="-"
  if [[ -n "$\{ATK_NAME[$ROW_ITEM]:-}" ]]; then ROW_EV_ITEM="$ROW_ITEM"; fi
}

# lb_data ID KEY: a value from the item's latest succeeded cutover event.
lb_data() {
  local file="$ATK_STATUS/events.jsonl"
  [[ -f "$file" ]] || return 0
  jq -r --arg id "$1" --arg key "$2" --argjson dry "$ATK_DRY_RUN" \
    'select(.item == $id and .step == "cutover" and .outcome == "succeeded" and (.dryRun == false or $dry == 1) and ((.data // {})[$key] // null) != null) | .data[$key] | tostring' \
    "$file" | tail -n 1
}

# lb_targets: ROW_TARGET := the target addresses (resolving @target), or empty.
lb_targets() {
  local tok v out=""
  for tok in $\{ROW_TARGET_SPEC//;/ }; do
    if [[ "$tok" == @target ]]; then
      v="$(lb_data "$ROW_ITEM" targetIpv4)"
      if [[ -z "$v" ]]; then v="$(lb_data "$ROW_ITEM" targetIpv6)"; fi
      if [[ -n "$v" ]]; then out+=" $v"; fi
    else
      out+=" $tok"
    fi
  done
  ROW_TARGET="$\{out# }"
}

lb_is_v6() { [[ "$1" == *:* ]]; }

# ---------------------------------------------------------------- AWS Elastic Load Balancing

aws_state() {
  local ip="$1" az=""
  if [[ "$2" == source ]]; then az=",AvailabilityZone=all"; fi
  aws elbv2 describe-target-health --target-group-arn "$ROW_POOL" --targets "Id=$ip,Port=$ROW_PORT$az" --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text 2> /dev/null || printf 'unknown'
}
aws_in() { local s; s="$(aws_state "$1" "$2")"; [[ "$s" != unused && "$s" != draining && "$s" != unknown && "$s" != None ]]; }
aws_add() {
  local az=""
  if [[ "$2" == source ]]; then az=",AvailabilityZone=all"; fi
  if aws_in "$1" "$2"; then return 75; fi
  atk_run aws elbv2 register-targets --target-group-arn "$ROW_POOL" --targets "Id=$1,Port=$ROW_PORT$az"
}
aws_remove() {
  local az=""
  if [[ "$2" == source ]]; then az=",AvailabilityZone=all"; fi
  if ! aws_in "$1" "$2"; then return 75; fi
  atk_run aws elbv2 deregister-targets --target-group-arn "$ROW_POOL" --targets "Id=$1,Port=$ROW_PORT$az"
}
aws-elbv2_drain() { aws_remove "$1" source; }
aws-elbv2_enable() { aws_add "$1" source; }
aws-elbv2_add() { aws_add "$1" target; }
aws-elbv2_del() { aws_remove "$1" "$2"; }
aws-elbv2_show() { printf '%s' "$(aws_state "$1" "$2")"; }

# ---------------------------------------------------------------- Azure Load Balancer

az_pool_parts() { AZ_RG="$\{ROW_POOL%%/*}"; local r="$\{ROW_POOL#*/}"; AZ_LB="$\{r%%/*}"; AZ_POOL="$\{r#*/}"; }
az_member_name() {
  az_pool_parts
  az network lb address-pool address list -g "$AZ_RG" --lb-name "$AZ_LB" --pool-name "$AZ_POOL" -o json | jq -r --arg ip "$1" '.[] | select(.ipAddress == $ip) | .name' | head -n 1
}
az_add() {
  local name
  az_pool_parts
  name="$(az_member_name "$1")"
  if [[ -n "$name" ]]; then return 75; fi
  [[ -n "$ROW_SCOPE" ]] || { LB_ERR="the scope column needs the VNet resource id"; return 1; }
  atk_run az network lb address-pool address add -g "$AZ_RG" --lb-name "$AZ_LB" --pool-name "$AZ_POOL" --name "atk-$\{1//[.:]/-}" --ip-address "$1" --vnet "$ROW_SCOPE" -o none
}
az_remove() {
  local name
  az_pool_parts
  name="$(az_member_name "$1")"
  if [[ -z "$name" ]]; then return 75; fi
  atk_run az network lb address-pool address remove -g "$AZ_RG" --lb-name "$AZ_LB" --pool-name "$AZ_POOL" --name "$name" -o none
}
azure-lb_drain() { az_remove "$1"; }
azure-lb_enable() { az_add "$1"; }
azure-lb_add() { az_add "$1"; }
azure-lb_del() { az_remove "$1"; }
azure-lb_show() { if [[ -n "$(az_member_name "$1")" ]]; then printf 'member'; else printf 'absent'; fi; }

# ---------------------------------------------------------------- Google Cloud network endpoint groups

neg_list() { gcloud compute network-endpoint-groups list-network-endpoints "$ROW_POOL" --zone="$ROW_SCOPE" --format=json; }
neg_has() { neg_list | jq -e --arg ip "$1" --argjson port "$ROW_PORT" 'any(.[]; .networkEndpoint.ipAddress == $ip and ((.networkEndpoint.port // $port) == $port))' > /dev/null; }
neg_spec() {
  local instance=""
  if [[ "$2" == target ]]; then instance="$(lb_data "$ROW_ITEM" targetName)"; fi
  printf '%sip=%s,port=%s' "$\{instance:+instance=$instance,}" "$1" "$ROW_PORT"
}
neg_add() {
  [[ -n "$ROW_SCOPE" ]] || { LB_ERR="the scope column needs the NEG's zone"; return 1; }
  if neg_has "$1"; then return 75; fi
  atk_run gcloud compute network-endpoint-groups update "$ROW_POOL" --zone="$ROW_SCOPE" --add-endpoint="$(neg_spec "$1" "$2")"
}
neg_remove() {
  [[ -n "$ROW_SCOPE" ]] || { LB_ERR="the scope column needs the NEG's zone"; return 1; }
  if ! neg_has "$1"; then return 75; fi
  atk_run gcloud compute network-endpoint-groups update "$ROW_POOL" --zone="$ROW_SCOPE" --remove-endpoint="ip=$1,port=$ROW_PORT"
}
gcp-neg_drain() { neg_remove "$1"; }
gcp-neg_enable() { neg_add "$1" source; }
gcp-neg_add() { neg_add "$1" target; }
gcp-neg_del() { neg_remove "$1"; }
gcp-neg_show() { if neg_has "$1"; then printf 'member'; else printf 'absent'; fi; }

# ---------------------------------------------------------------- OCI load balancer

oci_parts() { OCI_LB="$\{ROW_POOL%%/*}"; OCI_BS="$\{ROW_POOL#*/}"; }
oci_backend() {
  oci_parts
  oci lb backend get --load-balancer-id "$OCI_LB" --backend-set-name "$OCI_BS" --backend-name "$1:$ROW_PORT" 2> /dev/null || true
}
oci_drain() {
  local b
  b="$(oci_backend "$1")"
  if [[ -z "$b" ]]; then LB_WHY="not a backend"; return 75; fi
  if [[ "$(jq -r '.data.drain' <<< "$b")" == true ]]; then return 75; fi
  atk_run oci lb backend update --load-balancer-id "$OCI_LB" --backend-set-name "$OCI_BS" --backend-name "$1:$ROW_PORT" \
    --drain true --offline false --backup false --weight "$(jq -r '.data.weight // 1' <<< "$b")" --wait-for-state SUCCEEDED
}
oci_enable() {
  local b
  b="$(oci_backend "$1")"
  if [[ -z "$b" ]]; then
    atk_run oci lb backend create --load-balancer-id "$OCI_LB" --backend-set-name "$OCI_BS" --ip-address "$1" --port "$ROW_PORT" --wait-for-state SUCCEEDED
    return
  fi
  if [[ "$(jq -r '.data.drain' <<< "$b")" != true && "$(jq -r '.data.offline' <<< "$b")" != true ]]; then return 75; fi
  atk_run oci lb backend update --load-balancer-id "$OCI_LB" --backend-set-name "$OCI_BS" --backend-name "$1:$ROW_PORT" \
    --drain false --offline false --backup false --weight "$(jq -r '.data.weight // 1' <<< "$b")" --wait-for-state SUCCEEDED
}
oci_add() {
  if [[ -n "$(oci_backend "$1")" ]]; then return 75; fi
  atk_run oci lb backend create --load-balancer-id "$OCI_LB" --backend-set-name "$OCI_BS" --ip-address "$1" --port "$ROW_PORT" --wait-for-state SUCCEEDED
}
oci_del() {
  if [[ -z "$(oci_backend "$1")" ]]; then return 75; fi
  atk_run oci lb backend delete --load-balancer-id "$OCI_LB" --backend-set-name "$OCI_BS" --backend-name "$1:$ROW_PORT" --force --wait-for-state SUCCEEDED
}
oci-lb_drain() { oci_drain "$1"; }
oci-lb_enable() { oci_enable "$1"; }
oci-lb_add() { oci_add "$1"; }
oci-lb_del() { oci_del "$1"; }
oci-lb_show() { local b; b="$(oci_backend "$1")"; if [[ -z "$b" ]]; then printf 'absent'; else jq -r '"drain=\(.data.drain) offline=\(.data.offline)"' <<< "$b"; fi; }

# ---------------------------------------------------------------- HTTP APIs (F5 iControl REST, Avi): credentials on curl's stdin

http_quote() {
  local s="$1"
  s="$\{s//\\/\\\\}"
  s="$\{s//\"/\\\"}"
  printf '"%s"' "$s"
}
http_creds() {
  local user_var="$1" pass_var="$2"
  [[ -n "$\{!user_var:-}" ]] || atk_die ${EXIT_CODES.missing} "$user_var is not set"
  HTTP_USER="$\{!user_var}"
  atk_secret_to HTTP_PASS "$pass_var"
}
# http_config METHOD URL [BODY] [HEADER]: curl's config on stdout; it carries the credentials, so it only goes to curl's stdin.
http_config() {
  printf 'silent\nshow-error\nfail\n'
  printf 'user = %s\n' "$(http_quote "$HTTP_USER:$HTTP_PASS")"
  printf 'url = %s\n' "$(http_quote "$2")"
  printf 'request = %s\n' "$(http_quote "$1")"
  if [[ -n "$\{LB_CACERT:-}" ]]; then printf 'cacert = %s\n' "$(http_quote "$LB_CACERT")"; fi
  if [[ -n "$\{4:-}" ]]; then printf 'header = %s\n' "$(http_quote "$4")"; fi
  if [[ -n "$\{3:-}" ]]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data = %s\n' "$(http_quote "$3")"
  fi
}
http_get() { http_config GET "$1" "" "$\{2:-}" | curl --config -; }
http_send() {
  atk_log "$1 $2$\{3:+ $3}"
  http_config "$@" | atk_run curl --config -
}

# F5 BIG-IP: members are <address>:<port> (IPv4) or <address>.<port> (IPv6), in the pool's partition.
f5_init() { [[ -n "$\{F5_HOST:-}" ]] || atk_die ${EXIT_CODES.missing} "F5_HOST is not set"; http_creds F5_USER F5_PASSWORD; }
f5_pool() { local p="$\{ROW_POOL#/}"; if [[ "$p" == */* ]]; then printf '~%s~%s' "$\{p%%/*}" "$\{p#*/}"; else printf '~Common~%s' "$p"; fi; }
f5_part() { local p="$\{ROW_POOL#/}"; if [[ "$p" == */* ]]; then printf '%s' "$\{p%%/*}"; else printf 'Common'; fi; }
f5_member() { if lb_is_v6 "$1"; then printf '%s.%s' "$1" "$ROW_PORT"; else printf '%s:%s' "$1" "$ROW_PORT"; fi; }
f5_url() { printf 'https://%s/mgmt/tm/ltm/pool/%s/members%s' "$F5_HOST" "$(f5_pool)" "$\{1:+/~$(f5_part)~$1}"; }
f5_get() { f5_init; http_get "$(f5_url "$(f5_member "$1")")" 2> /dev/null || true; }
f5-bigip_drain() {
  local m
  m="$(f5_get "$1")"
  if [[ -z "$m" ]]; then LB_WHY="not a member"; return 75; fi
  if [[ "$(jq -r '.session' <<< "$m")" == user-disabled ]]; then return 75; fi
  http_send PATCH "$(f5_url "$(f5_member "$1")")" '{"session":"user-disabled"}'
}
f5-bigip_enable() {
  local m
  m="$(f5_get "$1")"
  if [[ -z "$m" ]]; then
    http_send POST "$(f5_url)" "$(jq -nc --arg n "$(f5_member "$1")" --arg a "$1" '{name: $n, address: $a}')"
    return
  fi
  if [[ "$(jq -r '.session' <<< "$m")" != user-disabled ]]; then return 75; fi
  http_send PATCH "$(f5_url "$(f5_member "$1")")" '{"session":"user-enabled","state":"user-up"}'
}
f5-bigip_add() {
  if [[ -n "$(f5_get "$1")" ]]; then return 75; fi
  http_send POST "$(f5_url)" "$(jq -nc --arg n "$(f5_member "$1")" --arg a "$1" '{name: $n, address: $a}')"
}
f5-bigip_del() {
  if [[ -z "$(f5_get "$1")" ]]; then return 75; fi
  http_send DELETE "$(f5_url "$(f5_member "$1")")"
}
f5-bigip_show() { local m; m="$(f5_get "$1")"; if [[ -z "$m" ]]; then printf 'absent'; else jq -r '"session=\(.session) state=\(.state)"' <<< "$m"; fi; }

# VMware Avi Load Balancer: the pool is read, changed and written back whole (PUT).
avi_init() { [[ -n "$\{AVI_HOST:-}" ]] || atk_die ${EXIT_CODES.missing} "AVI_HOST is not set"; http_creds AVI_USER AVI_PASSWORD; }
avi_url() { printf 'https://%s/api/pool/%s' "$AVI_HOST" "$ROW_POOL"; }
avi_hdr() { printf 'X-Avi-Version: %s' "$\{AVI_API_VERSION:-22.1.3}"; }
avi_pool() { avi_init; http_get "$(avi_url)" "$(avi_hdr)"; }
avi_server() { jq -c --arg ip "$1" --argjson port "$ROW_PORT" '[.servers[]? | select(.ip.addr == $ip and ((.port // $port) == $port))][0] // empty' <<< "$2"; }
avi_put() { http_send PUT "$(avi_url)" "$1" "$(avi_hdr)"; }
avi_set_enabled() {
  local pool srv
  pool="$(avi_pool)" || return 1
  srv="$(avi_server "$1" "$pool")"
  if [[ -z "$srv" ]]; then
    if [[ "$2" == false ]]; then LB_WHY="not a server of the pool"; return 75; fi
    avi_put "$(jq -c --arg ip "$1" --argjson port "$ROW_PORT" --arg t "$(if lb_is_v6 "$1"; then printf V6; else printf V4; fi)" '.servers = ((.servers // []) + [{ip: {addr: $ip, type: $t}, port: $port, enabled: true}])' <<< "$pool")"
    return
  fi
  if [[ "$(jq -r '.enabled // true' <<< "$srv")" == "$2" ]]; then return 75; fi
  avi_put "$(jq -c --arg ip "$1" --argjson on "$2" '.servers |= map(if .ip.addr == $ip then .enabled = $on else . end)' <<< "$pool")"
}
avi_drop() {
  local pool
  pool="$(avi_pool)" || return 1
  if [[ -z "$(avi_server "$1" "$pool")" ]]; then return 75; fi
  avi_put "$(jq -c --arg ip "$1" '.servers |= map(select(.ip.addr != $ip))' <<< "$pool")"
}
avi_drain() { avi_set_enabled "$1" false; }
avi_enable() { avi_set_enabled "$1" true; }
avi_add() { avi_set_enabled "$1" true; }
avi_del() { avi_drop "$1"; }
avi_show() { local pool srv; pool="$(avi_pool)"; srv="$(avi_server "$1" "$pool")"; if [[ -z "$srv" ]]; then printf 'absent'; else jq -r '"enabled=\(.enabled // true)"' <<< "$srv"; fi; }

# ---------------------------------------------------------------- verbs (0 done, 75 skipped, anything else failed)

lb_need() {
  case "$ROW_KIND" in
    aws-elbv2) atk_need aws ;;
    azure-lb) atk_need az ;;
    gcp-neg) atk_need gcloud ;;
    oci-lb) atk_need oci ;;
    f5-bigip|avi) atk_need curl ;;
    *) LB_ERR="unknown load-balancer kind $ROW_KIND"; return 1 ;;
  esac
}

# lb_all FN ADDRESSES ROLE: FN for each address; 0 when any changed, 75 when all were already there.
lb_all() {
  local fn="$1" addrs="$2" role="$3" a rc changed=0
  for a in $addrs; do
    rc=0
    "$fn" "$a" "$role" || rc=$?
    case "$rc" in 0) changed=1 ;; 75) ;; *) return "$rc" ;; esac
  done
  if (( changed )); then return 0; fi
  return 75
}

row_drain() {
  [[ -n "$ROW_SOURCE" ]] || { LB_ERR="no source address in members.csv"; return 1; }
  lb_all "$\{ROW_KIND}_drain" "$ROW_SOURCE" source || return
  LB_WHY="source $ROW_SOURCE drained"
}
row_switch() {
  lb_targets
  if [[ -z "$ROW_TARGET" ]]; then
    if (( ATK_DRY_RUN )); then LB_WHY="the target address is known after the cutover"; return 75; fi
    LB_ERR="no target address: the item's cutover event has none"
    return 1
  fi
  local rc=0 rc2=0
  lb_all "$\{ROW_KIND}_add" "$ROW_TARGET" target || rc=$?
  if (( rc != 0 && rc != 75 )); then return "$rc"; fi
  if [[ -n "$ROW_SOURCE" ]]; then lb_all "$\{ROW_KIND}_del" "$ROW_SOURCE" source || rc2=$?; else rc2=75; fi
  if (( rc2 != 0 && rc2 != 75 )); then return "$rc2"; fi
  if (( rc == 75 && rc2 == 75 )); then LB_WHY="already switched"; return 75; fi
  LB_WHY="target $ROW_TARGET in, source $\{ROW_SOURCE:-none} out"
}
row_revert() {
  lb_targets
  local rc=0 rc2=0
  if [[ -n "$ROW_SOURCE" ]]; then lb_all "$\{ROW_KIND}_enable" "$ROW_SOURCE" source || rc=$?; else rc=75; fi
  if (( rc != 0 && rc != 75 )); then return "$rc"; fi
  if [[ -n "$ROW_TARGET" ]]; then lb_all "$\{ROW_KIND}_del" "$ROW_TARGET" target || rc2=$?; else rc2=75; fi
  if (( rc2 != 0 && rc2 != 75 )); then return "$rc2"; fi
  if (( rc == 75 && rc2 == 75 )); then LB_WHY="already reverted"; return 75; fi
  LB_WHY="source $\{ROW_SOURCE:-none} back, target $\{ROW_TARGET:-none} out"
}
row_check() {
  local a out=""
  lb_targets
  for a in $ROW_SOURCE; do out+=" source $a: $("$\{ROW_KIND}_show" "$a" source)"; done
  for a in $ROW_TARGET; do out+=" target $a: $("$\{ROW_KIND}_show" "$a" target)"; done
  LB_WHY="$\{out# }"
}

lb_each() {
  local fn="$1" step="$2" row rc ok=0 failed=0 skipped=0
  local -a extra=()
  if [[ "$LB_VERB" == revert ]]; then extra=(revert=true); fi
  if [[ "$LB_VERB" == drain ]]; then extra=(lb=drain); fi
  for row in "$\{LB_ROWS[@]}"; do
    lb_row "$row"
    LB_WHY=""
    LB_ERR=""
    rc=0
    lb_need || rc=$?
    if (( rc == 0 )); then "$fn" || rc=$?; fi
    case "$rc" in
      0) atk_event "$ROW_EV_ITEM" "$step" succeeded "" "$ROW_KIND $ROW_POOL: $LB_WHY" kind="$ROW_KIND" pool="$ROW_POOL" "$\{extra[@]}"; ok=$(( ok + 1 )) ;;
      75) atk_event "$ROW_EV_ITEM" "$step" skipped "" "$ROW_KIND $ROW_POOL: $\{LB_WHY:-already done}" kind="$ROW_KIND" pool="$ROW_POOL" "$\{extra[@]}"; skipped=$(( skipped + 1 )) ;;
      ${EXIT_CODES.missing}) exit ${EXIT_CODES.missing} ;;
      *) atk_event "$ROW_EV_ITEM" "$step" failed "" "$ROW_KIND $ROW_POOL: $\{LB_ERR:-failed}" kind="$ROW_KIND" pool="$ROW_POOL" "$\{extra[@]}"; failed=$(( failed + 1 )) ;;
    esac
  done
  atk_log "lb $LB_VERB: $ok done, $skipped skipped, $failed failed"
  if (( failed > 0 )); then exit ${EXIT_CODES.partial}; fi
  return 0
}

lb_load
if (( $\{#LB_ROWS[@]} == 0 )); then
  atk_log "no load-balancer members$\{ATK_WAVE:+ for wave $ATK_WAVE} in members.csv"
  exit 0
fi
case "$LB_VERB" in
  drain) lb_each row_drain freeze ;;
  switch) lb_each row_switch lb-switch ;;
  revert) lb_each row_revert lb-switch ;;
  check) lb_each row_check precheck ;;
esac
`;
}

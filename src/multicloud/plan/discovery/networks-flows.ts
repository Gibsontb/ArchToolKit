/**
 * Flows from VCF Operations for Networks (addendum A.10.1, source 1).
 *
 * `discovery/networks-flows.sh` logs in the way the toolkit's other Networks
 * scripts do (`networksPreamble`: VCFNET_TOKEN, or VCFNET_USER and a mode-600
 * VCFNET_PASSWORD_FILE posted to /api/ni/auth/token), then, for the plan's
 * server addresses in batches:
 *
 *   POST /api/ni/search/ql  {query: "flows where source ip address in (…) in last 30 days", size, cursor}
 *   POST /api/ni/entities/fetch  {entity_ids: [{entity_id, entity_type}]}
 *
 * and writes flows.csv in the canonical layout. It reads only; there is
 * nothing to dry-run.
 *
 * Verify: the search language is the search bar's, and the flow entity's
 * field names (source_ip.ip_address, destination_ip.ip_address, port.start,
 * protocol) are from the API reference's Flow schema; check the first run's
 * `raw/` output on the instance, as vcf-networks-logs.ts notes for this API.
 */

import { networksPreamble } from '../../../automation/blueprints/vcf-networks-logs.ts';
import type { Plan } from '../types.ts';
import { canonicalIp, FLOWS_CSV_HEADER, normaliseProtocol, normaliseTime, type FlowRecord } from './flows.ts';

export interface NetworksFlowsOptions {
  /** Addresses per search. Default 50: the query text stays well under the search bar's limits. */
  readonly batch?: number;
  /** Look-back window in days. Default 30. */
  readonly days?: number;
  /** Results per page. Default 1000. */
  readonly pageSize?: number;
}

export const NETWORKS_FLOWS_SOURCES = Object.freeze([
  'POST /api/ni/auth/token, POST /api/ni/search/ql {query, size, cursor}, POST /api/ni/entities/fetch: VCF Operations for Networks API reference (Authentication, Search, Entities) — verify the Flow entity fields on the instance.',
]);

/** Every server address in the plan, both families, sorted and unique. */
export function planAddresses(plan: Pick<Plan, 'workloads'>): string[] {
  const set = new Set<string>();
  for (const w of plan.workloads) for (const ip of w.facts?.ipAddresses ?? []) {
    const c = canonicalIp(ip);
    if (c) set.add(c);
  }
  return [...set].sort();
}

/** The search text for one batch of addresses, in one direction. */
export function flowQuery(addresses: readonly string[], direction: 'source' | 'destination', days: number): string {
  return `flows where ${direction} ip address in (${addresses.map((a) => `'${a}'`).join(', ')}) in last ${days} days`;
}

/**
 * The generated files: the script and the address list it reads. The address
 * list is data from the plan (server IPs), not a secret.
 */
export function networksFlowsFiles(plan: Pick<Plan, 'workloads'>, options: NetworksFlowsOptions = {}): Record<string, string> {
  const batch = Math.max(1, Math.min(200, options.batch ?? 50));
  const days = Math.max(1, Math.min(90, options.days ?? 30));
  const size = Math.max(10, Math.min(10000, options.pageSize ?? 1000));
  const addresses = planAddresses(plan);
  const script = [
    '#!/usr/bin/env bash',
    '# Flows for the plan\'s servers from VCF Operations for Networks, as flows.csv.',
    '# Reads only. Usage: ./networks-flows.sh [server-ips.txt] [flows.csv]',
    '#',
    '# Needs VCFNET_HOST and either VCFNET_TOKEN or VCFNET_USER + VCFNET_PASSWORD_FILE',
    '# (a file holding the password, mode 600). The password is never an argument.',
    '# Verify on first run: the Flow entity field names are read from raw/*.json.',
    'set -euo pipefail',
    '',
    ...networksPreamble(),
    '',
    'IPS_FILE="${1:-$(dirname "$0")/server-ips.txt}"',
    'OUT="${2:-flows.csv}"',
    `BATCH=${batch}`,
    `DAYS=${days}`,
    `SIZE=${size}`,
    'RAW="$(dirname "$OUT")/raw"',
    'mkdir -p "$RAW"',
    '[[ -s "$IPS_FILE" ]] || { echo "No addresses in $IPS_FILE" >&2; exit 2; }',
    '',
    'ni() {',
    '  local path="$1"; shift',
    '  curl -sS -f -X POST "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H @<(printf \'Authorization: NetworkInsight %s\\n\' "$VCFNET_TOKEN") \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    '',
    'IDS=$(mktemp)',
    'trap \'rm -f "$IDS"\' EXIT',
    'mapfile -t ALL < <(grep -v \'^\\s*\\(#\\|$\\)\' "$IPS_FILE")',
    'n=0',
    'for ((i = 0; i < ${#ALL[@]}; i += BATCH)); do',
    '  list=$(printf "\'%s\', " "${ALL[@]:i:BATCH}")',
    '  list=${list%, }',
    '  for dir in source destination; do',
    '    query="flows where ${dir} ip address in (${list}) in last ${DAYS} days"',
    '    cursor=""',
    '    while :; do',
    '      n=$((n + 1))',
    '      jq -n --arg q "$query" --argjson s "$SIZE" --arg c "$cursor" \'{query: $q, size: $s} + (if $c == "" then {} else {cursor: $c} end)\' \\',
    '        | ni /search/ql --data @- > "$RAW/search-${n}.json" || { echo "Search failed: $query" >&2; exit 1; }',
    '      jq -r \'.entity_list_response.results[]? | [.entity_id, (.entity_type // "Flow")] | @tsv\' "$RAW/search-${n}.json" >> "$IDS"',
    '      cursor=$(jq -r \'.entity_list_response.cursor // empty\' "$RAW/search-${n}.json")',
    '      got=$(jq -r \'.entity_list_response.results | length\' "$RAW/search-${n}.json")',
    '      [[ -n "$cursor" && "$got" -gt 0 ]] || break',
    '    done',
    '  done',
    'done',
    '',
    'sort -u "$IDS" -o "$IDS"',
    `echo '${FLOWS_CSV_HEADER}' > "$OUT"`,
    'f=0',
    '# Fetch the flow entities 100 at a time and write one row per flow.',
    'while mapfile -t -n 100 CHUNK && ((${#CHUNK[@]})); do',
    '  f=$((f + 1))',
    '  printf \'%s\\n\' "${CHUNK[@]}" | jq -R -s \'{entity_ids: [split("\\n")[] | select(length > 0) | split("\\t") | {entity_id: .[0], entity_type: .[1]}]}\' \\',
    '    | ni /entities/fetch --data @- > "$RAW/entities-${f}.json" || { echo "Entity fetch failed" >&2; exit 1; }',
    '  jq -r \'(.results // .entities // [])[] | (.entity // .) |',
    '    [(.source_ip.ip_address // ""), (.destination_ip.ip_address // ""), (.port.start // .port.display // ""),',
    '     (.protocol // "TCP"), 1, "", "", "", "", (.destination_vm.name // .destination_vm_name // "")] | @csv\' \\',
    '    "$RAW/entities-${f}.json" >> "$OUT"',
    'done < "$IDS"',
    'echo "Wrote $(($(wc -l < "$OUT") - 1)) flow(s) to $OUT"',
    '',
  ].join('\n');
  return {
    'discovery/networks-flows.sh': script,
    'discovery/server-ips.txt': `${addresses.join('\n')}${addresses.length ? '\n' : ''}`,
  };
}

/**
 * Parse the entities the script fetched (`raw/entities-*.json`) or a flow
 * search's saved JSON, for a user who has the JSON rather than the CSV. Fields
 * as NETWORKS_FLOWS_SOURCES notes (verify).
 */
export function parseNetworksEntities(json: unknown): FlowRecord[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const list = (Array.isArray(root.results) ? root.results : Array.isArray(root.entities) ? root.entities : Array.isArray(json) ? json : []) as unknown[];
  const out: FlowRecord[] = [];
  const s = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  for (const item of list) {
    const e = ((item as Record<string, unknown>)?.entity ?? item) as Record<string, Record<string, unknown> | string | undefined>;
    const src = canonicalIp(s((e.source_ip as Record<string, unknown> | undefined)?.ip_address));
    const dst = canonicalIp(s((e.destination_ip as Record<string, unknown> | undefined)?.ip_address));
    const port = Number(s((e.port as Record<string, unknown> | undefined)?.start ?? (e.port as Record<string, unknown> | undefined)?.display));
    if (!src || !dst || !Number.isInteger(port)) continue;
    const name = s((e.destination_vm as Record<string, unknown> | undefined)?.name);
    const time = normaliseTime(s((item as Record<string, unknown>)?.time));
    out.push({
      sourceIp: src, destIp: dst, destPort: port, protocol: normaliseProtocol(s(e.protocol)), observations: 1,
      ...(time ? { firstSeen: time, lastSeen: time } : {}),
      ...(name ? { destName: name } : {}),
    });
  }
  return out;
}

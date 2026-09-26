/**
 * VCF Operations setup: what the apply scripts share.
 *
 * Every setup script here does the same three things before it changes
 * anything: logs in (apply.ts), turns the names a person typed into the ids
 * the API wants — the outbound instance, the policy, the custom group, the
 * collector group — and refuses to go on if a name matches nothing or more
 * than one thing. A <REQUIRED — look up the id> in a payload is a step someone
 * skips; a lookup in the script is not.
 *
 * The lookups read, so they run under --dry-run too: the dry run prints the
 * body exactly as it would be sent, ids and all.
 */

import { authHeader, authPreamble } from '../apply.js';

const PLATFORM = 'vcf-operations'         ;

                            
                        
                        
 

/**
 * Object kinds, as adapter kind / resource kind. The VMWARE ones are the vCenter
 * adapter's own; the vSAN, NSX, Supervisor, VKS and VCF ones are the keys their
 * integrations publish — VERIFY with GET /suite-api/api/adapterkinds/{a}/resourcekinds.
 */
export const OBJECT_KINDS                                                             = [
  { value: 'VMWARE/VirtualMachine', label: 'Virtual machines', group: 'vSphere' },
  { value: 'VMWARE/HostSystem', label: 'ESX hosts', group: 'vSphere' },
  { value: 'VMWARE/ClusterComputeResource', label: 'Clusters', group: 'vSphere' },
  { value: 'VMWARE/Datastore', label: 'Datastores', group: 'vSphere' },
  { value: 'VMWARE/StoragePod', label: 'Datastore clusters', group: 'vSphere' },
  { value: 'VMWARE/VmwareDistributedVirtualSwitch', label: 'Distributed switches', group: 'vSphere' },
  { value: 'VMWARE/DistributedVirtualPortgroup', label: 'Distributed port groups', group: 'vSphere' },
  { value: 'VMWARE/Datacenter', label: 'Datacenters', group: 'vSphere' },
  { value: 'VMWARE/VMwareAdapter Instance', label: 'vCenters', group: 'vSphere' },
  { value: 'VirtualAndPhysicalSANAdapter/VirtualSANDCCluster', label: 'vSAN clusters', group: 'vSAN' },
  { value: 'NSXTAdapter/TransportNode', label: 'NSX transport nodes', group: 'NSX' },
  { value: 'NSXTAdapter/LogicalSwitch', label: 'NSX segments', group: 'NSX' },
  { value: 'NSXTAdapter/LogicalRouter', label: 'NSX gateways', group: 'NSX' },
  { value: 'VMWARE/Namespace', label: 'Supervisor namespaces', group: 'Supervisor and VKS' },
  { value: 'KubernetesAdapter/KubernetesCluster', label: 'VKS clusters', group: 'Supervisor and VKS' },
  { value: 'VcfAdapter/VCFSystem', label: 'VCF instances', group: 'VCF' },
  { value: 'VcfAdapter/VCFDomain', label: 'VCF workload domains', group: 'VCF' },
];

/** Rows of a " | " table: blank lines and # comments skipped, cells trimmed. */
export function rowsOf(text        )             {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+\|\s+/).map((cell) => cell.trim()));
}

/** Rows of a CSV with a header line (no quoting beyond a plain comma split). */
export function csvRows(text        )                                         {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const header = (lines[0] ?? '').split(',').map((cell) => cell.trim().toLowerCase());
  return { header, rows: lines.slice(1).map((line) => line.split(',').map((cell) => cell.trim())) };
}

/** "VMWARE/VirtualMachine" as its two halves; a bare kind is a VMWARE one. */
export function kindOf(value        )                                                {
  const [left, right] = value.includes('/') ? value.split('/', 2) : ['VMWARE', value];
  return { adapterKind: (left ?? 'VMWARE').trim() || 'VMWARE', resourceKind: (right ?? '').trim() };
}

/** A bare IPv6 literal, as opposed to a name or an IPv4 address. */
export function isIpv6(host        )          {
  return /^[0-9a-f]*:[0-9a-f:.]*$/i.test(host.replace(/^\[|\]$/g, '')) && host.includes(':');
}

/** An IPv6 address written into a URL without the brackets a URL needs. */
export function bareIpv6InUrl(url        )          {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(url);
  if (!match) return false;
  const authority = match[1] ?? '';
  return !authority.startsWith('[') && (authority.match(/:/g) ?? []).length > 1;
}

/** Shell-quote for a single-quoted bash string. */
export function sh(text        )         {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The lookups: each prints one id, or fails loudly. Names are compared
 * exactly, so "Production" does not quietly match "Production — old".
 */
const LOOKUPS                    = [
  '# uri TEXT: TEXT percent-encoded, for a query string.',
  'uri() { jq -rn --arg v "$1" \'$v | @uri\'; }',
  '# one WHAT JSON: exactly one id, or stop.',
  'one() {',
  '  local what="$1" ids="$2" n',
  '  n=$(jq \'length\' <<<"$ids")',
  '  if [[ "$n" == 0 ]]; then echo "Not found: ${what}." >&2; exit 1; fi',
  '  if [[ "$n" != 1 ]]; then echo "${what} matches ${n} objects; make the name unique first." >&2; exit 1; fi',
  '  jq -r \'.[0]\' <<<"$ids"',
  '}',
  'plugin_id() { one "outbound instance \\"$1\\"" "$(api GET alertplugins | jq -c --arg n "$1" \'[(.notificationPluginInstances[]?, .pluginInstances[]?) | select(.name == $n) | .pluginId]\')"; }',
  'policy_id() { one "policy \\"$1\\"" "$(api GET policies | jq -c --arg n "$1" \'[(.policySummaries[]?, ."policy-summaries"[]?) | select(.name == $n) | .id]\')"; }',
  'group_id() { one "custom group \\"$1\\"" "$(api GET "resources/groups?pageSize=10000" | jq -c --arg n "$1" \'[.groups[]? | select(.resourceKey.name == $n) | .id]\')"; }',
  '# resource_id NAME [ADAPTER_KIND RESOURCE_KIND]',
  'resource_id() {',
  '  local q="resources?pageSize=1000&name=$(uri "$1")"',
  '  [[ -n "${3:-}" ]] && q="${q}&adapterKind=$(uri "$2")&resourceKind=$(uri "$3")"',
  '  one "object \\"$1\\"${3:+ ($3)}" "$(api GET "$q" | jq -c --arg n "$1" \'[.resourceList[]? | select(.resourceKey.name == $n) | .identifier]\')"',
  '}',
  'collector_group_id() { one "collector group \\"$1\\"" "$(api GET collectorgroups | jq -c --arg n "$1" \'[.collectorGroups[]? | select(.name == $n) | .id]\')"; }',
  'auth_source_id() { one "authentication source \\"$1\\"" "$(api GET auth/sources | jq -c --arg n "$1" \'[.sources[]? | select(.name == $n) | .id]\')"; }',
  'report_definition_id() { one "report definition \\"$1\\"" "$(api GET "reportdefinitions?pageSize=1000&name=$(uri "$1")" | jq -c --arg n "$1" \'[.reportDefinitions[]? | select(.name == $n) | .id]\')"; }',
];

/**
 * A setup script: log in, look up, then send. `send METHOD PATH` reads the
 * body on stdin, so nothing sensitive is ever an argument; under --dry-run it
 * prints the body instead. Secrets named in `secrets` are required only when
 * it is going to send.
 */
export function opsScript(opts   
                                    
                                          
                                      
                                     
                                   
                        
 )         {
  return [
    '#!/usr/bin/env bash',
    ...opts.about.map((line) => `# ${line}`),
    '#',
    '# Applies when run. With --dry-run it looks the names up, prints what it would',
    '# send, and changes nothing.',
    'set -euo pipefail',
    '',
    ...authPreamble(PLATFORM),
    `for tool in ${['curl', 'jq', ...(opts.tools ?? [])].join(' ')}; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done`,
    'DRY_RUN=0',
    'for arg in "$@"; do case "$arg" in --dry-run) DRY_RUN=1 ;; esac; done',
    ...(opts.env ?? []).map((env) => `: "\${${env.name}:?set ${env.name} to ${env.hint}}"`),
    ...(opts.secrets ?? []).map((env) => `(( DRY_RUN )) || : "\${${env.name}:?set ${env.name} to ${env.hint}}"`),
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    '',
    '# api METHOD PATH [curl args]: one call to /suite-api/api.',
    'api() {',
    '  local method="$1" path="$2"; shift 2',
    `  curl -sS -f -X "$method" "https://\${VCFOPS_HOST}/suite-api/api/\${path}" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" "$@"`,
    '}',
    '# send METHOD PATH: the JSON body on stdin, the response on stdout. Under',
    '# --dry-run the body is printed to stderr and a stand-in id comes back.',
    'send() {',
    '  if (( DRY_RUN )); then',
    '    echo "DRY RUN: would $1 https://${VCFOPS_HOST}/suite-api/api/$2 with:" >&2',
    '    jq . >&2',
    '    echo \'{"id": "DRY-RUN", "pluginId": "DRY-RUN"}\'',
    '    return 0',
    '  fi',
    '  api "$1" "$2" -H "Content-Type: application/json" --data-binary @-',
    '}',
    ...LOOKUPS,
    '',
    ...opts.body,
    '',
    'if (( DRY_RUN )); then echo "Dry run: nothing was changed. Run it without --dry-run to apply."; fi',
    '',
    `# Undo: ${opts.undo}`,
    '',
  ].join('\n');
}

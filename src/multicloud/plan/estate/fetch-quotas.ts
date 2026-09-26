/**
 * `capacity/fetch-quotas.sh` (addendum A.5.4): reads the real quotas of the
 * platforms and regions the plan uses, with each provider's own CLI, and
 * writes `quotas.json` for `#capacity` to import (`parseQuotasJson`).
 *
 *   AWS     aws service-quotas get-service-quota --service-code … --quota-code …
 *   Azure   az vm list-usage --location <r> -o json; az network list-usages
 *   Google  gcloud compute regions describe <r> --format=json(quotas)
 *   OCI     oci limits resource-availability get --service-name … --limit-name …
 *           --compartment-id "$OCI_TENANCY_OCID" --availability-domain …
 *
 * It only reads. It runs as generated (no prompt, no dry run to opt out of),
 * signs in the way each CLI already is (no credential is written, asked for
 * or echoed), needs `jq`, and carries no footprint: the output is the same for
 * the same quotas.
 */

import { PLATFORM_VALUES } from '../options.ts';
import type { Plan, Platform } from '../types.ts';
import { QUOTA_DEFAULTS, type QuotaDefault } from './quota-data.ts';

export const FETCH_QUOTAS_PATH = 'capacity/fetch-quotas.sh';
export const QUOTAS_KIND = 'archtoolkit.quotas';

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The regions to query per platform: the primary (and DR) regions of the plan's requirements. */
export function quotaRegions(plan: Pick<Plan, 'requirements'>, platforms?: readonly Platform[]): Partial<Record<Platform, string[]>> {
  const out: Partial<Record<Platform, string[]>> = {};
  for (const p of PLATFORM_VALUES) {
    if (p === 'vmware') continue;
    if (platforms && !platforms.includes(p)) continue;
    if (!platforms && !plan.requirements.allowed.includes(p)) continue;
    const r = plan.requirements.regions[p];
    const list = [r?.primary?.trim(), r?.dr?.trim()].filter((x): x is string => !!x);
    if (list.length > 0) out[p] = [...new Set(list)];
  }
  return out;
}

function awsLines(q: QuotaDefault, region: string): string[] {
  if (q.fetch?.cli !== 'aws') return [];
  return [
    `v=$(aws service-quotas get-service-quota --region ${sh(region)} --service-code ${sh(q.fetch.serviceCode)} --quota-code ${sh(q.fetch.quotaCode)} --query 'Quota.Value' --output text 2>/dev/null || echo "")`,
    `emit aws ${sh(region)} ${sh(q.id)} "$v"`,
  ];
}

function azureLines(qs: readonly QuotaDefault[], region: string): string[] {
  const lines: string[] = [];
  const vm = qs.filter((q) => q.fetch?.cli === 'azure' && q.fetch.command === 'vm');
  const net = qs.filter((q) => q.fetch?.cli === 'azure' && q.fetch.command === 'network');
  if (vm.length > 0) {
    lines.push(`usage=$(az vm list-usage --location ${sh(region)} -o json 2>/dev/null || echo '[]')`);
    for (const q of vm) if (q.fetch?.cli === 'azure') lines.push(`v=$(printf '%s' "$usage" | jq -r --arg n ${sh(q.fetch.usageName)} '[.[] | select(.name.value == $n) | .limit][0] // empty')`, `emit azure ${sh(region)} ${sh(q.id)} "$v"`);
    // The largest per-family limit, for the per-family check.
    const fam = qs.find((q) => q.id === 'azure.vcpu.family');
    if (fam) lines.push(`v=$(printf '%s' "$usage" | jq -r '[.[] | select(.name.value | test("Family$")) | (.limit | tonumber)] | max // empty')`, `emit azure ${sh(region)} ${sh(fam.id)} "$v"`);
  }
  if (net.length > 0) {
    lines.push(`usage=$(az network list-usages --location ${sh(region)} -o json 2>/dev/null || echo '[]')`);
    for (const q of net) if (q.fetch?.cli === 'azure') lines.push(`v=$(printf '%s' "$usage" | jq -r --arg n ${sh(q.fetch.usageName)} '[.[] | select(.name.value == $n) | .limit][0] // empty')`, `emit azure ${sh(region)} ${sh(q.id)} "$v"`);
  }
  return lines;
}

function googleLines(qs: readonly QuotaDefault[], region: string): string[] {
  const g = qs.filter((q) => q.fetch?.cli === 'gcloud');
  if (g.length === 0) return [];
  const lines = [`quotas=$(gcloud compute regions describe ${sh(region)} --format='json(quotas)' 2>/dev/null || echo '{}')`];
  for (const q of g) {
    if (q.fetch?.cli !== 'gcloud') continue;
    lines.push(`v=$(printf '%s' "$quotas" | jq -r --arg m ${sh(q.fetch.metric)} '[.quotas[]? | select(.metric == $m) | .limit][0] // empty')`, `emit google ${sh(region)} ${sh(q.id)} "$v"`);
  }
  return lines;
}

function ociLines(qs: readonly QuotaDefault[], region: string): string[] {
  const o = qs.filter((q) => q.fetch?.cli === 'oci');
  if (o.length === 0) return [];
  const lines = [
    `for ad in $(oci iam availability-domain list --region ${sh(region)} --compartment-id "$OCI_TENANCY_OCID" --query 'data[].name' --raw-output 2>/dev/null | jq -r '.[]?' || true); do`,
  ];
  for (const q of o) {
    if (q.fetch?.cli !== 'oci') continue;
    lines.push(
      `  v=$(oci limits resource-availability get --region ${sh(region)} --service-name ${sh(q.fetch.service)} --limit-name ${sh(q.fetch.limitName)} --compartment-id "$OCI_TENANCY_OCID" --availability-domain "$ad" 2>/dev/null | jq -r '(.data.used // 0) + (.data.available // 0)' || echo "")`,
      `  emit oci ${sh(region)} ${sh(q.id)} "$v"`,
    );
  }
  lines.push('  break', 'done');
  return lines;
}

/**
 * The script's text. `platforms` limits it (default: the allowed platforms
 * with a region set).
 */
export function fetchQuotasScript(plan: Pick<Plan, 'requirements'>, platforms?: readonly Platform[]): string {
  const regions = quotaRegions(plan, platforms);
  const body: string[] = [];
  for (const p of PLATFORM_VALUES) {
    const list = regions[p];
    if (!list) continue;
    const qs = QUOTA_DEFAULTS.filter((q) => q.platform === p && q.fetch);
    if (qs.length === 0) continue;
    body.push('', `# ${p === 'google' ? 'Google Cloud (GCP)' : p === 'aws' ? 'AWS' : p === 'azure' ? 'Azure' : 'OCI'}`);
    if (p === 'aws') body.push('if command -v aws >/dev/null 2>&1; then');
    if (p === 'azure') body.push('if command -v az >/dev/null 2>&1; then');
    if (p === 'google') body.push('if command -v gcloud >/dev/null 2>&1; then');
    if (p === 'oci') body.push('if command -v oci >/dev/null 2>&1 && [ -n "${OCI_TENANCY_OCID:-}" ]; then');
    for (const region of list) {
      const lines = p === 'aws' ? qs.flatMap((q) => awsLines(q, region)) : p === 'azure' ? azureLines(qs, region) : p === 'google' ? googleLines(qs, region) : ociLines(qs, region);
      body.push(...lines.map((l) => `  ${l}`));
    }
    body.push(p === 'oci'
      ? 'else\n  echo "OCI: skipped (the oci CLI, or OCI_TENANCY_OCID with your tenancy OCID, is missing)." >&2\nfi'
      : `else\n  echo "${p}: skipped (its CLI is not installed or not on PATH)." >&2\nfi`);
  }
  return [
    '#!/usr/bin/env bash',
    '# Reads the real service quotas of the regions this plan uses and writes quotas.json,',
    '# to import on the Capacity pane. It only reads; each CLI signs in the way it already is.',
    '# Needs jq. OCI also needs OCI_TENANCY_OCID (your tenancy OCID) in the environment.',
    'set -euo pipefail',
    '',
    'out="${1:-quotas.json}"',
    'lines=$(mktemp)',
    'trap \'rm -f "$lines"\' EXIT',
    '',
    '# One JSON object per quota read; empty values (not available to this account) are skipped.',
    'emit() {',
    '  [ -n "${4:-}" ] && [ "$4" != "None" ] || return 0',
    '  jq -cn --arg platform "$1" --arg region "$2" --arg quota "$3" --arg actual "$4" \\',
    '    \'{platform: $platform, region: $region, quota: $quota, actual: ($actual | tonumber)}\' >> "$lines"',
    '}',
    ...body,
    '',
    `jq -s '{kind: "${QUOTAS_KIND}", v: 1, quotas: (. | sort_by(.platform, .region, .quota))}' "$lines" > "$out"`,
    'echo "Wrote $out."',
    '',
  ].join('\n');
}

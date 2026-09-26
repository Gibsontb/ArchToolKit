/**
 * `rightsize-after.sh` (addendum A.10.12): at the end of hypercare, 14 days
 * of target metrics per item, written as percentiles to
 * `status/observed.json` (imported as `WorkloadFacts.observedOnTarget`; the
 * `server` sizing engine re-runs with `basis: observed`). Nothing is resized:
 * a downsize or upsize is a proposal (finding `size.after-move`) and a
 * Resize utility bundle.
 *
 * | Platform | CPU | Memory |
 * |---|---|---|
 * | AWS | `aws cloudwatch get-metric-data` CPUUtilization | CWAgent `mem_used_percent` (the CloudWatch agent) |
 * | Azure | `az monitor metrics list` Percentage CPU | Available Memory Bytes (against the VM size) |
 * | Google Cloud (GCP) | Cloud Monitoring `timeSeries.list` `compute.googleapis.com/instance/cpu/utilization` | `agent.googleapis.com/memory/percent_used` (Ops Agent) |
 * | OCI | `oci monitoring metric-data summarize-metrics-data` CpuUtilization | MemoryUtilization |
 *
 * Read-only (hourly means; p50, p95 and max). The Google Cloud access token
 * goes to curl in a config on stdin, never as an argument.
 */

import { EXIT_CODES } from '../contract.ts';
import { code } from '../lib-sh.ts';

export const RIGHTSIZE_FILE = 'rightsize-after.sh';
export const RIGHTSIZE_DAYS = 14;

export function renderRightsizeAfter(): string {
  return code`#!/usr/bin/env bash
# rightsize-after.sh: ${RIGHTSIZE_DAYS} days of target metrics per cut-over item (A.10.12), as hourly-mean percentiles
# (p50, p95, max) of CPU and memory, into status/observed.json. Read-only: nothing is resized.
#   rightsize-after.sh [--wave N] [--item ID] [--timeout MINUTES]
# Environment: ATK_RIGHTSIZE_DAYS (default ${RIGHTSIZE_DAYS}); Azure memory needs the VM size's RAM (the manifest's target.ramGib).
# Exit codes: 0 ok, 2 usage, 3 missing tool, 10 some items had no metrics, 1 other.
set -Eeuo pipefail
source "$(cd "$(dirname "$\{BASH_SOURCE[0]}")" && pwd)/lib/atk.sh"
atk_init_tool orchestrator "$@"
atk_need jq date

RS_DAYS="$\{ATK_RIGHTSIZE_DAYS:-${RIGHTSIZE_DAYS}}"
RS_END="$(date -u +%Y-%m-%dT%H:00:00Z)"
RS_START="$(date -u -d "$RS_DAYS days ago" +%Y-%m-%dT%H:00:00Z 2> /dev/null || date -u -v-"$RS_DAYS"d +%Y-%m-%dT%H:00:00Z)"
RS_OUT="$ATK_STATUS/observed.json"
RS_CPU=""
RS_MEM=""

rs_items() {
  RS_ITEMS=()
  local id f ok lname
  for id in "$\{ATK_ALL_IDS[@]}"; do
    [[ "$\{ATK_KIND[$id]}" == workload ]] || continue
    if [[ -n "$ATK_WAVE" && "$\{ATK_ITEM_WAVE[$id]}" != "$ATK_WAVE" ]]; then continue; fi
    if (( $\{#ATK_ITEM_FILTER[@]} )); then
      ok=0
      lname="$\{ATK_NAME[$id],,}"
      for f in "$\{ATK_ITEM_FILTER[@]}"; do if [[ "$f" == "$id" || "$\{f,,}" == "$lname" ]]; then ok=1; fi; done
      (( ok )) || continue
    fi
    RS_ITEMS+=("$id")
  done
}
rs_data() {
  local file="$ATK_STATUS/events.jsonl"
  [[ -f "$file" ]] || return 0
  jq -r --arg id "$1" --arg key "$2" 'select(.item == $id and .step == "cutover" and .outcome == "succeeded" and .dryRun == false and ((.data // {})[$key] // null) != null) | .data[$key] | tostring' "$file" | tail -n 1
}
# rs_pct: stdin numbers (one per line) -> {"p50":…,"p95":…,"max":…,"n":…} or null.
rs_pct() {
  jq -sc 'map(select(type == "number")) | sort | if length == 0 then null else {p50: .[((length - 1) * 0.5 | floor)], p95: .[((length - 1) * 0.95 | floor)], max: .[-1], n: length} | map_values(if type == "number" then (. * 100 | round / 100) else . end) end'
}

rs_aws() {
  local tid="$1" region="$2" q out
  atk_need aws
  q="$(jq -nc --arg id "$tid" '[
    {Id: "cpu", MetricStat: {Metric: {Namespace: "AWS/EC2", MetricName: "CPUUtilization", Dimensions: [{Name: "InstanceId", Value: $id}]}, Period: 3600, Stat: "Average"}},
    {Id: "mem", MetricStat: {Metric: {Namespace: "CWAgent", MetricName: "mem_used_percent", Dimensions: [{Name: "InstanceId", Value: $id}]}, Period: 3600, Stat: "Average"}}]')"
  out="$(aws cloudwatch get-metric-data --metric-data-queries "$q" --start-time "$RS_START" --end-time "$RS_END" $\{region:+--region "$region"} --output json)" || return 1
  RS_CPU="$(jq '.MetricDataResults[] | select(.Id == "cpu") | .Values[]' <<< "$out" | rs_pct)"
  RS_MEM="$(jq '.MetricDataResults[] | select(.Id == "mem") | .Values[]' <<< "$out" | rs_pct)"
}
rs_azure() {
  local vm="$1" ram="$3" out
  atk_need az
  out="$(az monitor metrics list --resource "$vm" --metric "Percentage CPU" "Available Memory Bytes" --interval PT1H --aggregation Average --start-time "$RS_START" --end-time "$RS_END" -o json)" || return 1
  RS_CPU="$(jq '.value[] | select(.name.value == "Percentage CPU") | .timeseries[]?.data[]?.average // empty' <<< "$out" | rs_pct)"
  if [[ -n "$ram" && "$ram" != null ]]; then
    RS_MEM="$(jq --argjson gib "$ram" '.value[] | select(.name.value == "Available Memory Bytes") | .timeseries[]?.data[]?.average // empty | 100 - (. / ($gib * 1073741824) * 100)' <<< "$out" | rs_pct)"
  fi
}
rs_gcp_series() {
  local project="$1" filter="$2" token="$3"
  {
    printf 'silent\nshow-error\nfail\n'
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    printf 'url = "https://monitoring.googleapis.com/v3/projects/%s/timeSeries?filter=%s&interval.startTime=%s&interval.endTime=%s&aggregation.alignmentPeriod=3600s&aggregation.perSeriesAligner=ALIGN_MEAN"\n' \
      "$project" "$(jq -rn --arg v "$filter" '$v | @uri')" "$RS_START" "$RS_END"
  } | curl --config -
}
rs_google() {
  local ref="$1" project name zone iid token out
  atk_need gcloud curl
  project="$(sed -E 's#.*projects/([^/]+)/.*#\1#' <<< "$ref")"
  iid="$(gcloud compute instances describe "$ref" --format='value(id)')" || return 1
  token="$(gcloud auth print-access-token)" || return 1
  out="$(rs_gcp_series "$project" "metric.type=\"compute.googleapis.com/instance/cpu/utilization\" AND resource.labels.instance_id=\"$iid\"" "$token")" || return 1
  RS_CPU="$(jq '.timeSeries[]?.points[]?.value.doubleValue * 100' <<< "$out" | rs_pct)"
  out="$(rs_gcp_series "$project" "metric.type=\"agent.googleapis.com/memory/percent_used\" AND metric.labels.state=\"used\" AND resource.labels.instance_id=\"$iid\"" "$token" 2> /dev/null || printf '{}')"
  RS_MEM="$(jq '.timeSeries[]?.points[]?.value.doubleValue' <<< "$out" | rs_pct)"
}
rs_oci() {
  local tid="$1" comp out
  atk_need oci
  comp="$\{OCI_COMPARTMENT_ID:-$(oci compute instance get --instance-id "$tid" --query 'data."compartment-id"' --raw-output)}" || return 1
  out="$(oci monitoring metric-data summarize-metrics-data --compartment-id "$comp" --namespace oci_computeagent --query-text "CpuUtilization[1h]{resourceId = \"$tid\"}.mean()" --start-time "$RS_START" --end-time "$RS_END")" || return 1
  RS_CPU="$(jq '.data[0]."aggregated-datapoints"[]?.value' <<< "$out" | rs_pct)"
  out="$(oci monitoring metric-data summarize-metrics-data --compartment-id "$comp" --namespace oci_computeagent --query-text "MemoryUtilization[1h]{resourceId = \"$tid\"}.mean()" --start-time "$RS_START" --end-time "$RS_END" 2> /dev/null || printf '{}')"
  RS_MEM="$(jq '.data[0]."aggregated-datapoints"[]?.value' <<< "$out" | rs_pct)"
}

rs_items
if (( $\{#RS_ITEMS[@]} == 0 )); then atk_log "no cut-over workloads selected"; exit 0; fi
atk_event - manual started "" "post-move right-sizing: $RS_DAYS days of target metrics" check=rightsize days="$RS_DAYS"
result='{}'
failed=0
for id in "$\{RS_ITEMS[@]}"; do
  t="$\{ATK_TARGET[$id]:--}"
  platform="$\{t%%:*}"
  region=""
  if [[ "$t" == *:* ]]; then region="$\{t#*:}"; fi
  tid="$(rs_data "$id" targetId)"
  RS_CPU=""
  RS_MEM=""
  if [[ -z "$tid" ]]; then atk_event "$id" manual skipped "" "right-sizing: no target id from the cutover" check=rightsize; continue; fi
  rc=0
  case "$platform" in
    aws) rs_aws "$tid" "$region" || rc=$? ;;
    azure) rs_azure "$(rs_data "$id" vmId || true)" "" "$(jq -r --arg id "$id" '.items[] | select(.id == $id) | .target.ramGib // empty' "$ATK_HOME/manifest/items.json")" || rc=$? ;;
    google) rs_google "$tid" || rc=$? ;;
    oci) rs_oci "$tid" || rc=$? ;;
    *) atk_event "$id" manual skipped "" "right-sizing: no metrics source for $\{platform:-this platform} (use the platform's own monitoring)" check=rightsize; continue ;;
  esac
  if [[ "$platform" == azure && -z "$RS_CPU" ]]; then rc=0; rs_azure "$tid" "" "" || rc=$?; fi
  if (( rc != 0 )) || [[ -z "$RS_CPU" || "$RS_CPU" == null ]]; then
    atk_event "$id" manual failed "" "right-sizing: no CPU metrics for the last $RS_DAYS days" check=rightsize
    failed=$(( failed + 1 ))
    continue
  fi
  result="$(jq -c --arg id "$id" --arg p "$platform" --argjson cpu "$RS_CPU" --argjson mem "$\{RS_MEM:-null}" --argjson days "$RS_DAYS" \
    '.[$id] = ({platform: $p, days: $days, cpuPct: $cpu} + (if $mem == null then {} else {memPct: $mem} end))' <<< "$result")"
  atk_event "$id" manual succeeded "" "right-sizing: CPU p95 $(jq -r '.p95' <<< "$RS_CPU")%" check=rightsize cpuP95="$(jq -r '.p95' <<< "$RS_CPU")"
done
mkdir -p "$ATK_STATUS"
prev='{}'
if [[ -f "$RS_OUT" ]]; then prev="$(jq -c '.items // {}' "$RS_OUT")"; fi
jq -n --arg plan "$ATK_PLAN_ID" --arg start "$RS_START" --arg end "$RS_END" --argjson prev "$prev" --argjson add "$result" \
  '{kind: "archtoolkit.observed", v: 1, planId: $plan, from: $start, to: $end, basis: "hourly-mean", items: ($prev + $add)}' > "$RS_OUT"
atk_log "wrote status/observed.json: import it in Application Migration (sizing, basis observed); nothing was resized"
if (( failed > 0 )); then exit ${EXIT_CODES.partial}; fi
`;
}

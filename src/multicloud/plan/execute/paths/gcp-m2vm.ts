/**
 * The Google Cloud (GCP) server paths (addendum A.6.7, A.3.4):
 *
 *   gcp-m2vm          Migrate to Virtual Machines, over the VM Migration REST
 *                     API (https://vmmigration.googleapis.com/v1): the GA
 *                     `gcloud migration vms` group has only image imports,
 *                     machine-image imports and target projects, and the
 *                     google provider has no `google_vm_migration_*`.
 *   gcp-image-import  offline: the exported disks are uploaded to Cloud
 *                     Storage and imported as images
 *                     (`gcloud migration vms image-imports create`), then
 *                     the instance is built by Terraform from the image.
 *
 * Files (relative to `migration/execute/`):
 *   paths/gcp-m2vm/m2vm.sh                 the gcp-m2vm verbs
 *   paths/gcp-m2vm/image-import.sh         the gcp-image-import verbs
 *   paths/gcp-m2vm/servers.json            per item: source, VM name, zone, target files
 *   paths/gcp-m2vm/targets/<item>.json     computeEngineTargetDefaults for the cutover
 *   paths/gcp-m2vm/targets/<item>.test.json and for the test clone (the test network)
 *   paths/gcp-m2vm/m2vm-bulk-<n>.csv       the Migrate to VMs bulk file (provider format, 100 rows a file)
 *   paths/gcp-m2vm/README.md
 *
 * Migrate to Virtual Machines has no automatic fallback: a rollback after
 * cutover loses the target's writes (the kit's core warns, `exec.path.no-fallback`).
 */

import { info, warning, type Finding } from '../../../../core/findings.ts';
import type { ExecPath } from '../contract.ts';
import { code, shScript } from '../lib-sh.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext, PathGenerator, ToolNeed } from '../registry.ts';
import { csvText, jsonText, placementOf, subnetKey, TF_OUTPUT_FN, vmName, type Placement } from './cloud-shared.ts';

const DIR = 'paths/gcp-m2vm';
export const M2VM_SCRIPT = `${DIR}/m2vm.sh`;
export const IMAGE_IMPORT_SCRIPT = `${DIR}/image-import.sh`;
const PATHS: readonly ExecPath[] = ['gcp-m2vm', 'gcp-image-import'];

/** The VM Migration API the script calls. */
export const M2VM_API = 'https://vmmigration.googleapis.com/v1';

export const M2VM_NEEDS: readonly ToolNeed[] = Object.freeze([
  { kind: 'command', name: 'gcloud', why: 'access tokens, Compute Engine, Cloud Storage and image imports', install: 'https://cloud.google.com/sdk/docs/install' },
  { kind: 'command', name: 'curl', min: '7.76', why: 'the VM Migration REST API (--fail-with-body)' },
  { kind: 'command', name: 'terraform', min: '1.7', why: 'reading the Google Cloud (GCP) stack outputs; building image-imported instances' },
]);

/** The Migrate to VMs bulk file's columns (import-export page; the optional columns are unverified). */
export const M2VM_BULK_COLUMNS: readonly string[] = Object.freeze([
  'Source name', 'Region', 'Source VM ID', 'Source VM Display name', 'Target instance name', 'Target project', 'Zone', 'Machine type',
  'Network', 'Subnetwork', 'Network tags', 'Labels',
]);
export const M2VM_BULK_MAX_ROWS = 100;

const DISK_TYPE: Readonly<Record<string, string>> = {
  'pd-standard': 'COMPUTE_ENGINE_DISK_TYPE_STANDARD',
  'pd-balanced': 'COMPUTE_ENGINE_DISK_TYPE_BALANCED',
  'pd-ssd': 'COMPUTE_ENGINE_DISK_TYPE_SSD',
  'hyperdisk-balanced': 'COMPUTE_ENGINE_DISK_TYPE_HYPERDISK_BALANCED',
};

/** A label value Compute Engine accepts: lower case, digits, `-` and `_`, at most 63. */
const label = (v: string): string => v.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 63);

interface ServerEntry {
  readonly name: string;
  readonly vm: string;
  readonly source: string;
  readonly sourceKind: 'vmware' | 'aws' | 'azure' | 'image';
  readonly sourceRegion?: string;
  readonly sourceVmId?: string;
  readonly zone: string;
  readonly wave: number | null;
  readonly file: string;
  readonly imageVar: string;
}

/** `computeEngineTargetDefaults` for a phase, with landing-zone keys the script resolves. */
export function targetDefaults(item: ManifestItem, p: Placement, phase: 'test' | 'cutover', planId8: string): Record<string, unknown> {
  const network = phase === 'test' ? p.testNetwork : p.network;
  const vm = vmName(item.name);
  const efi = p.workload?.facts?.firmware === 'efi';
  return {
    vmName: phase === 'test' ? `${vm}-test`.slice(0, 63) : vm,
    targetProject: '@target_project',
    zone: p.zone,
    machineType: p.size,
    networkInterfaces: [{ network: `@network ${network}`, subnetwork: `@subnet ${subnetKey(network, p.tier, p.zoneLetter)}` }],
    networkTags: [p.tier],
    serviceAccount: '@service_account',
    diskType: DISK_TYPE[p.disks[0]?.type ?? 'pd-balanced'] ?? 'COMPUTE_ENGINE_DISK_TYPE_BALANCED',
    labels: { atk_plan: label(planId8), atk_item: label(item.id), atk_wave: item.wave === null ? '' : String(item.wave), atk_phase: phase },
    licenseType: p.windows && p.licence !== 'li' ? 'COMPUTE_ENGINE_LICENSE_TYPE_BYOL' : 'COMPUTE_ENGINE_LICENSE_TYPE_DEFAULT',
    bootOption: efi ? 'COMPUTE_ENGINE_BOOT_OPTION_EFI' : 'COMPUTE_ENGINE_BOOT_OPTION_BIOS',
    secureBoot: false,
    hostname: vm,
  };
}

const COMMON = (region: string, lagSeconds: number): string => code`
M2VM_DIR="$ATK_HOME/paths/gcp-m2vm"
M2VM_TF="$\{ATK_TF_GOOGLE_DIR:-$ATK_ROOT/terraform/google}"
M2VM_INVENTORY="$\{ATK_INVENTORY:-$ATK_ROOT/ansible/inventory}"
M2VM_API="${M2VM_API}"
M2VM_REGION="$\{M2VM_REGION:-${region}}"
M2VM_LAG_MAX=${lagSeconds}
M2VM_OUT=""
M2VM_P=""
M2VM_TP=""
${TF_OUTPUT_FN}
# The stack's m2vm output (project, network and subnet ids, service account), else its landing zone.
m2vm_load() {
  [[ -z "$M2VM_OUT" ]] || return 0
  if ! M2VM_OUT="$(atk_tf_output "$M2VM_TF" m2vm 2> /dev/null)"; then M2VM_OUT="$(atk_tf_output "$M2VM_TF" landing_zone)"; fi
  M2VM_P="$\{M2VM_PROJECT:-$(jq -r .project <<< "$M2VM_OUT")}"
  M2VM_TP="$\{M2VM_TARGET_PROJECT:-$M2VM_P}"
  [[ -n "$M2VM_P" && "$M2VM_P" != null ]] || atk_die 5 "no Google Cloud (GCP) project in the stack outputs: set M2VM_PROJECT"
}
m2vm_lz() { jq -c '{subnet_ids, network_ids, instance_profile: null}' <<< "$M2VM_OUT"; }
m2vm_entry() { jq -c --arg id "$1" '.[$id] // empty' "$M2VM_DIR/servers.json"; }

# A target file with its landing-zone keys, the target project and the service account resolved.
m2vm_target() {
  atk_resolve "$(m2vm_lz)" < "$M2VM_DIR/targets/$1" \
    | jq -c --arg tp "projects/$M2VM_P/locations/global/targetProjects/$M2VM_TP" --arg sa "$(jq -r '.service_account // ""' <<< "$M2VM_OUT")" \
      'walk(if . == "@target_project" then $tp elif . == "@service_account" then $sa else . end) | if .serviceAccount == "" then del(.serviceAccount) else . end'
}

# The instance's addresses as event data.
m2vm_instance_data() {
  local vm="$1" zone="$2" inst
  inst="$(gcloud compute instances describe "$vm" --zone "$zone" --project "$M2VM_TP" --format json 2> /dev/null)" || return 0
  printf 'instanceId=%s\n' "$(jq -r '.id // empty' <<< "$inst")"
  printf 'targetIpv4=%s\n' "$(jq -r '.networkInterfaces[0].networkIP // empty' <<< "$inst")"
  printf 'targetIpv6=%s\n' "$(jq -r '.networkInterfaces[0].ipv6Address // empty' <<< "$inst")"
}
m2vm_instance_status() { gcloud compute instances describe "$1" --zone "$2" --project "$M2VM_TP" --format 'value(status)' 2> /dev/null || true; }

m2vm_validate() {
  local id="$1" ip="$2"
  if [[ ! -f "$ATK_HOME/ansible/validate.yml" ]]; then atk_log "ansible/validate.yml is not in this kit: the test is not validated"; printf failed; return 0; fi
  if atk_run ansible-playbook -i "$M2VM_INVENTORY" "$ATK_HOME/ansible/validate.yml" --limit "$\{ATK_NAME[$id]}" \
      -e validate_phase=test -e "validate_item=$id" -e "validate_address=$ip" >&2; then printf passed; else printf failed; fi
}

m2vm_enable_api() {
  if [[ -n "$(gcloud services list --enabled --project "$M2VM_P" --filter="config.name=$1" --format 'value(config.name)')" ]]; then return 0; fi
  atk_run gcloud services enable "$1" --project "$M2VM_P"
}
`;

const API_FUNCTIONS = code`
# The VM Migration REST API. The token reaches curl as a header file, never as an argument.
m2vm_token() {
  local t
  t="$(gcloud auth print-access-token)"
  _atk_redact_add "$t"
  printf '%s' "$t"
}
m2vm_get() { curl -sS --fail-with-body -H @<(printf 'Authorization: Bearer %s\n' "$(m2vm_token)") "$M2VM_API/$1"; }
m2vm_exists() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$(m2vm_token)") "$M2VM_API/$1")"
  [[ "$code" == 200 ]]
}
# m2vm_call METHOD PATH: a change, with the JSON body on stdin; prints the operation.
m2vm_call() {
  local method="$1" path="$2"
  atk_run curl -sS --fail-with-body -X "$method" -H @<(printf 'Authorization: Bearer %s\n' "$(m2vm_token)") \
    -H 'Content-Type: application/json' --data-binary @- "$M2VM_API/$path"
}
m2vm_op_done() { [[ "$(m2vm_get "$1" | jq -r '.done // false')" == true ]]; }
m2vm_wait() {
  local op="$1" what="$2" name err
  if (( ATK_DRY_RUN )); then return 0; fi
  name="$(jq -r '.name // empty' <<< "$op" 2> /dev/null || true)"
  [[ -n "$name" && "$name" == */operations/* ]] || return 0
  atk_wait_until 60 10 m2vm_op_done "$name" || atk_die 1 "$what: the operation did not finish"
  err="$(m2vm_get "$name" | jq -r '.error.message // empty')"
  [[ -z "$err" ]] || atk_die 1 "$what: $err"
}
# A clone or cutover job, polled to SUCCEEDED.
m2vm_job_state() { m2vm_get "$1" | jq -r '.state // "UNKNOWN"'; }
m2vm_job_done() { [[ "$(m2vm_job_state "$1")" =~ ^(SUCCEEDED|FAILED|CANCELLED)$ ]]; }
m2vm_wait_job() {
  local path="$1" what="$2"
  if (( ATK_DRY_RUN )); then return 0; fi
  atk_wait_until 240 30 m2vm_job_done "$path" || atk_die 1 "$what did not finish"
  [[ "$(m2vm_job_state "$path")" == SUCCEEDED ]] || atk_die 1 "$what ended $(m2vm_job_state "$path")"
}

M2VM_LOC=""
m2vm_loc() { M2VM_LOC="projects/$M2VM_P/locations/$M2VM_REGION"; }
m2vm_mv() { printf '%s/sources/%s/migratingVms/%s' "$M2VM_LOC" "$(jq -r .source <<< "$1")" "$(jq -r .vm <<< "$1")"; }

# The source: created when missing (credentials from the environment or the vault, in the request body only).
m2vm_source() {
  local e="$1" s kind body op
  s="$(jq -r .source <<< "$e")"
  kind="$(jq -r .sourceKind <<< "$e")"
  if ! m2vm_exists "$M2VM_LOC/sources/$s"; then
    case "$kind" in
      vmware)
        [[ -n "$\{M2VM_VCENTER:-}" && -n "$\{M2VM_VCENTER_USER:-}" && -n "$\{M2VM_VCENTER_THUMBPRINT:-}" ]] || atk_die 3 "set M2VM_VCENTER, M2VM_VCENTER_USER and M2VM_VCENTER_THUMBPRINT for the vSphere source"
        atk_secret_to M2VM_SECRET VC_PASSWORD
        body="$(M2VM_SECRET="$M2VM_SECRET" jq -n '{vmware: {vcenterIp: env.M2VM_VCENTER, username: env.M2VM_VCENTER_USER, password: env.M2VM_SECRET, thumbprint: env.M2VM_VCENTER_THUMBPRINT}}')" ;;
      aws)
        atk_secret_to M2VM_KEY M2VM_AWS_ACCESS_KEY_ID
        atk_secret_to M2VM_SECRET M2VM_AWS_SECRET_ACCESS_KEY
        body="$(M2VM_KEY="$M2VM_KEY" M2VM_SECRET="$M2VM_SECRET" M2VM_SRC_REGION="$(jq -r '.sourceRegion // ""' <<< "$e")" \
          jq -n '{aws: {accessKeyCreds: {accessKeyId: env.M2VM_KEY, secretAccessKey: env.M2VM_SECRET}, awsRegion: env.M2VM_SRC_REGION}}')" ;;
      azure)
        [[ -n "$\{M2VM_AZURE_TENANT_ID:-}" && -n "$\{M2VM_AZURE_CLIENT_ID:-}" && -n "$\{M2VM_AZURE_SUBSCRIPTION_ID:-}" ]] || atk_die 3 "set M2VM_AZURE_TENANT_ID, M2VM_AZURE_CLIENT_ID and M2VM_AZURE_SUBSCRIPTION_ID for the Azure source"
        atk_secret_to M2VM_SECRET M2VM_AZURE_CLIENT_SECRET
        body="$(M2VM_SECRET="$M2VM_SECRET" M2VM_SRC_REGION="$(jq -r '.sourceRegion // ""' <<< "$e")" \
          jq -n '{azure: {clientSecretCreds: {tenantId: env.M2VM_AZURE_TENANT_ID, clientId: env.M2VM_AZURE_CLIENT_ID, clientSecret: env.M2VM_SECRET}, subscriptionId: env.M2VM_AZURE_SUBSCRIPTION_ID, azureLocation: env.M2VM_SRC_REGION}}')" ;;
      *) atk_die 1 "no Migrate to VMs source kind $kind" ;;
    esac
    op="$(printf '%s' "$body" | m2vm_call POST "$M2VM_LOC/sources?sourceId=$s")"
    body=""
    m2vm_wait "$op" "create the source $s"
  fi
  if [[ "$kind" == vmware ]] && ! (( ATK_DRY_RUN )); then
    m2vm_get "$M2VM_LOC/sources/$s/datacenterConnectors" | jq -e '[.datacenterConnectors[]? | select(.state == "ACTIVE")] | length > 0' > /dev/null \
      || atk_die 5 "no ACTIVE datacenter connector on the source $s: deploy and register the Migrate Connector OVA (README, step 1)"
  fi
}

# The source VM id: from the manifest, else the source's inventory by display name.
m2vm_vm_id() {
  local e="$1" id
  id="$(jq -r '.sourceVmId // empty' <<< "$e")"
  if [[ -z "$id" ]]; then
    id="$(m2vm_get "$M2VM_LOC/sources/$(jq -r .source <<< "$e"):fetchInventory" \
      | jq -r --arg n "$(jq -r .name <<< "$e")" '[(.vmwareVms.details[]?, .awsVms.details[]?, .azureVms.details[]?) | select((.displayName // "" | ascii_downcase) == ($n | ascii_downcase))] | .[0].vmId // empty')"
  fi
  printf '%s' "$id"
}

# Replication as event data, and whether the VM is in sync (0) or not (1).
M2VM_REPORT=()
m2vm_report() {
  local mv="$1" state pct
  state="$(jq -r '.state // "UNKNOWN"' <<< "$mv")"
  pct="$(jq -r '.currentSyncInfo.progressPercent // (if .state == "ACTIVE" then 100 else 0 end)' <<< "$mv")"
  M2VM_REPORT=("replicationState=$state" "progressPct=$pct" "lastSync=$(jq -r '.lastSync.lastSyncTime // ""' <<< "$mv")")
  [[ "$state" == ACTIVE ]]
}
m2vm_active() { local mv; mv="$(m2vm_get "$1")" && m2vm_report "$mv"; }
m2vm_is_cut() { [[ "$(m2vm_get "$1" | jq -r '.state // ""')" =~ ^(CUTOVER|FINALIZING|FINALIZED)$ ]]; }

# Point the migrating VM's target defaults at FILE (the test or the cutover target).
m2vm_defaults() {
  local mvp="$1" file="$2" want have op
  want="$(m2vm_target "$file")"
  have="$(m2vm_get "$mvp" | jq -c '.computeEngineTargetDefaults // {}')"
  if [[ "$(jq -r .vmName <<< "$want")" == "$(jq -r '.vmName // ""' <<< "$have")" && "$(jq -c .networkInterfaces <<< "$want")" == "$(jq -c '.networkInterfaces // []' <<< "$have")" ]]; then return 0; fi
  op="$(jq -c '{computeEngineTargetDefaults: .}' <<< "$want" | m2vm_call PATCH "$mvp?updateMask=computeEngineTargetDefaults")"
  m2vm_wait "$op" "update the target defaults"
}
`;

const M2VM_VERBS = {
  prepare: code`
local e op
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server: the design has no Google Cloud (GCP) compute target for it; regenerate the kit"
m2vm_load
m2vm_loc
m2vm_enable_api vmmigration.googleapis.com
if ! m2vm_exists "projects/$M2VM_P/locations/global/targetProjects/$M2VM_TP"; then
  op="$(jq -n --arg p "projects/$M2VM_TP" '{project: $p}' | m2vm_call POST "projects/$M2VM_P/locations/global/targetProjects?targetProjectId=$M2VM_TP")"
  m2vm_wait "$op" "register the target project $M2VM_TP"
fi
m2vm_source "$e"
if ! (( ATK_DRY_RUN )) && [[ -z "$(m2vm_vm_id "$e")" ]]; then atk_fail "$id" "the source $(jq -r .source <<< "$e") does not list this VM: check its name in the source, or give its id (sourceRef.id)"; fi
atk_done "$id" prepared "" source="$(jq -r .source <<< "$e")"
`,
  replicate: code`
local e mvp vmid op state group mv
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
if ! m2vm_exists "$mvp"; then
  vmid="$(m2vm_vm_id "$e")"
  [[ -n "$vmid" || "$ATK_DRY_RUN" == 1 ]] || atk_fail "$id" "the source does not list this VM: run prepare"
  op="$(m2vm_target "$(jq -r .file <<< "$e").json" \
    | jq -c --arg v "$vmid" --arg n "$\{ATK_NAME[$id]}" '{sourceVmId: $v, displayName: $n, computeEngineTargetDefaults: ., labels: .labels}' \
    | m2vm_call POST "$M2VM_LOC/sources/$(jq -r .source <<< "$e")/migratingVms?migratingVmId=$(jq -r .vm <<< "$e")")"
  m2vm_wait "$op" "create the migrating VM"
fi
if (( ATK_DRY_RUN )) && ! m2vm_exists "$mvp"; then atk_done "$id" replicating "dry run: the migrating VM and its replication were printed"; fi
state="$(m2vm_get "$mvp" | jq -r '.state // "PENDING"')"
if [[ "$state" == PENDING || "$state" == READY ]]; then
  op="$(printf '{}' | m2vm_call POST "$mvp:startMigration")"
  m2vm_wait "$op" "start replication"
fi
group="atk-$ATK_PLAN8-w$\{ATK_ITEM_WAVE[$id]}"
if [[ "$\{ATK_ITEM_WAVE[$id]}" =~ ^[0-9]+$ ]]; then
  if ! m2vm_exists "$M2VM_LOC/groups/$group"; then
    op="$(jq -n --arg d "wave $\{ATK_ITEM_WAVE[$id]}" '{displayName: $d}' | m2vm_call POST "$M2VM_LOC/groups?groupId=$group")"
    m2vm_wait "$op" "create the group $group"
  fi
  if [[ "$(m2vm_get "$mvp" | jq -r '.group // ""')" != "$M2VM_LOC/groups/$group" ]]; then
    op="$(jq -n --arg m "$mvp" '{migratingVm: $m}' | m2vm_call POST "$M2VM_LOC/groups/$group:addGroupMigration")"
    m2vm_wait "$op" "add to the group $group"
  fi
fi
atk_wait_until 1440 60 m2vm_active "$mvp" || true
mv="$(m2vm_get "$mvp")"
if [[ "$(jq -r .state <<< "$mv")" == ERROR ]]; then atk_fail "$id" "replication is in ERROR: $(jq -r '.error.message // ""' <<< "$mv")"; fi
if m2vm_report "$mv"; then atk_done "$id" in-sync "" inSync=true "$\{M2VM_REPORT[@]}"; fi
atk_done "$id" replicating "" "$\{M2VM_REPORT[@]}"
`,
  test: code`
local e mvp state vm zone op job data=() ip passed
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
vm="$(jq -r .vm <<< "$e")-test"
vm="$\{vm:0:63}"
zone="$(jq -r .zone <<< "$e")"
if [[ -n "$(m2vm_instance_status "$vm" "$zone")" ]]; then
  mapfile -t data < <(m2vm_instance_data "$vm" "$zone")
  atk_skip "$id" "a test clone is already running" testing "$\{data[@]}"
fi
m2vm_exists "$mvp" || atk_fail "$id" "not replicating: run replicate"
state="$(m2vm_get "$mvp" | jq -r .state)"
[[ "$state" == ACTIVE ]] || atk_fail "$id" "a test clone needs the VM ACTIVE (in sync); it is $state"
m2vm_defaults "$mvp" "$(jq -r .file <<< "$e").test.json"
job="test-$\{ATK_RUN_ID:0:8}"
if ! m2vm_exists "$mvp/cloneJobs/$job"; then
  op="$(printf '{}' | m2vm_call POST "$mvp/cloneJobs?cloneJobId=$job")"
  m2vm_wait "$op" "start the test clone"
fi
if (( ATK_DRY_RUN )); then atk_done "$id" testing "dry run: the test clone was printed"; fi
m2vm_wait_job "$mvp/cloneJobs/$job" "the test clone"
mapfile -t data < <(m2vm_instance_data "$vm" "$zone")
ip="$(printf '%s\n' "$\{data[@]}" | sed -n 's/^targetIpv4=//p')"
passed="$(m2vm_validate "$id" "$ip")"
atk_ids_put gcp-m2vm "test:$id" "$passed"
atk_done "$id" testing "" "$\{data[@]}" validated="$passed"
`,
  'test-cleanup': code`
local e mvp vm zone passed
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
vm="$(jq -r .vm <<< "$e")-test"
vm="$\{vm:0:63}"
zone="$(jq -r .zone <<< "$e")"
passed="$(atk_ids_get gcp-m2vm "test:$id" 2> /dev/null || true)"
if [[ -n "$(m2vm_instance_status "$vm" "$zone")" ]]; then
  atk_run gcloud compute instances delete "$vm" --zone "$zone" --project "$M2VM_TP" --quiet
fi
if m2vm_exists "$mvp"; then m2vm_defaults "$mvp" "$(jq -r .file <<< "$e").json"; fi
if [[ "$passed" == passed ]]; then atk_done "$id" "" "" passed=true; fi
atk_done "$id" "" "the test clone is removed; the test did not pass" passed=false
`,
  cutover: code`
local e mvp state vm zone op job data=()
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
vm="$(jq -r .vm <<< "$e")"
zone="$(jq -r .zone <<< "$e")"
m2vm_exists "$mvp" || atk_fail "$id" "not replicating: run replicate"
state="$(m2vm_get "$mvp" | jq -r .state)"
case "$state" in
  CUTOVER|FINALIZING|FINALIZED)
    mapfile -t data < <(m2vm_instance_data "$vm" "$zone")
    atk_skip "$id" "already cut over ($state)" cut-over "$\{data[@]}" ;;
  ACTIVE) ;;
  CUTTING_OVER|FINAL_SYNC) ;;
  *) atk_fail "$id" "a cutover needs the VM ACTIVE; it is $state" ;;
esac
if [[ "$state" == ACTIVE ]]; then
  atk_wait_until 60 30 m2vm_active "$mvp" || atk_fail "$id" "replication is not in sync" "$\{M2VM_REPORT[@]}"
  m2vm_defaults "$mvp" "$(jq -r .file <<< "$e").json"
  job="cutover-$\{ATK_RUN_ID:0:8}"
  op="$(printf '{}' | m2vm_call POST "$mvp/cutoverJobs?cutoverJobId=$job")"
  m2vm_wait "$op" "start the cutover"
  if (( ATK_DRY_RUN )); then atk_done "$id" cut-over "dry run: the cutover was printed"; fi
  m2vm_wait_job "$mvp/cutoverJobs/$job" "the cutover"
else
  atk_wait_until 240 30 m2vm_is_cut "$mvp" || atk_fail "$id" "the cutover in progress did not finish"
fi
mapfile -t data < <(m2vm_instance_data "$vm" "$zone")
atk_ids_put gcp-m2vm "instance:$\{ATK_NAME[$id]}" "$(printf '%s\n' "$\{data[@]}" | sed -n 's/^instanceId=//p')"
atk_done "$id" cut-over "" "$\{data[@]}"
`,
  commit: code`
local e mvp state op
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
m2vm_exists "$mvp" || atk_skip "$id" "no migrating VM (already deleted)"
state="$(m2vm_get "$mvp" | jq -r .state)"
case "$state" in
  FINALIZED|FINALIZING) atk_skip "$id" "already finalized" ;;
  CUTOVER) ;;
  *) atk_fail "$id" "finalize needs a completed cutover; the VM is $state" ;;
esac
op="$(printf '{}' | m2vm_call POST "$mvp:finalizeMigration")"
m2vm_wait "$op" "finalize the migration"
atk_done "$id" "" "finalized: replication stopped"
`,
  rollback: code`
local e mvp state vm zone op kept=false what="no Compute Engine instance was running"
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
vm="$(jq -r .vm <<< "$e")"
zone="$(jq -r .zone <<< "$e")"
if [[ "$(m2vm_instance_status "$vm" "$zone")" == RUNNING ]]; then
  atk_run gcloud compute instances stop "$vm" --zone "$zone" --project "$M2VM_TP"
  what="the Compute Engine instance is stopped and kept for analysis"
fi
if m2vm_exists "$mvp"; then
  state="$(m2vm_get "$mvp" | jq -r .state)"
  if [[ "$state" == CUTOVER ]]; then
    op="$(printf '{}' | m2vm_call POST "$mvp:resumeMigration")"
    m2vm_wait "$op" "resume replication"
    kept=true
  fi
fi
atk_done "$id" "" "$what. Migrate to Virtual Machines has no automatic fallback: writes on the instance are not copied back; restart the source through its adapter" replicationKept="$kept"
`,
  finalize: code`
local e mvp op
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
m2vm_exists "$mvp" || atk_skip "$id" "the migrating VM is already deleted"
op="$(m2vm_call DELETE "$mvp" < /dev/null)"
m2vm_wait "$op" "delete the migrating VM"
atk_done "$id" "" "the migrating VM is deleted"
`,
  status: code`
local e mvp mv
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_skip "$id" "no target for this server"
m2vm_load
m2vm_loc
mvp="$(m2vm_mv "$e")"
m2vm_exists "$mvp" || atk_skip "$id" "not replicating yet"
mv="$(m2vm_get "$mvp")"
if m2vm_report "$mv"; then atk_done "$id" in-sync "" inSync=true "$\{M2VM_REPORT[@]}"; fi
atk_done "$id" "" "" inSync=false "$\{M2VM_REPORT[@]}"
`,
};

const IMAGE_FUNCTIONS = code`
M2VM_BUCKET="$\{M2VM_IMAGE_BUCKET:-}"
M2VM_EXPORT_DIR="$\{M2VM_EXPORT_DIR:-$ATK_ROOT/exports}"
image_bucket() { printf '%s' "$\{M2VM_BUCKET:-$M2VM_P-atk-$ATK_PLAN8-images}"; }

# The exported disks of an item on the controller: $M2VM_EXPORT_DIR/<name>/, the boot disk first by name.
image_disks() {
  local dir="$M2VM_EXPORT_DIR/$1"
  [[ -d "$dir" ]] || return 0
  find "$dir" -maxdepth 1 -type f \( -iname '*.vmdk' -o -iname '*.vhd' -o -iname '*.vhdx' -o -iname '*.qcow2' -o -iname '*.raw' -o -iname '*.img' \) | LC_ALL=C sort
}

# Stop the source through its adapter, when the kit has one for the platform.
image_stop_source() {
  local id="$1" platform="$\{ATK_SOURCE[$1]:-}" args=(stop --item "$1")
  if (( ATK_DRY_RUN )); then args+=(--dry-run); fi
  if [[ -x "$ATK_HOME/source/$platform.sh" ]]; then "$ATK_HOME/source/$platform.sh" "$\{args[@]}"
  elif [[ -f "$ATK_HOME/source/$platform.ps1" ]]; then atk_pwsh "source/$platform.ps1" "$\{args[@]}"
  else atk_log "no source adapter for $platform: stop the source by hand before the export (the runbook step)"; fi
}

image_ready() { [[ "$(gcloud compute images describe "$1" --project "$M2VM_TP" --format 'value(status)' 2> /dev/null)" == READY ]]; }

# Record the image for Terraform and build the instance from it.
image_apply() {
  local var="$1" image="$2" file="$M2VM_TF/image-imports.auto.tfvars.json" next
  if [[ ! -f "$file" ]]; then next='{}'; else next="$(< "$file")"; fi
  if [[ "$(jq -r --arg k "$var" '.[$k] // ""' <<< "$next")" != "$image" ]]; then
    next="$(jq --arg k "$var" --arg v "$image" '.[$k] = $v' <<< "$next")"
    if (( ATK_DRY_RUN )); then atk_log "dry-run, not written: $var in $file"; else printf '%s\n' "$next" > "$file"; fi
  fi
  atk_run terraform -chdir="$M2VM_TF" apply -auto-approve -input=false
}
`;

const IMAGE_VERBS = {
  prepare: code`
local e b
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server: the design has no Google Cloud (GCP) compute target for it; regenerate the kit"
m2vm_load
m2vm_enable_api vmmigration.googleapis.com
b="$(image_bucket)"
if ! gcloud storage buckets describe "gs://$b" --project "$M2VM_P" > /dev/null 2>&1; then
  atk_run gcloud storage buckets create "gs://$b" --project "$M2VM_P" --location "$M2VM_REGION" --uniform-bucket-level-access
fi
atk_done "$id" prepared "" bucket="$b"
`,
  replicate: code`
atk_done "$id" in-sync "offline path: nothing replicates; the disks are exported and imported at cutover, inside the outage" inSync=true offline=true
`,
  test: code`
atk_skip "$id" "offline path: there is no test launch before cutover; the instance is validated after it (gate G2 shows the outage)"
`,
  'test-cleanup': code`
atk_skip "$id" "offline path: no test copy to remove"
`,
  cutover: code`
local e name vm zone b disks=() f base n=0 imp img boot="" data=()
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
name="$\{ATK_NAME[$id]}"
vm="$(jq -r .vm <<< "$e")"
zone="$(jq -r .zone <<< "$e")"
if [[ -n "$(m2vm_instance_status "$vm" "$zone")" ]]; then
  mapfile -t data < <(m2vm_instance_data "$vm" "$zone")
  atk_skip "$id" "the instance is already built from its image" cut-over "$\{data[@]}"
fi
image_stop_source "$id"
mapfile -t disks < <(image_disks "$name")
if (( $\{#disks[@]} == 0 )); then
  atk_fail "$id" "no exported disk in $M2VM_EXPORT_DIR/$name: export the stopped source's disks there (README, Exporting the disks), boot disk first by name"
fi
b="$(image_bucket)"
for f in "$\{disks[@]}"; do
  base="$(basename "$f")"
  imp="$vm-$n"
  img="$vm-disk$n"
  if ! gcloud storage objects describe "gs://$b/$name/$base" > /dev/null 2>&1; then
    atk_run gcloud storage cp "$f" "gs://$b/$name/$base"
  fi
  if ! gcloud migration vms image-imports describe "$imp" --location "$M2VM_REGION" --project "$M2VM_P" > /dev/null 2>&1; then
    atk_run gcloud migration vms image-imports create "$imp" --source-file "gs://$b/$name/$base" --location "$M2VM_REGION" \
      --target-project "projects/$M2VM_P/locations/global/targetProjects/$M2VM_TP" --image-name "$img" --project "$M2VM_P"
  fi
  if ! (( ATK_DRY_RUN )); then
    atk_wait_until 240 60 image_ready "$img" || atk_fail "$id" "the image $img was not created"
  fi
  if (( n == 0 )); then boot="projects/$M2VM_TP/global/images/$img"; fi
  n=$(( n + 1 ))
done
image_apply "$(jq -r .imageVar <<< "$e")" "$boot"
if (( ATK_DRY_RUN )); then atk_done "$id" cut-over "dry run: the upload, the image import and the Terraform apply were printed"; fi
mapfile -t data < <(m2vm_instance_data "$vm" "$zone")
atk_done "$id" cut-over "" "$\{data[@]}" images="$n"
`,
  commit: code`
atk_skip "$id" "offline path: nothing to finalize; the source stays stopped until decommission"
`,
  rollback: code`
local e vm zone
e="$(m2vm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
m2vm_load
vm="$(jq -r .vm <<< "$e")"
zone="$(jq -r .zone <<< "$e")"
if [[ "$(m2vm_instance_status "$vm" "$zone")" == RUNNING ]]; then
  atk_run gcloud compute instances stop "$vm" --zone "$zone" --project "$M2VM_TP"
fi
atk_done "$id" "" "the instance is stopped and kept; the source was never changed: restart it through its adapter" replicationKept=false
`,
  finalize: code`
local b
m2vm_load
b="$(image_bucket)"
if gcloud storage ls "gs://$b/$\{ATK_NAME[$id]}/" > /dev/null 2>&1; then
  atk_run gcloud storage rm --recursive "gs://$b/$\{ATK_NAME[$id]}/"
fi
atk_done "$id" "" "the uploaded disks are removed; the images stay"
`,
  status: code`
atk_done "$id" "" "offline path: nothing replicates" inSync=true offline=true
`,
};

function readme(region: string, hasM2vm: boolean, hasImage: boolean): string {
  return `# Google Cloud (GCP): Migrate to Virtual Machines and image import

${hasM2vm ? `## \`gcp-m2vm\`: \`m2vm.sh\`

There is no gcloud command group for migrating VMs (the GA \`gcloud migration vms\` has image imports, machine-image imports and target projects only) and no Terraform resource, so \`m2vm.sh\` calls the VM Migration REST API, \`${M2VM_API}/projects/<project>/locations/${region}\`, with \`gcloud auth print-access-token\` (the token reaches curl as a header file, never as an argument). Reference: https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/reference/rest

1. **vSphere sources**: deploy the Migrate Connector OVA and register it (runbook step); \`prepare\` stops with exit 5 until the datacenter connector is ACTIVE. AWS and Azure sources need no connector.
2. \`prepare\`: enables vmmigration.googleapis.com, registers the target project, creates the source when missing (M2VM_VCENTER, M2VM_VCENTER_USER, M2VM_VCENTER_THUMBPRINT and VC_PASSWORD; or M2VM_AWS_ACCESS_KEY_ID / M2VM_AWS_SECRET_ACCESS_KEY; or M2VM_AZURE_TENANT_ID, M2VM_AZURE_CLIENT_ID, M2VM_AZURE_SUBSCRIPTION_ID and M2VM_AZURE_CLIENT_SECRET: from the environment or ATK_VAULT_CMD, sent in the request body only), and checks the VM is in its inventory.
3. \`replicate\`: creates the migrating VM with its target (\`targets/<item>.json\`), starts replication, adds it to the wave's group; \`ACTIVE\` is in sync.
4. \`test\`: points the target at the test network (\`targets/<item>.test.json\`, VM name \`<name>-test\`), runs a clone job, validates; \`test-cleanup\` deletes the clone and points the target back.
5. \`cutover\`: a cutover job (final sync, then the instance); the wave stops the source through its adapter either way.
6. \`commit\`: finalizes the migration. \`finalize\` (decommission) deletes the migrating VM.

**No automatic fallback.** Migrate to Virtual Machines does not copy writes on the Compute Engine instance back to the source (https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/discover/lifecycle). \`rollback\` stops the instance and, before commit, resumes replication; after that, writes since cutover are lost unless the app replays them.

**Bulk file.** \`m2vm-bulk-<n>.csv\` is the Migrate to VMs bulk import file (at most ${M2VM_BULK_MAX_ROWS} rows each; https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/import-export). The mandatory columns are Source name, Region and the source VM's id or display name; the target columns' spellings are unverified, and the network cells name landing-zone keys (\`@network prod\`), resolved into \`status/exports/gcp-m2vm/\` by \`prepare\`.
` : ''}
${hasImage ? `## \`gcp-image-import\`: \`image-import.sh\`

Offline, for sources Migrate to VMs does not take (Hyper-V, AHV, KVM, Proxmox, Xen, OCI): the whole copy is inside the outage.

1. \`prepare\` makes the bucket (M2VM_IMAGE_BUCKET, default \`<project>-atk-<plan>-images\`).
2. \`cutover\` stops the source through its adapter, uploads the exported disks from \`$M2VM_EXPORT_DIR/<name>/\` (default \`exports/<name>/\`, the boot disk first by name), imports each as an image (\`gcloud migration vms image-imports create\`, which adapts the OS: https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/image_import), writes the boot image into \`terraform/google/image-imports.auto.tfvars.json\` as \`image_<name>\` and applies the stack, whose compute row takes \`var:image_<name>\`.

### Exporting the disks

- Hyper-V: the source is stopped; copy the VHDX files (\`Get-VMHardDiskDrive -VMName <vm>\`), or \`Convert-VHD -Path <vhdx> -DestinationPath <vhd> -VHDType Fixed\`.
- KVM, Proxmox, oVirt: \`qemu-img convert -O vmdk <disk> <name>/0-boot.vmdk\` (QCOW2 and RAW are accepted as they are).
- Xen: export the VDI as VHD (\`xe vdi-export uuid=<vdi> filename=<name>/0-boot.vhd format=vhd\`).
- Nutanix AHV: export the vDisk as QCOW2 or VMDK from Prism.
` : ''}`;
}

function files(items: readonly ManifestItem[], ctx: PathContext): Record<string, string> {
  const out: Record<string, string> = {};
  const pd = ctx.design.platforms.find((p) => p.platform === 'google');
  const region = pd?.region ?? '';
  const plan8 = ctx.manifest.planId8;
  const vcSource = ctx.settings.m2vm?.source || `atk-${plan8}-vc`;
  const servers: Record<string, ServerEntry> = {};
  const bulk: string[][] = [];
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = placementOf(item, ctx);
    if (!p) continue;
    const file = item.resource;
    const vm = vmName(item.name);
    const src = item.source.platform;
    const sourceKind = item.path === 'gcp-image-import' ? 'image' : src === 'aws' ? 'aws' : src === 'azure' ? 'azure' : 'vmware';
    const source = sourceKind === 'vmware' ? vcSource : sourceKind === 'image' ? '' : `atk-${plan8}-${sourceKind}-${label(item.source.region ?? 'default')}`;
    servers[item.id] = {
      name: item.name, vm, source, sourceKind, ...(item.source.region ? { sourceRegion: item.source.region } : {}),
      ...(item.source.id ? { sourceVmId: item.source.id } : {}), zone: p.zone, wave: item.wave, file,
      imageVar: `image_${vm.replace(/-/g, '_')}`,
    };
    out[`${DIR}/targets/${file}.json`] = jsonText(targetDefaults(item, p, 'cutover', plan8));
    if (item.path === 'gcp-m2vm') {
      out[`${DIR}/targets/${file}.test.json`] = jsonText(targetDefaults(item, p, 'test', plan8));
      const t = targetDefaults(item, p, 'cutover', plan8);
      bulk.push([
        source, region, item.source.id ?? '', item.name, vm, '@target_project_id', p.zone, p.size, `@network ${p.network}`,
        `@subnet ${subnetKey(p.network, p.tier, p.zoneLetter)}`, p.tier,
        Object.entries(t.labels as Record<string, string>).map(([k, v]) => `${k}=${v}`).join(';'),
      ]);
    }
  }
  const hasM2vm = items.some((i) => i.path === 'gcp-m2vm');
  const hasImage = items.some((i) => i.path === 'gcp-image-import');
  const exportFn = code`
# The bulk files with the landing-zone keys resolved: status/exports/gcp-m2vm/.
m2vm_exports() {
  local out="$ATK_STATUS/exports/gcp-m2vm" f
  mkdir -p "$out"
  for f in "$M2VM_DIR"/m2vm-bulk-*.csv; do
    [[ -f "$f" ]] || continue
    jq -Rr --argjson lz "$(m2vm_lz)" --arg tp "$M2VM_TP" 'split(",") | map(
        if . == "@target_project_id" then $tp
        elif startswith("@subnet ") then ($lz.subnet_ids[.[8:]] // .)
        elif startswith("@network ") then ($lz.network_ids[.[9:]] // .)
        else . end) | join(",")' "$f" > "$out/$(basename "$f")"
  done
}
`;
  if (hasM2vm) {
    out[M2VM_SCRIPT] = shScript({
      file: M2VM_SCRIPT,
      paths: ['gcp-m2vm'],
      summary: 'Google Cloud (GCP) Migrate to Virtual Machines over the VM Migration REST API: source, replication, test clone, cutover, finalize.',
      needs: ['gcloud', 'curl', 'jq', 'terraform'],
      functions: COMMON(region, ctx.settings.lagSeconds.server) + API_FUNCTIONS + exportFn,
      verbs: { ...M2VM_VERBS, prepare: M2VM_VERBS.prepare.replace(/atk_done "\$id" prepared/, 'm2vm_exports\natk_done "$id" prepared') },
    });
    for (let i = 0; i < bulk.length; i += M2VM_BULK_MAX_ROWS) {
      out[`${DIR}/m2vm-bulk-${i / M2VM_BULK_MAX_ROWS + 1}.csv`] = csvText(M2VM_BULK_COLUMNS, bulk.slice(i, i + M2VM_BULK_MAX_ROWS));
    }
  }
  if (hasImage) {
    out[IMAGE_IMPORT_SCRIPT] = shScript({
      file: IMAGE_IMPORT_SCRIPT,
      paths: ['gcp-image-import'],
      summary: 'Google Cloud (GCP) image import (offline): stop the source, upload its exported disks, import them as images, build the instance with Terraform.',
      needs: ['gcloud', 'jq', 'terraform'],
      functions: COMMON(region, ctx.settings.lagSeconds.server) + IMAGE_FUNCTIONS,
      verbs: IMAGE_VERBS,
    });
  }
  out[`${DIR}/servers.json`] = jsonText(servers);
  out[`${DIR}/README.md`] = readme(region, hasM2vm, hasImage);
  return out;
}

function findings(items: readonly ManifestItem[], ctx: PathContext): Finding[] {
  const out: Finding[] = [];
  const missing = items.filter((i) => !placementOf(i, ctx));
  if (missing.length) {
    out.push(warning('exec.m2vm.no-design', `${missing.length} Google Cloud (GCP) item(s) have no compute target in the design: ${missing.map((i) => i.name).join(', ')}.`, { remediation: 'Design the Google Cloud (GCP) platform, then regenerate the kit.' }));
  }
  const offline = items.filter((i) => i.path === 'gcp-image-import');
  if (offline.length) {
    out.push(warning('exec.m2vm.image-import-outage', `${offline.length} server(s) move by image import, which is offline: the outage covers stopping the source, exporting and uploading its disks, and importing them (${offline.map((i) => i.name).join(', ')}).`, { remediation: 'Size the cutover window from the disk sizes and the upload bandwidth; gate G2 shows it.', source: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/image_import' }));
  }
  if (items.some((i) => i.path === 'gcp-m2vm' && i.source.platform === 'vsphere')) {
    out.push(info('exec.m2vm.connector', 'vSphere sources need the Migrate Connector OVA deployed and registered before prepare (a runbook step).', { source: 'https://docs.cloud.google.com/migrate/virtual-machines/docs/5.0/migrate/vmware/install-migrate-connector' }));
  }
  return out;
}

export const GCP_M2VM_GENERATOR: PathGenerator = Object.freeze({
  id: 'gcp-m2vm',
  owner: 'WP-11c' as const,
  paths: PATHS,
  needs: M2VM_NEEDS,
  entry: (path: ExecPath) => (path === 'gcp-image-import' ? IMAGE_IMPORT_SCRIPT : M2VM_SCRIPT),
  files,
  findings,
});

export const GENERATORS: readonly PathGenerator[] = Object.freeze([GCP_M2VM_GENERATOR]);

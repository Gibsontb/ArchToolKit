/**
 * The `oci-ocm` path (addendum A.6.8): Oracle Cloud Migrations (OCM) with
 * Oracle Cloud Bridge discovery, for vSphere and AWS EC2 sources.
 *
 * OCI has full Terraform coverage, so the migration objects (environment,
 * inventory, asset source, replication schedule, one migration per wave,
 * the migration assets, a test and a cutover plan per wave and their target
 * assets) come from the `oci_mig_replication` blueprint. The migration
 * assets need the discovered inventory OCIDs, which `ocm.sh prepare` writes
 * to `terraform/oci/ocm-assets.auto.tfvars.json` (OCIDs only) before it
 * applies the stack. The script then drives replication and the plans with
 * the OCI CLI.
 *
 * Files (relative to `migration/execute/`):
 *   paths/oci-ocm/ocm.sh               the verbs
 *   paths/oci-ocm/servers.json         per item: name, wave, source platform, Windows or not
 *   paths/oci-ocm/target-assets.csv    the target-asset mapping per item and plan (provider format)
 *   paths/oci-ocm/target-assets.json   the same, as the Terraform target_asset user_spec fields
 *   paths/oci-ocm/README.md            the Cloud Bridge agent notes, the order of operations
 *   ansible/ocm-agent.yml              the VirtIO drivers on Windows sources, before replication
 */

import { info, warning,              } from '../../../../core/findings.js';
                                               
import { code, shScript } from '../lib-sh.js';
                                                   
                                                                           
import { csvText, jsonText, placementOf, subnetKey, TF_OUTPUT_FN,                } from './cloud-shared.js';

const DIR = 'paths/oci-ocm';
export const OCM_SCRIPT = `${DIR}/ocm.sh`;
const PATHS                      = ['oci-ocm'];

export const OCM_NEEDS                      = Object.freeze([
  { kind: 'command', name: 'oci', why: 'Oracle Cloud Migrations, Cloud Bridge and Compute (oci cloud-migrations, oci cloud-bridge)', install: 'https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm' },
  { kind: 'command', name: 'terraform', min: '1.7', why: 'the OCI stack: migration assets and plans from the discovered inventory' },
  { kind: 'command', name: 'ansible-playbook', why: 'the VirtIO drivers on Windows sources' },
  { kind: 'ansible-collection', name: 'ansible.windows', why: 'the VirtIO drivers on Windows sources' },
]);

/** The target-asset export's columns: one row per item and plan (test, cutover). */
export const OCM_TARGET_ASSET_COLUMNS                    = Object.freeze([
  'Migration', 'Plan', 'Asset', 'Shape', 'OCPUs', 'Memory GB', 'Subnet', 'Availability domain index', 'Excluded', 'Microsoft licence',
]);

/** Shape name, OCPUs and memory from the design's size (`shape[:ocpus[:memory]]`, or a fixed shape). */
export function shapeOf(p           )                                                   {
  const [name = 'VM.Standard.E5.Flex', o, m] = p.size.split(':');
  const ocpus = p.ocpus ?? (Number(o) > 0 ? Number(o) : Math.max(1, Math.ceil(p.vcpu / 2)));
  const memory = Number(m) > 0 ? Number(m) : Math.max(p.ramGib, ocpus * 16);
  return { shape: name, ocpus, memory };
}

                       
                        
                               
                          
                            
 

const FUNCTIONS = (lagSeconds        )         => code`
OCM_DIR="$ATK_HOME/paths/oci-ocm"
OCM_TF="$\{ATK_TF_OCI_DIR:-$ATK_ROOT/terraform/oci}"
OCM_INVENTORY="$\{ATK_INVENTORY:-$ATK_ROOT/ansible/inventory}"
OCM_LAG_MAX=${lagSeconds}
OCM_OUT=""
OCM_C=""
${TF_OUTPUT_FN}
# The stack's ocm output: compartment, environment, asset source, migrations, plans, assets, target assets.
ocm_load() {
  if [[ -n "$OCM_OUT" && "$\{1:-}" != reload ]]; then return 0; fi
  OCM_OUT="$(atk_tf_output "$OCM_TF" ocm)"
  OCM_C="$(jq -r .compartment_id <<< "$OCM_OUT")"
}
ocm_entry() { jq -c --arg id "$1" '.[$id] // empty' "$OCM_DIR/servers.json"; }
ocm_get() { jq -r --arg k "$2" ".$1[\$k] // empty" <<< "$OCM_OUT"; }

# Stop the source through its adapter, when the kit has one for its platform.
ocm_stop_source() {
  local id="$1" platform="$\{ATK_SOURCE[$1]:-}" args=(stop --item "$1")
  if (( ATK_DRY_RUN )); then args+=(--dry-run); fi
  if [[ -x "$ATK_HOME/source/$platform.sh" ]]; then "$ATK_HOME/source/$platform.sh" "$\{args[@]}"
  elif [[ -f "$ATK_HOME/source/$platform.ps1" ]]; then atk_pwsh "source/$platform.ps1" "$\{args[@]}"
  else atk_log "no source adapter for $platform: stop the source by hand (the runbook step)"; fi
}

# Discovered inventory assets of every selected item, by display name, into ocm-assets.auto.tfvars.json; applies the stack when the map changed.
ocm_map_assets() {
  local all have want file="$OCM_TF/ocm-assets.auto.tfvars.json" id names=()
  all="$(oci cloud-bridge inventory asset list --compartment-id "$OCM_C" --all --output json)"
  for id in "$\{ATK_ITEMS[@]}"; do names+=("$\{ATK_NAME[$id]}"); done
  if [[ -f "$file" ]]; then have="$(jq -c '.ocm_inventory_asset_ids // {}' "$file")"; else have='{}'; fi
  want="$(jq -c --argjson have "$have" --args '[.data.items[]? | select(."lifecycle-state" == "ACTIVE")] as $a
      | reduce $ARGS.positional[] as $n ($have; . + ([$a[] | select((."display-name" // "" | ascii_downcase) == ($n | ascii_downcase))] | if length > 0 then {($n): .[0].id} else {} end))' "$\{names[@]}" <<< "$all")"
  if [[ "$want" == "$have" ]]; then atk_log "the inventory asset map is up to date"; return 0; fi
  if (( ATK_DRY_RUN )); then
    atk_log "dry-run, not written: ocm_inventory_asset_ids in $file"
  else
    jq -n --argjson m "$want" '{ocm_inventory_asset_ids: $m}' > "$file"
  fi
  atk_run terraform -chdir="$OCM_TF" apply -auto-approve -input=false
  ocm_load reload
}

# Replication progress of a migration asset as event data; 0 when complete.
OCM_REPORT=()
ocm_progress() {
  local p pct st
  p="$(oci cloud-migrations migration-asset get-replication-progress --migration-asset-id "$1" --output json 2> /dev/null || printf '{}')"
  pct="$(jq -r '.data.percentage // 0' <<< "$p")"
  st="$(jq -r '.data.status // "NONE"' <<< "$p")"
  OCM_REPORT=("progressPct=$pct" "replicationState=$st")
  [[ "$st" == SUCCEEDED ]] || { [[ "$pct" == 100 ]] && [[ "$st" != IN_PROGRESS ]]; }
}
ocm_replicating() {
  local st
  st="$(oci cloud-migrations migration-asset get-replication-progress --migration-asset-id "$1" --query 'data.status' --raw-output 2> /dev/null || true)"
  [[ "$st" == IN_PROGRESS || "$st" == STARTED ]]
}

# Start the wave's migration replication, once a run.
ocm_start_replication() {
  local wave="$1" mid
  mid="$(ocm_get migrations "$wave")"
  [[ -n "$mid" ]] || atk_die 5 "no migration for wave $wave in the stack: apply it with the wave's items"
  if atk_ids_get oci-ocm "start:$wave:$ATK_RUN_ID" > /dev/null 2>&1; then return 0; fi
  atk_run oci cloud-migrations migration start-migration-replication --migration-id "$mid"
  atk_ids_put oci-ocm "start:$wave:$ATK_RUN_ID" 1
}

# Execute a wave's plan (test or cutover), once a run, and wait for its work request.
ocm_execute_plan() {
  local wave="$1" phase="$2" pid
  pid="$(ocm_get plans "$wave/$phase")"
  [[ -n "$pid" ]] || atk_die 5 "no $phase plan for wave $wave in the stack"
  if atk_ids_get oci-ocm "plan:$wave:$phase:$ATK_RUN_ID" > /dev/null 2>&1; then return 0; fi
  atk_run oci cloud-migrations migration-plan execute --migration-plan-id "$pid" --wait-for-state SUCCEEDED --max-wait-seconds 14400
  atk_ids_put oci-ocm "plan:$wave:$phase:$ATK_RUN_ID" 1
}

# The instance a target asset launched, and its addresses as event data.
ocm_instance() {
  local ta
  ta="$(ocm_get target_assets "$1")"
  [[ -n "$ta" ]] || return 0
  oci cloud-migrations target-asset get --target-asset-id "$ta" --query 'data."created-resource-id"' --raw-output 2> /dev/null || true
}
ocm_instance_state() { [[ -n "$1" && "$1" != null ]] || return 0; oci compute instance get --instance-id "$1" --query 'data."lifecycle-state"' --raw-output 2> /dev/null || true; }
ocm_instance_data() {
  local iid="$1" vnics
  [[ -n "$iid" && "$iid" != null ]] || return 0
  vnics="$(oci compute instance list-vnics --instance-id "$iid" --output json 2> /dev/null || printf '{}')"
  printf 'instanceId=%s\n' "$iid"
  printf 'targetIpv4=%s\n' "$(jq -r '.data[0]."private-ip" // empty' <<< "$vnics")"
  printf 'targetIpv6=%s\n' "$(jq -r '.data[0]."ipv6-addresses"[0] // empty' <<< "$vnics")"
}

ocm_validate() {
  local id="$1" ip="$2"
  if [[ ! -f "$ATK_HOME/ansible/validate.yml" ]]; then atk_log "ansible/validate.yml is not in this kit: the test is not validated"; printf failed; return 0; fi
  if atk_run ansible-playbook -i "$OCM_INVENTORY" "$ATK_HOME/ansible/validate.yml" --limit "$\{ATK_NAME[$id]}" \
      -e validate_phase=test -e "validate_item=$id" -e "validate_address=$ip" >&2; then printf passed; else printf failed; fi
}
`;

const V = {
  prepare: code`
local e name as
e="$(ocm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server: the design has no OCI compute target for it; regenerate the kit"
name="$\{ATK_NAME[$id]}"
ocm_load
if [[ "$(jq -r .source <<< "$e")" == vsphere ]]; then
  oci cloud-bridge ocb-agent-svc agent list --compartment-id "$OCM_C" --all --output json \
    | jq -e '[.data.items[]? | select(."lifecycle-state" == "ACTIVE")] | length > 0' > /dev/null \
    || atk_die 5 "no ACTIVE Oracle Cloud Bridge agent: deploy the discovery and replication appliance (README, step 1)"
fi
if [[ "$(jq -r .windows <<< "$e")" == true ]]; then
  [[ -n "$\{OCM_VIRTIO_WIN_URL:-}" ]] || atk_die 3 "OCM_VIRTIO_WIN_URL is not set: the VirtIO drivers MSI Windows sources need before replication to OCI"
  atk_run ansible-playbook -i "$OCM_INVENTORY" "$ATK_HOME/ansible/ocm-agent.yml" --limit "$name"
fi
as="$(jq -r '.asset_source_id // empty' <<< "$OCM_OUT")"
if [[ -n "$as" ]] && ! atk_ids_get oci-ocm "refresh:$ATK_RUN_ID" > /dev/null 2>&1; then
  atk_run oci cloud-bridge discovery asset-source refresh --asset-source-id "$as"
  atk_ids_put oci-ocm "refresh:$ATK_RUN_ID" 1
fi
ocm_map_assets
if [[ -z "$(ocm_get assets "$name")" ]]; then
  if (( ATK_DRY_RUN )); then atk_done "$id" prepared "dry run: the inventory map and the Terraform apply were printed"; fi
  atk_fail "$id" "not in the Cloud Bridge inventory (or not yet a migration asset): check the asset source discovered it under this name"
fi
atk_done "$id" prepared "" migrationAssetId="$(ocm_get assets "$name")"
`,
  replicate: code`
local e name ma
e="$(ocm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
name="$\{ATK_NAME[$id]}"
ocm_load
ma="$(ocm_get assets "$name")"
[[ -n "$ma" ]] || atk_fail "$id" "no migration asset: run prepare"
if ! ocm_progress "$ma" && ! ocm_replicating "$ma"; then ocm_start_replication "$(jq -r .wave <<< "$e")"; fi
atk_wait_until 1440 60 ocm_progress "$ma" || true
if ocm_progress "$ma"; then atk_done "$id" in-sync "" inSync=true "$\{OCM_REPORT[@]}"; fi
atk_done "$id" replicating "" "$\{OCM_REPORT[@]}"
`,
  test: code`
local e name ma iid data=() ip passed
e="$(ocm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
name="$\{ATK_NAME[$id]}"
ocm_load
iid="$(ocm_instance "$name/test")"
if [[ "$(ocm_instance_state "$iid")" == RUNNING ]]; then
  mapfile -t data < <(ocm_instance_data "$iid")
  atk_skip "$id" "the test instance is already running" testing "$\{data[@]}"
fi
ma="$(ocm_get assets "$name")"
[[ -n "$ma" ]] || atk_fail "$id" "no migration asset: run prepare"
ocm_progress "$ma" || atk_fail "$id" "replication has not completed a cycle" "$\{OCM_REPORT[@]}"
ocm_execute_plan "$(jq -r .wave <<< "$e")" test
if (( ATK_DRY_RUN )); then atk_done "$id" testing "dry run: the test plan's execution was printed"; fi
iid="$(ocm_instance "$name/test")"
mapfile -t data < <(ocm_instance_data "$iid")
ip="$(printf '%s\n' "$\{data[@]}" | sed -n 's/^targetIpv4=//p')"
passed="$(ocm_validate "$id" "$ip")"
atk_ids_put oci-ocm "test:$id" "$passed"
atk_done "$id" testing "" "$\{data[@]}" validated="$passed"
`,
  'test-cleanup': code`
local name iid passed
name="$\{ATK_NAME[$id]}"
ocm_load
passed="$(atk_ids_get oci-ocm "test:$id" 2> /dev/null || true)"
iid="$(ocm_instance "$name/test")"
case "$(ocm_instance_state "$iid")" in
  ""|TERMINATED|TERMINATING) ;;
  *) atk_run oci compute instance terminate --instance-id "$iid" --preserve-boot-volume false --force ;;
esac
if [[ "$passed" == passed ]]; then atk_done "$id" "" "" passed=true; fi
atk_done "$id" "" "the test instance is removed; the test did not pass" passed=false
`,
  cutover: code`
local e name ma iid data=()
e="$(ocm_entry "$id")"
[[ -n "$e" ]] || atk_fail "$id" "no target for this server; regenerate the kit"
name="$\{ATK_NAME[$id]}"
ocm_load
iid="$(ocm_instance "$name/cutover")"
if [[ "$(ocm_instance_state "$iid")" == RUNNING ]]; then
  mapfile -t data < <(ocm_instance_data "$iid")
  atk_skip "$id" "the cutover instance is already running" cut-over "$\{data[@]}"
fi
ma="$(ocm_get assets "$name")"
[[ -n "$ma" ]] || atk_fail "$id" "no migration asset: run prepare"
ocm_stop_source "$id"
ocm_start_replication "$(jq -r .wave <<< "$e")"
if ! (( ATK_DRY_RUN )); then
  atk_wait_until 1 30 ocm_replicating "$ma" || true
  atk_wait_until 240 60 ocm_progress "$ma" || atk_fail "$id" "the final replication did not complete" "$\{OCM_REPORT[@]}"
fi
ocm_execute_plan "$(jq -r .wave <<< "$e")" cutover
if (( ATK_DRY_RUN )); then atk_done "$id" cut-over "dry run: the final replication and the cutover plan were printed"; fi
iid="$(ocm_instance "$name/cutover")"
mapfile -t data < <(ocm_instance_data "$iid")
atk_ids_put oci-ocm "instance:$name" "$iid"
atk_done "$id" cut-over "" "$\{data[@]}"
`,
  commit: code`
atk_skip "$id" "Oracle Cloud Migrations has nothing to finalize at commit; the migration asset is removed at finalize"
`,
  rollback: code`
local name iid
name="$\{ATK_NAME[$id]}"
ocm_load
iid="$(ocm_instance "$name/cutover")"
if [[ "$(ocm_instance_state "$iid")" == RUNNING ]]; then
  atk_run oci compute instance action --action SOFTSTOP --instance-id "$iid"
fi
atk_done "$id" "" "the OCI instance is stopped and kept for analysis; the source was only stopped: restart it through its adapter" replicationKept=true instanceId="$iid"
`,
  finalize: code`
local name file="$OCM_TF/ocm-assets.auto.tfvars.json" next
name="$\{ATK_NAME[$id]}"
[[ -f "$file" ]] || atk_skip "$id" "no inventory asset map: nothing to remove"
if [[ "$(jq -r --arg n "$name" '.ocm_inventory_asset_ids[$n] // empty' "$file")" == "" ]]; then atk_skip "$id" "already removed from the migration"; fi
next="$(jq --arg n "$name" 'del(.ocm_inventory_asset_ids[$n])' "$file")"
if (( ATK_DRY_RUN )); then atk_log "dry-run, not written: $name removed from $file"; else printf '%s\n' "$next" > "$file"; fi
atk_run terraform -chdir="$OCM_TF" apply -auto-approve -input=false
atk_done "$id" "" "the migration asset and its target assets are removed"
`,
  status: code`
local name ma
name="$\{ATK_NAME[$id]}"
ocm_load
ma="$(ocm_get assets "$name")"
[[ -n "$ma" ]] || atk_skip "$id" "no migration asset yet"
if ocm_progress "$ma"; then atk_done "$id" in-sync "" inSync=true "$\{OCM_REPORT[@]}"; fi
atk_done "$id" "" "" inSync=false "$\{OCM_REPORT[@]}"
`,
};

/** `ansible/ocm-agent.yml`: the VirtIO drivers on Windows sources before replication to OCI (A.3.5). */
export const OCM_AGENT_PLAYBOOK = `---
# Installs the VirtIO drivers on Windows sources before Oracle Cloud Migrations replicates them,
# so the migrated instance boots on OCI's paravirtualized devices. Run by paths/oci-ocm/ocm.sh prepare.
# OCM_VIRTIO_WIN_URL names the virtio-win MSI (for example the Fedora virtio-win build the
# organisation has approved); OCM_VIRTIO_WIN_SHA256, when set, is checked.
- name: Install the VirtIO drivers on Windows sources
  hosts: all
  gather_facts: true
  vars:
    ocm_virtio_win_url: "{{ lookup('ansible.builtin.env', 'OCM_VIRTIO_WIN_URL') }}"
    ocm_virtio_win_sha256: "{{ lookup('ansible.builtin.env', 'OCM_VIRTIO_WIN_SHA256') }}"
  tasks:
    - name: Check the play's inputs
      ansible.builtin.assert:
        that:
          - ocm_virtio_win_url | length > 0
        fail_msg: Set OCM_VIRTIO_WIN_URL to the virtio-win MSI.
        quiet: true

    - name: Windows sources
      when: ansible_facts['os_family'] == 'Windows'
      block:
        - name: Make a private working directory
          ansible.windows.win_tempfile:
            state: directory
            suffix: virtio
          register: virtio_tmp

        - name: Download the VirtIO drivers
          ansible.windows.win_get_url:
            url: "{{ ocm_virtio_win_url }}"
            dest: "{{ virtio_tmp.path }}\\\\virtio-win.msi"
            checksum: "{{ ocm_virtio_win_sha256 | default(omit, true) }}"
            checksum_algorithm: sha256

        - name: Install the VirtIO drivers
          ansible.windows.win_package:
            path: "{{ virtio_tmp.path }}\\\\virtio-win.msi"
            state: present
            creates_path: C:\\\\Program Files\\\\Virtio-Win

      always:
        - name: Remove the working directory
          ansible.windows.win_file:
            path: "{{ virtio_tmp.path }}"
            state: absent
          when: virtio_tmp.path is defined
`;

function readme(ctx             )         {
  const s = ctx.settings.ocm;
  return `# Oracle Cloud Migrations (\`oci-ocm\`)

Oracle Cloud Migrations (OCM) moves vSphere and AWS EC2 servers to OCI Compute, with Oracle Cloud Bridge discovering them. Every OCM object is Terraform, in the \`oci_mig_replication\` item of the OCI stack; \`ocm.sh\` drives replication and the plans with the OCI CLI (https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/cloud-migrations.html).
${s ? `\nCloud Bridge environment \`${s.environment}\`, snapshot bucket \`${s.bucket}\`, replication schedule \`${s.schedule}\`.\n` : ''}
## The Cloud Bridge agent (notes)

1. **vSphere sources:** deploy the Oracle Cloud Bridge discovery and replication appliance (an OVA) in vCenter, and register its agent with the environment the stack creates (the agent's key comes from the Cloud Bridge console). \`prepare\` stops with exit 5 until an agent is ACTIVE. The vCenter credentials the asset source uses are OCI Vault secrets, given to the stack as secret OCIDs, never values.
2. **AWS sources** need no appliance: the asset source reads the AWS account (agentless).
3. **Windows sources:** \`prepare\` installs the VirtIO drivers first (\`ansible/ocm-agent.yml\`, from OCM_VIRTIO_WIN_URL), so the instance boots on OCI.
4. The replication snapshots go to the snapshot bucket; replication after the first cycle follows the schedule.

## Order of operations

1. Apply the OCI stack once: environment, inventory, asset source, schedules, one migration per wave and a test and a cutover plan per wave.
2. \`ocm.sh prepare --wave N\`: checks the agent, refreshes discovery, maps the servers to their inventory asset OCIDs in \`terraform/oci/ocm-assets.auto.tfvars.json\` (OCIDs only) and applies the stack, which creates the migration assets and target assets.
3. \`replicate\`: starts the wave's replication and reports each asset's progress.
4. \`test\`: executes the wave's test plan (the test subnet), validates; \`test-cleanup\` terminates the test instances.
5. \`cutover\`: stops the source through its adapter, runs a final replication, executes the cutover plan.
6. \`finalize\` (decommission): removes the server from the asset map and applies the stack.

\`rollback\` soft-stops the OCI instance (kept for analysis); the source was only stopped. OCI has no reverse replication.

## Provider-format export

\`target-assets.csv\` (and \`target-assets.json\`) is the migration plans' target-asset mapping: per server and plan, the shape, OCPUs, memory, subnet (a landing-zone key) and availability domain. OCI's own migration-plan CSV columns are not published; this follows the \`oci_cloud_migrations_target_asset\` fields.

## Environment

The OCI CLI's own authentication (\`OCI_CLI_AUTH=instance_principal\`, or the config file), ATK_TF_OCI_DIR (default terraform/oci), ATK_INVENTORY, OCM_VIRTIO_WIN_URL and OCM_VIRTIO_WIN_SHA256.
`;
}

function files(items                         , ctx             )                         {
  const servers                              = {};
  const rows                                  = [];
  const specs                            = [];
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = placementOf(item, ctx);
    if (!p) continue;
    servers[item.id] = { name: item.name, wave: item.wave, source: item.source.platform, windows: p.windows };
    const sh = shapeOf(p);
    for (const phase of ['test', 'cutover']         ) {
      const network = phase === 'test' ? p.testNetwork : p.network;
      const subnet = subnetKey(network, p.tier, p.zoneLetter);
      const ms = p.windows ? (p.licence === 'li' ? 'LICENSE_INCLUDED' : 'BRING_YOUR_OWN_LICENSE') : '';
      rows.push([item.wave === null ? '' : `atk-${ctx.manifest.planId8}-w${item.wave}`, phase, item.name, sh.shape, sh.ocpus, sh.memory, subnet, p.zoneIndex, false, ms]);
      specs.push({
        asset: item.name, wave: item.wave, plan: phase, type: 'INSTANCE', is_excluded_from_execution: false,
        user_spec: { display_name: phase === 'test' ? `${item.name}-test` : item.name, shape: sh.shape, shape_config: { ocpus: sh.ocpus, memory_in_gbs: sh.memory }, create_vnic_details: { subnet: subnet, assign_public_ip: false }, availability_domain_index: p.zoneIndex },
        ...(ms ? { ms_license: ms } : {}),
      });
    }
  }
  const out                         = {
    [OCM_SCRIPT]: shScript({
      file: OCM_SCRIPT,
      paths: PATHS,
      summary: 'Oracle Cloud Migrations: discovery map, replication, test and cutover plans, with the OCM objects in Terraform.',
      needs: ['oci', 'jq', 'terraform'],
      functions: FUNCTIONS(ctx.settings.lagSeconds.server),
      verbs: V,
    }),
    [`${DIR}/servers.json`]: jsonText(servers),
    [`${DIR}/target-assets.csv`]: csvText(OCM_TARGET_ASSET_COLUMNS, rows),
    [`${DIR}/target-assets.json`]: jsonText(specs),
    [`${DIR}/README.md`]: readme(ctx),
  };
  if (Object.values(servers).some((s) => s.windows)) out['ansible/ocm-agent.yml'] = OCM_AGENT_PLAYBOOK;
  return out;
}

function findings(items                         , ctx             )            {
  const out            = [];
  const missing = items.filter((i) => !placementOf(i, ctx));
  if (missing.length) {
    out.push(warning('exec.ocm.no-design', `${missing.length} Oracle Cloud Migrations item(s) have no OCI compute target in the design: ${missing.map((i) => i.name).join(', ')}.`, { remediation: 'Design the OCI platform, then regenerate the kit.' }));
  }
  const other = items.filter((i) => i.source.platform !== 'vsphere' && i.source.platform !== 'aws');
  if (other.length) {
    out.push(warning('exec.oci.source-unsupported', `Oracle Cloud Migrations takes vSphere and AWS EC2 sources only; ${other.map((i) => i.name).join(', ')} are on another platform.`, { remediation: 'Rebuild them on OCI instead.', source: 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/cloud-migration-overview.htm' }));
  }
  out.push(info('exec.ocm.unverified', 'The OCM CLI verbs (start-migration-replication, get-replication-progress, migration-plan execute) and two plans per migration follow the API reference but are not confirmed on a live tenancy; check them with --help on the first wave.', { source: 'https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/cloud-migrations.html' }));
  return out;
}

export const OCI_OCM_GENERATOR                = Object.freeze({
  id: 'oci-ocm',
  owner: 'WP-11c'         ,
  paths: PATHS,
  needs: OCM_NEEDS,
  entry: () => OCM_SCRIPT,
  files,
  findings,
});

export const GENERATORS                           = Object.freeze([OCI_OCM_GENERATOR]);

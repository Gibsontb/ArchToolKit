/**
 * `waves/wave-<n>/decommission.sh` (addendum A.7.6): after the keep-days.
 * It checks G4 first, then the target backup of every item, before any
 * delete; an item whose backup cannot be confirmed is not touched.
 *
 *   1. target backup: AWS `aws backup list-recovery-points-by-resource`
 *      (a COMPLETED point); Azure `az backup item list` (last backup
 *      Completed; the vault from AZURE_BACKUP_VAULT / AZURE_BACKUP_RG);
 *      OCI `oci bv boot-volume-backup list` (AVAILABLE); Google Cloud (GCP)
 *      and VCF by attestation (`status/backups/<item>.json`, or the G4 gate
 *      file's `g4.target-backup` criterion met);
 *   2. path `finalize` (MGN disconnect and archive, replication removed …);
 *   3. `source/<origin>.* delete` (physical: marked for disposal);
 *   4. the pre-cutover restore points go with the source VM;
 *   5. AD: the computer objects of renamed servers (identity.yml);
 *   6. DNS: temporary names are listed for removal by hand;
 *   7. CMDB and licence-reclaim events (`decommission` → decommissioned);
 *   8. the source backup product: a checklist line per item.
 *
 * `--check-backups` runs step 1 only, without the gate, so the tracker's G4
 * criterion (`data.check = target-backup`) can be met before G4 is decided.
 */

import { EXIT_CODES } from '../contract.js';
import {                waveDataSh, waveFile, waveScript } from './common.js';

export function renderDecommission(w          )         {
  const file = waveFile(w.n, 'decommission.sh');
  const functions = `${waveDataSh(w)}
BK_WHY=""
backup_attested() {
  local g
  if [[ -f "$ATK_STATUS/backups/$(wave_file "$1").json" ]]; then BK_WHY="attested in status/backups"; return 0; fi
  for g in "$ATK_STATUS/gates/wave-$WAVE_N-decommission.json" "$ATK_STATUS/gates/wave-$WAVE_N-G4.json"; do
    if [[ -f "$g" ]] && jq -e --arg p "$ATK_PLAN_ID" '.planId == $p and ([.criteria[]? | select(.id == "g4.target-backup") | .met] | any)' "$g" > /dev/null 2>&1; then
      BK_WHY="attested in the G4 gate file"
      return 0
    fi
  done
  return 1
}
backup_aws() {
  local tid region arn account n
  tid="$(wave_data "$1" cutover targetId)"
  [[ -n "$tid" ]] || { BK_WHY="the cutover reported no targetId"; return 1; }
  atk_need aws
  region="$(wave_region "$1")"
  if [[ "$tid" == arn:* ]]; then
    arn="$tid"
  else
    account="$(aws sts get-caller-identity --query Account --output text)" || { BK_WHY="aws sts get-caller-identity failed"; return 1; }
    arn="arn:\${AWS_PARTITION:-aws}:ec2:\${region:-\${AWS_REGION:-}}:$account:instance/$tid"
  fi
  n="$(aws backup list-recovery-points-by-resource --resource-arn "$arn" \${region:+--region "$region"} --query "length(RecoveryPoints[?Status=='COMPLETED'])" --output text)" || { BK_WHY="aws backup list-recovery-points-by-resource failed"; return 1; }
  if [[ ! "$n" =~ ^[0-9]+$ ]] || (( n == 0 )); then BK_WHY="no COMPLETED recovery point for $arn"; return 1; fi
  BK_WHY="$n completed recovery point(s)"
}
backup_azure() {
  local vm st
  vm="$(wave_data "$1" cutover vmId)"
  vm="\${vm:-$(wave_data "$1" cutover targetId)}"
  [[ -n "$vm" ]] || { BK_WHY="the cutover reported no VM id"; return 1; }
  [[ -n "\${AZURE_BACKUP_VAULT:-}" && -n "\${AZURE_BACKUP_RG:-}" ]] || { BK_WHY="set AZURE_BACKUP_VAULT and AZURE_BACKUP_RG (the Recovery Services vault)"; return 1; }
  atk_need az
  st="$(az backup item list --vault-name "$AZURE_BACKUP_VAULT" -g "$AZURE_BACKUP_RG" --backup-management-type AzureIaasVM --workload-type VM -o json \\
    | jq -r --arg vm "\${vm,,}" '[.[] | select((.properties.virtualMachineId // "" | ascii_downcase) == $vm) | .properties.lastBackupStatus][0] // empty')" || { BK_WHY="az backup item list failed"; return 1; }
  if [[ "$st" != Completed ]]; then BK_WHY="last backup status \${st:-none}"; return 1; fi
  BK_WHY="last backup Completed"
}
backup_oci() {
  local tid inst comp ad bv n
  tid="$(wave_data "$1" cutover targetId)"
  [[ -n "$tid" ]] || { BK_WHY="the cutover reported no targetId"; return 1; }
  atk_need oci
  inst="$(oci compute instance get --instance-id "$tid")" || { BK_WHY="oci compute instance get failed"; return 1; }
  comp="\${OCI_COMPARTMENT_ID:-$(jq -r '.data."compartment-id"' <<< "$inst")}"
  ad="$(jq -r '.data."availability-domain"' <<< "$inst")"
  bv="$(wave_data "$1" cutover bootVolumeId)"
  if [[ -z "$bv" ]]; then
    bv="$(oci compute boot-volume-attachment list --availability-domain "$ad" --compartment-id "$comp" --instance-id "$tid" --query 'data[0]."boot-volume-id"' --raw-output)" || { BK_WHY="no boot volume found"; return 1; }
  fi
  n="$(oci bv boot-volume-backup list --compartment-id "$comp" --boot-volume-id "$bv" --lifecycle-state AVAILABLE --query 'length(data)' --raw-output 2> /dev/null || printf 0)"
  if [[ ! "$n" =~ ^[0-9]+$ ]] || (( n == 0 )); then BK_WHY="no AVAILABLE boot-volume backup"; return 1; fi
  BK_WHY="$n available boot-volume backup(s)"
}
backup_item() {
  local id="$1" p rc=0
  BK_WHY=""
  if [[ "\${ATK_ITEM_PATH[$id]}" == retire ]]; then atk_event "$id" precheck skipped "" "retired: no target" check=target-backup; return 0; fi
  p="$(wave_platform "$id")"
  if [[ "\${ATK_KIND[$id]}" == database ]]; then p=attest; fi
  case "$p" in
    aws) backup_aws "$id" || rc=$? ;;
    azure) backup_azure "$id" || rc=$? ;;
    oci) backup_oci "$id" || rc=$? ;;
    *) rc=1; BK_WHY="confirm the target backup by attestation (status/backups/<item>.json or the G4 gate); Google Cloud (GCP) Backup and DR and VCF site backups are not read by the kit" ;;
  esac
  if (( rc != 0 )); then
    local live="$BK_WHY"
    if backup_attested "$id"; then rc=0; BK_WHY="$BK_WHY (live check: $live)"; else BK_WHY="$live"; fi
  fi
  if (( rc == 0 )); then
    atk_event "$id" precheck succeeded "" "target backup: $BK_WHY" check=target-backup targetBackup=true
    return 0
  fi
  atk_event "$id" precheck failed "" "target backup not confirmed: $BK_WHY" check=target-backup targetBackup=false
  return 1
}
step_backups() { wave_each backup_item; }
finalize_item() { wave_path finalize "$1"; }
step_finalize() { wave_each finalize_item; }
source_item() {
  local id="$1"
  if [[ "\${ATK_KIND[$id]}" == database ]]; then atk_event "$id" decommission skipped "" "a database: removed with its source server" ; return 0; fi
  wave_source delete "$id" decommission
}
step_sources() { wave_each source_item; }
step_ad() {
  local id names=""
  wave_live
  for id in "\${WAVE_LIVE[@]}"; do
    if [[ -n "\${WAVE_RENAMED[$id]:-}" ]]; then names+="\${names:+,}\\"\${WAVE_RENAMED[$id]}\\""; fi
  done
  if [[ -z "$names" ]]; then atk_log "no renamed servers: their computer objects stay (same name)"; return 0; fi
  local rc=0
  wave_playbook identity.yml role_ad_dc -e identity_stage=decommission -e "{\\"identity_remove_computers\\": [$names]}" || rc=$?
  if (( rc != 0 )); then atk_log "identity.yml exited $rc: remove the old computer objects by hand"; fi
}
record_item() {
  local id="$1"
  atk_event "$id" decommission succeeded decommissioned "decommissioned: CMDB and licence reclaim to record" cmdb=update licenceReclaim=true
}
step_record() { wave_each record_item; }
`;
  const body = `
atk_need jq
if (( \${#WAVE_ITEMS[@]} == 0 )); then atk_event - decommission skipped "" "no items in wave $WAVE_N"; exit 0; fi
if (( WAVE_CHECK_BACKUPS )); then
  WAVE_CONTINUE=1
  wave_step 1 precheck "target backups (check only)" step_backups
  if (( \${#WAVE_FAILED[@]} )); then exit ${EXIT_CODES.partial}; fi
  exit 0
fi

# G4 before anything, then the backups before any delete.
atk_gate G4
WAVE_CONTINUE=1
wave_step 1 precheck "target backups" step_backups
if (( \${#WAVE_FAILED[@]} )); then
  for id in "\${!WAVE_FAILED[@]}"; do atk_log "not decommissioned (no confirmed target backup): \${ATK_NAME[$id]}"; done
fi
wave_live
if (( \${#WAVE_LIVE[@]} == 0 )); then
  atk_event - decommission failed "" "no item has a confirmed target backup: nothing was deleted" failed="\${#WAVE_FAILED[@]}"
  exit ${EXIT_CODES.partial}
fi
wave_step 2 finalize "finalize the paths (replication and tool leftovers removed)" step_finalize
wave_step 3 decommission "remove the sources" step_sources
atk_event - decommission skipped "" "step 4: the pre-cutover restore points were removed with the source VMs" stepNo=4
wave_step 5 identity "AD: computer objects of renamed servers" step_ad
atk_event - decommission skipped "" "step 6: remove any temporary *-old / *-new DNS names by hand (not in dns/records.csv)" stepNo=6
wave_step 7 decommission "CMDB update and licence reclaim" step_record
wave_live
for id in "\${WAVE_LIVE[@]}"; do atk_log "checklist: remove \${ATK_NAME[$id]} from the source backup product's jobs"; done
atk_event - manual skipped "" "step 8: remove the decommissioned sources from the source backup product's jobs (by hand)" stepNo=8
if (( \${#WAVE_FAILED[@]} )); then exit ${EXIT_CODES.partial}; fi
`;
  return waveScript({
    file, wave: w.n, channel: 'orchestrator',
    summary: `Wave ${w.n} decommission (A.7.6): G4, then the target backups, before any delete.`,
    about: ['--check-backups: only the target-backup check (no gate, nothing deleted), for the tracker\'s G4 criterion.'],
    options: [{ flag: '--check-backups', variable: 'WAVE_CHECK_BACKUPS', help: 'only check the target backups' }],
    functions,
    body,
  });
}

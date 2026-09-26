/**
 * The `aws-mgn` path (addendum A.6.5): AWS Transform MGN (formerly AWS
 * Application Migration Service; the API and the `aws mgn` CLI are
 * unchanged). There is no `aws_mgn_*` Terraform resource, so the service is
 * driven by the AWS CLI; its supporting pieces (the agent-install role, the
 * replication security group) come from the `aws_mig_replication` blueprint.
 *
 * Files (relative to `migration/execute/`):
 *   paths/aws-mgn/mgn.sh                     the verbs
 *   paths/aws-mgn/replication-template.json  the replication settings (ids resolved at run time)
 *   paths/aws-mgn/servers.json               per item: launch name, platform, licensing, launch files
 *   paths/aws-mgn/launch/<item>.test.json    EC2 launch template data for the test launch
 *   paths/aws-mgn/launch/<item>.cutover.json and for the cutover launch
 *   paths/aws-mgn/mgn-import.csv             the MGN import file (provider format)
 *   paths/aws-mgn/cmf-intake.csv             the Cloud Migration Factory intake form (provider format)
 *   paths/aws-mgn/README.md                  the order of operations, the agentless option, the exports
 *   ansible/mgn-agent.yml                    the replication agent, installed with short-lived credentials
 *
 * MGN launches the launch template's **default** version, so `test` makes
 * the test version the default and `test-cleanup` / `cutover` the cutover
 * version (https://docs.aws.amazon.com/mgn/latest/ug/launch-template.html).
 */

import { warning,              } from '../../../../core/findings.js';
                                               
import { code, shScript } from '../lib-sh.js';
                                                   
                                                                           
import { csvText, jsonText, placementOf, sgKey, subnetKey, TF_OUTPUT_FN,                } from './cloud-shared.js';

const DIR = 'paths/aws-mgn';
export const MGN_SCRIPT = `${DIR}/mgn.sh`;
const PATHS                      = ['aws-mgn'];

export const MGN_NEEDS                      = Object.freeze([
  { kind: 'command', name: 'aws', min: '2', why: 'AWS Transform MGN and EC2 (aws mgn, aws ec2)', install: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html' },
  { kind: 'command', name: 'terraform', min: '1.7', why: 'reading the replication outputs of the AWS stack' },
  { kind: 'command', name: 'ansible-playbook', why: 'installing the MGN replication agent' },
  { kind: 'command', name: 'sha256sum', why: 'naming launch template versions by their content' },
  { kind: 'ansible-collection', name: 'ansible.windows', why: 'the MGN agent on Windows sources' },
]);

/** The MGN import file's columns (https://docs.aws.amazon.com/mgn/latest/ug/import-parameters.html; spellings to verify on the page). */
export const MGN_IMPORT_COLUMNS                    = Object.freeze([
  'mgn:account-id', 'mgn:region', 'mgn:wave:name', 'mgn:app:name', 'mgn:server:user-provided-id', 'mgn:server:platform',
  'mgn:server:fqdn-for-action-framework', 'mgn:server:tag:atk_item', 'mgn:launch:instance-type', 'mgn:launch:copy-private-ip',
  'mgn:launch:iam-instance-profile:name', 'mgn:launch:nic:0:subnet-id', 'mgn:launch:nic:0:security-group-id:0',
  'mgn:launch:placement:tenancy', 'mgn:launch:tag:instance:atk_item', 'mgn:launch:tag:instance:atk_wave',
]);

/** The Cloud Migration Factory intake form's columns: the required ones, then the optional ones used. */
export const CMF_INTAKE_COLUMNS                    = Object.freeze([
  'wave_name', 'app_name', 'aws_accountid', 'aws_region', 'server_name', 'server_os_family', 'server_os_version', 'server_fqdn',
  'server_tier', 'server_environment', 'r_type', 'subnet_IDs', 'securitygroup_IDs', 'subnet_IDs_test', 'securitygroup_IDs_test',
  'instanceType', 'tenancy', 'iamRole', 'tags',
]);

/** A cell the run-time resolver can split on commas: commas become semicolons. */
const flat = (s        )         => s.replace(/[,\r\n]+/g, ';');

                       
                        
                                         
                           
                                                                    
                        
 

/** EC2 launch template data for a phase, with landing-zone keys the script resolves. */
export function launchData(item              , p           , phase                    , planId        )                          {
  const network = phase === 'test' ? p.testNetwork : p.network;
  const ipv6 = phase === 'test' ? p.testIpv6 : p.ipv6;
  const tags = [
    { Key: 'Name', Value: phase === 'test' ? `${item.name}-test` : item.name },
    { Key: 'atk_plan', Value: planId },
    { Key: 'atk_item', Value: item.id },
    { Key: 'atk_wave', Value: item.wave === null ? '' : String(item.wave) },
    { Key: 'atk_app', Value: item.app },
    { Key: 'atk_phase', Value: phase },
  ];
  return {
    InstanceType: p.size,
    NetworkInterfaces: [{
      DeviceIndex: 0,
      SubnetId: `@subnet ${subnetKey(network, p.tier, p.zoneLetter)}`,
      Groups: [`@sg ${sgKey(network, p.tier)}`],
      AssociatePublicIpAddress: false,
      DeleteOnTermination: true,
      ...(ipv6 ? { Ipv6AddressCount: 1 } : {}),
    }],
    IamInstanceProfile: { Name: '@instance_profile' },
    MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', ...(ipv6 ? { HttpProtocolIpv6: 'enabled' } : {}) },
    TagSpecifications: [
      { ResourceType: 'instance', Tags: tags },
      { ResourceType: 'volume', Tags: tags },
    ],
  };
}

/** The replication template, less the ids the script fills from the stack's `mgn` output. */
export function replicationTemplate(ctx             )                          {
  const pd = ctx.design.platforms.find((p) => p.platform === 'aws');
  const mgmtV6 = pd?.networks.some((n) => n.envs.includes('prod') && n.ipv6) ?? true;
  const s = ctx.settings.mgn ?? { replication: 'agent', serverType: 't3.small', bandwidthMbps: 0, ip: mgmtV6 ? 'IPV6' : 'IPV4' };
  return {
    associateDefaultSecurityGroup: false,
    bandwidthThrottling: s.bandwidthMbps,
    createPublicIP: false,
    dataPlaneRouting: 'PRIVATE_IP',
    defaultLargeStagingDiskType: 'GP3',
    ebsEncryption: 'CUSTOM',
    ebsEncryptionKeyArn: '@kms',
    internetProtocol: s.ip,
    replicationServerInstanceType: s.serverType,
    replicationServersSecurityGroupsIDs: ['@mgn_sg'],
    stagingAreaSubnetId: '@staging_subnet',
    stagingAreaTags: { atk_plan: ctx.manifest.planId8 },
    useDedicatedReplicationServer: false,
  };
}

const FUNCTIONS = (replication                       , lagMax        )         => code`
MGN_DIR="$ATK_HOME/paths/aws-mgn"
MGN_TF="$\{ATK_TF_AWS_DIR:-$ATK_ROOT/terraform/aws}"
MGN_INVENTORY="$\{ATK_INVENTORY:-$ATK_ROOT/ansible/inventory}"
MGN_REPLICATION="$\{ATK_MGN_REPLICATION:-${replication}}"
MGN_LAG_MAX=${lagMax}
MGN_OUT=""
${TF_OUTPUT_FN}
# The item's region: the target in the manifest, else AWS_REGION.
mgn_region() {
  local t="$\{ATK_TARGET[$1]:-}" r=""
  if [[ "$t" == *:* ]]; then r="$\{t#*:}"; fi
  if [[ -z "$r" || "$r" == "-" ]]; then r="$\{AWS_REGION:-$\{AWS_DEFAULT_REGION:-}}"; fi
  [[ -n "$r" ]] || atk_die 3 "no AWS region for $1: set AWS_REGION"
  printf '%s' "$r"
}

# The replication stack's mgn output (staging subnet, security group, key, agent role, landing-zone ids).
mgn_load() {
  if [[ -z "$MGN_OUT" ]]; then MGN_OUT="$(atk_tf_output "$MGN_TF" mgn)"; fi
  return 0
}
mgn_lz() { jq -c '{subnet_ids, security_group_ids, network_ids, instance_profile}' <<< "$MGN_OUT"; }

# The source server tagged atk_item=ID (not archived); agentless servers are matched by host name once and tagged.
mgn_server_json() {
  local id="$1" r="$2" all s arn
  all="$(aws mgn describe-source-servers --region "$r" --filters '{"isArchived":false}' --output json)"
  s="$(jq -c --arg id "$id" '[.items[] | select(.tags.atk_item == $id)] | .[0] // empty' <<< "$all")"
  if [[ -z "$s" && "$MGN_REPLICATION" == agentless ]]; then
    s="$(jq -c --arg n "$\{ATK_NAME[$id],,}" '[.items[] | select(((.sourceProperties.identificationHints.hostname // "") | ascii_downcase | split(".")[0]) == $n)] | .[0] // empty' <<< "$all")"
    if [[ -n "$s" ]]; then
      arn="$(jq -r .arn <<< "$s")"
      atk_run aws mgn tag-resource --region "$r" --resource-arn "$arn" --tags "atk_item=$id" "atk_plan=$ATK_PLAN8"
    fi
  fi
  printf '%s' "$s"
}
mgn_has_server() { [[ -n "$(mgn_server_json "$1" "$2")" ]]; }

# ISO 8601 duration (PT1M30S) to seconds; unknown is very large.
mgn_seconds() {
  local d="$\{1:-}" re='^P(([0-9]+)D)?(T(([0-9]+)H)?(([0-9]+)M)?(([0-9]+)(\.[0-9]+)?S)?)?$'
  if [[ -n "$d" && "$d" =~ $re ]]; then
    printf '%s' "$(( $\{BASH_REMATCH[2]:-0} * 86400 + $\{BASH_REMATCH[5]:-0} * 3600 + $\{BASH_REMATCH[7]:-0} * 60 + $\{BASH_REMATCH[9]:-0} ))"
  else
    printf '%s' 999999
  fi
}

# Replication settings: initialize the service when needed, then create or update the template.
mgn_template() {
  local r="$1" want have tid same
  want="$(jq --argjson o "$MGN_OUT" '.stagingAreaSubnetId = $o.staging_subnet_id
    | .replicationServersSecurityGroupsIDs = [$o.security_group_id]
    | if ($o.kms_key_arn // "") != "" then .ebsEncryptionKeyArn = $o.kms_key_arn else (.ebsEncryption = "DEFAULT" | del(.ebsEncryptionKeyArn)) end' "$MGN_DIR/replication-template.json")"
  if ! have="$(aws mgn describe-replication-configuration-templates --region "$r" --output json 2> /dev/null)"; then have='{"items":[]}'; fi
  if [[ "$(jq '.items | length' <<< "$have")" == 0 ]]; then
    atk_run aws mgn initialize-service --region "$r"
    jq -c . <<< "$want" | atk_run aws mgn create-replication-configuration-template --region "$r" --cli-input-json file:///dev/stdin > /dev/null
    return 0
  fi
  tid="$(jq -r '.items[0].replicationConfigurationTemplateID' <<< "$have")"
  same="$(jq -n --argjson w "$want" --argjson h "$(jq -c '.items[0]' <<< "$have")" '[$w | to_entries[] | .value == $h[.key]] | all')"
  if [[ "$same" == true ]]; then atk_log "replication template $tid is up to date"; return 0; fi
  jq -c --arg t "$tid" '. + {replicationConfigurationTemplateID: $t} | del(.tags)' <<< "$want" \
    | atk_run aws mgn update-replication-configuration-template --region "$r" --cli-input-json file:///dev/stdin > /dev/null
}

# The replication agent, installed by Ansible with 1-hour credentials from the agent-install role (in the environment, never as flags).
mgn_install_agent() {
  local id="$1" r="$2" role creds
  role="$\{MGN_AGENT_ROLE_ARN:-$(jq -r '.agent_role_arn // empty' <<< "$MGN_OUT")}"
  [[ -n "$role" ]] || atk_die 5 "no agent-install role: apply aws_mig_replication, or set MGN_AGENT_ROLE_ARN"
  creds="$(aws sts assume-role --role-arn "$role" --role-session-name "atk-$ATK_PLAN8-mgn" --duration-seconds 3600 --output json)"
  ATK_MGN_AK="$(jq -r .Credentials.AccessKeyId <<< "$creds")"
  ATK_MGN_SK="$(jq -r .Credentials.SecretAccessKey <<< "$creds")"
  ATK_MGN_ST="$(jq -r .Credentials.SessionToken <<< "$creds")"
  creds=""
  _atk_redact_add "$ATK_MGN_SK"
  _atk_redact_add "$ATK_MGN_ST"
  export ATK_MGN_AK ATK_MGN_SK ATK_MGN_ST
  atk_run ansible-playbook -i "$MGN_INVENTORY" "$ATK_HOME/ansible/mgn-agent.yml" --limit "$\{ATK_NAME[$id]}" \
    -e "mgn_region=$r" -e "atk_item=$id" -e "atk_wave=$\{ATK_ITEM_WAVE[$id]}" -e "atk_plan=$ATK_PLAN8"
}

# The highest launch template version whose description is DESC, or starts with DESC-.
mgn_lt_version() {
  aws ec2 describe-launch-template-versions --region "$1" --launch-template-id "$2" --output json \
    | jq -r --arg d "$3" '[.LaunchTemplateVersions[] | select(.VersionDescription == $d or ((.VersionDescription // "") | startswith($d + "-")))] | max_by(.VersionNumber) | .VersionNumber // empty'
}
mgn_template_id() { aws mgn get-launch-configuration --region "$1" --source-server-id "$2" --query ec2LaunchTemplateID --output text; }

# Make PHASE's launch template version the default one: MGN launches the default version, not the latest.
mgn_use_version() {
  local r="$1" sid="$2" phase="$3" lt ver cur
  lt="$(mgn_template_id "$r" "$sid")"
  ver="$(mgn_lt_version "$r" "$lt" "atk-$phase")"
  if [[ -z "$ver" ]]; then
    if (( ATK_DRY_RUN )); then atk_log "dry-run: no $phase launch template version yet"; return 0; fi
    atk_die 5 "no $phase launch template version on $lt: run prepare"
  fi
  cur="$(aws ec2 describe-launch-templates --region "$r" --launch-template-ids "$lt" --query 'LaunchTemplates[0].DefaultVersionNumber' --output text)"
  if [[ "$cur" == "$ver" ]]; then atk_log "the $phase version ($ver) is already the default of $lt"; return 0; fi
  atk_run aws ec2 modify-launch-template --region "$r" --launch-template-id "$lt" --default-version "$ver" > /dev/null
}

# The launch settings of a source server, and its test and cutover launch template versions.
mgn_launch() {
  local id="$1" r="$2" sid="$3" s cur lt phase data hash desc byol name
  s="$(jq -c --arg id "$id" '.[$id] // empty' "$MGN_DIR/servers.json")"
  [[ -n "$s" ]] || atk_fail "$id" "no launch data for this server: the design has no AWS compute target for it; regenerate the kit"
  name="$(jq -r .name <<< "$s")"
  byol="$(jq -r .osByol <<< "$s")"
  cur="$(aws mgn get-launch-configuration --region "$r" --source-server-id "$sid" --output json)"
  if jq -e --arg n "$name" --argjson b "$byol" '.name == $n and .targetInstanceTypeRightSizingMethod == "NONE" and .launchDisposition == "STARTED"
      and .copyPrivateIp == false and .copyTags == true and .bootMode == "USE_SOURCE" and (.licensing.osByol // false) == $b' <<< "$cur" > /dev/null; then
    atk_log "launch settings of $sid are up to date"
  else
    atk_run aws mgn update-launch-configuration --region "$r" --source-server-id "$sid" --name "$name" \
      --target-instance-type-right-sizing-method NONE --launch-disposition STARTED --no-copy-private-ip --copy-tags \
      --boot-mode USE_SOURCE --licensing "osByol=$byol" \
      --post-launch-actions '{"deployment":"TEST_AND_CUTOVER","ssmDocuments":[]}' > /dev/null
  fi
  lt="$(jq -r .ec2LaunchTemplateID <<< "$cur")"
  for phase in test cutover; do
    data="$(atk_resolve "$(mgn_lz)" < "$MGN_DIR/launch/$(jq -r .file <<< "$s").$phase.json" | jq -cS .)"
    hash="$(printf '%s' "$data" | sha256sum | cut -c1-12)"
    desc="atk-$phase-$hash"
    if [[ -n "$(mgn_lt_version "$r" "$lt" "$desc")" ]]; then atk_log "$phase launch template version $desc exists"; continue; fi
    printf '%s' "$data" | atk_run aws ec2 create-launch-template-version --region "$r" --launch-template-id "$lt" \
      --source-version '$Default' --version-description "$desc" --launch-template-data file:///dev/stdin > /dev/null
  done
}

# The MGN application (per app) and wave (per wave), so the MGN console shows the kit's grouping.
mgn_group() {
  local id="$1" r="$2" s="$3" sid app wave appid waveid apps
  sid="$(jq -r .sourceServerID <<< "$s")"
  app="$\{ATK_APP[$id]}"
  wave="$\{ATK_ITEM_WAVE[$id]}"
  apps="$(aws mgn list-applications --region "$r" --output json)"
  appid="$(jq -r --arg n "$app" '[.items[] | select(.name == $n and ((.isArchived // false) | not))] | .[0].applicationID // empty' <<< "$apps")"
  if [[ -z "$appid" ]]; then
    appid="$(atk_run aws mgn create-application --region "$r" --name "$app" --tags "atk_plan=$ATK_PLAN8" --query applicationID --output text)"
    appid="$\{appid:-dry-run}"
  fi
  if [[ "$(jq -r '.applicationID // empty' <<< "$s")" != "$appid" ]]; then
    atk_run aws mgn associate-source-servers --region "$r" --application-id "$appid" --source-server-ids "$sid"
  fi
  [[ "$wave" =~ ^[0-9]+$ ]] || return 0
  waveid="$(aws mgn list-waves --region "$r" --output json | jq -r --arg n "atk-$ATK_PLAN8-w$wave" '[.items[] | select(.name == $n)] | .[0].waveID // empty')"
  if [[ -z "$waveid" ]]; then
    waveid="$(atk_run aws mgn create-wave --region "$r" --name "atk-$ATK_PLAN8-w$wave" --tags "atk_plan=$ATK_PLAN8" --query waveID --output text)"
    waveid="$\{waveid:-dry-run}"
  fi
  if [[ "$(jq -r --arg a "$appid" '[.items[] | select(.applicationID == $a)] | .[0].waveID // empty' <<< "$apps")" != "$waveid" ]]; then
    atk_run aws mgn associate-applications --region "$r" --wave-id "$waveid" --application-ids "$appid"
  fi
}

# The provider-format exports with the landing-zone keys resolved: status/exports/aws-mgn/.
mgn_exports() {
  local r="$1" acct out f
  acct="$(aws sts get-caller-identity --query Account --output text)"
  out="$ATK_STATUS/exports/aws-mgn"
  mkdir -p "$out"
  for f in mgn-import.csv cmf-intake.csv; do
    jq -Rr --argjson lz "$(mgn_lz)" --arg acct "$acct" --arg r "$r" 'split(",") | map(
        if . == "@account" then $acct
        elif . == "@region" then $r
        elif startswith("@subnet ") then ($lz.subnet_ids[.[8:]] // .)
        elif startswith("@sg ") then ($lz.security_group_ids[.[4:]] // .)
        elif . == "@instance_profile" then ($lz.instance_profile // .)
        else . end) | join(",")' "$MGN_DIR/$f" > "$out/$f"
  done
}

# Poll a job until it completes; 0 when COMPLETED.
mgn_job_done() {
  local st
  st="$(aws mgn describe-jobs --region "$1" --filters "jobIDs=$2" --query 'items[0].status' --output text)"
  [[ "$st" == COMPLETED ]]
}
mgn_wait_job() {
  local r="$1" job="$2" what="$3"
  [[ -n "$job" && "$job" != None ]] || return 0
  atk_wait_until 90 30 mgn_job_done "$r" "$job" || atk_die 1 "the $what job $job did not complete"
  local failed
  failed="$(aws mgn describe-jobs --region "$r" --filters "jobIDs=$job" --output json | jq -r '[.items[0].participatingServers[]? | select(.launchStatus == "FAILED")] | length')"
  [[ "$failed" == 0 ]] || atk_die 1 "the $what job $job failed to launch (aws mgn describe-job-log-items --job-id $job)"
}

# The launched instance of a source server, as event data: instanceId, targetIpv4, targetIpv6.
mgn_instance_data() {
  local r="$1" s="$2" iid inst
  iid="$(jq -r '.launchedInstance.ec2InstanceID // empty' <<< "$s")"
  [[ -n "$iid" ]] || return 0
  inst="$(aws ec2 describe-instances --region "$r" --instance-ids "$iid" --output json)"
  printf 'instanceId=%s\n' "$iid"
  printf 'targetIpv4=%s\n' "$(jq -r '.Reservations[0].Instances[0].PrivateIpAddress // empty' <<< "$inst")"
  printf 'targetIpv6=%s\n' "$(jq -r '[.Reservations[0].Instances[0].NetworkInterfaces[]?.Ipv6Addresses[]?.Ipv6Address] | .[0] // empty' <<< "$inst")"
}

# Replication state as event data, and whether the server is in sync (0) or not (1).
MGN_REPORT=()
mgn_report() {
  local s="$1" state lag secs pct backlog
  state="$(jq -r '.dataReplicationInfo.dataReplicationState // "UNKNOWN"' <<< "$s")"
  lag="$(jq -r '.dataReplicationInfo.lagDuration // empty' <<< "$s")"
  secs="$(mgn_seconds "$lag")"
  pct="$(jq -r '[.dataReplicationInfo.replicatedDisks[]?] | ((map(.totalStorageBytes // 0) | add) // 0) as $t | ((map(.replicatedStorageBytes // 0) | add) // 0) as $d | if $t > 0 then (100 * $d / $t | floor) else 0 end' <<< "$s")"
  backlog="$(jq -r '[.dataReplicationInfo.replicatedDisks[]?.backloggedStorageBytes // 0] | add // 0' <<< "$s")"
  MGN_REPORT=("replicationState=$state" "progressPct=$pct" "lagSeconds=$secs" "backlogBytes=$backlog")
  [[ "$state" == CONTINUOUS ]] && (( secs <= MGN_LAG_MAX ))
}
mgn_synced() {
  local s
  s="$(mgn_server_json "$1" "$2")"
  [[ -n "$s" ]] || return 1
  case "$(jq -r '.dataReplicationInfo.dataReplicationState // ""' <<< "$s")" in STALLED|DISCONNECTED) return 0 ;; esac
  mgn_report "$s"
}
mgn_synced_final() {
  local s
  s="$(mgn_server_json "$1" "$2")"
  [[ -n "$s" ]] || return 1
  mgn_report "$s" && [[ "$(jq -r '[.dataReplicationInfo.replicatedDisks[]?.backloggedStorageBytes // 0] | add // 0' <<< "$s")" == 0 ]]
}
`;

const V = {
  prepare: code`
local r s sid
r="$(mgn_region "$id")"
mgn_load
mgn_template "$r"
s="$(mgn_server_json "$id" "$r")"
if [[ -z "$s" ]]; then
  if [[ "$MGN_REPLICATION" == agentless ]]; then
    atk_fail "$id" "agentless replication: the source server is not discovered; deploy the AWS MGN vCenter Client (README, step 2) and run prepare again"
  fi
  mgn_install_agent "$id" "$r"
  if (( ATK_DRY_RUN )); then atk_done "$id" "" "dry run: the agent install and the launch settings were printed"; fi
  atk_wait_until 30 30 mgn_has_server "$id" "$r" || atk_fail "$id" "the agent was installed but the server did not register with AWS Transform MGN within 30 minutes"
  s="$(mgn_server_json "$id" "$r")"
fi
sid="$(jq -r .sourceServerID <<< "$s")"
if [[ "$MGN_REPLICATION" == agentless && "$(jq -r '.dataReplicationInfo.dataReplicationState // "NONE"' <<< "$s")" == NONE ]]; then
  atk_run aws mgn start-replication --region "$r" --source-server-id "$sid" > /dev/null
fi
mgn_launch "$id" "$r" "$sid"
mgn_group "$id" "$r" "$s"
mgn_exports "$r"
atk_done "$id" prepared "" sourceServerId="$sid"
`,
  replicate: code`
local r s sid
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_fail "$id" "not registered with AWS Transform MGN: run prepare"
sid="$(jq -r .sourceServerID <<< "$s")"
atk_wait_until 1440 60 mgn_synced "$id" "$r" || true
s="$(mgn_server_json "$id" "$r")"
case "$(jq -r '.dataReplicationInfo.dataReplicationState // ""' <<< "$s")" in
  STALLED|DISCONNECTED)
    mgn_report "$s" || true
    if ! atk_ids_get aws-mgn "retry:$sid:$ATK_RUN_ID" > /dev/null 2>&1; then
      atk_run aws mgn retry-data-replication --region "$r" --source-server-id "$sid" > /dev/null
      atk_ids_put aws-mgn "retry:$sid:$ATK_RUN_ID" 1
    fi
    atk_fail "$id" "replication is stalled or disconnected; AWS Transform MGN was asked to retry" "$\{MGN_REPORT[@]}" ;;
esac
if mgn_report "$s"; then atk_done "$id" in-sync "" inSync=true "$\{MGN_REPORT[@]}"; fi
atk_done "$id" replicating "" "$\{MGN_REPORT[@]}"
`,
  test: code`
local r s sid lc job ip data=() passed=failed
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_fail "$id" "not registered with AWS Transform MGN: run prepare"
sid="$(jq -r .sourceServerID <<< "$s")"
lc="$(jq -r .lifeCycle.state <<< "$s")"
if [[ "$lc" == TESTING && -n "$(jq -r '.launchedInstance.ec2InstanceID // empty' <<< "$s")" ]]; then
  mapfile -t data < <(mgn_instance_data "$r" "$s")
  atk_skip "$id" "a test instance is already running" testing "$\{data[@]}"
fi
[[ "$lc" == READY_FOR_TEST ]] || atk_fail "$id" "a test launch needs the server Ready for testing; it is $lc"
mgn_use_version "$r" "$sid" test
job="$(atk_run aws mgn start-test --region "$r" --source-server-ids "$sid" --query job.jobID --output text)"
if (( ATK_DRY_RUN )); then atk_done "$id" testing "dry run: the test launch was printed"; fi
mgn_wait_job "$r" "$job" test
s="$(mgn_server_json "$id" "$r")"
mapfile -t data < <(mgn_instance_data "$r" "$s")
ip="$(printf '%s\n' "$\{data[@]}" | sed -n 's/^targetIpv4=//p')"
if [[ -f "$ATK_HOME/ansible/validate.yml" ]]; then
  if atk_run ansible-playbook -i "$MGN_INVENTORY" "$ATK_HOME/ansible/validate.yml" --limit "$\{ATK_NAME[$id]}" \
      -e validate_phase=test -e "validate_item=$id" -e "validate_address=$ip"; then passed=passed; fi
else
  atk_log "ansible/validate.yml is not in this kit: the test launch is not validated"
fi
atk_ids_put aws-mgn "test:$id" "$passed"
atk_done "$id" testing "" "$\{data[@]}" validated="$passed"
`,
  'test-cleanup': code`
local r s sid lc job passed
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_fail "$id" "not registered with AWS Transform MGN: run prepare"
sid="$(jq -r .sourceServerID <<< "$s")"
lc="$(jq -r .lifeCycle.state <<< "$s")"
passed="$(atk_ids_get aws-mgn "test:$id" 2> /dev/null || true)"
if [[ "$lc" == TESTING ]]; then
  job="$(atk_run aws mgn terminate-target-instances --region "$r" --source-server-ids "$sid" --query job.jobID --output text)"
  mgn_wait_job "$r" "$job" terminate
fi
if [[ "$passed" != passed ]]; then
  atk_done "$id" "" "the test instance is removed; the test did not pass, so the server stays Ready for testing" passed=false
fi
if [[ "$lc" == TESTING || "$lc" == READY_FOR_TEST ]]; then
  atk_run aws mgn change-server-life-cycle-state --region "$r" --source-server-id "$sid" --life-cycle state=READY_FOR_CUTOVER > /dev/null
fi
mgn_use_version "$r" "$sid" cutover
atk_done "$id" "" "" passed=true
`,
  cutover: code`
local r s sid lc job data=()
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_fail "$id" "not registered with AWS Transform MGN: run prepare"
sid="$(jq -r .sourceServerID <<< "$s")"
lc="$(jq -r .lifeCycle.state <<< "$s")"
case "$lc" in
  CUTTING_OVER|CUTOVER)
    if [[ -n "$(jq -r '.launchedInstance.ec2InstanceID // empty' <<< "$s")" ]]; then
      mapfile -t data < <(mgn_instance_data "$r" "$s")
      atk_skip "$id" "the cutover instance is already launched" cut-over "$\{data[@]}"
    fi ;;
  READY_FOR_CUTOVER) ;;
  *) atk_fail "$id" "a cutover launch needs the server Ready for cutover (run test and test-cleanup); it is $lc" ;;
esac
atk_wait_until 120 30 mgn_synced_final "$id" "$r" || atk_fail "$id" "replication did not catch up (backlog 0, lag at most $\{MGN_LAG_MAX}s) after the freeze" "$\{MGN_REPORT[@]}"
mgn_use_version "$r" "$sid" cutover
job="$(atk_run aws mgn start-cutover --region "$r" --source-server-ids "$sid" --query job.jobID --output text)"
if (( ATK_DRY_RUN )); then atk_done "$id" cut-over "dry run: the cutover launch was printed"; fi
mgn_wait_job "$r" "$job" cutover
s="$(mgn_server_json "$id" "$r")"
mapfile -t data < <(mgn_instance_data "$r" "$s")
atk_ids_put aws-mgn "instance:$\{ATK_NAME[$id]}" "$(printf '%s\n' "$\{data[@]}" | sed -n 's/^instanceId=//p')"
atk_done "$id" cut-over "" "$\{data[@]}"
`,
  commit: code`
local r s sid lc
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_skip "$id" "not registered (already finalized and archived)"
sid="$(jq -r .sourceServerID <<< "$s")"
lc="$(jq -r .lifeCycle.state <<< "$s")"
case "$lc" in
  CUTOVER) atk_skip "$id" "the cutover is already finalized" ;;
  CUTTING_OVER) atk_run aws mgn finalize-cutover --region "$r" --source-server-id "$sid" > /dev/null ;;
  *) atk_fail "$id" "finalize needs a launched cutover instance; the server is $lc" ;;
esac
atk_done "$id" "" "cutover finalized: replication stopped and the staging resources are removed"
`,
  rollback: code`
local r s sid lc iid kept=true
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_fail "$id" "not registered with AWS Transform MGN: nothing to roll back here; restart the source through its adapter"
sid="$(jq -r .sourceServerID <<< "$s")"
lc="$(jq -r .lifeCycle.state <<< "$s")"
iid="$(jq -r '.launchedInstance.ec2InstanceID // empty' <<< "$s")"
if [[ "$lc" == TESTING ]]; then
  atk_run aws mgn terminate-target-instances --region "$r" --source-server-ids "$sid" > /dev/null
  atk_done "$id" "" "the test instance is terminated" replicationKept=true
fi
[[ -n "$iid" ]] || atk_done "$id" "" "no AWS instance was launched: nothing to stop; the source is restarted through its adapter" replicationKept=true
if [[ -n "$iid" && "$(aws ec2 describe-instances --region "$r" --instance-ids "$iid" --query 'Reservations[0].Instances[0].State.Name' --output text)" == running ]]; then
  atk_run aws ec2 stop-instances --region "$r" --instance-ids "$iid" > /dev/null
fi
case "$lc" in
  CUTTING_OVER) atk_run aws mgn change-server-life-cycle-state --region "$r" --source-server-id "$sid" --life-cycle state=READY_FOR_CUTOVER > /dev/null ;;
  CUTOVER|DISCONNECTED) kept=false ;;
esac
if [[ "$kept" == false ]]; then
  atk_done "$id" "" "the AWS instance is stopped and kept for analysis. AWS Transform MGN has no reverse replication: writes on AWS since commit are lost unless the database path reverses them; restart the source through its adapter" replicationKept=false instanceId="$iid"
fi
atk_done "$id" "" "the AWS instance is stopped and kept for analysis; replication continues, the server is Ready for cutover again" replicationKept=true instanceId="$iid"
`,
  finalize: code`
local r s sid
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_skip "$id" "not registered, or already archived"
sid="$(jq -r .sourceServerID <<< "$s")"
if [[ "$(jq -r '.dataReplicationInfo.dataReplicationState // ""' <<< "$s")" != DISCONNECTED ]]; then
  atk_run aws mgn disconnect-from-service --region "$r" --source-server-id "$sid" > /dev/null
fi
atk_run aws mgn mark-as-archived --region "$r" --source-server-id "$sid" > /dev/null
atk_done "$id" "" "disconnected and archived in AWS Transform MGN"
`,
  status: code`
local r s
r="$(mgn_region "$id")"
s="$(mgn_server_json "$id" "$r")"
[[ -n "$s" ]] || atk_skip "$id" "not registered with AWS Transform MGN yet"
if mgn_report "$s"; then atk_done "$id" in-sync "" inSync=true lifeCycle="$(jq -r .lifeCycle.state <<< "$s")" "$\{MGN_REPORT[@]}"; fi
atk_done "$id" "" "" inSync=false lifeCycle="$(jq -r .lifeCycle.state <<< "$s")" "$\{MGN_REPORT[@]}"
`,
};

/** `ansible/mgn-agent.yml`: the replication agent on Linux and Windows sources, idempotent, credentials in the environment. */
export const MGN_AGENT_PLAYBOOK = `---
# Installs the AWS Transform MGN replication agent (formerly AWS Application Migration Service)
# on source servers. paths/aws-mgn/mgn.sh prepare runs it per server with --limit, after exporting
# 1-hour credentials of the agent-install role as ATK_MGN_AK, ATK_MGN_SK and ATK_MGN_ST.
# The installer reads them from its environment, never from flags, which the process list would show.
# Docs: https://docs.aws.amazon.com/mgn/latest/ug/linux-agent.html
#       https://docs.aws.amazon.com/mgn/latest/ug/windows-agent.html
- name: Install the AWS Transform MGN replication agent
  hosts: all
  gather_facts: true
  vars:
    mgn_bucket: "https://aws-application-migration-service-{{ mgn_region }}.s3.{{ mgn_region }}.amazonaws.com/latest"
    mgn_hashes: "https://aws-application-migration-service-hashes-{{ mgn_region }}.s3.{{ mgn_region }}.amazonaws.com/latest"
    mgn_environment:
      AWS_ACCESS_KEY_ID: "{{ lookup('ansible.builtin.env', 'ATK_MGN_AK') }}"
      AWS_SECRET_ACCESS_KEY: "{{ lookup('ansible.builtin.env', 'ATK_MGN_SK') }}"
      AWS_SESSION_TOKEN: "{{ lookup('ansible.builtin.env', 'ATK_MGN_ST') }}"
  tasks:
    - name: Check the play's inputs
      ansible.builtin.assert:
        that:
          - mgn_region is defined
          - atk_item is defined
          - lookup('ansible.builtin.env', 'ATK_MGN_AK') | length > 0
        fail_msg: Run this play through paths/aws-mgn/mgn.sh prepare, which sets the region, the item and the credentials.
        quiet: true

    - name: Linux sources
      when: ansible_facts['os_family'] != 'Windows'
      become: true
      block:
        - name: Read the services
          ansible.builtin.service_facts:

        - name: Install the agent when it is not there
          when: "'aws-replication.service' not in ansible_facts['services']"
          block:
            - name: Make a private working directory
              ansible.builtin.tempfile:
                state: directory
                suffix: mgn
              register: mgn_tmp

            - name: Download the installer, checked against the published SHA-512
              ansible.builtin.get_url:
                url: "{{ mgn_bucket }}/linux/aws-replication-installer-init"
                dest: "{{ mgn_tmp.path }}/aws-replication-installer-init"
                checksum: "sha512:{{ mgn_hashes }}/linux/aws-replication-installer-init.sha512"
                mode: "0700"

            - name: Run the installer
              ansible.builtin.command:
                argv:
                  - "{{ mgn_tmp.path }}/aws-replication-installer-init"
                  - --region
                  - "{{ mgn_region }}"
                  - --no-prompt
                  - --tags
                  - "atk_item={{ atk_item }}"
                  - "atk_wave={{ atk_wave }}"
                  - "atk_plan={{ atk_plan }}"
              environment: "{{ mgn_environment }}"
              no_log: true
              changed_when: true

          always:
            - name: Remove the working directory
              ansible.builtin.file:
                path: "{{ mgn_tmp.path }}"
                state: absent
              when: mgn_tmp.path is defined

    - name: Windows sources
      when: ansible_facts['os_family'] == 'Windows'
      block:
        - name: Look for the agent service
          ansible.windows.win_service_info:
            name: AwsReplicationService
          register: mgn_service

        - name: Install the agent when it is not there
          when: not mgn_service.exists
          block:
            - name: Make a private working directory
              ansible.windows.win_tempfile:
                state: directory
                suffix: mgn
              register: mgn_wtmp

            - name: Download the installer, checked against the published SHA-512
              ansible.windows.win_get_url:
                url: "{{ mgn_bucket }}/windows/AwsReplicationWindowsInstaller.exe"
                dest: "{{ mgn_wtmp.path }}\\\\AwsReplicationWindowsInstaller.exe"
                checksum_url: "{{ mgn_hashes }}/windows/AwsReplicationWindowsInstaller.exe.sha512"
                checksum_algorithm: sha512

            - name: Run the installer
              ansible.windows.win_command:
                argv:
                  - "{{ mgn_wtmp.path }}\\\\AwsReplicationWindowsInstaller.exe"
                  - --region
                  - "{{ mgn_region }}"
                  - --no-prompt
                  - --tags
                  - "atk_item={{ atk_item }}"
                  - "atk_wave={{ atk_wave }}"
                  - "atk_plan={{ atk_plan }}"
              environment: "{{ mgn_environment }}"
              no_log: true
              changed_when: true

          always:
            - name: Remove the working directory
              ansible.windows.win_file:
                path: "{{ mgn_wtmp.path }}"
                state: absent
              when: mgn_wtmp.path is defined
`;

function readme(ctx             , replication                       )         {
  return `# AWS Transform MGN (\`aws-mgn\`)

AWS Transform MGN is the current name of AWS Application Migration Service; the API and \`aws mgn\` are unchanged. \`mgn.sh\` drives it with the AWS CLI, because the AWS provider has no MGN resource. The replication security group, the staging subnet, the key and the agent-install role come from the \`aws_mig_replication\` item of the AWS stack (its \`mgn\` output).

Replication mode: **${replication}**${replication === 'agentless' ? ' (vCenter sources only)' : ''}. Replication lag allowed at cutover: ${ctx.settings.lagSeconds.server} s.

## Order of operations

1. Apply the AWS stack (\`terraform -chdir=terraform/aws apply\`), with the replication item in it.
2. ${replication === 'agent' ? 'The controller must reach every source server over SSH or WinRM (the Ansible inventory), and the sources must reach AWS on TCP 443 and the replication servers on TCP 1500.' : 'Agentless: install the AWS MGN vCenter Client on a machine that reaches vCenter (https://docs.aws.amazon.com/mgn/latest/ug/agentless-mgn.html); its servers appear in MGN, and `prepare` tags them and starts replication.'}
3. \`mgn.sh prepare --wave N\`: initializes the service when needed, writes the replication template, ${replication === 'agent' ? 'installs the agent (\`ansible/mgn-agent.yml\`, with 1-hour credentials of the agent-install role in its environment), ' : ''}sets the launch settings, creates the test and cutover launch template versions, and groups the servers into MGN applications and waves.
4. \`mgn.sh replicate --wave N\` until every server is in sync (\`CONTINUOUS\`, lag within the setting).
5. \`mgn.sh test\`: makes the test version the launch template's default (MGN launches the default version, not the latest), launches test instances on the test network and validates them.
6. \`mgn.sh test-cleanup\`: terminates the test instances, marks the servers Ready for cutover when the test passed, and makes the cutover version the default.
7. \`mgn.sh cutover\` (after the freeze): waits for backlog 0, launches the cutover instances; the wave's cutover stops the sources through their adapter.
8. \`mgn.sh commit\`: finalizes the cutover (replication stops, staging resources are removed).
9. \`mgn.sh finalize\` (at decommission): disconnects and archives the servers.

## No automatic fallback

AWS Transform MGN has no failback (https://docs.aws.amazon.com/mgn/latest/ug/General-Questions-FAQ.html). Before \`commit\`, \`rollback\` stops the AWS instance and returns the server to Ready for cutover with replication running; after \`commit\`, writes on AWS since then are lost unless the database path reverses them. Keep the source stopped, not deleted, until the keep-days end; where a failback path is needed, AWS Elastic Disaster Recovery is the tool for it.

## Provider-format exports

- \`mgn-import.csv\`: the MGN import file (https://docs.aws.amazon.com/mgn/latest/ug/import-parameters.html), one row per server with its application, wave and launch settings. The column spellings follow that page; check them against it before importing.
- \`cmf-intake.csv\`: the Cloud Migration Factory on AWS intake form (the required columns, then \`iamRole\` and \`tags\`).

Both name landing-zone keys (\`@subnet prod/app/a\`, \`@sg prod/app\`) and \`@account\`; \`prepare\` writes resolved copies to \`status/exports/aws-mgn/\`.

## Environment

\`AWS_REGION\` (when the manifest has none), the AWS CLI's own credentials (profile or instance role), \`ATK_INVENTORY\` (default \`ansible/inventory\`), \`ATK_TF_AWS_DIR\` (default \`terraform/aws\`), \`MGN_AGENT_ROLE_ARN\` (overrides the stack's), \`ATK_MGN_REPLICATION\` (\`agent\` or \`agentless\`).
`;
}

function files(items                         , ctx             )                         {
  const replication = ctx.settings.mgn?.replication ?? 'agent';
  const out                         = {};
  const servers                              = {};
  const importRows             = [];
  const cmfRows             = [];
  const planTag = ctx.manifest.planId8;
  for (const item of items) {
    const p = placementOf(item, ctx);
    if (!p) continue;
    const file = item.resource;
    servers[item.id] = { name: item.name, platform: p.windows ? 'WINDOWS' : 'LINUX', osByol: p.licence !== 'li', file };
    out[`${DIR}/launch/${file}.test.json`] = jsonText(launchData(item, p, 'test', planTag));
    out[`${DIR}/launch/${file}.cutover.json`] = jsonText(launchData(item, p, 'cutover', planTag));
    const fqdn = item.dns[0]?.fqdn ?? item.name;
    const wave = item.wave === null ? '' : `atk-${planTag}-w${item.wave}`;
    importRows.push([
      '@account', '@region', wave, flat(item.app), flat(item.name), p.windows ? 'WINDOWS' : 'LINUX', flat(fqdn), flat(item.id),
      p.size, 'false', '@instance_profile', `@subnet ${subnetKey(p.network, p.tier, p.zoneLetter)}`, `@sg ${sgKey(p.network, p.tier)}`,
      'default', flat(item.id), item.wave === null ? '' : String(item.wave),
    ]);
    cmfRows.push([
      wave, flat(item.app), '@account', '@region', flat(item.name), p.windows ? 'windows' : 'linux', flat(item.os ?? ''), flat(fqdn),
      p.tier, p.env, 'Rehost',
      `@subnet ${subnetKey(p.network, p.tier, p.zoneLetter)}`, `@sg ${sgKey(p.network, p.tier)}`,
      `@subnet ${subnetKey(p.testNetwork, p.tier, p.zoneLetter)}`, `@sg ${sgKey(p.testNetwork, p.tier)}`,
      p.size, 'Shared', '@instance_profile', flat(`atk_item:${item.id};atk_plan:${planTag}`),
    ]);
  }
  const sortedServers = Object.fromEntries(Object.keys(servers).sort().map((k) => [k, servers[k] ]));
  out[MGN_SCRIPT] = shScript({
    file: MGN_SCRIPT,
    paths: PATHS,
    summary: 'AWS Transform MGN (formerly AWS Application Migration Service): agent, launch settings, test, cutover, finalize.',
    needs: ['aws', 'jq', 'terraform', 'sha256sum', ...(replication === 'agent' ? ['ansible-playbook'] : [])],
    functions: FUNCTIONS(replication, ctx.settings.lagSeconds.server),
    verbs: V,
  });
  out[`${DIR}/replication-template.json`] = jsonText(replicationTemplate(ctx));
  out[`${DIR}/servers.json`] = jsonText(sortedServers);
  out[`${DIR}/mgn-import.csv`] = csvText(MGN_IMPORT_COLUMNS, importRows);
  out[`${DIR}/cmf-intake.csv`] = csvText(CMF_INTAKE_COLUMNS, cmfRows);
  out[`${DIR}/README.md`] = readme(ctx, replication);
  if (replication === 'agent') out['ansible/mgn-agent.yml'] = MGN_AGENT_PLAYBOOK;
  return out;
}

function findings(items                         , ctx             )            {
  const out            = [];
  const missing = items.filter((i) => !placementOf(i, ctx));
  if (missing.length) {
    out.push(warning('exec.mgn.no-design', `${missing.length} AWS Transform MGN item(s) have no AWS compute target in the design, so no launch settings were generated for them: ${missing.map((i) => i.name).join(', ')}.`, { remediation: 'Design the AWS platform, then regenerate the kit.' }));
  }
  if (ctx.settings.mgn?.replication === 'agentless') {
    const other = items.filter((i) => i.source.platform !== 'vsphere');
    if (other.length) out.push(warning('exec.mgn.agentless-source', `Agentless AWS Transform MGN takes vCenter sources only; ${other.map((i) => i.name).join(', ')} are not on vSphere.`, { remediation: 'Use agent-based replication (Execute › Settings › AWS MGN).', source: 'https://docs.aws.amazon.com/mgn/latest/ug/agentless-mgn.html' }));
  }
  return out;
}

export const AWS_MGN_GENERATOR                = Object.freeze({
  id: 'aws-mgn',
  owner: 'WP-11c'         ,
  paths: PATHS,
  needs: MGN_NEEDS,
  entry: () => MGN_SCRIPT,
  files,
  findings,
});

export const GENERATORS                           = Object.freeze([AWS_MGN_GENERATOR]);

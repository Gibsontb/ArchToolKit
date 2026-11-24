import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const systems = ['WINDOWS', 'AMAZON_LINUX_2', 'AMAZON_LINUX_2023', 'REDHAT_ENTERPRISE_LINUX'];
const schedules = ['cron(0 2 ? * SUN *)', 'cron(0 2 * * ? *)', 'cron(0 2 ? * SAT *)'];
export const AWS_SSM_PATCHING_SERVICE = {
  id: 'aws_service_ssm_patching', label: 'Set up managed-node patching and maintenance',
  description: 'Custom OS security baseline, dedicated patch group, retained encrypted command logs and an initially disabled scan/install maintenance window. Includes an explicit bounded one-time operator.',
  emits: ['aws_ssm_patch_baseline', 'aws_ssm_patch_group', 'aws_ssm_maintenance_window', 'aws_ssm_maintenance_window_target', 'aws_ssm_maintenance_window_task', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Patch workflow name', control: 'text' },
    { id: 'os', label: 'Managed-node operating system', control: 'select', default: 'AMAZON_LINUX_2023', options: systems.map(value => ({ value, label: value.replaceAll('_', ' ') })) },
    { id: 'group', label: 'Dedicated PatchGroup tag value', control: 'text', hint: 'Unused dedicated group across all operating systems. Tag approved nodes separately with the exact key PatchGroup; this package does not tag or enroll nodes.' },
    { id: 'approval_days', label: 'Security patch approval delay (days)', control: 'number', default: 7, hint: 'Critical/Important security updates only; emergency exceptions and product/repository policies require owner review.' },
    { id: 'operation', label: 'Patch operation', control: 'select', default: 'Scan', options: [{ value: 'Scan', label: 'Scan compliance only' }, { value: 'Install', label: 'Install approved security patches' }] },
    { id: 'reboot', label: 'OS reboot behavior', control: 'select', default: 'NoReboot', options: [{ value: 'NoReboot', label: 'No automatic OS reboot (services may still restart)' }, { value: 'RebootIfNeeded', label: 'Allow documented patch reboots' }] },
    { id: 'schedule', label: 'Maintenance schedule', control: 'select', default: schedules[0], options: [{ value: schedules[0] , label: 'Sunday at 02:00' }, { value: schedules[1] , label: 'Daily at 02:00' }, { value: schedules[2] , label: 'Saturday at 02:00' }] },
    { id: 'timezone', label: 'Schedule time zone', control: 'combo', default: 'UTC', options: ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'].map(value => ({ value, label: value })), hint: 'Approved IANA zone; review daylight-saving behavior.' },
    { id: 'enabled', label: 'Enable recurring window after pilot acceptance', control: 'select', default: 'NO', options: [{ value: 'NO', label: 'Disabled — configure and review first' }, { value: 'YES', label: 'Enabled — execute selected operation on schedule' }] },
    { id: 'duration', label: 'Maintenance duration (hours)', control: 'number', default: 3 },
    { id: 'cutoff', label: 'Stop starting tasks before end (hours)', control: 'number', default: 1 },
    { id: 'concurrency', label: 'Maximum concurrent nodes', control: 'number', default: 1 },
    { id: 'errors', label: 'Error threshold', control: 'number', default: 1 },
    { id: 'role', label: 'Existing maintenance-window service role ARN', control: 'text', hint: 'Dedicated same-account role with approved SSM trust/SendCommand scope to this document and tagged nodes, result access and necessary log delivery. Trust/permissions are not overwritten.' },
    { id: 'kms', label: 'Existing CloudWatch log encryption key ARN', control: 'text', hint: 'Same-account regional symmetric key with approved regional Logs-service encryption-context policy.' },
    { id: 'log_retention', label: 'Command log retention (days)', control: 'select', default: '90', options: ['7', '14', '30', '60', '90', '180', '365'].map(value => ({ value, label: value })) },
  ],
  build(values)                                      {
    const findings            = [], reject = (path        , message        ) => findings.push(error('aws.ssm.patching.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), os = String(values.os ?? ''), group = String(values.group ?? '').trim(), operation = String(values.operation ?? ''), reboot = String(values.reboot ?? ''), schedule = String(values.schedule ?? ''), timezone = String(values.timezone ?? ''), enabled = String(values.enabled ?? ''), role = String(values.role ?? '').trim(), kms = String(values.kms ?? '').trim();
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    const days = Number(values.approval_days), duration = Number(values.duration), cutoff = Number(values.cutoff), concurrency = Number(values.concurrency), errors = Number(values.errors), retention = Number(values.log_retention);
    if (!/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(name)) reject('name', 'Use a letter followed by 2–63 letters, digits, underscores or hyphens.');
    if (!systems.includes(os)) reject('os', 'Choose a supported OS recipe.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(group)) reject('group', 'Use a dedicated literal PatchGroup value without spaces/wildcards.');
    if (!Number.isInteger(days) || days < 0 || days > 100) reject('approval_days', 'Use 0–100 approval-delay days.');
    if (!['Scan', 'Install'].includes(operation)) reject('operation', 'Choose scan or install.');
    if (!['NoReboot', 'RebootIfNeeded'].includes(reboot)) reject('reboot', 'Choose the reboot behavior.');
    if (!schedules.includes(schedule)) reject('schedule', 'Choose a listed maintenance schedule.');
    if (!/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(timezone)) reject('timezone', 'Use an approved IANA time-zone identifier.');
    if (!['YES', 'NO'].includes(enabled)) reject('enabled', 'Choose disabled or enabled recurring operation.');
    if (!Number.isInteger(duration) || duration < 1 || duration > 24) reject('duration', 'Use 1–24 maintenance hours.');
    if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff >= duration) reject('cutoff', 'Use a cutoff from 0 to less than the duration.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) reject('concurrency', 'Use 1–50 concurrent nodes.');
    if (!Number.isInteger(errors) || errors < 1 || errors > 50) reject('errors', 'Use an error threshold of 1–50.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('log_retention', 'Choose a listed log retention.');
    if (!match) reject('role', 'Use an existing same-account maintenance-window role ARN.');
    if (!new RegExp('^arn:' + partition + ':kms:' + region + ':' + account + ':key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing same-account regional symmetric log key ARN.');
    const logGroup = '/aws/ssm/' + name;
    const guide = [
      '# Managed-node security patch workflow',
      '## Prepare\nUse a dedicated unused PatchGroup value for the chosen OS. Run PREFLIGHT.ps1 before first deployment; it rejects an existing association for this group/OS, rather than silently replacing a shared baseline. This is an explicit owner prerequisite; Terraform registration itself can change a group association. Review again if another owner changes it. The recipe never sets an account-wide default baseline, tags/enrolls nodes, installs SSM Agent or changes instance profiles. Prepare supported managed-node OS/agent/runtime versions, authorized EC2/hybrid enrollment, repository access, SSM/private endpoints, DNS, time synchronization and approved package sources. Other OS families and mixed-OS groups need separate baselines.',
      'Existing window service role requires SSM trust, scoped SendCommand/document/tag permissions, invocation-result access and appropriate delivery permissions. Managed-node roles must permit approved log delivery to the new retained/encrypted group. Review KMS policy for the regional CloudWatch Logs service and exact group encryption context. This package does not overwrite role trust, attach AdministratorAccess or change shared key policies. Logs, repository metadata and node identities require approved handling. Do not use this generic patch workflow for EMR cluster nodes; use the EMR-supported update path.',
      '## Deploy and pilot\nRun terraform init, terraform validate and terraform plan -out=service.tfplan; review the security-only Critical/Important approval filters/delay, tag target, log key/retention, role, schedule/timezone, limits and operation. Default Scan, NoReboot and disabled recurring window make the initial deployment non-executing. Selecting Enabled explicitly makes this a scheduled live scan/install after apply. Owner-approved backups/restore, application draining, availability groups, reboot handling and rollback must precede Install. A scan runs code on nodes and records compliance; it is not merely a cloud metadata lookup.',
      'Run OPERATE.ps1 with 1–50 explicit InstanceIds; default behavior previews a request after checking applied account/region/baseline, actual patch-group mapping, exact node membership, Online status and OS. Use -Execute to send one command; Install also requires -ConfirmInstall. This sends only the explicit reviewed IDs, never an expanding tag target for the one-time command. It writes a unique request file, reports acceptance/command ID, and never retries. Preview does not execute a node command. Review scan findings and actual result status before an installation pilot. No automatic resume, uninstall or reboot is performed by the operator.',
      '## Scheduled execution and verification\nAfter successful pilot, enable the recurring window in a separately reviewed plan. The scheduled target is dynamic: every future node tagged PatchGroup=' + group + ' is eligible. Govern tags, do not mix OSes and recheck membership/quotas. Correct baseline selection also depends on avoiding conflicting Patch Group (with a space) tags and Quick Setup/other scan methods. The package uses the exact no-space PatchGroup key consistently. Cutoff stops new task starts; CONTINUE_TASK lets existing work finish and may extend beyond the nominal window. Error/concurrency thresholds do not cancel every already-running command or roll back installed patches.',
      'NoReboot prevents OS-level reboot by Patch Manager, not service restarts or application disruption. RebootIfNeeded can reboot after installed patches or pending-reboot state. Schedule approved restart/failover and rescan when patches are pending reboot. Inspect command invocation statuses/exit codes, logs, patch compliance and application health; success/zero missing patches is not proof of all security controls or application acceptance. Use one coordinated baseline/scan method to avoid compliance overwrites.',
      '## Recovery\nDisable future window execution and verify that running commands have completed before maintenance changes. Disabling a window does not undo patches or stop an already-running command. Recover through tested application/volume/image backups or owner-approved package rollback, preserving forensic/compliance evidence. Do not delete the patch-group association while nodes rely on it, or they may fall back to another/default baseline. Baseline/window have prevent_destroy; logs and cloud state have their own lifecycle. No command, patch, reboot, tag or cloud deployment runs during generation/local tests.',
      'https://docs.aws.amazon.com/systems-manager/latest/userguide/patch-manager-aws-runpatchbaseline.html\nhttps://docs.aws.amazon.com/systems-manager/latest/userguide/patch-manager-patch-groups.html\nhttps://docs.aws.amazon.com/systems-manager/latest/userguide/sysman-patch-scheduletasks.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'window', { name: match?.[2]?.split('/').at(-1) ?? '' }), dat('aws_kms_key', 'logs', { key_id: kms }),
      res('aws_cloudwatch_log_group', 'commands', { name: logGroup, retention_in_days: retention, kms_key_id: kms }),
      res('aws_ssm_patch_baseline', 'configured', { name, operating_system: os, description: 'Reviewed security-only baseline for dedicated patch group', rejected_patches_action: 'BLOCK', tags: x(hcl({ Name: name })) }, [
        blk('approval_rule', { approve_after_days: days, compliance_level: 'HIGH', enable_non_security: false }, [
          blk('patch_filter', { key: 'CLASSIFICATION', values: os === 'WINDOWS' ? ['SecurityUpdates', 'CriticalUpdates'] : ['Security'] }),
          blk('patch_filter', { key: os === 'WINDOWS' ? 'MSRC_SEVERITY' : 'SEVERITY', values: ['Critical', 'Important'] }),
        ]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.window.arn == ' + JSON.stringify(role) + ' && data.aws_kms_key.logs.enabled && data.aws_kms_key.logs.key_spec == "SYMMETRIC_DEFAULT" && data.aws_kms_key.logs.key_usage == "ENCRYPT_DECRYPT"'), error_message: 'Use this account window role and enabled symmetric regional log key.' })]),
      ]),
      res('aws_ssm_patch_group', 'configured', { baseline_id: x('aws_ssm_patch_baseline.configured.id'), patch_group: group }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_ssm_maintenance_window', 'configured', { name, schedule, schedule_timezone: timezone, duration, cutoff, enabled: enabled === 'YES', allow_unassociated_targets: false }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_ssm_maintenance_window_target', 'configured', { window_id: x('aws_ssm_maintenance_window.configured.id'), resource_type: 'INSTANCE', name: name + '-nodes' }, [blk('targets', { key: 'tag:PatchGroup', values: [group] })]),
      res('aws_ssm_maintenance_window_task', 'configured', { window_id: x('aws_ssm_maintenance_window.configured.id'), name: name + '-patch', task_type: 'RUN_COMMAND', task_arn: 'AWS-RunPatchBaseline', service_role_arn: role, priority: 1, max_concurrency: String(concurrency), max_errors: String(errors), cutoff_behavior: 'CONTINUE_TASK', depends_on: x('[aws_ssm_patch_group.configured]') }, [
        blk('targets', { key: 'WindowTargetIds', values: x('[aws_ssm_maintenance_window_target.configured.id]') }),
        blk('task_invocation_parameters', {}, [blk('run_command_parameters', { timeout_seconds: 600, comment: name + ' reviewed patch operation' }, [
          blk('parameter', { name: 'Operation', values: [operation] }), blk('parameter', { name: 'RebootOption', values: [reboot] }),
          blk('cloudwatch_config', { cloudwatch_log_group_name: x('aws_cloudwatch_log_group.commands.name'), cloudwatch_output_enabled: true }),
        ])]),
      ]),
      output('patch_job', '{ account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', baseline = aws_ssm_patch_baseline.configured.id, window = aws_ssm_maintenance_window.configured.id }'),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw "SSM prerequisite request failed." }; return ($raw | ConvertFrom-Json) }',
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne '" + account + "') { throw 'Unexpected patch deployment account.' }",
      "$response = Read-AwsJson @('ssm','describe-patch-groups','--region','" + region + "','--output','json')",
      "$existing = @($response.Mappings | Where-Object { $_.PatchGroup -eq '" + group + "' })",
      'if ($existing.Count -gt 0) { throw "PatchGroup already has a baseline association. Do not replace a shared association; use a new dedicated group or reviewed import/change." }',
      'Write-Host "Initial group/account checks passed. Verify agent enrollment, node tags/OS, role/key policy, repository access and backups separately. No node or baseline changed."',
    ].join('\n') + '\n';
    const operator = patchOperator({ region, account, name, os, group, operation, reboot, logGroup, concurrency, errors, days });
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': preflight, 'OPERATE.ps1': operator } };
  },
}                    ;

function patchOperator(config                                                                                                                                                                                      )         {
  return [
    'param([Parameter(Mandatory=$true)][string[]]$InstanceIds, [switch]$Execute, [switch]$ConfirmInstall)',
    "$ErrorActionPreference = 'Stop'",
    'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw "SSM patch request failed." }; return ($raw | ConvertFrom-Json) }',
    '$ids = @($InstanceIds | Select-Object -Unique)',
    'if ($ids.Count -lt 1 -or $ids.Count -gt 50 -or @($ids | Where-Object { $_ -notmatch "^(i-[a-f0-9]{8}|i-[a-f0-9]{17}|mi-[a-f0-9]{17})$" }).Count -gt 0) { throw "Use 1-50 exact managed-node IDs." }',
    '$raw = terraform output -json patch_job; if ($LASTEXITCODE -ne 0) { throw "Read applied patch package outputs." }; $job = $raw | ConvertFrom-Json',
    "if ($job.account -ne '" + config.account + "' -or $job.region -ne '" + config.region + "') { throw 'Unexpected patch package placement.' }",
    "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne $job.account) { throw 'Unexpected patch operator account.' }",
    "$mapping = Read-AwsJson @('ssm','get-patch-baseline-for-patch-group','--patch-group','" + config.group + "','--operating-system','" + config.os + "','--region',$job.region,'--output','json')",
    'if ($mapping.BaselineId -ne $job.baseline) { throw "Actual patch-group baseline differs from applied package." }',
    "$baseline = Read-AwsJson @('ssm','get-patch-baseline','--baseline-id',$job.baseline,'--region',$job.region,'--output','json')",
    "if ($baseline.BaselineId -ne $job.baseline -or $baseline.Name -ne '" + config.name + "' -or $baseline.OperatingSystem -ne '" + config.os + "') { throw 'Unexpected actual baseline identity.' }",
    '$rules = @($baseline.ApprovalRules.PatchRules)',
    "if ($rules.Count -ne 1 -or $rules[0].ApproveAfterDays -ne " + config.days + " -or $rules[0].ApproveUntilDate -or $rules[0].ComplianceLevel -ne 'HIGH' -or $rules[0].EnableNonSecurity -eq $true) { throw 'Actual baseline approval rule differs.' }",
    '$filters = @($rules[0].PatchFilterGroup.PatchFilters)',
    "$classification = @($filters | Where-Object { $_.Key -eq 'CLASSIFICATION' }); $severity = @($filters | Where-Object { $_.Key -eq '" + (config.os === 'WINDOWS' ? 'MSRC_SEVERITY' : 'SEVERITY') + "' })",
    "if ($filters.Count -ne 2 -or $classification.Count -ne 1 -or $severity.Count -ne 1 -or ((@($classification[0].Values | Sort-Object) -join ',') -ne '" + (config.os === 'WINDOWS' ? 'CriticalUpdates,SecurityUpdates' : 'Security') + "') -or ((@($severity[0].Values | Sort-Object) -join ',') -ne 'Critical,Important')) { throw 'Actual baseline patch filters differ.' }",
    'if (@($baseline.ApprovedPatches | Where-Object { $null -ne $_ }).Count -gt 0 -or @($baseline.RejectedPatches | Where-Object { $null -ne $_ }).Count -gt 0 -or @($baseline.Sources | Where-Object { $null -ne $_ }).Count -gt 0 -or @($baseline.GlobalFilters.PatchFilters | Where-Object { $null -ne $_ }).Count -gt 0) { throw "Unexpected baseline exceptions/repository/global filters; review the changed policy." }',
    "$members = Read-AwsJson @('ssm','describe-instance-information','--filters','Key=tag:PatchGroup,Values=" + config.group + "','--region',$job.region,'--output','json')",
    '$selected = @($members.InstanceInformationList | Where-Object { $ids -contains $_.InstanceId })',
    'if ($selected.Count -ne $ids.Count -or @($selected | Where-Object { $_.PingStatus -ne "Online" }).Count -gt 0) { throw "Every exact selected node must be Online and in the configured PatchGroup." }',
    '$nodeTags = @{}; $ec2Ids = @($ids | Where-Object { $_ -like "i-*" })',
    'if ($ec2Ids.Count -gt 0) {',
    '  $arguments = @("ec2","describe-instances","--instance-ids") + $ec2Ids + @("--region",$job.region,"--output","json")',
    '  $instances = Read-AwsJson $arguments',
    '  foreach ($node in @($instances.Reservations | ForEach-Object { $_.Instances })) { if ($ec2Ids -notcontains $node.InstanceId -or $node.State.Name -ne "running") { throw "Unexpected or nonrunning EC2 node." }; $nodeTags[$node.InstanceId] = @($node.Tags) }',
    '}',
    'foreach ($id in $ids) {',
    '  if ($id -like "mi-*") { $tags = Read-AwsJson @("ssm","list-tags-for-resource","--resource-type","ManagedInstance","--resource-id",$id,"--region",$job.region,"--output","json"); $nodeTags[$id] = @($tags.TagList) }',
    '  if (-not $nodeTags.ContainsKey($id)) { throw "Missing exact node-tag metadata." }',
    '  $patchTag = @($nodeTags[$id] | Where-Object { $_.Key -ceq "PatchGroup" })',
    "  if ($patchTag.Count -ne 1 -or $patchTag[0].Value -cne '" + config.group + "' -or @($nodeTags[$id] | Where-Object { $_.Key -ceq 'Patch Group' }).Count -gt 0) { throw 'Node has missing/changed PatchGroup or conflicting Patch Group tags.' }",
    '}',
    ...(
      config.os === 'WINDOWS' ? ['if (@($selected | Where-Object { $_.PlatformType -ne "Windows" }).Count -gt 0) { throw "Selected node OS differs from Windows baseline." }'] :
      config.os === 'REDHAT_ENTERPRISE_LINUX' ? ['if (@($selected | Where-Object { $_.PlatformType -ne "Linux" -or $_.PlatformName -notlike "*Red Hat*" }).Count -gt 0) { throw "Selected node OS differs from RHEL baseline." }'] :
      ['if (@($selected | Where-Object { $_.PlatformType -ne "Linux" -or $_.PlatformName -notlike "*Amazon Linux*" -or $_.PlatformVersion -notlike "' + (config.os === 'AMAZON_LINUX_2023' ? '2023*' : '2') + '" }).Count -gt 0) { throw "Selected node OS/version differs from Amazon Linux baseline." }']
    ),
    "$request = @{ DocumentName = 'AWS-RunPatchBaseline'; InstanceIds = $ids; Parameters = @{ Operation = @('" + config.operation + "'); RebootOption = @('" + config.reboot + "'); 'Snapshot-ID' = @([guid]::NewGuid().ToString()) }; MaxConcurrency = '" + config.concurrency + "'; MaxErrors = '" + config.errors + "'; CloudWatchOutputConfig = @{ CloudWatchOutputEnabled = $true; CloudWatchLogGroupName = '" + config.logGroup + "' } }",
    'if (-not $Execute) { $request | ConvertTo-Json -Depth 8; Write-Host "Preview only; no node command sent."; return }',
    ...(config.operation === 'Install' ? ['if (-not $ConfirmInstall) { throw "Install requires -ConfirmInstall after backup, application draining and reboot/rollback review." }'] : []),
    '$file = "patch-request-" + [guid]::NewGuid().ToString() + ".json"',
    '$request | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding ASCII',
    '$previousAttempts = $env:AWS_MAX_ATTEMPTS',
    'try { $env:AWS_MAX_ATTEMPTS = "1"; $response = Read-AwsJson @("ssm","send-command","--cli-input-json",("file://" + $file),"--region",$job.region,"--output","json") } finally { $env:AWS_MAX_ATTEMPTS = $previousAttempts }',
    'if (-not $response.Command.CommandId) { throw "Command acceptance response missing ID. Inspect command history; do not automatically retry." }',
    'Write-Host ("Command accepted: " + $response.Command.CommandId + ". Inspect command invocations, compliance/logs and application health; this is not final success.")',
  ].join('\n') + '\n';
}

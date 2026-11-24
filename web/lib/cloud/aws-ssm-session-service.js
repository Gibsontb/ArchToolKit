import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
export const AWS_SSM_SESSION_SERVICE = {
  id: 'aws_service_ssm_session', label: 'Set up controlled, audited node sessions',
  description: 'Custom standard-shell Session document, exact managed-node access on a dedicated operator role, own-session controls, KMS session encryption and retained streaming logs. No SSH/port-forwarding recipe.',
  emits: ['aws_ssm_document', 'aws_iam_role_policy', 'aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Custom session document name', control: 'text', hint: 'New project-specific name; never replaces the account default preferences document.' },
    { id: 'os', label: 'Managed-node OS family', control: 'select', default: 'Linux', options: [{ value: 'Linux', label: 'Linux — existing approved Run As account' }, { value: 'Windows', label: 'Windows — review administrative session privileges' }] },
    { id: 'user', label: 'Existing Linux Run As account', control: 'text', default: 'session-ops', showWhen: { input: 'os', equals: ['Linux'] }, hint: 'Non-root account with approved POSIX/sudo privileges. IAM role/session SSMSessionRunAs tags must not override this identity.' },
    { id: 'nodes', label: 'Exact existing managed-node IDs', control: 'text', hint: 'Comma-separated EC2 i- or hybrid mi- IDs, 1–50. SSM enrollment, compatible agent and private service connectivity are prerequisites.' },
    { id: 'operator', label: 'Existing dedicated operator role ARN', control: 'text', hint: 'Adds explicit session denies outside this node/document scope and own-session rules; affects all users of this role. Review federation/trust/session-tag controls.' },
    { id: 'node_roles', label: 'Existing managed-node IAM roles', control: 'text', hint: 'Comma-separated same-account instance-profile/hybrid role ARNs, 1–10. Adds exact log/key permissions; does not replace agent core permissions or role trust.' },
    { id: 'session_kms', label: 'Existing session-data KMS key ARN', control: 'text' },
    { id: 'log_kms', label: 'Existing CloudWatch log KMS key ARN', control: 'text', hint: 'Regional Logs service/key encryption-context policy must permit this new group.' },
    { id: 'idle', label: 'Idle timeout (minutes)', control: 'number', default: 15 },
    { id: 'maximum', label: 'Maximum session duration (minutes)', control: 'number', default: 60 },
    { id: 'retention', label: 'Session log retention (days)', control: 'select', default: '90', options: ['7', '14', '30', '60', '90', '180', '365'].map(value => ({ value, label: value })) },
  ],
  build(values)                                      {
    const findings            = [], reject = (path        , message        ) => findings.push(error('aws.ssm.session.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), os = String(values.os ?? ''), user = os === 'Linux' ? String(values.user ?? '').trim() : '', operator = String(values.operator ?? '').trim(), sessionKms = String(values.session_kms ?? '').trim(), logKms = String(values.log_kms ?? '').trim();
    const rolePattern = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$'), match = rolePattern.exec(operator), account = match?.[1] ?? '';
    const list = (field        ) => [...new Set(String(values[field] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const nodes = list('nodes'), nodeRoles = list('node_roles'), idle = Number(values.idle), maximum = Number(values.maximum), retention = Number(values.retention);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{2,63}$/.test(name) || /^(AWS|Amazon|SSM)[-_.]/i.test(name)) reject('name', 'Use a new project-specific document name (3–64 characters) outside AWS/Amazon/SSM reserved prefixes.');
    if (!['Linux', 'Windows'].includes(os)) reject('os', 'Choose Linux or Windows.');
    if (os === 'Linux' && (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || ['root', 'ssm-user'].includes(user))) reject('user', 'Use a dedicated existing non-root account, not the default privileged ssm-user.');
    if (!nodes.length || nodes.length > 50 || nodes.some(id => !/^(?:i-(?:[a-f0-9]{8}|[a-f0-9]{17})|mi-[a-f0-9]{17})$/.test(id))) reject('nodes', 'Use 1–50 exact existing EC2/hybrid managed-node IDs.');
    if (!match) reject('operator', 'Use an existing same-account dedicated operator role.');
    if (!nodeRoles.length || nodeRoles.length > 10 || nodeRoles.some(arn => rolePattern.exec(arn)?.[1] !== account || arn === operator)) reject('node_roles', 'Use 1–10 same-account managed-node roles, distinct from the dedicated operator role.');
    for (const [field, arn] of [['session_kms', sessionKms], ['log_kms', logKms]]) if (!new RegExp('^arn:' + partition + ':kms:' + region + ':' + account + ':key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(arn )) reject(field , 'Use an existing same-account regional symmetric key ARN.');
    if (!Number.isInteger(idle) || idle < 1 || idle > 60) reject('idle', 'Use 1–60 idle minutes.');
    if (!Number.isInteger(maximum) || maximum < idle || maximum > 1440) reject('maximum', 'Use a maximum from the idle timeout through 1440 minutes.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Choose a listed log retention.');
    const logGroup = '/aws/ssm/session/' + name;
    const document = { schemaVersion: '1.0', description: 'Project-scoped audited standard shell sessions', sessionType: 'Standard_Stream', inputs: {
      s3BucketName: '', s3KeyPrefix: '', s3EncryptionEnabled: true, cloudWatchLogGroupName: logGroup, cloudWatchEncryptionEnabled: true, cloudWatchStreamingEnabled: true, kmsKeyId: sessionKms,
      runAsEnabled: os === 'Linux', runAsDefaultUser: user, idleSessionTimeout: String(idle), maxSessionDuration: String(maximum), shellProfile: { windows: '', linux: '' },
    } };
    const nodeArns = nodes.map(id => 'arn:' + partition + ':' + (id.startsWith('mi-') ? 'ssm:' : 'ec2:') + region + ':' + account + ':' + (id.startsWith('mi-') ? 'managed-instance/' : 'instance/') + id);
    const sessionArn = 'arn:' + partition + ':ssm:' + region + ':' + account + ':session/*', own = '$' + '{aws:userid}', ownerTag = 'ssm:resourceTag/aws:ssmmessages:session-id', targetTag = 'ssm:resourceTag/aws:ssmmessages:target-id';
    const sessionActions = ['ssm:ResumeSession', 'ssm:TerminateSession', 'ssmmessages:OpenDataChannel'];
    const guide = [
      '# Controlled Session Manager standard-shell access',
      '## Prepare identities and nodes\nThis creates a new custom Session document, not the regional SSM-SessionManagerRunShell default. Use a dedicated operator role: explicit denies limit StartSession to the selected node/document resources and restrict channel/resume/terminate to owned sessions on selected targets. These denies affect every use of the role; review policy boundaries, trust, federation, unique role-session names, CloudTrail and break-glass design. Core SSM Agent enrollment/permissions remain external. Node-role list must correspond to actual EC2 profiles/hybrid service roles; the metadata helper does not prove this association automatically.',
      'Linux requires the configured existing non-root Run As user and approved POSIX/sudo restrictions. Role/session SSMSessionRunAs tags take precedence over document defaults: the Terraform check rejects a conflicting operator-role tag, but the IAM owner must also prevent unapproved overriding session tags in trust/federation. This is not a guarantee of nonprivileged access if node sudo rights or external identity policies are broader. Windows Run As is not supported; review actual ssm-user/local administrator privileges explicitly. No local account, password, sudo rule, SSH key, inbound SSH rule or node profile is changed here.',
      '## Prepare encrypted audit\nReview both existing enabled symmetric key policies: operator GenerateDataKey and node Decrypt for session transport; regional CloudWatch Logs encryption-context permissions for the retained streaming group. The package adds scoped node log/key permissions but not full agent enrollment permissions. Confirm approved SSM/ssmmessages/Logs/KMS connectivity, compatible agent/plugin versions, system clock and required node logging utilities. Session transcripts and identities can contain classified/regulated content; approve storage boundary, access, retention and audit ingestion before connecting. Streaming logs are not a claim of complete forensic capture; perform log-loss and client-disconnect tests.',
      '## Deploy\nRun terraform init, terraform validate and terraform plan -out=service.tfplan; review exact nodes, dedicated role effects, node roles, custom document, Run As, duration/idle limits and retained log key, then apply the approved plan. After a document update, inspect/promote the reviewed default document version through the deployment owner before connection; CONNECT.ps1 checks the actual $DEFAULT content and fails if it differs. Test both explicit and omitted document-name requests against effective IAM policies. The document has prevent_destroy; existing role trust and account default preferences are untouched. IAM own-session controls use AWS-supplied session resource tags and aws:userid, not an incorrect assumed-role ARN prefix. Node-role inline policy resources are additive; preserve and review their effective policies.',
      '## Inspect and connect explicitly\nInstall the official Session Manager CLI plugin on the client through the approved software process. Run CONNECT.ps1 -Target <selected-id> -Reason <approved-ticket-id> to inspect account, applied custom document/inputs and exact Online node OS without opening a session. Add -Connect to launch an interactive standard-shell session using the explicit custom document. This is an administrative connection and may expose data; it is never run during generation/local tests. The helper does not ask for AWS credentials or print a session token. Do not supply document overrides/port-forwarding/SSH paths; only the exact custom standard-stream document is allowed by the dedicated policy.',
      '## Verify and recover\nUse an approved pilot to confirm correct login identity, command rights, idle/max duration, encrypted transcript streaming and independent CloudTrail identity/StartSession evidence. Prove denial for unlisted nodes, another document/region, another caller session and conflicting Run As tags. Log availability and exact caller/session-tag behavior require live IAM/agent/plugin testing; local schemas/mocks cannot establish those guarantees. End a session and verify actual termination; removing permission does not prove an established channel has ended. Revoke through approved session termination/identity controls, preserve audit evidence and retain a reviewed recovery path. No session, command, IAM change or deployment runs during local generation/validation.',
      'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-schema.html\nhttps://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-restrict-access-examples.html\nhttps://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-create-iam-instance-profile.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'operator', { name: match?.[2]?.split('/').at(-1) ?? '' }),
      dat('aws_iam_role', 'nodes', { for_each: x('toset(' + JSON.stringify(nodeRoles) + ')'), name: x('element(reverse(split("/", each.value)), 0)') }),
      dat('aws_kms_key', 'session', { key_id: sessionKms }), dat('aws_kms_key', 'logs', { key_id: logKms }),
      res('aws_cloudwatch_log_group', 'session', { name: logGroup, retention_in_days: retention, kms_key_id: logKms }),
      res('aws_ssm_document', 'session', { name, document_type: 'Session', document_format: 'JSON', content: x(jsonencode(document)), tags: x(hcl({ Name: name })), depends_on: x('[aws_cloudwatch_log_group.session]') }, [
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.operator.arn == ' + JSON.stringify(operator) + ' && alltrue([for arn, role in data.aws_iam_role.nodes : arn == role.arn]) && alltrue([for key in [data.aws_kms_key.session, data.aws_kms_key.logs] : key.enabled && key.key_spec == "SYMMETRIC_DEFAULT" && key.key_usage == "ENCRYPT_DECRYPT"])' + (os === 'Linux' ? ' && try(data.aws_iam_role.operator.tags["SSMSessionRunAs"], ' + JSON.stringify(user) + ') == ' + JSON.stringify(user) : '')), error_message: 'Use this account roles, enabled symmetric regional keys and no conflicting operator-role Run As tag.' })]),
      ]),
      res('aws_iam_role_policy', 'operator', { name: name + '-session-access', role: x('data.aws_iam_role.operator.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['ssm:StartSession'], Resource: [...nodeArns, e('aws_ssm_document.session.arn')], Condition: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': true } } },
        { Effect: 'Deny', Action: ['ssm:StartSession'], NotResource: [...nodeArns, e('aws_ssm_document.session.arn')] },
        { Effect: 'Allow', Action: ['ssm:GetDocument'], Resource: e('aws_ssm_document.session.arn') },
        { Effect: 'Allow', Action: ['ssm:DescribeInstanceInformation'], Resource: '*', Condition: { StringEquals: { 'aws:RequestedRegion': region } } },
        { Effect: 'Allow', Action: sessionActions, Resource: sessionArn, Condition: { StringEquals: { [ownerTag]: own, [targetTag]: nodes } } },
        { Effect: 'Deny', Action: sessionActions, NotResource: sessionArn },
        { Effect: 'Deny', Action: sessionActions, Resource: sessionArn, Condition: { StringNotEquals: { [ownerTag]: own } } },
        { Effect: 'Deny', Action: sessionActions, Resource: sessionArn, Condition: { StringNotEquals: { [targetTag]: nodes } } },
        { Effect: 'Allow', Action: ['kms:GenerateDataKey'], Resource: sessionKms },
      ] })) }),
      res('aws_iam_role_policy', 'nodes', { for_each: x('data.aws_iam_role.nodes'), name: name + '-session-audit', role: x('each.value.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['kms:Decrypt'], Resource: sessionKms },
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'], Resource: e('format("%s:*", aws_cloudwatch_log_group.session.arn)') },
        { Effect: 'Allow', Action: ['logs:DescribeLogGroups'], Resource: '*' },
      ] })) }),
      output('session_job', '{ account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', document = aws_ssm_document.session.name, operator_arn = data.aws_iam_role.operator.arn, operator_id = data.aws_iam_role.operator.unique_id }'),
    ], guide, findings);
    const connect = [
      'param([Parameter(Mandatory=$true)][string]$Target, [Parameter(Mandatory=$true)][ValidatePattern("^[A-Za-z0-9._:-]{1,64}$")][string]$Reason, [switch]$Connect)',
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw "Session metadata request failed." }; return ($raw | ConvertFrom-Json) }',
      '$allowed = @(' + nodes.map(id => "'" + id + "'").join(',') + '); if ($allowed -notcontains $Target) { throw "Target is outside this package." }',
      '$raw = terraform output -json session_job; if ($LASTEXITCODE -ne 0) { throw "Read applied session package outputs." }; $job = $raw | ConvertFrom-Json',
      "if ($job.account -ne '" + account + "' -or $job.region -ne '" + region + "' -or $job.document -ne '" + name + "') { throw 'Unexpected session package placement/document.' }",
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne $job.account) { throw 'Unexpected session account.' }",
      "if ($job.operator_arn -ne '" + operator + "' -or -not $job.operator_id -or -not ([string]$identity.UserId).StartsWith($job.operator_id + ':')) { throw 'Use the exact applied dedicated operator role through the approved federation/assume-role path.' }",
      "$response = Read-AwsJson @('ssm','get-document','--name',$job.document,'--document-version','$DEFAULT','--document-format','JSON','--region',$job.region,'--output','json')",
      '$document = $response.Content | ConvertFrom-Json; $settings = $document.inputs',
      "if ($response.Name -ne $job.document -or $document.schemaVersion -ne '1.0' -or $document.sessionType -ne 'Standard_Stream' -or $settings.cloudWatchLogGroupName -ne '" + logGroup + "' -or $settings.cloudWatchEncryptionEnabled -ne $true -or $settings.cloudWatchStreamingEnabled -ne $true -or $settings.kmsKeyId -ne '" + sessionKms + "' -or $settings.idleSessionTimeout -ne '" + idle + "' -or $settings.maxSessionDuration -ne '" + maximum + "') { throw 'Actual session audit/encryption/duration settings differ.' }",
      "if ($settings.runAsEnabled -ne " + (os === 'Linux' ? '$true' : '$false') + " -or $settings.runAsDefaultUser -ne '" + user + "' -or $settings.shellProfile.linux -or $settings.shellProfile.windows -or $settings.s3BucketName -or $document.parameters) { throw 'Actual session identity/profile/parameters differ.' }",
      '$nodes = Read-AwsJson @("ssm","describe-instance-information","--filters",("Key=InstanceIds,Values=" + $Target),"--region",$job.region,"--output","json"); $selected = @($nodes.InstanceInformationList)',
      "if ($selected.Count -ne 1 -or $selected[0].InstanceId -ne $Target -or $selected[0].PingStatus -ne 'Online' -or $selected[0].PlatformType -ne '" + os + "') { throw 'Require the exact Online managed node and selected OS.' }",
      'if (-not $Connect) { Write-Host "Session prerequisites inspected; no connection opened. Verify actual node-role association, Run As tags/privileges, plugin and audit delivery before connecting."; return }',
      '$arguments = @("ssm","start-session","--target",$Target,"--document-name",$job.document,"--reason",$Reason,"--region",$job.region)',
      '$previousAttempts = $env:AWS_MAX_ATTEMPTS',
      'try { $env:AWS_MAX_ATTEMPTS = "1"; aws @arguments; $clientExit = $LASTEXITCODE } finally { $env:AWS_MAX_ATTEMPTS = $previousAttempts }',
      'if ($clientExit -ne 0) { throw "Interactive session client failed. Inspect session history; do not automatically retry." }',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'SESSION-DOCUMENT.json': JSON.stringify(document, null, 2) + '\n', 'CONNECT.ps1': connect } };
  },
}                    ;

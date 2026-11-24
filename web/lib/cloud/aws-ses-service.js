import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_SES_SERVICE = {
  id: 'aws_service_ses_sending', label: 'Set up SES sending policy and delivery monitoring',
  description: 'Configure a verified sender integration, TLS-required configuration set, scoped sending role, bounce/complaint metrics and alarms.',
  emits: ['aws_sesv2_configuration_set', 'aws_sesv2_configuration_set_event_destination', 'aws_iam_role_policy', 'aws_cloudwatch_metric_alarm'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Sending configuration set name', control: 'text' },
    { id: 'sender', label: 'Approved From email address', control: 'text' },
    { id: 'identity', label: 'Existing verified SES identity', control: 'text', hint: 'Verified domain or exact sender email in this region. Leave blank to use the sender email as the identity.' },
    { id: 'role', label: 'Existing application sender role ARN', control: 'text', hint: 'Adds a scoped sending policy to this existing role. The application uses its approved credential chain.' },
    { id: 'bounce', label: 'Hard bounces per 5 minutes to alarm', control: 'number', default: 5 },
    { id: 'complaint', label: 'Complaints per 5 minutes to alarm', control: 'number', default: 1 },
    { id: 'topic', label: 'Existing alarm notification SNS topic ARN', control: 'text', hint: 'Optional regional topic in this account. Its policy, encryption key and confirmed subscriptions must support CloudWatch alarm publishing.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.ses.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), sender = String(values.sender ?? '').trim(), identity = String(values.identity ?? '').trim() || sender, role = String(values.role ?? '').trim(), topic = String(values.topic ?? '').trim();
    const domain = (value        ) => value.length <= 253 && value.includes('.') && value.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
    const email = (value        ) => { const parsed = /^([A-Za-z0-9._%+-]{1,64})@(.+)$/.exec(value); return value.length <= 254 && !!parsed && !parsed[1] .startsWith('.') && !parsed[1] .endsWith('.') && !parsed[1] .includes('..') && domain(parsed[2] ?? ''); };
    if (!/^[A-Za-z0-9_-]{1,56}$/.test(name)) reject('name', 'Use 1–56 letters, numbers, underscores or hyphens, leaving room for the event destination suffix.');
    if (!email(sender)) reject('sender', 'Enter an approved sender email address without a display-name prefix.');
    if (identity.includes('@') ? identity !== sender || !email(identity) : !domain(identity) || !(sender.toLowerCase().endsWith('@' + identity.toLowerCase()) || sender.toLowerCase().endsWith('.' + identity.toLowerCase()))) reject('identity', 'Use the exact verified sender email or its verified parent domain in this region.');
    const parsedRole = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(role);
    if (!parsedRole || parsedRole[1] !== partition) reject('role', 'Enter an existing application sender IAM role in the selected partition.');
    const parsedTopic = /^arn:([^:]+):sns:([^:]+):(\d{12}):[A-Za-z0-9_-]+$/.exec(topic);
    if (topic && (!parsedTopic || parsedTopic[1] !== partition || parsedTopic[2] !== region || parsedTopic[3] !== parsedRole?.[2])) reject('topic', 'Use a standard SNS topic ARN in the sender role account and selected region.');
    const bounce = Number(values.bounce), complaint = Number(values.complaint);
    for (const [path, threshold] of [['bounce', bounce], ['complaint', complaint]]         ) if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1000000) reject(path, 'Use a whole event count from 1 to 1,000,000; this is not a percentage.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_sesv2_configuration_set', 'configured', { configuration_set_name: name }, [blk('delivery_options', { tls_policy: 'REQUIRE' }), blk('suppression_options', { suppressed_reasons: ['BOUNCE', 'COMPLAINT'] }), blk('sending_options', { sending_enabled: true }), blk('reputation_options', { reputation_metrics_enabled: true })]),
      res('aws_sesv2_configuration_set_event_destination', 'metrics', { configuration_set_name: x('aws_sesv2_configuration_set.configured.configuration_set_name'), event_destination_name: name + '-metrics' }, [blk('event_destination', { enabled: true, matching_event_types: ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT'] }, [blk('cloud_watch_destination', {}, [blk('dimension_configuration', { dimension_name: 'ses:configuration-set', dimension_value_source: 'MESSAGE_TAG', default_dimension_value: name })])])]),
      res('aws_iam_role_policy', 'sender', { name: name + '-sender', role: parsedRole?.[3]?.split('/').at(-1) ?? '', policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: [e('"arn:' + partition + ':ses:' + region + ':${data.aws_caller_identity.current.account_id}:identity/' + identity + '"'), e('aws_sesv2_configuration_set.configured.arn')], Condition: { StringEquals: { 'ses:FromAddress': sender } } }] })) }, [blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedRole?.[2] ?? '')), error_message: 'The sender role must belong to this deployment account.' })])]),
      ...([['Bounce', bounce], ['Complaint', complaint]]         ).map(([metric, threshold]) => res('aws_cloudwatch_metric_alarm', metric.toLowerCase(), { alarm_name: name + '-' + metric.toLowerCase(), namespace: 'AWS/SES', metric_name: metric, dimensions: x(hcl({ 'ses:configuration-set': name })), comparison_operator: 'GreaterThanOrEqualToThreshold', threshold, evaluation_periods: 1, period: 300, statistic: 'Sum', treat_missing_data: 'notBreaching', ...(topic ? { alarm_actions: [topic] } : {}) })),
      output('configuration_set_name', 'aws_sesv2_configuration_set.configured.configuration_set_name'),
    ], `# SES sender integration and delivery monitoring

## Prepare
Run PREFLIGHT.ps1 as an authorized setup operator. The selected identity must already be verified for sending in this region, with domain/email ownership, DKIM, SPF/MAIL FROM and DMARC reviewed through the identity owner. This workflow does not register a domain or change DNS. Check sandbox/production access, sending quotas, approved recipients, privacy and message retention. Existing sender-role trust and workload identity must be configured. Review any broader existing sending policies because IAM grants are additive. SNS alarm delivery, when selected, requires topic/key permission and confirmed recipients; this package preserves those existing resources.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review sender identity, role scope, required transport TLS, suppression settings, metric costs and count thresholds; apply the saved reviewed plan. Configure the application to pass ConfigurationSetName=${name} in SES v2 SendEmail requests or the corresponding configuration-set header for supported SMTP/raw-mail clients. No identity default is changed. Calls that omit the configuration set do not automatically use these monitoring/suppression settings; this IAM grant alone does not enforce configuration-set selection. Use the configured role credential chain and avoid static credentials.

## Verify
Review SEND-EXAMPLE.ps1, then run it explicitly with -To <approved-test-recipient> under the sender role when a test message is authorized. It sends one message only when you execute it; Terraform does not send a test. In the SES sandbox the recipient must also be verified, except supported SES simulator addresses. Verify receipt, TLS, authentication headers and suppression behavior. Use the SES mailbox simulator with approved test procedures for bounce/complaint events and confirm per-configuration-set metrics and alarm transitions. Hard-bounce and complaint thresholds here are counts over five minutes, not account reputation rates. If no SNS topic was entered, alarms record state without notification actions. CloudWatch event metrics and alarms incur applicable charges.

## Recovery
Pause the application sender or disable sending on this configuration set through a reviewed change, investigate bounce/complaint causes and preserve required evidence. Pausing a configuration set does not stop clients that omit it or use another set. Restore prior reviewed settings and application configuration; do not indiscriminately remove suppression entries. Removing the role's inline policy affects consumers relying on it. Removing this configuration set requires migrating clients first; sent email cannot be recalled by deleting infrastructure. Dedicated IPs, receiving rules, identity/DNS creation, custom MAIL FROM, templates and reputation/delivery programs require separate workflows.

https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-cloudwatch.html
`, findings);
    return { ...result, files: { ...result.files,
      'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
$identityJson = aws sesv2 get-email-identity --email-identity '${identity}' --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the existing regional SES identity.' }
if (-not ($identityJson | ConvertFrom-Json).VerifiedForSendingStatus) { throw 'Verify the regional sending identity before proceeding.' }
$accountJson = aws sesv2 get-account --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read SES account sending status.' }
$accountDetails = $accountJson | ConvertFrom-Json
if (-not $accountDetails.SendingEnabled) { throw 'SES sending is disabled for this account.' }
if (-not $accountDetails.ProductionAccessEnabled) { Write-Host 'SES sandbox: test recipients must also be verified, except supported simulator addresses.' }
Write-Host 'Identity/account checked. Review domain authentication, quotas, role trust, approved recipients and configuration-set use.'
`,
      'SEND-EXAMPLE.ps1': `param([Parameter(Mandatory=$true)][ValidatePattern('^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$')][string]$To)
$ErrorActionPreference = 'Stop'
$requestFile = [System.IO.Path]::GetTempFileName()
try {
  $sendRequest = @{ FromEmailAddress = '${sender}'; Destination = @{ ToAddresses = @($To) }; ConfigurationSetName = '${name}'; Content = @{ Simple = @{ Subject = @{ Data = 'SES setup verification'; Charset = 'UTF-8' }; Body = @{ Text = @{ Data = 'Authorized operator setup test using the configured SES sending policy and monitoring.'; Charset = 'UTF-8' } } } } }
  [System.IO.File]::WriteAllText($requestFile, ($sendRequest | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))
  aws sesv2 send-email --cli-input-json ('file://' + $requestFile) --region '${region}'
  if ($LASTEXITCODE -ne 0) { throw 'SES test send failed. Check role, regional identity, sandbox, suppression and configuration set.' }
} finally { Remove-Item -LiteralPath $requestFile -Force }
`,
    } };
  },
}                    ;

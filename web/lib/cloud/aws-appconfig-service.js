import { bool } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

const strategies = ['AppConfig.Canary10Percent20Minutes', 'AppConfig.Linear20PercentEvery6Minutes', 'AppConfig.AllAtOnce', 'AppConfig.Linear50PercentEvery30Seconds'];
export const AWS_APPCONFIG_SERVICE = {
  id: 'aws_service_appconfig', label: 'Set up hosted application configuration and rollout',
  description: 'Create an application, environment, hosted JSON configuration and optional rollout with an existing health alarm.',
  emits: ['aws_appconfig_application', 'aws_appconfig_environment', 'aws_appconfig_configuration_profile', 'aws_appconfig_hosted_configuration_version', 'aws_appconfig_deployment', 'aws_iam_role', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Application name', control: 'text' },
    { id: 'environment', label: 'Environment name', control: 'text', default: 'production' },
    { id: 'profile', label: 'Configuration profile name', control: 'text', default: 'application-settings' },
    { id: 'content', label: 'Non-secret configuration (JSON)', control: 'textarea', default: '{\n  "logLevel": "info"\n}', hint: 'Configuration content is included in the generated package. Keep credentials in the approved secret store.' },
    { id: 'schema', label: 'JSON Schema validator', control: 'textarea', hint: 'Optional JSON Schema object compatible with AppConfig JSON_SCHEMA validation.' },
    { id: 'deploy', label: 'Include configuration deployment', control: 'toggle', default: true },
    { id: 'strategy', label: 'Rollout strategy', control: 'select', default: 'AppConfig.Canary10Percent20Minutes', options: strategies.map(value => ({ value, label: value.replace('AppConfig.', '') })), showWhen: { input: 'deploy', equals: ['true'] } },
    { id: 'alarm', label: 'Existing rollout health alarm ARN', control: 'text', hint: 'Optional CloudWatch alarm in this account and region. A monitoring role is created when supplied.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.appconfig.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), partition = awsServicePartition(location), name = String(values.name ?? ''), environment = String(values.environment ?? ''), profile = String(values.profile ?? ''), content = String(values.content ?? ''), schema = String(values.schema ?? '').trim(), alarm = String(values.alarm ?? '').trim(), strategy = String(values.strategy ?? '');
    for (const [key, value] of [['name', name], ['environment', environment], ['profile', profile]]         ) if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) reject(key, 'Use 1–64 letters, numbers, hyphens or underscores, beginning with a letter or number.');
    try { JSON.parse(content); } catch { reject('content', 'Enter valid JSON configuration.'); }
    if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) reject('content', 'Keep the hosted configuration within this form’s 2 MiB limit and confirm account quotas.');
    if (schema) { try { const parsed = JSON.parse(schema); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); } catch { reject('schema', 'Enter a JSON Schema object.'); } }
    if (bool(values, 'deploy') && !strategies.includes(strategy)) reject('strategy', 'Select a predefined deployment strategy.');
    if (alarm && !new RegExp('^arn:' + partition + ':cloudwatch:' + location + ':\\d{12}:alarm:.+$').test(alarm)) reject('alarm', 'Use a CloudWatch alarm ARN in the selected region and partition.');
    const result = awsServiceModule(location, [
      res('aws_appconfig_application', 'configured', { name }),
      ...(alarm ? [
        dat('aws_caller_identity', 'current', {}),
        res('aws_iam_role', 'monitor', { name_prefix: 'appconfig-monitor-', assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'appconfig.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }),
        res('aws_iam_role_policy', 'monitor', { role: x('aws_iam_role.monitor.id'), policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'cloudwatch:DescribeAlarms', Resource: '*' }] }) }),
      ] : []),
      res('aws_appconfig_environment', 'configured', { application_id: x('aws_appconfig_application.configured.id'), name: environment, ...(alarm ? { depends_on: x('[aws_iam_role_policy.monitor]') } : {}) }, alarm ? [blk('monitor', { alarm_arn: alarm, alarm_role_arn: x('aws_iam_role.monitor.arn') }), blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(alarm.split(':')[4] ?? '')), error_message: 'Use a rollout alarm in the deployment account.' })])] : []),
      res('aws_appconfig_configuration_profile', 'configured', { application_id: x('aws_appconfig_application.configured.id'), name: profile, location_uri: 'hosted', type: 'AWS.Freeform' }, schema ? [blk('validator', { type: 'JSON_SCHEMA', content: schema })] : []),
      res('aws_appconfig_hosted_configuration_version', 'configured', { application_id: x('aws_appconfig_application.configured.id'), configuration_profile_id: x('aws_appconfig_configuration_profile.configured.configuration_profile_id'), content_type: 'application/json', content }),
      ...(bool(values, 'deploy') ? [res('aws_appconfig_deployment', 'configured', { application_id: x('aws_appconfig_application.configured.id'), environment_id: x('aws_appconfig_environment.configured.environment_id'), configuration_profile_id: x('aws_appconfig_configuration_profile.configured.configuration_profile_id'), configuration_version: x('aws_appconfig_hosted_configuration_version.configured.version_number'), deployment_strategy_id: strategy })] : []),
      output('application_id', 'aws_appconfig_application.configured.id'), output('environment_id', 'aws_appconfig_environment.configured.environment_id'), output('configuration_profile_id', 'aws_appconfig_configuration_profile.configured.configuration_profile_id'),
    ], `# Hosted AppConfig JSON configuration

## Prepare
Confirm the application's configuration contract, validation schema, regional support and client integration. Hosted JSON is exported as configuration content; supply no secret values. Prepare a meaningful healthy CloudWatch alarm for automatic rollback and review the generated monitor role. Without an alarm, selecting a gradual strategy does not provide application-health rollback. AllAtOnce and the short linear strategy need their own rollout-risk review.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review application/environment ownership, hosted content, validator, alarm and deployment strategy. Apply the saved plan. When deployment is included, applying publishes the new version to the selected environment through the chosen strategy. With deployment disabled, only the hosted version is created. A schema must validate the actual configuration before AppConfig can deploy it.

## Verify
Monitor deployment state, configured alarm and application metrics through rollout and bake time. Use the exported CLIENT-EXAMPLE.ps1 with an authorized AWS CLI identity to retrieve the deployed configuration once. Production clients should use AppConfig Agent or a correct AppConfig Data polling implementation that honors tokens and polling intervals. Test configuration parsing, refresh behavior and rollback with a controlled faulty test configuration.

## Recovery
Stop an active faulty deployment or deploy the preceding validated configuration version through the approved process. Automatic alarm rollback requires the alarm and monitoring role to work. Changing a hosted version in Terraform does not automatically revert an application's external side effects. Keep prior configuration versions and preserve required rollout evidence. Feature-flag profiles, custom deployment strategies, external configuration sources and extension actions use their corresponding existing builders.

https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-creating-deployment-strategy-predefined.html
`, findings);
    return { ...result, files: { ...result.files, 'CLIENT-EXAMPLE.ps1': `param([string]$Region = '${location}')
$ErrorActionPreference = 'Stop'
$applicationId = terraform output -raw application_id
if ($LASTEXITCODE -ne 0) { throw 'Read application_id from the applied Terraform state first.' }
$environmentId = terraform output -raw environment_id
if ($LASTEXITCODE -ne 0) { throw 'Could not read environment_id.' }
$configurationProfileId = terraform output -raw configuration_profile_id
if ($LASTEXITCODE -ne 0) { throw 'Could not read configuration_profile_id.' }
$response = aws appconfigdata start-configuration-session --application-identifier $applicationId --environment-identifier $environmentId --configuration-profile-identifier $configurationProfileId --region $Region
if ($LASTEXITCODE -ne 0) { throw 'Configuration session failed.' }
$session = $response | ConvertFrom-Json
aws appconfigdata get-latest-configuration --configuration-token $session.InitialConfigurationToken --region $Region configuration.json
if ($LASTEXITCODE -ne 0) { throw 'Configuration retrieval failed.' }
` } };
  },
}                    ;

import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, hcl, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_MQ_SERVICE = {
  id: 'aws_service_mq_rabbitmq', label: 'Set up a private RabbitMQ broker',
  description: 'Amazon MQ RabbitMQ single-node or three-AZ cluster with existing private networks, separate application/admin access and a deployment-time sensitive bootstrap password.',
  emits: ['aws_mq_broker', 'aws_security_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Broker name', control: 'text' },
    { id: 'version', label: 'RabbitMQ engine version', control: 'text', hint: 'Required currently supported version from the regional Amazon MQ broker-engine API. Run the exported preflight before plan.' },
    { id: 'instance', label: 'Broker instance type', control: 'combo', default: 'mq.m7g.large', options: ['mq.m7g.large', 'mq.m7g.xlarge', 'mq.m7g.2xlarge', 'mq.m5.large', 'mq.m5.xlarge'].map(value => ({ value, label: value })), hint: 'Confirm the selected engine/version, region and deployment mode support this type; the preflight checks offerings.' },
    { id: 'mode', label: 'Broker availability', control: 'select', default: 'CLUSTER_MULTI_AZ', options: [{ value: 'SINGLE_INSTANCE', label: 'Single broker node — one private subnet' }, { value: 'CLUSTER_MULTI_AZ', label: 'Three-node cluster — three subnets in different AZs' }] },
    { id: 'subnets', label: 'Existing private broker subnet IDs', control: 'text', hint: 'Comma-separated IDs in one VPC: exactly one for single-node or exactly three in different AZs for a cluster.' },
    { id: 'clients', label: 'Application client security group IDs', control: 'text', hint: '1–5 existing groups in the same VPC; allowed only on TLS AMQP TCP 5671.' },
    { id: 'admins', label: 'Management client security group IDs', control: 'text', hint: '1–5 existing admin/bastion/VPN client groups in that VPC; allowed on management HTTPS TCP 443/15671.' },
    { id: 'username', label: 'Bootstrap administrator username', control: 'text', default: 'brokeradmin', hint: 'Initial admin only. Supply mq_admin_password securely at Terraform deployment time; no password is collected by this form.' },
    { id: 'kms', label: 'Encryption KMS key ARN', control: 'text', hint: 'Optional regional symmetric customer-managed key. Blank uses an Amazon MQ owned encryption key.' },
    { id: 'maintenance_day', label: 'Maintenance day (UTC)', control: 'select', default: 'SUNDAY', options: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map(value => ({ value, label: value })) },
    { id: 'maintenance_time', label: 'Maintenance start (UTC HH:MM)', control: 'text', default: '03:00' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.mq.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), version = String(values.version ?? '').trim(), instance = String(values.instance ?? '').trim(), mode = String(values.mode ?? ''), username = String(values.username ?? '').trim(), kms = String(values.kms ?? '').trim(), day = String(values.maintenance_day ?? ''), time = String(values.maintenance_time ?? '').trim();
    const list = (id        ) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), admins = list('admins'), groups = [...new Set([...clients, ...admins])];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(name)) reject('name', 'Use a letter followed by up to 49 letters, digits, underscores or hyphens.');
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) reject('version', 'Enter an exact supported major.minor or major.minor.patch RabbitMQ version from the regional API.');
    if (!/^mq\.[a-z0-9]+\.[a-z0-9]+$/.test(instance)) reject('instance', 'Enter an Amazon MQ broker instance type.');
    if (!['SINGLE_INSTANCE', 'CLUSTER_MULTI_AZ'].includes(mode)) reject('mode', 'Choose single-node or three-AZ cluster.');
    const count = mode === 'SINGLE_INSTANCE' ? 1 : 3;
    if (subnets.length !== count || subnets.some(subnet => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(subnet))) reject('subnets', 'Use exactly ' + count + ' private subnet ID(s), in one VPC and distinct AZs.');
    for (const [id, selected] of [['clients', clients], ['admins', admins]]         ) if (!selected.length || selected.length > 5 || selected.some(group => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(group))) reject(id, 'Use 1–5 existing same-VPC security group IDs.');
    if (!/^[A-Za-z0-9_.-]{2,100}$/.test(username) || username.toLowerCase() === 'guest') reject('username', 'Use 2–100 letters, digits, underscores, periods or hyphens, excluding guest.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a regional symmetric KMS key ARN in the selected partition.');
    if (!['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(day)) reject('maintenance_day', 'Choose a maintenance day.');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) reject('maintenance_time', 'Use UTC HH:MM.');
    const result = awsServiceModule(region, [
      blk('variable', { type: x('string'), sensitive: true, nullable: false, description: 'Initial RabbitMQ administrator password, supplied securely at deployment; never put in the exported package. It is retained in Terraform state by the provider.' }, [blk('validation', { condition: x('length(var.mq_admin_password) >= 12 && length(var.mq_admin_password) <= 250 && length(distinct(split("", var.mq_admin_password))) >= 4 && can(regex("^[!-~]+$", var.mq_admin_password)) && !can(regex("[,:=]", var.mq_admin_password))'), error_message: 'Use 12–250 characters with at least four unique characters and no colon, comma, equals sign or whitespace.' })], ['mq_admin_password']),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'clients', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_security_group', 'broker', { name: name + '-broker', description: 'Private RabbitMQ application and admin TLS', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id'), tags: x(hcl({ Name: name + '-broker' })) }, [blk('ingress', { description: 'Application AMQPS', protocol: 'tcp', from_port: 5671, to_port: 5671, security_groups: clients }), ...[443, 15671].map(port => blk('ingress', { description: 'Administrator HTTPS', protocol: 'tcp', from_port: port, to_port: port, security_groups: admins }))]),
      res('aws_mq_broker', 'configured', { broker_name: name, engine_type: 'RabbitMQ', engine_version: version, host_instance_type: instance, deployment_mode: mode, publicly_accessible: false, subnet_ids: subnets, security_groups: x('[aws_security_group.broker.id]'), auto_minor_version_upgrade: true, apply_immediately: false, storage_type: 'EBS', tags: x(hcl({ Name: name })) }, [
        blk('encryption_options', { use_aws_owned_key: !kms, ...(kms ? { kms_key_id: kms } : {}) }),
        blk('user', { username, password: x('var.mq_admin_password') }),
        blk('maintenance_window_start_time', { day_of_week: day, time_of_day: time, time_zone: 'UTC' }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + count + ' && alltrue([for group in data.aws_security_group.clients : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'Broker subnets must belong to one VPC in the required distinct AZs, and all client/admin groups must be in that VPC.' })]),
      ]),
      output('broker_id', 'aws_mq_broker.configured.id'), output('broker_arn', 'aws_mq_broker.configured.arn'), output('broker_endpoints', '[for instance in aws_mq_broker.configured.instances : instance.endpoints]'), output('management_urls', '[for instance in aws_mq_broker.configured.instances : instance.console_url]'),
    ], `# Private Amazon MQ RabbitMQ

## Prepare
Run PREFLIGHT.ps1 to check regional engine and instance/deployment offerings. Review node sizing, queue type/replication compatibility, connection limits, service quotas and charges. This is RabbitMQ, not ActiveMQ. Private routing, client egress, NACLs, DNS and any KMS permissions must already work. The deployment identity may need permission to create the Amazon MQ service-linked role. A cluster requires three private subnets in three AZs; single-node has no multi-AZ availability.

## Implement
Protect encrypted, access-controlled Terraform state and saved plans: the provider retains the supplied bootstrap password in state despite its sensitive flag. Provide mq_admin_password through an approved secret-injection mechanism at deployment, not a checked-in tfvars file or exported archive. Run terraform init, terraform validate and terraform plan -out=service.tfplan; review the regional offering, network, maintenance and encryption, then apply the reviewed plan. Wait for RUNNING. Minor-version upgrades are enabled; review service maintenance and mandatory version lifecycle independently.

Create application vhosts, least-privilege users/permissions, durable queues, replication policies and dead-letter/retry behavior through the RabbitMQ management interface/API using an approved administrator. The single bootstrap user is for initial administration only. Terraform's RabbitMQ user block is creation-time configuration; it does not implement ongoing user/password management or detect external user drift. Rotate through RabbitMQ's supported interface and coordinate future plans; do not treat changing the sensitive variable as a safe password rotation procedure. Broker prevent_destroy blocks unreviewed destructive replacements.

## Verify
Inspect aws mq describe-broker --broker-id <output-id> --region ${region}. From approved application hosts, connect to the AMQPS endpoint on 5671 with trusted CA and hostname verification; do not bypass TLS verification. Use management HTTPS 443/15671 only from selected admin groups. Unauthorized hosts must be denied. Test publisher confirms, persistent messages, consumer acknowledgements, duplicate handling and recovery with disposable test messages/vhosts. Verify queue replication and node/AZ failure behavior for the actual engine and queue type. Provision CloudWatch metrics/alarms and broker general logging with approved permissions/retention separately; RabbitMQ audit logging is not an available broker option here.

## Recovery
Record topology definitions and permissions outside the broker under approved access controls; definitions exports are not backups of queued messages. Test durable message/replica behavior and replay from the system of record. Drain or retain messages before migration/deletion, preserve source acceptance evidence and coordinate clients. Deleting/recreating a broker is not rollback and can lose messages. Explicitly review removal of prevent_destroy for approved destruction. No broker, credentials, vhost, queue or messages are created by local generation/validation.

https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/working-with-rabbitmq.html
https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/data-protection.html
https://registry.terraform.io/providers/hashicorp/aws/5.100.0/docs/resources/mq_broker
`, findings);
    return { ...result, files: { ...result.files, 'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
function Read-MqPages([string]$Operation, [string[]]$Filters, [string]$Property) {
  $nextToken = $null
  do {
    $arguments = @('mq', $Operation) + $Filters + @('--region', '${region}', '--output', 'json')
    if ($nextToken) { $arguments += @('--next-token', $nextToken) }
    $pageJson = aws @arguments
    if ($LASTEXITCODE -ne 0) { throw ('Could not read regional Amazon MQ metadata: ' + $Operation) }
    $page = $pageJson | ConvertFrom-Json
    $page.$Property
    $nextToken = $page.NextToken
  } while ($nextToken)
}
$engines = @(Read-MqPages 'describe-broker-engine-types' @('--engine-type', 'RABBITMQ') 'BrokerEngineTypes')
$versions = @($engines | ForEach-Object { $_.EngineVersions } | ForEach-Object { $_.Name })
if ($versions -notcontains '${version}') { throw 'Selected RabbitMQ version is not listed in this region.' }
$options = @(Read-MqPages 'describe-broker-instance-options' @('--engine-type', 'RABBITMQ', '--host-instance-type', '${instance}', '--storage-type', 'EBS') 'BrokerInstanceOptions')
$compatible = @($options | Where-Object { $_.HostInstanceType -eq '${instance}' -and $_.EngineType -eq 'RABBITMQ' -and $_.SupportedEngineVersions -contains '${version}' -and $_.SupportedDeploymentModes -contains '${mode}' })
if ($compatible.Count -eq 0) { throw 'Selected type/version/deployment mode is not listed as compatible in this region.' }
Write-Host 'Regional offering checked. Review subnet AZs, permissions, capacity and queue compatibility before deployment.'
` } };
  },
}                    ;

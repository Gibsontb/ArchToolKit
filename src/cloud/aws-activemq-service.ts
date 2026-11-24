import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
const protocols = [
  { value: 'OPENWIRE', label: 'OpenWire TLS (61617)', port: 61617 },
  { value: 'AMQP', label: 'AMQP TLS (5671)', port: 5671 },
  { value: 'STOMP', label: 'STOMP TLS (61614)', port: 61614 },
  { value: 'MQTT', label: 'MQTT TLS (8883)', port: 8883 },
  { value: 'WEBSOCKET', label: 'WebSocket TLS (61619)', port: 61619 },
];
export const AWS_ACTIVEMQ_SERVICE = {
  id: 'aws_service_mq_activemq', label: 'Set up a private ActiveMQ broker',
  description: 'Private single or active/standby broker, TLS protocol checklist, admin/application users, scoped destination authorization, audit logs and guarded log-retention/TLS checks.',
  emits: ['aws_mq_broker', 'aws_mq_configuration', 'aws_security_group', 'aws_cloudwatch_log_resource_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Broker name', control: 'text' },
    { id: 'version', label: 'Regional ActiveMQ engine version', control: 'text', hint: 'Exact current version advertised by Amazon MQ. Run the exported regional-offering preflight before plan.' },
    { id: 'instance', label: 'Broker instance type', control: 'combo', default: 'mq.m5.large', options: ['mq.m5.large', 'mq.m5.xlarge', 'mq.m5.2xlarge', 'mq.t3.micro'].map(value => ({ value, label: value })) },
    { id: 'mode', label: 'Broker availability', control: 'select', default: 'ACTIVE_STANDBY_MULTI_AZ', options: [{ value: 'ACTIVE_STANDBY_MULTI_AZ', label: 'Active/standby — two AZs with EFS storage' }, { value: 'SINGLE_INSTANCE', label: 'Single broker — one AZ' }] },
    { id: 'storage', label: 'Single-broker storage', control: 'select', default: 'EFS', options: [{ value: 'EFS', label: 'EFS' }, { value: 'EBS', label: 'EBS — verify instance offering' }], showWhen: { input: 'mode', equals: ['SINGLE_INSTANCE'] } },
    { id: 'subnets', label: 'Private broker subnet IDs', control: 'text', hint: 'One subnet for single broker; two distinct-AZ subnets in one VPC for active/standby.' },
    { id: 'clients', label: 'Application security group IDs', control: 'text', hint: '1–5 same-VPC groups permitted only on selected messaging TLS ports.' },
    { id: 'admins', label: 'Administrator security group IDs', control: 'text', hint: '1–5 same-VPC groups permitted on management HTTPS8162.' },
    { id: 'protocols', label: 'Application TLS protocols', control: 'checklist', default: 'OPENWIRE', options: protocols.map(({ value, label }) => ({ value, label })) },
    { id: 'admin_user', label: 'Bootstrap administrator username', control: 'text', default: 'brokeradmin' },
    { id: 'app_user', label: 'Application username', control: 'text', default: 'application' },
    { id: 'access', label: 'Application destination access', control: 'select', default: 'READ', options: [{ value: 'READ', label: 'Consume/browse approved destinations' }, { value: 'READWRITE', label: 'Consume and publish approved destinations' }] },
    { id: 'prefix', label: 'Application destination prefix', control: 'text', default: 'application.', hint: 'Literal dot-terminated prefix. The app cannot create destinations, use temporary destinations or access unrelated queues/topics.' },
    { id: 'queues', label: 'Precreated queue suffixes', control: 'text', default: 'jobs', hint: 'Comma-separated literal suffixes. Example jobs creates application.jobs with the default prefix.' },
    { id: 'topics', label: 'Precreated topic suffixes', control: 'text', hint: 'Optional comma-separated suffixes. Durable subscriptions and acknowledgment/retry behavior require application configuration.' },
    { id: 'kms', label: 'Optional storage KMS key ARN', control: 'text' },
    { id: 'log_days', label: 'Post-creation log retention (days)', control: 'select', default: '90', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
    { id: 'day', label: 'Maintenance day (UTC)', control: 'select', default: 'SUNDAY', options: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map(value => ({ value, label: value })) },
    { id: 'time', label: 'Maintenance start (UTC HH:MM)', control: 'text', default: '03:00' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.mq.activemq.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), version = String(values.version ?? '').trim(), instance = String(values.instance ?? '').trim(), mode = String(values.mode ?? ''), storage = mode === 'ACTIVE_STANDBY_MULTI_AZ' ? 'EFS' : String(values.storage ?? ''), adminUser = String(values.admin_user ?? '').trim(), appUser = String(values.app_user ?? '').trim(), access = String(values.access ?? ''), prefix = String(values.prefix ?? '').trim(), kms = String(values.kms ?? '').trim(), day = String(values.day ?? ''), time = String(values.time ?? '').trim(), logDays = Number(values.log_days);
    const list = (id: string) => [...new Set(String(values[id] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), clients = list('clients'), admins = list('admins'), selected = list('protocols'), queues = list('queues'), topics = list('topics'), count = mode === 'ACTIVE_STANDBY_MULTI_AZ' ? 2 : 1;
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(name)) reject('name', 'Use 1–50 letters, digits, underscores or hyphens, starting with a letter.');
    if (!/^5\.\d+(?:\.\d+)?$/.test(version)) reject('version', 'Enter an exact currently advertised ActiveMQ 5.x version.');
    if (!/^mq\.[a-z0-9]+\.[a-z0-9]+$/.test(instance)) reject('instance', 'Use a supported regional broker instance type.');
    if (!['ACTIVE_STANDBY_MULTI_AZ', 'SINGLE_INSTANCE'].includes(mode)) reject('mode', 'Choose active/standby or single-instance deployment.');
    if (!['EFS', 'EBS'].includes(storage)) reject('storage', 'Choose supported storage; active/standby always uses EFS.');
    if (subnets.length !== count || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Use one subnet for single or two distinct-AZ subnets for active/standby.');
    for (const [id, ids] of [['clients', clients], ['admins', admins]] as const) if (!ids.length || ids.length > 5 || ids.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject(id, 'Use 1–5 existing same-VPC security groups.');
    if (!selected.length || selected.some(value => !protocols.some(protocol => protocol.value === value))) reject('protocols', 'Select at least one supported messaging TLS protocol.');
    for (const [id, username] of [['admin_user', adminUser], ['app_user', appUser]]) if (!/^[A-Za-z0-9_.~-]{2,100}$/.test(username!) || username === 'guest') reject(id!, 'Use a non-guest username of 2–100 letters, digits, periods, underscores, tildes or hyphens.');
    if (adminUser === appUser) reject('app_user', 'Use separate administrator and application usernames.');
    if (!['READ', 'READWRITE'].includes(access)) reject('access', 'Choose consume-only or consume/publish application access.');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}\.$/.test(prefix) || prefix.includes('..') || prefix.toLowerCase().startsWith('activemq.')) reject('prefix', 'Use a literal nonreserved dot-terminated application prefix without wildcards.');
    for (const [id, names] of [['queues', queues], ['topics', topics]] as const) if (names.length > 20 || names.some(value => !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) || value.includes('..'))) reject(id, 'Use up to 20 literal destination suffixes, without wildcard/control characters.');
    if (!queues.length && !topics.length) reject('queues', 'Provide at least one application queue or topic.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing enabled regional symmetric storage key ARN.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(logDays)) reject('log_days', 'Choose the explicit post-creation retention period.');
    if (!['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(day)) reject('day', 'Choose a maintenance day.');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) reject('time', 'Use a valid UTC HH:MM time.');
    const xml = [
      '<broker xmlns="http://activemq.apache.org/schema/core" advisorySupport="false">',
      '  <destinations>',
      ...queues.map(suffix => '    <queue physicalName="' + prefix + suffix + '"/>'),
      ...topics.map(suffix => '    <topic physicalName="' + prefix + suffix + '"/>'),
      '  </destinations>',
      '  <plugins><authorizationPlugin><map><authorizationMap>',
      '    <authorizationEntries>',
      '      <authorizationEntry queue="&gt;" read="broker-admins" write="broker-admins" admin="broker-admins"/>',
      '      <authorizationEntry topic="&gt;" read="broker-admins" write="broker-admins" admin="broker-admins"/>',
      ...['queue', 'topic'].map(type => '      <authorizationEntry ' + type + '="' + prefix + '&gt;" read="app-readers,broker-admins" write="app-writers,broker-admins" admin="broker-admins"/>'),
      '    </authorizationEntries>',
      '    <tempDestinationAuthorizationEntry><tempDestinationAuthorizationEntry read="broker-admins" write="broker-admins" admin="broker-admins"/></tempDestinationAuthorizationEntry>',
      '  </authorizationMap></map></authorizationPlugin></plugins>',
      '</broker>',
    ].join('\n') + '\n';
    const password = (id: string) => blk('variable', { type: x('string'), sensitive: true, nullable: false, description: 'Deploy-time secret; never export values and protect Terraform state/plans.' }, [blk('validation', { condition: x('can(regex("^[!-~]{12,100}$", var.' + id + ')) && length(regexall("[,:=]", var.' + id + ')) == 0 && length(distinct(split("", var.' + id + '))) >= 4'), error_message: 'Use 12–100 printable nonspace ASCII characters, at least four distinct characters, and no comma, colon or equal sign.' })], [id]);
    const ports = protocols.filter(protocol => selected.includes(protocol.value)).map(protocol => protocol.port);
    const guide = [
      '# Private Amazon MQ ActiveMQ with destination-scoped application user',
      '## Prepare\nRun PREFLIGHT.ps1 to verify regional engine/type/storage/deployment offerings, including pagination. Active/standby uses EFS across two AZs; a single broker has no standby and may use an advertised EFS/EBS offering. Review instance sizing, connection/message limits, durable message requirements, client compatibility, service-linked role, DNS, private client routes and KMS policies. This recipe uses simple broker users, not LDAP. TLS port selection is enforced by the new SG; unselected/insecure messaging ports are not opened. The admin group alone gets HTTPS8162.',
      '## Deploy securely\nProvide mq_admin_password and mq_application_password separately through the approved deployment secret-injection mechanism. Both are sensitive variables without generated defaults, but the provider stores them in Terraform state/plans; protect those artifacts. Passwords must differ and satisfy the service character rules. Run terraform init, terraform validate and terraform plan -out=service.tfplan; review the exact authorization XML, groups, precreated destinations, private network, maintenance and encryption, then apply the reviewed plan. Auto patch updates are enabled and apply_immediately is false. Wait for RUNNING. Configuration updates may remain pending until reboot/maintenance; inspect the ACTUAL applied configuration revision and its sanitized XML before connecting application traffic. Do not assume that an edited XML file is already active.',
      '## Authorization and clients\nThe console-enabled administrator belongs to broker-admins. The separate app user has no console access; READ maps to app-readers, READWRITE also maps to app-writers. App access covers only the selected literal destination namespace; app users cannot create destinations or use temporary destinations, which are explicitly admin-only. Precreated queues/topics are in the XML. Broker administrative permissions remain broad by design for the administrator. Advisory support is disabled to avoid granting app users global advisory access; OpenWire/JMS clients must use jms.watchTopicAdvisories=false. Request/reply clients needing temporary destinations, network-of-broker bridges and advisory-based behavior require a separately reviewed policy. No message-level data/tenant filtering is claimed.',
      'Run CHECK-TLS.py from the applied package and an authorized host to check a selected protocol TLS endpoint, CA/hostname validation and failover reachability. It does not authenticate, send, subscribe or consume messages. For OpenWire, use output openwire_failover_url when that protocol is selected; use both endpoints for active/standby and verify actual reconnect/ack behavior. Configure application credentials through its approved secret provider, not a committed URI or command line. Test disposable pilot messages, persistent delivery, acknowledgements, idempotency/duplicate handling, access denial outside the prefix, and denial of app destination/temporary-queue creation separately before cutover.',
      '## Logging and retention\nAudit/general logging are enabled with a broker-name/account/region-scoped source-conditioned CloudWatch log resource policy. The deployment/reboot identity must already have logs:CreateLogGroup for the broker log prefix; otherwise Amazon MQ cannot create the groups. The service creates broker-ID-named groups, so this package does not race their creation with Terraform. Run LOG-RETENTION.ps1 to inspect exact groups, then LOG-RETENTION.ps1 -Apply to set the selected retention after both groups exist. The script validates STS account and actual broker name/ARN/engine before writes. Test real delivery and retention; configuration flags alone are not evidence. Publishing through the ActiveMQ web console can put message contents in CloudWatch logs; keep sensitive payloads out of console tests and govern log access/retention.',
      '## Migration and recovery\nInventory destinations, selectors, durable subscriptions, IDs, transactions, DLQ/redelivery and client failover behavior. This configuration does not copy queued messages, bridge brokers or implement business retry/dead-letter policies. Drain or replicate through a separately tested compatible migration process, retain a system-of-record replay source, reconcile durable messages and owner acceptance, and define cutback/write reconciliation before cutover. EFS and standby replication do not recover logical deletes or form an exportable queue backup. Externalize configuration/user lifecycle and test replay/reconnection. Terraform prevent_destroy blocks unreviewed replacement, not an AWS deletion lock. No messaging connection, log-retention change or message publication occurs during local generation/validation.',
      'https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/amazon-mq-broker-architecture.html\nhttps://docs.aws.amazon.com/amazon-mq/latest/developer-guide/permitted-collections.html\nhttps://docs.aws.amazon.com/amazon-mq/latest/developer-guide/configure-logging-monitoring-activemq.html\nhttps://activemq.apache.org/components/classic/documentation/security',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      password('mq_admin_password'), password('mq_application_password'), dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify([...new Set([...clients, ...admins])]) + ')'), id: x('each.value') }),
      ...(kms ? [dat('aws_kms_key', 'storage', { key_id: kms })] : []),
      res('aws_security_group', 'broker', { name: name + '-activemq', description: 'Approved ActiveMQ TLS clients and HTTPS administrators', vpc_id: x('data.aws_subnet.selected[' + JSON.stringify(subnets[0] ?? '') + '].vpc_id') }, [
        ...ports.map(port => blk('ingress', { protocol: 'tcp', from_port: port, to_port: port, security_groups: clients })),
        blk('ingress', { protocol: 'tcp', from_port: 8162, to_port: 8162, security_groups: admins }),
      ]),
      res('aws_mq_configuration', 'configured', { name: name + '-configuration', engine_type: 'ActiveMQ', engine_version: version, data: xml }),
      res('aws_cloudwatch_log_resource_policy', 'broker', { policy_name: name + '-activemq-logs', policy_document: x(jsonencode({ Version: '2012-10-17', Statement: [{
        Effect: 'Allow', Principal: { Service: 'mq.amazonaws.com' }, Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: e('format("arn:' + partition + ':logs:' + region + ':%s:log-group:/aws/amazonmq/broker/*", data.aws_caller_identity.current.account_id)'),
        Condition: { StringEquals: { 'aws:SourceAccount': e('data.aws_caller_identity.current.account_id') }, ArnLike: { 'aws:SourceArn': e('format("arn:' + partition + ':mq:' + region + ':%s:broker:' + name + ':*", data.aws_caller_identity.current.account_id)') } },
      }] })) }),
      res('aws_mq_broker', 'configured', { broker_name: name, engine_type: 'ActiveMQ', engine_version: version, host_instance_type: instance, deployment_mode: mode, storage_type: storage, subnet_ids: subnets, security_groups: x('[aws_security_group.broker.id]'), publicly_accessible: false, auto_minor_version_upgrade: true, apply_immediately: false, tags: x(hcl({ Name: name })), depends_on: x('[aws_cloudwatch_log_resource_policy.broker]') }, [
        blk('configuration', { id: x('aws_mq_configuration.configured.id'), revision: x('aws_mq_configuration.configured.latest_revision') }),
        blk('encryption_options', { use_aws_owned_key: !kms, ...(kms ? { kms_key_id: x('data.aws_kms_key.storage.arn') } : {}) }),
        blk('user', { username: adminUser, password: x('var.mq_admin_password'), groups: ['broker-admins'], console_access: true }),
        blk('user', { username: appUser, password: x('var.mq_application_password'), groups: access === 'READWRITE' ? ['app-readers', 'app-writers'] : ['app-readers'], console_access: false }),
        blk('logs', { general: true, audit: 'true' }),
        blk('maintenance_window_start_time', { day_of_week: day, time_of_day: time, time_zone: 'UTC' }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('var.mq_admin_password != var.mq_application_password && length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) == ' + count + ' && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])' + (kms ? ' && data.aws_kms_key.storage.enabled && data.aws_kms_key.storage.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use distinct administrator/application passwords, required same-VPC subnet AZs/groups and an enabled symmetric key.' })]),
      ]),
      output('broker_id', 'aws_mq_broker.configured.id'),
      output('broker_endpoints', 'flatten([for instance in aws_mq_broker.configured.instances : instance.endpoints])'),
      ...(selected.includes('OPENWIRE') ? [output('openwire_failover_url', 'format("failover:(%s)?randomize=false&jms.watchTopicAdvisories=false", join(",", flatten([for instance in aws_mq_broker.configured.instances : [for endpoint in instance.endpoints : endpoint if startswith(endpoint, "ssl://")]])))')] : []),
      output('mq_job', '{ id = aws_mq_broker.configured.id, arn = aws_mq_broker.configured.arn, account = data.aws_caller_identity.current.account_id, region = ' + JSON.stringify(region) + ', name = ' + JSON.stringify(name) + ' }'),
    ], guide, findings);
    const preflight = [
      "$ErrorActionPreference = 'Stop'",
      'function Read-MqPages([string]$Operation, [string[]]$Filters, [string]$Property) {',
      '  $nextToken = $null',
      '  do {',
      "    $request = @('mq',$Operation) + $Filters + @('--region','" + region + "','--output','json')",
      "    if ($nextToken) { $request += @('--next-token',$nextToken) }",
      '    $raw = aws @request; if ($LASTEXITCODE -ne 0) { throw "Could not read regional Amazon MQ metadata." }',
      '    $page = $raw | ConvertFrom-Json; $page.$Property; $nextToken = $page.NextToken',
      '  } while ($nextToken)',
      '}',
      "$engines = @(Read-MqPages 'describe-broker-engine-types' @('--engine-type','ACTIVEMQ') 'BrokerEngineTypes')",
      '$versions = @($engines | ForEach-Object { $_.EngineVersions } | ForEach-Object { $_.Name })',
      "if ($versions -notcontains '" + version + "') { throw 'Selected ActiveMQ version is not listed in this region.' }",
      "$options = @(Read-MqPages 'describe-broker-instance-options' @('--engine-type','ACTIVEMQ','--host-instance-type','" + instance + "','--storage-type','" + storage + "') 'BrokerInstanceOptions')",
      "$compatible = @($options | Where-Object { $_.EngineType -eq 'ACTIVEMQ' -and $_.HostInstanceType -eq '" + instance + "' -and $_.SupportedEngineVersions -contains '" + version + "' -and $_.SupportedDeploymentModes -contains '" + mode + "' })",
      'if ($compatible.Count -eq 0) { throw "Selected type/version/storage/deployment mode is not listed as compatible." }',
      "Write-Host 'Regional offering checked. Review subnet AZs, effective XML authorization, private routing, logs and Terraform plan before apply.'",
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'BROKER-CONFIG.xml': xml, 'PREFLIGHT.ps1': preflight, 'LOG-RETENTION.ps1': mqRetention.replaceAll('__NAME__', name).replaceAll('__REGION__', region).replaceAll('__DAYS__', String(logDays)), 'CHECK-TLS.py': mqTlsClient.replaceAll('__PORTS__', JSON.stringify(ports)) } };
  },
} satisfies Blueprint;

const mqRetention = [
  'param([switch]$Apply)',
  "$ErrorActionPreference = 'Stop'",
  '$raw = terraform output -json mq_job; if ($LASTEXITCODE -ne 0) { throw "Read the applied broker package state." }; $job = $raw | ConvertFrom-Json',
  "if ($job.name -ne '__NAME__' -or $job.region -ne '__REGION__') { throw 'Broker state differs from this package.' }",
  'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ("AWS log/broker request failed: " + $Arguments[0] + " " + $Arguments[1]) }; return ($raw | ConvertFrom-Json) }',
  "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne $job.account) { throw 'Unexpected broker account.' }",
  "$broker = Read-AwsJson @('mq','describe-broker','--broker-id',$job.id,'--region',$job.region,'--output','json')",
  "if ($broker.BrokerArn -ne $job.arn -or $broker.BrokerName -ne $job.name -or $broker.EngineType -ne 'ACTIVEMQ') { throw 'Actual broker differs from this package.' }",
  '$groups = @("general","audit") | ForEach-Object { "/aws/amazonmq/broker/" + $job.id + "/" + $_ }',
  'foreach ($group in $groups) {',
  "  $metadata = Read-AwsJson @('logs','describe-log-groups','--log-group-name-prefix',$group,'--region',$job.region,'--output','json')",
  '  $exact = @($metadata.logGroups | Where-Object { $_.logGroupName -eq $group })',
  '  if ($exact.Count -ne 1) { throw "Expected broker log group is missing; verify delivery before retention changes." }',
  '  [pscustomobject]@{ Group = $group; CurrentDays = $exact[0].retentionInDays; RequestedDays = __DAYS__ }',
  '}',
  'if (-not $Apply) { Write-Host "Inspect only. Use -Apply after reviewing retention requirements."; return }',
  'foreach ($group in $groups) {',
  "  $null = Read-AwsJson @('logs','put-retention-policy','--log-group-name',$group,'--retention-in-days','__DAYS__','--region',$job.region)",
  '}',
  'Write-Host "Retention requests completed for the two exact broker groups. Re-read their settings to confirm."',
].join('\n') + '\n';
const mqTlsClient = [
  'import json, socket, ssl, subprocess, urllib.parse',
  'endpoints = json.loads(subprocess.check_output(["terraform", "output", "-json", "broker_endpoints"], text=True))',
  'allowed_ports = __PORTS__',
  'context = ssl.create_default_context()',
  'context.minimum_version = ssl.TLSVersion.TLSv1_2',
  'for port in allowed_ports:',
  '    verified = False',
  '    for endpoint in endpoints:',
  '        parsed = urllib.parse.urlparse(endpoint)',
  '        if not parsed.hostname or parsed.port != port: continue',
  '        try:',
  '            with socket.create_connection((parsed.hostname, parsed.port), timeout=10) as raw:',
  '                with context.wrap_socket(raw, server_hostname=parsed.hostname) as connection:',
  '                    print("TLS certificate/hostname verified for", parsed.hostname, parsed.port, connection.version())',
  '                    verified = True',
  '                    break',
  '        except (OSError, ssl.SSLError):',
  '            continue',
  '    if not verified: raise RuntimeError("No selected protocol endpoint completed verified TLS on port " + str(port))',
  'print("TLS reachability only; no broker login, subscription or message operation was performed.")',
].join('\n') + '\n';

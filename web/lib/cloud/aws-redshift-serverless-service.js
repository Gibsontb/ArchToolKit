import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';
const capacities = Array.from({ length: 64 }, (_, index) => (index + 1) * 8);
export const AWS_REDSHIFT_SERVERLESS_SERVICE = {
  id: 'aws_service_redshift_serverless', label: 'Set up a private Redshift Serverless warehouse',
  description: 'Create a protected namespace/workgroup with managed admin credentials, encryption, TLS, audit logs and explicit compute/network settings.',
  emits: ['aws_redshiftserverless_namespace', 'aws_redshiftserverless_workgroup'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Warehouse namespace / workgroup name', control: 'text' },
    { id: 'database', label: 'Initial database name', control: 'text', default: 'analytics' },
    { id: 'admin', label: 'Initial admin user name', control: 'text', default: 'warehouse_admin', hint: 'AWS Secrets Manager generates and manages the password; no password value is entered or exported.' },
    { id: 'base', label: 'Base compute capacity (RPUs)', control: 'select', default: '8', options: capacities.map(value => ({ value: String(value), label: String(value) })) },
    { id: 'maximum', label: 'Maximum compute capacity (RPUs)', control: 'select', default: '64', options: capacities.map(value => ({ value: String(value), label: String(value) })) },
    { id: 'routing', label: 'Enhanced VPC routing', control: 'select', default: 'on', options: [{ value: 'on', label: 'Enabled — data transfers follow VPC routing' }, { value: 'off', label: 'Disabled' }] },
    { id: 'subnets', label: 'Existing private subnet IDs', control: 'text', hint: 'Comma-separated IDs in one VPC. Three AZs with enhanced routing; two AZs without it in supported commercial regions. Other partitions use three here.' },
    { id: 'groups', label: 'Existing database security group IDs', control: 'text', hint: 'Comma-separated IDs in the subnet VPC. Permit approved clients on TCP 5439 and required data-transfer egress.' },
    { id: 'kms', label: 'Storage KMS key ARN', control: 'text', hint: 'Optional regional customer-managed key for warehouse storage. AWS managed encryption is used when omitted.' },
    { id: 'secret_kms', label: 'Admin secret KMS key ARN', control: 'text', hint: 'Optional regional customer-managed key for the generated credential secret. Review key policy and retrieval permissions.' },
    { id: 'data_role', label: 'Existing default data import/export role ARN', control: 'text', hint: 'Optional existing regional warehouse service role with scoped S3/KMS/catalog permissions for your datasets.' },
  ],
  build(values)                                      {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.redshift-serverless.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), database = String(values.database ?? '').trim(), admin = String(values.admin ?? '').trim(), base = Number(values.base), maximum = Number(values.maximum), routing = String(values.routing ?? '');
    if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(name)) reject('name', 'Use 3–64 lowercase letters, numbers and internal hyphens, beginning with a letter.');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,126}$/.test(database)) reject('database', 'Use a database identifier beginning with a letter, up to 127 letters, numbers or underscores.');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(admin) || /^(?:PUBLIC|ROOT|RDSDB)$/i.test(admin)) reject('admin', 'Use a nonreserved admin identifier beginning with a letter, up to 128 letters, numbers or underscores.');
    if (!capacities.includes(base)) reject('base', 'Select a supported 8–512 RPU base capacity and confirm regional support.');
    if (!capacities.includes(maximum) || maximum < base) reject('maximum', 'Select a maximum capacity at least as large as base capacity, within 512 RPUs.');
    if (!['on', 'off'].includes(routing)) reject('routing', 'Choose enhanced VPC routing.');
    const list = (key        ) => [...new Set(String(values[key] ?? '').split(',').map(value => value.trim()).filter(Boolean))];
    const subnets = list('subnets'), groups = list('groups'), minimumAZs = routing === 'on' || partition !== 'aws' ? 3 : 2;
    if (subnets.length < minimumAZs || subnets.length > 6 || subnets.some(value => !/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('subnets', 'Select ' + minimumAZs + '–6 private subnet IDs across at least ' + minimumAZs + ' supported AZs.');
    if (!groups.length || groups.length > 5 || groups.some(value => !/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(value))) reject('groups', 'Select 1–5 security groups in the subnet VPC.');
    const kms = String(values.kms ?? '').trim(), secretKms = String(values.secret_kms ?? '').trim(), role = String(values.data_role ?? '').trim();
    for (const [path, key] of [['kms', kms], ['secret_kms', secretKms]]) if (key && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(key)) reject(path , 'Use a KMS key ARN in the selected region and partition.');
    const parsedRole = /^arn:([^:]+):iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(role);
    if (role && (!parsedRole || parsedRole[1] !== partition)) reject('data_role', 'Use an existing import/export role ARN in the selected partition.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      dat('aws_subnet', 'selected', { for_each: x('toset(' + JSON.stringify(subnets) + ')'), id: x('each.value') }),
      dat('aws_security_group', 'selected', { for_each: x('toset(' + JSON.stringify(groups) + ')'), id: x('each.value') }),
      res('aws_redshiftserverless_namespace', 'configured', { namespace_name: name, db_name: database, admin_username: admin, manage_admin_password: true, log_exports: ['connectionlog', 'userlog', 'useractivitylog'], ...(kms ? { kms_key_id: kms } : {}), ...(secretKms ? { admin_password_secret_kms_key_id: secretKms } : {}), ...(role ? { iam_roles: [role], default_iam_role_arn: role } : {}) }, [blk('lifecycle', { prevent_destroy: true }, role ? [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedRole?.[2] ?? '')), error_message: 'The default import/export role must belong to this deployment account.' })] : [])]),
      res('aws_redshiftserverless_workgroup', 'configured', { workgroup_name: name, namespace_name: x('aws_redshiftserverless_namespace.configured.namespace_name'), base_capacity: base, max_capacity: maximum, enhanced_vpc_routing: routing === 'on', publicly_accessible: false, port: 5439, subnet_ids: subnets, security_group_ids: groups }, [
        blk('config_parameter', { parameter_key: 'require_ssl', parameter_value: 'true' }), blk('config_parameter', { parameter_key: 'enable_user_activity_logging', parameter_value: 'true' }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('length(distinct([for subnet in data.aws_subnet.selected : subnet.vpc_id])) == 1 && length(distinct([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= ' + minimumAZs + ' && alltrue([for group in data.aws_security_group.selected : contains([for subnet in data.aws_subnet.selected : subnet.vpc_id], group.vpc_id)])'), error_message: 'Subnets/security groups must use one VPC with the required number of distinct supported AZs.' })]),
      ]), output('endpoint_address', 'aws_redshiftserverless_workgroup.configured.endpoint[0].address'), output('endpoint_port', 'aws_redshiftserverless_workgroup.configured.endpoint[0].port'), output('admin_secret_arn', 'aws_redshiftserverless_namespace.configured.admin_password_secret_arn'), output('namespace_arn', 'aws_redshiftserverless_namespace.configured.arn'),
    ], `# Private Redshift Serverless warehouse

## Prepare
Confirm regional RPU support, quotas and supported AZ IDs, subnet free addresses, database access boundaries and backup/retention requirements. Enhanced routing requires three supported AZs and capacity-specific free-IP space; two-AZ setup is used here only for commercial workgroups without enhanced routing. Check current AWS IP requirements for your chosen RPU capacity before applying. Existing security groups must permit approved clients on TCP 5439; this package does not modify them. Enhanced routing needs working VPC routes/endpoints for COPY/UNLOAD data paths. Prepare KMS key policies and optional dataset-access role trust/permissions. Namespace storage encryption and credential-secret encryption have separate key selections.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan; review namespace, private workgroup, RPUs, routing, keys, logs and optional data role. Apply the reviewed saved plan and wait for AVAILABLE. AWS generates and manages the admin password in Secrets Manager; only its ARN is output. Retrieve credentials only through an authorized secret-reading identity with applicable KMS permission, or configure approved temporary IAM database credentials. Connect using an approved Redshift driver with TLS certificate verification, the endpoint_address/endpoint_port outputs and database ${database}. Do not put passwords into command history, generated files or logs.

## Verify
Run aws redshift-serverless get-workgroup --workgroup-name ${name} --region ${region} and aws redshift-serverless get-namespace --namespace-name ${name} --region ${region}. Confirm private endpoint, capacity limits, managed-secret status, keys and log exports. Execute CHECK.sql through the authorized TLS client. Test a nonadmin application identity and denied unauthorized access, then validate a representative approved dataset/query separately. Verify CloudWatch audit-log delivery and protect sensitive query content. A maximum RPU setting limits compute scaling, not total monthly spend. Build budgets/usage limits and monitor RPU-hours, storage, snapshots and data transfer separately.

## Recovery
Cancel failed queries through the database operator, investigate load/permissions/network paths and restore prior reviewed capacity/settings. Test snapshot/recovery-point restore and credential rotation before onboarding critical data. This package creates no explicit backup schedule, snapshot copy or dataset migration. Namespace and workgroup destruction are protected; inventory dependent clients, data and recovery evidence before removing protection. Data schemas, COPY/UNLOAD transformations, application grants, ingestion, provisioned clusters and cross-region recovery require corresponding workflows. This path deliberately uses 8–512 RPUs supported by the pinned provider; newer regional capacity variants need separate validation.

https://docs.aws.amazon.com/redshift/latest/mgmt/serverless-usage-considerations.html
`, findings);
    return { ...result, files: { ...result.files, 'CHECK.sql': 'SELECT current_database(), current_user;\nSELECT version();\n' } };
  },
}                    ;

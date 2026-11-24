import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_ATHENA_SERVICE = {
  id: 'aws_service_athena', label: 'Set up an Athena SQL workgroup',
  description: 'Configure enforced encrypted S3 query results, engine selection, query scan limits and CloudWatch metrics.',
  emits: ['aws_athena_workgroup'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Workgroup name', control: 'text' },
    { id: 'bucket', label: 'Existing results bucket', control: 'text', hint: 'Existing private S3 bucket in the selected region. Query users need access to the results prefix.' },
    { id: 'owner', label: 'Results bucket owner account ID', control: 'text', hint: '12-digit expected bucket owner. Required to guard result writes.' },
    { id: 'prefix', label: 'Results object prefix', control: 'text', default: 'athena-results/', hint: 'A dedicated prefix for query output. Do not use a source-data prefix.' },
    { id: 'encryption', label: 'Query results encryption', control: 'select', default: 'SSE_S3', options: [{ value: 'SSE_S3', label: 'S3 managed encryption' }, { value: 'SSE_KMS', label: 'Customer-managed KMS key' }] },
    { id: 'kms', label: 'Results KMS key ARN', control: 'text', showWhen: { input: 'encryption', equals: ['SSE_KMS'] }, hint: 'Required for KMS encryption. Existing regional key policy and query users must authorize result encryption/decryption.' },
    { id: 'engine', label: 'SQL engine selection', control: 'select', default: 'Athena engine version 3', options: [{ value: 'Athena engine version 3', label: 'Athena engine version 3' }, { value: 'AUTO', label: 'AWS automatic engine selection' }] },
    { id: 'limit', label: 'Per-query scan limit (GB)', control: 'number', default: 10, hint: 'Decimal GB (1 GB = 1,000,000,000 bytes). Use at least 0.011 GB. Queries exceeding the limit are cancelled and can still incur charges.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.athena.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim();
    const bucket = String(values.bucket ?? '').trim(), owner = String(values.owner ?? '').trim(), prefix = String(values.prefix ?? '').trim();
    const encryption = String(values.encryption ?? ''), kms = encryption === 'SSE_KMS' ? String(values.kms ?? '').trim() : '', engine = String(values.engine ?? ''), limit = Number(values.limit), bytes = Math.round(limit * 1e9);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name.toLowerCase() === 'primary') reject('name', 'Use 1–128 letters, numbers, dots, underscores or hyphens; choose a new name other than primary.');
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Enter an existing S3 results bucket name.');
    if (!/^\d{12}$/.test(owner)) reject('owner', 'Enter the results bucket owner\'s 12-digit account ID.');
    if (!prefix || prefix.startsWith('/') || !prefix.endsWith('/') || /[\x00-\x1f\\]/.test(prefix) || prefix.split('/').some(part => part === '..' || part === '.') || new TextEncoder().encode(prefix).length > 512) reject('prefix', 'Use a relative dedicated results prefix ending in /, within 512 UTF-8 bytes, without dot segments or control characters.');
    if (!['SSE_S3', 'SSE_KMS'].includes(encryption)) reject('encryption', 'Select an encryption option.');
    if (encryption === 'SSE_KMS' && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Enter a customer-managed KMS key ARN in the selected region and partition.');
    if (!['Athena engine version 3', 'AUTO'].includes(engine)) reject('engine', 'Choose an engine selection.');
    if (!Number.isFinite(limit) || bytes < 10485760 || !Number.isSafeInteger(bytes)) reject('limit', 'Use at least 0.011 GB (the provider minimum is 10,485,760 bytes) within the safe whole-byte range.');
    const result = awsServiceModule(region, [
      dat('aws_s3_bucket', 'results', { bucket }),
      res('aws_athena_workgroup', 'configured', { name, state: 'ENABLED', force_destroy: false }, [
        blk('configuration', { enforce_workgroup_configuration: true, publish_cloudwatch_metrics_enabled: true, bytes_scanned_cutoff_per_query: bytes, requester_pays_enabled: false }, [
          blk('engine_version', { selected_engine_version: engine }),
          blk('result_configuration', { output_location: 's3://' + bucket + '/' + prefix, expected_bucket_owner: owner }, [blk('encryption_configuration', { encryption_option: encryption, ...(encryption === 'SSE_KMS' ? { kms_key_arn: kms } : {}) })]),
        ]),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_s3_bucket.results.region == ' + JSON.stringify(region)), error_message: 'The results bucket must be in the selected Athena region.' })]),
      ]), output('workgroup_name', 'aws_athena_workgroup.configured.name'), output('workgroup_arn', 'aws_athena_workgroup.configured.arn'),
    ], `# Athena SQL workgroup

## Prepare
Prepare an existing private regional results bucket with public access blocked, retention/lifecycle rules and approved ownership. Keep results separate from source data. Existing query principals need workgroup-scoped Athena permissions, source-data S3 read access, results-prefix S3 read/write access and required Glue catalog/Lake Formation permissions. KMS result encryption also requires key policy and caller permissions. This package configures a workgroup; it does not create datasets, catalogs, tables, bucket policies, identities or Lake Formation grants.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review region, expected bucket owner, output prefix, encryption, engine and scan limit. Apply the saved reviewed plan. Workgroup settings override client result-location and encryption settings. Configure clients to select this workgroup explicitly. Default primary workgroup clients are not moved automatically.

## Verify
Run aws athena get-work-group --work-group ${name} --region ${region}. Confirm enforced results configuration, expected owner, encryption, engine and per-query bytes cutoff. Run aws athena start-query-execution --cli-input-json file://QUERY-EXAMPLE.json --region ${region} to submit SELECT 1 as the intended query principal; record the returned execution ID. Run aws athena get-query-execution --query-execution-id <id> --region ${region}, then aws athena get-query-results --query-execution-id <id> --region ${region}. Verify success and encrypted objects in the results prefix. Test a known authorized dataset and an unauthorized dataset separately. Monitor query metrics and scanned bytes; a per-query cutoff is not a monthly spending cap and cancelled queries can still be charged. Decimal GB values are converted once to bytes.

## Recovery
Cancel an active query with aws athena stop-query-execution --query-execution-id <id> --region ${region}. Restore prior reviewed settings through Terraform. Preserve query results and evidence according to retention rules. Destruction is protected; removing a workgroup requires an explicit reviewed protection change. Results in the existing bucket are outside Terraform deletion. Avoid lowering scan limits without checking scheduled workloads.

https://docs.aws.amazon.com/athena/latest/APIReference/API_WorkGroupConfiguration.html
`, findings);
    return { ...result, files: { ...result.files, 'QUERY-EXAMPLE.json': JSON.stringify({ QueryString: 'SELECT 1 AS setup_check', WorkGroup: name }, null, 2) + '\n' } };
  },
} satisfies Blueprint;

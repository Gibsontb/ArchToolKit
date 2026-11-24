import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
export const AWS_GLUE_CRAWLER_SERVICE = {
  id: 'aws_service_glue_crawler', label: 'Set up a governed S3 Glue crawler',
  description: 'Existing private S3 dataset/database, prefix-scoped role permissions, conservative schema policy, table threshold and explicit metadata/scan operator code. No scheduled crawl.',
  emits: ['aws_glue_crawler', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Crawler name', control: 'text' },
    { id: 'database', label: 'Existing governed Data Catalog database', control: 'text', hint: 'Same account/region, with empty table default grants. A separate explicit CREATE-DATABASE.json is included; no account-wide Lake Formation settings are changed.' },
    { id: 'role', label: 'Existing crawler execution role ARN', control: 'text', hint: 'Same-account role trusted by glue.amazonaws.com. Lake Formation database CREATE_TABLE/DESCRIBE and data-location grants remain owner prerequisites where applicable.' },
    { id: 'bucket', label: 'Existing private dataset bucket', control: 'text' },
    { id: 'prefix', label: 'Accepted dataset prefix', control: 'text', default: 'accepted/', hint: 'Point to one independently accepted dataset/run, not a parent containing failed or duplicate ETL attempts.' },
    { id: 'table_prefix', label: 'New catalog table prefix', control: 'text', default: 'application_' },
    { id: 'recrawl', label: 'Recrawl behavior', control: 'select', default: 'CRAWL_EVERYTHING', options: [{ value: 'CRAWL_EVERYTHING', label: 'Reinspect the selected dataset' }, { value: 'CRAWL_NEW_FOLDERS_ONLY', label: 'After first full crawl, inspect new folders only' }] },
    { id: 'sample', label: 'Sample files per leaf folder (0 = all)', control: 'number', default: 0 },
    { id: 'threshold', label: 'Maximum detected tables', control: 'number', default: 10 },
    { id: 'kms', label: 'Optional source KMS key ARN', control: 'text', hint: 'Adds decrypt permission for the declared source key. Mixed-key datasets need a separately reviewed policy.' },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.glue.crawler.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), database = String(values.database ?? '').trim(), role = String(values.role ?? '').trim(), bucket = String(values.bucket ?? '').trim(), prefix = String(values.prefix ?? '').trim(), tablePrefix = String(values.table_prefix ?? '').trim(), recrawl = String(values.recrawl ?? ''), kms = String(values.kms ?? '').trim(), sample = Number(values.sample), threshold = Number(values.threshold);
    const match = new RegExp('^arn:' + partition + ':iam::(\\d{12}):role/([A-Za-z0-9+=,.@_/-]*[A-Za-z0-9+=,.@_-])$').exec(role), account = match?.[1] ?? '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) reject('name', 'Use a letter followed by up to 63 letters, digits, underscores or hyphens.');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(database)) reject('database', 'Use an existing lowercase database name up to 64 characters.');
    if (!match) reject('role', 'Use an existing same-account crawler role ARN.');
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Use an existing private regional S3 bucket.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,198}\/$/.test(prefix) || prefix.includes('//') || prefix.split('/').some(part => part === '.' || part === '..')) reject('prefix', 'Use a literal dataset prefix ending in / without traversal or wildcard.');
    if (!/^[a-z][a-z0-9_]{0,30}_$/.test(tablePrefix)) reject('table_prefix', 'Use a lowercase literal table prefix ending in _.');
    if (!['CRAWL_EVERYTHING', 'CRAWL_NEW_FOLDERS_ONLY'].includes(recrawl)) reject('recrawl', 'Choose the explicit full or new-folder recrawl behavior.');
    if (!Number.isInteger(sample) || sample < 0 || sample > 249) reject('sample', 'Use 0 for all files or 1–249 sampled files per leaf folder.');
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) reject('threshold', 'Use a table threshold of 1–100.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/(?:[a-f0-9-]{36}|mrk-[a-f0-9]{32})$').test(kms)) reject('kms', 'Use an existing regional symmetric source key ARN.');
    const bucketArn = 'arn:' + partition + ':s3:::' + bucket, source = 's3://' + bucket + '/' + prefix;
    const glueArn = (resource: string) => 'arn:' + partition + ':glue:' + region + ':' + account + ':' + resource;
    const guide = [
      '# Explicit governed S3 crawler and Data Catalog integration',
      '## Prepare database and accepted data\nUse a dedicated existing same-account regional database whose CreateTableDefaultPermissions contains no grants. If an owner needs to create it, review CREATE-DATABASE.json and run the command in CREATE-DATABASE-COMMAND.txt explicitly through the approved database administrator. This sends an explicit empty table-default-permissions list instead of changing account-wide Lake Formation defaults. This database is an external prerequisite, not managed/deleted by this Terraform package. The crawler role still needs owner-approved Lake Formation DESCRIBE/CREATE_TABLE/data-location permissions where applicable. Existing database/table grants and IAM policies require separate review. No wildcard IAM_ALLOWED_PRINCIPALS default grant is added.',
      'Point the crawler at an independently accepted dataset. Do not point it at a parent containing multiple failed/repeated Glue ETL run-UUID outputs, or queries can double-count duplicate attempts. Format/schema discovery is heuristic and can read source content; approve the execution boundary, source keys and inferred metadata/log handling. Sampling can miss schema variants; 0 inspects all eligible files. New-folder mode still performs an initial full crawl and does not track changes/deletions inside older folders. S3 event crawls, JDBC, custom classifiers, Iceberg/Hudi/Delta and Lake Formation credential vending require separate workflows.',
      '## Deploy\nExisting execution role must trust glue.amazonaws.com. The package adds source-prefix read/list, selected-key decrypt, chosen-database/table-prefix metadata permissions and crawler log access; no source S3 writes, table deletion or scheduler is granted. Run OPERATE.ps1 -Action InspectPrerequisites before deployment to check STS account, database name/default grants, bucket ownership and public-access blocks without requiring Terraform state. Run terraform init, terraform validate and terraform plan -out=service.tfplan; review source, role, table prefix, threshold and schema policy, then apply the reviewed plan. Creating the crawler does not scan objects; there is no schedule or trigger.',
      '## Crawl explicitly\nRun OPERATE.ps1 -Action Inspect after apply. Start explicitly rechecks prerequisites and actual crawler role/database/source targets, requires READY and calls start-crawler once. It reports request acceptance, not success. Inspect until State is READY and LastCrawl.Status is SUCCEEDED; review ERROR/FAILED/CANCELLED evidence and the reported actual log group/stream. The default /aws-glue/crawlers group is shared; this package does not take ownership of it or reset other crawlers log retention. The owner must configure approved shared-group encryption/access/retention or extend this recipe with dedicated security configuration before use where required.',
      'Schema changes/deletions are LOG-only; new tables/partitions can still be created and partition metadata inherits table schema. Table threshold is a safety bound, not proof of schema correctness. Inspect inferred classifications, locations, columns/types, partitions and grants before exposing tables to Athena/jobs. Use least-privilege reader/consumer policies and the existing Athena workgroup workflow; this package does not grant query access or issue SQL/data reads. Crawler logs and names/columns can contain sensitive metadata even when source data is not copied.',
      '## Recovery\nCataloging does not copy or back up source data. Preserve accepted source versions, schema contracts and an approved catalog export/change history. Do not delete tables or broaden grants automatically after a failed crawl. Crawler replacement has prevent_destroy; database/data lifecycle remains external. Review partial or previous crawl results, source evolution, schema drift and dependent queries before rerunning. No source scan or metadata creation occurs during local generation/validation.',
      'https://docs.aws.amazon.com/glue/latest/dg/crawler-configuration.html\nhttps://docs.aws.amazon.com/glue/latest/webapi/API_Database.html',
    ].join('\n\n') + '\n';
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), dat('aws_iam_role', 'crawler', { name: match?.[2]?.split('/').at(-1) ?? '' }), dat('aws_s3_bucket', 'source', { bucket }),
      ...(kms ? [dat('aws_kms_key', 'source', { key_id: kms })] : []),
      res('aws_iam_role_policy', 'crawler', { name: name + '-catalog-source', role: x('data.aws_iam_role.crawler.name'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: bucketArn },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: bucketArn, Condition: { StringLike: { 's3:prefix': [prefix, prefix + '*'] } } },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: bucketArn + '/' + prefix + '*' },
        { Effect: 'Allow', Action: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetTables', 'glue:CreateTable', 'glue:UpdateTable', 'glue:GetPartition', 'glue:GetPartitions', 'glue:BatchGetPartition', 'glue:CreatePartition', 'glue:UpdatePartition', 'glue:BatchCreatePartition', 'glue:BatchUpdatePartition'], Resource: [glueArn('catalog'), glueArn('database/' + database), glueArn('table/' + database + '/' + tablePrefix + '*')] },
        { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: 'arn:' + partition + ':logs:' + region + ':' + account + ':log-group:/aws-glue/crawlers*' },
        ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: kms }] : []),
      ] })) }),
      res('aws_glue_crawler', 'configured', { name, database_name: database, role, table_prefix: tablePrefix, configuration: x(jsonencode({ Version: 1.0, CrawlerOutput: { Tables: { TableThreshold: threshold }, Partitions: { AddOrUpdateBehavior: 'InheritFromTable' } } })), tags: x(hcl({ Name: name })), depends_on: x('[aws_iam_role_policy.crawler]') }, [
        blk('s3_target', { path: source, exclusions: ['**/_temporary/**', '**/_SUCCESS', '**/.*/**'], ...(sample ? { sample_size: sample } : {}) }),
        blk('recrawl_policy', { recrawl_behavior: recrawl }),
        blk('schema_change_policy', { update_behavior: 'LOG', delete_behavior: 'LOG' }),
        blk('lifecycle', { prevent_destroy: true }, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(account) + ' && data.aws_iam_role.crawler.arn == ' + JSON.stringify(role) + ' && data.aws_s3_bucket.source.region == ' + JSON.stringify(region) + (kms ? ' && data.aws_kms_key.source.enabled && data.aws_kms_key.source.key_spec == "SYMMETRIC_DEFAULT"' : '')), error_message: 'Use this account role, regional source bucket and enabled symmetric source key.' })]),
      ]),
      output('crawler_name', 'aws_glue_crawler.configured.name'),
    ], guide, findings);
    const script = [
      'param([ValidateSet("InspectPrerequisites","Inspect","Start")][string]$Action = "InspectPrerequisites")',
      "$ErrorActionPreference = 'Stop'",
      'function Read-AwsJson([string[]]$Arguments) { $raw = aws @Arguments; if ($LASTEXITCODE -ne 0) { throw ("AWS crawler/prerequisite request failed: " + $Arguments[0] + " " + $Arguments[1]) }; return ($raw | ConvertFrom-Json) }',
      "$region = '" + region + "'; $account = '" + account + "'; $database = '" + database + "'; $bucket = '" + bucket + "'",
      "$identity = Read-AwsJson @('sts','get-caller-identity','--output','json'); if ($identity.Account -ne $account) { throw 'Unexpected crawler account.' }",
      "$catalog = Read-AwsJson @('glue','get-database','--name',$database,'--catalog-id',$account,'--region',$region,'--output','json')",
      'if ($catalog.Database.Name -ne $database -or ($catalog.Database.CatalogId -and $catalog.Database.CatalogId -ne $account)) { throw "Unexpected catalog database." }',
      '$grants = @($catalog.Database.CreateTableDefaultPermissions | Where-Object { $null -ne $_ -and @($_.Permissions | Where-Object { $null -ne $_ }).Count -gt 0 })',
      'if ($grants.Count -gt 0) { throw "Database has table-default grants; obtain a governed database before starting this crawler." }',
      "$null = Read-AwsJson @('s3api','head-bucket','--bucket',$bucket,'--expected-bucket-owner',$account,'--region',$region)",
      "$public = Read-AwsJson @('s3api','get-public-access-block','--bucket',$bucket,'--expected-bucket-owner',$account,'--region',$region,'--output','json')",
      'foreach ($flag in @("BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets")) { if ($public.PublicAccessBlockConfiguration.$flag -ne $true) { throw "Require all four source-bucket public-access blocks." } }',
      'if ($Action -eq "InspectPrerequisites") { Write-Host "Read-only prerequisite checks passed. No crawler started."; return }',
      '$raw = terraform output -raw crawler_name; if ($LASTEXITCODE -ne 0) { throw "Read the applied crawler package state." }; $crawlerName = ([string]$raw).Trim()',
      "if ($crawlerName -ne '" + name + "') { throw 'Crawler name differs from this package.' }",
      "$response = Read-AwsJson @('glue','get-crawler','--name',$crawlerName,'--region',$region,'--output','json'); $crawler = $response.Crawler",
      '$targets = @($crawler.Targets.S3Targets)',
      '$otherTargets = @($crawler.Targets.PSObject.Properties | Where-Object { $_.Name -ne "S3Targets" -and @($_.Value | Where-Object { $null -ne $_ }).Count -gt 0 })',
      "if ($crawler.Name -ne $crawlerName -or $crawler.Role -ne '" + role + "' -or $crawler.DatabaseName -ne $database -or $targets.Count -ne 1 -or $targets[0].Path -ne '" + source + "' -or $otherTargets.Count -ne 0) { throw 'Actual crawler role/database/source targets differ from this package.' }",
      '$configuration = $crawler.Configuration | ConvertFrom-Json',
      "if ($crawler.TablePrefix -ne '" + tablePrefix + "' -or $crawler.RecrawlPolicy.RecrawlBehavior -ne '" + recrawl + "' -or $crawler.SchemaChangePolicy.UpdateBehavior -ne 'LOG' -or $crawler.SchemaChangePolicy.DeleteBehavior -ne 'LOG' -or $configuration.CrawlerOutput.Tables.TableThreshold -ne " + threshold + " -or $configuration.CrawlerOutput.Partitions.AddOrUpdateBehavior -ne 'InheritFromTable') { throw 'Actual crawler metadata policies differ from this package.' }",
      "if ([int]$targets[0].SampleSize -ne " + sample + " -or $crawler.Schedule.ScheduleExpression -or $crawler.LakeFormationConfiguration.UseLakeFormationCredentials -eq $true) { throw 'Actual crawler sampling/schedule/credential mode differs from this package.' }",
      'if ($Action -eq "Inspect") { [pscustomobject]@{ Name = $crawler.Name; State = $crawler.State; LastStatus = $crawler.LastCrawl.Status; LogGroup = $crawler.LastCrawl.LogGroup; LogStream = $crawler.LastCrawl.LogStream }; return }',
      'if ($crawler.State -ne "READY") { throw "Start requires READY; inspect the current crawl first." }',
      "$null = Read-AwsJson @('glue','start-crawler','--name',$crawlerName,'--region',$region)",
      'Write-Host "Crawl request accepted. Inspect final LastCrawl status and catalog results; completion is not yet verified."',
    ].join('\n') + '\n';
    return { ...result, files: { ...result.files, 'OPERATE.ps1': script, 'CREATE-DATABASE.json': JSON.stringify({ DatabaseInput: { Name: database, CreateTableDefaultPermissions: [] } }, null, 2) + '\n', 'CREATE-DATABASE-COMMAND.txt': 'aws glue create-database --cli-input-json file://CREATE-DATABASE.json --region ' + region + '\n# Explicit owner bootstrap only; do not use this against an existing database or change account-wide defaults.\n' } };
  },
} satisfies Blueprint;

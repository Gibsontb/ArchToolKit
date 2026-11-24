import { error, type Finding } from '../core/findings.ts';
import { defaultValues, type Blueprint, type BlueprintInput } from '../kit/blueprint.ts';
import { blk, dat, e, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';
import { AWS_CODEBUILD_SERVICE } from './aws-codebuild-service.ts';
const buildInputs = AWS_CODEBUILD_SERVICE.inputs.filter(input => ['role', 'image', 'compute', 'install', 'commands', 'timeout', 'retention', 'artifact_files'].includes(input.id)).map(input => {
  const { showWhen, ...plain } = input as BlueprintInput;
  return plain;
});
export const AWS_CODEPIPELINE_SERVICE = {
  id: 'aws_service_codepipeline', label: 'Set up a source and CodeBuild pipeline',
  description: 'Create a V2 S3/Git source/build pipeline with optional manual approval and S3 ZIP release, configured CodeBuild, scoped permissions and preflight.',
  emits: ['aws_codepipeline', 'aws_codebuild_project', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Pipeline name', control: 'text' },
    { id: 'pipeline_role', label: 'Existing CodePipeline service role ARN', control: 'text', hint: 'Existing role trusted by codepipeline.amazonaws.com, separate from the build execution role.' },
    { id: 'source', label: 'Pipeline source', control: 'select', default: 'S3', options: [{ value: 'S3', label: 'Versioned S3 source ZIP' }, { value: 'GIT', label: 'GitHub / GitLab / Bitbucket through an existing connection' }] },
    { id: 'source_bucket', label: 'Existing source ZIP bucket', control: 'text', showWhen: { input: 'source', equals: ['S3'] }, hint: 'Private, versioned S3 bucket in the selected region.' },
    { id: 'source_key', label: 'Source ZIP object key', control: 'text', showWhen: { input: 'source', equals: ['S3'] }, hint: 'Exact existing .zip object key, without wildcard characters.' },
    { id: 'source_kms', label: 'Source object KMS key ARN', control: 'text', showWhen: { input: 'source', equals: ['S3'] }, hint: 'Optional customer-managed key used to encrypt the source object.' },
    { id: 'connection', label: 'Existing authenticated connection ARN', control: 'text', showWhen: { input: 'source', equals: ['GIT'] }, hint: 'CodeConnections or legacy CodeStar Connections ARN in this account/region, with AVAILABLE status and repository access.' },
    { id: 'repository', label: 'Repository owner/name', control: 'text', showWhen: { input: 'source', equals: ['GIT'] }, hint: 'Exact case-sensitive repository identifier, for example engineering/Payments.' },
    { id: 'branch', label: 'Repository branch', control: 'text', default: 'main', showWhen: { input: 'source', equals: ['GIT'] } },
    { id: 'artifact_bucket', label: 'Existing artifact bucket', control: 'text', hint: 'Private, versioned regional S3 bucket. Artifacts use a prefix matching this pipeline name.' },
    { id: 'artifact_kms', label: 'Artifact store KMS key ARN', control: 'text', hint: 'Optional regional customer-managed key. Both service roles and the key policy must authorize its use.' },
    { id: 'trigger', label: 'Source change trigger', control: 'select', default: 'MANUAL', options: [{ value: 'MANUAL', label: 'Manual execution after setup' }, { value: 'POLL', label: 'Automatic source changes — S3 polling / Git connection events' }], hint: 'AWS can run a newly created pipeline once even with manual change detection. Review commands before applying.' },
    { id: 'release', label: 'Release destination', control: 'select', default: 'NONE', options: [{ value: 'NONE', label: 'Build artifact only' }, { value: 'S3_ZIP', label: 'Publish built ZIP to an existing S3 bucket/object' }] },
    { id: 'release_bucket', label: 'Existing versioned release bucket', control: 'text', showWhen: { input: 'release', equals: ['S3_ZIP'] }, hint: 'Separate private bucket in this account/region. This uploads the build ZIP; it does not extract a website or deploy a running application.' },
    { id: 'release_key', label: 'Release ZIP object key', control: 'text', showWhen: { input: 'release', equals: ['S3_ZIP'] }, hint: 'Exact .zip key to publish. Each successful release creates a new version of this key.' },
    { id: 'release_kms', label: 'Release object KMS key ARN', control: 'text', showWhen: { input: 'release', equals: ['S3_ZIP'] }, hint: 'Optional regional symmetric customer-managed key; authorize the pipeline role in its key policy.' },
    { id: 'approval', label: 'Review built artifact', control: 'select', default: 'NONE', options: [{ value: 'NONE', label: 'Continue without manual approval' }, { value: 'MANUAL', label: 'Stop after build for manual approval' }], hint: 'When enabled, approval precedes release. Source and build commands still run before the gate.' },
    { id: 'review_url', label: 'Approval review URL', control: 'text', showWhen: { input: 'approval', equals: ['MANUAL'] }, hint: 'Optional HTTPS change/review record without embedded credentials.' },
    { id: 'review_note', label: 'Approval instructions', control: 'text', showWhen: { input: 'approval', equals: ['MANUAL'] }, hint: 'Optional reviewer instructions, up to 1000 characters. Do not enter secrets.' },
    ...buildInputs,
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.codepipeline.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim(), role = String(values.pipeline_role ?? '').trim();
    const parsedRole = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(role);
    const sourceMode = String(values.source ?? 'S3'), sourceValue = (id: string) => sourceMode === 'S3' ? String(values[id] ?? '').trim() : '';
    const sourceBucket = sourceValue('source_bucket'), sourceKey = sourceValue('source_key'), sourceKms = sourceValue('source_kms'), artifactBucket = String(values.artifact_bucket ?? '').trim(), artifactKms = String(values.artifact_kms ?? '').trim(), trigger = String(values.trigger ?? '');
    const connection = sourceMode === 'GIT' ? String(values.connection ?? '').trim() : '', repository = String(values.repository ?? '').trim(), branch = String(values.branch ?? '').trim();
    const parsedConnection = /^arn:([^:]+):(codeconnections|codestar-connections):([^:]+):(\d{12}):connection\/[A-Za-z0-9-]+$/.exec(connection);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(name)) reject('name', 'Use a letter followed by up to 59 letters, numbers, underscores or hyphens.');
    if (!parsedRole || parsedRole[1] !== partition) reject('pipeline_role', 'Enter an existing pipeline service role ARN in the selected partition.');
    if (role === String(values.role ?? '').trim()) reject('pipeline_role', 'Use separate pipeline and build service roles.');
    if (!['S3', 'GIT'].includes(sourceMode)) reject('source', 'Choose an S3 ZIP or existing Git connection source.');
    if (sourceMode === 'GIT') {
      if (!parsedConnection || parsedConnection[1] !== partition || parsedConnection[3] !== region || parsedConnection[4] !== parsedRole?.[2]) reject('connection', 'Use an authenticated connection ARN in the pipeline role account and selected region/partition.');
      if (!/^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 500 || repository.split('/').some(part => part === '.' || part === '..')) reject('repository', 'Use the exact case-sensitive repository owner/name, including GitLab subgroup paths when applicable.');
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(part => part.endsWith('.lock') || part.startsWith('.'))) reject('branch', 'Enter a valid branch name without wildcard, dot traversal, hidden segments or .lock suffixes.');
    }
    for (const [path, bucket] of [...(sourceMode === 'S3' ? [['source_bucket', sourceBucket]] : []), ['artifact_bucket', artifactBucket]]) if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') || bucket!.includes('..')) reject(path!, 'Enter an existing regional S3 bucket name.');
    if (sourceMode === 'S3' && (!/\.zip$/i.test(sourceKey) || /[\x00-\x1f*?]/.test(sourceKey) || new TextEncoder().encode(sourceKey).length > 1024)) reject('source_key', 'Use an exact existing source .zip object key, within 1024 UTF-8 bytes and without wildcards/control characters.');
    if (sourceBucket === artifactBucket && sourceKey.startsWith(name + '/')) reject('source_key', 'Keep the source ZIP outside the pipeline artifact prefix when sharing a bucket.');
    for (const [path, key] of [['source_kms', sourceKms], ['artifact_kms', artifactKms]]) if (key && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(key)) reject(path!, 'Use a KMS key ARN in the selected region and partition.');
    if (!['MANUAL', 'POLL'].includes(trigger)) reject('trigger', 'Choose source change detection.');
    const release = String(values.release ?? 'NONE'), approval = String(values.approval ?? 'NONE');
    const releaseValue = (id: string) => release === 'S3_ZIP' ? String(values[id] ?? '').trim() : '';
    const releaseBucket = releaseValue('release_bucket'), releaseKey = releaseValue('release_key'), releaseKms = releaseValue('release_kms');
    const reviewUrl = approval === 'MANUAL' ? String(values.review_url ?? '').trim() : '', reviewNote = approval === 'MANUAL' ? String(values.review_note ?? '').trim() : '';
    if (!['NONE', 'S3_ZIP'].includes(release)) reject('release', 'Choose build artifact only or S3 ZIP release.');
    if (!['NONE', 'MANUAL'].includes(approval)) reject('approval', 'Choose the artifact review gate.');
    if (release === 'S3_ZIP') {
      if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(releaseBucket) || releaseBucket.includes('..') || [sourceBucket, artifactBucket].includes(releaseBucket)) reject('release_bucket', 'Use a separate existing regional release bucket, distinct from source/artifact buckets.');
      if (!/\.zip$/i.test(releaseKey) || /[\x00-\x1f*?]/.test(releaseKey) || new TextEncoder().encode(releaseKey).length > 1024) reject('release_key', 'Use an exact .zip key without wildcard/control characters, within 1024 UTF-8 bytes.');
      if (releaseKms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(releaseKms)) reject('release_kms', 'Use a regional symmetric KMS key ARN.');
    }
    if (reviewUrl) { try { const url = new URL(reviewUrl); if (url.protocol !== 'https:' || url.username || url.password || reviewUrl.length > 2048 || /[\x00-\x20]/.test(reviewUrl)) throw new Error(); } catch { reject('review_url', 'Use an HTTPS review URL without whitespace or embedded credentials, up to 2048 characters.'); } }
    if (reviewNote.length > 1000 || /[\x00-\x1f]/.test(reviewNote)) reject('review_note', 'Use up to 1000 characters without control characters.');
    const child = AWS_CODEBUILD_SERVICE.build({ ...defaultValues(AWS_CODEBUILD_SERVICE), ...values, name: name + '-build', source: 'CODEPIPELINE', artifact_prefix: name + '/' });
    findings.push(...child.findings);
    const sourceArn = 'arn:' + partition + ':s3:::' + sourceBucket, artifactArn = 'arn:' + partition + ':s3:::' + artifactBucket;
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}), ...(sourceMode === 'S3' ? [dat('aws_s3_bucket', 'source', { bucket: sourceBucket })] : []), dat('aws_s3_bucket', 'artifacts', { bucket: artifactBucket }),
      ...(release === 'S3_ZIP' ? [dat('aws_s3_bucket', 'release', { bucket: releaseBucket })] : []),
      blk('module', { source: './modules/build' }, [], ['build']),
      res('aws_iam_role_policy', 'pipeline', { name: name + '-pipeline', role: parsedRole?.[3]?.split('/').at(-1) ?? '', policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        ...(sourceMode === 'S3' ? [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: sourceArn + '/' + sourceKey }] : [{ Effect: 'Allow', Action: [(parsedConnection?.[2] ?? 'codeconnections') + ':UseConnection'], Resource: connection, Condition: { StringEquals: { [(parsedConnection?.[2] ?? 'codeconnections') + ':FullRepositoryId']: repository } } }]),
        { Effect: 'Allow', Action: ['s3:GetBucketVersioning', 's3:GetBucketLocation', 's3:GetBucketAcl'], Resource: [...new Set([...(sourceMode === 'S3' ? [sourceArn] : []), artifactArn])] },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'], Resource: artifactArn + '/' + name + '/*' },
        { Effect: 'Allow', Action: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], Resource: e('module.build.project_arn') },
        ...(sourceKms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: sourceKms }] : []),
        ...(artifactKms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Resource: artifactKms }] : []),
        ...(release === 'S3_ZIP' ? [
          { Effect: 'Allow', Action: ['s3:GetBucketVersioning', 's3:GetBucketLocation', 's3:GetBucketAcl'], Resource: 'arn:' + partition + ':s3:::' + releaseBucket, Condition: { StringEquals: { 'aws:ResourceAccount': parsedRole?.[2] ?? '' } } },
          { Effect: 'Allow', Action: ['s3:PutObject', 's3:PutObjectAcl', 's3:PutObjectVersionAcl', 's3:GetObjectTagging', 's3:GetObjectVersionTagging', 's3:PutObjectTagging'], Resource: 'arn:' + partition + ':s3:::' + releaseBucket + '/' + releaseKey, Condition: { StringEquals: { 'aws:ResourceAccount': parsedRole?.[2] ?? '' } } },
          ...(releaseKms ? [{ Effect: 'Allow', Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Resource: releaseKms }] : []),
        ] : []),
      ] })) }),
      res('aws_codepipeline', 'configured', { name, role_arn: role, pipeline_type: 'V2', execution_mode: 'SUPERSEDED', depends_on: x('[aws_iam_role_policy.pipeline]') }, [
        blk('artifact_store', { location: artifactBucket, type: 'S3' }, artifactKms ? [blk('encryption_key', { id: artifactKms, type: 'KMS' })] : []),
        blk('stage', { name: 'Source' }, [blk('action', { name: 'SourceCode', category: 'Source', owner: 'AWS', provider: sourceMode === 'S3' ? 'S3' : 'CodeStarSourceConnection', version: '1', output_artifacts: ['SourceArtifact'], configuration: x(hcl(sourceMode === 'S3' ? { S3Bucket: sourceBucket, S3ObjectKey: sourceKey, PollForSourceChanges: trigger === 'POLL' ? 'true' : 'false' } : { ConnectionArn: connection, FullRepositoryId: repository, BranchName: branch, OutputArtifactFormat: 'CODE_ZIP', DetectChanges: trigger === 'POLL' ? 'true' : 'false' })) })]),
        blk('stage', { name: 'Build' }, [blk('action', { name: 'BuildAndTest', category: 'Build', owner: 'AWS', provider: 'CodeBuild', version: '1', input_artifacts: ['SourceArtifact'], output_artifacts: ['BuildArtifact'], configuration: x(hcl({ ProjectName: e('module.build.project_name') })) })]),
        ...(approval === 'MANUAL' ? [blk('stage', { name: 'Review' }, [blk('action', { name: 'ApproveArtifact', category: 'Approval', owner: 'AWS', provider: 'Manual', version: '1', ...(reviewUrl || reviewNote ? { configuration: x(hcl({ ...(reviewUrl ? { ExternalEntityLink: reviewUrl } : {}), ...(reviewNote ? { CustomData: reviewNote } : {}) })) } : {}) })])] : []),
        ...(release === 'S3_ZIP' ? [blk('stage', { name: 'Release' }, [blk('action', { name: 'PublishZip', category: 'Deploy', owner: 'AWS', provider: 'S3', version: '1', input_artifacts: ['BuildArtifact'], configuration: x(hcl({ BucketName: releaseBucket, Extract: 'false', ObjectKey: releaseKey, ...(releaseKms ? { KMSEncryptionKeyARN: releaseKms } : {}) })) })])] : []),
        blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedRole?.[2] ?? '') + (sourceMode === 'S3' ? ' && data.aws_s3_bucket.source.region == ' + JSON.stringify(region) : '') + ' && data.aws_s3_bucket.artifacts.region == ' + JSON.stringify(region) + (release === 'S3_ZIP' ? ' && data.aws_s3_bucket.release.region == ' + JSON.stringify(region) : '')), error_message: 'The pipeline role must belong to this account and configured buckets must be in the selected region.' })]),
      ]), output('pipeline_name', 'aws_codepipeline.configured.name'), output('pipeline_arn', 'aws_codepipeline.configured.arn'),
    ], `# Source and CodeBuild V2 pipeline

## Prepare
For a Git source, complete and authorize an existing regional CodeConnections/legacy CodeStar Connections integration with repository access. This package does not create the external provider installation or grant consent. It uses a ZIP source artifact, not full clone; no connection credentials enter the build container. Automatic Git changes use connection events, while automatic S3 changes use polling. Repository spelling/case and branch must match the provider. Inactive S3 fields are excluded from Git configurations.

Prepare a private versioned artifact bucket and the chosen source: a private versioned S3 ZIP or an authenticated Git connection/repository. Run PREFLIGHT.ps1 with the intended identity to verify bucket versioning and source metadata/status. Review source contents and build commands before applying: AWS can start a newly created pipeline once even when automatic change detection is disabled. Manual mode disables ongoing change detection; it is not a guarantee against initial execution. Separate existing service roles must trust codepipeline.amazonaws.com and codebuild.amazonaws.com respectively. This package adds scoped inline policies; coordinate all shared-role owners and authorize cross-account bucket/KMS access separately. Review V2/CodeBuild/S3/KMS/log charges and default-network egress. The optional release stage uploads the build ZIP to its configured object; it does not deploy a running application.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan in this package root. The local modules/build child reuses the configured CodeBuild workflow; its source and artifacts are CODEPIPELINE, its inline buildspec has explicit output patterns, and its permissions use this pipeline's artifact prefix. Do not apply the child separately. Review roles, source ZIP, artifact boundaries, trigger behavior and every command; apply the saved reviewed plan. Monitor any initial execution immediately. Use aws codepipeline start-pipeline-execution --name ${name} --region ${region} for subsequent approved manual runs. Poll mode automatically responds to source-object changes.

## Verify
${approval === 'MANUAL' ? `The Review/ApproveArtifact action pauses after build and before any release. Review the exact source revision and BuildArtifact, test evidence and change record, then approve or reject in the CodePipeline console with a separate authorized reviewer identity. APPROVER-POLICY.json is an example scoped to this action; have the IAM owner attach it through the approved identity process. Console navigation/read access is separate. No automatic approver or notification subscription is created. Unanswered approvals fail after seven days. This gate does not prevent earlier build commands from running or independently writing to external systems; restrict the build role accordingly.\n` : ''}
${release === 'S3_ZIP' ? `Release publishes BuildArtifact as one ZIP to s3://${releaseBucket}/${releaseKey}; Extract=false preserves the archive, not a website directory. Use a private versioned bucket in this account, bucket-owner-enforced object ownership and approved default encryption (or the specified symmetric KMS key). No canned ACL is set. The release role grant is limited to that exact object, and requires the expected bucket account. Check the resulting object version, size, encryption and archive contents after release, and record the accepted version ID. Uploading this ZIP overwrites the current object version. For recovery, restore/copy the previously accepted version using an approved operator; this package does not grant the pipeline delete/rollback rights or revert a deployed application.\n` : ''}
Run aws codepipeline get-pipeline-state --name ${name} --region ${region}; inspect Source and Build stages and CodeBuild logs. Run aws codepipeline get-pipeline-execution --pipeline-name ${name} --pipeline-execution-id <id> --region ${region} and verify the consumed S3 object version or Git commit. Check BuildArtifact contents, encryption and scoped artifact prefix. Verify build failure stops the execution and no unwanted files/secrets enter release artifacts. Use the generated buildspec under modules/build for review. This workflow creates a source/build pipeline; a successful build does not deploy an application. New connections, full clone, application deployment actions, multi-region pipelines and automated rollback require additional configurations.

## Recovery
Stop an execution with aws codepipeline stop-pipeline-execution --pipeline-name ${name} --pipeline-execution-id <id> --abandon --reason <reason> --region ${region}. Abandoning does not guarantee already-running actions stop; inspect CodeBuild and stop the build explicitly if required. Restore the prior reviewed source ZIP version/configuration and re-run only after confirming application side effects. Keep versioned source/artifact history and logs under retention rules. Reverting pipeline configuration does not undo code already executed by a build. Coordinate role-policy and bucket changes before removing infrastructure.

https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CodeBuild.html
https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-S3Deploy.html
https://docs.aws.amazon.com/codepipeline/latest/userguide/approvals.html
`, findings);
    return { ...result, files: { ...result.files, ...Object.fromEntries(Object.entries(child.files).map(([path, content]) => ['modules/build/' + path, content])),
      ...(approval === 'MANUAL' ? { 'APPROVER-POLICY.json': JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'codepipeline:PutApprovalResult', Resource: 'arn:' + partition + ':codepipeline:' + region + ':' + (parsedRole?.[2] ?? '') + ':' + name + '/Review/ApproveArtifact' }] }, null, 2) + '\n' } : {}),
      'PREFLIGHT.ps1': `$ErrorActionPreference = 'Stop'
${release === 'S3_ZIP' ? `$identityJson = aws sts get-caller-identity --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the current AWS account.' }
if (($identityJson | ConvertFrom-Json).Account -ne '${parsedRole?.[2] ?? ''}') { throw 'Use the configured pipeline account.' }
aws s3api get-bucket-versioning --bucket '${releaseBucket}' --expected-bucket-owner '${parsedRole?.[2] ?? ''}' --region '${region}'
if ($LASTEXITCODE -ne 0) { throw 'Release bucket does not match the expected account or cannot be read.' }
` : ''}
foreach ($bucketName in @(${[...(sourceMode === 'S3' ? [sourceBucket] : []), artifactBucket, ...(release === 'S3_ZIP' ? [releaseBucket] : [])].map(bucket => "'" + bucket + "'").join(', ')}) | Select-Object -Unique) {
  $versioningJson = aws s3api get-bucket-versioning --bucket $bucketName --region '${region}' --output json
  if ($LASTEXITCODE -ne 0) { throw ('Could not read versioning for ' + $bucketName) }
  if (($versioningJson | ConvertFrom-Json).Status -ne 'Enabled') { throw ('Enable versioning before proceeding: ' + $bucketName) }
}
${sourceMode === 'S3' ? `aws s3api head-object --bucket '${sourceBucket}' --key '${sourceKey.replace(/'/g, "''")}' --region '${region}'
if ($LASTEXITCODE -ne 0) { throw 'Could not read the configured source ZIP metadata.' }` : `$connectionJson = aws codeconnections get-connection --connection-arn '${connection}' --region '${region}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Could not read the configured Git connection.' }
if (($connectionJson | ConvertFrom-Json).Connection.ConnectionStatus -ne 'AVAILABLE') { throw 'Complete the external-provider connection authorization before proceeding.' }`}
Write-Host 'Source metadata and bucket versioning checked. Review roles, KMS policies, source contents, commands and potential initial execution.'
`,
    } };
  },
} satisfies Blueprint;

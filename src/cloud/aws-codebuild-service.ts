import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_CODEBUILD_SERVICE = {
  id: 'aws_service_codebuild', label: 'Set up a Linux CodeBuild project',
  description: 'Configure inline build commands with commands-only, S3 ZIP or CodePipeline input, scoped source/artifact/log permissions and retained logs.',
  emits: ['aws_codebuild_project', 'aws_cloudwatch_log_group', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Project name', control: 'text' },
    { id: 'role', label: 'Existing CodeBuild service role ARN', control: 'text', hint: 'Must trust codebuild.amazonaws.com. This package adds a project-specific inline policy to this role.' },
    { id: 'image', label: 'AWS-managed Linux x86 build image', control: 'text', default: 'aws/codebuild/standard:7.0', hint: 'Use an available AWS-managed Linux x86 image in the selected region. Custom images and ARM require another workflow.' },
    { id: 'compute', label: 'Build size', control: 'select', default: 'BUILD_GENERAL1_SMALL', options: ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'].map(value => ({ value, label: value })) },
    { id: 'source', label: 'Source input', control: 'select', default: 'NO_SOURCE', options: [{ value: 'NO_SOURCE', label: 'Commands only — no source download' }, { value: 'S3', label: 'Existing S3 source ZIP' }, { value: 'CODEPIPELINE', label: 'CodePipeline source and output artifacts' }] },
    { id: 'bucket', label: 'Source bucket', control: 'text', showWhen: { input: 'source', equals: ['S3'] }, hint: 'Required for S3 source; existing bucket in the selected region.' },
    { id: 'key', label: 'Source ZIP object key', control: 'text', showWhen: { input: 'source', equals: ['S3'] } },
    { id: 'version', label: 'Source object version ID', control: 'text', showWhen: { input: 'source', equals: ['S3'] }, hint: 'Optional S3 version ID to pin the source ZIP.' },
    { id: 'kms', label: 'Source KMS key ARN', control: 'text', showWhen: { input: 'source', equals: ['S3'] }, hint: 'Optional customer-managed encryption key for the source ZIP. Its key policy must permit this role.' },
    { id: 'artifact_bucket', label: 'Pipeline artifact bucket', control: 'text', showWhen: { input: 'source', equals: ['CODEPIPELINE'] }, hint: 'Existing regional bucket used by the calling CodePipeline.' },
    { id: 'artifact_prefix', label: 'Pipeline artifact prefix', control: 'text', showWhen: { input: 'source', equals: ['CODEPIPELINE'] }, hint: 'The calling pipeline name followed by /; scopes the build role artifact permissions.' },
    { id: 'artifact_kms', label: 'Pipeline artifact KMS key ARN', control: 'text', showWhen: { input: 'source', equals: ['CODEPIPELINE'] }, hint: 'Optional customer-managed key used by the pipeline artifact store. Its policy must permit the build role.' },
    { id: 'artifact_files', label: 'Build output file patterns', control: 'textarea', showWhen: { input: 'source', equals: ['CODEPIPELINE'] }, hint: 'Required for pipeline builds, one relative file/glob pattern per line. Include only intended release artifacts, for example dist/**/*.' },
    { id: 'install', label: 'Install commands', control: 'textarea', hint: 'Optional shell commands, one per line. Do not enter passwords or access keys.' },
    { id: 'commands', label: 'Build and test commands', control: 'textarea', hint: 'Required shell commands, one per line. Runs only when an operator starts a build in AWS.' },
    { id: 'timeout', label: 'Build timeout (minutes)', control: 'number', default: 30 },
    { id: 'retention', label: 'Build log retention (days)', control: 'select', default: '30', options: [7, 14, 30, 60, 90, 180, 365].map(value => ({ value: String(value), label: String(value) })) },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.codebuild.' + path, message, { path }));
    const region = String(values.aws_region ?? ''), partition = awsServicePartition(region), name = String(values.name ?? '').trim();
    const role = String(values.role ?? '').trim(), parsedRole = /^arn:([^:]+):iam::(\d{12}):role\/([A-Za-z0-9+=,.@_/-]+)$/.exec(role);
    const source = String(values.source ?? '');
    const sourceValue = (id: string) => source === 'S3' ? String(values[id] ?? '').trim() : '';
    const bucket = sourceValue('bucket'), key = sourceValue('key'), version = sourceValue('version'), kms = sourceValue('kms');
    const pipelineValue = (id: string) => source === 'CODEPIPELINE' ? String(values[id] ?? '').trim() : '';
    const artifactBucket = pipelineValue('artifact_bucket'), artifactPrefix = pipelineValue('artifact_prefix'), artifactKms = pipelineValue('artifact_kms');
    const artifactFiles = pipelineValue('artifact_files').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const image = String(values.image ?? '').trim(), compute = String(values.compute ?? ''), timeout = Number(values.timeout), retention = Number(values.retention);
    const lines = (id: string) => String(values[id] ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const commands = lines('commands'), install = lines('install');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,119}$/.test(name)) reject('name', 'Use 2–120 letters, numbers, underscores or hyphens, starting with a letter or number. This leaves room for the project policy suffix.');
    if (!parsedRole || parsedRole[1] !== partition) reject('role', 'Enter an existing CodeBuild IAM service role ARN in the selected partition.');
    if (!/^aws\/codebuild\/(?:standard|amazonlinux2-x86_64-standard|amazonlinux-x86_64-standard):\d+\.\d+$/.test(image)) reject('image', 'Use an AWS-managed Linux x86 standard build image with an explicit version.');
    if (!['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE'].includes(compute)) reject('compute', 'Select a supported build size.');
    if (!['NO_SOURCE', 'S3', 'CODEPIPELINE'].includes(source)) reject('source', 'Select a source input.');
    if (source === 'CODEPIPELINE') {
      if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(artifactBucket) || artifactBucket.includes('..')) reject('artifact_bucket', 'Enter the existing pipeline artifact bucket name.');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/$/.test(artifactPrefix)) reject('artifact_prefix', 'Use the exact calling pipeline name followed by /.');
      if (!artifactFiles.length || artifactFiles.length > 100 || artifactFiles.some(pattern => pattern.startsWith('/') || pattern.split('/').includes('..') || /[\x00-\x1f\\]/.test(pattern))) reject('artifact_files', 'Enter 1–100 relative artifact file patterns without dot traversal or control characters.');
      if (artifactKms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(artifactKms)) reject('artifact_kms', 'Use the artifact store KMS key ARN in the selected region and partition.');
    }
    if (source === 'S3') {
      if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) reject('bucket', 'Enter the existing S3 bucket name.');
      if (!key || new TextEncoder().encode(key).length > 1024 || /[\x00-\x1f*?]/.test(key)) reject('key', 'Enter the source ZIP object key, up to 1024 UTF-8 bytes, without control characters or IAM wildcards.');
    }
    if (version.length > 1024 || /[\x00-\x1f]/.test(version)) reject('version', 'Use an S3 object version ID without control characters.');
    if (kms && !new RegExp('^arn:' + partition + ':kms:' + region + ':\\d{12}:key/[A-Za-z0-9-]+$').test(kms)) reject('kms', 'Use a source KMS key ARN in the selected region and partition.');
    if (!commands.length || commands.length > 100 || install.length > 100) reject('commands', 'Enter 1–100 build commands and at most 100 install commands.');
    if ([...commands, ...install].some(command => command.includes('\0'))) reject('commands', 'Commands cannot contain NUL characters.');
    if (!Number.isInteger(timeout) || timeout < 5 || timeout > 2160) reject('timeout', 'Use a whole build timeout from 5 to 2160 minutes.');
    if (![7, 14, 30, 60, 90, 180, 365].includes(retention)) reject('retention', 'Choose a supported log retention.');
    const buildspec = 'version: 0.2\nphases:\n' + (install.length ? '  install:\n    commands:\n' + install.map(command => '      - ' + JSON.stringify(command)).join('\n') + '\n' : '') + '  build:\n    commands:\n' + commands.map(command => '      - ' + JSON.stringify(command)).join('\n') + '\n' + (source === 'CODEPIPELINE' ? 'artifacts:\n  files:\n' + artifactFiles.map(pattern => '    - ' + JSON.stringify(pattern)).join('\n') + '\n' : '');
    if (new TextEncoder().encode(buildspec).length > 25600) reject('commands', 'Keep the inline build specification within 25 KiB.');
    const result = awsServiceModule(region, [
      dat('aws_caller_identity', 'current', {}),
      res('aws_cloudwatch_log_group', 'build', { name: '/aws/codebuild/' + name, retention_in_days: retention }),
      res('aws_iam_role_policy', 'build', { name: name + '-build', role: parsedRole?.[3]?.split('/').at(-1) ?? '', policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: e('"${aws_cloudwatch_log_group.build.arn}:*"') },
        ...(source === 'S3' ? [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: 'arn:' + partition + ':s3:::' + bucket + '/' + key }, { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:GetBucketAcl'], Resource: 'arn:' + partition + ':s3:::' + bucket }] : []),
        ...(kms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:DescribeKey'], Resource: kms }] : []),
        ...(source === 'CODEPIPELINE' ? [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'], Resource: 'arn:' + partition + ':s3:::' + artifactBucket + '/' + artifactPrefix + '*' }, { Effect: 'Allow', Action: ['s3:GetBucketLocation', 's3:GetBucketAcl'], Resource: 'arn:' + partition + ':s3:::' + artifactBucket }] : []),
        ...(artifactKms ? [{ Effect: 'Allow', Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'], Resource: artifactKms }] : []),
      ] })) }),
      res('aws_codebuild_project', 'configured', { name, service_role: role, build_timeout: timeout, queued_timeout: 60, project_visibility: 'PRIVATE', concurrent_build_limit: 1, ...(version && source === 'S3' ? { source_version: version } : {}), depends_on: x('[aws_iam_role_policy.build]') }, [
        blk('source', { type: source, buildspec, ...(source === 'S3' ? { location: bucket + '/' + key } : {}) }),
        blk('artifacts', { type: source === 'CODEPIPELINE' ? 'CODEPIPELINE' : 'NO_ARTIFACTS' }),
        blk('environment', { type: 'LINUX_CONTAINER', compute_type: compute, image, image_pull_credentials_type: 'CODEBUILD', privileged_mode: false }),
        blk('logs_config', {}, [blk('cloudwatch_logs', { status: 'ENABLED', group_name: x('aws_cloudwatch_log_group.build.name') })]),
        blk('lifecycle', {}, [blk('precondition', { condition: x('data.aws_caller_identity.current.account_id == ' + JSON.stringify(parsedRole?.[2] ?? '')), error_message: 'The CodeBuild service role must belong to the deployment account.' })]),
      ]), output('project_name', 'aws_codebuild_project.configured.name'), output('project_arn', 'aws_codebuild_project.configured.arn'),
    ], `# Linux CodeBuild project

## Prepare
Prepare an existing role trusting codebuild.amazonaws.com, restricted to this account and project where practical. This package adds only project-log permissions and selected S3-source/KMS read permissions to that role; review its other policies and other users. Confirm the managed image and compute size are supported in the region. For S3 source, upload a ZIP to the selected regional bucket and preferably pin its version. Cross-account source buckets and KMS keys must separately authorize the role. Source bucket policies, key policies and identity trust are existing prerequisites.

## Implement
Review buildspec.yml and every shell command. Commands execute under the service role when a build starts. Run terraform init, terraform validate and terraform plan -out=service.tfplan; apply the reviewed plan. The project is private, nonprivileged, single-build concurrency, with retained CloudWatch logs. No build is started by Terraform. Run aws codebuild start-build --project-name ${name} --region ${region} when ready; keep the returned build ID. Commands-only mode has no source download. S3 mode extracts the selected ZIP and uses this inline buildspec.

## Verify
For CodePipeline source, configure the calling pipeline with this project and the exact artifact bucket/pipeline-name prefix entered here. Both input and output artifacts are managed by CodePipeline. Start the pipeline rather than starting this build independently. Verify the build output patterns select only intended deliverables; broad patterns can include source code, configuration and unwanted files. Source-bucket fields from S3 mode are inactive in pipeline mode. KMS key policies must authorize artifact use by both pipeline and build roles. This project alone does not create a pipeline or deployment stage.

Run aws codebuild batch-get-builds --ids <returned-build-id> --region ${region}. Check phase statuses, exit code and CloudWatch logs. Deliberately test a failed build command in an isolated test project and verify failure is reported. Check that the role cannot read unrelated source objects. Dependency installation needs network access in the default CodeBuild network. This path does not configure VPC access, repository webhooks, Docker privileged builds, independent S3 artifact publishing, secrets injection or a release pipeline. Use the existing builders for those configurations.

## Recovery
Stop a running build with aws codebuild stop-build --id <build-id> --region ${region}. Restore prior reviewed commands, source version or image and regenerate a plan. CodeBuild cannot reverse arbitrary side effects of user commands; implement application rollback separately. Preserve logs before shortening retention or deleting the project. Removing the inline policy affects this project and any other consumer relying on those permissions; coordinate role ownership.

https://docs.aws.amazon.com/codebuild/latest/userguide/no-source.html
`, findings);
    return { ...result, files: { ...result.files, 'buildspec.yml': buildspec } };
  },
} satisfies Blueprint;

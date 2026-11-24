import { bool,                } from '../kit/blueprint.js';
import { error,              } from '../core/findings.js';
import { blk, dat, hcl, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

const sizes = ['256:512', '256:1024', '512:1024', '1024:2048', '1024:3072', '1024:4096', '2048:4096', '2048:6144', '4096:8192', '4096:10240', '4096:12288'];
export const AWS_APPRUNNER_SERVICE = {
  id: 'aws_service_apprunner', label: 'Deploy an App Runner image — existing customers',
  description: 'Create a public HTTPS container service, scaling configuration and private-ECR pull role for an existing App Runner customer.',
  emits: ['aws_apprunner_service', 'aws_apprunner_auto_scaling_configuration_version', 'aws_iam_role', 'aws_iam_role_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'eligible', label: 'This AWS account is an existing App Runner customer', control: 'toggle', default: false, hint: 'App Runner closed to new customers on April 30, 2026. New customers should choose the appropriate ECS workflow.' },
    { id: 'name', label: 'Service name', control: 'text' },
    { id: 'repository', label: 'Image repository type', control: 'select', default: 'ECR', options: [{ value: 'ECR', label: 'Private ECR in this account and region' }, { value: 'ECR_PUBLIC', label: 'Public ECR' }] },
    { id: 'image', label: 'ECR image URI with tag or digest', control: 'text' },
    { id: 'automatic', label: 'Automatically deploy private image tag updates', control: 'toggle', default: false, showWhen: { input: 'repository', equals: ['ECR'] } },
    { id: 'port', label: 'Application container port', control: 'number', default: 8080, min: 1, max: 65535 },
    { id: 'size', label: 'Instance CPU and memory', control: 'select', default: '1024:2048', options: sizes.map(value => { const [cpu, memory] = value.split(':').map(Number); return { value, label: cpu  / 1024 + ' vCPU / ' + memory + ' MiB' }; }) },
    { id: 'minimum', label: 'Minimum provisioned instances', control: 'number', default: 1, min: 1, max: 25 },
    { id: 'maximum', label: 'Maximum instances', control: 'number', default: 3, min: 1, max: 25 },
    { id: 'concurrency', label: 'Concurrent requests per active instance', control: 'number', default: 100, min: 1, max: 200 },
    { id: 'health', label: 'Health check protocol', control: 'select', default: 'HTTP', options: [{ value: 'HTTP', label: 'HTTP application health' }, { value: 'TCP', label: 'TCP port reachability' }] },
    { id: 'health_path', label: 'HTTP health check path', control: 'text', default: '/health', showWhen: { input: 'health', equals: ['HTTP'] } },
    { id: 'environment', label: 'Non-secret environment variables (JSON)', control: 'textarea', hint: 'Optional string-to-string object. Values are included in the exported configuration.' },
    { id: 'role', label: 'Existing application instance IAM role ARN', control: 'text', hint: 'Optional role trusted by tasks.apprunner.amazonaws.com for the application’s AWS API access.' },
    { id: 'connector', label: 'Existing egress VPC connector ARN', control: 'text', hint: 'Optional connector in this account and region. The incoming service URL remains public HTTPS.' },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.apprunner.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), name = String(values.name ?? ''), repository = String(values.repository ?? ''), image = String(values.image ?? ''), size = String(values.size ?? ''), role = String(values.role ?? '').trim(), connector = String(values.connector ?? '').trim(), health = String(values.health ?? ''), healthPath = String(values.health_path ?? '');
    if (!bool(values, 'eligible')) reject('eligible', 'This setup is available only for an existing App Runner customer account.');
    if (awsServicePartition(location) !== 'aws') reject('aws_region', 'This App Runner workflow supports its available standard-partition regions.');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(name)) reject('name', 'Use 1–24 letters, numbers, hyphens or underscores, beginning with a letter.');
    if (!['ECR', 'ECR_PUBLIC'].includes(repository)) reject('repository', 'Select private or public ECR.');
    const privateImage = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*)(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})$/.exec(image);
    if (repository === 'ECR' && (!privateImage || privateImage[2] !== location)) reject('image', 'Use a private ECR image with tag or digest in the selected region.');
    if (repository === 'ECR_PUBLIC' && !/^public\.ecr\.aws\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})$/.test(image)) reject('image', 'Use a public.ecr.aws image URI with tag or digest.');
    if (repository === 'ECR' && bool(values, 'automatic') && image.includes('@sha256:')) reject('automatic', 'Digest-pinned images require an explicit deployment update; automatic tag deployments need a tagged image.');
    if (!sizes.includes(size)) reject('size', 'Select a supported CPU/memory combination.');
    const accounts           = repository === 'ECR' ? [privateImage?.[1] ?? ''] : [];
    if (role) { const parsed = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]+$/.exec(role); if (!parsed) reject('role', 'Use an existing application IAM role ARN.'); accounts.push(parsed?.[1] ?? ''); }
    if (connector) { const parsed = new RegExp('^arn:aws:apprunner:' + location + ':(\\d{12}):vpcconnector/[A-Za-z0-9_/-]+$').exec(connector); if (!parsed) reject('connector', 'Use a VPC connector ARN in this region.'); accounts.push(parsed?.[1] ?? ''); }
    const integer = (key        , min        , max        ) => { const value = Number(values[key]); if (!Number.isInteger(value) || value < min || value > max) reject(key, 'Enter a whole number from ' + min + ' to ' + max + '.'); return value; };
    const port = integer('port', 1, 65535), minimum = integer('minimum', 1, 25), maximum = integer('maximum', 1, 25), concurrency = integer('concurrency', 1, 200);
    if (minimum > maximum) reject('minimum', 'Minimum instances cannot exceed maximum instances.');
    if (!['HTTP', 'TCP'].includes(health)) reject('health', 'Select a health check protocol.');
    if (health === 'HTTP' && (!healthPath.startsWith('/') || healthPath.length > 512 || /[\r\n]/.test(healthPath))) reject('health_path', 'Enter a health path beginning with /.');
    let environment                         = {};
    try { environment = JSON.parse(String(values.environment || '{}')); if (!environment || Array.isArray(environment) || typeof environment !== 'object' || Object.entries(environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith('AWSAPPRUNNER') || typeof value !== 'string')) throw new Error(); } catch { reject('environment', 'Use a JSON object of nonreserved environment variable names and string values.'); environment = {}; }
    const [cpu, memory] = size.split(':');
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}),
      ...(repository === 'ECR' ? [
        res('aws_iam_role', 'image', { name_prefix: name + '-image-', assume_role_policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'build.apprunner.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }),
        res('aws_iam_role_policy', 'image', { role: x('aws_iam_role.image.id'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
          { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
          { Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage', 'ecr:DescribeImages'], Resource: 'arn:aws:ecr:' + location + ':' + (privateImage?.[1] ?? '') + ':repository/' + (privateImage?.[3] ?? '') },
        ] })) }),
      ] : []),
      res('aws_apprunner_auto_scaling_configuration_version', 'configured', { auto_scaling_configuration_name: name + '-scaling', min_size: minimum, max_size: maximum, max_concurrency: concurrency }),
      res('aws_apprunner_service', 'configured', { service_name: name, auto_scaling_configuration_arn: x('aws_apprunner_auto_scaling_configuration_version.configured.arn'), ...(repository === 'ECR' ? { depends_on: x('[aws_iam_role_policy.image]') } : {}) }, [
        blk('source_configuration', { auto_deployments_enabled: repository === 'ECR' && bool(values, 'automatic') }, [
          ...(repository === 'ECR' ? [blk('authentication_configuration', { access_role_arn: x('aws_iam_role.image.arn') })] : []),
          blk('image_repository', { image_identifier: image, image_repository_type: repository }, [blk('image_configuration', { port: String(port), runtime_environment_variables: x(hcl(environment)) })]),
        ]),
        blk('instance_configuration', { cpu, memory, ...(role ? { instance_role_arn: role } : {}) }),
        blk('network_configuration', {}, [blk('ingress_configuration', { is_publicly_accessible: true }), blk('egress_configuration', connector ? { egress_type: 'VPC', vpc_connector_arn: connector } : { egress_type: 'DEFAULT' })]),
        blk('health_check_configuration', { protocol: health, ...(health === 'HTTP' ? { path: healthPath } : {}), interval: 10, timeout: 5, healthy_threshold: 2, unhealthy_threshold: 5 }),
        ...(accounts.length ? [blk('lifecycle', {}, [blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(accounts) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Use the private image, instance role and VPC connector in the deployment account.' })])] : []),
      ]),
      output('service_url', 'aws_apprunner_service.configured.service_url'), output('service_arn', 'aws_apprunner_service.configured.arn'),
    ], `# App Runner image service for existing customers

## Prepare
AWS closed App Runner to new customers on April 30, 2026. Verify this account remains eligible and the chosen region offers the service. For new customers, use an appropriate ECS workflow. Prepare a compatible container image, listening port and application health endpoint. Review public HTTPS exposure and data handling. If using a VPC egress connector, provide outbound service connectivity and understand that incoming traffic remains public. The optional application role needs tasks.apprunner.amazonaws.com trust and only required runtime permissions.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the image tag/digest, generated private-image pull role, compute size, instance bounds, public endpoint and environment values. Apply the saved plan. The service starts deployment on creation. Public ECR does not use automatic deployments. Digest-pinned images require an explicit image update to deploy a different build.

## Verify
Wait for RUNNING status, inspect deployment events and application logs, and test HTTPS and the real application workflow. Verify HTTP health checks, scaling under representative load and application access to any VPC services. TCP health verifies only port reachability. App Runner container storage is ephemeral; preserve durable state externally. Configure application authentication, log retention and other required protections before production use.

## Recovery
Keep the previous image digest and production endpoint through cutover. Restore the known-good image reference and apply a reviewed deployment if validation fails. Check application/database compatibility before rollback. Pausing or deleting the service does not restore external data. Private ingress, custom domains, secret injection, source-code builds and observability integrations use their corresponding existing builders.

https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
`, findings);
  },
}                    ;

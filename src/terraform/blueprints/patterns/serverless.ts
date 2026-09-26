/**
 * `<p>_app_serverless` (tier pattern `serverless`, addendum A.2.10): an app's
 * functions on the platform's functions service, inside the landing zone.
 *
 *   AWS     Lambda (a container image or a zip in S3) in the app tier, with
 *           IPv6 allowed on a dual-stack network, X-Ray tracing and a log
 *           group of its own, and an execution role
 *   Azure   Functions on an Elastic Premium plan, VNet-integrated through a
 *           delegated subnet, its storage reached by managed identity
 *   Google  Cloud Run functions (2nd gen) with Direct VPC egress, internal
 *           ingress, built from a source archive in Cloud Storage
 *   OCI     OCI Functions: an application in the app tier and its function
 *           from an image in OCI Registry
 *
 * The code is the pipeline's: this builds where it runs, and points at the
 * artefact the pipeline publishes (an image, or an archive in a bucket).
 */

import { error, info, type Finding } from '../../../core/findings.ts';
import type { Blueprint, BlueprintInput, BlueprintValues } from '../../../kit/blueprint.ts';
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import { LANDING_ZONE_SOURCE, blk, jsonencode, lzRef, output, q, res, rname, x, type MigCloud } from '../migration/common.ts';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  appInputs,
  appOf,
  azureDelegatedSubnet,
  ipv6Of,
  isV4Cidr,
  namePrefix,
  patternMainTf,
  preamble,
  securityGroupOf,
  subnetOf,
  subnetsOf,
  tagsExpr,
} from './common.ts';

const RUNTIME: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['python3.12', 'nodejs20.x', 'java21', 'dotnet8'],
  azure: ['python-3.12', 'node-20', 'java-21', 'dotnet-8-isolated'],
  google: ['python312', 'nodejs20', 'java21', 'dotnet8'],
  oci: ['image'],
};

function serverlessInputs(platform: MigCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    ...(platform === 'oci'
      ? []
      : [{ id: 'runtime', label: 'Runtime', control: 'select' as const, default: RUNTIME[platform][0], options: RUNTIME[platform].map((r) => ({ value: r, label: r })) }]),
    { id: 'memory_mb', label: 'Memory (MB)', control: 'select', default: '512', options: ['128', '256', '512', '1024', '2048', '4096'].map((v) => ({ value: v, label: v })) },
    { id: 'timeout_s', label: 'Timeout (seconds)', control: 'number', default: 60, min: 1, max: 900 },
    ...(platform === 'aws'
      ? [
          { id: 'package', label: 'Package', control: 'select' as const, default: 's3', options: [{ value: 's3', label: 'A zip in S3' }, { value: 'image', label: 'A container image in ECR' }] },
          { id: 'artifact', label: 'Artefact', control: 'text' as const, default: 's3://artifacts-bucket/shop/function.zip', hint: 's3://bucket/key for a zip, or the ECR image URI.' },
          { id: 'handler', label: 'Handler', control: 'text' as const, default: 'app.handler', hint: 'Zip packages only.' },
        ]
      : platform === 'azure'
        ? [
            { id: 'sku', label: 'Plan', control: 'select' as const, default: 'EP1', options: ['EP1', 'EP2', 'EP3'].map((v) => ({ value: v, label: `Elastic Premium ${v}` })) },
            { id: 'integration_subnet_cidr', label: 'VNet integration subnet', control: 'text' as const, default: '10.40.253.0/26', hint: 'A free /26 of the network, delegated to App Service (Functions).' },
          ]
        : platform === 'google'
          ? [
              { id: 'artifact', label: 'Source archive', control: 'text' as const, default: 'gs://artifacts-bucket/shop/function.zip', hint: 'gs://bucket/object the pipeline uploads.' },
              { id: 'entry_point', label: 'Entry point', control: 'text' as const, default: 'handler' },
            ]
          : [{ id: 'artifact', label: 'Image', control: 'text' as const, default: 'iad.ocir.io/tenancy/shop/function:1.0.0', hint: 'The function image in OCI Registry.' }]),
    { id: 'max_instances', label: 'Maximum instances', control: 'number', default: 20, min: 1, max: 1000 },
    LANDING_ZONE_SOURCE,
  ];
}

const splitUri = (uri: string, scheme: string): { bucket: string; key: string } | null => {
  const m = new RegExp(`^${scheme}://([^/]+)/(.+)$`).exec(uri.trim());
  return m ? { bucket: m[1] as string, key: m[2] as string } : null;
};

function awsServerless(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'aws'));
  const image = valueOf(values, 'package', 's3') === 'image';
  const artifact = valueOf(values, 'artifact');
  const s3 = splitUri(artifact, 's3');
  if (!image && !s3) findings.push(error('tf.app.serverless-artifact', `"${artifact}" is not s3://bucket/key.`, { path: 'artifact' }));
  return [
    ...preamble('aws', values),
    res('aws_iam_role', 'function', {
      name: x(`"${pfx}-function"`),
      assume_role_policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] })),
      tags,
    }),
    res('aws_iam_role_policy_attachment', 'function_vpc', { role: x('aws_iam_role.function.name'), policy_arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole' }),
    res('aws_iam_role_policy_attachment', 'function_xray', { role: x('aws_iam_role.function.name'), policy_arn: 'arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess' }),
    res('aws_cloudwatch_log_group', 'function', { name: x(`"/aws/lambda/${pfx}"`), retention_in_days: 90, tags }),
    res('aws_lambda_function', 'function', {
      function_name: x(`"${pfx}"`),
      role: x('aws_iam_role.function.arn'),
      package_type: image ? 'Image' : 'Zip',
      image_uri: image ? artifact : undefined,
      s3_bucket: !image ? s3?.bucket ?? '' : undefined,
      s3_key: !image ? s3?.key ?? '' : undefined,
      runtime: image ? undefined : valueOf(values, 'runtime', 'python3.12'),
      handler: image ? undefined : valueOf(values, 'handler', 'app.handler'),
      architectures: ['arm64'],
      memory_size: Number(valueOf(values, 'memory_mb', '512')),
      timeout: numberOf(values, 'timeout_s', 60),
      reserved_concurrent_executions: numberOf(values, 'max_instances', 20),
      tags,
      depends_on: x('[aws_cloudwatch_log_group.function, aws_iam_role_policy_attachment.function_vpc]'),
    }, [
      blk('vpc_config', { subnet_ids: x(subnetsOf(lz, net, 'app')), security_group_ids: x(`[${securityGroupOf(lz, net, 'app')}]`), ipv6_allowed_for_dual_stack: x(ipv6Of(lz, net)) }),
      blk('tracing_config', { mode: 'Active' }),
      blk('logging_config', { log_format: 'JSON', log_group: x('aws_cloudwatch_log_group.function.name') }),
    ]),
    output('function_arn', 'aws_lambda_function.function.arn'),
  ];
}

function azureServerless(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const cidr = valueOf(values, 'integration_subnet_cidr', '10.40.253.0/26');
  if (!isV4Cidr(cidr)) findings.push(error('tf.app.serverless-subnet', `"${cidr}" is not an IPv4 range for the VNet integration subnet.`, { path: 'integration_subnet_cidr' }));
  const runtime = valueOf(values, 'runtime', 'python-3.12');
  const stack: Record<string, Record<string, string | boolean>> = {
    'python-3.12': { python_version: '3.12' },
    'node-20': { node_version: '20' },
    'java-21': { java_version: '21' },
    'dotnet-8-isolated': { dotnet_version: '8.0', use_dotnet_isolated_runtime: true },
  };
  // A storage account name: 3–24 lower-case letters and digits, unique in Azure.
  const account = `substr(replace(lower("${pfx}fn"), "/[^a-z0-9]/", ""), 0, 24)`;
  return [
    ...preamble('azure', values),
    azureDelegatedSubnet('function_integration', lz, net, `"${pfx}-func"`, cidr, 'Microsoft.Web/serverFarms', ['Microsoft.Network/virtualNetworks/subnets/action']),
    res('azurerm_storage_account', 'function', {
      name: x(account),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      account_tier: 'Standard',
      account_replication_type: app.criticality === 'tier0' || app.criticality === 'tier1' ? 'ZRS' : 'LRS',
      min_tls_version: 'TLS1_2',
      https_traffic_only_enabled: true,
      shared_access_key_enabled: false,
      allow_nested_items_to_be_public: false,
      tags,
    }),
    res('azurerm_service_plan', 'function', { name: x(`"${pfx}-func-plan"`), resource_group_name: x(rg), location: x(`${lz}.location`), os_type: 'Linux', sku_name: valueOf(values, 'sku', 'EP1'), maximum_elastic_worker_count: numberOf(values, 'max_instances', 20), tags }),
    res('azurerm_linux_function_app', 'function', {
      name: x(`"${pfx}-func"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      service_plan_id: x('azurerm_service_plan.function.id'),
      storage_account_name: x('azurerm_storage_account.function.name'),
      storage_uses_managed_identity: true,
      https_only: true,
      public_network_access_enabled: false,
      virtual_network_subnet_id: x('azurerm_subnet.function_integration.id'),
      ftp_publish_basic_authentication_enabled: false,
      webdeploy_publish_basic_authentication_enabled: false,
      tags,
    }, [
      blk('identity', { type: 'SystemAssigned' }),
      blk('site_config', { minimum_tls_version: '1.2', ftps_state: 'Disabled', vnet_route_all_enabled: true, elastic_instance_minimum: 1 }, [blk('application_stack', stack[runtime] ?? stack['python-3.12']!)]),
    ]),
    res('azurerm_role_assignment', 'function_storage', {
      scope: x('azurerm_storage_account.function.id'),
      role_definition_name: 'Storage Blob Data Owner',
      principal_id: x('azurerm_linux_function_app.function.identity[0].principal_id'),
    }, [], 'The function reaches its storage with its identity: no account key.'),
    output('default_hostname', 'azurerm_linux_function_app.function.default_hostname'),
  ];
}

function googleServerless(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const artifact = valueOf(values, 'artifact');
  const gs = splitUri(artifact, 'gs');
  if (!gs) findings.push(error('tf.app.serverless-artifact', `"${artifact}" is not gs://bucket/object.`, { path: 'artifact' }));
  return [
    ...preamble('google', values),
    res('google_cloudfunctions2_function', 'function', {
      name: x(`"${pfx}"`),
      project: x(`${lz}.project`),
      location: x(`${lz}.region`),
      labels: x(tagsExpr(app, 'google')),
    }, [
      blk('build_config', { runtime: valueOf(values, 'runtime', 'python312'), entry_point: valueOf(values, 'entry_point', 'handler') }, [blk('source', {}, [blk('storage_source', { bucket: gs?.bucket ?? '', object: gs?.key ?? '' })])]),
      blk('service_config', {
        available_memory: `${valueOf(values, 'memory_mb', '512')}M`,
        timeout_seconds: numberOf(values, 'timeout_s', 60),
        max_instance_count: numberOf(values, 'max_instances', 20),
        min_instance_count: app.criticality === 'tier0' || app.criticality === 'tier1' ? 1 : 0,
        ingress_settings: 'ALLOW_INTERNAL_AND_GCLB',
        all_traffic_on_latest_revision: true,
        service_account_email: x(`${lz}.service_account`),
        vpc_connector_egress_settings: 'PRIVATE_RANGES_ONLY',
      }, [blk('direct_vpc_network_interface', { network: x(`${lz}.network_ids[${q(net)}]`), subnetwork: x(subnetOf(lz, net, 'app')), tags: x(`[${securityGroupOf(lz, net, 'app')}]`) })]),
    ]),
    output('uri', 'google_cloudfunctions2_function.function.url'),
  ];
}

function ociServerless(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const tags = x(tagsExpr(app, 'oci'));
  findings.push(info('tf.app.serverless-oci-policy', 'OCI Functions needs the tenancy policies that let the service use the VCN and read OCI Registry (Allow service faas to use virtual-network-family / read repos in compartment …).', { source: 'https://docs.oracle.com/en-us/iaas/Content/Functions/Tasks/functionscreatingpolicies.htm' }));
  return [
    ...preamble('oci', values),
    res('oci_functions_application', 'function', {
      compartment_id: x(`${lz}.compartment_id`),
      display_name: x(`"${pfx}"`),
      subnet_ids: x(`[${subnetOf(lz, net, 'app')}]`),
      network_security_group_ids: x(`[${securityGroupOf(lz, net, 'app')}]`),
      shape: 'GENERIC_ARM',
      freeform_tags: tags,
    }),
    res('oci_functions_function', 'function', {
      application_id: x('oci_functions_application.function.id'),
      display_name: x(`"${pfx}"`),
      memory_in_mbs: valueOf(values, 'memory_mb', '512'),
      timeout_in_seconds: Math.min(300, numberOf(values, 'timeout_s', 60)),
      freeform_tags: tags,
    }, [blk('source_details', { source_type: 'CONTAINER_IMAGE', image: valueOf(values, 'artifact', 'iad.ocir.io/tenancy/shop/function:1.0.0') })]),
    output('invoke_endpoint', 'oci_functions_function.function.invoke_endpoint'),
  ];
}

const EMITS: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['aws_iam_role', 'aws_iam_role_policy_attachment', 'aws_cloudwatch_log_group', 'aws_lambda_function'],
  azure: ['azurerm_subnet', 'azurerm_storage_account', 'azurerm_service_plan', 'azurerm_linux_function_app', 'azurerm_role_assignment'],
  google: ['google_cloudfunctions2_function'],
  oci: ['oci_functions_application', 'oci_functions_function'],
};
const SERVICE: Readonly<Record<MigCloud, string>> = { aws: 'AWS Lambda', azure: 'Azure Functions', google: 'Cloud Run functions', oci: 'OCI Functions' };

function serverless(platform: MigCloud): Blueprint {
  return {
    id: `${platform}_app_serverless`,
    label: `App functions on ${SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'A Lambda function (a zip in S3 or an ECR image, arm64) in the app tier, IPv6 allowed on a dual-stack network, X-Ray tracing, JSON logs to a log group of its own encrypted with the landing zone\'s key, and an execution role.',
      azure: 'An Elastic Premium plan and a Linux function app, VNet-integrated through a delegated subnet, no public access, its storage account reached by the app\'s managed identity (no shared keys).',
      google: 'A Cloud Run function (2nd gen) built from a source archive in Cloud Storage, Direct VPC egress into the app tier, internal and load-balancer ingress, the landing zone\'s service account and key.',
      oci: 'An OCI Functions application in the app tier (its NSG) and a function from an image in OCI Registry.',
    }[platform],
    inputs: serverlessInputs(platform),
    emits: EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks =
        platform === 'aws' ? awsServerless(values, findings)
        : platform === 'azure' ? azureServerless(values, findings)
        : platform === 'google' ? googleServerless(values, findings)
        : ociServerless(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${SERVICE[platform]}: ${appOf(values).name}`) }, findings };
    },
  };
}

export const SERVERLESS_BLUEPRINTS: readonly Blueprint[] = (['aws', 'azure', 'google', 'oci'] as const).map(serverless);

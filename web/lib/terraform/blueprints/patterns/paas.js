/**
 * `<p>_app_paas_web` (tier pattern `paas-web`, addendum A.4.1): an app's web
 * tier on the platform's managed web runtime.
 *
 *   AWS     Elastic Beanstalk: the application and an environment in the
 *           landing zone's VPC (instances in the app tier, the load balancer
 *           in the web tier), a service role, managed platform updates
 *   Azure   App Service: a plan (zone-redundant for tier 0 / 1) and a Linux or
 *           Windows web app, VNet-integrated through a delegated subnet, HTTPS
 *           only, TLS 1.2+, logs to the landing zone's workspace, and a private
 *           endpoint when the app is internal
 *   Google  Cloud Run: a service with Direct VPC egress into the app tier,
 *           internal (or load-balancer) ingress, the landing zone's service
 *           account; Linux containers only (.NET 8+, Java, Node.js, Python)
 *
 * OCI and VCF have no managed web runtime (the tier pattern offers OKE / VKS
 * or a VM instead), so there is no blueprint for them.
 */

import { error, info,              } from '../../../core/findings.js';
                                                                                            
import { num as numberOf, str as valueOf } from '../../../kit/blueprint.js';
                                             
import {
  LANDING_ZONE_SOURCE,
  blk,
  dat,
  hcl,
  jsonencode,
  lzRef,
  output,
  q,
  res,
  rname,
  x,
} from '../migration/common.js';
import {
  NETWORK_INPUT,
  PATTERN_GROUP,
  appInputs,
  appOf,
  azureDelegatedSubnet,
  isV4Cidr,
  namePrefix,
  patternMainTf,
  preamble,
  subnetOf,
  subnetsOf,
  tagsExpr,
} from './common.js';

export const RUNTIMES = ['dotnet-8', 'dotnet-framework-4.8', 'java-17', 'java-17-tomcat', 'java-17-jboss', 'node-20', 'python-3.12']         ;
                                                

const RUNTIME_OPTIONS = [
  { value: 'dotnet-8', label: '.NET 8 (Linux)' },
  { value: 'dotnet-framework-4.8', label: '.NET Framework 4.8 (Windows)' },
  { value: 'java-17', label: 'Java 17 (Java SE)' },
  { value: 'java-17-tomcat', label: 'Java 17 on Tomcat 10' },
  { value: 'java-17-jboss', label: 'Java 17 on JBoss EAP 8 (Azure)' },
  { value: 'node-20', label: 'Node.js 20' },
  { value: 'python-3.12', label: 'Python 3.12' },
];

function paasInputs(platform                            )                   {
  return [
    ...appInputs(),
    NETWORK_INPUT,
    { id: 'runtime', label: 'Runtime', control: 'select', default: 'dotnet-8', options: RUNTIME_OPTIONS },
    { id: 'exposure', label: 'Exposure', control: 'select', default: 'internal', options: [{ value: 'internal', label: 'Internal (through the app ingress or a private endpoint)' }, { value: 'public', label: 'Public' }] },
    { id: 'instances', label: 'Instances (minimum)', control: 'number', default: 2, min: 1, max: 30 },
    { id: 'max_instances', label: 'Instances (maximum)', control: 'number', default: 6, min: 1, max: 100 },
    { id: 'health_path', label: 'Health check path', control: 'text', default: '/health' },
    ...(platform === 'aws'
      ? [{ id: 'instance_type', label: 'Instance type', control: 'combo'         , default: 'm7i.large', options: ['t3.medium', 'm7i.large', 'm7i.xlarge', 'c7i.large', 'c7i.xlarge', 'r7i.large'].map((v) => ({ value: v, label: v })) }]
      : platform === 'azure'
        ? [
            { id: 'sku', label: 'App Service plan', control: 'select'         , default: 'P1v3', options: ['P0v3', 'P1v3', 'P2v3', 'P3v3', 'P1mv3', 'P2mv3', 'S1', 'B1'].map((v) => ({ value: v, label: v })) },
            { id: 'integration_subnet_cidr', label: 'VNet integration subnet', control: 'text'         , default: '10.40.252.0/26', hint: 'A free /26 (or larger) of the network, delegated to App Service.' },
          ]
        : [
            { id: 'image', label: 'Container image', control: 'text'         , default: 'us-docker.pkg.dev/cloudrun/container/hello', hint: 'The image in Artifact Registry the pipeline builds.' },
            { id: 'cpu', label: 'vCPU per instance', control: 'select'         , default: '1', options: ['1', '2', '4', '8'].map((v) => ({ value: v, label: v })) },
            { id: 'memory', label: 'Memory per instance', control: 'select'         , default: '1Gi', options: ['512Mi', '1Gi', '2Gi', '4Gi', '8Gi', '16Gi'].map((v) => ({ value: v, label: v })) },
          ]),
    LANDING_ZONE_SOURCE,
  ];
}

const runtimeOf = (values                 )          => {
  const r = valueOf(values, 'runtime', 'dotnet-8');
  return (RUNTIMES                     ).includes(r) ? (r           ) : 'dotnet-8';
};

// ---------------------------------------------------------------------------
// AWS Elastic Beanstalk
// ---------------------------------------------------------------------------

/** The newest solution stack of each runtime, by name pattern (AWS renames the platform versions in the middle). */
const EB_STACKS                                    = {
  'dotnet-8': '^64bit Amazon Linux 2023 (.*) running \\.NET 8$',
  'dotnet-framework-4.8': '^64bit Windows Server 2022 (.*) running IIS 10\\.0$',
  'java-17': '^64bit Amazon Linux 2023 (.*) running Corretto 17$',
  'java-17-tomcat': '^64bit Amazon Linux 2023 (.*) running Tomcat 10 Corretto 17$',
  'java-17-jboss': '^64bit Amazon Linux 2023 (.*) running Tomcat 10 Corretto 17$',
  'node-20': '^64bit Amazon Linux 2023 (.*) running Node\\.js 20$',
  'python-3.12': '^64bit Amazon Linux 2023 (.*) running Python 3\\.12$',
};

function awsPaas(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const runtime = runtimeOf(values);
  const internal = valueOf(values, 'exposure', 'internal') !== 'public';
  const min = numberOf(values, 'instances', 2);
  const max = Math.max(min, numberOf(values, 'max_instances', 6));
  const tags = x(tagsExpr(app, 'aws'));
  if (runtime === 'java-17-jboss') findings.push(info('tf.app.paas-jboss-aws', 'Elastic Beanstalk has no JBoss EAP platform: the app runs on Tomcat 10 (Corretto 17), or on EKS / EC2 for JBoss itself.', { path: 'runtime' }));
  const setting = (namespace        , name        , value        ) => blk('setting', { namespace, name, value: x(value) });
  const blocks             = [
    ...preamble('aws', values),
    dat('aws_elastic_beanstalk_solution_stack', 'paas', { most_recent: true, name_regex: EB_STACKS[runtime] }),
    res('aws_iam_role', 'paas_service', {
      name: x(`"${pfx}-eb-service"`),
      assume_role_policy: x(jsonencode({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'elasticbeanstalk.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'sts:ExternalId': 'elasticbeanstalk' } } }] })),
      tags,
    }),
    res('aws_iam_role_policy_attachment', 'paas_health', { role: x('aws_iam_role.paas_service.name'), policy_arn: 'arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth' }),
    res('aws_iam_role_policy_attachment', 'paas_updates', { role: x('aws_iam_role.paas_service.name'), policy_arn: 'arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy' }),
    res('aws_elastic_beanstalk_application', 'paas', { name: x(`"${pfx}"`), description: `${app.name} (${runtime})`, tags }),
    res('aws_elastic_beanstalk_environment', 'paas', {
      name: x(`"${pfx}-${valueOf(values, 'component') ? rname(valueOf(values, 'component')).slice(0, 12) : 'web'}"`),
      application: x('aws_elastic_beanstalk_application.paas.name'),
      solution_stack_name: x('data.aws_elastic_beanstalk_solution_stack.paas.name'),
      tier: 'WebServer',
      tags,
    }, [
      setting('aws:ec2:vpc', 'VPCId', `${lz}.network_ids[${q(net)}]`),
      setting('aws:ec2:vpc', 'Subnets', `join(",", ${subnetsOf(lz, net, 'app')})`),
      setting('aws:ec2:vpc', 'ELBSubnets', `join(",", ${subnetsOf(lz, net, 'web')})`),
      setting('aws:ec2:vpc', 'ELBScheme', q(internal ? 'internal' : 'public')),
      setting('aws:ec2:vpc', 'AssociatePublicIpAddress', '"false"'),
      setting('aws:autoscaling:launchconfiguration', 'IamInstanceProfile', `${lz}.instance_profile`),
      setting('aws:autoscaling:launchconfiguration', 'SecurityGroups', `${lz}.security_group_ids[${q(`${net}/app`)}]`),
      setting('aws:autoscaling:launchconfiguration', 'DisableIMDSv1', '"true"'),
      setting('aws:ec2:instances', 'InstanceTypes', q(valueOf(values, 'instance_type', 'm7i.large'))),
      setting('aws:autoscaling:asg', 'MinSize', q(String(min))),
      setting('aws:autoscaling:asg', 'MaxSize', q(String(max))),
      setting('aws:elasticbeanstalk:environment', 'EnvironmentType', '"LoadBalanced"'),
      setting('aws:elasticbeanstalk:environment', 'LoadBalancerType', '"application"'),
      setting('aws:elasticbeanstalk:environment', 'ServiceRole', 'aws_iam_role.paas_service.name'),
      setting('aws:elasticbeanstalk:environment:process:default', 'HealthCheckPath', q(valueOf(values, 'health_path', '/health'))),
      setting('aws:elasticbeanstalk:healthreporting:system', 'SystemType', '"enhanced"'),
      setting('aws:elasticbeanstalk:managedactions', 'ManagedActionsEnabled', '"true"'),
      setting('aws:elasticbeanstalk:managedactions', 'PreferredStartTime', '"Sun:03:00"'),
      setting('aws:elasticbeanstalk:managedactions:platformupdate', 'UpdateLevel', '"minor"'),
      setting('aws:elasticbeanstalk:cloudwatch:logs', 'StreamLogs', '"true"'),
      setting('aws:elasticbeanstalk:cloudwatch:logs', 'RetentionInDays', '"90"'),
      setting('aws:autoscaling:updatepolicy:rollingupdate', 'RollingUpdateEnabled', '"true"'),
      setting('aws:autoscaling:updatepolicy:rollingupdate', 'RollingUpdateType', '"Health"'),
    ]),
    output('endpoint', 'aws_elastic_beanstalk_environment.paas.endpoint_url', 'The environment\'s load balancer.'),
    output('application', 'aws_elastic_beanstalk_application.paas.name'),
  ];
  findings.push(info('tf.app.paas-eb-ipv6', 'An Elastic Beanstalk environment\'s load balancer is IPv4: put the app ingress (dualstack) in front where IPv6 clients reach it.', { source: 'https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/command-options-general.html' }));
  return blocks;
}

// ---------------------------------------------------------------------------
// Azure App Service
// ---------------------------------------------------------------------------

function azurePaas(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const runtime = runtimeOf(values);
  const windows = runtime === 'dotnet-framework-4.8';
  const internal = valueOf(values, 'exposure', 'internal') !== 'public';
  const min = numberOf(values, 'instances', 2);
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group[${q(net)}]`;
  const cidr = valueOf(values, 'integration_subnet_cidr', '10.40.252.0/26');
  if (!isV4Cidr(cidr)) findings.push(error('tf.app.paas-subnet', `"${cidr}" is not an IPv4 range for the VNet integration subnet.`, { path: 'integration_subnet_cidr' }));
  const zoned = app.criticality === 'tier0' || app.criticality === 'tier1';
  const sku = valueOf(values, 'sku', 'P1v3');
  if (zoned && !/^P\d+m?v3$/.test(sku)) findings.push(info('tf.app.paas-zones', `Zone redundancy needs a Premium v3 plan; ${sku} is written without it.`, { path: 'sku' }));
  const stack                                          = {
    'dotnet-8': { dotnet_version: '8.0' },
    'dotnet-framework-4.8': { current_stack: 'dotnet', dotnet_version: 'v4.0' },
    'java-17': { java_server: 'JAVA', java_server_version: '17', java_version: '17' },
    'java-17-tomcat': { java_server: 'TOMCAT', java_server_version: '10.1', java_version: '17' },
    'java-17-jboss': { java_server: 'JBOSSEAP', java_server_version: '8', java_version: '17' },
    'node-20': { node_version: '20-lts' },
    'python-3.12': { python_version: '3.12' },
  };
  const kind = windows ? 'azurerm_windows_web_app' : 'azurerm_linux_web_app';
  const blocks             = [
    ...preamble('azure', values),
    azureDelegatedSubnet('paas_integration', lz, net, `"${pfx}-appsvc"`, cidr, 'Microsoft.Web/serverFarms', ['Microsoft.Network/virtualNetworks/subnets/action']),
    res('azurerm_service_plan', 'paas', {
      name: x(`"${pfx}-plan"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      os_type: windows ? 'Windows' : 'Linux',
      sku_name: sku,
      worker_count: zoned ? Math.max(3, min) : min,
      zone_balancing_enabled: zoned && /^P\d+m?v3$/.test(sku),
      tags,
    }),
    res(kind, 'paas', {
      name: x(`"${pfx}-web"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      service_plan_id: x('azurerm_service_plan.paas.id'),
      https_only: true,
      public_network_access_enabled: !internal,
      virtual_network_subnet_id: x('azurerm_subnet.paas_integration.id'),
      ftp_publish_basic_authentication_enabled: false,
      webdeploy_publish_basic_authentication_enabled: false,
      client_affinity_enabled: false,
      tags,
    }, [
      blk('identity', { type: 'SystemAssigned, UserAssigned', identity_ids: x(`[${lz}.identity_id]`) }),
      blk('site_config', {
        always_on: true,
        ftps_state: 'Disabled',
        http2_enabled: true,
        minimum_tls_version: '1.2',
        health_check_path: valueOf(values, 'health_path', '/health'),
        health_check_eviction_time_in_min: 5,
        vnet_route_all_enabled: true,
      }, [blk('application_stack', stack[runtime])]),
      blk('logs', { detailed_error_messages: true, failed_request_tracing: true }, [blk('http_logs', {}, [blk('file_system', { retention_in_days: 7, retention_in_mb: 35 })])]),
    ]),
    res('azurerm_monitor_diagnostic_setting', 'paas', {
      name: 'landing-zone',
      target_resource_id: x(`${kind}.paas.id`),
      log_analytics_workspace_id: x(`${lz}.log_destination`),
    }, [
      blk('enabled_log', { category: 'AppServiceHTTPLogs' }),
      blk('enabled_log', { category: 'AppServiceConsoleLogs' }),
      blk('enabled_log', { category: 'AppServiceAppLogs' }),
      blk('enabled_metric', { category: 'AllMetrics' }),
    ]),
  ];
  if (internal) {
    blocks.push(
      res('azurerm_private_endpoint', 'paas', {
        name: x(`"${pfx}-web-pe"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        subnet_id: x(subnetOf(lz, net, 'web')),
        tags,
      }, [blk('private_service_connection', { name: 'web', private_connection_resource_id: x(`${kind}.paas.id`), subresource_names: ['sites'], is_manual_connection: false })]),
    );
    findings.push(info('tf.app.paas-private-dns', 'The private endpoint needs a record in the privatelink.azurewebsites.net private zone linked to the network (the landing zone\'s DNS, or Azure Policy\'s DNS integration).', { source: 'https://learn.microsoft.com/en-us/azure/app-service/networking/private-endpoint' }));
  }
  if (runtime === 'java-17-jboss') findings.push(info('tf.app.paas-jboss', 'JBoss EAP on App Service needs a Premium v3 (or Isolated v2) plan and carries a Red Hat subscription charge per core.', { source: 'https://learn.microsoft.com/en-us/azure/app-service/configure-language-java-deploy-run' }));
  blocks.push(output('default_hostname', `${kind}.paas.default_hostname`), output('principal_id', `${kind}.paas.identity[0].principal_id`, 'The web app\'s system identity, for Key Vault and database access.'));
  return blocks;
}

// ---------------------------------------------------------------------------
// Google Cloud Run
// ---------------------------------------------------------------------------

function googlePaas(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const net = rname(valueOf(values, 'network', 'prod'));
  const runtime = runtimeOf(values);
  const internal = valueOf(values, 'exposure', 'internal') !== 'public';
  const min = numberOf(values, 'instances', 2);
  const max = Math.max(min, numberOf(values, 'max_instances', 6));
  if (runtime === 'dotnet-framework-4.8') {
    findings.push(error('tf.app.paas-cloud-run-windows', '.NET Framework does not run on Cloud Run (Linux containers only): use GKE Windows node pools or a VM.', { path: 'runtime', source: 'https://docs.cloud.google.com/run/docs/container-contract' }));
  }
  const blocks             = [
    ...preamble('google', values),
    res('google_cloud_run_v2_service', 'paas', {
      name: x(`"${pfx}-web"`),
      project: x(`${lz}.project`),
      location: x(`${lz}.region`),
      ingress: internal ? 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' : 'INGRESS_TRAFFIC_ALL',
      deletion_protection: app.criticality === 'tier0' || app.criticality === 'tier1',
      labels: x(tagsExpr(app, 'google')),
    }, [
      blk('template', { service_account: x(`${lz}.service_account`), execution_environment: 'EXECUTION_ENVIRONMENT_GEN2' }, [
        blk('scaling', { min_instance_count: min, max_instance_count: max }),
        blk('containers', { image: valueOf(values, 'image', 'us-docker.pkg.dev/cloudrun/container/hello') }, [
          blk('ports', { container_port: 8080 }),
          blk('resources', { limits: x(hcl({ cpu: valueOf(values, 'cpu', '1'), memory: valueOf(values, 'memory', '1Gi') })), cpu_idle: true, startup_cpu_boost: true }),
          blk('startup_probe', { initial_delay_seconds: 0, period_seconds: 10, failure_threshold: 6 }, [blk('http_get', { path: valueOf(values, 'health_path', '/health') })]),
          blk('liveness_probe', { period_seconds: 30 }, [blk('http_get', { path: valueOf(values, 'health_path', '/health') })]),
        ]),
        blk('vpc_access', { egress: 'PRIVATE_RANGES_ONLY' }, [
          blk('network_interfaces', { network: x(`${lz}.network_ids[${q(net)}]`), subnetwork: x(subnetOf(lz, net, 'app')), tags: x(`[${lz}.security_group_ids[${q(`${net}/app`)}]]`) }),
        ]),
      ]),
    ]),
    output('uri', 'google_cloud_run_v2_service.paas.uri'),
  ];
  if (internal) findings.push(info('tf.app.paas-cloud-run-lb', 'Internal Cloud Run is reached through a load balancer with a serverless NEG (the app ingress); its own URL answers only from inside.', { source: 'https://cloud.google.com/run/docs/securing/ingress' }));
  findings.push(info('tf.app.paas-cloud-run-v6', 'Direct VPC egress sends IPv4 into the subnet; IPv6 egress from Cloud Run through a dual-stack subnet is not written here (verify its status before relying on it).', { source: 'https://cloud.google.com/run/docs/configuring/vpc-direct-vpc' }));
  return blocks;
}

// ---------------------------------------------------------------------------

const EMITS = {
  aws: ['aws_iam_role', 'aws_iam_role_policy_attachment', 'aws_elastic_beanstalk_application', 'aws_elastic_beanstalk_environment'],
  azure: ['azurerm_subnet', 'azurerm_service_plan', 'azurerm_linux_web_app', 'azurerm_windows_web_app', 'azurerm_monitor_diagnostic_setting', 'azurerm_private_endpoint'],
  google: ['google_cloud_run_v2_service'],
}         ;

function paas(platform                            )            {
  const label = { aws: 'AWS Elastic Beanstalk', azure: 'Azure App Service', google: 'Cloud Run' }[platform];
  return {
    id: `${platform}_app_paas_web`,
    label: `App web tier on ${label}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'An Elastic Beanstalk application and environment in the landing zone\'s VPC: instances in the app tier with IMDSv2, the load balancer in the web tier (internal or public), enhanced health, managed platform updates and logs to CloudWatch.',
      azure: 'An App Service plan (zone-redundant for tier 0 and 1) and a Linux or Windows web app, VNet-integrated through a delegated subnet, HTTPS only, TLS 1.2+, no basic-auth publishing, logs to the landing zone\'s workspace, and a private endpoint when internal.',
      google: 'A Cloud Run service with Direct VPC egress into the app tier, internal-load-balancer or public ingress, the landing zone\'s service account and key, and startup and liveness probes.',
    }[platform],
    inputs: paasInputs(platform),
    emits: [...EMITS[platform]],
    build: (values                 ) => {
      const findings            = [];
      const blocks = platform === 'aws' ? awsPaas(values, findings) : platform === 'azure' ? azurePaas(values, findings) : googlePaas(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${label}: ${appOf(values).name}`) }, findings };
    },
  };
}

export const PAAS_BLUEPRINTS                       = (['aws', 'azure', 'google']         ).map(paas);

/**
 * `<p>_app_monitoring` (addendum A.10.14): an app's own monitoring, in every
 * app stack and added by "Deploy a new service". The landing zone's
 * monitoring item collects the logs and metrics (agents, log groups,
 * workspace); this adds, for one app:
 *
 *   - alarms on its VMs (CPU, memory from the agent, status / availability),
 *     its load balancer (5xx, p95 latency) and its databases (CPU, storage,
 *     replica lag), with thresholds by criticality (`THRESHOLDS`);
 *   - a dashboard;
 *   - a synthetic check of each public ingress FQDN;
 *   - a notification target (an email address).
 *
 *   AWS     SNS topic, CloudWatch alarms, a CloudWatch dashboard, Route 53
 *           health checks (public names)
 *   Azure   an action group, metric alerts, Application Insights on the
 *           landing zone's workspace with standard web tests, a portal
 *           dashboard
 *   Google  a notification channel, alert policies on the app's labelled
 *           instances, uptime checks, a Cloud Monitoring dashboard
 *   OCI     a Notifications topic and subscription, Monitoring alarms, an APM
 *           domain with a synthetic monitor per name
 *
 * The app's VMs come from the compute item in the stack (`local.mig_vms`,
 * filtered on atk_app) or, standalone, from a variable of the same shape.
 * VMware targets are monitored by VCF Operations (the base design); there is
 * no blueprint for vSphere.
 */

import { info, type Finding } from '../../../core/findings.ts';
import type { Blueprint, BlueprintInput, BlueprintValues } from '../../../kit/blueprint.ts';
import { str as valueOf } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import { LANDING_ZONE_SOURCE, blk, e, hcl, jsonencode, lzRef, lzSource, output, q, res, rname, variable, x, type MigCloud } from '../migration/common.ts';
import { PATTERN_GROUP, THRESHOLDS, appInputs, appOf, appTagMap, listOf, namePrefix, patternMainTf, preamble, tagsExpr, type AppInfo } from './common.ts';

function monitoringInputs(platform: MigCloud): BlueprintInput[] {
  return [
    ...appInputs(),
    { id: 'alert_email', label: 'Alert email', control: 'text', default: '', hint: 'Where alerts go; blank: the topic / group without a subscriber.' },
    { id: 'fqdns', label: 'Synthetic checks', control: 'text', default: '', hint: 'Public names to check over HTTPS, space-separated (internal names are checked from inside by validate.yml).' },
    { id: 'health_path', label: 'Check path', control: 'text', default: '/' },
    ...(platform === 'aws'
      ? [
          { id: 'lb_arn_suffix', label: 'Load balancer (ARN suffix)', control: 'text' as const, default: '', hint: 'app/<name>/<id> of the app\'s ALB, for 5xx and latency alarms; blank: none.' },
          { id: 'db_instances', label: 'RDS instances', control: 'text' as const, default: '', hint: 'DB instance identifiers, space-separated, for CPU, storage and lag alarms.' },
        ]
      : []),
    {
      id: 'vms_from',
      label: 'The app\'s VMs',
      // A dropdown, not a closed select: the kit builds every select answer as a root module on its own,
      // and `stack` is by definition not one (it reads the compute item's local.mig_vms).
      control: 'combo',
      hint: 'stack: the compute item in this stack; none: an app with no VMs.',
      default: 'landing-zone',
      options: [
        { value: 'landing-zone', label: 'As the landing zone: the stack\'s compute item, or a variable standalone' },
        { value: 'stack', label: 'The compute item in this stack' },
        { value: 'variables', label: 'A variable (standalone)' },
        { value: 'none', label: 'None (no VMs: PaaS, containers)' },
      ],
    },
    LANDING_ZONE_SOURCE,
  ];
}

/** The app's VMs, name → id: from the stack's compute item (filtered on atk_app), a variable, or none. */
function appVms(values: BlueprintValues, app: AppInfo, blocks: HclBlock[]): string {
  const from = valueOf(values, 'vms_from', 'landing-zone');
  const mode = from === 'landing-zone' ? (lzSource(values) === 'stack' ? 'stack' : 'variables') : from;
  if (mode === 'none') return '{}';
  if (mode === 'stack') return `{ for k, v in local.mig_vms : k => local.mig_vm_ids[k] if contains(keys(local.mig_vm_ids), k) && v.tags.atk_app == ${q(app.name)} }`;
  const name = `app_vms_${app.id}`;
  blocks.push(variable(name, 'map(string)', `${app.name}'s VMs to watch: name to instance id (the compute item's output has them).`, { default: '{}' }));
  return `var.${name}`;
}

const cpuOf = (app: AppInfo) => THRESHOLDS[app.criticality];

// ---------------------------------------------------------------------------

function awsMonitoring(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const t = cpuOf(app);
  const tags = x(tagsExpr(app, 'aws'));
  const blocks: HclBlock[] = [...preamble('aws', values)];
  const vms = appVms(values, app, blocks);
  const email = valueOf(values, 'alert_email');
  const period = t.periodMin * 60;
  blocks.push(res('aws_sns_topic', 'alerts', { name: x(`"${pfx}-alerts"`), kms_master_key_id: 'alias/aws/sns', tags }));
  if (email) blocks.push(res('aws_sns_topic_subscription', 'alerts', { topic_arn: x('aws_sns_topic.alerts.arn'), protocol: 'email', endpoint: email }));
  const alarm = (label: string, o: Record<string, unknown>, dims: string) =>
    res('aws_cloudwatch_metric_alarm', label, {
      ...(o as Record<string, never>),
      alarm_actions: x('[aws_sns_topic.alerts.arn]'),
      ok_actions: x('[aws_sns_topic.alerts.arn]'),
      dimensions: x(dims),
      tags,
    });
  blocks.push(
    alarm('vm_cpu', { for_each: x(vms), alarm_name: x(`"${pfx}-\${each.key}-cpu"`), namespace: 'AWS/EC2', metric_name: 'CPUUtilization', statistic: 'Average', period, evaluation_periods: 3, threshold: t.cpu, comparison_operator: 'GreaterThanThreshold', treat_missing_data: 'missing' }, '{ InstanceId = each.value }'),
    alarm('vm_memory', { for_each: x(vms), alarm_name: x(`"${pfx}-\${each.key}-memory"`), namespace: 'CWAgent', metric_name: 'mem_used_percent', statistic: 'Average', period, evaluation_periods: 3, threshold: t.memory, comparison_operator: 'GreaterThanThreshold', treat_missing_data: 'missing' }, '{ InstanceId = each.value }'),
    alarm('vm_status', { for_each: x(vms), alarm_name: x(`"${pfx}-\${each.key}-status"`), namespace: 'AWS/EC2', metric_name: 'StatusCheckFailed', statistic: 'Maximum', period: 60, evaluation_periods: 2, threshold: 0, comparison_operator: 'GreaterThanThreshold', treat_missing_data: 'breaching' }, '{ InstanceId = each.value }'),
  );
  const lb = valueOf(values, 'lb_arn_suffix');
  if (lb) {
    blocks.push(
      alarm('lb_5xx', { alarm_name: x(`"${pfx}-lb-5xx"`), namespace: 'AWS/ApplicationELB', metric_name: 'HTTPCode_Target_5XX_Count', statistic: 'Sum', period: 300, evaluation_periods: 1, threshold: t.http5xx, comparison_operator: 'GreaterThanThreshold', treat_missing_data: 'notBreaching' }, `{ LoadBalancer = ${q(lb)} }`),
      alarm('lb_p95', { alarm_name: x(`"${pfx}-lb-p95"`), namespace: 'AWS/ApplicationELB', metric_name: 'TargetResponseTime', extended_statistic: 'p95', period: 300, evaluation_periods: 2, threshold: t.p95ms / 1000, comparison_operator: 'GreaterThanThreshold', treat_missing_data: 'notBreaching' }, `{ LoadBalancer = ${q(lb)} }`),
    );
  }
  const dbs = listOf(values, 'db_instances');
  if (dbs.length > 0) {
    const set = `toset(${hcl(dbs)})`;
    blocks.push(
      alarm('db_cpu', { for_each: x(set), alarm_name: x(`"${pfx}-\${each.value}-db-cpu"`), namespace: 'AWS/RDS', metric_name: 'CPUUtilization', statistic: 'Average', period, evaluation_periods: 3, threshold: t.cpu, comparison_operator: 'GreaterThanThreshold' }, '{ DBInstanceIdentifier = each.value }'),
      alarm('db_storage', { for_each: x(set), alarm_name: x(`"${pfx}-\${each.value}-db-storage"`), namespace: 'AWS/RDS', metric_name: 'FreeStorageSpace', statistic: 'Minimum', period: 300, evaluation_periods: 1, threshold: 10 * 1024 * 1024 * 1024, comparison_operator: 'LessThanThreshold' }, '{ DBInstanceIdentifier = each.value }'),
      alarm('db_lag', { for_each: x(set), alarm_name: x(`"${pfx}-\${each.value}-db-lag"`), namespace: 'AWS/RDS', metric_name: 'ReplicaLag', statistic: 'Maximum', period: 300, evaluation_periods: 2, threshold: 300, comparison_operator: 'GreaterThanThreshold', treat_missing_data: 'notBreaching' }, '{ DBInstanceIdentifier = each.value }'),
    );
  }
  const fqdns = listOf(values, 'fqdns');
  for (const f of fqdns) {
    blocks.push(res('aws_route53_health_check', `check_${rname(f).replace(/-/g, '_')}`, { fqdn: f, port: 443, type: 'HTTPS', resource_path: valueOf(values, 'health_path', '/'), failure_threshold: 3, request_interval: 30, measure_latency: true, enable_sni: true, tags: x(tagsExpr(app, 'aws', { Name: f })) }));
  }
  if (fqdns.length > 0) findings.push(info('tf.app.monitoring-r53-alarm', 'Route 53 health-check metrics are in us-east-1: an alarm on them is created there (or the health checks are watched in the Route 53 console).', { source: 'https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-monitor-view-status.html' }));
  findings.push(info('tf.app.monitoring-disk', 'Disk alarms per mount need the CloudWatch agent\'s disk dimensions (path, device, fstype): add them per host once the agent reports; the memory alarm uses mem_used_percent with the InstanceId dimension the landing zone\'s agent configuration appends.', { path: 'vms_from' }));
  blocks.push(
    res('aws_cloudwatch_dashboard', 'app', {
      dashboard_name: x(`"${pfx}"`),
      dashboard_body: x(jsonencode({
        widgets: [
          { type: 'metric', x: 0, y: 0, width: 12, height: 6, properties: { title: 'CPU', region: e(`${lz}.region`), stat: 'Average', period: 300, metrics: e(`[for k, id in ${vms} : ["AWS/EC2", "CPUUtilization", "InstanceId", id, { label = k }]]`) } },
          { type: 'metric', x: 12, y: 0, width: 12, height: 6, properties: { title: 'Memory', region: e(`${lz}.region`), stat: 'Average', period: 300, metrics: e(`[for k, id in ${vms} : ["CWAgent", "mem_used_percent", "InstanceId", id, { label = k }]]`) } },
          { type: 'alarm', x: 0, y: 6, width: 24, height: 4, properties: { title: 'Alarms', alarms: e(`concat([for a in aws_cloudwatch_metric_alarm.vm_cpu : a.arn], [for a in aws_cloudwatch_metric_alarm.vm_status : a.arn])`) } },
        ],
      })),
    }),
    output('alert_topic', 'aws_sns_topic.alerts.arn'),
  );
  return blocks;
}

function azureMonitoring(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const t = cpuOf(app);
  const tags = x(tagsExpr(app, 'azure'));
  const rg = `${lz}.resource_group["shared"]`;
  const blocks: HclBlock[] = [...preamble('azure', values)];
  const vms = appVms(values, app, blocks);
  const email = valueOf(values, 'alert_email');
  const window = t.periodMin <= 1 ? 'PT1M' : t.periodMin <= 5 ? 'PT5M' : 'PT15M';
  blocks.push(
    res('azurerm_monitor_action_group', 'alerts', {
      name: x(`"${pfx}-alerts"`),
      resource_group_name: x(rg),
      short_name: app.slug.replace(/-/g, '').slice(0, 12) || 'app',
      enabled: true,
      tags,
    }, email ? [blk('email_receiver', { name: 'owner', email_address: email, use_common_alert_schema: true })] : []),
    res('azurerm_monitor_metric_alert', 'vm_cpu', {
      for_each: x(vms),
      name: x(`"${pfx}-\${each.key}-cpu"`),
      resource_group_name: x(rg),
      scopes: x('[each.value]'),
      severity: app.criticality === 'tier0' ? 1 : 2,
      frequency: window,
      window_size: window === 'PT15M' ? 'PT30M' : 'PT15M',
      tags,
    }, [
      blk('criteria', { metric_namespace: 'Microsoft.Compute/virtualMachines', metric_name: 'Percentage CPU', aggregation: 'Average', operator: 'GreaterThan', threshold: t.cpu }),
      blk('action', { action_group_id: x('azurerm_monitor_action_group.alerts.id') }),
    ]),
    res('azurerm_monitor_metric_alert', 'vm_available', {
      for_each: x(vms),
      name: x(`"${pfx}-\${each.key}-available"`),
      resource_group_name: x(rg),
      scopes: x('[each.value]'),
      severity: app.criticality === 'tier0' ? 0 : 1,
      frequency: 'PT1M',
      window_size: 'PT5M',
      tags,
    }, [
      blk('criteria', { metric_namespace: 'Microsoft.Compute/virtualMachines', metric_name: 'VmAvailabilityMetric', aggregation: 'Average', operator: 'LessThan', threshold: 1 }),
      blk('action', { action_group_id: x('azurerm_monitor_action_group.alerts.id') }),
    ]),
    res('azurerm_application_insights', 'app', {
      name: x(`"${pfx}-ai"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      workspace_id: x(`${lz}.log_destination`),
      application_type: 'web',
      local_authentication_enabled: false,
      tags,
    }),
  );
  findings.push(info('tf.app.monitoring-azure-db', 'Database alerts (CPU, storage, replica lag) are metric alerts on each database resource, whose metric names differ by service: add them per database (the landing zone\'s workspace already has the diagnostics).', { path: 'vms_from' }));
  const fqdns = listOf(values, 'fqdns');
  for (const f of fqdns) {
    const id = `check_${rname(f).replace(/-/g, '_')}`;
    blocks.push(
      res('azurerm_application_insights_standard_web_test', id, {
        name: x(`"${pfx}-${rname(f)}"`),
        resource_group_name: x(rg),
        location: x(`${lz}.location`),
        application_insights_id: x('azurerm_application_insights.app.id'),
        geo_locations: ['emea-nl-ams-azr', 'us-va-ash-azr', 'apac-sg-sin-azr'],
        frequency: 300,
        timeout: 30,
        enabled: true,
        retry_enabled: true,
        tags,
      }, [
        blk('request', { url: `https://${f}${valueOf(values, 'health_path', '/')}`, http_verb: 'GET' }),
        blk('validation_rules', { expected_status_code: 200, ssl_check_enabled: true, ssl_cert_remaining_lifetime: 14 }),
      ]),
    );
  }
  blocks.push(
    res('azurerm_portal_dashboard', 'app', {
      name: x(`"${pfx}-dashboard"`),
      resource_group_name: x(rg),
      location: x(`${lz}.location`),
      dashboard_properties: x(jsonencode({
        lenses: {
          '0': {
            order: 0,
            parts: {
              '0': {
                position: { x: 0, y: 0, colSpan: 6, rowSpan: 4 },
                metadata: { type: 'Extension/HubsExtension/PartType/MarkdownPart', inputs: [], settings: { content: { settings: { content: `## ${app.name}\n\nCriticality ${app.criticality}. Alerts go to the ${app.slug} action group; availability tests are in Application Insights.`, title: app.name } } } },
              },
            },
          },
        },
        metadata: { model: { timeRange: { value: { relative: { duration: 24, timeUnit: 1 } }, type: 'MsPortalFx.Composition.Configuration.ValueTypes.TimeRange' } } },
      })),
      tags,
    }),
    output('application_insights_connection_string', 'azurerm_application_insights.app.connection_string', 'For the app\'s telemetry (sensitive).', true),
  );
  findings.push(info('tf.app.monitoring-azure-geo', 'Standard web tests run from Azure\'s points of presence, so they check public names only; the location ids (emea-nl-ams-azr …) are from the Application Insights list (verify).', { source: 'https://learn.microsoft.com/en-us/azure/azure-monitor/app/availability-standard-tests' }));
  return blocks;
}

function googleMonitoring(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const t = cpuOf(app);
  const project = `${lz}.project`;
  const email = valueOf(values, 'alert_email');
  const label = tagsExpr(app, 'google');
  const appLabel = appTagMap(app, 'google').atk_app ?? app.slug;
  const blocks: HclBlock[] = [...preamble('google', values)];
  const channels = email ? '[google_monitoring_notification_channel.email.id]' : '[]';
  if (email) blocks.push(res('google_monitoring_notification_channel', 'email', { display_name: `${app.name} alerts`, project: x(project), type: 'email', labels: x(hcl({ email_address: email })) }));
  const policy = (id: string, name: string, filter: string, threshold: number) =>
    res('google_monitoring_alert_policy', id, {
      display_name: x(`"${pfx} ${name}"`),
      project: x(project),
      combiner: 'OR',
      enabled: true,
      notification_channels: x(channels),
      severity: app.criticality === 'tier0' ? 'CRITICAL' : 'WARNING',
      user_labels: x(label),
    }, [
      blk('conditions', { display_name: name }, [
        blk('condition_threshold', { filter, comparison: 'COMPARISON_GT', threshold_value: threshold, duration: `${t.periodMin * 60}s` }, [blk('aggregations', { alignment_period: '300s', per_series_aligner: 'ALIGN_MEAN' })]),
      ]),
    ]);
  const byApp = `metadata.user_labels.atk_app = "${appLabel}"`;
  blocks.push(
    policy('cpu', 'CPU', `resource.type = "gce_instance" AND metric.type = "compute.googleapis.com/instance/cpu/utilization" AND ${byApp}`, t.cpu / 100),
    policy('memory', 'memory', `resource.type = "gce_instance" AND metric.type = "agent.googleapis.com/memory/percent_used" AND metric.labels.state = "used" AND ${byApp}`, t.memory),
    policy('disk', 'disk', `resource.type = "gce_instance" AND metric.type = "agent.googleapis.com/disk/percent_used" AND metric.labels.state = "used" AND ${byApp}`, t.disk),
  );
  for (const f of listOf(values, 'fqdns')) {
    const id = `check_${rname(f).replace(/-/g, '_')}`;
    blocks.push(
      res('google_monitoring_uptime_check_config', id, {
        display_name: x(`"${pfx} ${f}"`),
        project: x(project),
        timeout: '10s',
        period: '300s',
        selected_regions: ['EUROPE', 'USA', 'ASIA_PACIFIC'],
      }, [
        blk('http_check', { path: valueOf(values, 'health_path', '/'), port: 443, use_ssl: true, validate_ssl: true, request_method: 'GET' }),
        blk('monitored_resource', { type: 'uptime_url', labels: x(hcl({ project_id: e(project), host: f })) }),
      ]),
    );
  }
  blocks.push(
    res('google_monitoring_dashboard', 'app', {
      project: x(project),
      dashboard_json: x(jsonencode({
        displayName: e(`"${pfx}"`),
        gridLayout: {
          columns: '2',
          widgets: [
            { title: 'CPU', xyChart: { dataSets: [{ timeSeriesQuery: { timeSeriesFilter: { filter: `metric.type="compute.googleapis.com/instance/cpu/utilization" ${byApp}`, aggregation: { alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_MEAN' } } } }] } },
            { title: 'Memory', xyChart: { dataSets: [{ timeSeriesQuery: { timeSeriesFilter: { filter: `metric.type="agent.googleapis.com/memory/percent_used" metric.label.state="used" ${byApp}`, aggregation: { alignmentPeriod: '300s', perSeriesAligner: 'ALIGN_MEAN' } } } }] } },
          ],
        },
      })),
    }),
  );
  findings.push(info('tf.app.monitoring-gcp-agent', 'Memory and disk alerts read the Ops Agent\'s metrics: the agent is installed by the landing zone\'s monitoring item (or the baseline).', { source: 'https://cloud.google.com/monitoring/agent/ops-agent' }));
  return blocks;
}

function ociMonitoring(values: BlueprintValues, findings: Finding[]): HclBlock[] {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const t = cpuOf(app);
  const comp = `${lz}.compartment_id`;
  const tags = x(tagsExpr(app, 'oci'));
  const blocks: HclBlock[] = [...preamble('oci', values)];
  const vms = appVms(values, app, blocks);
  const email = valueOf(values, 'alert_email');
  blocks.push(res('oci_ons_notification_topic', 'alerts', { compartment_id: x(comp), name: x(`"${pfx}-alerts"`), freeform_tags: tags }));
  if (email) blocks.push(res('oci_ons_subscription', 'alerts', { compartment_id: x(comp), topic_id: x('oci_ons_notification_topic.alerts.id'), protocol: 'EMAIL', endpoint: email, freeform_tags: tags }));
  const alarm = (id: string, metric: string, threshold: number, what: string) =>
    res('oci_monitoring_alarm', id, {
      for_each: x(vms),
      compartment_id: x(comp),
      metric_compartment_id: x(comp),
      display_name: x(`"${pfx}-\${each.key}-${what}"`),
      namespace: 'oci_computeagent',
      query: x(`"${metric}[${t.periodMin}m]{resourceId = \\"\${each.value}\\"}.mean() > ${threshold}"`),
      severity: app.criticality === 'tier0' ? 'CRITICAL' : 'WARNING',
      destinations: x('[oci_ons_notification_topic.alerts.id]'),
      is_enabled: true,
      pending_duration: 'PT5M',
      message_format: 'ONS_OPTIMIZED',
      freeform_tags: tags,
    });
  blocks.push(alarm('vm_cpu', 'CpuUtilization', t.cpu, 'cpu'), alarm('vm_memory', 'MemoryUtilization', t.memory, 'memory'));
  const fqdns = listOf(values, 'fqdns');
  if (fqdns.length > 0) {
    blocks.push(res('oci_apm_apm_domain', 'app', { compartment_id: x(comp), display_name: x(`"${pfx}-apm"`), is_free_tier: false, freeform_tags: tags }));
    for (const f of fqdns) {
      blocks.push(
        res('oci_apm_synthetics_monitor', `check_${rname(f).replace(/-/g, '_')}`, {
          apm_domain_id: x('oci_apm_apm_domain.app.id'),
          display_name: x(`"${pfx}-${rname(f)}"`),
          monitor_type: 'REST',
          target: `https://${f}${valueOf(values, 'health_path', '/')}`,
          repeat_interval_in_seconds: 300,
          timeout_in_seconds: 60,
          status: 'ENABLED',
          freeform_tags: tags,
        }, [
          blk('vantage_points', { name: x(`"OraclePublic-\${${lz}.region}"`) }),
          blk('configuration', { config_type: 'REST_CONFIG', is_failure_retried: true, request_method: 'GET', verify_response_codes: ['200'] }),
        ]),
      );
    }
    findings.push(info('tf.app.monitoring-oci-vantage', 'The synthetic monitors run from the public vantage point of the landing zone\'s region (OraclePublic-<region>); an internal name needs a dedicated vantage point in the VCN.', { source: 'https://docs.oracle.com/en-us/iaas/application-performance-monitoring/doc/configure-dedicated-vantage-points.html' }));
  }
  blocks.push(output('alert_topic', 'oci_ons_notification_topic.alerts.id'));
  return blocks;
}

const EMITS: Readonly<Record<MigCloud, readonly string[]>> = {
  aws: ['aws_sns_topic', 'aws_sns_topic_subscription', 'aws_cloudwatch_metric_alarm', 'aws_route53_health_check', 'aws_cloudwatch_dashboard'],
  azure: ['azurerm_monitor_action_group', 'azurerm_monitor_metric_alert', 'azurerm_application_insights', 'azurerm_application_insights_standard_web_test', 'azurerm_portal_dashboard'],
  google: ['google_monitoring_notification_channel', 'google_monitoring_alert_policy', 'google_monitoring_uptime_check_config', 'google_monitoring_dashboard'],
  oci: ['oci_ons_notification_topic', 'oci_ons_subscription', 'oci_monitoring_alarm', 'oci_apm_apm_domain', 'oci_apm_synthetics_monitor'],
};
const CLOUD: Readonly<Record<MigCloud, string>> = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI' };

function monitoring(platform: MigCloud): Blueprint {
  return {
    id: `${platform}_app_monitoring`,
    label: 'App monitoring (alarms, dashboard, synthetic checks)',
    group: PATTERN_GROUP,
    description: `The app's own monitoring on ${CLOUD[platform]}: alarms on its VMs${platform === 'aws' ? ', load balancer and databases' : ''} with thresholds by criticality, a dashboard, a synthetic check of each public name, and an email notification target.`,
    inputs: monitoringInputs(platform),
    emits: EMITS[platform],
    build: (values: BlueprintValues) => {
      const findings: Finding[] = [];
      const blocks = platform === 'aws' ? awsMonitoring(values, findings) : platform === 'azure' ? azureMonitoring(values, findings) : platform === 'google' ? googleMonitoring(values, findings) : ociMonitoring(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${CLOUD[platform]} monitoring: ${appOf(values).name}`) }, findings };
    },
  };
}

export const MONITORING_BLUEPRINTS: readonly Blueprint[] = (['aws', 'azure', 'google', 'oci'] as const).map(monitoring);

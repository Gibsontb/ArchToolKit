import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { output, res, x } from '../terraform/blueprints/migration/common.ts';
import { quote } from '../terraform/hcl.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

const choices = (values: readonly string[]) => values.map(value => ({ value, label: value }));
const statistics = ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'];
const comparisons = [
  { value: 'GreaterThanThreshold', label: 'Above threshold' },
  { value: 'GreaterThanOrEqualToThreshold', label: 'At or above threshold' },
  { value: 'LessThanThreshold', label: 'Below threshold' },
  { value: 'LessThanOrEqualToThreshold', label: 'At or below threshold' },
];
const missingModes = [
  { value: 'missing', label: 'Mark insufficient data when all points are missing' },
  { value: 'ignore', label: 'Keep current state' },
  { value: 'breaching', label: 'Treat missing points as breaching' },
  { value: 'notBreaching', label: 'Treat missing points as within threshold' },
];
const retentionDays = [0, 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
const applyGuide = 'Run terraform init, terraform validate, and terraform plan -out=service.tfplan. Verify the AWS account and review all changes before applying the saved plan.';

export const AWS_CLOUDWATCH_SERVICE: Blueprint = {
  id: 'aws_service_cloudwatch',
  label: 'Set up a CloudWatch metric alarm',
  description: 'Evaluate one existing metric against a static threshold and optionally notify an existing SNS topic.',
  emits: ['aws_cloudwatch_metric_alarm'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Alarm name', control: 'text' },
    { id: 'namespace', label: 'Metric namespace', control: 'combo', options: choices(['AWS/EC2', 'AWS/RDS', 'AWS/Lambda', 'AWS/ApplicationELB', 'CWAgent']) },
    { id: 'metric', label: 'Metric name', control: 'text', placeholder: 'CPUUtilization' },
    { id: 'dimensions', label: 'Metric dimensions', control: 'textarea', hint: 'One exact Name=Value pair per line, for example InstanceId=i-0123456789abcdef0. Leave blank for a metric published without dimensions.' },
    { id: 'statistic', label: 'Statistic', control: 'select', default: 'Average', options: choices(statistics) },
    { id: 'comparison', label: 'Comparison', control: 'select', default: 'GreaterThanThreshold', options: comparisons },
    { id: 'threshold', label: 'Threshold in metric units', control: 'number', default: 80 },
    { id: 'period', label: 'Period in seconds', control: 'number', default: 60, min: 60, hint: 'Use a multiple of 60. Match the source sampling interval.' },
    { id: 'evaluation', label: 'Evaluation periods', control: 'number', default: 3, min: 1 },
    { id: 'datapoints', label: 'Breaching periods required', control: 'number', default: 3, min: 1 },
    { id: 'missing', label: 'Missing data', control: 'select', default: 'missing', options: missingModes },
    { id: 'topic', label: 'Existing SNS topic ARN', control: 'text', hint: 'Optional. Sends notifications on transition to ALARM. Confirm the topic policy and subscriber delivery.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.cloudwatch.' + path, message, { path }));
    const location = String(values.aws_region ?? '');
    const name = String(values.name ?? '').trim();
    const namespace = String(values.namespace ?? '').trim();
    const metric = String(values.metric ?? '').trim();
    for (const [key, value] of [['name', name], ['namespace', namespace], ['metric', metric]] as const) {
      if (value.length < 1 || value.length > 255 || /[\x00-\x1f\x7f]/.test(value)) reject(key, 'Enter 1–255 characters without control characters.');
    }
    const dimensions = new Map<string, string>();
    for (const line of String(values.dimensions ?? '').split(/\r?\n/).filter(line => line.trim())) {
      const separator = line.indexOf('=');
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (separator < 1 || !/^(?!:)[\x20-\x7e]{1,255}$/.test(key) || !/^[\x20-\x7e]{1,1024}$/.test(value) || dimensions.has(key)) {
        reject('dimensions', 'Enter unique ASCII dimension names and nonempty values as Name=Value.');
        continue;
      }
      dimensions.set(key, value);
    }
    if (dimensions.size > 30) reject('dimensions', 'CloudWatch accepts up to 30 metric dimensions.');
    const period = Number(values.period), evaluation = Number(values.evaluation), datapoints = Number(values.datapoints);
    const threshold = Number(values.threshold);
    if (!Number.isInteger(period) || period < 60 || period % 60) reject('period', 'Use a positive multiple of 60 seconds.');
    if (!Number.isInteger(evaluation) || evaluation < 1 || period * evaluation > (period < 3600 ? 86400 : 604800)) {
      reject('evaluation', 'The evaluation window can span up to one day with periods under one hour, or seven days otherwise.');
    }
    if (!Number.isInteger(datapoints) || datapoints < 1 || datapoints > evaluation) reject('datapoints', 'Use 1 through the number of evaluation periods.');
    if (String(values.threshold ?? '').trim() === '' || !Number.isFinite(threshold)) reject('threshold', 'Enter a finite threshold.');
    const statistic = String(values.statistic), comparison = String(values.comparison), missing = String(values.missing);
    if (!statistics.includes(statistic)) reject('statistic', 'Select a supported statistic.');
    if (!comparisons.some(option => option.value === comparison)) reject('comparison', 'Select a comparison.');
    if (!missingModes.some(option => option.value === missing)) reject('missing', 'Select a missing data behavior.');
    const topic = String(values.topic ?? '').trim();
    const partition = awsServicePartition(location);
    const topicArn = /^arn:([^:]+):sns:([^:]+):\d{12}:[A-Za-z0-9_-]{1,256}$/.exec(topic);
    if (topic && (topicArn?.[1] !== partition || topicArn?.[2] !== location)) reject('topic', 'Enter a standard SNS topic ARN in the selected region and partition.');

    return awsServiceModule(location, [
      res('aws_cloudwatch_metric_alarm', 'configured', {
        alarm_name: name, namespace, metric_name: metric, statistic, period, threshold,
        evaluation_periods: evaluation, datapoints_to_alarm: datapoints, comparison_operator: comparison,
        treat_missing_data: missing, alarm_actions: topic ? [topic] : [],
        ...(dimensions.size ? { dimensions: x('{ ' + [...dimensions].map(([key, value]) => quote(key) + ' = ' + quote(value)).join(', ') + ' }') } : {}),
      }),
      output('alarm_arn', 'aws_cloudwatch_metric_alarm.configured.arn'),
    ], `# CloudWatch metric alarm

Confirm the metric is already publishing in the selected account and region. Match its exact namespace, name and dimension set, choose a period consistent with its sampling resolution, then review the threshold and missing-data behavior. If you use SNS, verify the topic policy, any KMS permissions and a confirmed subscriber.

${applyGuide}

Check the metric graph and the alarm history over a full evaluation window. Use a controlled test metric or approved test traffic to verify transitions and notification delivery. If the alarm stays in INSUFFICIENT_DATA, compare the dimension set and sampling interval with the source. Restore the previous threshold, period and actions through a reviewed plan if changes produce incorrect alerts.

https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html
`, findings);
  },
};

export const AWS_CLOUDWATCH_LOGS_SERVICE: Blueprint = {
  id: 'aws_service_cloudwatch_logs',
  label: 'Set up a CloudWatch Logs group',
  description: 'Create a Standard log group with a retention policy and optional customer-managed KMS encryption.',
  emits: ['aws_cloudwatch_log_group'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Log group name', control: 'text', placeholder: '/apps/production/api' },
    { id: 'retention', label: 'Retention', control: 'select', default: '30', options: retentionDays.map(days => ({ value: String(days), label: days ? days + ' days' : 'Never expire' })) },
    { id: 'kms_key', label: 'Existing KMS key ARN', control: 'text', hint: 'Optional. Use an enabled symmetric key in this region whose policy permits CloudWatch Logs.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const location = String(values.aws_region ?? '');
    const name = String(values.name ?? '').trim();
    const retention = Number(values.retention);
    const key = String(values.kms_key ?? '').trim();
    if (!/^[A-Za-z0-9_./#-]{1,512}$/.test(name) || name.startsWith('aws/')) {
      findings.push(error('aws.logs.name', 'Enter a supported log group name that does not start with aws/.', { path: 'name' }));
    }
    if (String(values.retention ?? '').trim() === '' || !retentionDays.includes(retention)) {
      findings.push(error('aws.logs.retention', 'Select a supported retention period.', { path: 'retention' }));
    }
    const partition = awsServicePartition(location);
    const arn = /^arn:([^:]+):kms:([^:]+):\d{12}:key\/(?:mrk-[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(key);
    if (key && (arn?.[1] !== partition || arn?.[2] !== location)) {
      findings.push(error('aws.logs.kms', 'Enter a KMS key ARN in the selected region and partition.', { path: 'kms_key' }));
    }
    return awsServiceModule(location, [
      res('aws_cloudwatch_log_group', 'configured', {
        name, retention_in_days: retention, ...(key ? { kms_key_id: key } : {}),
        skip_destroy: true,
      }),
      output('log_group_name', 'aws_cloudwatch_log_group.configured.name'),
      output('log_group_arn', 'aws_cloudwatch_log_group.configured.arn'),
    ], `# CloudWatch Logs group

Check whether the producer has already created a log group with this name. Import an existing group before managing it. Configure the producer with the output log group name and permissions to create streams and publish events. When using KMS, grant the regional Logs service principal access to the enabled symmetric key, scoped to this group.

${applyGuide}

Confirm retention and encryption in the group details. Emit a test event through the producer and verify it appears in the expected stream and can be read by an authorized reader. Check the producer IAM permissions and KMS policy if ingestion fails.

The deployment preserves the group on Terraform destroy. If the group leaves state, import it before managing it again. Export needed logs before reducing retention. Keep old KMS keys available for events previously encrypted with them.

https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html
`, findings);
  },
};


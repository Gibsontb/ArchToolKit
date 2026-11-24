import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { output, res } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServiceRegion } from './aws-service-module.ts';

const statistics = ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount', 'p95', 'p99'];
export const AWS_DASHBOARD_SERVICE = {
  id: 'aws_service_cloudwatch_dashboard', label: 'Set up a multi-metric CloudWatch dashboard',
  description: 'Build metric widgets from repeatable rows, including multiple metrics per widget, dimensions, statistics and left/right axes.',
  emits: ['aws_cloudwatch_dashboard'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Dashboard name', control: 'text' },
    { id: 'range', label: 'Initial time range', control: 'select', default: '-PT6H', options: [{ value: '-PT1H', label: 'Last hour' }, { value: '-PT6H', label: 'Last 6 hours' }, { value: '-P1D', label: 'Last day' }, { value: '-P7D', label: 'Last 7 days' }] },
    { id: 'metrics', label: 'Metric widget rows', control: 'textarea', default: 'Application | AWS/Lambda | Invocations | FunctionName= | Sum | 300 | left',
      hint: 'Title | Namespace | Metric | Dimensions | Statistic | Period | Axis',
      help: 'Repeat a title to graph multiple metrics together. Dimensions use Name=Value pairs separated by semicolons. Period is seconds.',
      options: [...statistics.map(value => ({ value, label: value, group: 'Statistic' })), ...[60, 300, 900, 3600].map(value => ({ value: String(value), label: String(value), group: 'Period' })), ...['left', 'right'].map(value => ({ value, label: value, group: 'Axis' }))],
    },
  ],
  build(values): ReturnType<typeof awsServiceModule> {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.dashboard.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), name = String(values.name ?? ''), range = String(values.range ?? '');
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(name)) reject('name', 'Use 1–255 letters, numbers, hyphens or underscores.');
    if (!['-PT1H', '-PT6H', '-P1D', '-P7D'].includes(range)) reject('range', 'Select an initial time range.');
    const rows = String(values.metrics ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!rows.length || rows.length > 100) reject('metrics', 'Enter 1–100 metric rows.');
    const widgets = new Map<string, unknown[][]>();
    for (const [index, row] of rows.entries()) {
      const cells = row.split('|').map(value => value.trim());
      if (cells.length !== 7) { reject('metrics', 'Row ' + (index + 1) + ' needs seven columns.'); continue; }
      const [title = '', namespace = '', metric = '', dimensions = '', statistic = '', periodText = '', axis = ''] = cells;
      if ([title, namespace, metric].some(value => !value || value.length > 255 || /[\x00-\x1f\x7f]/.test(value))) reject('metrics', 'Row ' + (index + 1) + ' needs a title, namespace and metric name within 255 characters.');
      if (!statistics.includes(statistic)) reject('metrics', 'Select a supported statistic in row ' + (index + 1) + '.');
      const period = Number(periodText);
      if (!Number.isInteger(period) || period < 60 || period > 86400 || period % 60) reject('metrics', 'Use a period that is a multiple of 60 seconds, up to 86400.');
      if (!['left', 'right'].includes(axis)) reject('metrics', 'Select a left or right axis.');
      const pairs = new Map<string, string>();
      for (const part of dimensions.split(';').map(value => value.trim()).filter(Boolean)) {
        const equal = part.indexOf('='), key = part.slice(0, equal).trim(), value = part.slice(equal + 1).trim();
        if (equal < 1 || !/^(?!:)[\x20-\x7e]{1,255}$/.test(key) || !/^[\x20-\x7e]{1,1024}$/.test(value) || pairs.has(key)) reject('metrics', 'Use unique nonempty Name=Value dimension pairs in row ' + (index + 1) + '.');
        else pairs.set(key, value);
      }
      if (pairs.size > 30) reject('metrics', 'A metric supports at most 30 dimensions.');
      const series: unknown[] = [namespace, metric, ...[...pairs].flat(), { stat: statistic, period, yAxis: axis }];
      const metrics = widgets.get(title) ?? [];
      metrics.push(series); widgets.set(title, metrics);
    }
    const body = { start: range, periodOverride: 'inherit', widgets: [...widgets].map(([title, metrics], index) => ({ type: 'metric', x: index % 2 * 12, y: Math.floor(index / 2) * 6, width: 12, height: 6, properties: { title, region: location, view: 'timeSeries', metrics, period: 300, stat: 'Average' } })) };
    const json = JSON.stringify(body, null, 2);
    const result = awsServiceModule(location, [res('aws_cloudwatch_dashboard', 'configured', { dashboard_name: name, dashboard_body: json }), output('dashboard_arn', 'aws_cloudwatch_dashboard.configured.dashboard_arn')], `# Multi-metric CloudWatch dashboard

## Prepare
Identify exact existing metric namespaces, names, dimensions, statistics and sampling intervals in the selected region. A dashboard does not create or publish metrics. Repeat a widget title for multiple series on one graph; separate dimensions with semicolons. Review existing dashboard ownership because names are account-global. The operator needs dashboard-management permission and viewers need access to the underlying metrics.

## Implement
Review dashboard.json alongside the Terraform configuration. Run terraform init, terraform validate and terraform plan -out=service.tfplan, then apply the saved plan. The form arranges metric widgets in two columns and preserves each row's statistic, period and axis. The selected region applies to all widgets in this supported path.

## Verify
Open the dashboard and confirm every series has the expected data, labels, units, aggregation and freshness. Check missing data against the metric's exact dimension set and period before changing configuration. Validate left/right scales and percentile meaning with application owners. Empty graphs are not evidence of zero usage or a healthy application.

## Recovery
Preserve the previous dashboard JSON before updating a dashboard already managed elsewhere. Restore the previous reviewed configuration if graphs or layout are incorrect. Removing a dashboard does not delete the underlying metrics. Alarm widgets, metric math, logs queries, cross-region/account graphs and other layouts use the existing dashboard-body builder.

https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Dashboard-Body-Structure.html
`, findings);
    return { ...result, files: { ...result.files, 'dashboard.json': json } };
  },
} satisfies Blueprint;

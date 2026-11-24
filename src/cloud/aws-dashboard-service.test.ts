import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DASHBOARD_SERVICE } from './aws-dashboard-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_DASHBOARD_SERVICE), aws_region: 'us-east-1', name: 'application-metrics', metrics: 'Functions | AWS/Lambda | Invocations | FunctionName=orders | Sum | 300 | left\nFunctions | AWS/Lambda | Errors | FunctionName=orders | Sum | 60 | right\nDatabase | AWS/RDS | CPUUtilization | DBInstanceIdentifier=orders-db | Average | 300 | left' };

test('CloudWatch dashboard groups multiple metrics and preserves dimensions, axes and layout', () => {
  assert.ok(addServicesFor('aws').find(row => row.id === 'amazon-cloudwatch')?.terraform.includes(AWS_DASHBOARD_SERVICE));
  const result = AWS_DASHBOARD_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const dashboard = JSON.parse(result.files['dashboard.json']!);
  assert.equal(dashboard.widgets.length, 2);
  assert.equal(dashboard.widgets[0].properties.metrics.length, 2);
  assert.equal(dashboard.widgets[0].properties.metrics[1].at(-1).yAxis, 'right');
  assert.equal(dashboard.widgets[1].x, 12);
  assert.deepEqual(dashboard.widgets[0].properties.metrics[0].slice(0, 4), ['AWS/Lambda', 'Invocations', 'FunctionName', 'orders']);
});

test('CloudWatch dashboard validates exact dimension pairs and statistical periods', () => {
  const multidimensional = AWS_DASHBOARD_SERVICE.build({ ...values, metrics: 'Host | CWAgent | disk_used_percent | path=/;device=xvda;fstype=xfs | Average | 300 | left' });
  assert.deepEqual(multidimensional.findings, []);
  const invalid = AWS_DASHBOARD_SERVICE.build({ ...values, metrics: 'Functions | AWS/Lambda | Errors | FunctionName= | invalid | 17 | center' });
  assert.ok(invalid.findings.length >= 4);
  assert.ok(AWS_DASHBOARD_SERVICE.build({ ...values, metrics: 'incomplete | row' }).findings.some(finding => finding.path === 'metrics'));
});

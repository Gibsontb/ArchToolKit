import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_PROMETHEUS_SERVICE } from './aws-prometheus-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_PROMETHEUS_SERVICE), aws_region: 'us-east-1', name: 'application-metrics' };

test('Managed Prometheus exports protected workspace and concrete post-apply remote-write configuration', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-managed-service-for-prometheus')?.terraform[0], AWS_PROMETHEUS_SERVICE);
  const result = AWS_PROMETHEUS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /prevent_destroy\s+= true/);
  assert.match(result.files['outputs.tf']!, /yamlencode/);
  assert.match(result.files['outputs.tf']!, /prometheus_endpoint}api\/v1\/remote_write/);
  assert.match(result.files['outputs.tf']!, /sigv4/);
  assert.doesNotMatch(result.files['main.tf']!, /resource "aws_iam_role_policy"/);
});

test('Managed Prometheus scopes ingest/query policies and validates role/key partitions', () => {
  const result = AWS_PROMETHEUS_SERVICE.build({ ...values, writer: 'arn:aws:iam::123456789012:role/agents/MetricsWriter', reader: 'arn:aws:iam::123456789012:role/MetricsReader' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /aps:RemoteWrite/);
  assert.match(result.files['main.tf']!, /aps:QueryMetrics/);
  assert.match(result.files['main.tf']!, /Resource\s+= aws_prometheus_workspace.configured.arn/);
  assert.match(result.files['main.tf']!, /role\s+= "MetricsWriter"/);
  const invalid = AWS_PROMETHEUS_SERVICE.build({ ...values, writer: 'arn:aws-us-gov:iam::123456789012:role/Writer', kms: 'arn:aws:kms:us-west-2:123456789012:key/abc' });
  for (const path of ['writer', 'kms']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});

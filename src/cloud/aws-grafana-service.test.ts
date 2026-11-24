import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_GRAFANA_SERVICE } from './aws-grafana-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_GRAFANA_SERVICE), aws_region: 'us-east-1', identity_region: 'us-east-2', name: 'application-metrics', store: 'd-0123456789', admins: '12345678-abcd-4bcd-8bcd-123456789abc', role: 'arn:aws:iam::123456789012:role/GrafanaQuery', endpoints: 'vpce-0123456789abcdef0' };
test('Grafana configures restricted ingress, existing home-region identity groups and metric-only role', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-managed-grafana')?.terraform[0], AWS_GRAFANA_SERVICE);
  const result = AWS_GRAFANA_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/network_access_control/, /CUSTOMER_MANAGED/, /CURRENT_ACCOUNT/, /AWS_SSO/, /aws\.identitycenter/, /aws_identitystore_group/, /cloudwatch:GetMetricData/, /prevent_destroy\s+= true/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /resource "aws_iam_role" "query|logs:Get|= "jsonencode|aws_grafana_workspace_api_key/);
  assert.match(result.files['SETUP-DATASOURCES.py']!, /if not args.apply/);
  assert.match(result.files['SETUP-DATASOURCES.py']!, /Refusing authenticated redirect/);
});
test('Grafana private data-source networking is independent from workspace access', () => {
  const result = AWS_GRAFANA_SERVICE.build({ ...values, cloudwatch: 'NO', prometheus: 'arn:aws:aps:us-east-1:123456789012:workspace/ws-12345678-abcd-4bcd-8bcd-123456789abc', outbound: 'YES', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /vpc_configuration/);
  assert.match(result.files['main.tf']!, /available_ip_address_count >= 15/);
  assert.doesNotMatch(result.files['main.tf']!, /cloudwatch:Get/);
  assert.equal(JSON.parse(result.files['DATA-SOURCES.json']!).length, 1);
  assert.match(JSON.parse(result.files['DATA-SOURCES.json']!)[0].url, /aps-workspaces\.us-east-1/);
  assert.deepEqual(AWS_GRAFANA_SERVICE.build({ ...values, subnets: 'stale', groups: 'stale' }).findings, []);
});
test('Grafana rejects unbounded ingress, overlapping identity roles and invalid data-source boundary', () => {
  for (const [key, value] of Object.entries({ role: 'invalid', admins: '', identity_region: 'cn-north-1', endpoints: '', store: 'invalid', editors: values.admins, prometheus: 'arn:aws:aps:eu-west-1:123456789012:workspace/ws-12345678-abcd-4bcd-8bcd-123456789abc' })) assert.ok(AWS_GRAFANA_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === (key === 'editors' ? 'admins' : key)), key);
});

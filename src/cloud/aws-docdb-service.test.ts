import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_DOCDB_SERVICE } from './aws-docdb-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_DOCDB_SERVICE), aws_region: 'us-east-1', name: 'application-documents', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1,subnet-0123456789abcdef2', clients: 'sg-0123456789abcdef0' };
test('DocumentDB creates actual instances with distinct AZ placement and managed credentials', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-documentdb-with-mongodb-compatibility')?.terraform[0], AWS_DOCDB_SERVICE);
  const result = AWS_DOCDB_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /data "aws_docdb_engine_version"/);
  assert.match(main, /data "aws_docdb_orderable_db_instance"/);
  assert.match(main, /resource "aws_docdb_cluster_instance"/);
  assert.match(main, /count\s+= 3/);
  assert.match(main, /node-\$\{count.index \+ 1\}/);
  assert.match(main, /manage_master_user_password\s+= true/);
  assert.doesNotMatch(main, /\bmaster_password\s*=/);
  assert.match(result.files['outputs.tf']!, /retryWrites=false/);
});
test('DocumentDB configures both audit parameter and log export with explicit retention and TLS', () => {
  const result = AWS_DOCDB_SERVICE.build({ ...values, nodes: '2', storage: 'iopt1', audit: 'ddl,dml_write', log_days: '180', username: 'docdbadmin' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /tls1.2\+/);
  assert.match(result.files['main.tf']!, /audit_logs/);
  assert.match(result.files['main.tf']!, /enabled_cloudwatch_logs_exports\s+= \["audit"\]/);
  assert.match(result.files['main.tf']!, /retention_in_days\s+= 180/);
  assert.match(result.files['main.tf']!, /storage_type\s+= "iopt1"/);
  assert.doesNotMatch(result.files['CHECK.js']!, /insert|update|delete|drop/);
});
test('DocumentDB rejects incomplete multi-AZ topology and unsafe or unsupported inputs', () => {
  for (const [key, value] of Object.entries({ subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', nodes: 4, username: 'bad_user', version: '3.6.0', audit: 'disabled', retention: 0, kms: 'bad' })) assert.ok(AWS_DOCDB_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_RDS_SQLSERVER_SERVICE } from './aws-rds-sqlserver-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_RDS_SQLSERVER_SERVICE), aws_region: 'us-east-1', name: 'application-sql', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', groups: 'sg-0123456789abcdef0' };
test('SQL Server RDS derives engine family/class support and creates forced TLS without exposing passwords', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-relational-database-service')?.terraform[1], AWS_RDS_SQLSERVER_SERVICE);
  const result = AWS_RDS_SQLSERVER_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /aws_rds_engine_version/);
  assert.match(result.files['main.tf']!, /aws_rds_orderable_db_instance/);
  assert.match(result.files['main.tf']!, /preferred_instance_classes/);
  assert.match(result.files['main.tf']!, /instance_class\s+= data.aws_rds_orderable_db_instance.selected.instance_class/);
  assert.match(result.files['main.tf']!, /family\s+= data.aws_rds_engine_version.selected.parameter_group_family/);
  assert.match(result.files['main.tf']!, /rds.force_ssl/);
  assert.match(result.files['main.tf']!, /manage_master_user_password\s+= true/);
  assert.doesNotMatch(result.files['main.tf']!, /\bdb_name\s*=|\bpassword\s*=/);
  assert.match(result.files['SETUP.sql']!, /CREATE DATABASE \[application\] COLLATE SQL_Latin1_General_CP1_CI_AS/);
});
test('SQL Server editions preserve express single-AZ and request multi-AZ offering support for other editions', () => {
  const express = AWS_RDS_SQLSERVER_SERVICE.build({ ...values, engine: 'sqlserver-ex', availability: 'true' });
  assert.deepEqual(express.findings, []);
  assert.match(express.files['main.tf']!, /multi_az\s+= false/);
  assert.doesNotMatch(express.files['main.tf']!, /supports_multi_az/);
  for (const engine of ['sqlserver-web', 'sqlserver-se', 'sqlserver-ee']) {
    const result = AWS_RDS_SQLSERVER_SERVICE.build({ ...values, engine, availability: 'true', version: '16.00.4215.2.v1' });
    assert.deepEqual(result.findings, []);
    assert.match(result.files['main.tf']!, /supports_multi_az\s+= true/);
    assert.match(result.files['main.tf']!, /version\s+= "16.00.4215.2.v1"/);
  }
});
test('SQL Server bootstrap identifiers and encryption/storage constraints reject invalid inputs', () => {
  for (const [key, value] of Object.entries({ database: 'master', collation: 'x; DROP DATABASE application', storage: 1, kms: 'invalid', username: 'sa', version: 'bad version', snapshot: 'trailing-', retention: 0 })) assert.ok(AWS_RDS_SQLSERVER_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
  const explicit = AWS_RDS_SQLSERVER_SERVICE.build({ ...values, instance: 'db.m6i.large' });
  assert.deepEqual(explicit.findings, []);
  assert.doesNotMatch(explicit.files['main.tf']!, /preferred_instance_classes/);
  assert.match(explicit.files['main.tf']!, /instance_class\s+= "db.m6i.large"/);
});

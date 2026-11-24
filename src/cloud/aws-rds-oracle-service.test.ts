import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_RDS_ORACLE_SERVICE } from './aws-rds-oracle-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_RDS_ORACLE_SERVICE), aws_region: 'us-east-1', name: 'application-oracle', version: '19.0.0.0.ru-2026-01.rur-2026-01.r1', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0' };
test('Oracle RDS restricts client access to the TLS listener and keeps credentials managed', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-relational-database-service')?.terraform[2], AWS_RDS_ORACLE_SERVICE);
  const result = AWS_RDS_ORACLE_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  assert.match(main, /option_name\s+= "SSL"/);
  assert.match(main, /SQLNET.SSL_VERSION/);
  assert.match(main, /from_port\s+= 2484/);
  assert.doesNotMatch(main, /from_port\s+= 1521|cidr_blocks|\bpassword\s*=/);
  assert.match(main, /manage_master_user_password\s+= true/);
  assert.match(main, /vpc_security_group_ids\s+= \[aws_security_group.database.id\]/);
  assert.match(result.files['outputs.tf']!, /PROTOCOL=TCPS/);
  assert.match(result.files['CHECK.sql']!, /NETWORK_PROTOCOL/);
});
test('Oracle licensing and multi-AZ choices flow into exact regional compatibility checks', () => {
  for (const [edition, engine, license] of [['se2-li', 'oracle-se2', 'license-included'], ['se2-byol', 'oracle-se2', 'bring-your-own-license'], ['ee-byol', 'oracle-ee', 'bring-your-own-license']]) {
    const result = AWS_RDS_ORACLE_SERVICE.build({ ...values, edition, availability: 'true' });
    assert.deepEqual(result.findings, []);
    assert.match(result.files['main.tf']!, new RegExp('engine\\s+= "' + engine + '"'));
    assert.match(result.files['main.tf']!, new RegExp('license_model\\s+= "' + license + '"'));
    assert.match(result.files['main.tf']!, /supports_multi_az\s+= true/);
    assert.match(result.files['main.tf']!, /min_storage_size/);
  }
});
test('Oracle rejects unsupported major versions, missing clients and unsafe identifiers', () => {
  for (const [key, value] of Object.entries({ version: '21.0', edition: 'ee-li', clients: '', subnets: 'subnet-0123456789abcdef0', database: 'SYS', username: 'system', storage: 0, retention: 36, kms: 'bad', snapshot: 'bad--snapshot' })) assert.ok(AWS_RDS_ORACLE_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});

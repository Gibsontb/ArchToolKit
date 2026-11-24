import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_KEYSPACES_SERVICE as blueprint } from './aws-keyspaces-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'records', keyspace: 'application', role: 'arn:aws:iam::123456789012:role/CassandraApplication', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc' };
test('Keyspaces creates a protected encrypted table with real schema and exact application access', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-keyspaces-for-apache-cassandra')?.terraform[0], blueprint);
  const result = blueprint.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/aws_keyspaces_keyspace/, /aws_keyspaces_table/, /SINGLE_REGION/, /CUSTOMER_MANAGED_KMS_KEY/, /point_in_time_recovery/, /partition_key/, /clustering_key/, /cassandra:Select/, /keyspace\/system\*/, /prevent_destroy/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /cassandra:Modify|client_side_timestamps|default_time_to_live|cassandra:\*/);
  assert.match(result.files['CHECK.py']!, /get_table/);
  assert.doesNotMatch(result.files['CHECK.py']!, /execute_statement|\.execute\(|put_item/);
});
test('Keyspaces existing/provisioned mode adds static columns and reviewed expiry/timestamps without claiming an undo', () => {
  const result = blueprint.build({ ...values, create: 'EXISTING', capacity: 'PROVISIONED', reads: 50, writes: 25, access: 'WRITE', ttl: 3600, timestamps: 'YES', columns: String(defaultValues(blueprint).columns) + '\nsummary | text | STATIC | ' });
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.doesNotMatch(main, /resource "aws_keyspaces_keyspace"/);
  for (const pattern of [/read_capacity_units\s+= 50/, /write_capacity_units\s+= 25/, /static_column/, /default_time_to_live\s+= 3600/, /client_side_timestamps/, /cassandra:Modify/]) assert.match(main, pattern);
  const config = JSON.parse(result.files['CLIENT-CONFIG.json']!);
  assert.equal(config.schema.staticColumns[0].name, 'summary');
});
test('Keyspaces rejects invalid key schema, values and encryption boundaries', () => {
  for (const columns of ['value | text | REGULAR | ', 'id | blob | PARTITION | ', 'id | text | PARTITION | DESC', 'id | text | PARTITION | \nid | int | REGULAR | ', 'id | text | PARTITION | \nvalue | text | STATIC | ']) assert.ok(blueprint.build({ ...values, columns }).findings.some(f => f.path === 'columns'));
  for (const [key, value] of Object.entries({ name: 'bad-name', keyspace: 'system_custom', kms: '', role: 'bad', capacity: 'AUTO', ttl: -1, timestamps: 'true' })) assert.ok(blueprint.build({ ...values, [key]: value }).findings.some(f => f.path === key), key);
  assert.deepEqual(blueprint.build({ ...values, reads: 'bad', writes: 'bad' }).findings, []);
});

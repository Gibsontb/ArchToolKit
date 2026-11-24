import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_MSK_SERVERLESS_SERVICE } from './aws-msk-serverless-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_MSK_SERVERLESS_SERVICE), aws_region: 'us-east-1', name: 'application-kafka', role: 'arn:aws:iam::123456789012:role/KafkaApplication', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', topics: 'orders,events', groups: 'workers' };
test('MSK Serverless configures private IAM access with exact topic/group resources', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-managed-streaming-for-apache-kafka')?.terraform[0], AWS_MSK_SERVERLESS_SERVICE);
  const result = AWS_MSK_SERVERLESS_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/aws_msk_serverless_cluster/, /from_port\s+= 9098/, /client_authentication/, /:topic\//, /:group\//, /ReadData/, /WriteData/, /prevent_destroy\s+= true/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /0\.0\.0\.0|CreateTopic|kafka-cluster:\*|= "jsonencode/);
  assert.match(result.files['CHECK.py']!, /allow_auto_create_topics=False/);
  assert.match(result.files['CHECK.py']!, /group_id=None/);
});
test('Read and write paths omit unused permissions and hidden consumer inputs', () => {
  const read = AWS_MSK_SERVERLESS_SERVICE.build({ ...values, access: 'READ' });
  assert.doesNotMatch(read.files['main.tf']!, /WriteData/);
  const write = AWS_MSK_SERVERLESS_SERVICE.build({ ...values, access: 'WRITE', groups: '*' });
  assert.deepEqual(write.findings, []);
  assert.doesNotMatch(write.files['main.tf']!, /ReadData|AlterGroup|:group\//);
  assert.deepEqual(JSON.parse(write.files['CLIENT-CONFIG.json']!).consumer_groups, []);
  assert.match(AWS_MSK_SERVERLESS_SERVICE.build({ ...values, create_topics: 'YES' }).files['main.tf']!, /CreateTopic/);
});
test('MSK rejects unsupported regional deployment and wildcard identities', () => {
  for (const [key, value] of Object.entries({ aws_region: 'us-gov-west-1', role: 'invalid', subnets: 'subnet-0123456789abcdef0', clients: 'invalid', topics: '*', groups: 'workers*', access: 'ADMIN' })) assert.ok(AWS_MSK_SERVERLESS_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});

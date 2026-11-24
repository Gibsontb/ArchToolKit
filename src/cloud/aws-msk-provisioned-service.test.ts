import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_MSK_PROVISIONED_SERVICE as blueprint } from './aws-msk-provisioned-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(blueprint), aws_region: 'us-east-1', name: 'application-kafka', role: 'arn:aws:iam::123456789012:role/KafkaApplication', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', topics: 'orders,events', groups: 'workers', kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc', log_kms: 'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abd' };
test('provisioned Kafka preserves Serverless and emits sized encrypted private Standard brokers', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-managed-streaming-for-apache-kafka')?.terraform[1], blueprint);
  const result = blueprint.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/aws_msk_cluster/, /aws_msk_configuration/, /number_of_broker_nodes\s+= 2/, /volume_size\s+= 1000/, /client_broker\s+= "TLS"/, /in_cluster\s+= true/, /unauthenticated\s+= false/, /scram\s+= false/, /type\s+= "DISABLED"/, /use1-az3/, /availability-zone/, /kafka-cluster:WriteData/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /0\.0\.0\.0|CreateTopic|kafka-cluster:\*|aws_msk_serverless_cluster/);
  assert.match(result.files['BROKER-PROPERTIES.txt']!, /default.replication.factor=2\nmin.insync.replicas=1/);
  assert.match(result.files['CHECK.py']!, /allow_auto_create_topics=False/);
});
test('provisioned Kafka derives replication defaults and scopes application modes', () => {
  const result = blueprint.build({ ...values, subnets: values.subnets + ',subnet-0123456789abcdef2', access: 'READ' });
  assert.match(result.files['BROKER-PROPERTIES.txt']!, /default.replication.factor=3\nmin.insync.replicas=2/);
  assert.doesNotMatch(result.files['main.tf']!, /WriteData/);
  const write = blueprint.build({ ...values, access: 'WRITE', groups: '*', create_topics: 'YES' });
  assert.deepEqual(write.findings, []);
  assert.doesNotMatch(write.files['main.tf']!, /ReadData|AlterGroup/);
  assert.match(write.files['main.tf']!, /CreateTopic/);
});
test('provisioned Kafka rejects wildcard targets, mismatched keys and unsupported sizing', () => {
  for (const [key, value] of Object.entries({ version: '3.5.1', size: 'express.m7g.large', per_az: 11, storage: 99, retention: 0, kms: '', log_kms: values.kms.replace('us-east-1', 'us-west-2'), role: 'bad', topics: '*', groups: '*' })) assert.ok(blueprint.build({ ...values, [key]: value }).findings.some(f => f.path === key), key);
  assert.ok(blueprint.build({ ...values, aws_region: 'us-west-1', subnets: values.subnets + ',subnet-0123456789abcdef2' }).findings.some(f => f.path === 'subnets'));
});

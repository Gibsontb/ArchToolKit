import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_ACTIVEMQ_SERVICE } from './aws-activemq-service.ts';
import { AWS_MQ_SERVICE } from './aws-mq-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_ACTIVEMQ_SERVICE), aws_region: 'us-east-1', name: 'application-broker', version: '5.18', admin_user: 'brokeradmin', clients: 'sg-0123456789abcdef0', admins: 'sg-0123456789abcdef1', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1' };
test('ActiveMQ adds private HA/EFS and scoped users without changing preferred RabbitMQ flow', () => {
  const forms = addServicesFor('aws').find(row => row.id === 'amazon-mq')!.terraform;
  assert.equal(forms[0], AWS_MQ_SERVICE);
  assert.ok(forms.includes(AWS_ACTIVEMQ_SERVICE));
  const result = AWS_ACTIVEMQ_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/ActiveMQ/, /ACTIVE_STANDBY_MULTI_AZ/, /storage_type\s+= "EFS"/, /publicly_accessible\s+= false/, /from_port\s+= 61617/, /from_port\s+= 8162/, /console_access = false/, /audit\s+= "true"/, /aws:SourceArn/, /mq_application_password/]) assert.match(main, pattern);
  assert.doesNotMatch(main, /0\.0\.0\.0\/0|from_port\s+= 61616|= "jsonencode/);
  assert.match(result.files['variables.tf']!, /sensitive\s+= true/);
});
test('ActiveMQ restricts destinations and temporary destinations with explicit XML authorization', () => {
  const result = AWS_ACTIVEMQ_SERVICE.build({ ...values, access: 'READWRITE', protocols: 'OPENWIRE,STOMP', topics: 'events' }), xml = result.files['BROKER-CONFIG.xml']!;
  assert.match(xml, /queue physicalName="application.jobs"/);
  assert.match(xml, /topic physicalName="application.events"/);
  assert.match(xml, /queue="application.&gt;"/);
  assert.match(xml, /tempDestinationAuthorizationEntry read="broker-admins" write="broker-admins" admin="broker-admins"/);
  assert.match(xml, /advisorySupport="false"/);
  assert.match(result.files['main.tf']!, /from_port\s+= 61614/);
  assert.match(result.files['LOG-RETENTION.ps1']!, /if \(-not \$Apply\)/);
});
test('ActiveMQ single EBS mode is explicit and HA ignores hidden single storage', () => {
  const single = AWS_ACTIVEMQ_SERVICE.build({ ...values, mode: 'SINGLE_INSTANCE', subnets: 'subnet-0123456789abcdef0', storage: 'EBS' });
  assert.deepEqual(single.findings, []);
  assert.match(single.files['main.tf']!, /storage_type\s+= "EBS"/);
  assert.deepEqual(AWS_ACTIVEMQ_SERVICE.build({ ...values, storage: 'stale' }).findings, []);
});
test('ActiveMQ rejects invalid topology, protocol, reserved destinations and role collisions', () => {
  for (const [key, value] of Object.entries({ subnets: 'subnet-0123456789abcdef0', protocols: '', app_user: values.admin_user, prefix: 'ActiveMQ.', version: 'latest', queues: '*', time: '25:00' })) assert.ok(AWS_ACTIVEMQ_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});

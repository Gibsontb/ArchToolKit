import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_NLB_SERVICE } from './aws-nlb-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_NLB_SERVICE), aws_region: 'us-east-1', name: 'application-network', subnets: 'subnet-0123456789abcdef0', groups: 'sg-0123456789abcdef0', instances: 'i-0123456789abcdef0', certificate: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-abcd-abcd-abcd-123456789abc' };

test('NLB is available beside ALB and exports TLS listeners with network checks', () => {
  assert.ok(addServicesFor('aws').find(row => row.id === 'elastic-load-balancing')?.terraform.includes(AWS_NLB_SERVICE));
  const result = AWS_NLB_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /load_balancer_type\s+= "network"/);
  assert.match(code, /security_groups\s+= \["sg-/);
  assert.match(code, /enable_deletion_protection\s+= true/);
  assert.match(code, /certificate_arn/);
  assert.match(code, /available_ip_address_count >= 8/);
});

test('NLB TCP forwarding needs no certificate and rejects incompatible target protocols', () => {
  const tcp = AWS_NLB_SERVICE.build({ ...values, listener: 'TCP', certificate: '' });
  assert.deepEqual(tcp.findings, []);
  assert.doesNotMatch(tcp.files['main.tf']!, /certificate_arn|ssl_policy/);
  const invalid = AWS_NLB_SERVICE.build({ ...values, listener: 'TCP', target_protocol: 'TLS', listener_port: 0, instances: '' });
  for (const path of ['target_protocol', 'listener_port', 'instances']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});

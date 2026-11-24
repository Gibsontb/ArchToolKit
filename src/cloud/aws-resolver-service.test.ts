import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_RESOLVER_SERVICE } from './aws-resolver-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_RESOLVER_SERVICE), aws_region: 'us-east-1', name: 'application-dns', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: '10.100.0.0/24' };
test('Inbound Resolver uses private IPv4, two-AZ checks and approved UDP/TCP clients without stale outbound rules', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-route-53-resolver')?.terraform[0], AWS_RESOLVER_SERVICE);
  const result = AWS_RESOLVER_SERVICE.build({ ...values, targets: 'invalid', domains: '*' });
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.match(main, /resolver_endpoint_type\s+= "IPV4"/);
  assert.match(main, /availability_zone/);
  assert.match(main, /10.100.0.0\/24/);
  assert.match(main, /protocol\s+= "udp"/);
  assert.match(main, /protocol\s+= "tcp"/);
  assert.doesNotMatch(main, /egress \{|aws_route53_resolver_rule"/);
});
test('Outbound Resolver creates each unique suffix rule and scopes egress to target DNS hosts', () => {
  const result = AWS_RESOLVER_SERVICE.build({ ...values, direction: 'OUTBOUND', clients: 'bad', targets: '10.100.0.10,10.100.0.11', domains: 'Corp.Example.org.,services.internal,corp.example.org' });
  assert.deepEqual(result.findings, []);
  const main = result.files['main.tf']!;
  assert.equal((main.match(/resource "aws_route53_resolver_rule"/g) ?? []).length, 2);
  assert.equal((main.match(/resource "aws_route53_resolver_rule_association"/g) ?? []).length, 2);
  assert.match(main, /10.100.0.10\/32/);
  assert.match(main, /domain_name\s+= "corp.example.org"/);
  assert.doesNotMatch(main, /ingress \{|10.100.0.0\/24/);
});
test('Resolver rejects unrestricted clients, malformed DNS suffixes and nonunicast targets', () => {
  assert.ok(AWS_RESOLVER_SERVICE.build({ ...values, clients: '0.0.0.0/0' }).findings.some(finding => finding.path === 'clients'));
  const outbound = { ...values, direction: 'OUTBOUND', targets: '10.100.0.10', domains: 'corp.example.org' };
  for (const domains of ['.', '*.example.org', 'corp..example.org', '-bad.example.org']) assert.ok(AWS_RESOLVER_SERVICE.build({ ...outbound, domains }).findings.some(finding => finding.path === 'domains'));
  for (const targets of ['127.0.0.1', '224.0.0.1', '::1', '0.0.0.0']) assert.ok(AWS_RESOLVER_SERVICE.build({ ...outbound, targets }).findings.some(finding => finding.path === 'targets'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_EKS_SERVICE } from './aws-eks-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_EKS_SERVICE), aws_region: 'us-east-1', name: 'application-cluster', version: '1.34',
  subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', cluster_role: 'arn:aws:iam::123456789012:role/EksCluster',
  node_role: 'arn:aws:iam::123456789012:role/EksNodes', admin: 'arn:aws:iam::123456789012:role/EksAdmin' };

test('EKS wires private managed cluster with explicit administration and encrypted nodes', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-elastic-kubernetes-service')?.terraform[0], AWS_EKS_SERVICE);
  const result = AWS_EKS_SERVICE.build(values);
  assert.deepEqual(result.findings, []);
  const code = result.files['main.tf']!;
  assert.match(code, /endpoint_public_access\s+= false/);
  assert.match(code, /bootstrap_cluster_creator_admin_permissions\s+= false/);
  assert.match(code, /AmazonEKSClusterAdminPolicy/);
  assert.match(code, /resource "aws_eks_node_group"/);
  assert.match(code, /encrypted\s+= true/);
  assert.match(code, /http_tokens\s+= "required"/);
  assert.match(code, /prevent_destroy\s+= true/);
  assert.match(code, /supported_architectures/);
  assert.match(result.files['SERVICE-SETUP.md']!, /kubectl get nodes/);
});

test('EKS supports restricted public API access and rejects open networks or inconsistent scaling', () => {
  const result = AWS_EKS_SERVICE.build({ ...values, endpoint: 'both', public_cidrs: '192.0.2.0/24,198.51.100.8/32' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /endpoint_public_access\s+= true/);
  for (const public_cidrs of ['0.0.0.0/0', '192.0.2.8/24', '999.0.0.0/8', '']) {
    assert.ok(AWS_EKS_SERVICE.build({ ...values, endpoint: 'both', public_cidrs }).findings.some(finding => finding.path === 'public_cidrs'));
  }
  const invalid = AWS_EKS_SERVICE.build({ ...values, desired: 0, node_role: values.cluster_role, admin: 'arn:aws-us-gov:iam::123456789012:role/Admin', version: '', subnets: '' });
  for (const path of ['desired', 'node_role', 'admin', 'version', 'subnets']) assert.ok(invalid.findings.some(finding => finding.path === path), path);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultValues } from '../kit/blueprint.ts';
import { AWS_FSX_ONTAP_SERVICE } from './aws-fsx-ontap-service.ts';
import { addServicesFor } from './add-service-catalog.ts';
const values = { ...defaultValues(AWS_FSX_ONTAP_SERVICE), aws_region: 'us-east-1', name: 'application-ontap', subnets: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1', clients: 'sg-0123456789abcdef0', admins: 'sg-0123456789abcdef1', client_cidrs: '10.20.0.0/24,10.30.0.0/24', routes: 'rtb-0123456789abcdef0' };
test('ONTAP configures one-pair protected NFS target with sensitive deploy-time password', () => {
  assert.equal(addServicesFor('aws').find(row => row.id === 'amazon-fsx')?.terraform[0], AWS_FSX_ONTAP_SERVICE);
  const result = AWS_FSX_ONTAP_SERVICE.build(values), main = result.files['main.tf']!;
  assert.deepEqual(result.findings, []);
  for (const pattern of [/MULTI_AZ_2/, /ha_pairs\s+= 1/, /throughput_capacity_per_ha_pair\s+= 384/, /fsx_admin_password\s+= var.fsx_admin_password/, /skip_final_backup\s+= false/, /size_in_megabytes\s+= 65536/, /name = "NONE"/, /cidrhost/]) assert.match(main, pattern);
  assert.match(result.files['variables.tf']!, /sensitive\s+= true/);
  assert.doesNotMatch(main, /0\.0\.0\.0\/0|svm_admin_password/);
  assert.match(result.files['ONTAP-CONFIG.txt']!, /-superuser none/);
  assert.match(result.files['ONTAP-CONFIG.txt']!, /-user 1000 -group 1000 -unix-permissions 0750/);
  assert.match(result.files['MOUNT-READONLY.sh']!, /ro,nfsvers=4\.1,sec=sys/);
});
test('Single-AZ ONTAP ignores hidden floating network and throughput inputs', () => {
  const result = AWS_FSX_ONTAP_SERVICE.build({ ...values, deployment: 'SINGLE_AZ_2', subnets: 'subnet-0123456789abcdef0', routes: 'stale', endpoint_cidr: 'stale', throughput_first: 'stale', throughput_multi2: 'stale' });
  assert.deepEqual(result.findings, []);
  assert.match(result.files['main.tf']!, /throughput_capacity_per_ha_pair\s+= 1536/);
  assert.doesNotMatch(result.files['main.tf']!, /endpoint_ip_address_range|route_table_ids|stale/);
});
test('ONTAP rejects misaligned/broad exports, oversized volumes and invalid route inputs', () => {
  for (const [key, value] of Object.entries({ client_cidrs: '0.0.0.0/0', endpoint_cidr: '198.19.0.1/24', volume_gib: 1024, uid: 0, retention: 0, routes: '', subnets: 'subnet-0123456789abcdef0' })) assert.ok(AWS_FSX_ONTAP_SERVICE.build({ ...values, [key]: value }).findings.some(finding => finding.path === key), key);
});

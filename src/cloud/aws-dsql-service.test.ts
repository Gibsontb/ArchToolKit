import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_DSQL_SERVICE as blueprint} from './aws-dsql-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-database',account:'123456789012',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',role:'arn:aws:iam::123456789012:role/application'};
test('DSQL creates protected customer-key single-Region cluster and actual cell-service endpoint without implicit SQL/policy grants',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-aurora-dsql')?.terraform[0],blueprint);
  const result=blueprint.build(values);assert.deepEqual(result.findings,[]);
  assert.match(result.files['main.tf']!,/deletion_protection_enabled\s+= true/);assert.match(result.files['main.tf']!,/aws_dsql_cluster.configured.vpc_endpoint_service_name/);
  assert.match(result.files['main.tf']!,/private_dns_enabled\s+= true/);assert.match(result.files['main.tf']!,/from_port\s+= 5432/);
  assert.doesNotMatch(result.files['main.tf']!,/aws_dsql_cluster_policy|resource "aws_iam_role_policy"|multi_region_properties|0\.0\.0\.0\/0|local-exec/);
  assert.match(result.files['AUTHORIZE-REVIEW.sql']!,/AWS IAM GRANT app_user TO 'arn:aws:iam::123456789012:role\/application'/);
  assert.doesNotMatch(result.files['INSPECT.py']!,/put_cluster_policy\(|generate_db_connect|psycopg|execute\(/);
  assert.match(result.files['CHECK-CONNECTION.py']!,/confirm-approved-connect/);assert.match(result.files['CHECK-CONNECTION.py']!,/sslmode='verify-full'/);
  assert.doesNotMatch(result.files['CHECK-CONNECTION.py']!,/generate_db_connect_admin_auth_token|CREATE |INSERT |UPDATE |DELETE /);
});
test('DSQL rejects unavailable region, wrong owner key/role and unsafe SQL/network identifiers',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-west-1',name:'bad name',account:'bad',kms:'alias/aws',subnets:'subnet-12345678,subnet-12345678',clients:'0.0.0.0/0',role:'arn:aws:iam::000000000000:role/application',db_role:'admin',schema:'x;DROP SCHEMA public'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const aws_region of ['us-east-2','us-west-2'])assert.deepEqual(blueprint.build({...values,aws_region,kms:values.kms.replace('us-east-1',aws_region)}).findings,[]);
});

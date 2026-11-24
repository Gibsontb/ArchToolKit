import {test} from 'node:test';import assert from 'node:assert/strict';import {AWS_S3_SERVICE,validS3BucketName} from './aws-s3-service.ts';import {defaultValues} from '../kit/blueprint.ts';import {addServicesFor} from './add-service-catalog.ts';
const valid=()=>({...defaultValues(AWS_S3_SERVICE),aws_region:'us-gov-west-1',bucket_name:'agency-test-storage-2026'});
const build=(extra={})=>AWS_S3_SERVICE.build({...valid(),...extra},'storage');
test('S3 configuration is the default S3 service form and exports a private storage implementation',()=>{
 assert.equal(addServicesFor('aws').find(row=>row.id==='amazon-simple-storage-service').terraform[0],AWS_S3_SERVICE);
 const result=build();assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=Object.values(result.files).join('\n');
 for(const expected of ['us-gov-west-1','BucketOwnerEnforced','block_public_policy = true','force_destroy = false','aws:SecureTransport','sse_algorithm = "AES256"','prevent_destroy = true'])assert.ok(code.includes(expected),expected);
 assert.ok(!code.includes('aws_instance'));assert.ok(result.files['SERVICE-SETUP.md'].includes('get-bucket-encryption'));
});
test('S3 bucket names reject reserved, uppercase, IP and invalid forms',()=>{
 for(const name of ['ABC','ab','a..b','192.168.1.1','xn--bucket','my-bucket--x-s3','my-bucket--table-s3','my-bucket-s3alias','my_bucket','my-bucket-an'])assert.equal(validS3BucketName(name),false,name);
 assert.ok(validS3BucketName('storage.example-2026'));
});
test('S3 dependent selections validate retention, lifecycle and logging',()=>{
 assert.ok(build({lock_mode:'COMPLIANCE',versioning:'Suspended'}).findings.some(f=>f.code==='aws.s3.lock-versioning'));
 assert.ok(build({transition_class:'STANDARD_IA',transition_days:10}).findings.some(f=>f.severity==='error'));
 assert.ok(build({transition_class:'GLACIER',transition_days:30,expire_days:10}).findings.some(f=>f.code==='aws.s3.expiration-order'));
 assert.ok(build({logging:'true',log_bucket:'agency-test-storage-2026'}).findings.some(f=>f.code==='aws.s3.logging'));
 const result=build({encryption:'aws:kms',kms_key:'alias/storage',lock_mode:'GOVERNANCE',lock_days:365,transition_class:'GLACIER',transition_days:90,expire_days:400,noncurrent_days:30,logging:'true',log_bucket:'agency-access-logs'});
 assert.equal(result.findings.filter(f=>f.severity==='error').length,0);const code=Object.values(result.files).join('\n');
 for(const expected of ['kms_master_key_id = "alias/storage"','bucket_key_enabled = true','mode = "GOVERNANCE"','storage_class = "GLACIER"','target_bucket = "agency-access-logs"','noncurrent_days = 30'])assert.ok(code.includes(expected),expected);
 const dsse=build({encryption:'aws:kms:dsse'});assert.ok(!dsse.files['main.tf'].includes('bucket_key_enabled'));
});

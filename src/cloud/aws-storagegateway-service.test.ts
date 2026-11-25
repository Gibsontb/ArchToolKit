import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_STORAGEGATEWAY_SERVICE as blueprint} from './aws-storagegateway-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-files',account:'123456789012',gateway:'arn:aws:storagegateway:us-east-1:123456789012:gateway/sgw-1234ABCD',bucket:'approved-file-storage',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',audit:'/approved/file-audit',clients:'10.20.0.0/24'};
test('S3 File Gateway restricts the new role/share and preserves existing appliance/storage',()=>{
  assert.equal(addServicesFor('aws').find(row=>row.id==='aws-storage-gateway')?.terraform[0],blueprint);
  for(const mode of ['READ_ONLY','READ_WRITE']){
    const result=blueprint.build({...values,mode}); assert.deepEqual(result.findings,[]);
    assert.match(result.files['main.tf']!,/resource "aws_storagegateway_nfs_file_share"/);
    assert.doesNotMatch(result.files['main.tf']!,/resource "aws_s3_bucket"|resource "aws_storagegateway_gateway"|resource "aws_storagegateway_cache"|local-exec/);
    assert.match(result.files['main.tf']!,/aws:SourceArn/);
    assert.equal(result.files['main.tf']!.includes('s3:PutObject"'),mode==='READ_WRITE');
    assert.match(result.files['main.tf']!,/bucket-owner-full-control/);
    assert.doesNotMatch(result.files['main.tf']!,/0777|0666|NoSquash|0\.0\.0\.0\/0/);
    assert.doesNotMatch(result.files['INSPECT.py']!,/get_object\(|put_object\(|mount\(|refresh_cache\(/);
  }
});
test('S3 File Gateway validates private exact client networks, ownership, encryption and identities',()=>{
  for(const [key,value]of Object.entries({aws_region:'us-gov-west-1',name:'bad name',account:'wrong',gateway:'arn:aws:storagegateway:us-west-2:123456789012:gateway/sgw-1234ABCD',bucket:'bucket.with.dots',prefix:'files',kms:'alias/default',audit:'',clients:'0.0.0.0/0',mode:'OTHER',squash:'NoSquash',uid:0,gid:-1,ttl:1,storage:'S3_ONEZONE_IA',permissions:'0777'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const clients of ['10.20.0.1/24','10.20.0.0/24/extra','10.0.0.0/8','203.0.113.1/32','10.20.0.0/24,10.20.0.0/24'])assert.ok(blueprint.build({...values,clients}).findings.some(f=>f.path==='clients'));
});

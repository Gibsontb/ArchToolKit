import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultValues} from '../kit/blueprint.ts';
import {AWS_COGNITO_IDENTITY_SERVICE as blueprint} from './aws-cognito-identity-service.ts';
import {addServicesFor} from './add-service-catalog.ts';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-identity',account:'123456789012',user_pool:'us-east-1_Approved123',client:'approvedclient12345',bucket:'approved-shared-documents',kms:'arn:aws:kms:us-east-1:123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc',approved:'true'};
test('Federated Identities has its own authenticated-only pool and exact shared read grant, distinct from user-pool API alias',()=>{
  const service=addServicesFor('aws').find(s=>s.id==='amazon-cognito-identity')!;assert.equal(service.terraform[0],blueprint);assert.equal(service.setupAliasOf,undefined);assert.ok(service.terraform.length>1);
  const r=blueprint.build(values);assert.deepEqual(r.findings,[]);const main=r.files['main.tf']!;
  assert.match(main,/allow_unauthenticated_identities\s+= false/);assert.match(main,/allow_classic_flow\s+= false/);assert.match(main,/server_side_token_check\s+= true/);assert.match(main,/cognito-identity.amazonaws.com:aud/);assert.match(main,/aws_cognito_identity_pool.configured.id/);
  const policy=JSON.parse(r.files['ACCESS-POLICY-REVIEW.json']!);assert.deepEqual(policy.Statement.flatMap((s:{Action:string[]})=>s.Action),['s3:GetObject','s3:ListBucket','kms:Decrypt']);assert.deepEqual(policy.Statement[0].Resource,['arn:aws:s3:::approved-shared-documents/approved/*']);
  assert.doesNotMatch(main,/role_mapping|openid_connect_provider_arns|saml_provider_arns|developer_provider_name/);
  assert.match(main,/assume_role_policy\s+= jsonencode\(/);assert.match(main,/policy\s+= jsonencode\(/);
  assert.doesNotMatch(r.files['INSPECT.py']!,/get_credentials_for_identity\(|get_id\(|describe_user_pool_client\(|get_object\(/);
  assert.match(r.files['FEDERATE-CHECK.py']!,/confirm-approved-federation/);assert.match(r.files['FEDERATE-CHECK.py']!,/getpass.getpass/);
});
test('Federation validates exact owner/client/prefix/key and partition-specific source metadata',()=>{
  for(const [key,value]of Object.entries({name:'bad name',account:'bad',user_pool:'us-west-2_Foreign',client:'bad/client',bucket:'192.0.2.1',prefix:'../',kms:'alias/aws/s3',approved:'false'}))assert.ok(blueprint.build({...values,[key]:value}).findings.some(f=>f.path===key),key);
  for(const aws_region of ['us-east-1','us-east-2','us-west-1','us-west-2','us-gov-east-1','us-gov-west-1']){
    const partition=aws_region.startsWith('us-gov-')?'aws-us-gov':'aws';const r=blueprint.build({...values,aws_region,user_pool:aws_region+'_Approved123',kms:'arn:'+partition+':kms:'+aws_region+':123456789012:key/12345678-abcd-4bcd-8bcd-123456789abc'});assert.deepEqual(r.findings,[]);assert.equal(JSON.parse(r.files['IDENTITY-CONFIG.json']!).partition,partition);
  }
});

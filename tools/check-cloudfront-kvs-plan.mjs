/** Generated CloudFront store/key/DEVELOPMENT function mock plans; no publication or AWS calls. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_CLOUDFRONT_KVS_SERVICE as blueprint} from '../src/cloud/aws-cloudfront-kvs-service.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'cloudfront-kvs-plan-')),account='123456789012',arn='arn:aws:cloudfront::'+account+':key-value-store/12345678-abcd-4bcd-8bcd-123456789abc';const result=blueprint.build({...defaultValues(blueprint),name:'reviewed-edge',account,approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf')||name==='FEATURE-FLAG.js')writeFileSync(join(work,name),body);
writeFileSync(join(work,'global.tftest.hcl'),`mock_provider "aws" {
 override_during = plan
 mock_data "aws_caller_identity" { defaults = { account_id = "${account}" } }
}
mock_provider "aws" {
 alias = "control"
 override_during = plan
 mock_resource "aws_cloudfront_key_value_store" { defaults = { arn = "${arn}" } }
}
mock_provider "aws" { alias = "data" }
mock_provider "aws" {
 alias = "bad_owner"
 override_during = plan
 mock_resource "aws_cloudfront_key_value_store" { defaults = { arn = "${arn.replace(account,'000000000000')}" } }
}
run "nonsecret_key_and_unpublished_association" {
 command = plan
 assert {
  condition = aws_cloudfrontkeyvaluestore_key.flag.key == "migration_enabled" && aws_cloudfrontkeyvaluestore_key.flag.value == "false" && aws_cloudfrontkeyvaluestore_key.flag.key_value_store_arn == "${arn}" && !aws_cloudfront_function.configured.publish && aws_cloudfront_function.configured.runtime == "cloudfront-js-2.0" && contains(aws_cloudfront_function.configured.key_value_store_associations,"${arn}")
  error_message = "Keep the exact owned nonsecret flag and unpublished runtime2 association."
 }
}
run "foreign_caller" {
 command = plan
 override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "000000000000" }
 }
 expect_failures = [aws_cloudfront_key_value_store.configured]
}
run "wrong_returned_store_owner" {
 command = plan
 providers = { aws = aws, aws.control = aws.bad_owner, aws.data = aws.data }
 expect_failures = [aws_cloudfront_key_value_store.configured]
}
`);
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Three generated global store/key/function mock plans passed. '+work);

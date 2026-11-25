/** Generated Detective Terraform mock plans. No service enablement or AWS calls. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DETECTIVE_SERVICE as blueprint} from '../src/cloud/aws-detective-service.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'detective-plan-')),account='123456789012',arn='arn:aws:detective:us-east-1:'+account+':graph:'+'a'.repeat(32);
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-investigation',account,approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
writeFileSync(join(work,'graph.tftest.hcl'),`mock_provider "aws" {
 override_during = plan
 mock_data "aws_caller_identity" { defaults = { account_id = "${account}" } }
}
mock_provider "aws" {
 alias = "investigation"
 override_during = plan
 mock_resource "aws_detective_graph" { defaults = { graph_arn = "${arn}" } }
}
mock_provider "aws" {
 alias = "wrong_owner"
 override_during = plan
 mock_resource "aws_detective_graph" { defaults = { graph_arn = "${arn.replace(account,'000000000000')}" } }
}
run "owned_graph_output" {
 command = plan
 assert {
  condition = output.graph_arn == "${arn}"
  error_message = "Return actual owned graph ARN."
 }
}
run "foreign_caller" {
 command = plan
 override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "000000000000" }
 }
 expect_failures = [aws_detective_graph.configured]
}
run "wrong_returned_owner" {
 command = plan
 providers = { aws = aws, aws.investigation = aws.wrong_owner }
 expect_failures = [aws_detective_graph.configured]
}
`);
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Three generated Detective mock plans passed. '+work);

/** Actual generated AppFlow plan guards using local AWS mocks; no Salesforce/AWS operations. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_APPFLOW_SERVICE as blueprint} from '../src/cloud/aws-appflow-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'appflow-plan-')),account='123456789012',key='arn:aws:kms:us-east-1:'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-export',account,profile:'approved-private-salesforce',instance:'https://approved.my.salesforce.com',bucket:'approved-flow-output',kms:key});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const kms={arn:key,key_state:'Enabled',key_manager:'CUSTOMER',key_spec:'SYMMETRIC_DEFAULT',key_usage:'ENCRYPT_DECRYPT'};
const defaults={aws_caller_identity:{account_id:account},aws_s3_bucket:{region:'us-east-1'},aws_kms_key:kms};
const mock='mock_provider "aws" {\n'+Object.entries(defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n}\nmock_provider "aws" { alias = "transfer" }\n';
const invalid=[['wrong_account','data.aws_caller_identity.current',{account_id:'000000000000'}],['wrong_region','data.aws_s3_bucket.selected',{region:'us-west-2'}],['wrong_key','data.aws_kms_key.selected',{...kms,arn:'arn:aws:kms:us-east-1:000000000000:key/12345678-abcd-4bcd-8bcd-123456789abc'}],['disabled_key','data.aws_kms_key.selected',{...kms,key_state:'Disabled'}],['managed_key','data.aws_kms_key.selected',{...kms,key_manager:'AWS'}],['asymmetric_key','data.aws_kms_key.selected',{...kms,key_spec:'RSA_2048'}],['signing_key','data.aws_kms_key.selected',{...kms,key_usage:'SIGN_VERIFY'}]];
writeFileSync(join(work,'flow.tftest.hcl'),mock+'run "reviewed_on_demand_flow" {\n command = plan\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n expect_failures = [aws_appflow_flow.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Eight generated AppFlow mock plans passed. '+work);

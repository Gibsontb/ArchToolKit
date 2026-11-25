/** Actual generated Kinesis Terraform mock plans, no live stream or records. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_KINESIS_SERVICE as blueprint} from '../src/cloud/aws-kinesis-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'kinesis-plan-')),account='123456789012',key='arn:aws:kms:us-east-1:'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',account,name:'reviewed-events',mode:'PROVISIONED',shards:2,kms:key,consumer:'reviewed-consumer'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const kms={arn:key,key_state:'Enabled',key_spec:'SYMMETRIC_DEFAULT',key_usage:'ENCRYPT_DECRYPT',key_manager:'CUSTOMER'};
const invalid=[['foreign_owner','data.aws_caller_identity.current',{account_id:'000000000000'}],['disabled_key','data.aws_kms_key.selected',{...kms,key_state:'Disabled'}],['wrong_key','data.aws_kms_key.selected',{...kms,arn:key.replace(account,'000000000000')}],['asymmetric_key','data.aws_kms_key.selected',{...kms,key_spec:'RSA_2048'}],['signing_key','data.aws_kms_key.selected',{...kms,key_usage:'SIGN_VERIFY'}],['managed_key_not_customer_key','data.aws_kms_key.selected',{...kms,key_manager:'AWS'}]];
writeFileSync(join(work,'stream.tftest.hcl'),'mock_provider "aws" {\n mock_data "aws_caller_identity" { defaults = { account_id = "'+account+'" } }\n mock_data "aws_kms_key" { defaults = '+hcl(kms)+' }\n}\nrun "owned_customer_key_stream" {\n command = plan\n assert {\n condition = aws_kinesis_stream.configured.shard_count == 2 && aws_kinesis_stream.configured.encryption_type == "KMS" && !aws_kinesis_stream.configured.enforce_consumer_deletion\n error_message = "Preserve approved capacity/encryption/consumer deletion protection."\n }\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n }\n expect_failures = [aws_kinesis_stream.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Seven generated Kinesis mock plans passed. '+work);

/** Generated NFS share ownership/encryption guards with local Terraform mocks only. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_STORAGEGATEWAY_SERVICE as blueprint} from '../src/cloud/aws-storagegateway-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'storagegateway-plan-')),account='123456789012',key='arn:aws:kms:us-east-1:'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'approved-files',account,gateway:'arn:aws:storagegateway:us-east-1:'+account+':gateway/sgw-1234ABCD',bucket:'approved-file-storage',kms:key,audit:'/approved/file-audit',clients:'10.20.0.0/24'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const kms={arn:key,aws_account_id:account,key_state:'Enabled',key_manager:'CUSTOMER',key_usage:'ENCRYPT_DECRYPT',key_spec:'SYMMETRIC_DEFAULT'},log={arn:'arn:aws:logs:us-east-1:'+account+':log-group:/approved/file-audit',kms_key_id:key,retention_in_days:90};
const defaults={aws_caller_identity:{account_id:account},aws_s3_bucket:{region:'us-east-1'},aws_kms_key:kms,aws_cloudwatch_log_group:log};
const mock='mock_provider "aws" {\n'+Object.entries(defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n}\n';
const invalid=[['foreign_account','data.aws_caller_identity.current',{account_id:'000000000000'}],['wrong_region','data.aws_s3_bucket.selected',{region:'us-west-2'}],['foreign_key','data.aws_kms_key.selected',{...kms,aws_account_id:'000000000000'}],['disabled_key','data.aws_kms_key.selected',{...kms,key_state:'Disabled'}],['asymmetric_key','data.aws_kms_key.selected',{...kms,key_spec:'RSA_2048'}],['short_log_retention','data.aws_cloudwatch_log_group.audit',{...log,retention_in_days:7}],['unencrypted_log','data.aws_cloudwatch_log_group.audit',{...log,kms_key_id:''}]];
writeFileSync(join(work,'share.tftest.hcl'),mock+'run "owned_encrypted_share" {\n command = plan\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n expect_failures = [aws_storagegateway_nfs_file_share.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
 writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Eight generated Storage Gateway mock plans passed. '+work);

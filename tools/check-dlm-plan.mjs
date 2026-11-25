/** Actual generated DLM Terraform mock plans; no AWS calls or apply. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DLM_SERVICE as blueprint} from '../src/cloud/aws-dlm-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'dlm-plan-')),account='123456789012',key='arn:aws:kms:us-east-1:'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc',role='arn:aws:iam::'+account+':role/service-role/dlm-execution';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-backups',account,keys:key,role,volumes:'vol-12345678',tag_value:'reviewed-estate'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const volume={id:'vol-12345678',arn:'arn:aws:ec2:us-east-1:'+account+':volume/vol-12345678',encrypted:true,kms_key_id:key,outpost_arn:'',tags:{BackupPlan:'reviewed-estate'}};
const kms={arn:key,key_state:'Enabled',key_manager:'CUSTOMER',key_usage:'ENCRYPT_DECRYPT',key_spec:'SYMMETRIC_DEFAULT'};
const defaults={aws_caller_identity:{account_id:account},aws_iam_role:{arn:role},aws_ebs_volume:volume,aws_kms_key:kms};
const invalid=[['foreign_account','data.aws_caller_identity.current',{account_id:'000000000000'}],['wrong_role','data.aws_iam_role.execution',{arn:role.replace(account,'000000000000')}],['foreign_volume','data.aws_ebs_volume.source_0',{...volume,arn:volume.arn.replace(account,'000000000000')}],['unencrypted','data.aws_ebs_volume.source_0',{...volume,encrypted:false}],['wrong_key','data.aws_ebs_volume.source_0',{...volume,kms_key_id:'alias/aws/ebs'}],['wrong_tag','data.aws_ebs_volume.source_0',{...volume,tags:{BackupPlan:'other'}}],['outpost','data.aws_ebs_volume.source_0',{...volume,outpost_arn:'arn:aws:outposts:us-east-1:'+account+':outpost/op-example'}],['disabled_key','data.aws_kms_key.source_0',{...kms,key_state:'Disabled'}],['aws_managed_key','data.aws_kms_key.source_0',{...kms,key_manager:'AWS'}]];
writeFileSync(join(work,'snapshots.tftest.hcl'),'mock_provider "aws" {\n'+Object.entries(defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n}\nmock_provider "aws" { alias = "snapshots" }\nrun "staged_disabled" {\n command = plan\n assert {\n condition = aws_dlm_lifecycle_policy.configured.state == "DISABLED"\n error_message = "Snapshot/deletion operations must remain disabled until approved."\n }\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n }\n expect_failures = [aws_dlm_lifecycle_policy.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Ten generated DLM mock plans passed. '+work);

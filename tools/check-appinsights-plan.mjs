/** Actual generated Application Insights mock plans; no monitoring/guest/SSM/AWS actions. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_APPINSIGHTS_SERVICE as blueprint} from '../src/cloud/aws-appinsights-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'appinsights-plan-')),account='123456789012';const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',account,group:'reviewed-compute',instances:'i-12345678',tag_key:'MonitoringScope',tag_value:'reviewed-compute',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const instance={arn:'arn:aws:ec2:us-east-1:'+account+':instance/i-12345678',instance_state:'running',iam_instance_profile:'approved-profile'};
const invalid=[['foreign_caller','data.aws_caller_identity.current',{account_id:'000000000000'}],['foreign_instance','data.aws_instance.selected_0',{...instance,arn:instance.arn.replace(account,'000000000000')}],['stopped_instance','data.aws_instance.selected_0',{...instance,instance_state:'stopped'}],['missing_profile','data.aws_instance.selected_0',{...instance,iam_instance_profile:''}]];
writeFileSync(join(work,'instrumentation.tftest.hcl'),'mock_provider "aws" {\n mock_data "aws_caller_identity" { defaults = { account_id = "'+account+'" } }\n mock_data "aws_instance" { defaults = '+hcl(instance)+' }\n}\nmock_provider "aws" { alias = "monitoring" }\nrun "initial_approved_configuration_only" {\n command = plan\n assert {\n condition = aws_applicationinsights_application.configured.auto_create && !aws_applicationinsights_application.configured.auto_config_enabled && aws_applicationinsights_application.configured.cwe_monitor_enabled && !aws_applicationinsights_application.configured.ops_center_enabled\n error_message = "Configure initial approved group, without future autoconfig or OpsCenter notifications."\n }\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n }\n expect_failures = [aws_applicationinsights_application.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Five generated Application Insights mock plans passed. '+work);

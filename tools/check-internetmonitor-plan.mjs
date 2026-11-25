/** Generated Internet Monitor Terraform mock plans; no monitoring or AWS calls. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_INTERNETMONITOR_SERVICE as blueprint} from '../src/cloud/aws-internetmonitor-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'internetmonitor-plan-')),account='123456789012';const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',account,name:'reviewed-internet',vpcs:'vpc-12345678,vpc-abcdef12',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const vpc={owner_id:account,state:'available'},gateway={owner_id:account};
const invalid=[['foreign_caller','data.aws_caller_identity.current',{account_id:'000000000000'}],['foreign_first_vpc','data.aws_vpc.selected_0',{...vpc,owner_id:'000000000000'}],['foreign_second_vpc','data.aws_vpc.selected_1',{...vpc,owner_id:'000000000000'}],['unavailable_vpc','data.aws_vpc.selected_0',{...vpc,state:'pending'}],['foreign_gateway','data.aws_internet_gateway.existing',{owner_id:'000000000000'}]];
writeFileSync(join(work,'internet.tftest.hcl'),'mock_provider "aws" {\n mock_data "aws_caller_identity" { defaults = { account_id = "'+account+'" } }\n mock_data "aws_vpc" { defaults = '+hcl(vpc)+' }\n mock_data "aws_internet_gateway" { defaults = '+hcl(gateway)+' }\n}\nmock_provider "aws" { alias = "internet" }\nrun "approved_bounded_active_monitor" {\n command = plan\n assert {\n condition = aws_internetmonitor_monitor.configured.status == "ACTIVE" && length(aws_internetmonitor_monitor.configured.resources) == 2 && aws_internetmonitor_monitor.configured.max_city_networks_to_monitor == 500 && aws_internetmonitor_monitor.configured.traffic_percentage_to_monitor == 100\n error_message = "Use exact approved source count, coverage and active collection."\n }\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n }\n expect_failures = [aws_internetmonitor_monitor.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Six generated Internet Monitor mock plans passed. '+work);

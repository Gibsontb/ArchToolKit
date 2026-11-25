/** Actual generated Network Synthetic Monitor Terraform mock plans, no packets or AWS calls. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_NETWORKMONITOR_SERVICE as blueprint} from '../src/cloud/aws-networkmonitor-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'networkmonitor-plan-')),account='123456789012';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',account,name:'reviewed-hybrid',subnet:'subnet-12345678',destination:'10.200.0.10',approved:'true'});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const subnet={owner_id:account,vpc_id:'vpc-12345678',map_public_ip_on_launch:false,ipv6_native:false,available_ip_address_count:20},vpc={owner_id:account};
const invalid=[['foreign_caller','data.aws_caller_identity.current',{account_id:'000000000000'}],['foreign_subnet','data.aws_subnet.source',{...subnet,owner_id:'000000000000'}],['foreign_vpc','data.aws_vpc.source',{owner_id:'000000000000'}],['public_subnet','data.aws_subnet.source',{...subnet,map_public_ip_on_launch:true}],['ipv6_subnet','data.aws_subnet.source',{...subnet,ipv6_native:true}],['no_ip_headroom','data.aws_subnet.source',{...subnet,available_ip_address_count:5}]];
writeFileSync(join(work,'probe.tftest.hcl'),'mock_provider "aws" {\n mock_data "aws_caller_identity" { defaults = { account_id = "'+account+'" } }\n mock_data "aws_subnet" { defaults = '+hcl(subnet)+' }\n mock_data "aws_vpc" { defaults = '+hcl(vpc)+' }\n}\nmock_provider "aws" { alias = "network" }\nrun "owned_approved_probe" {\n command = plan\n assert {\n condition = aws_networkmonitor_probe.configured.destination == "10.200.0.10" && aws_networkmonitor_probe.configured.protocol == "TCP" && aws_networkmonitor_probe.configured.destination_port == 443\n error_message = "Use only approved destination/protocol/port."\n }\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n }\n expect_failures = [aws_networkmonitor_monitor.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Seven generated Network Synthetic Monitor mock plans passed. '+work);

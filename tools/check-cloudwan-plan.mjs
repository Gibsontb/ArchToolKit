/** Actual generated Cloud WAN plans with local mock providers; no AWS API calls. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_CLOUDWAN_SERVICE as blueprint} from '../src/cloud/aws-cloudwan-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'cloudwan-plan-')),account='123456789012';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'isolated-core',account,attachment:'vpc',vpc:'vpc-12345678',subnets:'subnet-12345678,subnet-abcdef12'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const vpc={id:'vpc-12345678',owner_id:account,enable_dns_support:true,enable_dns_hostnames:true,arn:`arn:aws:ec2:us-east-1:${account}:vpc/vpc-12345678`};
const subnet=index=>({id:index?'subnet-abcdef12':'subnet-12345678',arn:`arn:aws:ec2:us-east-1:${account}:subnet/${index?'subnet-abcdef12':'subnet-12345678'}`,owner_id:account,vpc_id:vpc.id,map_public_ip_on_launch:false,ipv6_native:false,outpost_arn:'',available_ip_address_count:20,availability_zone_id:index?'use1-az2':'use1-az1'});
const mock='mock_provider "aws" {\n mock_data "aws_caller_identity" { defaults = '+hcl({account_id:account})+' }\n mock_data "aws_vpc" { defaults = '+hcl(vpc)+' }\n}\nmock_provider "aws" {\n alias = "control"\n mock_data "aws_caller_identity" { defaults = '+hcl({account_id:account})+' }\n}\n';
const base=[0,1].map(i=>`override_data {\n target = data.aws_subnet.selected_${i}\n values = ${hcl(subnet(i))}\n}\n`).join('');
const invalid=[['foreign_vpc','data.aws_vpc.selected',{...vpc,owner_id:'000000000000'}],['dns_off','data.aws_vpc.selected',{...vpc,enable_dns_support:false}],['foreign_subnet','data.aws_subnet.selected_0',{...subnet(0),owner_id:'000000000000'}],['wrong_vpc','data.aws_subnet.selected_0',{...subnet(0),vpc_id:'vpc-other'}],['public_subnet','data.aws_subnet.selected_0',{...subnet(0),map_public_ip_on_launch:true}],['same_az','data.aws_subnet.selected_1',{...subnet(1),availability_zone_id:'use1-az1'}],['no_headroom','data.aws_subnet.selected_0',{...subnet(0),available_ip_address_count:2}]];
const overrides=(target,values)=>[0,1].map(i=>`override_data {\n target = data.aws_subnet.selected_${i}\n values = ${hcl(target===`data.aws_subnet.selected_${i}`?values:subnet(i))}\n}\n`).join('')+(target==='data.aws_vpc.selected'?`override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n`:'');
writeFileSync(join(work,'core.tftest.hcl'),mock+`run "owned_staged_vpc" {\n command = plan\n ${base}\n assert {\n condition = aws_networkmanager_vpc_attachment.configured.options[0].ipv6_support == false\n error_message = "Bounded IPv4 attachment required."\n }\n}\n`+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n ${overrides(target,values)}\n expect_failures = [aws_networkmanager_vpc_attachment.configured]\n}\n`).join('')+'run "foreign_control_account" {\n command = plan\n'+base+'override_data {\n target = data.aws_caller_identity.control\n values = { account_id = "000000000000" }\n}\n expect_failures = [aws_networkmanager_global_network.configured]\n}\n');
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
  const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
  writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));
  if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));
  if(check.error)throw check.error;
  if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Nine generated Cloud WAN mock plans passed. '+work);

/** Generated MWAA plans, local mock provider only; no AWS environment or code upload. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_MWAA_SERVICE as blueprint} from '../src/cloud/aws-mwaa-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'mwaa-plan-')),account='123456789012',vpcId='vpc-12345678',key='arn:aws:kms:us-east-1:'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-workflows',account,bucket:'approved-airflow-dags',role:'approved-airflow-execution',kms:key,subnets:'subnet-12345678,subnet-abcdef12',group:'sg-12345678'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const vpc={id:vpcId,owner_id:account,enable_dns_support:true,enable_dns_hostnames:true};
const group={id:'sg-12345678',vpc_id:vpcId,arn:'arn:aws:ec2:us-east-1:'+account+':security-group/sg-12345678'};
const kms={arn:key,key_state:'Enabled',key_manager:'CUSTOMER',key_usage:'ENCRYPT_DECRYPT',key_spec:'SYMMETRIC_DEFAULT'};
const subnet=i=>({id:i?'subnet-abcdef12':'subnet-12345678',owner_id:account,vpc_id:vpcId,map_public_ip_on_launch:false,ipv6_native:false,available_ip_address_count:20,availability_zone_id:i?'use1-az2':'use1-az1'});
const defaults={aws_caller_identity:{account_id:account},aws_s3_bucket:{region:'us-east-1',arn:'arn:aws:s3:::approved-airflow-dags'},aws_iam_role:{arn:'arn:aws:iam::'+account+':role/approved-airflow-execution'},aws_vpc:vpc,aws_security_group:group,aws_kms_key:kms};
const mock='mock_provider "aws" {\n'+Object.entries(defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n}\n';
const invalid=[['foreign_vpc','data.aws_vpc.selected',{...vpc,owner_id:'000000000000'}],['foreign_group','data.aws_security_group.selected',{...group,arn:'arn:aws:ec2:us-east-1:000000000000:security-group/sg-12345678'}],['foreign_role','data.aws_iam_role.selected',{arn:'arn:aws:iam::000000000000:role/x'}],['disabled_key','data.aws_kms_key.selected',{...kms,key_state:'Disabled'}],['public_subnet','data.aws_subnet.selected_0',{...subnet(0),map_public_ip_on_launch:true}],['same_az','data.aws_subnet.selected_1',{...subnet(1),availability_zone_id:'use1-az1'}],['wrong_subnet_vpc','data.aws_subnet.selected_0',{...subnet(0),vpc_id:'vpc-other'}],['no_addresses','data.aws_subnet.selected_0',{...subnet(0),available_ip_address_count:2}]];
const overrides=(target,values)=>[0,1].map(i=>`override_data {\n target = data.aws_subnet.selected_${i}\n values = ${hcl(target===`data.aws_subnet.selected_${i}`?values:subnet(i))}\n}\n`).join('')+(target&&!target.startsWith('data.aws_subnet.')?`override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n`:'');
writeFileSync(join(work,'environment.tftest.hcl'),mock+'run "owned_private_environment" {\n command = plan\n'+overrides(null,null)+'}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n ${overrides(target,values)}\n expect_failures = [aws_mwaa_environment.configured]\n}\n`).join(''));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Nine generated MWAA mock plans passed. '+work);

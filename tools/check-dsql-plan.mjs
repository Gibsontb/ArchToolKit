/** Actual generated DSQL mock plans with computed cell metadata available at plan time. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DSQL_SERVICE as blueprint} from '../src/cloud/aws-dsql-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'dsql-plan-')),account='123456789012',vpcId='vpc-12345678',clusterId='a'.repeat(26),key='arn:aws:kms:us-east-1:'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc',role='arn:aws:iam::'+account+':role/application';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-database',account,kms:key,subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',role});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const vpc={id:vpcId,owner_id:account,enable_dns_support:true,enable_dns_hostnames:true};
const group={id:'sg-12345678',vpc_id:vpcId,arn:'arn:aws:ec2:us-east-1:'+account+':security-group/sg-12345678'};
const kms={arn:key,key_state:'Enabled',key_manager:'CUSTOMER',key_usage:'ENCRYPT_DECRYPT',key_spec:'SYMMETRIC_DEFAULT'};
const subnet=i=>({id:i?'subnet-abcdef12':'subnet-12345678',owner_id:account,vpc_id:vpcId,map_public_ip_on_launch:false,ipv6_native:false,available_ip_address_count:20,availability_zone_id:i?'use1-az2':'use1-az1'});
const defaults={aws_caller_identity:{account_id:account},aws_iam_role:{arn:role},aws_vpc:vpc,aws_security_group:group,aws_kms_key:kms};
const cluster={identifier:clusterId,arn:'arn:aws:dsql:us-east-1:'+account+':cluster/'+clusterId,vpc_endpoint_service_name:'com.amazonaws.us-east-1.dsql-cell1'};
const badCluster={...cluster,vpc_endpoint_service_name:'com.amazonaws.us-east-1.dsql'};
const mock='mock_provider "aws" {\n override_during = plan\n'+Object.entries(defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n mock_resource "aws_security_group" { defaults = { id = "sg-abcdef12" } }\n}\nmock_provider "aws" {\n alias = "database"\n override_during = plan\n mock_resource "aws_dsql_cluster" { defaults = '+hcl(cluster)+' }\n}\nmock_provider "aws" {\n alias = "bad_cell"\n override_during = plan\n mock_resource "aws_dsql_cluster" { defaults = '+hcl(badCluster)+' }\n}\n';
const invalid=[['foreign_account','data.aws_caller_identity.current',{account_id:'000000000000'}],['foreign_vpc','data.aws_vpc.selected',{...vpc,owner_id:'000000000000'}],['foreign_client','data.aws_security_group.client_0',{...group,arn:'arn:aws:ec2:us-east-1:000000000000:security-group/sg-12345678'}],['wrong_client_vpc','data.aws_security_group.client_0',{...group,vpc_id:'vpc-other'}],['foreign_role','data.aws_iam_role.selected',{arn:'arn:aws:iam::000000000000:role/application'}],['disabled_key','data.aws_kms_key.selected',{...kms,key_state:'Disabled'}],['public_subnet','data.aws_subnet.selected_0',{...subnet(0),map_public_ip_on_launch:true}],['same_az','data.aws_subnet.selected_1',{...subnet(1),availability_zone_id:'use1-az1'}],['wrong_subnet_vpc','data.aws_subnet.selected_0',{...subnet(0),vpc_id:'vpc-other'}],['no_addresses','data.aws_subnet.selected_0',{...subnet(0),available_ip_address_count:2}]];
const overrides=(target,values)=>[0,1].map(i=>`override_data {\n target = data.aws_subnet.selected_${i}\n values = ${hcl(target===`data.aws_subnet.selected_${i}`?values:subnet(i))}\n}\n`).join('')+(target&&!target.startsWith('data.aws_subnet.')?`override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n`:'');
writeFileSync(join(work,'database.tftest.hcl'),mock+'run "owned_cluster_cell_hostname" {\n command = plan\n'+overrides(null,null)+'assert {\n condition = output.private_database_hostname == "'+clusterId+'.dsql-cell1.us-east-1.on.aws"\n error_message = "Use exact returned cell-service private hostname."\n}\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n ${overrides(target,values)}\n expect_failures = [aws_dsql_cluster.configured]\n}\n`).join('')+'run "wrong_returned_cell_service" {\n command = plan\n'+overrides(null,null)+'providers = {\n aws = aws\n aws.database = aws.bad_cell\n }\n expect_failures = [aws_dsql_cluster.configured]\n}\n');
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Twelve generated DSQL mock plans passed. '+work);

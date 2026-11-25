/** Full generated nested DSQL root with mock regional providers; no peering/database calls. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DSQL_MULTIREGION_SERVICE as blueprint} from '../src/cloud/aws-dsql-multiregion-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'dsql-pair-plan-')),account='123456789012',role='arn:aws:iam::'+account+':role/application';
const key=region=>'arn:aws:kms:'+region+':'+account+':key/12345678-abcd-4bcd-8bcd-123456789abc';
const values={...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-pair',account,kms:key('us-east-1'),peer_kms:key('us-west-2'),subnets:'subnet-12345678,subnet-abcdef12',clients:'sg-12345678',peer_subnets:'subnet-12345679,subnet-abcdef13',peer_clients:'sg-12345679',role};
const result=blueprint.build(values);if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf')){mkdirSync(dirname(join(work,name)),{recursive:true});writeFileSync(join(work,name),body);}
let mock='mock_provider "aws" {}\n',overrides='';
for(const [site,region,id,vpcId,client]of [['primary','us-east-1','a'.repeat(26),'vpc-12345678','sg-12345678'],['secondary','us-west-2','b'.repeat(26),'vpc-12345679','sg-12345679']]){
 const defaults={aws_caller_identity:{account_id:account},aws_iam_role:{arn:role},aws_vpc:{id:vpcId,owner_id:account,enable_dns_support:true,enable_dns_hostnames:true},aws_security_group:{id:client,vpc_id:vpcId,arn:'arn:aws:ec2:'+region+':'+account+':security-group/'+client},aws_kms_key:{arn:key(region),key_state:'Enabled',key_manager:'CUSTOMER',key_spec:'SYMMETRIC_DEFAULT',key_usage:'ENCRYPT_DECRYPT'}};
 mock+='mock_provider "aws" {\n alias = "'+site+'"\n override_during = plan\n'+Object.entries(defaults).map(([name,body])=>`mock_data "${name}" { defaults = ${hcl(body)} }`).join('\n')+'\n mock_resource "aws_security_group" { defaults = { id = "sg-abcdef12" } }\n mock_resource "aws_dsql_cluster" { defaults = '+hcl({identifier:id,arn:'arn:aws:dsql:'+region+':'+account+':cluster/'+id,vpc_endpoint_service_name:'com.amazonaws.'+region+'.dsql-cell1'})+' }\n}\n';
 const ids=String(site==='primary'?values.subnets:values.peer_subnets).split(',');
 overrides+=ids.map((subnet,i)=>`override_data {\n target = module.${site}.data.aws_subnet.selected_${i}\n values = ${hcl({id:subnet,owner_id:account,vpc_id:vpcId,map_public_ip_on_launch:false,ipv6_native:false,available_ip_address_count:20,availability_zone_id:region+'-az'+i})}\n}\n`).join('');
}
const assertions=[['output.primary_private_database_hostname == "'+'a'.repeat(26)+'.dsql-cell1.us-east-1.on.aws"','Primary hostname must use primary cell/region.'],['output.secondary_private_database_hostname == "'+'b'.repeat(26)+'.dsql-cell1.us-west-2.on.aws"','Secondary hostname must use secondary cell/region.'],['aws_dsql_cluster_peering.primary.clusters == toset([module.secondary.cluster_arn])','Primary peer must target exact secondary ARN.'],['aws_dsql_cluster_peering.secondary.clusters == toset([module.primary.cluster_arn])','Secondary peer must target exact primary ARN.'],['aws_dsql_cluster_peering.primary.witness_region == "us-east-2" && aws_dsql_cluster_peering.secondary.witness_region == "us-east-2"','Both reciprocal peers must use the approved third witness.']];
writeFileSync(join(work,'pair.tftest.hcl'),mock+'run "owned_reciprocal_pair_and_private_hosts" {\n command = plan\n'+overrides+assertions.map(([condition,error_message])=>'assert {\n condition = '+condition+'\n error_message = '+JSON.stringify(error_message)+'\n}\n').join('')+'}\n');
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
 const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Generated nested pair mock plan and five reciprocal/hostname/witness assertions passed. '+work);

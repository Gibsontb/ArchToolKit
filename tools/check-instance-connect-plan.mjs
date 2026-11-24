/** Evaluate generated subnet/VPC/account guards with Terraform mock providers, no AWS. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_INSTANCE_CONNECT_SERVICE as blueprint} from '../src/cloud/aws-instance-connect-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'instance-connect-mock-plan-'));
const account='123456789012',subnet='subnet-0123456789abcdef0',group='sg-0123456789abcdef0';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'admin-access',account,subnet,target_group:group,destination:'10.20.30.40',role:'arn:aws:iam::'+account+':role/Admin'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const subnetData={owner_id:account,state:'available',ipv6_native:false,ipv6_cidr_block:'',map_public_ip_on_launch:false,available_ip_address_count:10,vpc_id:'vpc-0123456789abcdef0'};
const groupData={arn:'arn:aws:ec2:us-east-1:'+account+':security-group/'+group,vpc_id:subnetData.vpc_id};
const defaults={aws_caller_identity:{account_id:account},aws_subnet:subnetData,aws_security_group:groupData};
const bad=[['wrong_account','data.aws_caller_identity.current',{account_id:'000000000000'}],['shared_subnet','data.aws_subnet.endpoint',{...subnetData,owner_id:'000000000000'}],['dualstack','data.aws_subnet.endpoint',{...subnetData,ipv6_cidr_block:'2001:db8::/64'}],['ipv6_only','data.aws_subnet.endpoint',{...subnetData,ipv6_native:true}],['no_ips','data.aws_subnet.endpoint',{...subnetData,available_ip_address_count:0}],['public_subnet','data.aws_subnet.endpoint',{...subnetData,map_public_ip_on_launch:true}],['wrong_vpc','data.aws_security_group.targets',{...groupData,vpc_id:'vpc-other'}],['shared_group','data.aws_security_group.targets',{...groupData,arn:groupData.arn.replace(account,'000000000000')}]];
const mock='mock_provider "aws" {\n'+Object.entries(defaults).map(([name,values])=>'mock_data "'+name+'" { defaults = '+hcl(values)+' }').join('\n')+'\n}\n';
writeFileSync(join(work,'placement.tftest.hcl'),mock+'run "valid_private_ipv4" { command = plan }\n'+bad.map(([name,target,values])=>'run "'+name+'" {\n command = plan\n override_data {\n target = '+target+'\n values = '+hcl(values)+'\n }\n expect_failures = [aws_security_group.endpoint]\n}\n').join('\n'));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
const terraform=process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe');
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
  const check=spawnSync(terraform,['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
  writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));
  if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));
  if(check.error)throw check.error;
  if(check.status!==0)throw new Error('Inspect mock-provider log: '+join(work,command[0]+'.log'));
}
console.log('Nine generated mock-provider plans passed; no AWS. '+work);

/** Exercise actual generated ownership guards using local mock providers; no AWS. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_MGN_SERVICE} from '../src/cloud/aws-mgn-service.ts';
import {AWS_SAGEMAKER_SERVICE} from '../src/cloud/aws-sagemaker-service.ts';
import {AWS_REDSHIFT_PROVISIONED_SERVICE} from '../src/cloud/aws-redshift-provisioned-service.ts';
import {AWS_DRS_SERVICE} from '../src/cloud/aws-drs-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const account='123456789012',region='us-east-1',subnet='subnet-0123456789abcdef0',group='sg-0123456789abcdef0';
const kms=`arn:aws:kms:${region}:${account}:key/12345678-abcd-4bcd-8bcd-123456789abc`;
const role=`arn:aws:iam::${account}:role/ModelApplication`,digest='sha256:'+'a'.repeat(64);
const subnetData={owner_id:account,vpc_id:'vpc-0123456789abcdef0',map_public_ip_on_launch:false,ipv6_native:false,available_ip_address_count:10,availability_zone_id:'use1-az1'};
const groupData={arn:`arn:aws:ec2:${region}:${account}:security-group/${group}`,vpc_id:subnetData.vpc_id};
const common={aws_caller_identity:{account_id:account},aws_subnet:subnetData,aws_security_group:groupData,aws_kms_key:{arn:kms,enabled:true,key_spec:'SYMMETRIC_DEFAULT',key_usage:'ENCRYPT_DECRYPT',key_manager:'CUSTOMER'}};
const cases=[
  {name:'drs',blueprint:AWS_DRS_SERVICE,values:{name:'recovery',source:`arn:aws:drs:${region}:${account}:source-server/s-0123456789abcdef0`,snapshot:'pit-0123456789abcdef0',template:'lt-0123456789abcdef0',subnet,staging:'subnet-0123456789abcdef1',groups:group,staging_groups:group,kms},defaults:common,target:`data.aws_security_group.selected["${group}"]`,failure:'terraform_data.reviewed'},
  {name:'mgn',blueprint:AWS_MGN_SERVICE,values:{name:'pilot',source:`arn:aws:mgn:${region}:${account}:source-server/s-0123456789abcdef0`,template:'lt-0123456789abcdef0',subnet,staging:'subnet-0123456789abcdef1',groups:group,staging_groups:group,kms},defaults:common,target:`data.aws_security_group.selected["${group}"]`,failure:'terraform_data.reviewed'},
  {name:'sagemaker',blueprint:AWS_SAGEMAKER_SERVICE,values:{name:'model-serving',image:`${account}.dkr.ecr.${region}.amazonaws.com/inference/model@${digest}`,kms,subnets:subnet,clients:group,role},defaults:{...common,aws_vpc:{enable_dns_support:true},aws_iam_role:{arn:role},aws_ecr_repository:{arn:`arn:aws:ecr:${region}:${account}:repository/inference/model`},aws_ecr_image:{image_digest:digest},aws_vpc_endpoint_service:{service_name:`com.amazonaws.${region}.sagemaker.runtime-fips`}},target:`data.aws_security_group.clients["${group}"]`,failure:'aws_vpc_endpoint.runtime'},
  {name:'redshift',blueprint:AWS_REDSHIFT_PROVISIONED_SERVICE,values:{name:'warehouse',subnets:subnet+',subnet-0123456789abcdef1',clients:group,kms,secret_kms:kms,log_kms:kms},defaults:{...common,aws_vpc:{enable_dns_support:true}},baseOverrides:[[`data.aws_subnet.selected["subnet-0123456789abcdef1"]`,{...subnetData,availability_zone_id:'use1-az2'}]],target:`data.aws_security_group.clients["${group}"]`,failure:'aws_redshift_cluster.warehouse'},
];
const root=mkdtempSync(join(WORK_TMP,'aws-ownership-plans-'));
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const requested=process.argv.indexOf('--only'),selected=requested<0?cases:cases.filter(item=>item.name===process.argv[requested+1]);
if(!selected.length)throw new Error('No mock-plan workflow matched --only');
let plans=0;
for(const item of selected){
  const work=join(root,item.name);mkdirSync(work);
  const result=item.blueprint.build({...defaultValues(item.blueprint),aws_region:region,...item.values});
  if(result.findings.length)throw new Error(JSON.stringify(result.findings));
  for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
  const mock='mock_provider "aws" {\n'+Object.entries(item.defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n}\n';
  const invalid=[['foreign_group',item.target,{...groupData,arn:groupData.arn.replace(account,'000000000000')}],['foreign_vpc',item.target,{...groupData,vpc_id:'vpc-00000000000000000'}],...(item.name==='redshift'?[['same_az','data.aws_subnet.selected["subnet-0123456789abcdef1"]',subnetData],['insufficient_headroom',`data.aws_subnet.selected["${subnet}"]`,{...subnetData,available_ip_address_count:2}]]:[])];
  const overrides=(target,values)=>[...(item.baseOverrides||[]).filter(([base])=>base!==target),...(target?[[target,values]]:[])].map(([target,values])=>`override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n`).join('');
  writeFileSync(join(work,'ownership.tftest.hcl'),mock+'run "valid_owned_group" {\n command = plan\n'+overrides()+'}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n ${overrides(target,values)}\n expect_failures = [${item.failure}]\n}\n`).join('\n'));
  plans+=1+invalid.length;
  const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
  for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
    const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
    writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));
    if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));
    if(check.error)throw check.error;
    if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
  }
}
console.log(plans+' generated ownership plans passed with local AWS doubles only: '+root);

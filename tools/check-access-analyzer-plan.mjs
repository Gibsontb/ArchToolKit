/** Existing analyzer form, actual generated plans using local AWS mocks only. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_ACCESS_ANALYZER_SERVICE as blueprint} from '../src/cloud/aws-access-analyzer-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const root=mkdtempSync(join(WORK_TMP,'access-analyzer-plan-')),account='123456789012',organization='o-1234567890';
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
let count=0;
for(const type of ['ACCOUNT','ORGANIZATION','ACCOUNT_UNUSED_ACCESS','ORGANIZATION_UNUSED_ACCESS']){
 const work=join(root,type);mkdirSync(work);
 const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'reviewed-access',account,type,organization});if(result.findings.length)throw new Error(JSON.stringify(result.findings));
 for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
 const mock='mock_provider "aws" {\n mock_data "aws_caller_identity" { defaults = { account_id = "'+account+'" } }\n mock_data "aws_organizations_organization" { defaults = { id = "'+organization+'", feature_set = "ALL" } }\n}\nmock_provider "aws" { alias = "analysis" }\n';
 const invalid=[['wrong_account','data.aws_caller_identity.current',{account_id:'000000000000'}],...(type.startsWith('ORGANIZATION')?[['wrong_org','data.aws_organizations_organization.selected',{id:'o-other123456',feature_set:'ALL'}],['billing_only','data.aws_organizations_organization.selected',{id:organization,feature_set:'CONSOLIDATED_BILLING'}]]:[])];
 writeFileSync(join(work,'analyzer.tftest.hcl'),mock+'run "selected_analyzer" {\n command = plan\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n override_data {\n target = ${target}\n values = ${hcl(values)}\n}\n expect_failures = [aws_accessanalyzer_analyzer.configured]\n}\n`).join(''));
 const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
 for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
  const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));if(command[0]==='test')process.stdout.write(type+'\n'+(check.stdout||'')+(check.stderr||''));if(check.error)throw check.error;if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
 }
 count+=1+invalid.length;
}
console.log(count+' generated analyzer mock plans passed. '+root);

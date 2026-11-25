/** Actual generated private VIF plan/ownership/sensitivity checks, mock AWS only. */
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {defaultValues} from '../src/kit/blueprint.ts';
import {AWS_DIRECTCONNECT_SERVICE as blueprint} from '../src/cloud/aws-directconnect-service.ts';
import {hcl} from '../src/terraform/blueprints/migration/common.ts';
import {terraformEnv} from './terraform-init.mjs';
import {WORK_CACHE,WORK_TMP} from './work.mjs';
const work=mkdtempSync(join(WORK_TMP,'directconnect-plan-'));
const account='123456789012',connection='dxcon-1234abcd',gateway='12345678-abcd-4bcd-8bcd-123456789abc';
const result=blueprint.build({...defaultValues(blueprint),aws_region:'us-east-1',name:'private-vif',account,connection,connection_name:'approved-circuit',gateway,gateway_name:'approved-gateway',onprem:'10.20.0.0/16',cloud:'10.100.0.0/16'});
if(result.findings.length)throw new Error(JSON.stringify(result.findings));
for(const[name,body]of Object.entries(result.files))if(name.endsWith('.tf'))writeFileSync(join(work,name),body);
const circuit={id:connection,owner_account_id:account,state:'available'},hub={id:gateway,owner_account_id:account,amazon_side_asn:'64512'};
const defaults={aws_caller_identity:{account_id:account},aws_dx_connection:circuit,aws_dx_gateway:hub};
const mock='mock_provider "aws" {\n'+Object.entries(defaults).map(([name,values])=>`mock_data "${name}" { defaults = ${hcl(values)} }`).join('\n')+'\n}\n';
const invalid=[['foreign_circuit','data.aws_dx_connection.selected',{...circuit,owner_account_id:'000000000000'}],['wrong_circuit','data.aws_dx_connection.selected',{...circuit,id:'dxcon-other123'}],['down_circuit','data.aws_dx_connection.selected',{...circuit,state:'down'}],['foreign_gateway','data.aws_dx_gateway.selected',{...hub,owner_account_id:'000000000000'}],['wrong_gateway','data.aws_dx_gateway.selected',{...hub,id:'00000000-0000-0000-0000-000000000000'}],['wrong_gateway_asn','data.aws_dx_gateway.selected',{...hub,amazon_side_asn:'64513'}]];
// Public synthetic fixture, never a real authentication key; no AWS operations.
const variables='variables {\n bgp_auth_key = "PublicFixtureOnly12345"\n}\n';
writeFileSync(join(work,'interface.tftest.hcl'),mock+'run "owned_interface_and_sensitive_input" {\n command = plan\n'+variables+'assert {\n condition = issensitive(aws_dx_private_virtual_interface.configured.bgp_auth_key)\n error_message = "Configured BGP input must remain marked sensitive in the normal plan."\n}\n}\n'+invalid.map(([name,target,values])=>`run "${name}" {\n command = plan\n ${variables}\n override_data {\n target = ${target}\n values = ${hcl(values)}\n }\n expect_failures = [aws_dx_private_virtual_interface.configured]\n}\n`).join('\n')+'run "reject_weak_key_contract" {\n command = plan\n variables { bgp_auth_key = "bad" }\n expect_failures = [var.bgp_auth_key]\n}\n');
const cache=join(WORK_CACHE,'instance-connect-mock-provider-cache');mkdirSync(cache,{recursive:true});
const env=terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
for(const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]){
  const check=spawnSync(process.env.TERRAFORM_PATH||resolve(WORK_TMP,'terraform-cli/terraform.exe'),['-chdir='+work,...command],{env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
  writeFileSync(join(work,command[0]+'.log'),(check.stdout||'')+(check.stderr||''));
  if(command[0]==='test')process.stdout.write((check.stdout||'')+(check.stderr||''));
  if(check.error)throw check.error;
  if(check.status!==0)throw new Error('Inspect '+join(work,command[0]+'.log'));
}
console.log('Eight generated DirectConnect mock plans passed, including normal plan sensitivity; raw state is still credential-bearing. '+work);

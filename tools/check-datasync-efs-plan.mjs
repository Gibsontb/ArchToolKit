/** Evaluate generated HCL guards using Terraform mock-provider plans, never AWS. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_DATASYNC_EFS_SERVICE as blueprint } from '../src/cloud/aws-datasync-efs-service.ts';
import { hcl } from '../src/terraform/blueprints/migration/common.ts';
import { terraformEnv } from './terraform-init.mjs';
import { WORK_CACHE, WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP,'datasync-efs-mock-plan-'));
const account = '123456789012', filesystem = 'fs-0123456789abcdef0', accesspoint = 'fsap-0123456789abcdef0', mount = 'fsmt-0123456789abcdef0', subnet = 'subnet-0123456789abcdef0', group = 'sg-0123456789abcdef0';
const fsArn = 'arn:aws:elasticfilesystem:us-east-1:' + account + ':file-system/' + filesystem;
const role = 'arn:aws:iam::' + account + ':role/DataSyncEfs';
const result = blueprint.build({ ...defaultValues(blueprint), aws_region:'us-east-1', name:'application-efs-transfer', agent:'arn:aws:datasync:us-east-1:' + account + ':agent/agent-0123456789abcdef0', server:'nfs.example.com', path:'/exports/application', filesystem, accesspoint, mount, subnet, group, role });
if (result.findings.length) throw new Error(JSON.stringify(result.findings));
for (const [name, body] of Object.entries(result.files)) if (name.endsWith('.tf')) writeFileSync(join(work,name),body);
const subnetData = { arn:'arn:aws:ec2:us-east-1:' + account + ':subnet/' + subnet, vpc_id:'vpc-0123456789abcdef0', availability_zone_id:'use1-az1', map_public_ip_on_launch:false, available_ip_address_count:10 };
const apData = { file_system_id:filesystem, owner_id:account, posix_user:[], root_directory:[{ path:'/migration', creation_info:[] }] };
const defaults = {
  aws_caller_identity:{ account_id:account }, aws_efs_file_system:{ arn:fsArn, encrypted:true }, aws_efs_access_point:apData,
  aws_efs_mount_target:{ file_system_id:filesystem, owner_id:account, subnet_id:subnet, security_groups:[group] },
  aws_subnet:subnetData, aws_security_group:{ vpc_id:subnetData.vpc_id, arn:'arn:aws:ec2:us-east-1:' + account + ':security-group/' + group },
  aws_vpc:{ instance_tenancy:'default' }, aws_iam_role:{ arn:role, name:'DataSyncEfs' },
};
const badCases = [
  ['wrong_account','data.aws_caller_identity.current',{ account_id:'000000000000' }],
  ['unencrypted','data.aws_efs_file_system.destination',{ arn:fsArn, encrypted:false }],
  ['forced_identity','data.aws_efs_access_point.destination',{ ...apData, posix_user:[{ uid:1000,gid:1000,secondary_gids:[] }] }],
  ['wrong_root','data.aws_efs_access_point.destination',{ ...apData, root_directory:[{ path:'/',creation_info:[] }] }],
  ['different_az','data.aws_subnet.destination',{ ...subnetData,availability_zone_id:'use1-az2' }],
  ['public_subnet','data.aws_subnet.destination',{ ...subnetData,map_public_ip_on_launch:true }],
  ['no_addresses','data.aws_subnet.destination',{ ...subnetData,available_ip_address_count:0 }],
  ['dedicated_tenancy','data.aws_vpc.destination',{ instance_tenancy:'dedicated' }],
];
const mock = 'mock_provider "aws" {\n' + Object.entries(defaults).map(([name,values]) => '  mock_data "' + name + '" { defaults = ' + hcl(values) + ' }').join('\n') + '\n}\n';
const cases = badCases.map(([name,target,values]) => 'run "' + name + '" {\n command = plan\n override_data {\n target = ' + target + '\n values = ' + hcl(values) + '\n }\n expect_failures = [aws_datasync_location_efs.destination]\n}\n').join('\n');
writeFileSync(join(work,'placement.tftest.hcl'), mock + '\nrun "valid_target" { command = plan }\n' + cases);
const cache = join(WORK_CACHE,'datasync-efs-mock-provider-cache'); mkdirSync(cache,{recursive:true});
const env = terraformEnv({TF_PLUGIN_CACHE_DIR:cache,TF_DATA_DIR:join(work,'terraform-data')});
const terraform = process.env.TERRAFORM_PATH || resolve(WORK_TMP,'terraform-cli/terraform.exe');
for (const command of [['init','-backend=false','-input=false','-no-color'],['test','-no-color']]) {
  const check = spawnSync(terraform,['-chdir='+work,...command],{ env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true });
  writeFileSync(join(work,command[0]+'.log'),(check.stdout || '')+(check.stderr || ''));
  if (command[0] === 'test') process.stdout.write((check.stdout || '')+(check.stderr || ''));
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error('Inspect mock-provider log: '+join(work,command[0]+'.log'));
}
console.log('Nine mock-provider plan cases passed; no real AWS plan/apply. '+work);

/** Terraform mock-provider plans only. No real AWS data sources/resources are executed. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultValues } from '../src/kit/blueprint.ts';
import { AWS_FSX_ONTAP_SERVICE } from '../src/cloud/aws-fsx-ontap-service.ts';
import { terraformEnv } from './terraform-init.mjs';
import { WORK_CACHE, WORK_TMP } from './work.mjs';
const work = mkdtempSync(join(WORK_TMP, 'ontap-mock-plan-'));
const subnet = 'subnet-0123456789abcdef0', second = 'subnet-0123456789abcdef1', other = 'subnet-0123456789abcdef2';
const result = AWS_FSX_ONTAP_SERVICE.build({ ...defaultValues(AWS_FSX_ONTAP_SERVICE), aws_region: 'us-east-1', name: 'mock-ontap', subnets: subnet + ',' + second, clients: 'sg-0123456789abcdef0', admins: 'sg-0123456789abcdef1', client_cidrs: '10.20.0.0/24', routes: 'rtb-0123456789abcdef0' });
if (result.findings.length) throw new Error('Invalid ONTAP mock fixture.');
for (const [name, body] of Object.entries(result.files)) if (name.endsWith('.tf')) writeFileSync(join(work, name), body);
writeFileSync(join(work, 'network.tftest.hcl'), `mock_provider "aws" {
  mock_data "aws_subnet" {
    defaults = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "us-east-1a", cidr_block = "10.20.0.0/24" }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["${subnet}", "${second}", "${other}"] }
  }
  mock_data "aws_security_group" {
    defaults = { vpc_id = "vpc-0123456789abcdef0" }
  }
  mock_data "aws_route_table" {
    defaults = { vpc_id = "vpc-0123456789abcdef0" }
  }
}
variables { fsx_admin_password = "MockOnlyPassword9!" }
override_data {
  target = data.aws_subnet.selected["${second}"]
  values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "us-east-1b", cidr_block = "10.30.0.0/24" }
}
run "valid_target" { command = plan }
run "other_subnet_overlap" {
  command = plan
  override_data {
    target = data.aws_subnet.vpc["${other}"]
    values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "us-east-1c", cidr_block = "198.19.0.0/24" }
  }
  expect_failures = [aws_fsx_ontap_file_system.configured]
}
run "adjacent_subnet_is_allowed" {
  command = plan
  override_data {
    target = data.aws_subnet.vpc["${other}"]
    values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "us-east-1c", cidr_block = "198.19.1.0/24" }
  }
}
run "same_az_is_rejected" {
  command = plan
  override_data {
    target = data.aws_subnet.selected["${second}"]
    values = { vpc_id = "vpc-0123456789abcdef0", availability_zone = "us-east-1a", cidr_block = "10.30.0.0/24" }
  }
  expect_failures = [aws_fsx_ontap_file_system.configured]
}
run "foreign_route_is_rejected" {
  command = plan
  override_data {
    target = data.aws_route_table.selected["rtb-0123456789abcdef0"]
    values = { vpc_id = "vpc-00000000000000000" }
  }
  expect_failures = [aws_fsx_ontap_file_system.configured]
}
run "weak_password_is_rejected" {
  command = plan
  variables { fsx_admin_password = "weak" }
  expect_failures = [var.fsx_admin_password]
}
`);
const terraform = process.env.TERRAFORM_PATH || resolve(WORK_TMP, 'terraform-cli/terraform.exe');
const cache = join(WORK_CACHE, 'ontap-mock-provider-cache');
mkdirSync(cache, { recursive: true });
const env = terraformEnv({ TF_PLUGIN_CACHE_DIR: cache, TF_DATA_DIR: join(work, 'terraform-data') });
for (const command of [['init', '-backend=false', '-input=false', '-no-color'], ['test', '-no-color']]) {
  const check = spawnSync(terraform, ['-chdir=' + work, ...command], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  writeFileSync(join(work, command[0] + '.log'), (check.stdout || '') + (check.stderr || ''));
  if (command[0] === 'test' && check.stdout) process.stdout.write(check.stdout);
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error('ONTAP mock plan checks failed; inspect ' + join(work, command[0] + '.log'));
}
const data = realpathSync(env.TF_DATA_DIR);
if (data !== resolve(realpathSync(work), 'terraform-data')) throw new Error('Unsafe scratch provider cleanup path.');
rmSync(data, { recursive: true, force: false, maxRetries: 2 });
console.log('Six Terraform mock-provider plan cases passed; no real AWS plan or apply. Artifacts: ' + work);

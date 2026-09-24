/**
 * AWS blueprints that call the registry modules rather than writing resources.
 *
 * These are the modules the AWS community actually uses — `vpc` has been
 * downloaded 214 million times, `s3-bucket` 232 million, `iam` 419 million —
 * and for most of what an architect wants to stand up, calling one is the right
 * answer and writing the resources out is not. A VPC by hand is eleven
 * resources and the per-AZ NAT placement to get wrong; the module is nine
 * inputs.
 *
 * Each blueprint names a handful of the module's inputs. The rest keep the
 * module's own defaults, which is what calling a module is for. Every name here
 * is checked against the catalog when the blueprint is constructed, so an input
 * renamed in a major version fails the test suite rather than a plan.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { familyOf } from '../../core/ip.ts';
import { moduleBlueprint, type ModuleBlueprintSpec } from '../module-blueprint.ts';
import { ipv4Range, isOn, listOf } from './dual-stack.ts';

const SPECS: readonly ModuleBlueprintSpec[] = [
  {
    id: 'aws_module_vpc',
    label: 'VPC (terraform-aws-modules/vpc)',
    description:
      'A VPC with public and private subnets across availability zones, a route table per tier, and NAT. The module handles the routing that is tedious to get right by hand.',
    source: 'terraform-aws-modules/vpc/aws',
    name: 'vpc',
    fields: [
      { input: 'name', default: 'app-vpc', hint: 'Prefix for everything the module names' },
      { input: 'cidr', label: 'VPC CIDR', default: '10.0.0.0/16' },
      { input: 'azs', label: 'Availability zones', default: 'us-east-1a,us-east-1b,us-east-1c' },
      { input: 'private_subnets', default: '10.0.1.0/24,10.0.2.0/24,10.0.3.0/24' },
      { input: 'public_subnets', default: '10.0.101.0/24,10.0.102.0/24,10.0.103.0/24' },
      { input: 'database_subnets', default: '', hint: 'Comma-separated. Leave blank for none' },
      { input: 'enable_nat_gateway', default: 'true' },
      {
        input: 'single_nat_gateway',
        default: 'false',
        hint: 'One NAT for the whole VPC is cheaper and is a single point of failure',
      },
      { input: 'enable_dns_hostnames', default: 'true' },
      { input: 'enable_flow_log', default: 'false', hint: 'VPC flow logs to CloudWatch' },
      {
        input: 'enable_ipv6',
        label: 'Dual stack (IPv6)',
        default: 'false',
        hint: 'Amazon allocates a /56; subnets take the /64s named below, and private ones route ::/0 to an egress-only gateway',
      },
      {
        input: 'public_subnet_ipv6_prefixes',
        label: 'Public subnet IPv6 /64s',
        default: '',
        hint: 'With dual stack: one /64 index (0-255) of the /56 per public subnet, e.g. 0,1,2',
      },
      {
        input: 'private_subnet_ipv6_prefixes',
        label: 'Private subnet IPv6 /64s',
        default: '',
        hint: 'With dual stack: one index per private subnet, e.g. 3,4,5',
      },
      {
        input: 'public_subnet_assign_ipv6_address_on_creation',
        label: 'Give public instances an IPv6 address',
        default: 'false',
      },
      {
        input: 'private_subnet_assign_ipv6_address_on_creation',
        label: 'Give private instances an IPv6 address',
        default: 'false',
      },
    ],
    outputs: ['vpc_id', 'private_subnets', 'public_subnets', 'database_subnet_group', 'nat_public_ips'],
  },
  {
    id: 'aws_module_ec2',
    label: 'EC2 instance (terraform-aws-modules/ec2-instance)',
    description:
      'One instance, with an optional security group, elastic IP and instance profile created alongside it.',
    source: 'terraform-aws-modules/ec2-instance/aws',
    name: 'ec2',
    fields: [
      { input: 'name', default: 'app-01' },
      { input: 'instance_type', default: 't3.small' },
      {
        input: 'ami_ssm_parameter',
        label: 'AMI SSM parameter',
        default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
        hint: 'Resolved at plan time, so it is not pinned to one region',
      },
      { input: 'subnet_id', default: '', hint: 'Or wire it to module.vpc.private_subnets[0]' },
      { input: 'vpc_security_group_ids', default: '' },
      { input: 'key_name', default: '', hint: 'An existing EC2 key pair. Blank for none' },
      { input: 'monitoring', label: 'Detailed monitoring', default: 'false' },
      { input: 'create_eip', label: 'Create an elastic IP', default: 'false' },
      { input: 'create_iam_instance_profile', default: 'true' },
      {
        input: 'ipv6_address_count',
        label: 'IPv6 addresses',
        default: '',
        hint: 'Blank for none. The subnet must have an IPv6 /64',
      },
    ],
    outputs: ['id', 'arn', 'private_ip', 'public_ip'],
  },
  {
    id: 'aws_module_security_group',
    label: 'Security group (terraform-aws-modules/security-group)',
    description: 'A security group whose rules come from the module’s named rule set rather than being written out.',
    source: 'terraform-aws-modules/security-group/aws',
    name: 'security_group',
    fields: [
      { input: 'name', default: 'app-sg' },
      { input: 'description', default: 'Managed by Terraform' },
      { input: 'vpc_id', default: '', hint: 'Or module.vpc.vpc_id' },
      {
        input: 'ingress_rules',
        label: 'Ingress rules',
        default: '',
        hint: 'A map of rules — write it in the file. Each rule takes one cidr_ipv4 or one cidr_ipv6, never both',
      },
      { input: 'egress_rules', default: '' },
    ],
    outputs: ['security_group_id', 'security_group_arn'],
  },
  {
    id: 'aws_module_s3',
    label: 'S3 bucket (terraform-aws-modules/s3-bucket)',
    description:
      'A bucket with the settings that are separate resources in the provider — versioning, encryption, public access block, lifecycle — handled as inputs.',
    source: 'terraform-aws-modules/s3-bucket/aws',
    name: 's3',
    fields: [
      { input: 'bucket', default: 'app-records-archive' },
      { input: 'versioning', default: 'status=Enabled', hint: 'key=value. status=Enabled turns it on' },
      { input: 'block_public_acls', default: 'true' },
      { input: 'block_public_policy', default: 'true' },
      { input: 'ignore_public_acls', default: 'true' },
      { input: 'restrict_public_buckets', default: 'true' },
      { input: 'force_destroy', default: 'false', hint: 'Lets terraform destroy a bucket with objects in it' },
    ],
    outputs: ['s3_bucket_id', 's3_bucket_arn'],
  },
  {
    id: 'aws_module_rds',
    label: 'RDS instance (terraform-aws-modules/rds)',
    description:
      'A managed relational database with its subnet group, parameter group and monitoring role created alongside.',
    source: 'terraform-aws-modules/rds/aws',
    name: 'rds',
    fields: [
      { input: 'identifier', default: 'app-pgsql-01' },
      { input: 'engine', default: 'postgres' },
      { input: 'engine_version', default: '16' },
      { input: 'instance_class', default: 'db.t3.medium' },
      { input: 'allocated_storage', default: '100' },
      { input: 'db_name', default: 'app' },
      { input: 'username', default: 'dbadmin' },
      { input: 'multi_az', default: 'true' },
      { input: 'subnet_ids', default: '', hint: 'Or module.vpc.database_subnets' },
      { input: 'vpc_security_group_ids', default: '' },
      { input: 'deletion_protection', default: 'true' },
      { input: 'storage_encrypted', default: 'true' },
    ],
    outputs: ['db_instance_identifier', 'db_instance_endpoint', 'db_instance_port'],
  },
  {
    id: 'aws_module_rds_aurora',
    label: 'Aurora cluster (terraform-aws-modules/rds-aurora)',
    description: 'An Aurora cluster with its writer and readers, for workloads that outgrow a single instance.',
    source: 'terraform-aws-modules/rds-aurora/aws',
    name: 'aurora',
    fields: [
      { input: 'name', default: 'app-aurora' },
      { input: 'engine', default: 'aurora-postgresql' },
      { input: 'engine_version', default: '16.4' },
      { input: 'engine_mode', default: 'provisioned' },
      { input: 'master_username', default: 'dbadmin' },
      { input: 'vpc_id', default: '' },
      { input: 'subnets', default: '', hint: 'Or module.vpc.database_subnets' },
      { input: 'storage_encrypted', default: 'true' },
      { input: 'deletion_protection', default: 'true' },
    ],
    outputs: ['cluster_endpoint', 'cluster_reader_endpoint', 'cluster_database_name'],
  },
  {
    id: 'aws_module_eks',
    label: 'EKS cluster (terraform-aws-modules/eks)',
    description:
      'A managed Kubernetes cluster with its IAM roles, security groups, addons and OIDC provider — the parts that make IRSA work.',
    source: 'terraform-aws-modules/eks/aws',
    name: 'eks',
    fields: [
      { input: 'name', label: 'Cluster name', default: 'app-eks' },
      { input: 'kubernetes_version', default: '1.31' },
      { input: 'vpc_id', default: '', hint: 'Or module.vpc.vpc_id' },
      { input: 'subnet_ids', default: '', hint: 'Or module.vpc.private_subnets' },
      { input: 'endpoint_public_access', default: 'false', hint: 'Private-only is the safer default' },
      { input: 'enable_irsa', label: 'Enable IRSA', default: 'true' },
      { input: 'create_kms_key', label: 'Create a KMS key for secrets', default: 'true' },
      {
        input: 'ip_family',
        label: 'Pod and service IP family',
        control: 'select',
        options: [
          { value: 'ipv4', label: 'ipv4' },
          { value: 'ipv6', label: 'ipv6 — needs a dual-stack VPC and the CNI IPv6 policy' },
        ],
        default: 'ipv4',
        hint: 'Set at creation only; changing it replaces the cluster',
      },
      { input: 'create_cni_ipv6_iam_policy', label: 'Create the CNI IPv6 policy', default: 'false', hint: 'Needed with ip_family ipv6' },
    ],
    outputs: ['cluster_name', 'cluster_endpoint', 'cluster_certificate_authority_data', 'oidc_provider_arn'],
  },
  {
    id: 'aws_module_alb',
    label: 'Application load balancer (terraform-aws-modules/alb)',
    description: 'A load balancer with its listeners, target groups and security group.',
    source: 'terraform-aws-modules/alb/aws',
    name: 'alb',
    fields: [
      { input: 'name', default: 'app-alb' },
      { input: 'load_balancer_type', default: 'application' },
      { input: 'vpc_id', default: '' },
      { input: 'subnets', default: '', hint: 'Or module.vpc.public_subnets' },
      { input: 'internal', default: 'false' },
      { input: 'enable_deletion_protection', default: 'true' },
    ],
    outputs: ['id', 'arn', 'dns_name', 'zone_id'],
  },
  {
    id: 'aws_module_lambda',
    label: 'Lambda function (terraform-aws-modules/lambda)',
    description:
      'A function with its execution role, log group and packaging. The module builds the zip, which is the part everyone reimplements.',
    source: 'terraform-aws-modules/lambda/aws',
    name: 'lambda',
    fields: [
      { input: 'function_name', default: 'app-function' },
      { input: 'description', default: 'Managed by Terraform' },
      { input: 'handler', default: 'index.handler' },
      { input: 'runtime', default: 'python3.12' },
      { input: 'source_path', default: './src', hint: 'Directory the module packages' },
      { input: 'timeout', default: '30' },
      { input: 'memory_size', default: '256' },
      { input: 'vpc_subnet_ids', default: '', hint: 'Blank unless it needs the VPC' },
      { input: 'vpc_security_group_ids', default: '' },
    ],
    outputs: ['lambda_function_arn', 'lambda_function_name', 'lambda_role_arn'],
  },
  {
    id: 'aws_module_kms',
    label: 'KMS key (terraform-aws-modules/kms)',
    description: 'A customer-managed key with its alias, policy and rotation.',
    source: 'terraform-aws-modules/kms/aws',
    name: 'kms',
    fields: [
      { input: 'description', default: 'App data encryption key' },
      { input: 'aliases', default: 'app-data-key', hint: 'Comma-separated, without the alias/ prefix' },
      { input: 'enable_key_rotation', default: 'true' },
      { input: 'deletion_window_in_days', default: '30' },
      { input: 'multi_region', default: 'false' },
    ],
    outputs: ['key_id', 'key_arn'],
  },
  {
    id: 'aws_module_dynamodb',
    label: 'DynamoDB table (terraform-aws-modules/dynamodb-table)',
    description: 'A table with its keys, indexes, autoscaling and point-in-time recovery.',
    source: 'terraform-aws-modules/dynamodb-table/aws',
    name: 'dynamodb',
    fields: [
      { input: 'name', default: 'AppSessions' },
      { input: 'billing_mode', default: 'PAY_PER_REQUEST' },
      { input: 'hash_key', default: 'CaseId' },
      { input: 'range_key', default: '', hint: 'Sort key. Blank for none' },
      { input: 'point_in_time_recovery_enabled', default: 'true' },
      { input: 'server_side_encryption_enabled', default: 'true' },
    ],
    outputs: ['dynamodb_table_id', 'dynamodb_table_arn'],
  },
  {
    id: 'aws_module_autoscaling',
    label: 'Auto Scaling group (terraform-aws-modules/autoscaling)',
    description: 'A launch template and the group that uses it, with the scaling policies attached.',
    source: 'terraform-aws-modules/autoscaling/aws',
    name: 'asg',
    fields: [
      { input: 'name', default: 'app-web-asg' },
      { input: 'image_id', default: '', hint: 'An AMI id, or wire it to an SSM lookup' },
      { input: 'instance_type', default: 't3.small' },
      { input: 'min_size', default: '2' },
      { input: 'max_size', default: '6' },
      { input: 'desired_capacity', default: '2' },
      { input: 'vpc_zone_identifier', label: 'Subnet ids', default: '', hint: 'Or module.vpc.private_subnets' },
      { input: 'health_check_type', default: 'EC2' },
    ],
    outputs: ['autoscaling_group_id', 'autoscaling_group_arn', 'launch_template_id'],
  },
  {
    id: 'aws_module_ecs',
    label: 'ECS cluster (terraform-aws-modules/ecs)',
    description: 'A cluster with capacity providers and the task execution role, ready for Fargate services.',
    source: 'terraform-aws-modules/ecs/aws',
    name: 'ecs',
    fields: [
      { input: 'cluster_name', default: 'app-ecs' },
      { input: 'create_cloudwatch_log_group', default: 'true' },
      { input: 'create_task_exec_iam_role', default: 'true' },
      { input: 'vpc_id', default: '' },
    ],
    outputs: ['cluster_id', 'cluster_arn', 'cluster_name'],
  },
  {
    id: 'aws_module_acm',
    label: 'ACM certificate (terraform-aws-modules/acm)',
    description: 'A certificate and the Route 53 records that validate it, so issuance completes in one apply.',
    source: 'terraform-aws-modules/acm/aws',
    name: 'acm',
    fields: [
      { input: 'domain_name', default: 'app.example.com' },
      { input: 'subject_alternative_names', default: '', hint: 'Comma-separated. Blank for none' },
      { input: 'validation_method', default: 'DNS' },
      { input: 'zone_id', default: '', hint: 'The Route 53 zone that holds the domain' },
      { input: 'wait_for_validation', default: 'true' },
    ],
    outputs: ['acm_certificate_arn', 'acm_certificate_status'],
  },
];

/**
 * The address checks the module cannot make before plan.
 *
 * The VPC module indexes the IPv6 prefix lists by subnet position, so a list
 * shorter than its subnet list fails at plan with an index error, and a list
 * given without enable_ipv6 has no /56 to carve from.
 */
function vpcFindings(values: BlueprintValues): Finding[] {
  const code = 'terraform.aws_module_vpc';
  const v6 = isOn(values.enable_ipv6);
  const findings: Finding[] = [];
  if (String(values.cidr ?? '').trim()) findings.push(...ipv4Range(values.cidr, 'cidr', 'The VPC CIDR', code));
  let anyPrefixes = false;
  for (const tier of ['public', 'private'] as const) {
    const subnets = listOf(values[`${tier}_subnets`]);
    for (const s of subnets) {
      if (familyOf(s) === 6) {
        findings.push(error(`${code}.ipv4-subnet-required`, `${tier}_subnets takes IPv4 ranges; "${s}" is IPv6. IPv6 goes in ${tier}_subnet_ipv6_prefixes.`, { path: `${tier}_subnets` }));
      }
    }
    const prefixes = listOf(values[`${tier}_subnet_ipv6_prefixes`]);
    if (prefixes.length === 0) continue;
    anyPrefixes = true;
    if (!v6) {
      findings.push(error(`${code}.ipv6-prefixes-without-ipv6`, `${tier}_subnet_ipv6_prefixes is set but dual stack is off, so there is no /56 to take them from.`, { path: 'enable_ipv6' }));
    }
    if (prefixes.some((p) => !/^\d+$/.test(p) || Number(p) > 255)) {
      findings.push(error(`${code}.ipv6-prefix-index`, `${tier}_subnet_ipv6_prefixes takes /64 indexes from 0 to 255, e.g. 0,1,2.`, { path: `${tier}_subnet_ipv6_prefixes` }));
    }
    if (prefixes.length !== subnets.length) {
      findings.push(error(`${code}.ipv6-prefix-count`, `${tier}_subnet_ipv6_prefixes has ${prefixes.length} entries for ${subnets.length} ${tier} subnet(s); the module needs one each.`, { path: `${tier}_subnet_ipv6_prefixes` }));
    }
  }
  if (v6 && !anyPrefixes) {
    findings.push(warning(`${code}.ipv6-no-subnet-prefixes`, 'Dual stack is on, but no subnet IPv6 /64s are named, so the VPC gets a /56 and no subnet uses it.', { path: 'public_subnet_ipv6_prefixes' }));
  }
  return findings;
}

/** EKS with ip_family ipv6 needs the CNI's IPv6 policy, or pods get no addresses. */
function eksFindings(values: BlueprintValues): Finding[] {
  if (values.ip_family !== 'ipv6' || isOn(values.create_cni_ipv6_iam_policy)) return [];
  return [
    warning('terraform.aws_module_eks.ipv6-cni-policy', 'ip_family is ipv6 but the CNI IPv6 policy is not created; the VPC CNI cannot assign pod addresses without it.', {
      path: 'create_cni_ipv6_iam_policy',
    }),
  ];
}

const CHECKS: Readonly<Record<string, (values: BlueprintValues) => Finding[]>> = {
  aws_module_vpc: vpcFindings,
  aws_module_eks: eksFindings,
};

function checked(blueprint: Blueprint): Blueprint {
  const check = CHECKS[blueprint.id];
  if (!check) return blueprint;
  return {
    ...blueprint,
    build: (values, name) => {
      const out = blueprint.build(values, name);
      return { ...out, findings: [...(out.findings ?? []), ...check(values)] };
    },
  };
}

export const AWS_TERRAFORM_MODULES: BlueprintGroup = {
  target: 'aws',
  label: 'Amazon Web Services (AWS)',
  blueprints: SPECS.map((spec) => checked(moduleBlueprint('aws', spec))),
};

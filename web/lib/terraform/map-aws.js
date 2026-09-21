/**
 * The AWS Terraform Map.
 *
 * The other three maps are generated from the previous toolkit's own pages.
 * This one is not, because there was nothing to generate it from:
 * `_old/13_Web/static/terraform/terraform-aws.html` is a mislabelled copy of
 * the Azure map — its title reads "Azure Terraform Map", its body holds 54
 * `azurerm_*` names and not a single `aws_*`. The file is a duplicate, not a
 * draft, so the AWS map is written here instead.
 *
 * It follows the Azure map's domains, because that is the shape the rest of the
 * toolkit's AWS material already follows and because a map that organises AWS
 * differently from the others would be harder to read across. Every resource
 * named below is checked against the committed provider catalog by the page and
 * by the test suite, so this cannot drift into naming things that do not exist.
 */

                                         

export const AWS_MAP           = {
  target: 'aws',
  label: 'AWS',
  title: 'AWS Terraform Map',
  blurb: 'Organizations, VPCs, IAM, EKS and data services, mapped to aws_* resources.',
  sections: [
    {
      id: 'aws-overview',
      title: 'AWS Terraform Overview',
      badge: 'AWS',
      tagline:
        'Terraform with the aws provider: organization → OUs → accounts, with a VPC and a state bucket per account or per environment.',
      notes: [
        'Provider: aws, with a second aliased provider per region where a stack spans regions.',
        'State: an S3 bucket with versioning on, locking via the bucket’s own conditional writes or a DynamoDB table.',
        'Isolation: an account per environment, or per tenant, assumed into by role.',
      ],
      code: [
        `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket       = "tfstate-central"
    key          = "aws/global/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  assume_role {
    role_arn = "arn:aws:iam::\${var.account_id}:role/TerraformExecution"
  }

  default_tags {
    tags = {
      ManagedBy = "terraform"
      System    = var.system_name
    }
  }
}`,
      ],
    },
    {
      id: 'aws-identity',
      title: 'Accounts, Organizations & IAM',
      badge: 'Identity',
      tagline:
        'The account boundary is the strongest one AWS has, so the organization tree and the roles across it are the first thing to put in code.',
      tables: [
        {
          headers: ['Concept', 'Service', 'Terraform Resources', 'Language Options'],
          rows: [
            {
              cells: [
                'Organization tree',
                'Organizations, OUs, accounts',
                'aws_organizations_organization, aws_organizations_organizational_unit, aws_organizations_account',
                'One module for the tree; accounts from a map with for_each so adding a tenant is a map entry.',
              ],
              resources: [
                'aws_organizations_organization',
                'aws_organizations_organizational_unit',
                'aws_organizations_account',
              ],
            },
            {
              cells: [
                'Guardrails',
                'Service control policies',
                'aws_organizations_policy, aws_organizations_policy_attachment',
                'Policy JSON from templatefile or aws_iam_policy_document; attach at the OU, not the account.',
              ],
              resources: ['aws_organizations_policy', 'aws_organizations_policy_attachment'],
            },
            {
              cells: [
                'Roles and policies',
                'IAM',
                'aws_iam_role, aws_iam_policy, aws_iam_role_policy_attachment, aws_iam_instance_profile',
                'Trust and permission documents via aws_iam_policy_document rather than heredoc JSON, so the plan diffs readably.',
              ],
              resources: [
                'aws_iam_role',
                'aws_iam_policy',
                'aws_iam_role_policy_attachment',
                'aws_iam_instance_profile',
              ],
            },
            {
              cells: [
                'Workforce access',
                'IAM Identity Center',
                'aws_ssoadmin_permission_set, aws_ssoadmin_account_assignment, aws_ssoadmin_managed_policy_attachment',
                'Permission sets as a locals map; assignments with for_each over group × account.',
              ],
              resources: [
                'aws_ssoadmin_permission_set',
                'aws_ssoadmin_account_assignment',
                'aws_ssoadmin_managed_policy_attachment',
              ],
            },
            {
              cells: [
                'Workload federation',
                'OIDC and SAML',
                'aws_iam_openid_connect_provider, aws_iam_saml_provider',
                'The way CI and EKS service accounts get credentials without a long-lived key existing anywhere.',
              ],
              resources: ['aws_iam_openid_connect_provider', 'aws_iam_saml_provider'],
            },
            {
              cells: [
                'Least privilege review',
                'IAM Access Analyzer',
                'aws_accessanalyzer_analyzer',
                'One analyzer per account, or one at the organization for external-access findings.',
              ],
              resources: ['aws_accessanalyzer_analyzer'],
            },
          ],
        },
      ],
      examples: [
        {
          title: 'Example: permission sets with for_each',
          note: 'A CCoE access matrix, straight from a map.',
          code: `locals {
  # CCoE-approved access matrix
  access = {
    "platform-admins" = { permission_set = "AdministratorAccess", accounts = ["prod", "nonprod"] }
    "app-ops"      = { permission_set = "PowerUserAccess", accounts = ["nonprod"] }
    "auditors"     = { permission_set = "ReadOnlyAccess", accounts = ["prod", "nonprod", "security"] }
  }

  assignments = merge([
    for group, cfg in local.access : {
      for account in cfg.accounts :
      "\${group}-\${account}" => { group = group, account = account, permission_set = cfg.permission_set }
    }
  ]...)
}

resource "aws_ssoadmin_account_assignment" "this" {
  for_each = local.assignments

  instance_arn       = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  permission_set_arn = aws_ssoadmin_permission_set.this[each.value.permission_set].arn
  principal_id       = data.aws_identitystore_group.this[each.value.group].group_id
  principal_type     = "GROUP"
  target_id          = var.account_ids[each.value.account]
  target_type        = "AWS_ACCOUNT"
}`,
        },
      ],
    },
    {
      id: 'aws-networking',
      title: 'Networking & Connectivity',
      badge: 'VPC',
      tagline:
        'VPCs, subnets, security groups and the routes between them are the spine of the landing zone. How strongly you standardise them is the decision.',
      tables: [
        {
          headers: ['Domain', 'Services', 'Terraform Resources', 'Pattern / Options'],
          rows: [
            {
              cells: [
                'VPC and subnets',
                'VPC, Subnet, Route Table',
                'aws_vpc, aws_subnet, aws_route_table, aws_route_table_association',
                'A module around VPC plus subnets; cidrsubnet to carve the ranges so a new AZ is a count, not a hand-picked block.',
              ],
              resources: ['aws_vpc', 'aws_subnet', 'aws_route_table', 'aws_route_table_association'],
            },
            {
              cells: [
                'Egress',
                'Internet Gateway, NAT Gateway',
                'aws_internet_gateway, aws_nat_gateway, aws_eip',
                'One NAT per AZ for resilience, or one shared for cost — this is the cheapest decision to get wrong and the most expensive to leave wrong.',
              ],
              resources: ['aws_internet_gateway', 'aws_nat_gateway', 'aws_eip'],
            },
            {
              cells: [
                'Security',
                'Security Groups, NACLs',
                'aws_security_group, aws_vpc_security_group_ingress_rule, aws_vpc_security_group_egress_rule, aws_network_acl',
                'Rules from object variables. The separate ingress and egress rule resources replace inline blocks and aws_security_group_rule; they diff per rule.',
              ],
              resources: [
                'aws_security_group',
                'aws_vpc_security_group_ingress_rule',
                'aws_vpc_security_group_egress_rule',
                'aws_network_acl',
              ],
            },
            {
              cells: [
                'Hybrid connectivity',
                'Site-to-Site VPN, Direct Connect',
                'aws_vpn_gateway, aws_customer_gateway, aws_vpn_connection, aws_dx_gateway',
                'Site-to-site and site-to-datacenter links. Direct Connect for steady volume, VPN for everything else and as the failover.',
              ],
              resources: [
                'aws_vpn_gateway',
                'aws_customer_gateway',
                'aws_vpn_connection',
                'aws_dx_gateway',
              ],
            },
            {
              cells: [
                'Many-to-many',
                'Transit Gateway, VPC Peering',
                'aws_ec2_transit_gateway, aws_ec2_transit_gateway_vpc_attachment, aws_vpc_peering_connection',
                'Peering up to a handful of VPCs; a transit gateway past that, before the peering mesh becomes the topology.',
              ],
              resources: [
                'aws_ec2_transit_gateway',
                'aws_ec2_transit_gateway_vpc_attachment',
                'aws_vpc_peering_connection',
              ],
            },
            {
              cells: [
                'Private access to AWS services',
                'VPC Endpoints, PrivateLink',
                'aws_vpc_endpoint, aws_vpc_endpoint_service',
                'A standard module for private access to S3, ECR and the rest, so no workload subnet needs a route to the internet to reach them.',
              ],
              resources: ['aws_vpc_endpoint', 'aws_vpc_endpoint_service'],
            },
            {
              cells: [
                'DNS',
                'Route 53',
                'aws_route53_zone, aws_route53_record, aws_route53_resolver_endpoint',
                'Private zones per VPC; resolver endpoints where on-premises has to resolve into the VPC or the reverse.',
              ],
              resources: ['aws_route53_zone', 'aws_route53_record', 'aws_route53_resolver_endpoint'],
            },
          ],
        },
      ],
    },
    {
      id: 'aws-compute',
      title: 'Compute, EKS & Serverless',
      badge: 'Compute',
      tagline:
        'From a single instance to a managed cluster. The decision is how much of the runtime you want to own.',
      tables: [
        {
          headers: ['Service', 'Terraform Resources', 'Key Options'],
          rows: [
            {
              cells: [
                'EC2 instances',
                'aws_instance, aws_key_pair, aws_ebs_volume, aws_volume_attachment',
                'AMI from an SSM public parameter rather than a pinned id, which is per-region; instance profile rather than keys on the box.',
              ],
              resources: ['aws_instance', 'aws_key_pair', 'aws_ebs_volume', 'aws_volume_attachment'],
            },
            {
              cells: [
                'Auto scaling',
                'aws_launch_template, aws_autoscaling_group, aws_autoscaling_policy',
                'Launch templates over launch configurations, which are gone; scale on a target-tracking policy rather than on step alarms where you can.',
              ],
              resources: ['aws_launch_template', 'aws_autoscaling_group', 'aws_autoscaling_policy'],
            },
            {
              cells: [
                'Load balancing',
                'aws_lb, aws_lb_target_group, aws_lb_listener, aws_lb_listener_rule',
                'Application load balancer for HTTP, network for TCP and static addressing; certificates from ACM, never uploaded.',
              ],
              resources: ['aws_lb', 'aws_lb_target_group', 'aws_lb_listener', 'aws_lb_listener_rule'],
            },
            {
              cells: [
                'Containers',
                'aws_ecs_cluster, aws_ecs_service, aws_ecs_task_definition, aws_ecr_repository',
                'ECS on Fargate where there is no reason to run nodes; task role separate from execution role.',
              ],
              resources: [
                'aws_ecs_cluster',
                'aws_ecs_service',
                'aws_ecs_task_definition',
                'aws_ecr_repository',
              ],
            },
            {
              cells: [
                'Kubernetes',
                'aws_eks_cluster, aws_eks_node_group, aws_eks_fargate_profile, aws_eks_addon',
                'Managed node groups unless the workload needs otherwise; IRSA via the cluster OIDC provider so pods get roles, not keys.',
              ],
              resources: [
                'aws_eks_cluster',
                'aws_eks_node_group',
                'aws_eks_fargate_profile',
                'aws_eks_addon',
              ],
            },
            {
              cells: [
                'Serverless',
                'aws_lambda_function, aws_lambda_permission, aws_apigatewayv2_api, aws_apigatewayv2_stage',
                'Package from S3 or ECR rather than inline; HTTP APIs over REST APIs unless you need the REST feature set.',
              ],
              resources: [
                'aws_lambda_function',
                'aws_lambda_permission',
                'aws_apigatewayv2_api',
                'aws_apigatewayv2_stage',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'aws-storage',
      title: 'Storage & Data',
      badge: 'Storage',
      tagline:
        'Buckets, volumes and shares become evidence stores, log sinks and integration channels — which is why the access settings matter more than the size.',
      tables: [
        {
          headers: ['Service', 'Terraform Resources', 'What You Decide'],
          rows: [
            {
              cells: [
                'S3 buckets',
                'aws_s3_bucket, aws_s3_bucket_versioning, aws_s3_bucket_server_side_encryption_configuration, aws_s3_bucket_public_access_block',
                'The settings are separate resources now, not blocks on the bucket. A bucket without the public access block is the finding that matters.',
              ],
              resources: [
                'aws_s3_bucket',
                'aws_s3_bucket_versioning',
                'aws_s3_bucket_server_side_encryption_configuration',
                'aws_s3_bucket_public_access_block',
              ],
            },
            {
              cells: [
                'Retention and tiering',
                'aws_s3_bucket_lifecycle_configuration, aws_s3_bucket_policy, aws_s3_bucket_object_lock_configuration',
                'Object lock in compliance mode where retention is a legal requirement rather than a preference — it cannot be shortened afterwards, including by you.',
              ],
              resources: [
                'aws_s3_bucket_lifecycle_configuration',
                'aws_s3_bucket_policy',
                'aws_s3_bucket_object_lock_configuration',
              ],
            },
            {
              cells: [
                'Block storage',
                'aws_ebs_volume, aws_volume_attachment, aws_ebs_snapshot',
                'gp3 by default, since it decouples IOPS from size; encryption on by account default rather than per volume.',
              ],
              resources: ['aws_ebs_volume', 'aws_volume_attachment', 'aws_ebs_snapshot'],
            },
            {
              cells: [
                'Shared file systems',
                'aws_efs_file_system, aws_efs_mount_target, aws_fsx_windows_file_system',
                'EFS for Linux, FSx for Windows workloads that expect SMB and a domain join.',
              ],
              resources: [
                'aws_efs_file_system',
                'aws_efs_mount_target',
                'aws_fsx_windows_file_system',
              ],
            },
            {
              cells: [
                'Backup',
                'aws_backup_vault, aws_backup_plan, aws_backup_selection',
                'Selection by tag rather than by resource id, so a new instance is covered the moment it is tagged.',
              ],
              resources: ['aws_backup_vault', 'aws_backup_plan', 'aws_backup_selection'],
            },
          ],
        },
      ],
    },
    {
      id: 'aws-database',
      title: 'Databases & Analytics',
      badge: 'Data',
      tagline:
        'Managed engines, caches and the analytics layer above them. The recurring decision is single instance against cluster.',
      tables: [
        {
          headers: ['Service', 'Terraform Resources', 'Key Options'],
          rows: [
            {
              cells: [
                'Relational',
                'aws_db_instance, aws_db_subnet_group, aws_db_parameter_group',
                'Multi-AZ for anything with a recovery objective; the password as a sensitive variable or from Secrets Manager, never a literal.',
              ],
              resources: ['aws_db_instance', 'aws_db_subnet_group', 'aws_db_parameter_group'],
            },
            {
              cells: [
                'Aurora',
                'aws_rds_cluster, aws_rds_cluster_instance, aws_rds_cluster_parameter_group',
                'Serverless v2 where the load is spiky; provisioned readers where it is steady and you want predictable cost.',
              ],
              resources: [
                'aws_rds_cluster',
                'aws_rds_cluster_instance',
                'aws_rds_cluster_parameter_group',
              ],
            },
            {
              cells: [
                'NoSQL',
                'aws_dynamodb_table',
                'On-demand billing until the traffic is understood; point-in-time recovery on for anything holding a record.',
              ],
              resources: ['aws_dynamodb_table'],
            },
            {
              cells: [
                'Cache',
                'aws_elasticache_cluster, aws_elasticache_replication_group, aws_elasticache_subnet_group',
                'A replication group rather than a bare cluster once failover matters; encryption in transit and at rest on.',
              ],
              resources: [
                'aws_elasticache_cluster',
                'aws_elasticache_replication_group',
                'aws_elasticache_subnet_group',
              ],
            },
            {
              cells: [
                'Warehouse and lake',
                'aws_redshift_cluster, aws_glue_catalog_database, aws_athena_workgroup',
                'Athena over the lake for occasional questions; Redshift once the questions are constant and joined.',
              ],
              resources: [
                'aws_redshift_cluster',
                'aws_glue_catalog_database',
                'aws_athena_workgroup',
              ],
            },
            {
              cells: [
                'Streaming',
                'aws_kinesis_stream, aws_kinesis_firehose_delivery_stream, aws_sqs_queue, aws_sns_topic',
                'Kinesis for ordered replayable streams; SQS and SNS for work queues and fan-out.',
              ],
              resources: [
                'aws_kinesis_stream',
                'aws_kinesis_firehose_delivery_stream',
                'aws_sqs_queue',
                'aws_sns_topic',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'aws-governance',
      title: 'Security, Guardrails & Monitoring',
      badge: 'Governance',
      tagline:
        'Keys, audit trails, detection and alarms. The test of this domain is whether turning a control off shows up somewhere.',
      tables: [
        {
          headers: ['Domain', 'Services', 'Terraform Resources', 'Options / Patterns'],
          rows: [
            {
              cells: [
                'Keys and secrets',
                'KMS, Secrets Manager, Parameter Store',
                'aws_kms_key, aws_kms_alias, aws_secretsmanager_secret, aws_ssm_parameter',
                'A customer-managed key per data class rather than per resource; key policy as a document, rotation on.',
              ],
              resources: [
                'aws_kms_key',
                'aws_kms_alias',
                'aws_secretsmanager_secret',
                'aws_ssm_parameter',
              ],
            },
            {
              cells: [
                'Audit trail',
                'CloudTrail, Config',
                'aws_cloudtrail, aws_config_configuration_recorder, aws_config_config_rule, aws_config_delivery_channel',
                'One organization trail to a locked bucket in the security account; Config rules as the machine-readable half of the control set.',
              ],
              resources: [
                'aws_cloudtrail',
                'aws_config_configuration_recorder',
                'aws_config_config_rule',
                'aws_config_delivery_channel',
              ],
            },
            {
              cells: [
                'Detection',
                'GuardDuty, Security Hub, Inspector, Macie',
                'aws_guardduty_detector, aws_securityhub_account, aws_inspector2_enabler, aws_macie2_account',
                'Enabled from the organization’s delegated administrator so a new account is covered on creation, not on remembering.',
              ],
              resources: [
                'aws_guardduty_detector',
                'aws_securityhub_account',
                'aws_inspector2_enabler',
                'aws_macie2_account',
              ],
            },
            {
              cells: [
                'Monitoring',
                'CloudWatch',
                'aws_cloudwatch_log_group, aws_cloudwatch_metric_alarm, aws_cloudwatch_dashboard, aws_cloudwatch_event_rule',
                'A retention period on every log group, because the default is forever and it is billed as such.',
              ],
              resources: [
                'aws_cloudwatch_log_group',
                'aws_cloudwatch_metric_alarm',
                'aws_cloudwatch_dashboard',
                'aws_cloudwatch_event_rule',
              ],
            },
            {
              cells: [
                'Edge protection',
                'WAF, Shield',
                'aws_wafv2_web_acl, aws_wafv2_web_acl_association, aws_shield_protection',
                'Managed rule groups first, custom rules only where they earn it; associate the ACL to the load balancer or the distribution.',
              ],
              resources: [
                'aws_wafv2_web_acl',
                'aws_wafv2_web_acl_association',
                'aws_shield_protection',
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'aws-patterns',
      title: 'CCoE Patterns & Recipes (AWS)',
      badge: 'Patterns',
      tagline:
        'The stacks worth standing up once and reusing, and where the seam between them belongs.',
      tables: [
        {
          headers: ['Pattern', 'Scope', 'Terraform Stack', 'Language Options'],
          rows: [
            {
              cells: [
                'Landing zone',
                'Organization',
                'aws_organizations_organization, aws_organizations_account, aws_cloudtrail, aws_config_configuration_recorder',
                'One stack, run rarely, by a small group. Accounts from a map so adding one is a map entry and a plan.',
              ],
              resources: [
                'aws_organizations_organization',
                'aws_organizations_account',
                'aws_cloudtrail',
                'aws_config_configuration_recorder',
              ],
            },
            {
              cells: [
                'Account baseline',
                'Per account',
                'aws_vpc, aws_subnet, aws_iam_role, aws_kms_key, aws_cloudwatch_log_group',
                'A module applied by every account stack, versioned, so raising the baseline is a version bump rather than a sweep.',
              ],
              resources: [
                'aws_vpc',
                'aws_subnet',
                'aws_iam_role',
                'aws_kms_key',
                'aws_cloudwatch_log_group',
              ],
            },
            {
              cells: [
                'Workload stack',
                'Per application, per environment',
                'aws_instance, aws_lb, aws_db_instance, aws_s3_bucket',
                'Owned by the application team, consuming the baseline’s outputs by remote state rather than re-declaring them.',
              ],
              resources: ['aws_instance', 'aws_lb', 'aws_db_instance', 'aws_s3_bucket'],
            },
            {
              cells: [
                'Evidence store',
                'Security account',
                'aws_s3_bucket, aws_s3_bucket_object_lock_configuration, aws_backup_vault',
                'Write-once retention, a separate account, and no role in the workload accounts that can delete from it.',
              ],
              resources: [
                'aws_s3_bucket',
                'aws_s3_bucket_object_lock_configuration',
                'aws_backup_vault',
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Amazon Web Services (AWS) Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, unchanged. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { str } from '../../kit/blueprint.ts';
import { playbookFiles } from '../from-plays.ts';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.ts';
import { HOSTS_INPUT } from './common.ts';

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'ec2_instance',
    label: 'Provision EC2 instance',
    description: 'Create an EC2 instance with a basic security group.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Target region"
            },
            { id: "instance_name", label: "Instance Name tag", control: 'text', default: "web-01", hint: "Name tag" },
            {
              id: "instance_type",
              label: "Instance type",
              control: 'select',
              options: ["t3.micro", "t3.small", "t3.medium", "t3a.micro", "t3a.small", "t3a.medium"]
                .map(v => ({ value: v, label: v })),
              default: "t3.small",
              hint: "Size"
            },
            { id: "ami_id", label: "AMI ID", control: 'text', default: "ami-xxxxxxxx", hint: "AMI ID" },
            { id: "key_name", label: "SSH key name", control: 'text', default: "default", hint: "Key pair name" },
            { id: "vpc_subnet_id", label: "Subnet ID", control: 'text', default: "subnet-xxxx", hint: "VPC subnet" },
            { id: "security_group_name", label: "Security group name", control: 'text', default: "sg-web", hint: "SG name" },
            { id: "allowed_http_cidr", label: "HTTP allowed CIDR", control: 'text', default: "0.0.0.0/0", hint: "Lock this down in prod" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Provision EC2 instance",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                instance_name: vals.instance_name,
                instance_type: vals.instance_type,
                ami_id: vals.ami_id,
                key_name: vals.key_name,
                vpc_subnet_id: vals.vpc_subnet_id,
                security_group_name: vals.security_group_name,
                allowed_http_cidr: vals.allowed_http_cidr
              },
              tasks: [
                {
                  name: "Ensure security group exists",
                  "amazon.aws.ec2_security_group": {
                    name: "{{ security_group_name }}",
                    description: "Web security group",
                    region: "{{ aws_region }}",
                    rules: [
                      { proto: "tcp", from_port: 22, to_port: 22, cidr_ip: "0.0.0.0/0" },
                      { proto: "tcp", from_port: 80, to_port: 80, cidr_ip: "{{ allowed_http_cidr }}" }
                    ]
                  }
                },
                {
                  name: "Launch EC2 instance",
                  "amazon.aws.ec2_instance": {
                    name: "{{ instance_name }}",
                    region: "{{ aws_region }}",
                    image_id: "{{ ami_id }}",
                    instance_type: "{{ instance_type }}",
                    key_name: "{{ key_name }}",
                    vpc_subnet_id: "{{ vpc_subnet_id }}",
                    security_group: "{{ security_group_name }}",
                    wait: true
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'Provision EC2 instance',
      ),
  },
  {
    id: 's3_bucket',
    label: 'Create S3 bucket',
    description: 'Create S3 bucket with versioning and encryption.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Bucket region"
            },
            { id: "bucket_name", label: "Bucket name", control: 'text', default: "app-archive-bucket", hint: "Globally unique" },
            {
              id: "enable_versioning",
              label: "Enable versioning",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "true",
              hint: "true / false"
            },
            {
              id: "sse_algorithm",
              label: "SSE algorithm",
              control: 'select',
              options: [
                { value: "AES256", label: "AES256" },
                { value: "aws:kms", label: "aws:kms" }
              ],
              default: "AES256",
              hint: "Encryption"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create S3 bucket",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                bucket_name: vals.bucket_name,
                enable_versioning: vals.enable_versioning === "true",
                sse_algorithm: vals.sse_algorithm
              },
              tasks: [
                {
                  name: "Create bucket",
                  "amazon.aws.s3_bucket": {
                    name: "{{ bucket_name }}",
                    state: "present",
                    region: "{{ aws_region }}"
                  }
                },
                {
                  name: "Configure versioning",
                  "amazon.aws.s3_bucket": {
                    name: "{{ bucket_name }}",
                    region: "{{ aws_region }}",
                    versioning: { Status: "{{ 'Enabled' if enable_versioning else 'Suspended' }}" }
                  }
                },
                {
                  name: "Configure default encryption",
                  "amazon.aws.s3_bucket": {
                    name: "{{ bucket_name }}",
                    region: "{{ aws_region }}",
                    encryption_configuration: {
                      Rules: [
                        {
                          ApplyServerSideEncryptionByDefault: {
                            SSEAlgorithm: "{{ sse_algorithm }}"
                          }
                        }
                      ]
                    }
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'Create S3 bucket',
      ),
  },
  {
    id: 'vpc_baseline',
    label: 'Create VPC + subnets',
    description: 'Baseline VPC with public/private subnets and an Internet Gateway.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "vpc_cidr", label: "VPC CIDR", control: 'text', default: "10.0.0.0/16", hint: "CIDR block" },
            { id: "public_cidr", label: "Public subnet CIDR", control: 'text', default: "10.0.1.0/24", hint: "Public subnet" },
            { id: "private_cidr", label: "Private subnet CIDR", control: 'text', default: "10.0.2.0/24", hint: "Private subnet" },
            { id: "name_prefix", label: "Name prefix", control: 'text', default: "app-vpc", hint: "Tag prefix" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create baseline VPC",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                vpc_cidr: vals.vpc_cidr,
                public_cidr: vals.public_cidr,
                private_cidr: vals.private_cidr,
                name_prefix: vals.name_prefix
              },
              tasks: [
                {
                  name: "Create VPC",
                  "amazon.aws.ec2_vpc_net": {
                    name: "{{ name_prefix }}",
                    cidr_block: "{{ vpc_cidr }}",
                    region: "{{ aws_region }}",
                    tags: { Name: "{{ name_prefix }}" }
                  },
                  register: "vpc"
                },
                {
                  name: "Create Internet Gateway",
                  "amazon.aws.ec2_vpc_igw": {
                    vpc_id: "{{ vpc.vpc.id }}",
                    region: "{{ aws_region }}",
                    state: "present",
                    tags: { Name: "{{ name_prefix }}-igw" }
                  },
                  register: "igw"
                },
                {
                  name: "Create public subnet",
                  "amazon.aws.ec2_vpc_subnet": {
                    vpc_id: "{{ vpc.vpc.id }}",
                    cidr: "{{ public_cidr }}",
                    az: "{{ aws_region }}a",
                    map_public: true,
                    region: "{{ aws_region }}",
                    tags: { Name: "{{ name_prefix }}-public" }
                  },
                  register: "public_subnet"
                },
                {
                  name: "Create private subnet",
                  "amazon.aws.ec2_vpc_subnet": {
                    vpc_id: "{{ vpc.vpc.id }}",
                    cidr: "{{ private_cidr }}",
                    az: "{{ aws_region }}b",
                    region: "{{ aws_region }}",
                    tags: { Name: "{{ name_prefix }}-private" }
                  },
                  register: "private_subnet"
                },
                {
                  name: "Create public route table",
                  "amazon.aws.ec2_vpc_route_table": {
                    vpc_id: "{{ vpc.vpc.id }}",
                    region: "{{ aws_region }}",
                    tags: { Name: "{{ name_prefix }}-public-rt" },
                    subnets: ["{{ public_subnet.subnet.id }}"],
                    routes: [
                      { dest: "0.0.0.0/0", gateway_id: "{{ igw.gateway_id }}" }
                    ]
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'Create VPC + subnets',
      ),
  },
  {
    id: 'rds_instance',
    label: 'RDS – Database instance',
    description: 'Create an RDS instance for a relational database.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "db_identifier", label: "DB identifier", control: 'text', default: "app-rds-01", hint: "Instance ID" },
            {
              id: "engine",
              label: "Engine",
              control: 'select',
              options: [
                { value: "mysql", label: "MySQL" },
                { value: "postgres", label: "PostgreSQL" },
                { value: "oracle-ee", label: "Oracle EE" }
              ],
              default: "postgres",
              hint: "DB engine"
            },
            { id: "engine_version", label: "Engine version", control: 'text', default: "15", hint: "e.g. 15, 8.0.36" },
            {
              id: "instance_class",
              label: "Instance class",
              control: 'select',
              options: [
                "db.t3.micro",
                "db.t3.small",
                "db.t3.medium",
                "db.m5.large"
              ].map(v => ({ value: v, label: v })),
              default: "db.t3.small",
              hint: "Size"
            },
            { id: "allocated_storage", label: "Storage (GB)", control: 'number', default: 20, hint: "Initial storage" },
            { id: "master_username", label: "Master username", control: 'text', default: "dbadmin", hint: "Admin user" },
            { id: "master_password", label: "Master password", control: 'text', default: "ChangeMe123!", hint: "Use a secret in real life" },
            {
              id: "publicly_accessible",
              label: "Publicly accessible",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "true / false"
            },
            {
              id: "multi_az",
              label: "Multi-AZ",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "true",
              hint: "Enable Multi-AZ"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Provision RDS instance",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                db_identifier: vals.db_identifier,
                engine: vals.engine,
                engine_version: vals.engine_version,
                instance_class: vals.instance_class,
                allocated_storage: Number(vals.allocated_storage),
                master_username: vals.master_username,
                master_password: vals.master_password,
                publicly_accessible: vals.publicly_accessible === "true",
                multi_az: vals.multi_az === "true"
              },
              tasks: [
                {
                  name: "Create RDS instance",
                  "amazon.aws.rds_instance": {
                    region: "{{ aws_region }}",
                    db_instance_identifier: "{{ db_identifier }}",
                    engine: "{{ engine }}",
                    engine_version: "{{ engine_version }}",
                    db_instance_class: "{{ instance_class }}",
                    allocated_storage: "{{ allocated_storage }}",
                    master_username: "{{ master_username }}",
                    master_user_password: "{{ master_password }}",
                    multi_az: "{{ multi_az }}",
                    publicly_accessible: "{{ publicly_accessible }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'RDS – Database instance',
      ),
  },
  {
    id: 'dynamodb_table',
    label: 'DynamoDB – Table',
    description: 'Create a DynamoDB table with a simple key schema.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "table_name", label: "Table name", control: 'text', default: "AppSessions", hint: "DynamoDB table name" },
            { id: "hash_key_name", label: "Partition key name", control: 'text', default: "CaseId", hint: "Hash key" },
            {
              id: "billing_mode",
              label: "Billing mode",
              control: 'select',
              options: [
                { value: "PAY_PER_REQUEST", label: "On-demand" },
                { value: "PROVISIONED", label: "Provisioned" }
              ],
              default: "PAY_PER_REQUEST",
              hint: "Capacity mode"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create DynamoDB table",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                table_name: vals.table_name,
                hash_key_name: vals.hash_key_name,
                billing_mode: vals.billing_mode
              },
              tasks: [
                {
                  name: "Ensure DynamoDB table exists",
                  "community.aws.dynamodb_table": {
                    name: "{{ table_name }}",
                    region: "{{ aws_region }}",
                    hash_key_name: "{{ hash_key_name }}",
                    hash_key_type: "S",
                    billing_mode: "{{ billing_mode }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'DynamoDB – Table',
      ),
  },
  {
    id: 'sns_topic',
    label: 'SNS – Topic + subscription',
    description: 'Create an SNS topic and subscribe an email endpoint.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "topic_name", label: "Topic name", control: 'text', default: "app-notifications", hint: "Topic name" },
            { id: "subscription_email", label: "Subscriber email", control: 'text', default: "alerts@example.org", hint: "Email endpoint" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create SNS topic and subscription",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                topic_name: vals.topic_name,
                subscription_email: vals.subscription_email
              },
              tasks: [
                {
                  // community.aws.sns_topic carries its own subscriptions; the
                  // separate sns_subscription module no longer exists.
                  name: "Create SNS topic with its subscription",
                  "community.aws.sns_topic": {
                    name: "{{ topic_name }}",
                    region: "{{ aws_region }}",
                    subscriptions: [
                      { endpoint: "{{ subscription_email }}", protocol: "email" }
                    ]
                  },
                  register: "topic"
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'SNS – Topic + subscription',
      ),
  },
  {
    id: 'sqs_queue',
    label: 'SQS – Queue',
    description: 'Create an SQS queue for asynchronous workloads.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "queue_name", label: "Queue name", control: 'text', default: "app-jobs-queue", hint: "Queue name" },
            {
              id: "visibility_timeout",
              label: "Visibility timeout (sec)",
              control: 'number',
              default: 30,
              hint: "Default visibility timeout"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create SQS queue",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                queue_name: vals.queue_name,
                visibility_timeout: Number(vals.visibility_timeout)
              },
              tasks: [
                {
                  name: "Ensure SQS queue exists",
                  "community.aws.sqs_queue": {
                    name: "{{ queue_name }}",
                    region: "{{ aws_region }}",
                    visibility_timeout: "{{ visibility_timeout }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'SQS – Queue',
      ),
  },
  {
    id: 'kms_key',
    label: 'KMS – Customer managed key',
    description: 'Create a KMS CMK for encrypting app workloads.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "key_alias", label: "Key alias", control: 'text', default: "alias/app-data-key", hint: "Alias name" },
            { id: "description", label: "Key description", control: 'text', default: "App data encryption key", hint: "Description" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create KMS key",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                key_alias: vals.key_alias,
                description: vals.description
              },
              tasks: [
                {
                  name: "Create CMK",
                  "amazon.aws.kms_key": {
                    state: "present",
                    alias: "{{ key_alias }}",
                    description: "{{ description }}",
                    region: "{{ aws_region }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'KMS – Customer managed key',
      ),
  },
  {
    id: 'cloudwatch_alarm',
    label: 'CloudWatch – CPU alarm',
    description: 'Create a CPUUtilization alarm for an EC2 instance.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region"
            },
            { id: "alarm_name", label: "Alarm name", control: 'text', default: "HighCPU", hint: "Alarm name" },
            { id: "instance_id", label: "Instance ID", control: 'text', default: "i-xxxxxxxx", hint: "Target EC2 instance" },
            {
              id: "threshold",
              label: "Threshold (%)",
              control: 'number',
              default: 80,
              hint: "CPU threshold"
            },
            {
              id: "evaluation_periods",
              label: "Evaluation periods",
              control: 'number',
              default: 3,
              hint: "Number of periods"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Create CloudWatch CPU alarm",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                alarm_name: vals.alarm_name,
                instance_id: vals.instance_id,
                threshold: Number(vals.threshold),
                evaluation_periods: Number(vals.evaluation_periods)
              },
              tasks: [
                {
                  name: "Ensure CPU alarm exists",
                  "amazon.aws.cloudwatch_metric_alarm": {
                    name: "{{ alarm_name }}",
                    region: "{{ aws_region }}",
                    state: "present",
                    metric: "CPUUtilization",
                    namespace: "AWS/EC2",
                    statistic: "Average",
                    comparison: ">=",
                    threshold: "{{ threshold }}",
                    period: 300,
                    evaluation_periods: "{{ evaluation_periods }}",
                    dimensions: {
                      InstanceId: "{{ instance_id }}"
                    }
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'CloudWatch – CPU alarm',
      ),
  },
  {
    id: 'cloudtrail_trail',
    label: 'CloudTrail – Organization trail',
    description: 'Create or ensure a CloudTrail trail for auditing API calls.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "aws_region",
              label: "Home region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Trail home region"
            },
            { id: "trail_name", label: "Trail name", control: 'text', default: "org-audit-trail", hint: "CloudTrail name" },
            { id: "s3_bucket_name", label: "S3 bucket for logs", control: 'text', default: "app-cloudtrail-logs", hint: "Bucket must exist or be created" },
            {
              id: "is_multi_region",
              label: "Multi-region",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "true",
              hint: "Record in all regions"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => ([
            {
              name: "Configure CloudTrail trail",
              hosts,
              become: false,
              gather_facts: false,
              vars: {
                aws_region: vals.aws_region,
                trail_name: vals.trail_name,
                s3_bucket_name: vals.s3_bucket_name,
                is_multi_region: vals.is_multi_region === "true"
              },
              tasks: [
                {
                  name: "Ensure CloudTrail trail exists",
                  "amazon.aws.cloudtrail": {
                    name: "{{ trail_name }}",
                    region: "{{ aws_region }}",
                    s3_bucket_name: "{{ s3_bucket_name }}",
                    is_multi_region_trail: "{{ is_multi_region }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'CloudTrail – Organization trail',
      ),
  },
];

export const AWS_ANSIBLE: BlueprintGroup = {
  target: 'aws',
  label: 'Amazon Web Services (AWS)',
  blueprints: BLUEPRINTS,
};

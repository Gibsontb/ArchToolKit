/**
 * Amazon Web Services (AWS) Terraform blueprints.
 *
 * Ported from the previous toolkit's TERRA_DEFS — the inputs and the HCL
 * templates are the originals, unchanged. What is new around them: the inputs
 * are typed, so a one-of choice is a dropdown rather than a text box, and every
 * resource type a blueprint emits is checked against the committed provider
 * catalog by the test suite.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.ts';
import { error, type Finding } from '../../core/findings.ts';
import { dualStackInput, ipv4Range, isOn, sources } from './dual-stack.ts';

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'aws_ec2_instance',
    label: 'EC2 instance + security group',
    description: 'Basic EC2 instance in a VPC subnet with an attached security group.',
    inputs: [
            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Commercial + Gov / ISO regions"
            },
            { id: "instance_name", label: "Instance Name tag", control: 'text', default: "app-01", hint: "Name tag / logical name" },
            { id: "instance_type", label: "Instance type", control: 'text', default: "t3.small", hint: "e.g. t3.small, m5.large" },
            { id: "ami_id", label: "AMI ID", control: 'text', default: "ami-xxxxxxxx", hint: "Hardened AMI" },
            { id: "subnet_id", label: "Subnet ID", control: 'text', default: "subnet-xxxxxxx", hint: "Existing subnet" },
            { id: "vpc_security_group_name", label: "Security group name", control: 'text', default: "sg-app", hint: "SG created in this module" },
            { id: "allow_ssh_cidr", label: "Allowed SSH CIDR", control: 'text', default: "10.0.0.0/16", hint: "IPv4 or IPv6, comma-separated. Lock down in prod" },
            {
              id: "ipv6_address_count",
              label: "IPv6 addresses",
              control: 'select',
              options: [
                { value: "0", label: "None — IPv4 only" },
                { value: "1", label: "1 (subnet must have an IPv6 /64)" },
                { value: "2", label: "2" },
              ],
              default: "0",
              hint: "Assigned from the subnet's IPv6 range"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      const ssh = sources(values.allow_ssh_cidr, 'allow_ssh_cidr', 'terraform.aws_ec2_instance');
      if (ssh.v4.length + ssh.v6.length === 0 && ssh.findings.length === 0) {
        ssh.findings.push(error('terraform.aws_ec2_instance.no-ssh-source', 'No SSH source was given, so the rule admits nothing.', { path: 'allow_ssh_cidr' }));
      }
      const v6Count = Number(values.ipv6_address_count ?? 0) || 0;
      // Egress to the IPv6 internet only when the instance or its rules use IPv6.
      const v6 = v6Count > 0 || ssh.v6.length > 0;
      const hcl = (list: string[]): string => list.map((c) => `"${c}"`).join(", ");
      // One ingress block per family: cidr_blocks for IPv4, ipv6_cidr_blocks for IPv6.
      const sshIngress = [
        ...(ssh.v4.length > 0 || ssh.v6.length === 0 ? [`  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [${hcl(ssh.v4)}]
  }`] : []),
        ...(ssh.v6.length > 0 ? [`  ingress {
    description      = "SSH over IPv6"
    from_port        = 22
    to_port          = 22
    protocol         = "tcp"
    ipv6_cidr_blocks = [${hcl(ssh.v6)}]
  }`] : []),
      ].join("\n\n");
      const egressV6 = v6 ? `

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    ipv6_cidr_blocks = ["::/0"]
  }` : "";
      return {
      findings: ssh.findings,
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "aws_ec2_instance";
            return `# terraform init && terraform plan
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "${vals.aws_region}"
}

resource "aws_security_group" "this" {
  name        = "${vals.vpc_security_group_name}"
  description = "Security group for ${vals.instance_name}"
  vpc_id      = var.vpc_id

${sshIngress}

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }${egressV6}

  tags = {
    Name        = "${vals.vpc_security_group_name}"
    System      = "${m}"
    Environment = var.environment
  }
}

resource "aws_instance" "this" {
  ami                    = "${vals.ami_id}"
  instance_type          = "${vals.instance_type}"
  subnet_id              = "${vals.subnet_id}"
  vpc_security_group_ids = [aws_security_group.this.id]${v6Count > 0 ? `
  ipv6_address_count     = ${v6Count}` : ""}

  tags = {
    Name        = "${vals.instance_name}"
    System      = "${m}"
    Environment = var.environment
  }
}

variable "vpc_id" {
  type        = string
  description = "Target VPC ID"
}

variable "environment" {
  type        = string
  description = "Environment name (dev/stage/prod)"
  default     = "dev"
}
`;
          })(values, name),
      },
      };
    },
  },
  {
    id: 'aws_s3_secure_bucket',
    label: 'S3 bucket (versioned + encrypted)',
    description: 'S3 bucket with versioning, SSE and private access.',
    inputs: [
            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region for bucket"
            },
            { id: "bucket_name", label: "Bucket name", control: 'text', default: "app-records-archive", hint: "Globally unique" },
            { id: "sse_algorithm", label: "SSE algorithm", control: 'text', default: "aws:kms", hint: "AES256 or aws:kms" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "aws_s3_secure_bucket";
            return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "${vals.aws_region}"
}

resource "aws_s3_bucket" "this" {
  bucket = "${vals.bucket_name}"

  versioning {
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        sse_algorithm = "${vals.sse_algorithm}"
      }
    }
  }

  acl = "private"

  tags = {
    Name        = "${vals.bucket_name}"
    System      = "${m}"
    Environment = var.environment
  }
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Environment name"
}
`;
          })(values, name),
      },
    }),
  },
  {
    id: 'aws_vpc_baseline',
    label: 'VPC baseline (2 subnets + IGW)',
    description: 'Creates a VPC, two public subnets, an Internet Gateway and a route table.',
    inputs: [
            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region for VPC"
            },
            { id: "vpc_cidr", label: "VPC CIDR block", control: 'text', default: "10.20.0.0/16", hint: "Top-level CIDR (non-overlapping)" },
            { id: "subnet1_cidr", label: "Public subnet 1 CIDR", control: 'text', default: "10.20.1.0/24", hint: "AZ A" },
            { id: "subnet2_cidr", label: "Public subnet 2 CIDR", control: 'text', default: "10.20.2.0/24", hint: "AZ B" },
            { id: "name_prefix", label: "Name prefix", control: 'text', default: "app-vpc", hint: "Prefix for tags/names" },
            dualStackInput("Amazon allocates a /56; each subnet takes a /64 and routes ::/0 to the gateway")
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      const v6 = isOn(values.enable_ipv6);
      // The IPv4 ranges stay IPv4: a VPC cannot be built without one.
      const findings: Finding[] = [
        ...ipv4Range(values.vpc_cidr, 'vpc_cidr', 'The VPC CIDR', 'terraform.aws_vpc_baseline'),
        ...ipv4Range(values.subnet1_cidr, 'subnet1_cidr', 'Public subnet 1', 'terraform.aws_vpc_baseline'),
        ...ipv4Range(values.subnet2_cidr, 'subnet2_cidr', 'Public subnet 2', 'terraform.aws_vpc_baseline'),
      ];
      // The n-th /64 of the VPC's Amazon-allocated /56.
      const subnetV6 = (n: number): string => v6 ? `
  ipv6_cidr_block                 = cidrsubnet(aws_vpc.this.ipv6_cidr_block, 8, ${n})
  assign_ipv6_address_on_creation = true` : "";
      return {
      findings,
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "aws_vpc_baseline";
            return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "${vals.aws_region}"
}

resource "aws_vpc" "this" {
  cidr_block           = "${vals.vpc_cidr}"
  enable_dns_support   = true
  enable_dns_hostnames = true${v6 ? `

  # Amazon allocates the /56; subnets take /64s of it.
  assign_generated_ipv6_cidr_block = true` : ""}

  tags = {
    Name   = "${vals.name_prefix}"
    System = "${m}"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name   = "${vals.name_prefix}-igw"
    System = "${m}"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "${vals.subnet1_cidr}"
  map_public_ip_on_launch = true${subnetV6(0)}

  tags = {
    Name   = "${vals.name_prefix}-public-a"
    System = "${m}"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = "${vals.subnet2_cidr}"
  map_public_ip_on_launch = true${subnetV6(1)}

  tags = {
    Name   = "${vals.name_prefix}-public-b"
    System = "${m}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }${v6 ? `

  route {
    ipv6_cidr_block = "::/0"
    gateway_id      = aws_internet_gateway.this.id
  }` : ""}

  tags = {
    Name   = "${vals.name_prefix}-public-rt"
    System = "${m}"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}
`;
          })(values, name),
      },
      };
    },
  },
  {
    id: 'aws_rds_postgres',
    label: 'RDS PostgreSQL instance',
    description: 'Creates an RDS PostgreSQL instance and subnet group in existing subnets.',
    inputs: [
            {
              id: "aws_region",
              label: "AWS region",
              control: 'select',
              options: AWS_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-east-1",
              hint: "Region for RDS"
            },
            { id: "db_identifier", label: "DB identifier", control: 'text', default: "app-pgsql-01", hint: "Unique DB identifier" },
            { id: "db_name", label: "Database name", control: 'text', default: "app", hint: "Initial database name" },
            { id: "username", label: "Master username", control: 'text', default: "dbadmin", hint: "Master user (use secrets in prod)" },
            { id: "password", label: "Master password", control: 'text', default: "CHANGEME", hint: "Use secrets manager in prod" },
            { id: "subnet_ids_csv", label: "Subnet IDs (comma-separated)", control: 'text', default: "subnet-1,subnet-2", hint: "At least two subnets" },
            { id: "vpc_security_group_ids_csv", label: "VPC security group IDs (comma-separated)", control: 'text', default: "sg-xxxx", hint: "Existing SG(s)" },
            { id: "instance_class", label: "Instance class", control: 'text', default: "db.t3.medium", hint: "e.g. db.t3.medium" },
            { id: "storage_gb", label: "Allocated storage (GB)", control: 'number', default: "100", hint: "Storage size" },
            {
              id: "network_type",
              label: "Network type",
              control: 'select',
              options: [
                { value: "IPV4", label: "IPV4 — IPv4 only" },
                { value: "DUAL", label: "DUAL — IPv4 and IPv6 (subnets need IPv6 ranges)" },
              ],
              default: "IPV4",
              hint: "DUAL needs every subnet in the group to be dual-stack"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "aws_rds_postgres";
            const subnetList = vals.subnet_ids_csv.split(",").map((s: string) => s.trim()).filter(Boolean);
            const sgList = vals.vpc_security_group_ids_csv.split(",").map((s: string) => s.trim()).filter(Boolean);
            const subnetHcl = subnetList.map((s: string) => `"${s}"`).join(", ");
            const sgHcl = sgList.map((s: string) => `"${s}"`).join(", ");
            return `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "${vals.aws_region}"
}

resource "aws_db_subnet_group" "this" {
  name       = "${vals.db_identifier}-subnets"
  subnet_ids = [${subnetHcl}]

  tags = {
    Name   = "${vals.db_identifier}-subnets"
    System = "${m}"
  }
}

resource "aws_db_instance" "this" {
  identifier              = "${vals.db_identifier}"
  engine                  = "postgres"
  engine_version          = "15"
  instance_class          = "${vals.instance_class}"
  allocated_storage       = ${Number(vals.storage_gb) || 100}
  db_name                 = "${vals.db_name}"
  username                = "${vals.username}"
  password                = "${vals.password}"
  db_subnet_group_name    = aws_db_subnet_group.this.name
  vpc_security_group_ids  = [${sgHcl}]
  skip_final_snapshot     = true
  deletion_protection     = false
  publicly_accessible     = false${vals.network_type === "DUAL" ? `
  network_type            = "DUAL"` : ""}
  storage_encrypted       = true
  auto_minor_version_upgrade = true

  tags = {
    Name   = "${vals.db_identifier}"
    System = "${m}"
  }
}
`;
          })(values, name),
      },
    }),
  },
];

export const AWS_TERRAFORM: BlueprintGroup = {
  target: 'aws',
  label: 'Amazon Web Services (AWS)',
  blueprints: BLUEPRINTS,
};

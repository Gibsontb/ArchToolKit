# ATK AWS Terraform Export (manual)

Generated from: reports/manual/enriched.1768319239167.json

Creates:
- VPC, subnets (round-robin AZs), IGW
- Public RT (0.0.0.0/0 -> IGW)
- NAT per AZ **if** you have public subnets in that AZ
- Private RT per AZ (0.0.0.0/0 -> NAT) **only where NAT exists**
- Isolated RT (no default route)

Before plan/apply: fill empty CIDRs in terraform.tfvars.json.

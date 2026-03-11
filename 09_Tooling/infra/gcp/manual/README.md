# ATK GCP Terraform Export (manual)

Generated from: reports/manual/enriched.1768319239167.json

Creates:
- VPC network(s) (custom mode)
- Subnets in var.region
- Cloud Router + Cloud NAT for private subnets (only if private subnets exist)

Before plan/apply:
- set project_id in terraform.tfvars.json
- fill empty CIDRs in terraform.tfvars.json

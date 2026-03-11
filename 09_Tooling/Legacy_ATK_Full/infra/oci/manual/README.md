# ATK OCI Terraform Export (manual)

Generated from: reports/manual/enriched.1768319239167.json

Creates:
- VCN(s) + subnets
- Internet Gateway + public route table (only if public subnets exist)
- NAT Gateway + private route table (only if private subnets exist)

Before plan/apply:
- set tenancy/user/fingerprint/private_key_path/compartment_ocid in terraform.tfvars.json
- fill empty CIDRs in terraform.tfvars.json

# ATK Azure Terraform Export (manual)

Generated from: reports/manual/enriched.1768319239167.json

Creates:
- Resource group
- VNet(s) (from network.vpcs)
- Subnets
- NSG per subnet (associated)
- NAT Gateway + Public IP (only if there are private subnets), attached to private subnets

Before plan/apply: fill empty CIDRs in terraform.tfvars.json.

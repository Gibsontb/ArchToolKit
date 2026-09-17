terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.0.0" }
  }
}

provider "aws" { region = var.region }

data "aws_availability_zones" "available" { state = "available" }

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.max_azs)

  subnets_flat = flatten([
    for v in var.vpcs : [
      for idx, s in v.subnets : {
        vpc_name = v.name
        name     = s.name
        cidr     = s.cidr
        role     = lower(s.role)
        az       = local.azs[idx % length(local.azs)]
      }
    ]
  ])

  public_subnets   = [for s in local.subnets_flat : s if s.role == "public"]
  private_subnets  = [for s in local.subnets_flat : s if s.role == "private"]
  isolated_subnets = [for s in local.subnets_flat : s if s.role == "isolated"]

  public_subnet_by_vpc_az = {
    for key in distinct([for s in local.public_subnets : "${s.vpc_name}::${s.az}"]) :
    key => element([for s in local.public_subnets : s if "${s.vpc_name}::${s.az}" == key], 0)
  }

  private_subnets_by_vpc_az = {
    for key in distinct([for s in local.private_subnets : "${s.vpc_name}::${s.az}"]) :
    key => [for s in local.private_subnets : s if "${s.vpc_name}::${s.az}" == key]
  }
}

resource "aws_vpc" "vpc" {
  for_each = { for v in var.vpcs : v.name => v }
  cidr_block = each.value.cidr
  enable_dns_support = true
  enable_dns_hostnames = true
  tags = { Name = "${var.naming_prefix}-${each.key}" }
}

resource "aws_internet_gateway" "igw" {
  for_each = aws_vpc.vpc
  vpc_id = each.value.id
  tags = { Name = "${var.naming_prefix}-${each.key}-igw" }
}

resource "aws_subnet" "subnet" {
  for_each = { for s in local.subnets_flat : "${s.vpc_name}::${s.name}" => s }
  vpc_id = aws_vpc.vpc[each.value.vpc_name].id
  cidr_block = each.value.cidr
  availability_zone = each.value.az
  map_public_ip_on_launch = each.value.role == "public"
  tags = { Name="${var.naming_prefix}-${each.value.vpc_name}-${each.value.name}", Role=each.value.role, AZ=each.value.az }
}

resource "aws_route_table" "public" {
  for_each = aws_vpc.vpc
  vpc_id = each.value.id
  tags = { Name = "${var.naming_prefix}-${each.key}-rt-public" }
}

resource "aws_route" "public_default" {
  for_each = aws_route_table.public
  route_table_id = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.igw[each.key].id
}

resource "aws_route_table_association" "public_assoc" {
  for_each = { for s in local.public_subnets : "${s.vpc_name}::${s.name}" => s }
  subnet_id = aws_subnet.subnet["${each.value.vpc_name}::${each.value.name}"].id
  route_table_id = aws_route_table.public[each.value.vpc_name].id
}

resource "aws_eip" "nat_eip" {
  for_each = local.public_subnet_by_vpc_az
  domain = "vpc"
  tags = { Name = "${var.naming_prefix}-${each.value.vpc_name}-${each.value.az}-nat-eip" }
}

resource "aws_nat_gateway" "nat" {
  for_each = local.public_subnet_by_vpc_az
  allocation_id = aws_eip.nat_eip[each.key].id
  subnet_id = aws_subnet.subnet["${each.value.vpc_name}::${each.value.name}"].id
  tags = { Name = "${var.naming_prefix}-${each.value.vpc_name}-${each.value.az}-nat" }
  depends_on = [aws_internet_gateway.igw]
}

resource "aws_route_table" "private" {
  for_each = local.private_subnets_by_vpc_az
  vpc_id = aws_vpc.vpc[split("::", each.key)[0]].id
  tags = { Name = "${var.naming_prefix}-${split("::", each.key)[0]}-${split("::", each.key)[1]}-rt-private" }
}

# Only create default routes where a NAT exists for that (vpc,az)
resource "aws_route" "private_default" {
  for_each = {
    for k, rt in aws_route_table.private :
    k => rt if contains(keys(aws_nat_gateway.nat), k)
  }
  route_table_id = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = aws_nat_gateway.nat[each.key].id
}

resource "aws_route_table_association" "private_assoc" {
  for_each = { for s in local.private_subnets : "${s.vpc_name}::${s.name}" => s }
  subnet_id = aws_subnet.subnet["${each.value.vpc_name}::${each.value.name}"].id
  route_table_id = aws_route_table.private["${each.value.vpc_name}::${each.value.az}"].id
}

resource "aws_route_table" "isolated" {
  for_each = aws_vpc.vpc
  vpc_id = each.value.id
  tags = { Name = "${var.naming_prefix}-${each.key}-rt-isolated" }
}

resource "aws_route_table_association" "isolated_assoc" {
  for_each = { for s in local.isolated_subnets : "${s.vpc_name}::${s.name}" => s }
  subnet_id = aws_subnet.subnet["${each.value.vpc_name}::${each.value.name}"].id
  route_table_id = aws_route_table.isolated[each.value.vpc_name].id
}

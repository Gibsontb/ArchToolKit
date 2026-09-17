terraform {
  required_version = ">= 1.5.0"
  required_providers {
    oci = { source = "oracle/oci", version = ">= 5.0.0" }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

locals {
  vcns = var.vcns

  subnets_flat = flatten([
    for v in local.vcns : [
      for s in v.subnets : {
        vcn_name = v.name
        name     = s.name
        cidr     = s.cidr
        role     = lower(s.role)
      }
    ]
  ])

  public_subnets  = [for s in local.subnets_flat : s if s.role == "public"]
  private_subnets = [for s in local.subnets_flat : s if s.role == "private"]
}

resource "oci_core_vcn" "vcn" {
  for_each       = { for v in local.vcns : v.name => v }
  compartment_id = var.compartment_ocid
  display_name   = "${var.naming_prefix}-${each.key}"
  cidr_blocks    = [each.value.cidr]
  dns_label      = substr(replace(lower("${var.naming_prefix}${each.key}"), "/[^a-z0-9]/", ""), 0, 15)
}

resource "oci_core_internet_gateway" "igw" {
  for_each       = { for v in local.vcns : v.name => v if length([for s in local.public_subnets : s if s.vcn_name == v.name]) > 0 }
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "${var.naming_prefix}-${each.key}-igw"
  enabled        = true
}

resource "oci_core_nat_gateway" "nat" {
  for_each       = { for v in local.vcns : v.name => v if length([for s in local.private_subnets : s if s.vcn_name == v.name]) > 0 }
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "${var.naming_prefix}-${each.key}-nat"
}

resource "oci_core_route_table" "rt_public" {
  for_each       = oci_core_internet_gateway.igw
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "${var.naming_prefix}-${each.key}-rt-public"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = each.value.id
  }
}

resource "oci_core_route_table" "rt_private" {
  for_each       = oci_core_nat_gateway.nat
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn[each.key].id
  display_name   = "${var.naming_prefix}-${each.key}-rt-private"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = each.value.id
  }
}

resource "oci_core_subnet" "subnet" {
  for_each = { for s in local.subnets_flat : "${s.vcn_name}::${s.name}" => s }

  compartment_id      = var.compartment_ocid
  vcn_id              = oci_core_vcn.vcn[each.value.vcn_name].id
  cidr_block          = each.value.cidr
  display_name        = "${var.naming_prefix}-${replace(each.key, "::", "-")}"
  prohibit_public_ip_on_vnic = each.value.role != "public"

  route_table_id = each.value.role == "public"
    ? try(oci_core_route_table.rt_public[each.value.vcn_name].id, null)
    : try(oci_core_route_table.rt_private[each.value.vcn_name].id, null)
}

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = ">= 3.0.0" }
  }
}

provider "azurerm" { features {} }

locals {
  vnets = var.vnets

  subnets_flat = flatten([
    for v in local.vnets : [
      for s in v.subnets : {
        vnet_name = v.name
        name      = s.name
        cidr      = s.cidr
        role      = lower(s.role)
      }
    ]
  ])

  private_subnets = [for s in local.subnets_flat : s if s.role == "private"]
}

resource "azurerm_resource_group" "rg" {
  name     = "${var.naming_prefix}-rg"
  location = var.location
}

resource "azurerm_virtual_network" "vnet" {
  for_each            = { for v in local.vnets : v.name => v }
  name                = "${var.naming_prefix}-${each.key}"
  address_space       = [each.value.cidr]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet" "subnet" {
  for_each = { for s in local.subnets_flat : "${s.vnet_name}::${s.name}" => s }

  name                 = each.value.name
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet[each.value.vnet_name].name
  address_prefixes     = [each.value.cidr]
}

# Baseline NSG per subnet role
resource "azurerm_network_security_group" "nsg" {
  for_each            = { for s in local.subnets_flat : "${s.vnet_name}::${s.name}" => s }
  name                = "${var.naming_prefix}-${replace(each.key, "::", "-")}-nsg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet_network_security_group_association" "nsg_assoc" {
  for_each = azurerm_network_security_group.nsg
  subnet_id                 = azurerm_subnet.subnet[each.key].id
  network_security_group_id = each.value.id
}

# Optional: NAT Gateway for private subnets (one per deployment)
resource "azurerm_public_ip" "nat_pip" {
  count               = length(local.private_subnets) > 0 ? 1 : 0
  name                = "${var.naming_prefix}-nat-pip"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_nat_gateway" "nat" {
  count               = length(local.private_subnets) > 0 ? 1 : 0
  name                = "${var.naming_prefix}-nat"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "Standard"
}

resource "azurerm_nat_gateway_public_ip_association" "nat_ip_assoc" {
  count                = length(local.private_subnets) > 0 ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.nat[0].id
  public_ip_address_id = azurerm_public_ip.nat_pip[0].id
}

resource "azurerm_subnet_nat_gateway_association" "nat_assoc" {
  for_each = { for s in local.private_subnets : "${s.vnet_name}::${s.name}" => s }
  subnet_id      = azurerm_subnet.subnet[each.key].id
  nat_gateway_id = azurerm_nat_gateway.nat[0].id
}

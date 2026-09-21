/**
 * Microsoft Azure Terraform blueprints.
 *
 * Ported from the previous toolkit's TERRA_DEFS — the inputs and the HCL
 * templates are the originals, unchanged. What is new around them: the inputs
 * are typed, so a one-of choice is a dropdown rather than a text box, and every
 * resource type a blueprint emits is checked against the committed provider
 * catalog by the test suite.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.ts';

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'azurerm_linux_vm',
    label: 'Linux VM + NIC + NSG',
    description: 'Resource group, network, NSG and a Linux VM.',
    inputs: [
            {
              id: "location",
              label: "Location",
              control: 'select',
              options: AZURE_REGIONS.map(r => ({ value: r, label: r })),
              default: "eastus",
              hint: "Commercial + US Gov / DoD / Secret"
            },
            { id: "rg_name", label: "Resource group name", control: 'text', default: "rg-app", hint: "New RG" },
            { id: "vm_name", label: "VM name", control: 'text', default: "app-az-linux-01", hint: "Linux VM name" },
            { id: "vm_size", label: "VM size", control: 'text', default: "Standard_B2s", hint: "Size / SKU" },
            { id: "admin_username", label: "Admin username", control: 'text', default: "dbadmin", hint: "SSH login user" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "azurerm_linux_vm";
            return `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "this" {
  name     = "${vals.rg_name}"
  location = "${vals.location}"
}

resource "azurerm_virtual_network" "this" {
  name                = "${vals.rg_name}-vnet"
  address_space       = ["10.10.0.0/16"]
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_subnet" "this" {
  name                 = "subnet-app"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = ["10.10.1.0/24"]
}

resource "azurerm_network_security_group" "this" {
  name                = "${vals.rg_name}-nsg"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name

  security_rule {
    name                       = "SSH"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = "10.0.0.0/8"
    destination_address_prefix = "*"
  }

  tags = {
    System      = "${m}"
    Environment = "dev"
  }
}

resource "azurerm_network_interface" "this" {
  name                = "${vals.vm_name}-nic"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.this.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_network_interface_security_group_association" "this" {
  network_interface_id      = azurerm_network_interface.this.id
  network_security_group_id = azurerm_network_security_group.this.id
}

resource "azurerm_linux_virtual_machine" "this" {
  name                = "${vals.vm_name}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  size                = "${vals.vm_size}"
  admin_username      = "${vals.admin_username}"

  network_interface_ids = [azurerm_network_interface.this.id]

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-focal"
    sku       = "20_04-lts"
    version   = "latest"
  }

  admin_ssh_key {
    username   = "${vals.admin_username}"
    public_key = var.admin_ssh_public_key
  }

  tags = {
    System      = "${m}"
    Environment = "dev"
  }
}

variable "admin_ssh_public_key" {
  type        = string
  description = "SSH public key for admin user"
}
`;
          })(values, name),
      },
    }),
  },
  {
    id: 'azurerm_storage_account_secure',
    label: 'Secure Storage Account',
    description: 'Creates a storage account locked to HTTPS, TLS 1.2+, with private access.',
    inputs: [
            {
              id: "location",
              label: "Location",
              control: 'select',
              options: AZURE_REGIONS.map(r => ({ value: r, label: r })),
              default: "eastus",
              hint: "Region for storage account"
            },
            { id: "rg_name", label: "Resource group name", control: 'text', default: "rg-app-storage", hint: "Existing or new RG" },
            { id: "storage_account_name", label: "Storage account name", control: 'text', default: "appstoracct01", hint: "Globally unique" },
            { id: "account_tier", label: "Account tier", control: 'select', options: [{ value: 'Standard', label: 'Standard' }, { value: 'Premium', label: 'Premium' }], default: "Standard", hint: "Standard or Premium" },
            { id: "replication_type", label: "Replication type", control: 'select', options: [{ value: 'LRS', label: 'LRS — locally redundant' }, { value: 'ZRS', label: 'ZRS — zone redundant' }, { value: 'GRS', label: 'GRS — geo redundant' }, { value: 'RAGRS', label: 'RAGRS — geo redundant, read access' }, { value: 'GZRS', label: 'GZRS — geo-zone redundant' }, { value: 'RAGZRS', label: 'RAGZRS — geo-zone redundant, read access' }], default: "LRS", hint: "LRS, GRS, RAGRS, ZRS..." }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "azurerm_storage_account_secure";
            return `terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "this" {
  name     = "${vals.rg_name}"
  location = "${vals.location}"
}

resource "azurerm_storage_account" "this" {
  name                     = "${vals.storage_account_name}"
  resource_group_name      = azurerm_resource_group.this.name
  location                 = azurerm_resource_group.this.location
  account_tier             = "${vals.account_tier}"
  account_replication_type = "${vals.replication_type}"

  allow_blob_public_access      = false
  min_tls_version               = "TLS1_2"
  enable_https_traffic_only     = true
  infrastructure_encryption_enabled = true

  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
  }

  tags = {
    System      = "${m}"
    Environment = "dev"
  }
}
`;
          })(values, name),
      },
    }),
  },
];

export const AZURE_TERRAFORM: BlueprintGroup = {
  target: 'azure',
  label: 'Microsoft Azure',
  blueprints: BLUEPRINTS,
};

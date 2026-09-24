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
import { str } from '../../kit/blueprint.ts';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.ts';
import { error, type Finding } from '../../core/findings.ts';
import { containsAny } from '../../core/ip.ts';
import { dualStackInput, ipv4Range, ipv6Range, isOn, nthSlash64, sources } from './dual-stack.ts';

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
            { id: "admin_username", label: "Admin username", control: 'text', default: "dbadmin", hint: "SSH login user" },
            { id: "vnet_cidr", label: "VNet address space", control: 'text', default: "10.10.0.0/16", hint: "IPv4 range" },
            { id: "subnet_cidr", label: "Subnet address prefix", control: 'text', default: "10.10.1.0/24", hint: "IPv4, inside the VNet" },
            { id: "ssh_source_cidr", label: "SSH allowed from", control: 'text', default: "10.0.0.0/8", hint: "IPv4 or IPv6, comma-separated. One rule per family" },
            dualStackInput("Adds an IPv6 range to the VNet, a /64 to the subnet and an IPv6 address to the NIC"),
            {
              id: "vnet_ipv6_cidr",
              label: "VNet IPv6 address space",
              control: 'text',
              default: "fd00:db8:deca::/48",
              hint: "A /48 is usual: ULA (fd00::/8) or your assigned global range",
              showWhen: { input: "enable_ipv6", equals: ["true"] }
            },
            {
              id: "subnet_ipv6_cidr",
              label: "Subnet IPv6 prefix",
              control: 'text',
              default: "",
              placeholder: "First /64 of the VNet range",
              hint: "Must be a /64 — the only IPv6 size an Azure subnet takes",
              showWhen: { input: "enable_ipv6", equals: ["true"] }
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      const code = 'terraform.azurerm_linux_vm';
      const v6 = isOn(values.enable_ipv6);
      const vnetCidr = str(values, 'vnet_cidr', '10.10.0.0/16');
      const subnetCidr = str(values, 'subnet_cidr', '10.10.1.0/24');
      const findings: Finding[] = [
        ...ipv4Range(vnetCidr, 'vnet_cidr', 'The VNet address space', code),
        ...ipv4Range(subnetCidr, 'subnet_cidr', 'The subnet prefix', code),
      ];
      const ssh = sources(str(values, 'ssh_source_cidr', '10.0.0.0/8'), 'ssh_source_cidr', code, { ipv6Network: v6 });
      findings.push(...ssh.findings);
      let vnetV6 = '';
      let subnetV6 = '';
      if (v6) {
        const vnet = ipv6Range(values.vnet_ipv6_cidr, 'vnet_ipv6_cidr', 'The VNet IPv6 address space', code, { maxPrefix: 64 });
        findings.push(...vnet.findings);
        vnetV6 = vnet.cidr ?? '';
        if (str(values, 'subnet_ipv6_cidr')) {
          const sub = ipv6Range(values.subnet_ipv6_cidr, 'subnet_ipv6_cidr', 'The subnet IPv6 prefix', code, { maxPrefix: 64, exact: true });
          findings.push(...sub.findings);
          subnetV6 = sub.cidr ?? '';
          if (sub.cidr && vnet.cidr && !containsAny(vnet.cidr, sub.cidr.split('/')[0]!)) {
            findings.push(error(`${code}.subnet-ipv6-outside`, `${sub.cidr} is not inside ${vnet.cidr}.`, { path: 'subnet_ipv6_cidr' }));
          }
        } else if (vnet.cidr) {
          subnetV6 = nthSlash64(vnet.cidr, 0);
        }
      }
      const list = (items: string[]): string => items.map((c) => `"${c}"`).join(", ");
      // A rule's source is one family, so IPv4 and IPv6 sources are separate rules.
      const rule = (ruleName: string, priority: number, from: string[]): string => `  security_rule {
    name                       = "${ruleName}"
    priority                   = ${priority}
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    ${from.length === 1 ? `source_address_prefix      = "${from[0]}"` : `source_address_prefixes    = [${list(from)}]`}
    destination_address_prefix = "*"
  }`;
      const rules = [
        ...(ssh.v4.length > 0 ? [rule("SSH", 100, ssh.v4)] : []),
        ...(ssh.v6.length > 0 ? [rule("SSH-IPv6", 110, ssh.v6)] : []),
      ].join("\n\n");
      return {
      findings,
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
  address_space       = [${list(v6 ? [vnetCidr, vnetV6] : [vnetCidr])}]
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
}

resource "azurerm_subnet" "this" {
  name                 = "subnet-app"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [${list(v6 ? [subnetCidr, subnetV6] : [subnetCidr])}]
}

resource "azurerm_network_security_group" "this" {
  name                = "${vals.rg_name}-nsg"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name

${rules}

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
    private_ip_address_allocation = "Dynamic"${v6 ? `
    # With two configurations one must be primary, and it must be the IPv4 one.
    primary                       = true
  }

  ip_configuration {
    name                          = "internal-ipv6"
    subnet_id                     = azurerm_subnet.this.id
    private_ip_address_allocation = "Dynamic"
    private_ip_address_version    = "IPv6"` : ""}
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
      };
    },
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

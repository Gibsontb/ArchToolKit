/**
 * Microsoft Azure Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, unchanged. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { str } from '../../kit/blueprint.ts';
import { playbookFiles } from '../from-plays.ts';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.ts';
import { HOSTS_INPUT } from './common.ts';
import { error, info, type Finding } from '../../core/findings.ts';
import { containsAny } from '../../core/ip.ts';
import type { PlaybookFiles } from '../from-plays.ts';
import { dualStackInput, ipv4Range, ipv6Range, isOn, nthSlash64 } from './ipv6.ts';

/**
 * The VM playbooks build their own VNet and subnet, whose ranges were fixed
 * literals; they are inputs now, and IPv4 (a VNet cannot be IPv6-only). A
 * dual-stack NIC is not generated here — see the note — so these stay IPv4.
 */
function withVmNetworkChecks(values: BlueprintValues, code: string, out: PlaybookFiles): PlaybookFiles {
  const findings: Finding[] = [
    ...ipv4Range(str(values, 'vnet_prefix', '10.10.0.0/16'), 'vnet_prefix', 'The VNet address prefix', code),
    ...ipv4Range(str(values, 'subnet_prefix', '10.10.1.0/24'), 'subnet_prefix', 'The subnet prefix', code),
  ];
  const vnet = str(values, 'vnet_prefix');
  const subnet = str(values, 'subnet_prefix');
  if (findings.length === 0 && vnet && subnet && !containsAny(vnet, subnet.split('/')[0]!)) {
    findings.push(error(`${code}.subnet-outside-vnet`, `${subnet} is not inside ${vnet}.`, { path: 'subnet_prefix' }));
  }
  findings.push(
    info(`${code}.ipv4-only-nic`, 'VERIFY: this VM is IPv4 only. A dual-stack NIC needs a second ip_configuration with private_ip_address_version IPv6 on azure_rm_networkinterface; confirm your azure.azcollection version accepts it before adding it.', {
      path: 'subnet_prefix',
    }),
  );
  return { ...out, findings: [...findings, ...out.findings] };
}

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'vm_linux',
    label: 'Compute – Linux VM',
    description: 'Create a Linux VM, NIC and basic network resources.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-ansible-demo", hint: "Existing or to create" },
            { id: "vm_name", label: "VM name", control: 'text', default: "vm-linux-01", hint: "Name of the VM" },
            { id: "vm_size", label: "VM size", control: 'text', default: "Standard_B2s", hint: "e.g. Standard_B2s" },
            { id: "admin_username", label: "Admin username", control: 'text', default: "azureuser", hint: "SSH user" },
            { id: "vnet_prefix", label: "VNet address prefix", control: 'text', default: "10.10.0.0/16", hint: "IPv4 range" },
            { id: "subnet_prefix", label: "Subnet address prefix", control: 'text', default: "10.10.1.0/24", hint: "IPv4, inside the VNet" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      withVmNetworkChecks(values, 'ansible.azure.vm_linux', playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Provision Azure Linux VM",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  vm_name: vals.vm_name,
                  vm_size: vals.vm_size,
                  admin_username: vals.admin_username
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Ensure virtual network exists",
                    "azure.azcollection.azure_rm_virtualnetwork": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ resource_group }}-vnet",
                      address_prefixes: [str(vals, 'vnet_prefix', '10.10.0.0/16')]
                    }
                  },
                  {
                    name: "Ensure subnet exists",
                    "azure.azcollection.azure_rm_subnet": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ resource_group }}-subnet",
                      address_prefix: str(vals, 'subnet_prefix', '10.10.1.0/24'),
                      virtual_network: "{{ resource_group }}-vnet"
                    }
                  },
                  {
                    name: "Create public IP",
                    "azure.azcollection.azure_rm_publicipaddress": {
                      resource_group: "{{ resource_group }}",
                      allocation_method: "Static",
                      name: "{{ vm_name }}-pip"
                    }
                  },
                  {
                    name: "Create NIC",
                    "azure.azcollection.azure_rm_networkinterface": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vm_name }}-nic",
                      virtual_network: "{{ resource_group }}-vnet",
                      subnet: "{{ resource_group }}-subnet",
                      public_ip_name: "{{ vm_name }}-pip"
                    }
                  },
                  {
                    name: "Provision Azure VM",
                    "azure.azcollection.azure_rm_virtualmachine": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vm_name }}",
                      vm_size: "{{ vm_size }}",
                      admin_username: "{{ admin_username }}",
                      network_interfaces: ["{{ vm_name }}-nic"],
                      image: {
                        offer: "0001-com-ubuntu-server-focal",
                        publisher: "Canonical",
                        sku: "20_04-lts",
                        version: "latest"
                      }
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Compute – Linux VM',
      )),
  },
  {
    id: 'vm_windows',
    label: 'Compute – Windows VM',
    description: 'Create a Windows VM in Azure with basic network resources.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-win-servers", hint: "Existing or to create" },
            { id: "vm_name", label: "VM name", control: 'text', default: "vm-win-01", hint: "Name of the VM" },
            { id: "vm_size", label: "VM size", control: 'text', default: "Standard_B2ms", hint: "e.g. Standard_B2ms" },
            { id: "admin_username", label: "Admin username", control: 'text', default: "azureadmin", hint: "Local admin user" },
            { id: "admin_password", label: "Admin password", control: 'text', default: "CHANGE_ME!", hint: "Use secret in real life" },
            { id: "vnet_prefix", label: "VNet address prefix", control: 'text', default: "10.20.0.0/16", hint: "IPv4 range" },
            { id: "subnet_prefix", label: "Subnet address prefix", control: 'text', default: "10.20.1.0/24", hint: "IPv4, inside the VNet" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      withVmNetworkChecks(values, 'ansible.azure.vm_windows', playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Provision Azure Windows VM",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  vm_name: vals.vm_name,
                  vm_size: vals.vm_size,
                  admin_username: vals.admin_username,
                  admin_password: vals.admin_password
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Ensure virtual network exists",
                    "azure.azcollection.azure_rm_virtualnetwork": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ resource_group }}-vnet",
                      address_prefixes: [str(vals, 'vnet_prefix', '10.20.0.0/16')]
                    }
                  },
                  {
                    name: "Ensure subnet exists",
                    "azure.azcollection.azure_rm_subnet": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ resource_group }}-subnet",
                      address_prefix: str(vals, 'subnet_prefix', '10.20.1.0/24'),
                      virtual_network: "{{ resource_group }}-vnet"
                    }
                  },
                  {
                    name: "Create public IP",
                    "azure.azcollection.azure_rm_publicipaddress": {
                      resource_group: "{{ resource_group }}",
                      allocation_method: "Static",
                      name: "{{ vm_name }}-pip"
                    }
                  },
                  {
                    name: "Create NIC",
                    "azure.azcollection.azure_rm_networkinterface": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vm_name }}-nic",
                      virtual_network: "{{ resource_group }}-vnet",
                      subnet: "{{ resource_group }}-subnet",
                      public_ip_name: "{{ vm_name }}-pip"
                    }
                  },
                  {
                    name: "Provision Azure Windows VM",
                    "azure.azcollection.azure_rm_virtualmachine": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vm_name }}",
                      vm_size: "{{ vm_size }}",
                      admin_username: "{{ admin_username }}",
                      admin_password: "{{ admin_password }}",
                      os_type: "Windows",
                      network_interfaces: ["{{ vm_name }}-nic"],
                      image: {
                        offer: "WindowsServer",
                        publisher: "MicrosoftWindowsServer",
                        sku: "2019-Datacenter",
                        version: "latest"
                      }
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Compute – Windows VM',
      )),
  },
  {
    id: 'vnet_baseline',
    label: 'Network – VNet + subnets',
    description: 'Create a VNet with public/private subnets.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-network", hint: "Resource group" },
            { id: "vnet_name", label: "VNet name", control: 'text', default: "app-vnet", hint: "Virtual network name" },
            { id: "address_prefix", label: "VNet address prefix", control: 'text', default: "10.30.0.0/16", hint: "CIDR" },
            { id: "public_subnet_prefix", label: "Public subnet prefix", control: 'text', default: "10.30.1.0/24", hint: "CIDR" },
            { id: "private_subnet_prefix", label: "Private subnet prefix", control: 'text', default: "10.30.2.0/24", hint: "CIDR" },
            dualStackInput("Adds an IPv6 range to the VNet and a /64 to each subnet"),
            {
              id: "vnet_ipv6_prefix",
              label: "VNet IPv6 address prefix",
              control: 'text',
              default: "fd00:db8:deca::/48",
              hint: "A /48 is usual: ULA (fd00::/8) or your assigned global range",
              showWhen: { input: "enable_ipv6", equals: ["true"] }
            },
            {
              id: "public_subnet_ipv6_prefix",
              label: "Public subnet IPv6 prefix",
              control: 'text',
              default: "",
              placeholder: "First /64 of the VNet range",
              hint: "A /64 — the only IPv6 size an Azure subnet takes",
              showWhen: { input: "enable_ipv6", equals: ["true"] }
            },
            {
              id: "private_subnet_ipv6_prefix",
              label: "Private subnet IPv6 prefix",
              control: 'text',
              default: "",
              placeholder: "Second /64 of the VNet range",
              hint: "A /64",
              showWhen: { input: "enable_ipv6", equals: ["true"] }
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      const code = 'ansible.azure.vnet_baseline';
      const v6 = isOn(values.enable_ipv6);
      const findings: Finding[] = [
        ...ipv4Range(values.address_prefix, 'address_prefix', 'The VNet address prefix', code),
        ...ipv4Range(values.public_subnet_prefix, 'public_subnet_prefix', 'The public subnet prefix', code),
        ...ipv4Range(values.private_subnet_prefix, 'private_subnet_prefix', 'The private subnet prefix', code),
      ];
      let vnetV6 = '';
      const subnetsV6: string[] = [];
      if (v6) {
        const vnet = ipv6Range(values.vnet_ipv6_prefix, 'vnet_ipv6_prefix', 'The VNet IPv6 address prefix', code, { maxPrefix: 63 });
        findings.push(...vnet.findings);
        vnetV6 = vnet.cidr ?? '';
        (['public_subnet_ipv6_prefix', 'private_subnet_ipv6_prefix'] as const).forEach((id, n) => {
          if (str(values, id)) {
            const sub = ipv6Range(values[id], id, 'A subnet IPv6 prefix', code, { maxPrefix: 64, exact: true });
            findings.push(...sub.findings);
            if (sub.cidr && vnet.cidr && !containsAny(vnet.cidr, sub.cidr.split('/')[0]!)) {
              findings.push(error(`${code}.subnet-ipv6-outside`, `${sub.cidr} is not inside ${vnet.cidr}.`, { path: id }));
            }
            subnetsV6.push(sub.cidr ?? '');
          } else {
            subnetsV6.push(vnet.cidr ? nthSlash64(vnet.cidr, n) : '');
          }
        });
      }
      // Dual stack: a list of both families, in the plural argument.
      const subnetPrefix = (v4Var: string, n: number) =>
        v6 ? { address_prefixes_cidr: [`{{ ${v4Var} }}`, `{{ ${n === 0 ? 'public' : 'private'}_subnet_ipv6_prefix }}`] } : { address_prefix: `{{ ${v4Var} }}` };
      const out = playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Azure VNet and subnets",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  vnet_name: vals.vnet_name,
                  address_prefix: vals.address_prefix,
                  public_subnet_prefix: vals.public_subnet_prefix,
                  private_subnet_prefix: vals.private_subnet_prefix,
                  ...(v6
                    ? {
                        vnet_ipv6_prefix: vnetV6,
                        public_subnet_ipv6_prefix: subnetsV6[0] ?? '',
                        private_subnet_ipv6_prefix: subnetsV6[1] ?? ''
                      }
                    : {})
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create VNet",
                    "azure.azcollection.azure_rm_virtualnetwork": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vnet_name }}",
                      address_prefixes: v6 ? ["{{ address_prefix }}", "{{ vnet_ipv6_prefix }}"] : ["{{ address_prefix }}"]
                    }
                  },
                  {
                    name: "Create public subnet",
                    "azure.azcollection.azure_rm_subnet": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vnet_name }}-public",
                      ...subnetPrefix('public_subnet_prefix', 0),
                      virtual_network: "{{ vnet_name }}"
                    }
                  },
                  {
                    name: "Create private subnet",
                    "azure.azcollection.azure_rm_subnet": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vnet_name }}-private",
                      ...subnetPrefix('private_subnet_prefix', 1),
                      virtual_network: "{{ vnet_name }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Network – VNet + subnets',
      );
      return { ...out, findings: [...findings, ...out.findings] };
    },
  },
  {
    id: 'storage_account',
    label: 'Storage – Account & container',
    description: 'Create a Storage Account and a Blob container.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-storage", hint: "Resource group" },
            { id: "account_name", label: "Storage account name", control: 'text', default: "apparchive001", hint: "Globally unique" },
            { id: "container_name", label: "Container name", control: 'text', default: "documents", hint: "Blob container" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Storage account and container",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  account_name: vals.account_name,
                  container_name: vals.container_name
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create storage account",
                    "azure.azcollection.azure_rm_storageaccount": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ account_name }}",
                      location: "{{ azure_location }}",
                      account_type: "Standard_LRS"
                    }
                  },
                  {
                    name: "Create blob container",
                    "azure.azcollection.azure_rm_storageblob": {
                      resource_group: "{{ resource_group }}",
                      storage_account_name: "{{ account_name }}",
                      container: "{{ container_name }}",
                      type: "container"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Storage – Account & container',
      ),
  },
  {
    id: 'sql_db',
    label: 'SQL – Server & database',
    description: 'Create an Azure SQL logical server and a database.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-sql", hint: "Resource group name" },
            { id: "sql_server_name", label: "SQL server name", control: 'text', default: "app-sql-srv", hint: "Globally unique DNS name" },
            { id: "admin_username", label: "Admin login", control: 'text', default: "sqladmin", hint: "SQL admin login" },
            { id: "admin_password", label: "Admin password", control: 'text', default: "CHANGE_ME!", hint: "Use secret in production" },
            { id: "db_name", label: "Database name", control: 'text', default: "app", hint: "DB name" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Azure SQL server & DB",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  sql_server_name: vals.sql_server_name,
                  admin_username: vals.admin_username,
                  admin_password: vals.admin_password,
                  db_name: vals.db_name
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create SQL logical server",
                    "azure.azcollection.azure_rm_sqlserver": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ sql_server_name }}",
                      location: "{{ azure_location }}",
                      admin_username: "{{ admin_username }}",
                      admin_password: "{{ admin_password }}"
                    }
                  },
                  {
                    name: "Create SQL database",
                    "azure.azcollection.azure_rm_sqldatabase": {
                      resource_group: "{{ resource_group }}",
                      server_name: "{{ sql_server_name }}",
                      name: "{{ db_name }}",
                      edition: "Standard",
                      requested_service_objective_name: "S0"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'SQL – Server & database',
      ),
  },
  {
    id: 'app_service',
    label: 'App Service – Web App',
    description: 'Create an App Service plan and a Linux Web App.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-apps", hint: "Resource group" },
            { id: "plan_name", label: "App Service plan name", control: 'text', default: "app-plan", hint: "Plan name" },
            { id: "sku", label: "SKU", control: 'text', default: "B1", hint: "e.g. F1, B1, P1v3" },
            { id: "webapp_name", label: "Web app name", control: 'text', default: "app-webapp", hint: "Unique webapp name" },
            { id: "runtime_stack", label: "Runtime stack", control: 'text', default: "DOTNETCORE|6.0", hint: "Linux runtime (e.g. DOTNETCORE|6.0)" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Azure App Service Web App",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  plan_name: vals.plan_name,
                  sku: vals.sku,
                  webapp_name: vals.webapp_name,
                  runtime_stack: vals.runtime_stack
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create App Service plan",
                    "azure.azcollection.azure_rm_appserviceplan": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ plan_name }}",
                      location: "{{ azure_location }}",
                      sku: "{{ sku }}",
                      is_linux: true
                    }
                  },
                  {
                    name: "Create Web App",
                    "azure.azcollection.azure_rm_webapp": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ webapp_name }}",
                      plan: "{{ plan_name }}",
                      location: "{{ azure_location }}",
                      linux_fx_version: "{{ runtime_stack }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'App Service – Web App',
      ),
  },
  {
    id: 'aks_cluster',
    label: 'AKS – Kubernetes cluster',
    description: 'Create a basic AKS cluster.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-aks", hint: "Resource group" },
            { id: "aks_name", label: "AKS cluster name", control: 'text', default: "app-aks", hint: "Cluster name" },
            {
              id: "node_count",
              label: "Node count",
              control: 'number',
              default: 3,
              hint: "Number of nodes"
            },
            { id: "node_vm_size", label: "Node VM size", control: 'text', default: "Standard_DS2_v2", hint: "VM size" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create AKS cluster",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  aks_name: vals.aks_name,
                  node_count: Number(vals.node_count),
                  node_vm_size: vals.node_vm_size
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create AKS cluster",
                    "azure.azcollection.azure_rm_aks": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ aks_name }}",
                      location: "{{ azure_location }}",
                      dns_prefix: "{{ aks_name }}",
                      kubernetes_version: "",
                      agent_pool_profiles: [
                        {
                          name: "nodepool1",
                          count: "{{ node_count }}",
                          vm_size: "{{ node_vm_size }}",
                          os_type: "Linux"
                        }
                      ]
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'AKS – Kubernetes cluster',
      ),
  },
  {
    id: 'log_analytics',
    label: 'Monitor – Log Analytics workspace',
    description: 'Create a Log Analytics workspace for monitoring.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-monitor", hint: "Resource group" },
            { id: "workspace_name", label: "Workspace name", control: 'text', default: "app-laworkspace", hint: "Log Analytics workspace" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Log Analytics workspace",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  workspace_name: vals.workspace_name
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create Log Analytics workspace",
                    "azure.azcollection.azure_rm_loganalyticsworkspace": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ workspace_name }}",
                      location: "{{ azure_location }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Monitor – Log Analytics workspace',
      ),
  },
  {
    id: 'key_vault',
    label: 'Security – Key Vault',
    description: 'Create a Key Vault and a sample secret.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "azure_location",
              label: "Azure location",
              control: 'select',
              options: AZURE_LOCATIONS.map(l => ({ value: l, label: l })),
              default: "eastus",
              hint: "Region"
            },
            { id: "resource_group", label: "Resource group", control: 'text', default: "rg-secrets", hint: "Resource group" },
            { id: "vault_name", label: "Key Vault name", control: 'text', default: "app-kv", hint: "Vault name (globally unique DNS)" },
            { id: "secret_name", label: "Secret name", control: 'text', default: "db-password", hint: "Secret name" },
            { id: "secret_value", label: "Secret value", control: 'text', default: "ChangeMe!", hint: "Use a secure value / vault" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Key Vault & secret",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  azure_location: vals.azure_location,
                  resource_group: vals.resource_group,
                  vault_name: vals.vault_name,
                  secret_name: vals.secret_name,
                  secret_value: vals.secret_value
                },
                tasks: [
                  {
                    name: "Ensure resource group exists",
                    "azure.azcollection.azure_rm_resourcegroup": {
                      name: "{{ resource_group }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create Key Vault",
                    "azure.azcollection.azure_rm_keyvault": {
                      resource_group: "{{ resource_group }}",
                      name: "{{ vault_name }}",
                      location: "{{ azure_location }}"
                    }
                  },
                  {
                    name: "Create secret",
                    "azure.azcollection.azure_rm_keyvaultsecret": {
                      vault_uri: "https://{{ vault_name }}.vault.azure.net",
                      secret_name: "{{ secret_name }}",
                      secret_value: "{{ secret_value }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Security – Key Vault',
      ),
  },
];

export const AZURE_ANSIBLE: BlueprintGroup = {
  target: 'azure',
  label: 'Microsoft Azure',
  blueprints: BLUEPRINTS,
};

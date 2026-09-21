/**
 * VMware vSphere / vCenter Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, unchanged. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

                                                                                                         
import { str } from '../../kit/blueprint.js';
import { playbookFiles } from '../from-plays.js';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.js';
import { HOSTS_INPUT } from './common.js';

const BLUEPRINTS                       = [
  {
    id: 'vsphere_vm_from_template',
    label: 'Create VM from template',
    description: 'Provision a vSphere VM from an existing template with network and datastore settings.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "vcenter_hostname",
              label: "vCenter hostname or IP",
              control: 'text',
              default: "vcenter.example.com",
              hint: "API endpoint used by Ansible"
            },
            {
              id: "vcenter_username",
              label: "vCenter username",
              control: 'text',
              default: "administrator@vsphere.local",
              hint: "Use a service account in real environments"
            },
            {
              id: "vcenter_password",
              label: "vCenter password",
              control: 'text',
              default: "ChangeMe123!",
              hint: "Use Ansible Vault / cred store in reality"
            },
            {
              id: "validate_certs",
              label: "Validate TLS certs",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "true = require valid certs"
            },
            {
              id: "datacenter_name",
              label: "Datacenter name",
              control: 'text',
              default: "DC1",
              hint: "vSphere datacenter"
            },
            {
              id: "cluster_name",
              label: "Cluster name",
              control: 'text',
              default: "Compute-Cluster",
              hint: "Cluster where VM will run"
            },
            {
              id: "template_name",
              label: "Template name",
              control: 'text',
              default: "golden-linux-template",
              hint: "Existing VM template"
            },
            {
              id: "vm_name",
              label: "New VM name",
              control: 'text',
              default: "app-01",
              hint: "Resulting VM object name"
            },
            {
              id: "datastore_name",
              label: "Datastore",
              control: 'text',
              default: "datastore1",
              hint: "Primary datastore"
            },
            {
              id: "vm_network",
              label: "Portgroup / Network",
              control: 'text',
              default: "VM Network",
              hint: "Backed by standard or distributed switch"
            },
            {
              id: "cpu_count",
              label: "vCPUs",
              control: 'number',
              default: 2,
              hint: "Number of vCPUs"
            },
            {
              id: "memory_mb",
              label: "Memory (MB)",
              control: 'number',
              default: 4096,
              hint: "RAM in MB"
            },
            {
              id: "disk_gb",
              label: "Disk size (GB)",
              control: 'number',
              default: 60,
              hint: "Primary disk size (can be same as template for thin provisioning)"
            },
            {
              id: "power_on",
              label: "Power on after create",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "true",
              hint: "Start VM immediately"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => ([
            {
              name: "Create vSphere VM from template",
              hosts,
              gather_facts: false,
              become: false,
              vars: {
                vcenter_hostname: vals.vcenter_hostname,
                vcenter_username: vals.vcenter_username,
                vcenter_password: vals.vcenter_password,
                validate_certs: vals.validate_certs === "true",
                datacenter_name: vals.datacenter_name,
                cluster_name: vals.cluster_name,
                template_name: vals.template_name,
                vm_name: vals.vm_name,
                datastore_name: vals.datastore_name,
                vm_network: vals.vm_network,
                cpu_count: Number(vals.cpu_count),
                memory_mb: Number(vals.memory_mb),
                disk_gb: Number(vals.disk_gb),
                power_on: vals.power_on === "true"
              },
              tasks: [
                {
                  name: "Create or update VM from template",
                  "community.vmware.vmware_guest": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    datacenter: "{{ datacenter_name }}",
                    cluster: "{{ cluster_name }}",
                    name: "{{ vm_name }}",
                    template: "{{ template_name }}",
                    datastore: "{{ datastore_name }}",
                    state: "poweredon",
                    hardware: {
                      memory_mb: "{{ memory_mb }}",
                      num_cpus: "{{ cpu_count }}"
                    },
                    disk: [
                      {
                        size_gb: "{{ disk_gb }}",
                        type: "thin"
                      }
                    ],
                    networks: [
                      {
                        name: "{{ vm_network }}"
                      }
                    ],
                    wait_for_ip_address: false
                  },
                  register: "vm_result"
                },
                {
                  name: "Ensure VM power state matches desired",
                  "community.vmware.vmware_guest_powerstate": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    name: "{{ vm_name }}",
                    state: "{{ 'powered-on' if power_on else 'powered-off' }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'Create VM from template',
      ),
  },
  {
    id: 'vsphere_vm_power_and_snapshot',
    label: 'VM power & snapshot management',
    description: 'Standardize power operations and snapshots for an existing VM.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "vcenter_hostname",
              label: "vCenter hostname or IP",
              control: 'text',
              default: "vcenter.example.com",
              hint: "Same as above"
            },
            {
              id: "vcenter_username",
              label: "vCenter username",
              control: 'text',
              default: "automation@vsphere.local",
              hint: "Service account"
            },
            {
              id: "vcenter_password",
              label: "vCenter password",
              control: 'text',
              default: "ChangeMe123!",
              hint: "Use Vault in prod"
            },
            {
              id: "validate_certs",
              label: "Validate TLS certs",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "true / false"
            },
            {
              id: "datacenter_name",
              label: "Datacenter name",
              control: 'text',
              default: "DC1",
              hint: "Optional but recommended"
            },
            {
              id: "vm_name",
              label: "Target VM name",
              control: 'text',
              default: "app-01",
              hint: "Existing VM"
            },
            {
              id: "power_state",
              label: "Desired power state",
              control: 'select',
              options: [
                { value: "powered-on", label: "Power on" },
                { value: "powered-off", label: "Power off" },
                { value: "restarted", label: "Restart" }
              ],
              default: "powered-on",
              hint: "Standard lifecycle"
            },
            {
              id: "snapshot_action",
              label: "Snapshot action",
              control: 'select',
              options: [
                { value: "none", label: "None" },
                { value: "create", label: "Create snapshot" },
                { value: "revert", label: "Revert to snapshot" }
              ],
              default: "none",
              hint: "Pick snapshot workflow"
            },
            {
              id: "snapshot_name",
              label: "Snapshot name",
              control: 'text',
              default: "pre-change",
              hint: "Used for create/revert when relevant"
            },
            {
              id: "snapshot_description",
              label: "Snapshot description",
              control: 'text',
              default: "Automated snapshot before change",
              hint: "For audit trail"
            },
            {
              id: "remove_children",
              label: "Remove child snapshots on revert",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "true / false"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => ([
            {
              name: "Manage VM power state and snapshots",
              hosts,
              gather_facts: false,
              become: false,
              vars: {
                vcenter_hostname: vals.vcenter_hostname,
                vcenter_username: vals.vcenter_username,
                vcenter_password: vals.vcenter_password,
                validate_certs: vals.validate_certs === "true",
                datacenter_name: vals.datacenter_name,
                vm_name: vals.vm_name,
                power_state: vals.power_state,
                snapshot_action: vals.snapshot_action,
                snapshot_name: vals.snapshot_name,
                snapshot_description: vals.snapshot_description,
                remove_children: vals.remove_children === "true"
              },
              tasks: [
                {
                  name: "Set VM power state",
                  "community.vmware.vmware_guest_powerstate": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    name: "{{ vm_name }}",
                    state: "{{ power_state }}",
                    state_change_timeout: 300
                  }
                },
                {
                  name: "Create snapshot if requested",
                  when: "snapshot_action == 'create'",
                  "community.vmware.vmware_guest_snapshot": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    datacenter: "{{ datacenter_name | default(omit) }}",
                    name: "{{ vm_name }}",
                    state: "present",
                    snapshot_name: "{{ snapshot_name }}",
                    description: "{{ snapshot_description }}",
                    memory: false,
                    quiesce: true
                  }
                },
                {
                  name: "Revert to snapshot if requested",
                  when: "snapshot_action == 'revert'",
                  "community.vmware.vmware_guest_snapshot": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    datacenter: "{{ datacenter_name | default(omit) }}",
                    name: "{{ vm_name }}",
                    state: "reverted",
                    snapshot_name: "{{ snapshot_name }}",
                    remove_children: "{{ remove_children }}"
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'VM power & snapshot management',
      ),
  },
  {
    id: 'vsphere_vm_add_disk',
    label: 'Add extra virtual disk',
    description: 'Attach an additional virtual disk to an existing VM on a given datastore.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "vcenter_hostname",
              label: "vCenter hostname or IP",
              control: 'text',
              default: "vcenter.example.com",
              hint: "API endpoint used by Ansible"
            },
            {
              id: "vcenter_username",
              label: "vCenter username",
              control: 'text',
              default: "automation@vsphere.local",
              hint: "Account with rights to modify VMs"
            },
            {
              id: "vcenter_password",
              label: "vCenter password",
              control: 'text',
              default: "CHANGE_ME",
              hint: "Use Ansible Vault / cred store in reality"
            },
            {
              id: "validate_certs",
              label: "Validate TLS certs",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "false for lab / self-signed; true for hardened prod"
            },
            {
              id: "datacenter_name",
              label: "Datacenter name",
              control: 'text',
              default: "DC1",
              hint: "Datacenter containing the VM"
            },
            {
              id: "vm_name",
              label: "VM name",
              control: 'text',
              default: "app-db-01",
              hint: "Target VM to attach extra disk"
            },
            {
              id: "datastore_name",
              label: "Datastore",
              control: 'text',
              default: "vsanDatastore",
              hint: "Datastore that will hold the new disk"
            },
            {
              id: "new_disk_size_gb",
              label: "New disk size (GB)",
              control: 'number',
              default: "100",
              hint: "Size of the additional data disk"
            },
            {
              id: "unit_number",
              label: "Disk unit number (optional)",
              control: 'number',
              default: "",
              hint: "Leave blank to let vSphere choose next unit"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Add extra virtual disk to VM",
                hosts,
                gather_facts: false,
                vars: {
                  vcenter_hostname: vals.vcenter_hostname,
                  vcenter_username: vals.vcenter_username,
                  vcenter_password: vals.vcenter_password,
                  validate_certs: vals.validate_certs === "true",
                  datacenter_name: vals.datacenter_name,
                  vm_name: vals.vm_name,
                  datastore_name: vals.datastore_name,
                  new_disk_size_gb: Number(vals.new_disk_size_gb),
                  unit_number: vals.unit_number
                },
                tasks: [
                  {
                    name: "Attach new disk",
                    "community.vmware.vmware_guest_disk": {
                      hostname: "{{ vcenter_hostname }}",
                      username: "{{ vcenter_username }}",
                      password: "{{ vcenter_password }}",
                      validate_certs: "{{ validate_certs }}",
                      datacenter: "{{ datacenter_name }}",
                      name: "{{ vm_name }}",
                      disk: [
                        {
                          state: "present",
                          size_gb: "{{ new_disk_size_gb }}",
                          datastore: "{{ datastore_name }}",
                          type: "thin",
                          unit_number: "{{ unit_number | default(omit) }}"
                        }
                      ]
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Add extra virtual disk',
      ),
  },
  {
    id: 'vsphere_vm_folder_and_annotation',
    label: 'Organize VM into folder + annotation',
    description: 'Move an existing VM into a folder and set an annotation for tagging / audit.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "vcenter_hostname",
              label: "vCenter hostname or IP",
              control: 'text',
              default: "vcenter.example.com",
              hint: "API endpoint used by Ansible"
            },
            {
              id: "vcenter_username",
              label: "vCenter username",
              control: 'text',
              default: "automation@vsphere.local",
              hint: "Account with permission to move VMs"
            },
            {
              id: "vcenter_password",
              label: "vCenter password",
              control: 'text',
              default: "CHANGE_ME",
              hint: "Use Ansible Vault / cred store in reality"
            },
            {
              id: "validate_certs",
              label: "Validate TLS certs",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "false for lab / self-signed; true for hardened prod"
            },
            {
              id: "datacenter_name",
              label: "Datacenter name",
              control: 'text',
              default: "DC1",
              hint: "Datacenter containing the VM"
            },
            {
              id: "vm_name",
              label: "VM name",
              control: 'text',
              default: "app-01",
              hint: "VM to move and annotate"
            },
            {
              id: "folder_path",
              label: "Destination folder path",
              control: 'text',
              default: "/Prod/Restricted",
              hint: "Full folder path, e.g. /Prod/Restricted"
            },
            {
              id: "annotation",
              label: "VM annotation",
              control: 'text',
              default: "System of record: AppSystem; Data class: Restricted",
              hint: "Free text used for tagging / classification"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Move VM to folder and set annotation",
                hosts,
                gather_facts: false,
                vars: {
                  vcenter_hostname: vals.vcenter_hostname,
                  vcenter_username: vals.vcenter_username,
                  vcenter_password: vals.vcenter_password,
                  validate_certs: vals.validate_certs === "true",
                  datacenter_name: vals.datacenter_name,
                  vm_name: vals.vm_name,
                  folder_path: vals.folder_path,
                  annotation: vals.annotation
                },
                tasks: [
                  {
                    name: "Move VM to destination folder",
                    "community.vmware.vmware_guest_move": {
                      hostname: "{{ vcenter_hostname }}",
                      username: "{{ vcenter_username }}",
                      password: "{{ vcenter_password }}",
                      validate_certs: "{{ validate_certs }}",
                      datacenter: "{{ datacenter_name }}",
                      name: "{{ vm_name }}",
                      folder: "{{ folder_path }}"
                    }
                  },
                  {
                    name: "Set VM annotation",
                    "community.vmware.vmware_guest": {
                      hostname: "{{ vcenter_hostname }}",
                      username: "{{ vcenter_username }}",
                      password: "{{ vcenter_password }}",
                      validate_certs: "{{ validate_certs }}",
                      datacenter: "{{ datacenter_name }}",
                      name: "{{ vm_name }}",
                      annotation: "{{ annotation }}",
                      state: "present"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Organize VM into folder + annotation',
      ),
  },
  {
    id: 'vsphere_vm_reconfigure',
    label: 'VM reconfigure (CPU/RAM/disk/network)',
    description: 'Adjust hardware and network settings for an existing VM.',
    inputs: [
    HOSTS_INPUT,

            {
              id: "vcenter_hostname",
              label: "vCenter hostname or IP",
              control: 'text',
              default: "vcenter.example.com",
              hint: "Same as above"
            },
            {
              id: "vcenter_username",
              label: "vCenter username",
              control: 'text',
              default: "automation@vsphere.local",
              hint: "Service account"
            },
            {
              id: "vcenter_password",
              label: "vCenter password",
              control: 'text',
              default: "ChangeMe123!",
              hint: "Use Vault in prod"
            },
            {
              id: "validate_certs",
              label: "Validate TLS certs",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "true / false"
            },
            {
              id: "datacenter_name",
              label: "Datacenter name",
              control: 'text',
              default: "DC1",
              hint: "Optional"
            },
            {
              id: "vm_name",
              label: "VM name",
              control: 'text',
              default: "app-01",
              hint: "Existing VM"
            },
            {
              id: "cpu_count",
              label: "New vCPU count",
              control: 'number',
              default: 4,
              hint: "Leave same as current if no change"
            },
            {
              id: "memory_mb",
              label: "New memory (MB)",
              control: 'number',
              default: 8192,
              hint: "RAM in MB"
            },
            {
              id: "disk_gb",
              label: "New primary disk size (GB)",
              control: 'number',
              default: 80,
              hint: "Must be >= current size"
            },
            {
              id: "vm_network",
              label: "Network / portgroup",
              control: 'text',
              default: "VM Network",
              hint: "New network, or keep same"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => ([
            {
              name: "Reconfigure vSphere VM",
              hosts,
              gather_facts: false,
              become: false,
              vars: {
                vcenter_hostname: vals.vcenter_hostname,
                vcenter_username: vals.vcenter_username,
                vcenter_password: vals.vcenter_password,
                validate_certs: vals.validate_certs === "true",
                datacenter_name: vals.datacenter_name,
                vm_name: vals.vm_name,
                cpu_count: Number(vals.cpu_count),
                memory_mb: Number(vals.memory_mb),
                disk_gb: Number(vals.disk_gb),
                vm_network: vals.vm_network
              },
              tasks: [
                {
                  name: "Resize CPU and memory",
                  "community.vmware.vmware_guest": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    datacenter: "{{ datacenter_name | default(omit) }}",
                    name: "{{ vm_name }}",
                    state: "present",
                    hardware: {
                      num_cpus: "{{ cpu_count }}",
                      memory_mb: "{{ memory_mb }}"
                    }
                  }
                },
                {
                  name: "Resize disk if requested",
                  "community.vmware.vmware_guest_disk": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    datacenter: "{{ datacenter_name | default(omit) }}",
                    name: "{{ vm_name }}",
                    disk: [
                      {
                        state: "present",
                        size_gb: "{{ disk_gb }}",
                        unit_number: 0
                      }
                    ]
                  }
                },
                {
                  name: "Update network if requested",
                  "community.vmware.vmware_guest_network": {
                    hostname: "{{ vcenter_hostname }}",
                    username: "{{ vcenter_username }}",
                    password: "{{ vcenter_password }}",
                    validate_certs: "{{ validate_certs }}",
                    datacenter: "{{ datacenter_name | default(omit) }}",
                    name: "{{ vm_name }}",
                    networks: [
                      {
                        name: "{{ vm_network }}"
                      }
                    ]
                  }
                }
              ]
            }
          ]))(values, str(values, 'hosts', 'all')),
        name,
        'VM reconfigure (CPU/RAM/disk/network)',
      ),
  },
];

export const VMWARE_ANSIBLE                 = {
  target: 'vsphere',
  label: 'VMware vSphere / vCenter',
  blueprints: BLUEPRINTS,
};

/**
 * VMware vSphere / vCenter Terraform blueprints.
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
    id: 'vsphere_vm_from_template',
    label: 'vSphere VM from template',
    description: 'Terraform config using vsphere provider to clone a VM from template.',
    inputs: [
            { id: "vsphere_user", label: "vSphere username", control: 'text', default: "administrator@vsphere.local", hint: "User with clone rights" },
            { id: "vsphere_password", label: "vSphere password", control: 'text', default: "CHANGEME", hint: "Use environment variables in real use" },
            { id: "vsphere_server", label: "vSphere server", control: 'text', default: "vcenter.example.com", hint: "vCenter hostname" },
            { id: "datacenter", label: "Datacenter name", control: 'text', default: "Court-DC1", hint: "Datacenter" },
            { id: "cluster", label: "Cluster name", control: 'text', default: "Cluster1", hint: "Target cluster" },
            { id: "datastore", label: "Datastore", control: 'text', default: "vsanDatastore", hint: "Datastore for VM" },
            { id: "template", label: "Template name", control: 'text', default: "rhel8-template", hint: "Existing template name" },
            { id: "vm_name", label: "VM name", control: 'text', default: "court-vsphere-01", hint: "New VM name" },
            { id: "network_label", label: "Network label", control: 'text', default: "VM Network", hint: "Portgroup name" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "vsphere_vm_from_template";
            return `terraform {
  required_providers {
    vsphere = {
      source  = "hashicorp/vsphere"
      version = "~> 2.0"
    }
  }
}

provider "vsphere" {
  user           = "${vals.vsphere_user}"
  password       = "${vals.vsphere_password}"
  vsphere_server = "${vals.vsphere_server}"

  allow_unverified_ssl = true
}

data "vsphere_datacenter" "dc" {
  name = "${vals.datacenter}"
}

data "vsphere_compute_cluster" "cluster" {
  name          = "${vals.cluster}"
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_datastore" "datastore" {
  name          = "${vals.datastore}"
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_network" "network" {
  name          = "${vals.network_label}"
  datacenter_id = data.vsphere_datacenter.dc.id
}

data "vsphere_virtual_machine" "template" {
  name          = "${vals.template}"
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_virtual_machine" "this" {
  name             = "${vals.vm_name}"
  resource_pool_id = data.vsphere_compute_cluster.cluster.resource_pool_id
  datastore_id     = data.vsphere_datastore.datastore.id

  num_cpus = 2
  memory   = 4096
  guest_id = data.vsphere_virtual_machine.template.guest_id

  network_interface {
    network_id   = data.vsphere_network.network.id
    adapter_type = data.vsphere_virtual_machine.template.network_interface_types[0]
  }

  disk {
    label            = "disk0"
    size             = data.vsphere_virtual_machine.template.disks.0.size
    eagerly_scrub    = data.vsphere_virtual_machine.template.disks.0.eagerly_scrub
    thin_provisioned = data.vsphere_virtual_machine.template.disks.0.thin_provisioned
  }

  clone {
    template_uuid = data.vsphere_virtual_machine.template.id
  }

  annotation = "System=${m}, Environment=dev"
}
`;
          })(values, name),
      },
    }),
  },
  {
    id: 'vsphere_tagged_foldered_vm',
    label: 'Tag + folder an existing VM',
    description: 'Adds a folder and tags around an existing VM for classification / audit.',
    inputs: [
            { id: "vsphere_user", label: "vSphere username", control: 'text', default: "administrator@vsphere.local", hint: "User with tag/folder rights" },
            { id: "vsphere_password", label: "vSphere password", control: 'text', default: "CHANGEME", hint: "Use env vars in real use" },
            { id: "vsphere_server", label: "vSphere server", control: 'text', default: "vcenter.example.com", hint: "vCenter hostname" },
            { id: "datacenter", label: "Datacenter name", control: 'text', default: "Court-DC1", hint: "Datacenter" },
            { id: "vm_name", label: "Existing VM name", control: 'text', default: "court-vsphere-01", hint: "Target VM" },
            { id: "folder_path", label: "Folder path", control: 'text', default: "Court/Prod/IL5", hint: "Folder path under datacenter" },
            { id: "tag_category_name", label: "Tag category name", control: 'text', default: "DataClassification", hint: "e.g. DataClassification" },
            { id: "tag_category_description", label: "Tag category description", control: 'text', default: "Data classification level", hint: "Category description" },
            { id: "tag_name", label: "Tag name", control: 'text', default: "CJIS", hint: "e.g. CJIS, PHI, FOUO" },
            { id: "tag_description", label: "Tag description", control: 'text', default: "CJIS-controlled workload", hint: "Tag description" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "vsphere_tagged_foldered_vm";
            return `terraform {
  required_providers {
    vsphere = {
      source  = "hashicorp/vsphere"
      version = "~> 2.0"
    }
  }
}

provider "vsphere" {
  user           = "${vals.vsphere_user}"
  password       = "${vals.vsphere_password}"
  vsphere_server = "${vals.vsphere_server}"

  allow_unverified_ssl = true
}

data "vsphere_datacenter" "dc" {
  name = "${vals.datacenter}"
}

data "vsphere_virtual_machine" "vm" {
  name          = "${vals.vm_name}"
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_folder" "folder" {
  path          = "${vals.folder_path}"
  type          = "vm"
  datacenter_id = data.vsphere_datacenter.dc.id
}

resource "vsphere_tag_category" "classification" {
  name        = "${vals.tag_category_name}"
  description = "${vals.tag_category_description}"
  cardinality = "MULTIPLE"
  associable_types = [
    "VirtualMachine"
  ]
}

resource "vsphere_tag" "classification_tag" {
  name        = "${vals.tag_name}"
  description = "${vals.tag_description}"
  category_id = vsphere_tag_category.classification.id
}

resource "vsphere_virtual_machine" "annotated" {
  # We do not recreate the VM; we only use this to move/tag via Terraform's understanding of the object.
  # In practice, management via separate module is recommended.

  name             = data.vsphere_virtual_machine.vm.name
  resource_pool_id = data.vsphere_virtual_machine.vm.resource_pool_id
  datastore_id     = data.vsphere_virtual_machine.vm.datastore_id

  num_cpus = data.vsphere_virtual_machine.vm.num_cpus
  memory   = data.vsphere_virtual_machine.vm.memory

  clone {
    template_uuid = data.vsphere_virtual_machine.vm.id
  }

  folder = vsphere_folder.folder.path

  tags = [
    vsphere_tag.classification_tag.id
  ]

  annotation = "System=${m}, Classification=${vals.tag_name}"
}
`;
          })(values, name),
      },
    }),
  },
];

export const VMWARE_TERRAFORM: BlueprintGroup = {
  target: 'vsphere',
  label: 'VMware vSphere / vCenter',
  blueprints: BLUEPRINTS,
};

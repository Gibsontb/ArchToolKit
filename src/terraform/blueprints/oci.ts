/**
 * Oracle Cloud Infrastructure (OCI) Terraform blueprints.
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
    id: 'oci_core_vcn_baseline',
    label: 'VCN baseline (public + private subnets)',
    description: 'Creates an OCI VCN with one public and one private subnet, Internet Gateway and route table.',
    inputs: [
            {
              id: "oci_region",
              label: "OCI region",
              control: 'select',
              options: OCI_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-ashburn-1",
              hint: "Commercial + US Gov regions"
            },
            {
              id: "tenancy_ocid",
              label: "Tenancy OCID",
              control: 'text',
              default: "ocid1.tenancy.oc1..example",
              hint: "Use TF vars or env in real use"
            },
            {
              id: "user_ocid",
              label: "User OCID",
              control: 'text',
              default: "ocid1.user.oc1..example",
              hint: "User allowed to manage network"
            },
            {
              id: "fingerprint",
              label: "API key fingerprint",
              control: 'text',
              default: "aa:bb:cc:dd:ee:ff",
              hint: "From OCI console"
            },
            {
              id: "private_key_path",
              label: "Private key path",
              control: 'text',
              default: "~/.oci/oci_api_key.pem",
              hint: "On Terraform runner"
            },
            {
              id: "compartment_ocid",
              label: "Compartment OCID",
              control: 'text',
              default: "ocid1.compartment.oc1..example",
              hint: "Target compartment for VCN"
            },
            {
              id: "vcn_display_name",
              label: "VCN display name",
              control: 'text',
              default: "court-vcn",
              hint: "Friendly VCN name"
            },
            {
              id: "vcn_cidr",
              label: "VCN CIDR",
              control: 'text',
              default: "10.40.0.0/16",
              hint: "Top-level CIDR (non-overlapping)"
            },
            {
              id: "pub_subnet_cidr",
              label: "Public subnet CIDR",
              control: 'text',
              default: "10.40.1.0/24",
              hint: "For internet-facing workloads / bastion"
            },
            {
              id: "priv_subnet_cidr",
              label: "Private subnet CIDR",
              control: 'text',
              default: "10.40.2.0/24",
              hint: "For app / DB tiers"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "oci_core_vcn_baseline";
            return `terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  region           = "${vals.oci_region}"
  tenancy_ocid     = "${vals.tenancy_ocid}"
  user_ocid        = "${vals.user_ocid}"
  fingerprint      = "${vals.fingerprint}"
  private_key_path = "${vals.private_key_path}"
}

resource "oci_core_vcn" "this" {
  cidr_block     = "${vals.vcn_cidr}"
  compartment_id = "${vals.compartment_ocid}"
  display_name   = "${vals.vcn_display_name}"
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = "${vals.compartment_ocid}"
  display_name   = "${vals.vcn_display_name}-igw"
  vcn_id         = oci_core_vcn.this.id
  is_enabled     = true
}

resource "oci_core_route_table" "public_rt" {
  compartment_id = "${vals.compartment_ocid}"
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${vals.vcn_display_name}-public-rt"

  route_rules {
    network_entity_id = oci_core_internet_gateway.igw.id
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
  }
}

resource "oci_core_subnet" "public" {
  compartment_id      = "${vals.compartment_ocid}"
  vcn_id              = oci_core_vcn.this.id
  display_name        = "${vals.vcn_display_name}-public"
  cidr_block          = "${vals.pub_subnet_cidr}"
  route_table_id      = oci_core_route_table.public_rt.id
  prohibit_public_ip_on_vnic = false
}

resource "oci_core_subnet" "private" {
  compartment_id      = "${vals.compartment_ocid}"
  vcn_id              = oci_core_vcn.this.id
  display_name        = "${vals.vcn_display_name}-private"
  cidr_block          = "${vals.priv_subnet_cidr}"
  prohibit_public_ip_on_vnic = true
}
`;
          })(values, name),
      },
    }),
  },
  {
    id: 'oci_core_instance_linux',
    label: 'Linux compute instance',
    description: 'Creates a Linux compute instance in an existing subnet + compartment.',
    inputs: [
            {
              id: "oci_region",
              label: "OCI region",
              control: 'select',
              options: OCI_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-ashburn-1",
              hint: "Region for compute"
            },
            {
              id: "tenancy_ocid",
              label: "Tenancy OCID",
              control: 'text',
              default: "ocid1.tenancy.oc1..example",
              hint: "Use TF vars or env in real use"
            },
            {
              id: "user_ocid",
              label: "User OCID",
              control: 'text',
              default: "ocid1.user.oc1..example",
              hint: "User allowed to manage compute"
            },
            {
              id: "fingerprint",
              label: "API key fingerprint",
              control: 'text',
              default: "aa:bb:cc:dd:ee:ff",
              hint: "From OCI console"
            },
            {
              id: "private_key_path",
              label: "Private key path",
              control: 'text',
              default: "~/.oci/oci_api_key.pem",
              hint: "On Terraform runner"
            },
            {
              id: "compartment_ocid",
              label: "Compartment OCID",
              control: 'text',
              default: "ocid1.compartment.oc1..example",
              hint: "Target compartment for instance"
            },
            {
              id: "availability_domain",
              label: "Availability domain name",
              control: 'text',
              default: "Uocm:PHX-AD-1",
              hint: "From OCI console (AD1/AD2/AD3)"
            },
            {
              id: "subnet_ocid",
              label: "Subnet OCID",
              control: 'text',
              default: "ocid1.subnet.oc1..example",
              hint: "Existing subnet within VCN"
            },
            {
              id: "shape",
              label: "Shape",
              control: 'text',
              default: "VM.Standard3.Flex",
              hint: "e.g. VM.Standard3.Flex"
            },
            {
              id: "ocpus",
              label: "OCPUs",
              control: 'number',
              default: "2",
              hint: "CPU count"
            },
            {
              id: "memory_in_gbs",
              label: "Memory (GB)",
              control: 'number',
              default: "16",
              hint: "RAM in GB"
            },
            {
              id: "image_ocid",
              label: "Image OCID",
              control: 'text',
              default: "ocid1.image.oc1..example",
              hint: "Linux image OCID"
            },
            {
              id: "instance_display_name",
              label: "Instance display name",
              control: 'text',
              default: "court-oci-linux-01",
              hint: "Friendly name"
            },
            {
              id: "ssh_authorized_keys",
              label: "SSH authorized key (single line)",
              control: 'text',
              default: "ssh-rsa AAAA... user@example",
              hint: "Admin SSH key"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "oci_core_instance_linux";
            const ocpus = Number(vals.ocpus) || 2;
            const mem   = Number(vals.memory_in_gbs) || 16;
            return `terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  region           = "${vals.oci_region}"
  tenancy_ocid     = "${vals.tenancy_ocid}"
  user_ocid        = "${vals.user_ocid}"
  fingerprint      = "${vals.fingerprint}"
  private_key_path = "${vals.private_key_path}"
}

resource "oci_core_instance" "this" {
  availability_domain = "${vals.availability_domain}"
  compartment_id      = "${vals.compartment_ocid}"
  display_name        = "${vals.instance_display_name}"
  shape               = "${vals.shape}"

  shape_config {
    ocpus         = ${ocpus}
    memory_in_gbs = ${mem}
  }

  create_vnic_details {
    subnet_id              = "${vals.subnet_ocid}"
    assign_public_ip       = true
    display_name           = "${vals.instance_display_name}-vnic"
    hostname_label         = "courtlinux01"
    skip_source_dest_check = false
  }

  source_details {
    source_type = "image"
    source_id   = "${vals.image_ocid}"
  }

  metadata = {
    ssh_authorized_keys = "${vals.ssh_authorized_keys}"
  }
}
`;
          })(values, name),
      },
    }),
  },
  {
    id: 'oci_objectstorage_bucket_secure',
    label: 'Object Storage bucket (secure)',
    description: 'Creates a private, encrypted OCI Object Storage bucket with versioning enabled.',
    inputs: [
            {
              id: "oci_region",
              label: "OCI region",
              control: 'select',
              options: OCI_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-ashburn-1",
              hint: "Region for bucket"
            },
            {
              id: "tenancy_ocid",
              label: "Tenancy OCID",
              control: 'text',
              default: "ocid1.tenancy.oc1..example",
              hint: "Use TF vars or env in real use"
            },
            {
              id: "user_ocid",
              label: "User OCID",
              control: 'text',
              default: "ocid1.user.oc1..example",
              hint: "User allowed to manage Object Storage"
            },
            {
              id: "fingerprint",
              label: "API key fingerprint",
              control: 'text',
              default: "aa:bb:cc:dd:ee:ff",
              hint: "From OCI console"
            },
            {
              id: "private_key_path",
              label: "Private key path",
              control: 'text',
              default: "~/.oci/oci_api_key.pem",
              hint: "On Terraform runner"
            },
            {
              id: "compartment_ocid",
              label: "Compartment OCID",
              control: 'text',
              default: "ocid1.compartment.oc1..example",
              hint: "Compartment for bucket"
            },
            {
              id: "bucket_name",
              label: "Bucket name",
              control: 'text',
              default: "court-oci-archive",
              hint: "Unique within namespace"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "oci_objectstorage_bucket_secure";
            return `terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  region           = "${vals.oci_region}"
  tenancy_ocid     = "${vals.tenancy_ocid}"
  user_ocid        = "${vals.user_ocid}"
  fingerprint      = "${vals.fingerprint}"
  private_key_path = "${vals.private_key_path}"
}

data "oci_objectstorage_namespace" "ns" {
  compartment_id = "${vals.compartment_ocid}"
}

resource "oci_objectstorage_bucket" "this" {
  compartment_id = "${vals.compartment_ocid}"
  name           = "${vals.bucket_name}"
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  access_type    = "NoPublicAccess"

  versioning = "Enabled"

  kms_key_id = null

  metadata = {
    system      = "${m}"
    environment = "dev"
  }
}
`;
          })(values, name),
      },
    }),
  },
];

export const OCI_TERRAFORM: BlueprintGroup = {
  target: 'oci',
  label: 'Oracle Cloud Infrastructure (OCI)',
  blueprints: BLUEPRINTS,
};

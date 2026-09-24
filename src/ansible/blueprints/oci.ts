/**
 * Oracle Cloud Infrastructure (OCI) Ansible blueprints.
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
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { familyOf, isIp } from '../../core/ip.ts';
import { dualStackInput, ipv4Range, isOn, listOf, slash64, withAnsibleUtils } from './ipv6.ts';

const BLUEPRINTS: readonly Blueprint[] = [
  {
    id: 'compute_instance',
    label: 'Compute – VM instance',
    description: 'Create an OCI compute instance in a given compartment and subnet.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Target compartment" },
            { id: "availability_domain", label: "Availability Domain", control: 'text', default: "Uocm:US-ASHBURN-AD-1", hint: "Full AD name" },
            { id: "subnet_ocid", label: "Subnet OCID", control: 'text', default: "ocid1.subnet.oc1..xxxxx", hint: "Target subnet" },
            { id: "display_name", label: "Instance display name", control: 'text', default: "oci-ansible-01", hint: "Human-friendly name" },
            { id: "shape", label: "Shape", control: 'text', default: "VM.Standard.E4.Flex", hint: "e.g. VM.Standard.E4.Flex" },
            { id: "ocpus", label: "OCPUs", control: 'number', default: 1, hint: "vCPU count" },
            { id: "memory_in_gbs", label: "Memory (GB)", control: 'number', default: 16, hint: "RAM in GB" },
            { id: "image_ocid", label: "Image OCID", control: 'text', default: "ocid1.image.oc1..xxxxx", hint: "OS image" },
            {
              id: "assign_public_ip",
              label: "Assign public IP",
              control: 'select',
              options: [
                { value: "true", label: "true" },
                { value: "false", label: "false" }
              ],
              default: "true",
              hint: "true / false"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Provision OCI compute instance",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  availability_domain: vals.availability_domain,
                  subnet_ocid: vals.subnet_ocid,
                  display_name: vals.display_name,
                  shape: vals.shape,
                  ocpus: Number(vals.ocpus),
                  memory_in_gbs: Number(vals.memory_in_gbs),
                  image_ocid: vals.image_ocid,
                  assign_public_ip: vals.assign_public_ip === "true"
                },
                tasks: [
                  {
                    name: "Create compute instance",
                    "oracle.oci.oci_compute_instance": {
                      availability_domain: "{{ availability_domain }}",
                      compartment_id: "{{ compartment_ocid }}",
                      display_name: "{{ display_name }}",
                      shape: "{{ shape }}",
                      shape_config: {
                        ocpus: "{{ ocpus }}",
                        memory_in_gbs: "{{ memory_in_gbs }}"
                      },
                      create_vnic_details: {
                        subnet_id: "{{ subnet_ocid }}",
                        assign_public_ip: "{{ assign_public_ip }}"
                      },
                      source_details: {
                        source_type: "image",
                        image_id: "{{ image_ocid }}"
                      }
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Compute – VM instance',
      ),
  },
  {
    id: 'object_bucket',
    label: 'Object Storage – Bucket',
    description: 'Create an OCI Object Storage bucket.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Target compartment" },
            { id: "namespace", label: "Object storage namespace", control: 'text', default: "mytenancy", hint: "From OCI console" },
            { id: "bucket_name", label: "Bucket name", control: 'text', default: "app-archive-oci", hint: "Bucket name" },
            {
              id: "storage_tier",
              label: "Storage tier",
              control: 'select',
              options: [
                { value: "Standard", label: "Standard" },
                { value: "Archive", label: "Archive" }
              ],
              default: "Standard",
              hint: "Tier"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create OCI object storage bucket",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  namespace: vals.namespace,
                  bucket_name: vals.bucket_name,
                  storage_tier: vals.storage_tier
                },
                tasks: [
                  {
                    name: "Ensure bucket exists",
                    "oracle.oci.oci_object_storage_bucket": {
                      compartment_id: "{{ compartment_ocid }}",
                      namespace_name: "{{ namespace }}",
                      name: "{{ bucket_name }}",
                      storage_tier: "{{ storage_tier }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Object Storage – Bucket',
      ),
  },
  {
    id: 'vcn_baseline',
    label: 'Network – VCN + subnets + IGW',
    description: 'Create a VCN, public/private subnets, Internet Gateway and route table.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Target compartment" },
            { id: "vcn_cidr", label: "VCN CIDR", control: 'text', default: "10.50.0.0/16", hint: "VCN CIDR block" },
            { id: "vcn_display_name", label: "VCN display name", control: 'text', default: "app-vcn", hint: "VCN name" },
            { id: "public_subnet_cidr", label: "Public subnet CIDR", control: 'text', default: "10.50.1.0/24", hint: "Public subnet" },
            { id: "private_subnet_cidr", label: "Private subnet CIDR", control: 'text', default: "10.50.2.0/24", hint: "Private subnet" },
            dualStackInput("Oracle allocates a /56 to the VCN; each subnet takes a /64, and ::/0 routes to the gateway")
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      const code = 'ansible.oci.vcn_baseline';
      const v6 = isOn(values.enable_ipv6);
      const findings: Finding[] = [
        ...ipv4Range(values.vcn_cidr, 'vcn_cidr', 'The VCN CIDR', code),
        ...ipv4Range(values.public_subnet_cidr, 'public_subnet_cidr', 'The public subnet CIDR', code),
        ...ipv4Range(values.private_subnet_cidr, 'private_subnet_cidr', 'The private subnet CIDR', code),
      ];
      if (v6) {
        findings.push(info(`${code}.private-ipv6-no-egress`, 'The private subnet gets IPv6 addresses but no route out; OCI\'s NAT gateway translates IPv4 only.', { path: 'enable_ipv6' }));
      }
      // The n-th /64 of the VCN's Oracle-allocated /56, as oci_network_vcn registers it.
      const subnetV6 = (n: number) => (v6 ? { ipv6_cidr_blocks: [slash64('vcn.data.ipv6_cidr_blocks[0]', n)] } : {});
      const out = playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create OCI VCN baseline",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  vcn_cidr: vals.vcn_cidr,
                  vcn_display_name: vals.vcn_display_name,
                  public_subnet_cidr: vals.public_subnet_cidr,
                  private_subnet_cidr: vals.private_subnet_cidr
                },
                tasks: [
                  {
                    name: "Create VCN",
                    "oracle.oci.oci_network_vcn": {
                      compartment_id: "{{ compartment_ocid }}",
                      cidr_block: "{{ vcn_cidr }}",
                      display_name: "{{ vcn_display_name }}",
                      // Oracle allocates a global /56; subnets take /64s of it.
                      ...(v6 ? { is_ipv6_enabled: true } : {})
                    },
                    register: "vcn"
                  },
                  {
                    name: "Create Internet Gateway",
                    "oracle.oci.oci_network_internet_gateway": {
                      compartment_id: "{{ compartment_ocid }}",
                      vcn_id: "{{ vcn.data.id }}",
                      display_name: "{{ vcn_display_name }}-igw",
                      is_enabled: true
                    },
                    register: "igw"
                  },
                  {
                    name: "Create public subnet",
                    "oracle.oci.oci_network_subnet": {
                      compartment_id: "{{ compartment_ocid }}",
                      vcn_id: "{{ vcn.data.id }}",
                      cidr_block: "{{ public_subnet_cidr }}",
                      ...subnetV6(0),
                      display_name: "{{ vcn_display_name }}-public",
                      prohibit_public_ip_on_vnic: false
                    },
                    register: "public_subnet"
                  },
                  {
                    name: "Create private subnet",
                    "oracle.oci.oci_network_subnet": {
                      compartment_id: "{{ compartment_ocid }}",
                      vcn_id: "{{ vcn.data.id }}",
                      cidr_block: "{{ private_subnet_cidr }}",
                      ...subnetV6(1),
                      display_name: "{{ vcn_display_name }}-private",
                      prohibit_public_ip_on_vnic: true
                    },
                    register: "private_subnet"
                  },
                  {
                    name: "Create route table for public subnet",
                    "oracle.oci.oci_network_route_table": {
                      compartment_id: "{{ compartment_ocid }}",
                      vcn_id: "{{ vcn.data.id }}",
                      display_name: "{{ vcn_display_name }}-public-rt",
                      route_rules: [
                        {
                          cidr_block: "0.0.0.0/0",
                          network_entity_id: "{{ igw.data.id }}"
                        },
                        ...(v6
                          ? [{ destination: "::/0", destination_type: "CIDR_BLOCK", network_entity_id: "{{ igw.data.id }}" }]
                          : [])
                      ]
                    },
                    register: "public_rt"
                  },
                  {
                    name: "Associate route table with public subnet",
                    "oracle.oci.oci_network_subnet": {
                      subnet_id: "{{ public_subnet.data.id }}",
                      route_table_id: "{{ public_rt.data.id }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Network – VCN + subnets + IGW',
      );
      const built = { ...out, findings: [...findings, ...out.findings] };
      return v6 ? withAnsibleUtils(built) : built;
    },
  },
  {
    id: 'load_balancer',
    label: 'Load Balancer – Public HTTP',
    description: 'Create a public load balancer with a simple HTTP listener and backend set.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Target compartment" },
            { id: "subnet1_ocid", label: "Subnet 1 OCID", control: 'text', default: "ocid1.subnet.oc1..subnet1", hint: "Subnet for LB" },
            { id: "subnet2_ocid", label: "Subnet 2 OCID", control: 'text', default: "ocid1.subnet.oc1..subnet2", hint: "Second subnet (HA)" },
            { id: "lb_display_name", label: "LB display name", control: 'text', default: "app-lb", hint: "Load balancer name" },
            { id: "backend_ip", label: "Backend IP (comma-separated)", control: 'text', default: "10.50.1.10,10.50.1.11", hint: "Backend server IPs" },
            {
              id: "port",
              label: "Listener port",
              control: 'number',
              default: 80,
              hint: "HTTP port"
            }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => {
      const code = 'ansible.oci.load_balancer';
      const findings: Finding[] = [];
      const v4: string[] = [];
      const v6: string[] = [];
      for (const ip of listOf(values.backend_ip)) {
        if (!isIp(ip)) findings.push(error(`${code}.invalid-backend`, `"${ip}" is not an IPv4 or IPv6 address.`, { path: 'backend_ip' }));
        else (familyOf(ip) === 6 ? v6 : v4).push(ip);
      }
      if (v6.length > 0) {
        // Uncertain support is not emitted: an IPv6 backend needs an IPv6-mode load balancer.
        findings.push(
          warning(`${code}.ipv6-backends-not-generated`, `VERIFY: IPv6 backends (${v6.join(', ')}) were not generated. They need the load balancer created with ip_mode IPV6 on dual-stack subnets; confirm oracle.oci.oci_loadbalancer_load_balancer and your region support it, then add them.`, {
            path: 'backend_ip',
          }),
        );
      }
      const out = playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create OCI Load Balancer",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  subnet1_ocid: vals.subnet1_ocid,
                  subnet2_ocid: vals.subnet2_ocid,
                  lb_display_name: vals.lb_display_name,
                  backend_ip_list: v4,
                  port: Number(vals.port)
                },
                tasks: [
                  {
                    name: "Create public load balancer",
                    "oracle.oci.oci_loadbalancer_load_balancer": {
                      compartment_id: "{{ compartment_ocid }}",
                      display_name: "{{ lb_display_name }}",
                      shape_name: "flexible",
                      subnet_ids: [
                        "{{ subnet1_ocid }}",
                        "{{ subnet2_ocid }}"
                      ],
                      is_private: false
                    },
                    register: "lb"
                  },
                  {
                    name: "Create backend set",
                    "oracle.oci.oci_loadbalancer_backend_set": {
                      load_balancer_id: "{{ lb.data.id }}",
                      name: "backendset1",
                      policy: "ROUND_ROBIN",
                      health_checker: {
                        protocol: "HTTP",
                        url_path: "/",
                        port: "{{ port }}"
                      }
                    }
                  },
                  {
                    name: "Register backends",
                    "oracle.oci.oci_loadbalancer_backend": {
                      load_balancer_id: "{{ lb.data.id }}",
                      backendset_name: "backendset1",
                      ip_address: "{{ item }}",
                      port: "{{ port }}"
                    },
                    loop: "{{ backend_ip_list }}"
                  },
                  {
                    name: "Create HTTP listener",
                    "oracle.oci.oci_loadbalancer_listener": {
                      load_balancer_id: "{{ lb.data.id }}",
                      name: "http-listener",
                      protocol: "HTTP",
                      port: "{{ port }}",
                      default_backendset_name: "backendset1"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Load Balancer – Public HTTP',
      );
      return { ...out, findings: [...findings, ...out.findings] };
    },
  },
  {
    id: 'autonomous_database',
    label: 'Database – Autonomous DB',
    description: 'Create an Autonomous Transaction Processing database.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Target compartment" },
            { id: "db_name", label: "Database name", control: 'text', default: "APPATP", hint: "DB name" },
            { id: "display_name", label: "Display name", control: 'text', default: "app-atp-db", hint: "Friendly name" },
            {
              id: "db_workload",
              label: "Workload type",
              control: 'select',
              options: [
                { value: "OLTP", label: "Autonomous Transaction Processing (OLTP)" },
                { value: "DW", label: "Autonomous Data Warehouse (DW)" }
              ],
              default: "OLTP",
              hint: "Type"
            },
            { id: "cpu_core_count", label: "CPU cores", control: 'number', default: 2, hint: "Number of OCPUs" },
            { id: "data_storage_size_in_tbs", label: "Storage (TB)", control: 'number', default: 1, hint: "Data storage in TB" },
            { id: "admin_password", label: "ADMIN password", control: 'text', default: "ChangeMe123!", hint: "Use a secret in real life" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Autonomous Database",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  db_name: vals.db_name,
                  display_name: vals.display_name,
                  db_workload: vals.db_workload,
                  cpu_core_count: Number(vals.cpu_core_count),
                  data_storage_size_in_tbs: Number(vals.data_storage_size_in_tbs),
                  admin_password: vals.admin_password
                },
                tasks: [
                  {
                    name: "Create ATP/ADW database",
                    "oracle.oci.oci_database_autonomous_database": {
                      compartment_id: "{{ compartment_ocid }}",
                      db_name: "{{ db_name }}",
                      display_name: "{{ display_name }}",
                      db_workload: "{{ db_workload }}",
                      cpu_core_count: "{{ cpu_core_count }}",
                      data_storage_size_in_tbs: "{{ data_storage_size_in_tbs }}",
                      admin_password: "{{ admin_password }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Database – Autonomous DB',
      ),
  },
  {
    id: 'oke_cluster',
    label: 'OKE – Kubernetes cluster',
    description: 'Create an Oracle Kubernetes Engine (OKE) cluster.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Cluster compartment" },
            { id: "vcn_ocid", label: "VCN OCID", control: 'text', default: "ocid1.vcn.oc1..xxxxx", hint: "VCN for the cluster" },
            { id: "cluster_name", label: "Cluster name", control: 'text', default: "app-oke", hint: "OKE cluster name" },
            { id: "k8s_version", label: "Kubernetes version", control: 'text', default: "v1.29.1", hint: "K8s version string" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create OKE cluster",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  vcn_ocid: vals.vcn_ocid,
                  cluster_name: vals.cluster_name,
                  k8s_version: vals.k8s_version
                },
                tasks: [
                  {
                    name: "Create OKE control plane",
                    "oracle.oci.oci_container_engine_cluster": {
                      compartment_id: "{{ compartment_ocid }}",
                      name: "{{ cluster_name }}",
                      kubernetes_version: "{{ k8s_version }}",
                      vcn_id: "{{ vcn_ocid }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'OKE – Kubernetes cluster',
      ),
  },
  {
    id: 'kms_key',
    label: 'Security – KMS vault key',
    description: 'Create a Vault master encryption key in OCI KMS.',
    inputs: [
    HOSTS_INPUT,

            { id: "compartment_ocid", label: "Compartment OCID", control: 'text', default: "ocid1.compartment.oc1..xxxxx", hint: "Key compartment" },
            { id: "vault_ocid", label: "Vault OCID", control: 'text', default: "ocid1.vault.oc1..xxxxx", hint: "Existing Vault OCID" },
            { id: "key_display_name", label: "Key display name", control: 'text', default: "app-data-key", hint: "Friendly key name" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) =>
      playbookFiles(
        ((vals: TemplateValues, hosts: string) => {
            return [
              {
                name: "Create Vault master key",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  compartment_ocid: vals.compartment_ocid,
                  vault_ocid: vals.vault_ocid,
                  key_display_name: vals.key_display_name
                },
                tasks: [
                  {
                    name: "Create KMS key",
                    "oracle.oci.oci_key_management_key": {
                      compartment_id: "{{ compartment_ocid }}",
                      vault_id: "{{ vault_ocid }}",
                      display_name: "{{ key_display_name }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Security – KMS vault key',
      ),
  },
];

export const OCI_ANSIBLE: BlueprintGroup = {
  target: 'oci',
  label: 'Oracle Cloud Infrastructure (OCI)',
  blueprints: BLUEPRINTS,
};

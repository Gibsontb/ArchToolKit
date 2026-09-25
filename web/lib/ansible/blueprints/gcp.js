/**
 * Google Cloud Platform Ansible blueprints.
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
import { info,              } from '../../core/findings.js';
import { ipv4Range, sources } from './ipv6.js';

const BLUEPRINTS                       = [
  {
    id: 'gce_instance',
    label: 'Compute – VM instance',
    description: 'Create a GCE instance in a given project and zone.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            {
              id: "zone",
              label: "Zone",
              control: 'select',
              options: GCP_ZONES.map(z => ({ value: z, label: z })),
              default: "us-central1-a",
              hint: "Compute zone"
            },
            { id: "instance_name", label: "Instance name", control: 'text', default: "gce-ansible-01", hint: "VM name" },
            { id: "machine_type", label: "Machine type", control: 'text', default: "e2-medium", hint: "e2-medium, n2-standard-2, etc." },
            { id: "image_family", label: "Image family", control: 'text', default: "debian-11", hint: "debian-11, ubuntu-2004-lts, etc." },
            { id: "image_project", label: "Image project", control: 'text', default: "debian-cloud", hint: "debian-cloud, ubuntu-os-cloud, etc." }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Provision GCE instance",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  gcp_zone: vals.zone,
                  instance_name: vals.instance_name,
                  machine_type: vals.machine_type,
                  image_family: vals.image_family,
                  image_project: vals.image_project
                },
                tasks: [
                  {
                    name: "Create GCE instance",
                    "google.cloud.gcp_compute_instance": {
                      name: "{{ instance_name }}",
                      project: "{{ gcp_project }}",
                      zone: "{{ gcp_zone }}",
                      machine_type: "{{ machine_type }}",
                      disks: [
                        {
                          auto_delete: true,
                          boot: true,
                          initialize_params: {
                            source_image: "projects/{{ image_project }}/global/images/family/{{ image_family }}"
                          }
                        }
                      ],
                      network_interfaces: [
                        {
                          network: "default",
                          access_configs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }]
                        }
                      ]
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
    id: 'vpc_network',
    label: 'Network – VPC + subnet + firewall',
    description: 'Create a custom VPC network, subnet, and basic firewall rules.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "network_name", label: "VPC network name", control: 'text', default: "app-vpc", hint: "Custom VPC" },
            { id: "subnet_name", label: "Subnet name", control: 'text', default: "app-subnet", hint: "Subnet" },
            { id: "subnet_cidr", label: "Subnet CIDR", control: 'text', default: "10.40.0.0/24", hint: "CIDR block" },
            { id: "region", label: "Subnet region", control: 'select', options: GCP_REGIONS.map((r        ) => ({ value: r, label: r })), default: "us-central1", hint: "Region, e.g. us-central1" },
            { id: "ssh_source_ranges", label: "SSH allowed from", control: 'text', default: "0.0.0.0/0", hint: "IPv4 or IPv6, comma-separated. One rule per family" },
            { id: "http_source_ranges", label: "HTTP allowed from", control: 'text', default: "0.0.0.0/0", hint: "IPv4 or IPv6, comma-separated. One rule per family" }
          ],
    emits: [],
    build: (values                 , name        ) => {
      const code = 'ansible.gcp.vpc_network';
      // The subnet this play builds is IPv4 (see the note), so an IPv6 source is flagged.
      const ssh = sources(str(values, 'ssh_source_ranges', '0.0.0.0/0'), 'ssh_source_ranges', code, { ipv6Network: false });
      const http = sources(str(values, 'http_source_ranges', '0.0.0.0/0'), 'http_source_ranges', code, { ipv6Network: false });
      const findings            = [
        ...ipv4Range(values.subnet_cidr, 'subnet_cidr', 'The subnet CIDR', code),
        ...ssh.findings,
        ...http.findings,
        info(`${code}.ipv4-only-subnet`, 'VERIFY: the subnet is IPv4 only. Dual stack needs stack_type IPV4_IPV6 and ipv6_access_type on the subnetwork; confirm google.cloud.gcp_compute_subnetwork accepts them in your collection version, or use the Terraform blueprint, which does.', { path: 'subnet_cidr' }),
      ];
      // A firewall rule holds ranges of one family only, so each family is its own rule.
      const firewall = (label        , port        , suffix        , ranges          ) => ranges.length === 0 ? [] : [{
        name: `Allow ${label} ingress${suffix ? ' over IPv6' : ''}`,
        "google.cloud.gcp_compute_firewall": {
          project: "{{ gcp_project }}",
          name: `{{ network_name }}-allow-${label.toLowerCase()}${suffix}`,
          network: "{{ network_name }}",
          allowed: [{ IPProtocol: "tcp", ports: [port] }],
          source_ranges: ranges
        }
      }];
      const out = playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create GCP VPC and subnet",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  network_name: vals.network_name,
                  subnet_name: vals.subnet_name,
                  subnet_cidr: vals.subnet_cidr,
                  region: vals.region
                },
                tasks: [
                  {
                    name: "Create custom VPC network",
                    "google.cloud.gcp_compute_network": {
                      project: "{{ gcp_project }}",
                      name: "{{ network_name }}",
                      auto_create_subnetworks: false
                    }
                  },
                  {
                    name: "Create subnet",
                    "google.cloud.gcp_compute_subnetwork": {
                      project: "{{ gcp_project }}",
                      name: "{{ subnet_name }}",
                      region: "{{ region }}",
                      network: "{{ network_name }}",
                      ip_cidr_range: "{{ subnet_cidr }}"
                    }
                  },
                  ...firewall("SSH", "22", "", ssh.v4),
                  ...firewall("SSH", "22", "-ipv6", ssh.v6),
                  ...firewall("HTTP", "80", "", http.v4),
                  ...firewall("HTTP", "80", "-ipv6", http.v6)
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Network – VPC + subnet + firewall',
      );
      return { ...out, findings: [...findings, ...out.findings] };
    },
  },
  {
    id: 'gcs_bucket',
    label: 'Storage – GCS bucket',
    description: 'Create a Google Cloud Storage bucket.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "bucket_name", label: "Bucket name", control: 'text', default: "app-archive-gcs", hint: "Globally unique" },
            { id: "location", label: "Location", control: 'select', options: [{ value: 'US', label: 'US (multi-region)' }, { value: 'EU', label: 'EU (multi-region)' }, { value: 'ASIA', label: 'ASIA (multi-region)' }, ...GCP_REGIONS.map((r        ) => ({ value: r, label: r }))], default: "US", hint: "US, EU, regional code, etc." }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create GCS bucket",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  bucket_name: vals.bucket_name,
                  bucket_location: vals.location
                },
                tasks: [
                  {
                    name: "Create bucket",
                    "google.cloud.gcp_storage_bucket": {
                      name: "{{ bucket_name }}",
                      project: "{{ gcp_project }}",
                      location: "{{ bucket_location }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Storage – GCS bucket',
      ),
  },
  {
    id: 'pubsub_topic',
    label: 'Pub/Sub – Topic & subscription',
    description: 'Create a Pub/Sub topic and a pull subscription.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "topic_name", label: "Topic name", control: 'text', default: "app-events", hint: "Topic ID" },
            { id: "subscription_name", label: "Subscription name", control: 'text', default: "app-events-sub", hint: "Subscription ID" }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create Pub/Sub topic and subscription",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  topic_name: vals.topic_name,
                  subscription_name: vals.subscription_name
                },
                tasks: [
                  {
                    name: "Ensure topic exists",
                    "google.cloud.gcp_pubsub_topic": {
                      name: "{{ topic_name }}",
                      project: "{{ gcp_project }}"
                    },
                    register: "topic"
                  },
                  {
                    name: "Ensure pull subscription exists",
                    "google.cloud.gcp_pubsub_subscription": {
                      name: "{{ subscription_name }}",
                      topic: "{{ topic_name }}",
                      project: "{{ gcp_project }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Pub/Sub – Topic & subscription',
      ),
  },
  {
    id: 'cloud_sql_instance',
    label: 'Cloud SQL – Instance & DB',
    description: 'Create a Cloud SQL instance and a database (PostgreSQL/MySQL).',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            {
              id: "db_tier",
              label: "Tier",
              control: 'text',
              default: "db-custom-1-3840",
              hint: "db-custom-*-* or db-f1-micro, etc."
            },
            {
              id: "db_version",
              label: "Database version",
              control: 'select',
              options: [
                { value: "POSTGRES_15", label: "PostgreSQL 15" },
                { value: "POSTGRES_14", label: "PostgreSQL 14" },
                { value: "MYSQL_8_0", label: "MySQL 8.0" }
              ],
              default: "POSTGRES_15",
              hint: "Engine & version"
            },
            { id: "instance_name", label: "Instance name", control: 'text', default: "app-sql-01", hint: "Cloud SQL instance ID" },
            { id: "db_name", label: "Database name", control: 'text', default: "app", hint: "Initial database" },
            { id: "root_password", label: "Root password", control: 'text', default: "ChangeMe123!", hint: "Use secret manager in real life" },
            { id: "region", label: "Region", control: 'select', options: GCP_REGIONS.map((r        ) => ({ value: r, label: r })), default: "us-central1", hint: "Region (e.g. us-central1)" }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create Cloud SQL instance and database",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  db_tier: vals.db_tier,
                  db_version: vals.db_version,
                  sql_instance_name: vals.instance_name,
                  db_name: vals.db_name,
                  root_password: vals.root_password,
                  region: vals.region
                },
                tasks: [
                  {
                    name: "Create Cloud SQL instance",
                    "google.cloud.gcp_sql_instance": {
                      project: "{{ gcp_project }}",
                      name: "{{ sql_instance_name }}",
                      region: "{{ region }}",
                      database_version: "{{ db_version }}",
                      settings: {
                        tier: "{{ db_tier }}"
                      },
                      root_password: "{{ root_password }}"
                    }
                  },
                  {
                    name: "Create database",
                    "google.cloud.gcp_sql_database": {
                      project: "{{ gcp_project }}",
                      instance: "{{ sql_instance_name }}",
                      name: "{{ db_name }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Cloud SQL – Instance & DB',
      ),
  },
  {
    id: 'gke_cluster',
    label: 'GKE – Kubernetes cluster',
    description: 'Create a basic GKE cluster with a single node pool.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "cluster_name", label: "Cluster name", control: 'text', default: "app-gke", hint: "Cluster ID" },
            { id: "location", label: "Location (zone or region)", control: 'select', options: GCP_ZONES.map((z        ) => ({ value: z, label: z })), default: "us-central1-a", hint: "e.g. us-central1-a or us-central1" },
            { id: "node_count", label: "Node count", control: 'number', default: 3, hint: "Number of nodes" },
            { id: "node_machine_type", label: "Node machine type", control: 'text', default: "e2-standard-4", hint: "e2-standard-4, n2-standard-4, etc." }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create GKE cluster",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  cluster_name: vals.cluster_name,
                  location: vals.location,
                  node_count: Number(vals.node_count),
                  node_machine_type: vals.node_machine_type
                },
                tasks: [
                  {
                    name: "Create GKE cluster",
                    "google.cloud.gcp_container_cluster": {
                      project: "{{ gcp_project }}",
                      name: "{{ cluster_name }}",
                      location: "{{ location }}",
                      initial_node_count: "{{ node_count }}",
                      node_config: {
                        machine_type: "{{ node_machine_type }}"
                      }
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'GKE – Kubernetes cluster',
      ),
  },
  {
    id: 'service_account',
    label: 'IAM – Service account + key',
    description: 'Create a service account and a key (JSON) for automation.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "sa_name", label: "Service account name (ID)", control: 'text', default: "app-automation", hint: "Service account ID" },
            { id: "sa_display_name", label: "Display name", control: 'text', default: "App Automation SA", hint: "Friendly name" }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create GCP service account and key",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  sa_name: vals.sa_name,
                  sa_display_name: vals.sa_display_name
                },
                tasks: [
                  {
                    name: "Create service account",
                    "google.cloud.gcp_iam_service_account": {
                      project: "{{ gcp_project }}",
                      name: "projects/{{ gcp_project }}/serviceAccounts/{{ sa_name }}@{{ gcp_project }}.iam.gserviceaccount.com",
                      account_id: "{{ sa_name }}",
                      display_name: "{{ sa_display_name }}"
                    }
                  },
                  {
                    name: "Create service account key",
                    "google.cloud.gcp_iam_service_account_key": {
                      project: "{{ gcp_project }}",
                      service_account: "{{ sa_name }}@{{ gcp_project }}.iam.gserviceaccount.com",
                      private_key_type: "TYPE_GOOGLE_CREDENTIALS_FILE"
                    },
                    register: "sa_key"
                  },
                  {
                    name: "Write key to file (local hint)",
                    "ansible.builtin.debug": {
                      msg: "SA key JSON: {{ sa_key.privateKeyData | default('stored by module output') }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'IAM – Service account + key',
      ),
  },
  {
    id: 'cloud_function',
    label: 'Cloud Functions – HTTP function',
    description: 'Create a simple HTTP Cloud Function (1st gen style).',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "location", label: "Location", control: 'select', options: GCP_REGIONS.map((r        ) => ({ value: r, label: r })), default: "us-central1", hint: "Function region" },
            { id: "function_name", label: "Function name", control: 'text', default: "app-function", hint: "Function ID" },
            { id: "entry_point", label: "Entry point", control: 'text', default: "hello_http", hint: "Handler name" },
            { id: "runtime", label: "Runtime", control: 'text', default: "python310", hint: "e.g. python310, nodejs20" },
            { id: "source_archive_bucket", label: "Source bucket", control: 'text', default: "cf-source-bucket", hint: "GCS bucket containing source" },
            { id: "source_archive_object", label: "Source object", control: 'text', default: "app-function.zip", hint: "Zip object" }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Create Cloud Function",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  location: vals.location,
                  function_name: vals.function_name,
                  entry_point: vals.entry_point,
                  runtime: vals.runtime,
                  source_archive_bucket: vals.source_archive_bucket,
                  source_archive_object: vals.source_archive_object
                },
                tasks: [
                  {
                    name: "Deploy HTTP Cloud Function",
                    "google.cloud.gcp_cloudfunctions_cloud_function": {
                      project: "{{ gcp_project }}",
                      name: "{{ function_name }}",
                      location: "{{ location }}",
                      entry_point: "{{ entry_point }}",
                      runtime: "{{ runtime }}",
                      https_trigger: {},
                      source_archive_bucket: "{{ source_archive_bucket }}",
                      source_archive_object: "{{ source_archive_object }}"
                    }
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Cloud Functions – HTTP function',
      ),
  },
  {
    id: 'cloud_run_service',
    label: 'Cloud Run – Service',
    description: 'Create a Cloud Run service from a container image.',
    inputs: [
    HOSTS_INPUT,

            { id: "project_id", label: "Project ID", control: 'text', default: "my-gcp-project", hint: "GCP project ID" },
            { id: "service_name", label: "Service name", control: 'text', default: "app-api", hint: "Cloud Run service" },
            { id: "location", label: "Location (region)", control: 'select', options: GCP_REGIONS.map((r        ) => ({ value: r, label: r })), default: "us-central1", hint: "e.g. us-central1" },
            { id: "image", label: "Container image", control: 'text', default: "gcr.io/my-gcp-project/app-api:latest", hint: "Container image URI" },
            {
              id: "allow_unauth",
              label: "Allow unauthenticated",
              control: 'select',
              options: BOOL_OPTIONS,
              default: "false",
              hint: "Public HTTP or IAM-only"
            }
          ],
    emits: [],
    build: (values                 , name        ) =>
      playbookFiles(
        ((vals                , hosts        ) => {
            return [
              {
                name: "Deploy Cloud Run service",
                hosts,
                become: false,
                gather_facts: false,
                vars: {
                  gcp_project: vals.project_id,
                  service_name: vals.service_name,
                  location: vals.location,
                  image: vals.image,
                  allow_unauth: vals.allow_unauth === "true"
                },
                tasks: [
                  {
                    // google.cloud 1.14.0 ships no Cloud Run module, so this
                    // calls the CLI. changed_when is explicit because a deploy
                    // that changes nothing still exits zero.
                    name: "Deploy the Cloud Run service (no module exists in google.cloud)",
                    "ansible.builtin.command": {
                      argv: [
                        "gcloud", "run", "deploy", "{{ service_name }}",
                        "--project", "{{ gcp_project }}",
                        "--region", "{{ location }}",
                        "--image", "{{ image }}",
                        "--platform", "managed",
                        "--quiet"
                      ]
                    },
                    register: "cloud_run_deploy",
                    changed_when: "'Deploying' in cloud_run_deploy.stderr"
                  },
                  {
                    name: "Allow unauthenticated access",
                    "ansible.builtin.command": {
                      argv: [
                        "gcloud", "run", "services", "add-iam-policy-binding", "{{ service_name }}",
                        "--project", "{{ gcp_project }}",
                        "--region", "{{ location }}",
                        "--member", "allUsers",
                        "--role", "roles/run.invoker",
                        "--quiet"
                      ]
                    },
                    when: "allow_unauth | bool",
                    changed_when: true
                  },
                  {
                    name: "Configure IAM for public access (optional hint)",
                    "ansible.builtin.debug": {
                      msg: "To allow unauthenticated access, add IAM binding for allUsers on the service if allow_unauth is true."
                    },
                    when: "allow_unauth"
                  }
                ]
              }
            ];
          })(values, str(values, 'hosts', 'all')),
        name,
        'Cloud Run – Service',
      ),
  },
];

export const GCP_ANSIBLE                 = {
  target: 'google',
  label: 'Google Cloud Platform (GCP)',
  blueprints: BLUEPRINTS,
};

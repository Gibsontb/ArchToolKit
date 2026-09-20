/**
 * The Terraform Maps — GENERATED from the previous toolkit, do not edit by hand.
 *
 * A reference map per cloud: which resource does which job, in which domain,
 * with the pattern the previous toolkit recommended around it. This is the
 * content of `_old/13_Web/static/terraform/terraform-{azure,gcp,oracle}.html`,
 * taken verbatim and turned into data so one page renders all of them and every
 * name in them is checked against the committed provider catalog.
 *
 * The AWS map is not here. `_old/.../terraform-aws.html` is a mislabelled copy
 * of the Azure one — its title reads "Azure Terraform Map", its body holds 54
 * `azurerm_*` names and no `aws_*` at all — so there was nothing to port. It is
 * written in map-aws.ts instead, to the same domains.
 *
 * Regenerate with: python3 tools/port/mapgen.py
 */

import type { CloudMap } from './map.ts';


export const AZURE_MAP: CloudMap = {
  "target": "azure",
  "label": "Azure",
  "title": "Azure Terraform Map · Architect's Toolkit",
  "blurb": "Subscriptions, VNets, identity, AKS and more, mapped to azurerm_* / azuread_* .",
  "sections": [
    {
      "id": "az-overview",
      "title": "Azure Terraform Overview",
      "badge": "Azure",
      "tagline": "Azure + Terraform = subscriptions, resource groups, VNets, workloads, and guardrails expressed as repeatable blueprints for every court, tenant, or environment.",
      "notes": [
        "Provider: azurerm for Azure resources, azuread for identities.",
        "Scope: Tenant → Management Group → Subscription → Resource Group.",
        "State: commonly Azure Storage backend per environment."
      ],
      "code": [
        "terraform {\n  required_providers {\n    azurerm = {\n      source  = \"hashicorp/azurerm\"\n      version = \"~> 4.0\"\n    }\n    azuread = {\n      source  = \"hashicorp/azuread\"\n      version = \"~> 3.0\"\n    }\n  }\n\n  backend \"azurerm\" {\n    resource_group_name  = \"tfstate-rg\"\n    storage_account_name = \"tfstateaccount\"\n    container_name       = \"tfstate\"\n    key                  = \"azure/core.tfstate\"\n  }\n}\n\nprovider \"azurerm\" {\n  features {}\n}\n\nprovider \"azuread\" {}"
      ]
    },
    {
      "id": "az-identity",
      "title": "Identity, Tenants & RBAC",
      "badge": "Identity",
      "tagline": "Azure identity in Terraform splits across Azure AD ( azuread ) and subscription-level RBAC ( azurerm ). Your main decision surface is how you model personas & access .",
      "tables": [
        {
          "headers": [
            "Concept",
            "Service",
            "Terraform Resources",
            "Language Options"
          ],
          "rows": [
            {
              "cells": [
                "Tenant & Directory",
                "Azure AD",
                "data \"azuread_client_config\" , data \"azuread_directory_object\"",
                "Used mainly as data sources; feed IDs into RBAC modules."
              ],
              "resources": []
            },
            {
              "cells": [
                "Users & Groups",
                "Azure AD",
                "azuread_user , azuread_group , azuread_group_member",
                "for_each over “role → members” maps; use objects to describe personas."
              ],
              "resources": [
                "azuread_user",
                "azuread_group",
                "azuread_group_member",
                "for_each"
              ]
            },
            {
              "cells": [
                "Managed Identities",
                "Azure",
                "azurerm_user_assigned_identity , azurerm_linux_virtual_machine / azurerm_kubernetes_cluster identity blocks",
                "Expose identity IDs via outputs for app modules to consume."
              ],
              "resources": [
                "azurerm_user_assigned_identity",
                "azurerm_linux_virtual_machine",
                "azurerm_kubernetes_cluster"
              ]
            },
            {
              "cells": [
                "RBAC Assignments",
                "Azure RBAC",
                "azurerm_role_assignment , azurerm_role_definition",
                "for_each across a standard RBAC matrix: “scope, principal, role”."
              ],
              "resources": [
                "azurerm_role_assignment",
                "azurerm_role_definition",
                "for_each"
              ]
            }
          ]
        }
      ],
      "examples": [
        {
          "title": "Example: RBAC matrix with for_each",
          "code": "locals {\n  # CCoE-approved RBAC mapping\n  rbac = {\n    \"court-admins\" = {\n      principal_id = azuread_group.court_admins.object_id\n      role_name    = \"Owner\"\n      scope        = \"/subscriptions/${var.subscription_id}\"\n    }\n    \"app-ops\" = {\n      principal_id = azuread_group.app_ops.object_id\n      role_name    = \"Contributor\"\n      scope        = \"/subscriptions/${var.subscription_id}/resourceGroups/${var.app_rg}\"\n    }\n  }\n}\n\ndata \"azurerm_role_definition\" \"by_name\" {\n  for_each = { for k, v in local.rbac : k => v.role_name }\n\n  name  = each.value\n  scope = local.rbac[each.key].scope\n}\n\nresource \"azurerm_role_assignment\" \"rbac\" {\n  for_each = local.rbac\n\n  principal_id         = each.value.principal_id\n  role_definition_id   = data.azurerm_role_definition.by_name[each.key].role_definition_resource_id\n  scope                = each.value.scope\n  skip_service_principal_aad_check = true\n}"
        }
      ]
    },
    {
      "id": "az-networking",
      "title": "Networking & Connectivity",
      "badge": "Network",
      "tagline": "VNets, subnets, NSGs, firewalls and connectivity (VPN, ExpressRoute) are the spine of your Azure landing zone. Terraform options decide how strongly you standardize them.",
      "tables": [
        {
          "headers": [
            "Domain",
            "Services",
            "Terraform Resources",
            "Pattern / Options"
          ],
          "rows": [
            {
              "cells": [
                "Virtual Networks",
                "VNet, Subnet",
                "azurerm_virtual_network , azurerm_subnet",
                "Module around VNet + subnets; cidrsubnet for address planning, for_each to emit subnets."
              ],
              "resources": [
                "azurerm_virtual_network",
                "azurerm_subnet",
                "for_each"
              ]
            },
            {
              "cells": [
                "Security",
                "NSG, Azure Firewall, DDoS plan",
                "azurerm_network_security_group , azurerm_network_security_rule , azurerm_firewall , azurerm_firewall_policy",
                "Rules from object variables; shared firewall policy module for consistent north-south rules."
              ],
              "resources": [
                "azurerm_network_security_group",
                "azurerm_network_security_rule",
                "azurerm_firewall",
                "azurerm_firewall_policy"
              ]
            },
            {
              "cells": [
                "Hybrid Connectivity",
                "VPN, ExpressRoute",
                "azurerm_virtual_network_gateway , azurerm_local_network_gateway , azurerm_virtual_network_gateway_connection , azurerm_express_route_circuit",
                "“Court-to-court / court-to-datacenter” connectivity modules; depends_on for ordering."
              ],
              "resources": [
                "azurerm_virtual_network_gateway",
                "azurerm_local_network_gateway",
                "azurerm_virtual_network_gateway_connection",
                "azurerm_express_route_circuit",
                "depends_on"
              ]
            },
            {
              "cells": [
                "Private Access",
                "Private Link",
                "azurerm_private_endpoint , azurerm_private_dns_zone , azurerm_private_dns_zone_virtual_network_link",
                "Standard module for “private PaaS access” across storage, SQL, etc."
              ],
              "resources": [
                "azurerm_private_endpoint",
                "azurerm_private_dns_zone",
                "azurerm_private_dns_zone_virtual_network_link"
              ]
            }
          ]
        }
      ],
      "examples": [
        {
          "title": "Example: VNet module skeleton",
          "code": "variable \"name\"         { type = string }\nvariable \"resource_group\" { type = string }\nvariable \"location\"       { type = string }\nvariable \"address_space\"  { type = string }\n\nvariable \"subnets\" {\n  description = \"Map of subnet name -> cidr + flags\"\n  type = map(object({\n    cidr      = string\n    nsg_name  = optional(string)\n    delegated = optional(string)\n  }))\n}\n\nresource \"azurerm_virtual_network\" \"this\" {\n  name                = var.name\n  location            = var.location\n  resource_group_name = var.resource_group\n  address_space       = [var.address_space]\n}\n\nresource \"azurerm_subnet\" \"this\" {\n  for_each             = var.subnets\n  name                 = each.key\n  resource_group_name  = var.resource_group\n  virtual_network_name = azurerm_virtual_network.this.name\n  address_prefixes     = [each.value.cidr]\n}"
        }
      ]
    },
    {
      "id": "az-compute",
      "title": "Compute, AKS & App Services",
      "badge": "Compute",
      "tagline": "VMs, scale sets, AKS clusters, and PaaS app services – the main execution engines for your apps.",
      "tables": [
        {
          "headers": [
            "Domain",
            "Services",
            "Terraform Resources",
            "Options / Patterns"
          ],
          "rows": [
            {
              "cells": [
                "VMs",
                "Linux/Windows VM",
                "azurerm_linux_virtual_machine , azurerm_windows_virtual_machine",
                "Use objects for size, OS, disks, identity; templatefile for cloud-init."
              ],
              "resources": [
                "azurerm_linux_virtual_machine",
                "azurerm_windows_virtual_machine"
              ]
            },
            {
              "cells": [
                "Scale Sets",
                "VMSS",
                "azurerm_linux_virtual_machine_scale_set , azurerm_windows_virtual_machine_scale_set",
                "Fronted by load balancer or Application Gateway; count/for_each for zone distribution."
              ],
              "resources": [
                "azurerm_linux_virtual_machine_scale_set",
                "azurerm_windows_virtual_machine_scale_set"
              ]
            },
            {
              "cells": [
                "Containers",
                "AKS, ACR",
                "azurerm_kubernetes_cluster , azurerm_container_registry",
                "Cluster module with options for node pools, network plugin, RBAC, Azure AD integration."
              ],
              "resources": [
                "azurerm_kubernetes_cluster",
                "azurerm_container_registry"
              ]
            },
            {
              "cells": [
                "PaaS Apps",
                "App Service / Functions",
                "azurerm_app_service_plan , azurerm_linux_web_app , azurerm_windows_web_app , azurerm_function_app",
                "Module accepts app metadata, app settings, slots; builds diagnostic settings and identity by default."
              ],
              "resources": [
                "azurerm_app_service_plan",
                "azurerm_linux_web_app",
                "azurerm_windows_web_app",
                "azurerm_function_app"
              ]
            }
          ]
        }
      ],
      "examples": [
        {
          "title": "Example: AKS cluster snippet",
          "code": "resource \"azurerm_kubernetes_cluster\" \"aks\" {\n  name                = \"${var.environment}-${var.name}\"\n  location            = var.location\n  resource_group_name = var.resource_group\n  dns_prefix          = \"${var.environment}-${var.name}\"\n\n  identity {\n    type = \"SystemAssigned\"\n  }\n\n  default_node_pool {\n    name       = \"system\"\n    node_count = var.node_count\n    vm_size    = var.node_size\n    vnet_subnet_id = var.subnet_id\n  }\n\n  network_profile {\n    network_plugin    = \"azure\"\n    load_balancer_sku = \"standard\"\n  }\n\n  role_based_access_control_enabled = true\n\n  tags = var.tags\n}"
        }
      ]
    },
    {
      "id": "az-storage",
      "title": "Storage & Data",
      "badge": "Storage",
      "tagline": "Storage Accounts, blobs, files, queues and other data services become “evidence buckets”, log sinks, and integration channels.",
      "tables": [
        {
          "headers": [
            "Service",
            "Terraform Resources",
            "What You Decide"
          ],
          "rows": [
            {
              "cells": [
                "Storage Account",
                "azurerm_storage_account",
                "Kind (StorageV2), replication (LRS/ZRS/GZRS), access tier, public access disabled, encryption, managed identity."
              ],
              "resources": [
                "azurerm_storage_account"
              ]
            },
            {
              "cells": [
                "Blob Containers & Queues",
                "azurerm_storage_container , azurerm_storage_queue",
                "Container/queue names and ACLs; usually created by a “logging” or “evidence” module."
              ],
              "resources": [
                "azurerm_storage_container",
                "azurerm_storage_queue"
              ]
            },
            {
              "cells": [
                "File Shares",
                "azurerm_storage_share",
                "Size, protocol (if NFS), retention; referenced from VM or app modules."
              ],
              "resources": [
                "azurerm_storage_share"
              ]
            }
          ]
        }
      ],
      "examples": [
        {
          "title": "Example: Evidence Storage module core",
          "code": "variable \"evidence_rg\"   { type = string }\nvariable \"location\"      { type = string }\nvariable \"environment\"   { type = string }\n\nresource \"azurerm_storage_account\" \"evidence\" {\n  name                     = lower(replace(\"${var.environment}evidence\", \"-\", \"\"))\n  resource_group_name      = var.evidence_rg\n  location                 = var.location\n  account_tier             = \"Standard\"\n  account_replication_type = \"ZRS\"\n  min_tls_version          = \"TLS1_2\"\n  allow_blob_public_access = false\n\n  blob_properties {\n    delete_retention_policy {\n      days = 90\n    }\n  }\n\n  tags = {\n    environment = var.environment\n    purpose     = \"evidence\"\n  }\n}\n\nresource \"azurerm_storage_container\" \"evidence\" {\n  name                  = \"evidence\"\n  storage_account_name  = azurerm_storage_account.evidence.name\n  container_access_type = \"private\"\n}"
        }
      ]
    },
    {
      "id": "az-database",
      "title": "Databases & Analytics",
      "badge": "Data",
      "tagline": "Azure SQL, PostgreSQL, Cosmos DB, Synapse and other data services – tied into VNets and private endpoints, plus backups and encryption.",
      "tables": [
        {
          "headers": [
            "Service",
            "Terraform Resources",
            "Key Options"
          ],
          "rows": [
            {
              "cells": [
                "Azure SQL",
                "azurerm_mssql_server , azurerm_mssql_database , azurerm_mssql_virtual_network_rule",
                "Version, backup retention, minimum TLS, AAD auth, vNet rules vs. public. Modules enforce defaults."
              ],
              "resources": [
                "azurerm_mssql_server",
                "azurerm_mssql_database",
                "azurerm_mssql_virtual_network_rule"
              ]
            },
            {
              "cells": [
                "PostgreSQL Flexible",
                "azurerm_postgresql_flexible_server , azurerm_postgresql_flexible_database",
                "SKU, HA, backup window, storage, public vs. private access, connection limits."
              ],
              "resources": [
                "azurerm_postgresql_flexible_server",
                "azurerm_postgresql_flexible_database"
              ]
            },
            {
              "cells": [
                "Cosmos DB",
                "azurerm_cosmosdb_account , azurerm_cosmosdb_sql_database , azurerm_cosmosdb_sql_container",
                "Consistency, throughput, region replicas, IP filters, key vs. RBAC access."
              ],
              "resources": [
                "azurerm_cosmosdb_account",
                "azurerm_cosmosdb_sql_database",
                "azurerm_cosmosdb_sql_container"
              ]
            },
            {
              "cells": [
                "Analytics",
                "azurerm_synapse_workspace , azurerm_synapse_sql_pool",
                "Network, managed VNet, integration with storage/logging."
              ],
              "resources": [
                "azurerm_synapse_workspace",
                "azurerm_synapse_sql_pool"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "az-governance",
      "title": "Security, Policy & Monitoring",
      "badge": "Guardrails",
      "tagline": "Key Vault, policies, blueprints, monitoring and diagnostics – this is where Terraform enforces your security model instead of relying on manual clicks.",
      "tables": [
        {
          "headers": [
            "Domain",
            "Services",
            "Resources",
            "Terraform “Options”"
          ],
          "rows": [
            {
              "cells": [
                "Secrets & Keys",
                "Key Vault",
                "azurerm_key_vault , azurerm_key_vault_key , azurerm_key_vault_secret",
                "Vault creation and configuration as a reusable module; soft delete, purge protection, RBAC vs. access policies."
              ],
              "resources": [
                "azurerm_key_vault",
                "azurerm_key_vault_key",
                "azurerm_key_vault_secret"
              ]
            },
            {
              "cells": [
                "Policy",
                "Azure Policy",
                "azurerm_policy_definition , azurerm_policy_set_definition , azurerm_policy_assignment",
                "Policies stored as JSON templates; Terraform wires them to scopes (MG / subscription / RG)."
              ],
              "resources": [
                "azurerm_policy_definition",
                "azurerm_policy_set_definition",
                "azurerm_policy_assignment"
              ]
            },
            {
              "cells": [
                "Diagnostics",
                "Monitor & Logs",
                "azurerm_monitor_diagnostic_setting , azurerm_log_analytics_workspace , azurerm_monitor_action_group",
                "Standard diagnostic settings module attaches logs/metrics to workspace + event hub."
              ],
              "resources": [
                "azurerm_monitor_diagnostic_setting",
                "azurerm_log_analytics_workspace",
                "azurerm_monitor_action_group"
              ]
            },
            {
              "cells": [
                "Security Center",
                "Defender for Cloud",
                "azurerm_security_center_contact , azurerm_security_center_subscription_pricing",
                "Baseline module ensures security pricing is enabled for all subscriptions."
              ],
              "resources": [
                "azurerm_security_center_contact",
                "azurerm_security_center_subscription_pricing"
              ]
            }
          ]
        }
      ],
      "examples": [
        {
          "title": "Example: Policy assignment via template",
          "code": "resource \"azurerm_policy_definition\" \"allowed_locations\" {\n  name         = \"allowed-locations\"\n  policy_type  = \"Custom\"\n  mode         = \"Indexed\"\n  display_name = \"Allowed locations for resources\"\n\n  policy_rule = templatefile(\"${path.module}/policies/allowed_locations.json\", {\n    locations = var.allowed_locations\n  })\n}\n\nresource \"azurerm_policy_assignment\" \"allowed_locations\" {\n  name                 = \"allowed-locations\"\n  scope                = \"/subscriptions/${var.subscription_id}\"\n  policy_definition_id = azurerm_policy_definition.allowed_locations.id\n\n  parameters = jsonencode({\n    listOfAllowedLocations = {\n      value = var.allowed_locations\n    }\n  })\n}"
        }
      ]
    },
    {
      "id": "az-patterns",
      "title": "CCoE Patterns & Recipes (Azure)",
      "badge": "Patterns",
      "tagline": "A small index of “things we actually do” on Azure and which Terraform blocks/modules/options you combine each time. This is the Azure pillar of your overall decision logic kit.",
      "tables": [
        {
          "headers": [
            "Pattern",
            "Scope",
            "Terraform Stack",
            "Language Options"
          ],
          "rows": [
            {
              "cells": [
                "Hub-and-Spoke Landing Zone",
                "Tenant → MG → Subscriptions → VNets",
                "Org/landing-zone module, VNet module, RBAC module, logs module",
                "modules , for_each on subscriptions/spokes, object inputs for address spaces."
              ],
              "resources": [
                "for_each"
              ]
            },
            {
              "cells": [
                "Court-Isolated Subscription",
                "Subscription + core resource groups + VNets",
                "“Court subscription bootstrap” module calling RG, VNet, RBAC, logging modules",
                "locals for RG names, for_each for RBAC entries, validation for allowed regions."
              ],
              "resources": [
                "for_each"
              ]
            },
            {
              "cells": [
                "Court-to-Court Secure Link (Azure-only)",
                "VNets between subscriptions",
                "VNet peering module, shared firewall module",
                "depends_on between VNets, for_each over peering pairs."
              ],
              "resources": [
                "depends_on",
                "for_each"
              ]
            },
            {
              "cells": [
                "Court-to-Datacenter Hybrid Link",
                "On-prem ↔ Azure",
                "VPN/ExpressRoute connectivity module + standard routes + NSGs",
                "resource for gateways, data for remote networks, locals for allowed prefixes."
              ],
              "resources": []
            },
            {
              "cells": [
                "Secure App Stack (AKS + PaaS)",
                "AKS cluster, ACR, Key Vault, app services",
                "“App stack” module that wires AKS, ACR, KV, App Insights, diagnostics",
                "module composition, object “app descriptor”, jsonencode for appsettings."
              ],
              "resources": []
            },
            {
              "cells": [
                "Evidence & Log Enclave",
                "Storage + Log Analytics + Policy",
                "Evidence storage module, central logs module, policy assignments",
                "prevent_destroy in lifecycle, for_each over courts, cidr* for private endpoints."
              ],
              "resources": [
                "prevent_destroy",
                "for_each"
              ]
            }
          ]
        }
      ]
    }
  ]
};

export const GOOGLE_MAP: CloudMap = {
  "target": "google",
  "label": "GCP",
  "title": "GCP Terraform Map · Architect's Toolkit",
  "blurb": "Projects, VPCs, GKE, IAM, and logging as google_* resources.",
  "sections": [
    {
      "id": "gcp-overview",
      "title": "GCP Terraform Overview",
      "badge": "GCP",
      "tagline": "Terraform + google provider: org → folders → projects, with VPCs and services enabled per project.",
      "notes": [
        "Provider: google , optionally google-beta .",
        "State: usually in a GCS bucket.",
        "Isolation: projects per environment or per court/tenant."
      ],
      "code": [
        "terraform {\n  required_providers {\n    google = {\n      source  = \"hashicorp/google\"\n      version = \"~> 5.0\"\n    }\n  }\n\n  backend \"gcs\" {\n    bucket = \"tfstate-central\"\n    prefix = \"gcp/global\"\n  }\n}\n\nprovider \"google\" {\n  project = var.project_id\n  region  = var.region\n}"
      ]
    },
    {
      "id": "gcp-networking",
      "title": "Networking",
      "badge": "VPC",
      "tagline": "GCP networking is project-based: VPC per project or shared VPC. Terraform options: for_each across regions, object variables for subnet definitions.",
      "tables": [
        {
          "headers": [
            "Concept",
            "Service",
            "Resources",
            "Language Options"
          ],
          "rows": [
            {
              "cells": [
                "VPC",
                "Virtual Private Cloud",
                "google_compute_network",
                "Boolean for auto_subnetworks, naming via format ."
              ],
              "resources": [
                "google_compute_network"
              ]
            },
            {
              "cells": [
                "Subnets",
                "Regional subnets",
                "google_compute_subnetwork",
                "for_each on subnet map, cidrsubnet for addresses."
              ],
              "resources": [
                "google_compute_subnetwork",
                "for_each"
              ]
            },
            {
              "cells": [
                "Hybrid connectivity",
                "Cloud Router + Cloud NAT",
                "google_compute_router , google_compute_router_nat",
                "Objects for NAT configuration, for_each for multiple NATs."
              ],
              "resources": [
                "google_compute_router",
                "google_compute_router_nat",
                "for_each"
              ]
            }
          ]
        }
      ],
      "code": [
        "locals {\n  subnets = {\n    \"gke-primary\" = {\n      region = \"us-central1\"\n      cidr   = \"10.0.0.0/20\"\n    }\n    \"app-backend\" = {\n      region = \"us-central1\"\n      cidr   = \"10.0.16.0/20\"\n    }\n  }\n}\n\nresource \"google_compute_network\" \"vpc\" {\n  name                    = \"${var.environment}-vpc\"\n  auto_create_subnetworks = false\n}\n\nresource \"google_compute_subnetwork\" \"subnet\" {\n  for_each      = local.subnets\n  name          = each.key\n  ip_cidr_range = each.value.cidr\n  region        = each.value.region\n  network       = google_compute_network.vpc.id\n}"
      ]
    },
    {
      "id": "gcp-compute",
      "title": "Compute & GKE",
      "badge": "GCE / GKE",
      "tagline": "Instances, managed instance groups (MIGs), and GKE clusters. Terraform options: templates, for_each over groups, object configs for node pools.",
      "tables": [
        {
          "headers": [
            "Area",
            "Resources"
          ],
          "rows": [
            {
              "cells": [
                "Instances",
                "google_compute_instance"
              ],
              "resources": [
                "google_compute_instance"
              ]
            },
            {
              "cells": [
                "MIGs",
                "google_compute_instance_template, google_compute_region_instance_group_manager"
              ],
              "resources": [
                "google_compute_instance_template",
                "google_compute_region_instance_group_manager"
              ]
            },
            {
              "cells": [
                "GKE",
                "google_container_cluster, google_container_node_pool"
              ],
              "resources": [
                "google_container_cluster",
                "google_container_node_pool"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "gcp-iam",
      "title": "IAM & Folder Structure",
      "badge": "IAM",
      "tagline": "IAM policies in GCP are list-based bindings: Terraform maps these as google_project_iam_* and google_folder_iam_* resources, usually driven by maps and loops.",
      "tables": [
        {
          "headers": [
            "Scope",
            "Resource",
            "Use"
          ],
          "rows": [
            {
              "cells": [
                "Project",
                "google_project_iam_binding , google_project_iam_member",
                "Assign roles to groups / service accounts."
              ],
              "resources": [
                "google_project_iam_binding",
                "google_project_iam_member"
              ]
            },
            {
              "cells": [
                "Folder",
                "google_folder_iam_member",
                "Higher-level policy for a group of projects."
              ],
              "resources": [
                "google_folder_iam_member"
              ]
            },
            {
              "cells": [
                "Org",
                "google_organization_iam_member",
                "Org-wide SRE, audit, security roles."
              ],
              "resources": [
                "google_organization_iam_member"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "gcp-storage",
      "title": "Storage & Data",
      "badge": "GCS / DB / BigQuery",
      "tagline": "GCS, Cloud SQL, and BigQuery store your data; Terraform options define redundancy, encryption, and access control via IAM.",
      "tables": [
        {
          "headers": [
            "Area",
            "Resources"
          ],
          "rows": [
            {
              "cells": [
                "GCS",
                "google_storage_bucket"
              ],
              "resources": [
                "google_storage_bucket"
              ]
            },
            {
              "cells": [
                "Cloud SQL",
                "google_sql_database_instance, google_sql_user"
              ],
              "resources": [
                "google_sql_database_instance",
                "google_sql_user"
              ]
            },
            {
              "cells": [
                "BigQuery",
                "google_bigquery_dataset, google_bigquery_table"
              ],
              "resources": [
                "google_bigquery_dataset",
                "google_bigquery_table"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "gcp-security",
      "title": "Security & Logging",
      "badge": "Guardrails",
      "tagline": "Org-wide logging and security posture via log sinks, KMS, and monitoring alerts.",
      "tables": [
        {
          "headers": [
            "Area",
            "Resources"
          ],
          "rows": [
            {
              "cells": [
                "KMS",
                "google_kms_key_ring, google_kms_crypto_key"
              ],
              "resources": [
                "google_kms_key_ring",
                "google_kms_crypto_key"
              ]
            },
            {
              "cells": [
                "Logging",
                "google_logging_project_sink, google_logging_organization_sink"
              ],
              "resources": [
                "google_logging_project_sink",
                "google_logging_organization_sink"
              ]
            },
            {
              "cells": [
                "Monitoring",
                "google_monitoring_alert_policy, google_monitoring_notification_channel"
              ],
              "resources": [
                "google_monitoring_alert_policy",
                "google_monitoring_notification_channel"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "gcp-patterns",
      "title": "CCoE Patterns for GCP",
      "badge": "Patterns",
      "tagline": "Typical patterns you’ll cross-link from your main CCoE decision logic.",
      "tables": [
        {
          "headers": [
            "Pattern",
            "Scope",
            "Terraform Options"
          ],
          "rows": [
            {
              "cells": [
                "Org / Folder Bootstrap",
                "Org + folders",
                "Org/folder modules, for_each over folders, IAM bindings per folder."
              ],
              "resources": [
                "for_each"
              ]
            },
            {
              "cells": [
                "Secure Court Project",
                "One project per tenant",
                "Project module, VPC module, logging sink module; object inputs for court metadata."
              ],
              "resources": []
            },
            {
              "cells": [
                "Data Lake + Analytics",
                "Project / folder",
                "GCS + BigQuery modules, IAM policies for analysts, retention configs."
              ],
              "resources": []
            }
          ]
        }
      ]
    }
  ]
};

export const OCI_MAP: CloudMap = {
  "target": "oci",
  "label": "OCI",
  "title": "Oracle Cloud Terraform Map · Architect's Toolkit",
  "blurb": "Tenancy, compartments, VCNs, compute, IAM – mapped to oci_* .",
  "sections": [
    {
      "id": "oci-overview",
      "title": "OCI Terraform Overview",
      "badge": "OCI",
      "tagline": "Terraform + oci provider = tenancy layout, compartments, VCNs, workloads, and guardrails defined as code.",
      "notes": [
        "Provider: oci with config profile or env vars.",
        "Key concept: compartments as isolation boundaries, VCNs as network boundaries.",
        "State: typically remote (S3/GCS/remote) or local file when labbing."
      ],
      "code": [
        "terraform {\n  required_providers {\n    oci = {\n      source  = \"oracle/oci\"\n      version = \"~> 6.0\"\n    }\n  }\n}\n\nprovider \"oci\" {\n  # Uses default profile from ~/.oci/config or env variables\n  region = var.region\n}"
      ]
    },
    {
      "id": "oci-identity",
      "title": "Tenancy & Compartments",
      "badge": "Identity",
      "tagline": "In OCI, compartments are the primary unit of isolation. Terraform options are mostly about building the right tree with for_each and enforcing naming and tags.",
      "tables": [
        {
          "headers": [
            "Concept",
            "Service",
            "Resources",
            "Language Options"
          ],
          "rows": [
            {
              "cells": [
                "Tenancy root",
                "Tenancy",
                "data \"oci_identity_tenancy\"",
                "Use as root for compartment tree; queried as data source."
              ],
              "resources": []
            },
            {
              "cells": [
                "Compartments",
                "Identity",
                "oci_identity_compartment",
                "for_each across a map describing your standard layout (security, shared, apps, etc.)."
              ],
              "resources": [
                "oci_identity_compartment",
                "for_each"
              ]
            },
            {
              "cells": [
                "Groups & Policies",
                "Identity",
                "oci_identity_group , oci_identity_user , oci_identity_policy",
                "Policy statements as strings; build from templatefile or local lists."
              ],
              "resources": [
                "oci_identity_group",
                "oci_identity_user",
                "oci_identity_policy"
              ]
            },
            {
              "cells": [
                "Dynamic Groups",
                "Identity",
                "oci_identity_dynamic_group",
                "Condition strings derived from tags; use format and join ."
              ],
              "resources": [
                "oci_identity_dynamic_group"
              ]
            }
          ]
        }
      ],
      "examples": [
        {
          "title": "Example: Compartment Layout with for_each",
          "code": "data \"oci_identity_tenancy\" \"root\" {\n  tenancy_id = var.tenancy_ocid\n}\n\nlocals {\n  compartments = {\n    \"security\" = {\n      description = \"Central security & audit\"\n      parent_ocid = data.oci_identity_tenancy.root.id\n    }\n    \"shared-services\" = {\n      description = \"Shared court services\"\n      parent_ocid = data.oci_identity_tenancy.root.id\n    }\n    \"court-a\" = {\n      description = \"Court A workloads\"\n      parent_ocid = data.oci_identity_tenancy.root.id\n    }\n  }\n}\n\nresource \"oci_identity_compartment\" \"comp\" {\n  for_each                = local.compartments\n  compartment_id          = each.value.parent_ocid\n  description             = each.value.description\n  name                    = each.key\n  enable_delete           = false\n  freeform_tags           = var.common_tags\n}"
        }
      ]
    },
    {
      "id": "oci-networking",
      "title": "Networking & Connectivity",
      "badge": "VCN",
      "tagline": "VCNs, subnets, DRGs, local peering, and FastConnect – Terraform stitches these together using modules and cidr* helpers.",
      "tables": [
        {
          "headers": [
            "Concept",
            "Service",
            "Resources",
            "Language Options"
          ],
          "rows": [
            {
              "cells": [
                "VCN",
                "Networking",
                "oci_core_vcn",
                "Take CIDR and DNS label via variables; typically wrapped in VCN module."
              ],
              "resources": [
                "oci_core_vcn"
              ]
            },
            {
              "cells": [
                "Subnets",
                "Networking",
                "oci_core_subnet",
                "for_each on a subnet map; cidrsubnet to carve from VCN CIDR."
              ],
              "resources": [
                "oci_core_subnet",
                "for_each"
              ]
            },
            {
              "cells": [
                "Routing",
                "Route Tables, Gateways",
                "oci_core_route_table , oci_core_internet_gateway , oci_core_nat_gateway , oci_core_service_gateway",
                "Use modules for “public”, “private”, “service” route tables with standard rules."
              ],
              "resources": [
                "oci_core_route_table",
                "oci_core_internet_gateway",
                "oci_core_nat_gateway",
                "oci_core_service_gateway"
              ]
            },
            {
              "cells": [
                "Security",
                "Security Lists, NSGs",
                "oci_core_security_list , oci_core_network_security_group , oci_core_network_security_group_security_rule",
                "Rules built via for_each from a rules map; reuse objects across environments."
              ],
              "resources": [
                "oci_core_security_list",
                "oci_core_network_security_group",
                "oci_core_network_security_group_security_rule",
                "for_each"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "oci-compute",
      "title": "Compute & Pools",
      "badge": "Compute",
      "tagline": "Instances, instance configs, and pools are the main building blocks. Terraform options are about standardized shapes, images, and placement rules.",
      "tables": [
        {
          "headers": [
            "Area",
            "Resources"
          ],
          "rows": [
            {
              "cells": [
                "Instances",
                "oci_core_instance"
              ],
              "resources": [
                "oci_core_instance"
              ]
            },
            {
              "cells": [
                "Instance configs & pools",
                "oci_core_instance_configuration, oci_core_instance_pool"
              ],
              "resources": [
                "oci_core_instance_configuration",
                "oci_core_instance_pool"
              ]
            }
          ]
        }
      ],
      "notes": [
        "Placement: AD/FD placement configs as variables."
      ],
      "code": [
        "variable \"app_shape\" {\n  type        = string\n  description = \"OCI compute shape for the app instances\"\n  default     = \"VM.Standard.E4.Flex\"\n}\n\nresource \"oci_core_instance\" \"app\" {\n  availability_domain = var.ad\n  compartment_id      = var.compartment_ocid\n  display_name        = \"${var.environment}-app01\"\n  shape               = var.app_shape\n\n  create_vnic_details {\n    subnet_id = var.app_subnet_id\n  }\n\n  source_details {\n    source_type = \"image\"\n    source_id   = var.app_image_ocid\n  }\n\n  metadata = {\n    user_data = base64encode(templatefile(\"${path.module}/cloud_init.tpl\", {\n      env = var.environment\n    }))\n  }\n}"
      ]
    },
    {
      "id": "oci-storage",
      "title": "Storage & Backup",
      "badge": "Storage",
      "tagline": "Object Storage, block volumes, and file storage give you evidence buckets, logs, and durable block storage for VMs and DBs.",
      "tables": [
        {
          "headers": [
            "Service",
            "Resources",
            "Key Options"
          ],
          "rows": [
            {
              "cells": [
                "Object Storage",
                "oci_objectstorage_bucket",
                "Storage tier, encryption, retention, event notifications."
              ],
              "resources": [
                "oci_objectstorage_bucket"
              ]
            },
            {
              "cells": [
                "Block Volumes",
                "oci_core_volume , oci_core_volume_attachment",
                "Size, performance, backup policy assignments."
              ],
              "resources": [
                "oci_core_volume",
                "oci_core_volume_attachment"
              ]
            },
            {
              "cells": [
                "File Storage",
                "oci_file_storage_file_system , oci_file_storage_mount_target",
                "Subnet, export options; often encapsulated in “shared storage” module."
              ],
              "resources": [
                "oci_file_storage_file_system",
                "oci_file_storage_mount_target"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "oci-database",
      "title": "Databases",
      "badge": "DB",
      "tagline": "Autonomous Database and DB Systems for OLTP/OLAP workloads; Terraform options capture sizing, licensing, and network placement.",
      "tables": [
        {
          "headers": [
            "Area",
            "Resources"
          ],
          "rows": [
            {
              "cells": [
                "Autonomous DB",
                "oci_database_autonomous_database"
              ],
              "resources": [
                "oci_database_autonomous_database"
              ]
            },
            {
              "cells": [
                "DB Systems",
                "oci_database_db_system, oci_database_db_home"
              ],
              "resources": [
                "oci_database_db_system",
                "oci_database_db_home"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "oci-security",
      "title": "Security & Observability",
      "badge": "Guardrails",
      "tagline": "Vault, KMS keys, logging, and events implement your baseline security posture.",
      "tables": [
        {
          "headers": [
            "Area",
            "Resources"
          ],
          "rows": [
            {
              "cells": [
                "Vault & Keys",
                "oci_kms_vault, oci_kms_key"
              ],
              "resources": [
                "oci_kms_vault",
                "oci_kms_key"
              ]
            },
            {
              "cells": [
                "Logging",
                "oci_logging_log, oci_logging_log_group, oci_logging_log_saved_search"
              ],
              "resources": [
                "oci_logging_log",
                "oci_logging_log_group",
                "oci_logging_log_saved_search"
              ]
            },
            {
              "cells": [
                "Events",
                "oci_events_rule, oci_events_filter"
              ],
              "resources": [
                "oci_events_rule",
                "oci_events_filter"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "oci-patterns",
      "title": "CCoE Patterns for Oracle Cloud",
      "badge": "Patterns",
      "tagline": "Typical OCI-focused patterns you can cross-link from your main Terraform Encyclopedia and CCoE decision logic.",
      "tables": [
        {
          "headers": [
            "Pattern",
            "Scope",
            "Terraform Options"
          ],
          "rows": [
            {
              "cells": [
                "Court Landing Zone in OCI",
                "Tenancy + compartments + VCN",
                "Compartment module ( for_each over courts), VCN module per court with cidrsubnet -driven subnets."
              ],
              "resources": [
                "for_each"
              ]
            },
            {
              "cells": [
                "Evidence Storage Enclave (OCI)",
                "Compartments + Object Storage",
                "“Evidence bucket” module: oci_objectstorage_bucket with encryption, retention, event rules, prevent_destroy ."
              ],
              "resources": [
                "oci_objectstorage_bucket",
                "prevent_destroy"
              ]
            },
            {
              "cells": [
                "Hybrid Court Connectivity",
                "On-prem ↔ OCI",
                "VCN + DRG + IPsec/FastConnect modules, network security defined with for_each over rule sets."
              ],
              "resources": [
                "for_each"
              ]
            }
          ]
        }
      ]
    }
  ]
};

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = { source = "hashicorp/google", version = ">= 5.0.0" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  networks = var.networks

  subnets_flat = flatten([
    for n in local.networks : [
      for s in n.subnets : {
        net_name = n.name
        name     = s.name
        cidr     = s.cidr
        role     = lower(s.role)
      }
    ]
  ])

  private_subnets = [for s in local.subnets_flat : s if s.role == "private"]
}

resource "google_compute_network" "vpc" {
  for_each                = { for n in local.networks : n.name => n }
  name                    = "${var.naming_prefix}-${each.key}"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  for_each = { for s in local.subnets_flat : "${s.net_name}::${s.name}" => s }

  name          = each.value.name
  ip_cidr_range = each.value.cidr
  region        = var.region
  network       = google_compute_network.vpc[each.value.net_name].id
}

# Cloud Router/NAT for private subnets (one per network if any private exists)
resource "google_compute_router" "router" {
  for_each = {
    for n in local.networks :
    n.name => n if length([for s in local.private_subnets : s if s.net_name == n.name]) > 0
  }
  name    = "${var.naming_prefix}-${each.key}-router"
  region  = var.region
  network = google_compute_network.vpc[each.key].id
}

resource "google_compute_router_nat" "nat" {
  for_each = google_compute_router.router

  name                               = "${var.naming_prefix}-${each.key}-nat"
  router                             = each.value.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"

  dynamic "subnetwork" {
    for_each = { for s in local.private_subnets : "${s.net_name}::${s.name}" => s if s.net_name == each.key }
    content {
      name                    = google_compute_subnetwork.subnet[subnetwork.key].id
      source_ip_ranges_to_nat  = ["ALL_IP_RANGES"]
    }
  }
}

# Baseline firewall: no inbound rules created (GCP default denies ingress unless rules exist)

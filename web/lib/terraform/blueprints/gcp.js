/**
 * Google Cloud Platform Terraform blueprints.
 *
 * Ported from the previous toolkit's TERRA_DEFS — the inputs and the HCL
 * templates are the originals, unchanged. What is new around them: the inputs
 * are typed, so a one-of choice is a dropdown rather than a text box, and every
 * resource type a blueprint emits is checked against the committed provider
 * catalog by the test suite.
 */

                                                                                                         
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.js';

const BLUEPRINTS                       = [
  {
    id: 'gcp_compute_instance',
    label: 'Compute Engine VM',
    description: 'Simple Compute Engine VM in an existing subnet.',
    inputs: [
            { id: "project_id", label: "Project ID", control: 'text', default: "app-project", hint: "GCP project ID" },
            {
              id: "region",
              label: "Region",
              control: 'select',
              options: GCP_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-central1",
              hint: "Region (also used by Assured Workloads)"
            },
            {
              id: "zone",
              label: "Zone",
              control: 'select',
              options: GCP_ZONES.map(z => ({ value: z, label: z })),
              default: "us-central1-a",
              hint: "Zone within region"
            },
            { id: "instance_name", label: "Instance name", control: 'text', default: "app-gce-01", hint: "GCE VM name" },
            { id: "machine_type", label: "Machine type", control: 'text', default: "e2-medium", hint: "e.g. e2-medium" },
            { id: "subnetwork", label: "Subnetwork", control: 'text', default: "default", hint: "Existing subnetwork name" }
          ],
    emits: [],
    build: (values                 , name        ) => ({
      files: {
        'main.tf': ((vals                , moduleName        )         => {
            const m = moduleName || "gcp_compute_instance";
            return `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = "${vals.project_id}"
  region  = "${vals.region}"
  zone    = "${vals.zone}"
}

resource "google_compute_instance" "this" {
  name         = "${vals.instance_name}"
  machine_type = "${vals.machine_type}"
  zone         = "${vals.zone}"

  boot_disk {
    initialize_params {
      image = "projects/debian-cloud/global/images/family/debian-11"
    }
  }

  network_interface {
    subnetwork = "${vals.subnetwork}"
    access_config {}
  }

  labels = {
    system      = "${m}"
    environment = "dev"
  }
}
`;
          })(values, name),
      },
    }),
  },
  {
    id: 'gcp_storage_bucket_secure',
    label: 'GCS bucket (secure)',
    description: 'Creates a private, versioned GCS bucket with uniform bucket-level access.',
    inputs: [
            { id: "project_id", label: "Project ID", control: 'text', default: "app-project", hint: "GCP project ID" },
            {
              id: "location",
              label: "Location",
              control: 'select',
              options: GCP_REGIONS.map(r => ({ value: r, label: r })),
              default: "us-central1",
              hint: "Regional bucket location"
            },
            { id: "bucket_name", label: "Bucket name", control: 'text', default: "app-gcs-archive", hint: "Globally unique" }
          ],
    emits: [],
    build: (values                 , name        ) => ({
      files: {
        'main.tf': ((vals                , moduleName        )         => {
            const m = moduleName || "gcp_storage_bucket_secure";
            return `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = "${vals.project_id}"
}

resource "google_storage_bucket" "this" {
  name          = "${vals.bucket_name}"
  location      = "${vals.location}"
  storage_class = "STANDARD"

  versioning {
    enabled = true
  }

  uniform_bucket_level_access = true

  labels = {
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

export const GCP_TERRAFORM                 = {
  target: 'google',
  label: 'Google Cloud Platform (GCP)',
  blueprints: BLUEPRINTS,
};

/**
 * Linux OS configuration Terraform blueprints.
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
    id: 'linux_null_remote_exec',
    label: 'Remote-exec on Linux host',
    description: 'Terraform null_resource with remote-exec provisioner for Linux (for bootstrapping configs).',
    inputs: [
            { id: "host", label: "Target host (IP / DNS)", control: 'text', default: "10.0.0.10", hint: "Linux host address" },
            { id: "user", label: "SSH username", control: 'text', default: "dbadmin", hint: "Remote user" },
            { id: "private_key_path", label: "Private key path", control: 'text', default: "~/.ssh/id_rsa", hint: "Path on Terraform runner" },
            { id: "inline_command", label: "Inline command", control: 'text', default: "sudo apt-get update && sudo apt-get -y upgrade", hint: "Bootstrap command" }
          ],
    emits: [],
    build: (values: BlueprintValues, name: string) => ({
      files: {
        'main.tf': ((vals: TemplateValues, moduleName: string): string => {
            const m = moduleName || "linux_null_remote_exec";
            return `terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

resource "null_resource" "linux_bootstrap" {
  provisioner "remote-exec" {
    inline = [
      "${vals.inline_command}"
    ]

    connection {
      type        = "ssh"
      host        = "${vals.host}"
      user        = "${vals.user}"
      private_key = file("${vals.private_key_path}")
    }
  }

  triggers = {
    system = "${m}"
  }
}
`;
          })(values, name),
      },
    }),
  },
];

export const LINUX_TERRAFORM: BlueprintGroup = {
  target: 'linux',
  label: 'Linux OS configuration',
  blueprints: BLUEPRINTS,
};

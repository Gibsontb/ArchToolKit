/**
 * Windows OS configuration Terraform blueprints.
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
    id: 'windows_null_winrm_exec',
    label: 'Remote-exec on Windows host (WinRM)',
    description: 'Terraform null_resource using WinRM to run a bootstrap PowerShell script on Windows.',
    inputs: [
            { id: "host", label: "Target host (IP / DNS)", control: 'text', default: "10.0.0.20", hint: "Windows host address" },
            { id: "user", label: "WinRM username", control: 'text', default: "COURT\\administrator", hint: "Domain or local user" },
            { id: "password", label: "WinRM password", control: 'text', default: "CHANGEME", hint: "Secure with env vars / cloud secrets" },
            { id: "inline_command", label: "PowerShell command", control: 'text', default: "Install-WindowsFeature -Name Web-Server", hint: "Bootstrap command" }
          ],
    emits: [],
    build: (values                 , name        ) => ({
      files: {
        'main.tf': ((vals                , moduleName        )         => {
            const m = moduleName || "windows_null_winrm_exec";
            return `terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
  }
}

resource "null_resource" "windows_bootstrap" {
  provisioner "remote-exec" {
    inline = [
      "powershell -Command \\"${vals.inline_command}\\""
    ]

    connection {
      type     = "winrm"
      host     = "${vals.host}"
      user     = "${vals.user}"
      password = "${vals.password}"
      https    = false
      insecure = true
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

export const WINDOWS_TERRAFORM                 = {
  target: 'windows',
  label: 'Windows OS configuration',
  blueprints: BLUEPRINTS,
};

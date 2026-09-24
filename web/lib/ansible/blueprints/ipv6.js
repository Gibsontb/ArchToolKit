/**
 * Dual stack for the cloud network playbooks.
 *
 * The checks and the "Dual stack (IPv6)" question are the Terraform
 * blueprints' own (terraform/blueprints/dual-stack.ts), so the two generators
 * ask the same thing and refuse the same values.
 *
 * What Ansible adds is arithmetic. AWS and OCI allocate a network's IPv6 /56
 * when it is created, and a subnet needs a /64 of it written out — Terraform
 * has cidrsubnet() for that, a playbook has the ansible.utils.ipsubnet
 * filter. A filter is not a module, so requirements.yml (derived from the
 * modules a play names) would not list its collection; this adds it.
 */

import { info } from '../../core/findings.js';
                                                      

export { dualStackInput, ipv4Range, ipv6Range, isOn, listOf, nthSlash64, sources } from '../../terraform/blueprints/dual-stack.js';

/** The n-th /64 of a registered network's IPv6 block, as the play computes it. */
export const slash64 = (block        , n        )         => `{{ ${block} | ansible.utils.ipsubnet(64, ${n}) }}`;

/** requirements.yml and a note for a play that uses the ansible.utils filters. */
export function withAnsibleUtils(out               )                {
  const requirements = out.files['requirements.yml'];
  const entry = [
    '- name: ansible.utils',
    '  # For the ipsubnet filter that carves the IPv6 /64s. It needs the netaddr',
    '  # Python library on the control node: pip install netaddr',
  ].join('\n');
  const files = {
    ...out.files,
    'requirements.yml': requirements
      ? `${requirements.replace(/\s*$/, '')}\n${entry}\n`
      : `---\ncollections:\n${entry}\n`,
  };
  return {
    files,
    findings: [
      ...out.findings,
      info(
        'ansible.blueprint.ipv6-needs-ansible-utils',
        'The IPv6 subnets are carved with the ansible.utils.ipsubnet filter, which needs the ansible.utils collection and the netaddr Python library on the control node.',
        { remediation: 'ansible-galaxy collection install -r requirements.yml; pip install netaddr' },
      ),
    ],
  };
}

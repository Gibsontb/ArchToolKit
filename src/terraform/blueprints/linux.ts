/**
 * Linux OS configuration Terraform blueprints.
 *
 * Terraform does not configure an operating system the way Ansible does, but
 * it owns the pieces around one, and those are what is offered here:
 *
 *  - Scenarios, written out by hand (linux-scenarios.ts): cloud-init for a new
 *    VM, an SSH key pair, an internal CA and server certificates, BIND records,
 *    an Ansible playbook run, bootstrap and hardening over SSH.
 *  - One blueprint per resource in each provider a Linux build uses —
 *    cloud-init, TLS, DNS (RFC 2136, for BIND), Ansible, local files, random,
 *    null — with every argument it takes (schema-blueprints.ts).
 *
 * Every scenario is run through `terraform validate` with the real providers
 * by tools/validate-terraform-blueprints.mjs.
 */

import type { Blueprint, BlueprintGroup } from '../../kit/blueprint.ts';
import { providerBlueprints, type OsProvider } from '../schema-blueprints.ts';
import { LINUX_SCENARIOS } from './linux-scenarios.ts';

const PROVIDERS: readonly OsProvider[] = ['cloudinit', 'tls', 'dns', 'ansible', 'local', 'random', 'null'];

/** BIND and most Linux DNS servers take TSIG-signed updates, not Kerberos. */
function tsigByDefault(blueprint: Blueprint): Blueprint {
  return {
    ...blueprint,
    inputs: blueprint.inputs.map((input) => (input.id === 'p.dns_auth' ? { ...input, default: 'tsig' } : input)),
  };
}

export const LINUX_TERRAFORM: BlueprintGroup = {
  target: 'linux',
  label: 'Linux OS configuration',
  blueprints: [...LINUX_SCENARIOS, ...PROVIDERS.flatMap((p) => providerBlueprints(p, 'lnx'))].map(tsigByDefault),
};

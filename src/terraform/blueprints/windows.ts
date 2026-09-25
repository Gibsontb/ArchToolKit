/**
 * Windows OS configuration Terraform blueprints.
 *
 * Terraform does not configure an operating system the way Ansible or DSC
 * does, but it owns the pieces around one, and those are what is offered here:
 *
 *  - Scenarios, written out by hand (windows-scenarios.ts): Active Directory
 *    OUs, groups, users, computers and GPOs; Windows DNS records over
 *    Kerberos; roles and features, domain join and IIS over WinRM; an Ansible
 *    playbook run against Windows hosts.
 *  - One blueprint per resource in each provider a Windows build uses —
 *    Active Directory, DNS (GSS-TSIG, for AD-integrated zones), TLS, Ansible,
 *    local files, random, null — with every argument it takes
 *    (schema-blueprints.ts).
 *
 * Every scenario is run through `terraform validate` with the real providers
 * by tools/validate-terraform-blueprints.mjs.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import { providerBlueprints, type OsProvider } from '../schema-blueprints.ts';
import { WINDOWS_SCENARIOS } from './windows-scenarios.ts';

const PROVIDERS: readonly OsProvider[] = ['ad', 'dns', 'tls', 'ansible', 'local', 'random', 'null'];

export const WINDOWS_TERRAFORM: BlueprintGroup = {
  target: 'windows',
  label: 'Windows OS configuration',
  blueprints: [...WINDOWS_SCENARIOS, ...PROVIDERS.flatMap((p) => providerBlueprints(p, 'win'))],
};

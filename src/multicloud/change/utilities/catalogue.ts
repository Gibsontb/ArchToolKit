/**
 * Add any resource or module (addendum A.9.2): the escape hatch that makes
 * the catalogue complete. Any Terraform blueprint the Terraform page has (a
 * per-resource blueprint of any catalogued resource, a module, a migration
 * or pattern blueprint) or any Ansible blueprint (a `mod_<fqcn>` module
 * blueprint of any indexed module, or a role) becomes a change bundle, with
 * the blueprint's own form values.
 *
 * Terraform is its own root module, so the rollback is `terraform destroy`.
 * An Ansible module with a `state` of `present` is rolled back by the same
 * play with `absent`; any other play's rollback is a step the README names.
 */

import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.ts';
import { defaultValues, type BlueprintValues } from '../../../kit/blueprint.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import {
  ALL_PLATFORMS, PLATFORM_LABELS, ansibleFromBlueprints, error, guestOs, info, landingZoneExample, opt, osInput, platformInput, platformOf, serverInput, val,
  type ChangeUtility, type Finding, type Platform, type UtilityResult,
} from './common.ts';

/** A form's values as `id = value` lines (or a JSON object). */
export function parseValues(text: string): Record<string, string> {
  const t = text.trim();
  if (!t) return {};
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const line of t.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const DEFAULT_TF: Readonly<Record<Platform, string>> = {
  aws: 'res_aws_s3_bucket', azure: 'res_azurerm_resource_group', google: 'res_google_storage_bucket', oci: 'res_oci_objectstorage_bucket', vmware: 'vsphere_vm_from_template',
};
const DEFAULT_VALUES: Readonly<Record<Platform, string>> = {
  aws: 'r.bucket = shop-exports-change', azure: 'r.name = shop-change-rg\nr.location = westeurope', google: 'r.name = shop-exports-change\nr.location = EU',
  oci: 'r.name = shop-exports-change\nr.namespace = var.os_namespace\nr.compartment_id = var.compartment_id', vmware: 'vm_name = tools-01',
};

export const addAny: ChangeUtility = {
  id: 'add-any',
  label: 'Add any resource or module',
  category: 'catalogue',
  description: 'Any Terraform blueprint (every catalogued resource, the modules, the migration and pattern blueprints) or any Ansible blueprint (every indexed module as mod_<collection>_<module>, and the roles), filled in with its own form, as a change bundle.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Terraform: terraform destroy of the change\'s module. Ansible: the same module with state absent when it was present; otherwise the step to undo by hand.',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'engine', label: 'Kind', control: 'select', default: 'terraform', options: [opt('terraform', 'A Terraform resource or module'), opt('ansible', 'An Ansible module or role')] },
    { id: 'blueprint', label: 'Blueprint', control: 'combo', default: '', options: [], hint: 'The Terraform or Ansible page\'s blueprint id (the pickers on those pages); blank: an example for the platform.' },
    { id: 'values', label: 'Values', control: 'textarea', default: '', hint: 'The blueprint\'s form: one "input id = value" per line, or a JSON object. Unset inputs keep the blueprint\'s defaults.' },
    { ...serverInput('Servers (Ansible)', 'app01'), hint: 'Space-separated.', showWhen: { input: 'engine', equals: ['ansible'] } },
    { ...osInput(), showWhen: { input: 'engine', equals: ['ansible'] } },
  ],
  build(values: BlueprintValues, ctx): UtilityResult {
    const platform = platformOf(values, addAny);
    const findings: Finding[] = [];
    const engine = val(values, 'engine', 'terraform');
    if (engine === 'ansible') {
      const id = val(values, 'blueprint', 'mod_ansible_builtin_lineinfile');
      const lookup = ctx.ansibleLookup ?? findAnsibleBlueprint;
      const bp = lookup(id);
      const given = parseValues(val(values, 'values', 'path = /etc/motd\nline = Managed by the platform team\nstate = present'));
      const servers = val(values, 'server', 'app01').split(/[\s,]+/).filter(Boolean);
      const windows = servers.length > 0 && guestOs(ctx.plan, servers[0]!, values) === 'windows';
      if (!bp) {
        findings.push(error('change.any.blueprint', `No Ansible blueprint ${id}.`, { path: 'blueprint' }));
        return { platform, target: id, route: 'ansible', summary: `Ansible ${id}`, files: {}, findings, apply: [], rollback: [], needs: [] };
      }
      const full = { ...defaultValues(bp), ...given };
      const files = ansibleFromBlueprints([{ blueprint: id, values: full }], servers.map((s) => ({ name: s, windows })), lookup, findings);
      const stateKey = 'r.state' in full ? 'r.state' : 'state';
      const reversible = String(full[stateKey] ?? '') === 'present';
      const main = Object.keys(files).find((f) => /^ansible\/[^/]+\.yml$/.test(f) && f !== 'ansible/site.yml' && f !== 'ansible/requirements.yml');
      const undo: Record<string, string> = reversible && main
        ? { 'ansible/undo.yml': `# The same play with state absent (rollback.sh).
---
- name: Undo ${bp.label.replace(/[:#]/g, ' ')}
  ansible.builtin.import_playbook: ${main.slice('ansible/'.length)}
  vars:
    ${stateKey.replace(/^r\./, '')}: absent
` }
        : {};
      return {
        platform, target: `${id} on ${servers.join(' ')}`, route: 'ansible', summary: `Ansible ${bp.label} on ${servers.join(', ')}`, files: { ...files, ...undo }, findings,
        apply: [{ kind: 'ansible', title: bp.label, playbook: 'site.yml' }],
        rollback: undo['ansible/undo.yml'] ? [{ kind: 'ansible', title: `${bp.label}: state absent`, playbook: 'undo.yml' }] : [{ kind: 'manual', title: 'Undo by hand', text: `the ${bp.label} play has no automatic inverse: undo what it did on ${servers.join(', ')}` }],
        needs: [],
      };
    }
    const id = val(values, 'blueprint') || DEFAULT_TF[platform];
    const lookup = ctx.lookup ?? findTerraformBlueprint;
    const bp = lookup(id);
    if (!bp) {
      findings.push(error('change.any.blueprint', `No Terraform blueprint ${id}.`, { path: 'blueprint' }));
      return { platform, target: id, route: 'terraform', summary: `Terraform ${id}`, files: {}, findings, apply: [], rollback: [], needs: [] };
    }
    const given = parseValues(val(values, 'values') || (val(values, 'blueprint') ? '' : DEFAULT_VALUES[platform]));
    const full: Record<string, string | number | boolean | undefined> = { ...defaultValues(bp), ...given };
    const usesLz = bp.inputs.some((i) => i.id === 'landing_zone_source');
    if (usesLz) full.landing_zone_source = 'variables';
    const r = bp.build(full, 'change');
    findings.push(...(r.findings ?? []));
    const files: Record<string, string> = {};
    for (const [f, t] of Object.entries(r.files)) files[`terraform/${f}`] = t;
    const lz = platform !== 'vmware' && (usesLz || Object.values(r.files).some((t) => t.includes('variable "landing_zone"')));
    if (lz) files['terraform/landing_zone.auto.tfvars.json.example'] = landingZoneExample(platform === 'azure' ? 'azure' : platform as 'aws');
    if (!Object.values(r.files).some((t) => t.includes('required_providers'))) findings.push(info('change.any.providers', `${id} writes no provider requirements; check terraform/ before applying.`));
    return {
      platform, target: bp.label, route: 'terraform', summary: `Terraform ${bp.label} (${id}) on ${PLATFORM_LABELS[platform]}`, files, findings,
      apply: [{ kind: 'terraform', title: `Apply ${bp.label}`, dir: 'terraform', lz }],
      rollback: [{ kind: 'terraform-destroy', title: `Destroy ${bp.label}`, dir: 'terraform', lz }],
      needs: [],
      notes: ['The values not set here keep the blueprint\'s defaults; terraform/README.md lists what the module asks for.'],
    };
  },
};

export const CATALOGUE_UTILITIES: readonly ChangeUtility[] = [addAny];

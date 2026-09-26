/**
 * The Ansible blueprints for application patterns (addendum A.4.10, WP-17)
 * and mig_source_tools (A.3.5).
 *
 * The same checks as the migration blueprints, for every blueprint and every
 * choice of its dropdowns: every module is in the catalog and every option is
 * one it documents; every YAML file reads back; every task that passes a
 * vault_ variable has no_log; no password or CHANGEME is written; every vault
 * variable a task reads is listed by name in group_vars. Then what the design
 * promises of each.
 */

import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { readYaml, type YamlData } from '../../../core/yaml-read.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../../../kit/blueprint.ts';
import { checkPlaybook } from '../../args-check.ts';
import { collectModules } from '../../from-plays.ts';
import { moduleNames } from '../../module-blueprints.ts';
import { buildSite } from '../../site.ts';
import { flatTasks } from '../../migration/roles/types.ts';
import { MIGRATION_GROUP } from '../migration/common.ts';
import { APP_GROUP } from './common.ts';
import { PATTERN_ANSIBLE_BLUEPRINTS, PATTERN_ANSIBLE_LINUX, PATTERN_ANSIBLE_WINDOWS } from './index.ts';
import { SAP_ROLES } from './sap-preconfigure.ts';

const IDS = ['mig_source_tools', 'app_fslogix', 'app_sap_preconfigure', 'infra_dhcp', 'infra_adcs', 'app_velero', 'app_mm2', 'app_iis_site'];
const KNOWN_MODULES = new Set(moduleNames());
const find = (id: string): Blueprint => PATTERN_ANSIBLE_BLUEPRINTS.find((b) => b.id === id) as Blueprint;

/** The defaults, then the defaults with each other choice of each dropdown. */
function variants(blueprint: Blueprint): { label: string; values: BlueprintValues }[] {
  const base = defaultValues(blueprint);
  const out = [{ label: blueprint.id, values: base }];
  for (const input of blueprint.inputs) {
    if (input.control !== 'select') continue;
    for (const option of input.options ?? []) {
      if (option.value === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${option.value}]`, values: { ...base, [input.id]: option.value } });
    }
  }
  return out;
}

const BUILDS = PATTERN_ANSIBLE_BLUEPRINTS.flatMap((b) => variants(b).map(({ label, values }) => ({ label, files: { ...b.build(values, 'check').files } })));

const build = (id: string, values: BlueprintValues = {}): Record<string, string> => {
  const b = find(id);
  return { ...b.build({ ...defaultValues(b), ...values }, 'check').files };
};

/** The vault names a build lists (group_vars/all/main.yml, or all.yml in older builds). */
const groupVarsOf = (files: Record<string, string>): string => files['group_vars/all/main.yml'] ?? files['group_vars/all.yml'] ?? '';

const isTaskFile = (name: string) => name === 'check.yml' || /^roles\/[^/]+\/(tasks|handlers)\/main\.yml$/.test(name);

function tasksOf(name: string, text: string): Record<string, YamlData>[] {
  const doc = readYaml(text).documents[0];
  if (!Array.isArray(doc)) return [];
  if (/(tasks|handlers)\/main\.yml$/.test(name)) return flatTasks(doc as never) as unknown as Record<string, YamlData>[];
  const out: Record<string, YamlData>[] = [];
  for (const play of doc) {
    if (play === null || typeof play !== 'object' || Array.isArray(play)) continue;
    for (const key of ['pre_tasks', 'tasks', 'post_tasks', 'handlers']) {
      const list = (play as Record<string, YamlData>)[key];
      if (Array.isArray(list)) out.push(...(flatTasks(list as never) as unknown as Record<string, YamlData>[]));
    }
  }
  return out;
}

const CONDITIONS = new Set(['when', 'that', 'failed_when', 'changed_when', 'name']);

function passesVault(task: Record<string, YamlData>): boolean {
  const walk = (value: YamlData, key?: string): boolean => {
    if (key && CONDITIONS.has(key)) return false;
    if (typeof value === 'string') return /\{\{[^}]*\bvault_\w+/.test(value);
    if (Array.isArray(value)) return value.some((v) => walk(v));
    if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => walk(v, k));
    return false;
  };
  return Object.entries(task).some(([k, v]) => !['block', 'rescue', 'always'].includes(k) && walk(v, k));
}

/** The role's tasks from a build, flattened. */
function roleTasks(files: Record<string, string>, role: string): Record<string, YamlData>[] {
  return tasksOf(`roles/${role}/tasks/main.yml`, files[`roles/${role}/tasks/main.yml`] as string);
}

describe('ansible/patterns: the blueprints', () => {
  it('has every blueprint of A.4.10 once, hosts first, in its group', () => {
    expect(PATTERN_ANSIBLE_BLUEPRINTS.map((b) => b.id)).toEqual(IDS);
    for (const b of PATTERN_ANSIBLE_BLUEPRINTS) {
      expect([b.id, b.group]).toEqual([b.id, b.id === 'mig_source_tools' ? MIGRATION_GROUP : APP_GROUP]);
      expect([b.id, b.inputs[0]?.id]).toEqual([b.id, 'hosts']);
    }
    expect(find('mig_source_tools').inputs[0]?.default).toBe('method_replicate');
  });

  it('puts each on the platform of the hosts it manages, the mixed one on both', () => {
    const linux = new Set(PATTERN_ANSIBLE_LINUX.map((b) => b.id));
    const windows = new Set(PATTERN_ANSIBLE_WINDOWS.map((b) => b.id));
    expect([...linux].sort()).toEqual(['app_mm2', 'app_sap_preconfigure', 'app_velero', 'mig_source_tools']);
    expect([...windows].sort()).toEqual(['app_fslogix', 'app_iis_site', 'infra_adcs', 'infra_dhcp', 'mig_source_tools']);
  });

  it('declares the inputs the migration site passes to mig_source_tools', () => {
    const ids = find('mig_source_tools').inputs.map((i) => i.id);
    expect(ids.includes('hosts') && ids.includes('platform')).toBe(true);
  });

  it('uses a dropdown for every input with a closed set (and every select has options)', () => {
    for (const b of PATTERN_ANSIBLE_BLUEPRINTS) {
      for (const input of b.inputs) {
        if (input.control === 'select') expect([b.id, input.id, (input.options ?? []).length > 1]).toEqual([b.id, input.id, true]);
        if (input.control === 'select') expect([b.id, input.id, (input.options ?? []).some((o) => o.value === String(input.default))]).toEqual([b.id, input.id, true]);
      }
    }
  });
});

describe('ansible/patterns: every build, every dropdown choice', () => {
  it('uses only modules in the committed catalog', () => {
    const unknown: string[] = [];
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!isTaskFile(name)) continue;
        for (const m of collectModules(readYaml(text).documents[0])) if (!KNOWN_MODULES.has(m)) unknown.push(`${label} ${name}: ${m}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('passes only options each module documents, with documented values', () => {
    const problems: string[] = [];
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!isTaskFile(name)) continue;
        const asPlaybook = name === 'check.yml' ? text : JSON.stringify([{ hosts: 'all', tasks: readYaml(text).documents[0] }]);
        for (const p of checkPlaybook(asPlaybook)) problems.push(`${label} ${name}: ${p.message}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('writes YAML that reads back, as a --- document with no tabs', () => {
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!/\.ya?ml$/.test(name)) continue;
        expect([label, name, text.split('\n').some((l) => l === '---'), /\t/.test(text)]).toEqual([label, name, true, false]);
        const content = text.split('\n').some((l) => l.trim() !== '' && !l.trim().startsWith('#') && l !== '---');
        expect([label, name, readYaml(text).documents.length]).toEqual([label, name, content ? 1 : 0]);
      }
    }
  });

  it('sets no_log on every task that passes a vault_ variable', () => {
    const exposed: string[] = [];
    let checked = 0;
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (!isTaskFile(name)) continue;
        for (const task of tasksOf(name, text)) {
          if (!passesVault(task)) continue;
          checked += 1;
          if (task.no_log !== true) exposed.push(`${label} ${name}: ${String(task.name)}`);
        }
      }
    }
    expect(exposed).toEqual([]);
    expect(checked > 20).toBe(true);
  });

  it('writes no password, key or CHANGEME, anywhere', () => {
    const literal = /^(?![ \t]*#).*?\b\w*(password|passwd|pwd|secret|access_?key)['"]?[ \t]*[:=][ \t]*(?!['"]?\{\{)(?!['"]?\$)(?!['"]?(true|false)\b)(?!['"]?[ \t]*$)['"]?[^\s'"{$]/im;
    const found: string[] = [];
    for (const { label, files } of BUILDS) {
      for (const [name, text] of Object.entries(files)) {
        if (/CHANGE_?ME/i.test(text)) found.push(`${label} ${name}: CHANGEME`);
        const m = literal.exec(text);
        if (m) found.push(`${label} ${name}: ${m[0].trim()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('lists every vault variable a task or template reads in group_vars, by name only', () => {
    for (const { label, files } of BUILDS) {
      const used = new Set(Object.entries(files).filter(([n]) => isTaskFile(n) || n.endsWith('defaults/main.yml')).flatMap(([, t]) => [...t.matchAll(/\bvault_\w+/g)].map((m) => m[0])));
      const listed = groupVarsOf(files);
      for (const v of used) expect([label, v, listed.includes(`# ${v}: set in vault.yml, not here`)]).toEqual([label, v, true]);
      expect([label, /vault_\w+:\s*['"]?[^\s#'"]/.test(listed.replace(/^#.*$/gm, ''))]).toEqual([label, false]);
    }
  });

  it('writes no footprint and only current product names', () => {
    for (const { label, files } of BUILDS) {
      const all = Object.values(files).join('\n');
      expect([label, /Generated by|\bAria\b|vRealize|ESXi/.test(all)]).toEqual([label, false]);
      expect([label, /Google Cloud(?! \(GCP\))(?! Managed Service)/.test(all.replace(/Google Cloud \(GCP\)/g, ''))]).toEqual([label, false]);
    }
  });

  it('writes the same role files whatever the answers, so a site writes each role once', () => {
    for (const b of PATTERN_ANSIBLE_BLUEPRINTS) {
      const [first, ...rest] = variants(b).map(({ values }) => b.build(values, 'x').files);
      for (const files of rest) {
        for (const [name, text] of Object.entries(first ?? {})) if (name.startsWith('roles/')) expect([b.id, name, files[name] === text]).toEqual([b.id, name, true]);
      }
    }
  });

  it('builds into a site beside the other items', () => {
    const lookup = (id: string) => PATTERN_ANSIBLE_BLUEPRINTS.find((b) => b.id === id);
    const items = PATTERN_ANSIBLE_BLUEPRINTS.map((b, i) => ({ id: `p${i}`, blueprintId: b.id, label: b.label, values: defaultValues(b) }));
    const site = buildSite(items, lookup, { playbookDir: 'playbooks' });
    expect(site.files['site.yml'] !== undefined).toBe(true);
    const requirements = site.files['requirements.yml'] as string;
    for (const c of ['ansible.windows', 'community.windows', 'microsoft.iis', 'community.sap_install']) expect([c, requirements.includes(`name: ${c}`)]).toEqual([c, true]);
    for (const role of ['source_tools', 'fslogix', 'sap_preconfigure', 'dhcp_migrate', 'adcs_migrate', 'velero', 'mm2', 'iis_site']) {
      expect([role, site.files[`roles/${role}/tasks/main.yml`] !== undefined]).toEqual([role, true]);
    }
  });
});

describe('ansible/patterns: what the design promises', () => {
  it('mig_source_tools removes each source platform\'s tools and the replication agents, and keeps the target\'s own', () => {
    const files = build('mig_source_tools');
    const defaults = files['roles/source_tools/defaults/main.yml'] as string;
    for (const s of ['open-vm-tools', 'hyperv-daemons', 'uninstall_ngt.py', 'xe-guest-utilities', 'VMware Tools', 'AWS Replication Agent*', 'Microsoft Azure Site Recovery Mobility Service*']) {
      expect([s, defaults.includes(s)]).toEqual([s, true]);
    }
    // open-vm-tools stays on vSphere, the Hyper-V daemons on Azure.
    const doc = readYaml(defaults).documents[0] as Record<string, YamlData>;
    const catalog = doc.source_tools_catalog as Record<string, YamlData>[];
    expect(catalog.find((t) => t.source === 'vmware')?.keep_on).toEqual(['vmware']);
    expect(catalog.find((t) => t.source === 'hyperv')?.keep_on).toEqual(['azure']);
    expect(String(doc.source_tools_selected)).toContain("rejectattr('keep_on', 'contains', cloud_platform)");
    const tasks = roleTasks(files, 'source_tools');
    expect(tasks.some((t) => String(t.name).includes('persistent-net'))).toBe(true);
    expect(tasks.some((t) => String(t.name).includes('ghost'))).toBe(true);
    expect(JSON.stringify(tasks)).toContain('dracut.conf.d');
    const play = (readYaml(files['check.yml'] as string).documents[0] as Record<string, YamlData>[])[0] as Record<string, YamlData>;
    expect(play.hosts).toBe('method_replicate');
    expect((play.vars as Record<string, YamlData>).mig_cloud_platform).toBe('aws');
  });

  it('app_fslogix sets the profile container registry values', () => {
    const defaults = build('app_fslogix', { locations: '\\\\files.example\\profiles' })['roles/fslogix/defaults/main.yml'] as string;
    for (const v of ['Enabled', 'VHDLocations', 'CCDLocations', 'VolumeType', 'SizeInMBs', 'ProfileType', 'DeleteLocalProfileWhenVHDShouldApply', 'FlipFlopProfileDirectoryName', 'PreventLoginWithTempProfile']) {
      expect([v, defaults.includes(`name: ${v}`)]).toEqual([v, true]);
    }
    const tasks = roleTasks(build('app_fslogix'), 'fslogix');
    expect(tasks.some((t) => 'ansible.windows.win_regedit' in t)).toBe(true);
  });

  it('app_sap_preconfigure includes the community.sap_install roles and asks for the collection', () => {
    const files = build('app_sap_preconfigure', { system: 'both' });
    expect(files['requirements.yml']).toContain('name: community.sap_install');
    const includes = roleTasks(files, 'sap_preconfigure')
      .map((t) => (t['ansible.builtin.include_role'] as Record<string, YamlData> | undefined)?.name)
      .filter(Boolean);
    expect(includes).toEqual([SAP_ROLES.general, SAP_ROLES.hana, SAP_ROLES.netweaver]);
  });

  it('infra_dhcp exports and imports every IPv4 and IPv6 scope with leases, and authorizes at cutover', () => {
    const tasks = roleTasks(build('infra_dhcp', { source_server: 'dhcp01' }), 'dhcp_migrate');
    const text = JSON.stringify(tasks);
    expect(text).toContain('Export-DhcpServer -File');
    expect(text).toContain('-Leases');
    expect(text).toContain('BackupPath');
    expect(text).toContain('Add-DhcpServerInDC');
    expect(text).toContain('Remove-DhcpServerInDC');
    expect(text).toContain('Get-DhcpServerv6Scope');
    expect(/-ScopeId|-Prefix /.test(text)).toBe(false);
  });

  it('infra_adcs keeps the CA name and key, logs no key material, and deletes the backup', () => {
    const tasks = roleTasks(build('infra_adcs', { source_server: 'ca01' }), 'adcs_migrate');
    const text = JSON.stringify(tasks);
    for (const s of ['Backup-CARoleService', 'Install-AdcsCertificationAuthority', 'CertFile', 'Restore-CARoleService', 'reg.exe', 'certutil.exe -crl', 'OverwriteExistingCAinDS']) {
      expect([s, text.includes(s)]).toEqual([s, true]);
    }
    for (const t of tasks) {
      const s = JSON.stringify(t);
      if ('block' in t) continue;
      if (/Backup-CARoleService|Install-AdcsCertificationAuthority|ca-backup\.zip/.test(s) && !/Delete the key backup/.test(String(t.name))) expect([t.name, t.no_log]).toEqual([t.name, true]);
    }
    expect(tasks.filter((t) => String(t.name).startsWith('Delete the key backup')).length).toBe(3);
  });

  it('app_velero writes the credentials 0600 without logging them, and lists only the chosen provider\'s secrets', () => {
    for (const [provider, secrets] of [
      ['aws', ['vault_velero_access_key_id', 'vault_velero_secret_access_key']],
      ['azure', ['vault_velero_azure_client_id', 'vault_velero_azure_client_secret']],
      ['gcp', ['vault_velero_gcp_credentials_json']],
    ] as const) {
      const files = build('app_velero', { provider });
      const listed = [...groupVarsOf(files).matchAll(/# (vault_\w+): set in vault/g)].map((m) => m[1]);
      expect([provider, listed]).toEqual([provider, [...secrets]]);
      const write = roleTasks(files, 'velero').find((t) => 'ansible.builtin.template' in t) as Record<string, YamlData>;
      expect([(write['ansible.builtin.template'] as Record<string, YamlData>).mode, write.no_log]).toEqual(['0600', true]);
    }
    const defaults = build('app_velero')['roles/velero/defaults/main.yml'] as string;
    expect(defaults).toContain("'--use-node-agent'");
    expect(defaults).toContain("'--use-volume-snapshots=false'");
  });

  it('app_mm2 writes mm2.properties 0600 with the credentials from the vault, and runs mm2.service', () => {
    const files = build('app_mm2', { source_bootstrap: '[2001:db8::10]:9092', target_bootstrap: 'b-1:9096' });
    const props = files['roles/mm2/templates/mm2.properties.j2'] as string;
    expect(props).toContain('source.bootstrap.servers = {{ mm2_source_bootstrap }}');
    expect(props).toContain('password="{{ vault_mm2_target_password }}"');
    expect(props).toContain('replication.factor = {{ mm2_replication_factor }}');
    const tasks = roleTasks(files, 'mm2');
    const write = tasks.find((t) => String(t.name).startsWith('Write mm2.properties')) as Record<string, YamlData>;
    expect([(write['ansible.builtin.template'] as Record<string, YamlData>).mode, write.no_log]).toEqual(['0600', true]);
    expect(files['roles/mm2/templates/mm2.service.j2']).toContain('connect-mirror-maker.sh /etc/mm2/mm2.properties');
    const start = tasks.find((t) => 'ansible.builtin.systemd_service' in t) as Record<string, YamlData>;
    expect(start['ansible.builtin.systemd_service']).toEqual({ name: 'mm2', enabled: true, state: 'started', daemon_reload: true });
    // Only the SASL sides need credentials.
    expect(groupVarsOf(files)).toContain('vault_mm2_target_password');
    expect(groupVarsOf(files)).not.toContain('vault_mm2_source_password');
  });

  it('app_iis_site binds on * (IPv4 and IPv6), by certificate thumbprint, and opens the ports', () => {
    const files = build('app_iis_site', { tls: 'store', thumbprint: 'AB12' });
    const defaults = readYaml(files['roles/iis_site/defaults/main.yml'] as string).documents[0] as Record<string, YamlData>;
    expect(String(defaults.iis_site_bindings)).toContain("'ip': '*'");
    expect(String(defaults.iis_site_bindings)).toContain("'certificate_hash': iis_site_thumbprint_bound");
    const tasks = roleTasks(files, 'iis_site');
    expect(tasks.some((t) => 'microsoft.iis.website' in t)).toBe(true);
    expect(tasks.some((t) => 'microsoft.iis.web_app_pool' in t)).toBe(true);
    expect(tasks.some((t) => 'community.windows.win_firewall_rule' in t)).toBe(true);
    const pfx = roleTasks(build('app_iis_site', { tls: 'pfx' }), 'iis_site').find((t) => String(t.name).startsWith('Import the PFX')) as Record<string, YamlData>;
    expect(pfx.no_log).toBe(true);
  });
});

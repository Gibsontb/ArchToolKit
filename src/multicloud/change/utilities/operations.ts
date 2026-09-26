/**
 * Operations utilities: a patch run (addendum A.9.2), restart a service and
 * install or remove a package (added).
 *
 * The patch run is Ansible in `serial` batches (a percentage of the
 * targets), with a check before and after each batch, an optional
 * load-balancer drain hook around it, and the reboot policy; or the
 * platform's own patching (AWS-RunPatchBaseline, az vm install-patches,
 * OS Config patch jobs). It can take snapshots first, which the rollback
 * names for a restore: installed patches are not uninstalled.
 */

import type { BlueprintValues } from '../../../kit/blueprint.ts';
import { code } from '../../plan/execute/lib-sh.ts';
import { appWorkloads, findApp } from '../../plan/apps/components.ts';
import type { Env, Plan, Tracker } from '../../plan/types.ts';
import {
  ALL_PLATFORMS, CLI_OF, OCI_COMPARTMENT_INPUT, PLATFORM_LABELS, RG_INPUT, VSPHERE_INPUTS, ZONE_INPUT, ansibleProject, envInput, error, guestOs, info, locateSh,
  numVal, opt, osInput, platformInput, platformOf, playbook, serverInput, val, warning, yq,
  type AnsibleHost, type ChangeStep, type ChangeUtility, type Finding, type Platform, type UtilityResult,
} from './common.ts';
import { snapshotSteps } from './protection.ts';

/** The targets: listed servers, an app's, an environment's or a wave's (from the plan's waves). */
function targets(values: BlueprintValues, plan: Plan | undefined, findings: Finding[], tracker?: Tracker): string[] {
  const scope = val(values, 'scope', 'servers');
  if (plan && scope === 'app') {
    const app = findApp(plan, val(values, 'app', 'shop'));
    if (app) return appWorkloads(plan, app).map((w) => w.name);
    findings.push(warning('change.patch.app', `No app ${val(values, 'app')} in the plan.`, { path: 'app' }));
  }
  if (plan && scope === 'env') return plan.workloads.filter((w) => w.env === (val(values, 'env', 'dev') as Env)).map((w) => w.name);
  if (plan && scope === 'wave') {
    const n = numVal(values, 'wave', 1);
    const ids = new Set(Object.values(tracker?.items ?? {}).filter((i) => i.wave === n).map((i) => i.item));
    const list = plan.workloads.filter((w) => ids.has(w.id)).map((w) => w.name);
    if (!list.length) findings.push(warning('change.patch.wave', `Wave ${n} has no servers in the tracker; list them instead.`, { path: 'wave' }));
    return list;
  }
  return val(values, 'server', 'app01').split(/[\s,]+/).filter(Boolean);
}

const SCOPE_INPUTS = [
  { id: 'scope', label: 'Target', control: 'select' as const, default: 'servers', options: [opt('servers', 'Servers'), opt('app', 'An app'), opt('env', 'An environment'), opt('wave', 'A wave')] },
  { ...serverInput('Servers', 'app01'), hint: 'Space-separated.', showWhen: { input: 'scope', equals: ['servers'] } },
  { id: 'app', label: 'Application', control: 'combo' as const, default: 'shop', from: 'app' as const, showWhen: { input: 'scope', equals: ['app'] } },
  { ...envInput('dev'), showWhen: { input: 'scope', equals: ['env'] } },
  { id: 'wave', label: 'Wave', control: 'number' as const, default: 1, min: 0, showWhen: { input: 'scope', equals: ['wave'] } },
];

function hostsOf(servers: readonly string[], plan: Plan | undefined, values: BlueprintValues): AnsibleHost[] {
  return servers.map((s) => ({ name: s, windows: guestOs(plan, s, values) === 'windows' }));
}

// ---------------------------------------------------------------------------
// Patch run
// ---------------------------------------------------------------------------

function patchPlaybook(values: BlueprintValues): string {
  const reboot = val(values, 'reboot', 'if-required');
  const cat = val(values, 'categories', 'security');
  const batch = Math.min(100, Math.max(1, numVal(values, 'batch_pct', 25)));
  const ports = val(values, 'check_ports', '').split(/[\s,]+/).filter((p) => /^\d+$/.test(p));
  const winCats = cat === 'all' ? "['*']" : cat === 'critical' ? "['CriticalUpdates', 'SecurityUpdates']" : "['SecurityUpdates']";
  const vars = `    change_reboot: ${reboot}
    change_categories: ${cat}
    change_drain_cmd: "{{ lookup('ansible.builtin.env', 'CHANGE_DRAIN_CMD') }}"
    change_check_ports:${ports.length ? `\n${ports.map((p) => `      - ${p}`).join('\n')}` : ' []'}`;
  return [
    '# Patch run: batches of the targets, a check before and after each batch, the reboot policy.',
    '# Applied by apply.sh (--dry-run: --check --diff). CHANGE_DRAIN_CMD, when set on the controller, is run as',
    '# "<cmd> drain <host>" before a host is patched and "<cmd> resume <host>" after it (a load-balancer drain).',
    '---',
    '- name: Patch run',
    '  hosts: atk_change',
    '  gather_facts: true',
    `  serial: "${batch}%"`,
    '  max_fail_percentage: 0',
    '  vars:',
    vars,
    '  pre_tasks:',
    '    - name: Check the host answers before patching',
    '      ansible.builtin.wait_for:',
    '        port: "{{ item }}"',
    '        host: "{{ ansible_host | default(inventory_hostname) }}"',
    '        timeout: 30',
    '      loop: "{{ change_check_ports }}"',
    '      delegate_to: localhost',
    '',
    '    - name: Drain the host from its load balancer',
    '      ansible.builtin.command: "{{ change_drain_cmd }} drain {{ inventory_hostname }}"',
    '      delegate_to: localhost',
    '      changed_when: true',
    '      when: change_drain_cmd | length > 0 and not ansible_check_mode',
    '',
    '  tasks:',
    '    - name: Install Windows updates',
    '      ansible.windows.win_updates:',
    `        category_names: ${winCats}`,
    `        reboot: ${reboot === 'never' ? 'false' : 'true'}`,
    '      when: ansible_facts.os_family == "Windows"',
    '',
    '    - name: Reboot Windows (always)',
    '      ansible.windows.win_reboot:',
    '      when: ansible_facts.os_family == "Windows" and change_reboot == "always"',
    '',
    '    - name: Update packages (RHEL family)',
    '      ansible.builtin.dnf:',
    "        name: '*'",
    '        state: latest',
    `        security: ${cat === 'all' ? 'false' : 'true'}`,
    '        update_only: true',
    '      become: true',
    '      when: ansible_facts.os_family == "RedHat"',
    '',
    '    - name: Update packages (Debian family)',
    '      ansible.builtin.apt:',
    '        update_cache: true',
    '        upgrade: safe',
    '      become: true',
    '      when: ansible_facts.os_family == "Debian" and change_categories == "all"',
    '',
    '    - name: Install security updates (Debian family)',
    '      ansible.builtin.command: unattended-upgrade -v',
    '      become: true',
    '      register: change_uu',
    "      changed_when: \"'Packages that will be upgraded' in change_uu.stdout\"",
    '      when: ansible_facts.os_family == "Debian" and change_categories != "all" and not ansible_check_mode',
    '',
    '    - name: Update packages (SUSE)',
    '      community.general.zypper:',
    "        name: '*'",
    '        state: latest',
    '        type: patch',
    '      become: true',
    '      when: ansible_facts.os_family == "Suse"',
    '',
    '    - name: Ask whether a reboot is needed (Linux)',
    '      ansible.builtin.shell: |',
    '        if command -v needs-restarting > /dev/null; then needs-restarting -r > /dev/null || echo yes',
    '        elif [ -f /var/run/reboot-required ]; then echo yes',
    '        elif command -v zypper > /dev/null; then zypper needs-rebooting > /dev/null || echo yes',
    '        fi',
    '      register: change_needs_reboot',
    '      changed_when: false',
    '      become: true',
    '      when: ansible_facts.os_family != "Windows"',
    '',
    '    - name: Reboot (Linux)',
    '      ansible.builtin.reboot:',
    '        reboot_timeout: 1800',
    '      become: true',
    '      when: >-',
    '        ansible_facts.os_family != "Windows" and',
    "        (change_reboot == 'always' or (change_reboot == 'if-required' and 'yes' in (change_needs_reboot.stdout | default(''))))",
    '',
    '  post_tasks:',
    '    - name: Check the host answers after patching',
    '      ansible.builtin.wait_for:',
    '        port: "{{ item }}"',
    '        host: "{{ ansible_host | default(inventory_hostname) }}"',
    '        timeout: 600',
    '      loop: "{{ change_check_ports }}"',
    '      delegate_to: localhost',
    '',
    '    - name: Put the host back in its load balancer',
    '      ansible.builtin.command: "{{ change_drain_cmd }} resume {{ inventory_hostname }}"',
    '      delegate_to: localhost',
    '      changed_when: true',
    '      when: change_drain_cmd | length > 0 and not ansible_check_mode',
    '',
  ].join('\n');
}

function nativePatchSh(platform: Platform, servers: readonly string[], values: BlueprintValues): string {
  const reboot = val(values, 'reboot', 'if-required');
  const cat = val(values, 'categories', 'security');
  const batch = numVal(values, 'batch_pct', 25);
  switch (platform) {
    case 'aws': {
      const rb = reboot === 'never' ? 'NoReboot' : 'RebootIfNeeded';
      return code`ids=()
${servers.map((s) => `${locateSh('aws', s, values)}\nids+=("$SID")`).join('\n')}
atk_run aws ssm send-command --document-name AWS-RunPatchBaseline --instance-ids "$\{ids[@]}" --parameters "Operation=Install,RebootOption=${rb}" --max-concurrency ${batch}% --max-errors 1 --comment "$CHANGE_ITEM" --output text`;
    }
    case 'azure': {
      const rb = reboot === 'never' ? 'Never' : reboot === 'always' ? 'Always' : 'IfRequired';
      const lin = cat === 'all' ? 'Critical Security Other' : 'Critical Security';
      const win = cat === 'all' ? 'Critical Security UpdateRollUp FeaturePack ServicePack Definition Tools Updates' : cat === 'critical' ? 'Critical Security' : 'Security';
      return servers.map((s) => code`${locateSh('azure', s, values)}
atk_run az vm install-patches --resource-group "$RG" --name "$SERVER" --maximum-duration PT2H --reboot-setting ${rb} --classifications-to-include-linux ${lin} --classifications-to-include-win ${win} --output none`).join('\n');
    }
    case 'google': {
      const rb = reboot === 'never' ? 'never' : reboot === 'always' ? 'always' : 'default';
      return code`names=()
${servers.map((s) => `${locateSh('google', s, values)}\nnames+=("zones/$ZONE/instances/$SERVER")`).join('\n')}
filter="$(IFS=,; printf '%s' "$\{names[*]}")"
atk_run gcloud compute os-config patch-jobs execute --instance-filter-names="$filter" --display-name="$CHANGE_ITEM" --reboot-config=${rb}${cat === 'all' ? '' : ' --yum-security --windows-classifications=SECURITY,CRITICAL'} --rollout-mode=zone-by-zone --rollout-disruption-budget-percent=${batch} --quiet`;
    }
    default:
      return '';
  }
}

export const patchRun: ChangeUtility = {
  id: 'patch-run',
  label: 'Patch run',
  category: 'operations',
  description: 'Patches servers in batches: Ansible (win_updates, dnf, apt, zypper) with serial batches, a port check before and after each batch, a load-balancer drain hook and the reboot policy; or the platform\'s own patching (AWS-RunPatchBaseline through Systems Manager, az vm install-patches, OS Config patch jobs). Optionally snapshots first.',
  platforms: ALL_PLATFORMS,
  risk: 'high',
  reversible: false,
  rollback: 'Installed patches are not uninstalled: with "snapshot first", rollback.sh names the snapshots to restore from (and deletes nothing).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    ...SCOPE_INPUTS,
    osInput(),
    { id: 'method', label: 'How', control: 'select', default: 'ansible', options: [opt('ansible', 'Ansible (every platform)'), opt('native', 'The platform\'s own patching (AWS, Azure, Google Cloud)')] },
    { id: 'categories', label: 'Updates', control: 'select', default: 'security', options: [opt('security', 'Security'), opt('critical', 'Critical and security'), opt('all', 'All')] },
    { id: 'reboot', label: 'Reboot', control: 'select', default: 'if-required', options: [opt('if-required', 'If required'), opt('always', 'Always'), opt('never', 'Never')] },
    { id: 'batch_pct', label: 'Batch %', control: 'number', default: 25, min: 1, max: 100, hint: 'The share of the targets patched at once.' },
    { id: 'check_ports', label: 'Check ports', control: 'text', default: '', hint: 'Ports that must answer before and after each batch, e.g. 443.' },
    { id: 'window_start', label: 'Window start (UTC, HH:MM)', control: 'text', default: '', hint: 'apply.sh refuses to start outside the window (exit 4) unless --gate-override is given.' },
    { id: 'window_end', label: 'Window end (UTC, HH:MM)', control: 'text', default: '' },
    { id: 'snapshot_first', label: 'Snapshot first', control: 'select', default: 'yes', options: [opt('yes', 'Yes'), opt('no', 'No')] },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT, ...VSPHERE_INPUTS,
  ],
  build(values, ctx): UtilityResult {
    const platform = platformOf(values, patchRun);
    const findings: Finding[] = [];
    const servers = targets(values, ctx.plan, findings, ctx.tracker);
    if (!servers.length) findings.push(error('change.patch.no-targets', 'No servers to patch.', { path: 'server' }));
    let method = val(values, 'method', 'ansible');
    if (method === 'native' && (platform === 'oci' || platform === 'vmware')) {
      findings.push(info('change.patch.native', `${PLATFORM_LABELS[platform]} has no native patching here (OCI OS Management Hub jobs need registered instances; VCF has none): Ansible is used.`));
      method = 'ansible';
    }
    const apply: ChangeStep[] = [];
    const rollback: ChangeStep[] = [];
    const files: Record<string, string> = {};
    const ws = val(values, 'window_start');
    const we = val(values, 'window_end');
    if (ws || we) {
      if (!/^\d\d:\d\d$/.test(ws) || !/^\d\d:\d\d$/.test(we)) findings.push(error('change.patch.window', 'The window is two times, HH:MM (UTC).', { path: 'window_start' }));
      else {
        const [a, b] = [ws.replace(':', ''), we.replace(':', '')];
        apply.push({
          kind: 'sh', title: `Check the window ${ws}-${we} UTC`,
          body: `now="$(date -u +%H%M)"
inside=0
if [[ "${a}" < "${b}" ]]; then
  if [[ ! "$now" < "${a}" && "$now" < "${b}" ]]; then inside=1; fi
else
  if [[ ! "$now" < "${a}" || "$now" < "${b}" ]]; then inside=1; fi
fi
if (( ! inside )); then
  if [[ -n "$ATK_GATE_OVERRIDE" ]]; then atk_log "outside the window, overridden: $ATK_GATE_OVERRIDE"; else change_stop 4 "outside the window ${ws}-${we} UTC (pass --gate-override \\"<reason>\\" to go anyway)"; fi
fi`,
        });
      }
    }
    if (val(values, 'snapshot_first', 'yes') === 'yes' && servers.length) {
      const snap = snapshotSteps(platform, servers, values);
      Object.assign(files, snap.files);
      apply.push(...snap.take);
      rollback.push({ kind: 'manual', title: 'Restore from the snapshots', text: `restore the servers that must be undone from the snapshots this change took (tagged atk_change=<change id>); delete them later with the Snapshot now utility's rollback` });
    } else {
      rollback.push({ kind: 'manual', title: 'Undo by hand', text: 'patches are not uninstalled: restore the servers that must be undone from their backups' });
    }
    if (method === 'native') {
      apply.push({ kind: 'sh', title: `Patch with ${platform === 'aws' ? 'Systems Manager (AWS-RunPatchBaseline)' : platform === 'azure' ? 'az vm install-patches' : 'OS Config patch jobs'}`, body: nativePatchSh(platform, servers, values) });
    } else {
      Object.assign(files, ansibleProject(hostsOf(servers, ctx.plan, values), { 'patch.yml': patchPlaybook(values) }, ['ansible.windows', 'community.general']));
      apply.push({ kind: 'ansible', title: 'Patch in batches', playbook: 'patch.yml' });
    }
    return {
      platform, target: servers.length > 3 ? `${servers.length} servers` : servers.join(' '), route: method === 'native' ? 'cli' : 'ansible',
      summary: `Patch run (${val(values, 'categories', 'security')}, reboot ${val(values, 'reboot', 'if-required')}, ${numVal(values, 'batch_pct', 25)}% at a time) on ${servers.length} server(s)`,
      files, findings, apply, rollback, needs: method === 'native' ? [CLI_OF[platform]] : [],
      notes: ['CHANGE_DRAIN_CMD: a command on the controller taking "drain <host>" and "resume <host>" (for example a wrapper around the load balancer\'s CLI) to take each host out of rotation while it is patched.'],
    };
  },
};

// ---------------------------------------------------------------------------
// Restart a service (added)
// ---------------------------------------------------------------------------

export const restartService: ChangeUtility = {
  id: 'restart-service',
  label: 'Restart a service',
  category: 'operations',
  description: 'Starts, stops, restarts or reloads a service on servers (systemd or Windows services), one server at a time.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'A stop is undone by a start and a start by a stop; a restart or reload leaves the service started.',
  source: 'added',
  inputs: [
    platformInput(ALL_PLATFORMS),
    ...SCOPE_INPUTS,
    osInput(),
    { id: 'service', label: 'Service', control: 'text', default: 'nginx' },
    { id: 'action', label: 'Action', control: 'select', default: 'restarted', options: [opt('restarted', 'Restart'), opt('reloaded', 'Reload (Linux)'), opt('stopped', 'Stop'), opt('started', 'Start')] },
  ],
  build(values, ctx): UtilityResult {
    const platform = platformOf(values, restartService);
    const findings: Finding[] = [];
    const servers = targets(values, ctx.plan, findings, ctx.tracker);
    const service = val(values, 'service', 'nginx');
    const action = val(values, 'action', 'restarted');
    const back = action === 'stopped' ? 'started' : action === 'started' ? 'stopped' : 'started';
    const book = (state: string): string => playbook(`Service ${service}: ${state}`, 'atk_change', `    - name: Service ${service} ${state} (Linux)
      ansible.builtin.service:
        name: "{{ change_service }}"
        state: ${state}
      become: true
      when: ansible_facts.os_family != "Windows"

    - name: Service ${service} ${state} (Windows)
      ansible.windows.win_service:
        name: "{{ change_service }}"
        state: ${state === 'reloaded' ? 'restarted' : state}
      when: ansible_facts.os_family == "Windows"
`, { serial: '1', vars: `    change_service: ${yq(service)}` });
    const files = ansibleProject(hostsOf(servers, ctx.plan, values), { 'service.yml': book(action), 'undo.yml': book(back) }, ['ansible.windows']);
    return {
      platform, target: `${service} on ${servers.join(' ')}`, route: 'ansible', summary: `${action.replace(/ed$/, '')} ${service} on ${servers.join(', ')}`, files, findings,
      apply: [{ kind: 'ansible', title: `${service}: ${action}`, playbook: 'service.yml' }],
      rollback: [{ kind: 'ansible', title: `${service}: ${back}`, playbook: 'undo.yml' }],
      needs: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Install or remove a package (added)
// ---------------------------------------------------------------------------

export const installPackage: ChangeUtility = {
  id: 'install-package',
  label: 'Install or remove software',
  category: 'operations',
  description: 'Installs or removes packages: the OS package manager on Linux (dnf, apt, zypper through ansible.builtin.package), Windows features (win_feature) or Chocolatey packages on Windows.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Removes what was installed (or installs what was removed); the version before an upgrade is not put back.',
  source: 'added',
  inputs: [
    platformInput(ALL_PLATFORMS),
    ...SCOPE_INPUTS,
    osInput(),
    { id: 'packages', label: 'Packages / features', control: 'text', default: 'htop', hint: 'Space-separated names.' },
    { id: 'state', label: 'Action', control: 'select', default: 'present', options: [opt('present', 'Install'), opt('absent', 'Remove')] },
    { id: 'windows_source', label: 'Windows source', control: 'select', default: 'feature', options: [opt('feature', 'Windows features (win_feature)'), opt('chocolatey', 'Chocolatey packages')], showWhen: { input: 'os', equals: ['windows'] } },
  ],
  build(values, ctx): UtilityResult {
    const platform = platformOf(values, installPackage);
    const findings: Finding[] = [];
    const servers = targets(values, ctx.plan, findings, ctx.tracker);
    const pkgs = val(values, 'packages', 'htop').split(/[\s,]+/).filter(Boolean);
    if (!pkgs.length) findings.push(error('change.package.none', 'Name at least one package.', { path: 'packages' }));
    const state = val(values, 'state', 'present');
    const other = state === 'present' ? 'absent' : 'present';
    const choco = val(values, 'windows_source', 'feature') === 'chocolatey';
    const book = (st: string): string => playbook(`Packages ${st}: ${pkgs.join(' ')}`, 'atk_change', `    - name: Packages ${st} (Linux)
      ansible.builtin.package:
        name: "{{ change_packages }}"
        state: ${st}
      become: true
      when: ansible_facts.os_family != "Windows"

    - name: ${choco ? 'Chocolatey packages' : 'Windows features'} ${st}
      ${choco ? 'chocolatey.chocolatey.win_chocolatey' : 'ansible.windows.win_feature'}:
        name: "{{ change_packages }}"
        state: ${st}
      when: ansible_facts.os_family == "Windows"
`, { vars: `    change_packages:\n${pkgs.map((p) => `      - ${yq(p)}`).join('\n')}` });
    const files = ansibleProject(hostsOf(servers, ctx.plan, values), { 'packages.yml': book(state), 'undo.yml': book(other) }, ['ansible.windows', ...(choco ? ['chocolatey.chocolatey'] : [])]);
    return {
      platform, target: servers.join(' '), route: 'ansible', summary: `${state === 'present' ? 'Install' : 'Remove'} ${pkgs.join(', ')} on ${servers.join(', ')}`, files, findings,
      apply: [{ kind: 'ansible', title: `${state === 'present' ? 'Install' : 'Remove'} ${pkgs.join(' ')}`, playbook: 'packages.yml' }],
      rollback: [{ kind: 'ansible', title: `${other === 'present' ? 'Install' : 'Remove'} ${pkgs.join(' ')} again`, playbook: 'undo.yml' }],
      needs: [],
    };
  },
};

export const OPERATIONS_UTILITIES: readonly ChangeUtility[] = [patchRun, restartService, installPackage];

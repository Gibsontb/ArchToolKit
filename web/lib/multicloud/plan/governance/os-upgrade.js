/**
 * OS end-of-support and the upgrade plays (addendum A.10.16).
 *
 * Each workload's Upgrade choice:
 *
 * | Option           | Generated                                                    |
 * |------------------|--------------------------------------------------------------|
 * | none             | nothing (an EOL warning when the OS is past support)          |
 * | before-move      | the in-place play for its family (below)                      |
 * | during-move      | Azure Migrate's `-OsUpgradeVersion` (Windows Server to Azure) |
 * | rebuild          | the method becomes rebuild                                    |
 * | extended-support | a finding with the ESU / ELS / ESM dates                      |
 * | accept-risk      | a risk entry for the RAID log                                 |
 *
 * The in-place plays apply by default (the house rule) and stop on anything
 * that would make the upgrade unsafe:
 *  - `os-upgrade-windows.yml`: setup.exe /auto upgrade from `os_media_path`,
 *    only along Microsoft's supported paths (as data, verify);
 *  - `os-upgrade-rhel.yml`: **Leapp**, one major version at a time:
 *    `leapp preupgrade`, the report read for inhibitors — the play **fails**
 *    if there is any — then `leapp upgrade` and a reboot; Oracle Linux the same
 *    with `--oraclelinux`;
 *  - `os-upgrade-ubuntu.yml`: `do-release-upgrade -f DistUpgradeViewNonInteractive`;
 *  - `os-upgrade-sles.yml`: `zypper migration` (verify the non-interactive flags).
 */

import { renderYaml,                } from '../../../ansible/yaml.js';
import { error, info, warning,              } from '../../../core/findings.js';
import { osInfo, supportStatus } from '../os.js';
                                                                             

export const WINDOWS_UPGRADE_SOURCE = 'https://learn.microsoft.com/en-us/windows-server/get-started/upgrade-overview';
export const LEAPP_SOURCE = 'https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/upgrading_from_rhel_8_to_rhel_9/index';

/**
 * In-place upgrade paths for Windows Server, from Microsoft's upgrade overview
 * (verify: Microsoft revises the matrix with each release).
 */
export const WINDOWS_UPGRADE_PATHS                                                   = Object.freeze({
  'win-2012': ['win-2012r2', 'win-2016'],
  'win-2012r2': ['win-2016', 'win-2019', 'win-2025'],
  'win-2016': ['win-2019', 'win-2022', 'win-2025'],
  'win-2019': ['win-2022', 'win-2025'],
  'win-2022': ['win-2025'],
});

/** Leapp and do-release-upgrade move one major / LTS release per run. */
const NEXT_MAJOR                                        = Object.freeze({
  'rhel-7': 'rhel-8', 'rhel-8': 'rhel-9', 'rhel-9': 'rhel-10',
  'ol-7': 'ol-8', 'ol-8': 'ol-9', 'ol-9': 'ol-10',
  'ubuntu-16.04': 'ubuntu-18.04', 'ubuntu-18.04': 'ubuntu-20.04', 'ubuntu-20.04': 'ubuntu-22.04', 'ubuntu-22.04': 'ubuntu-24.04',
  'sles-12': 'sles-15', 'sles-15': 'sles-16',
});

                                                                                  

/** The play for an OS, or undefined when there is no supported in-place tool. */
export function upgradePlayFor(os      )                          {
  if (os.startsWith('win-')) return 'windows';
  if (os.startsWith('rhel-')) return 'rhel';
  if (os.startsWith('ol-')) return 'oracle-linux';
  if (os.startsWith('ubuntu-')) return 'ubuntu';
  if (os.startsWith('sles-')) return 'sles';
  return undefined;
}

/** The target of one in-place run: Windows as far as the path allows toward upgradeTo; others one major. */
export function inPlaceTarget(os      )                   {
  if (os.startsWith('win-')) {
    const paths = WINDOWS_UPGRADE_PATHS[os] ?? [];
    const wanted = osInfo(os).upgradeTo;
    return wanted && paths.includes(wanted) ? wanted : paths[paths.length - 1];
  }
  return NEXT_MAJOR[os];
}

                             
                            
                    
                                                     
                              
                         
                              
                                                                                         
                         
                        
 

/**
 * The default choice (A.10.16): rebuild when the image is unavailable and the
 * method was already rebuild; otherwise none (with an EOL warning later).
 */
export function defaultUpgrade(w          , plan                        , imageAvailable                           = () => true)            {
  return !imageAvailable(w) && plan.decision?.items[w.id]?.method === 'rebuild' ? 'rebuild' : 'none';
}

function runsTo(from      , to                  )         {
  if (!to) return 0;
  let n = 0;
  let at                   = from;
  while (at && at !== to && n < 6) {
    at = inPlaceTarget(at);
    n += 1;
  }
  return at === to ? n : 0;
}

/** Every workload's upgrade row, with findings (EOL, unsupported paths, extended-support dates). */
export function upgradePlan(plan      , on        , options                                                         = {})                                              {
  const rows               = [];
  const findings            = [];
  plan.workloads.forEach((w, i) => {
    const path = `workloads[${i}].upgrade`;
    const info0 = osInfo(w.os);
    const support = supportStatus(w.os, on);
    const upgrade = w.upgrade ?? defaultUpgrade(w, plan, options.imageAvailable);
    const target = inPlaceTarget(w.os);
    const play = upgradePlayFor(w.os);
    let note = '';
    switch (upgrade) {
      case 'none':
        if (support === 'end-of-life') findings.push(warning('os.eol', `${w.name}: ${info0.label} is past the end of support on ${on}, and no upgrade is planned.`, { path, source: info0.source, remediation: 'Choose before-move, rebuild, extended-support or accept-risk.' }));
        note = support === 'end-of-life' ? 'past end of support' : 'no upgrade';
        break;
      case 'before-move':
        if (!play || !target) {
          findings.push(error('os.upgrade.no-path', `${w.name}: no supported in-place upgrade for ${info0.label}.`, { path, remediation: w.os.startsWith('centos') || w.os.startsWith('rocky') || w.os.startsWith('alma') ? 'Convert to RHEL first (convert2rhel) or rebuild; Leapp upgrades RHEL and Oracle Linux (ELevate for Alma / Rocky is a community project — verify).' : 'Rebuild on the new OS instead.' }));
          note = 'no in-place path';
        } else {
          const runs = runsTo(w.os, info0.upgradeTo);
          note = `${info0.label} → ${osInfo(target).label}${runs > 1 ? ` (${runs} runs to reach ${osInfo(info0.upgradeTo ).label})` : ''}`;
          if (runs > 1) findings.push(info('os.upgrade.multi-step', `${w.name}: reaching ${osInfo(info0.upgradeTo ).label} takes ${runs} in-place runs, one major version each.`, { path, source: play === 'windows' ? WINDOWS_UPGRADE_SOURCE : LEAPP_SOURCE }));
          rows.push({ workload: w.name, os: w.os, support, upgrade, target, play, runs: Math.max(1, runs), note });
          return;
        }
        break;
      case 'during-move': {
        const toAzure = plan.decision?.items[w.id]?.chosen?.platform === 'azure';
        if (!w.os.startsWith('win-') || !toAzure) {
          findings.push(error('os.upgrade.during-move', `${w.name}: upgrade during the move is Azure Migrate's, for Windows Server moving to Azure only.`, { path, source: 'https://learn.microsoft.com/en-us/powershell/module/az.migrate/start-azmigrateservermigration' }));
        }
        note = 'Start-AzMigrateTestMigration / Start-AzMigrateServerMigration -OsUpgradeVersion (verify the parameter on your Az.Migrate version)';
        break;
      }
      case 'rebuild':
        note = `rebuilt on ${info0.upgradeTo ? osInfo(info0.upgradeTo).label : 'a supported OS'}`;
        break;
      case 'extended-support':
        note = info0.endOfExtendedSupport ? `extended support to ${info0.endOfExtendedSupport}` : 'no extended-support date in the catalogue';
        findings.push((info0.endOfExtendedSupport && on > info0.endOfExtendedSupport ? error : info)('os.extended-support', `${w.name}: ${info0.label} ${note}.`, { path, source: info0.source }));
        break;
      case 'accept-risk':
        note = 'risk accepted: see the RAID log';
        break;
    }
    rows.push({ workload: w.name, os: w.os, support, upgrade, ...(target ? { target } : {}), ...(play ? { play } : {}), note });
  });
  return { rows, findings };
}

/** RAID risks for the accept-risk choices (suggested, never added on their own). */
export function upgradeRisks(plan      , on        )             {
  return plan.workloads
    .filter((w) => w.upgrade === 'accept-risk')
    .map((w, i) => ({
      id: `R-OS-${String(i + 1).padStart(3, '0')}`,
      risk: `${w.name} runs ${osInfo(w.os).label}, ${supportStatus(w.os, on) === 'end-of-life' ? 'past the end of support' : 'near the end of support'}, and is moved without an upgrade.`,
      app: w.app,
      probability: 3, impact: w.criticality === 'tier0' || w.criticality === 'tier1' ? 4 : 3,
      response: 'accept', status: 'open',
      mitigation: 'Isolate the server, restrict access, monitor closely; plan the upgrade or rebuild after the move.',
    }));
}

// ---------------------------------------------------------------------------
// The plays
// ---------------------------------------------------------------------------

/** The Jinja expression the Leapp play uses to list inhibitors (flags or groups, by Leapp version). */
export const LEAPP_INHIBITOR_EXPR = "(leapp_entries | selectattr('flags', 'defined') | selectattr('flags', 'contains', 'inhibitor') | list)"
  + " + (leapp_entries | selectattr('groups', 'defined') | selectattr('groups', 'contains', 'inhibitor') | list)";

/**
 * The same selection in TypeScript, for tests and for reading a
 * leapp-report.json the user brings back: entries whose `flags` (older Leapp)
 * or `groups` (newer Leapp) contain "inhibitor".
 */
export function leappInhibitors(report         )           {
  const entries = ((report ?? {})                           ).entries ?? [];
  const titles = new Set        ();
  for (const e of entries) {
    const x = e                                                          ;
    const hit = (Array.isArray(x.flags) && x.flags.includes('inhibitor')) || (Array.isArray(x.groups) && x.groups.includes('inhibitor'));
    if (hit) titles.add(typeof x.title === 'string' ? x.title : '(untitled)');
  }
  return [...titles];
}

function leappPlay(oracle         )            {
  return [{
    name: `In-place ${oracle ? 'Oracle Linux' : 'RHEL'} upgrade with Leapp (one major version)`,
    hosts: `{{ upgrade_hosts | default('os_upgrade_${oracle ? 'oracle_linux' : 'rhel'}') }}`,
    become: true,
    serial: 1,
    vars: {
      leapp_report_path: '/var/log/leapp/leapp-report.json',
      leapp_args: oracle ? '--oraclelinux' : '',
      leapp_target: '',
    },
    tasks: [
      { name: 'Install Leapp', 'ansible.builtin.package': { name: ['leapp-upgrade'], state: 'present' } },
      {
        name: 'Pre-upgrade check',
        'ansible.builtin.command': "leapp preupgrade {{ leapp_args }} {{ ('--target ' ~ leapp_target) if leapp_target else '' }}",
        register: 'leapp_pre', changed_when: false, failed_when: false,
      },
      { name: 'Read the pre-upgrade report', 'ansible.builtin.slurp': { src: '{{ leapp_report_path }}' }, register: 'leapp_report_raw' },
      {
        name: 'List the inhibitors',
        'ansible.builtin.set_fact': {
          leapp_entries: "{{ (leapp_report_raw.content | b64decode | from_json).entries | default([]) }}",
        },
      },
      { name: 'Collect inhibitor titles', 'ansible.builtin.set_fact': { leapp_inhibitors: `{{ (${LEAPP_INHIBITOR_EXPR}) | map(attribute='title') | unique | list }}` } },
      {
        name: 'Stop when Leapp reports inhibitors',
        'ansible.builtin.fail': { msg: "Leapp found {{ leapp_inhibitors | length }} inhibitor(s): {{ leapp_inhibitors | join('; ') }}. Fix them (see /var/log/leapp/leapp-report.txt) and run again." },
        when: 'leapp_inhibitors | length > 0',
      },
      {
        name: 'Stop when the pre-upgrade check itself failed',
        'ansible.builtin.fail': { msg: 'leapp preupgrade exited {{ leapp_pre.rc }} without inhibitors: {{ leapp_pre.stderr | default("") }}' },
        when: 'leapp_pre.rc != 0',
      },
      { name: 'Upgrade', 'ansible.builtin.command': "leapp upgrade {{ leapp_args }} {{ ('--target ' ~ leapp_target) if leapp_target else '' }}", changed_when: true },
      { name: 'Reboot into the upgrade environment', 'ansible.builtin.reboot': { reboot_timeout: 7200 } },
      { name: 'Read the new version', 'ansible.builtin.setup': { gather_subset: ['distribution'] } },
      {
        name: 'Confirm the major version moved',
        'ansible.builtin.assert': {
          that: ["ansible_facts['distribution_major_version'] | int == (upgrade_to_major | default(ansible_facts['distribution_major_version']) | int)"],
          fail_msg: "Still on {{ ansible_facts['distribution_version'] }} after the upgrade; check /var/log/leapp/leapp-upgrade.log.",
        },
      },
    ],
  }];
}

function windowsPlay()            {
  return [{
    name: 'In-place Windows Server upgrade from media',
    hosts: "{{ upgrade_hosts | default('os_upgrade_windows') }}",
    serial: 1,
    vars: { os_image_index: 2 },
    tasks: [
      {
        name: 'Media path and target are set',
        'ansible.builtin.assert': { that: ['os_media_path is defined', 'os_media_path | length > 0', 'upgrade_to is defined'], fail_msg: 'Set os_media_path (the folder holding setup.exe) and upgrade_to for this host.' },
      },
      { name: 'Check that setup.exe is there', 'ansible.windows.win_stat': { path: '{{ os_media_path }}\\setup.exe' }, register: 'setup_exe' },
      { name: 'Stop when the media is missing', 'ansible.builtin.fail': { msg: 'No setup.exe under {{ os_media_path }}.' }, when: 'not setup_exe.stat.exists' },
      {
        name: 'Run the upgrade (Setup restarts the server itself)',
        'ansible.windows.win_command': '"{{ os_media_path }}\\setup.exe" /auto upgrade /quiet /imageindex {{ os_image_index }} /dynamicupdate disable /compat ignorewarning',
        async: 14400, poll: 0,
      },
      { name: 'Wait for the server to come back', 'ansible.builtin.wait_for_connection': { delay: 600, timeout: 14400, sleep: 60 } },
      {
        name: 'Wait until the new version reports',
        'ansible.windows.win_shell': '(Get-CimInstance Win32_OperatingSystem).Caption',
        register: 'os_caption', until: "upgrade_caption_match in os_caption.stdout", retries: 60, delay: 120, changed_when: false,
        vars: { upgrade_caption_match: "{{ upgrade_to_caption | default('Windows Server') }}" },
      },
    ],
  }];
}

function ubuntuPlay()            {
  return [{
    name: 'In-place Ubuntu LTS upgrade (one LTS release)',
    hosts: "{{ upgrade_hosts | default('os_upgrade_ubuntu') }}",
    become: true,
    serial: 1,
    tasks: [
      { name: 'Bring the current release up to date', 'ansible.builtin.apt': { update_cache: true, upgrade: 'dist' } },
      { name: 'Release upgrader present', 'ansible.builtin.apt': { name: 'ubuntu-release-upgrader-core', state: 'present' } },
      { name: 'Is a reboot pending', 'ansible.builtin.stat': { path: '/var/run/reboot-required' }, register: 'reboot_required' },
      { name: 'Reboot if the updates need it', 'ansible.builtin.reboot': { reboot_timeout: 3600 }, when: 'reboot_required.stat.exists' },
      { name: 'Upgrade to the next LTS', 'ansible.builtin.command': 'do-release-upgrade -f DistUpgradeViewNonInteractive', changed_when: true },
      { name: 'Reboot into the new release', 'ansible.builtin.reboot': { reboot_timeout: 3600 } },
    ],
  }];
}

function slesPlay()            {
  return [{
    name: 'SUSE Linux Enterprise Server migration (verify the flags for your service pack)',
    hosts: "{{ upgrade_hosts | default('os_upgrade_sles') }}",
    become: true,
    serial: 1,
    tasks: [
      { name: 'Patch the current service pack', 'ansible.builtin.command': 'zypper --non-interactive patch', changed_when: true, register: 'zp', failed_when: 'zp.rc not in [0, 102, 103]' },
      { name: 'Migrate', 'ansible.builtin.command': 'zypper --non-interactive migration --auto-agree-with-licenses --migration 1', changed_when: true },
      { name: 'Reboot', 'ansible.builtin.reboot': { reboot_timeout: 3600 } },
    ],
  }];
}

/** The plays, and an inventory of the hosts that chose before-move, grouped per play. */
export function osUpgradeFiles(plan      , on        )                                                         {
  const { rows, findings } = upgradePlan(plan, on);
  const header = (what        ) => `${what}\nApplies by default. Limit with -l <host>; one host at a time (serial: 1).\nRun only after a backup or snapshot of the server.`;
  const files                         = {
    'os-upgrade/os-upgrade-windows.yml': renderYaml(windowsPlay(), { header: header(`Windows Server in-place upgrade. Supported paths: ${WINDOWS_UPGRADE_SOURCE} (verify).`) }),
    'os-upgrade/os-upgrade-rhel.yml': renderYaml(leappPlay(false), { header: header(`RHEL in-place upgrade with Leapp; fails on any inhibitor. ${LEAPP_SOURCE}`) }),
    'os-upgrade/os-upgrade-oracle-linux.yml': renderYaml(leappPlay(true), { header: header('Oracle Linux in-place upgrade with Leapp (--oraclelinux); fails on any inhibitor.') }),
    'os-upgrade/os-upgrade-ubuntu.yml': renderYaml(ubuntuPlay(), { header: header('Ubuntu in-place upgrade to the next LTS.') }),
    'os-upgrade/os-upgrade-sles.yml': renderYaml(slesPlay(), { header: header('SLES migration with zypper (verify the non-interactive flags).') }),
  };
  const groups                                                                    = {};
  const group = { windows: 'os_upgrade_windows', rhel: 'os_upgrade_rhel', 'oracle-linux': 'os_upgrade_oracle_linux', ubuntu: 'os_upgrade_ubuntu', sles: 'os_upgrade_sles' }         ;
  for (const r of rows) {
    if (r.upgrade !== 'before-move' || !r.play || !r.target) continue;
    const g = (groups[group[r.play]] ??= { hosts: {} });
    const target = osInfo(r.target);
    g.hosts[r.workload] = {
      upgrade_from: r.os, upgrade_to: r.target, upgrade_to_major: target.majorVersion,
      ...(r.play === 'windows' ? { upgrade_to_caption: `Windows Server ${target.majorVersion}` } : {}),
    };
  }
  files['os-upgrade/hosts.yml'] = renderYaml({ all: { children: groups } }                        , { header: 'The servers whose Upgrade is before-move, per play. Set os_media_path for the Windows ones.' });
  return { files, findings };
}

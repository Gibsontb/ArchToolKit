/**
 * Check everything the network page generates — the counterpart of
 * tools/validate-terraform-blueprints.mjs and validate-ansible-blueprints.mjs.
 *
 * For every network blueprint, built with its defaults and once per other
 * choice of each dropdown and yes/no:
 *   - it builds, with a configuration, capture, verify and back-out, and its
 *     defaults raise no error;
 *   - every task option in its playbook is one the module has: the option
 *     check the Ansible page uses (src/ansible/args-check.ts), plus the option
 *     lists of the collections that check has no data for (Junos, AOS-CX, FMC);
 * then, per platform, all of its blueprints merge into one whole-device
 * configuration without an error; and every default playbook passes
 * `ansible-playbook --syntax-check` against the real collections, which proves
 * each module name resolves.
 *
 *   npm run network:validate                          # everything
 *   npm run network:validate -- --platform juniper_junos
 *   npm run network:validate -- --only fmc_           # ids containing this
 *   npm run network:validate -- --no-ansible          # skip the syntax check
 *
 * The syntax check needs the Ansible in ~/archtoolkit-ansible
 * (tools/setup-ansible-wsl.sh); on Windows, in WSL.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NETWORK_BLUEPRINTS, networkChange } from '../src/network/blueprints/index.ts';
import { defaultValues } from '../src/kit/blueprint.ts';
import { checkPlaybook } from '../src/ansible/args-check.ts';
import { readYaml } from '../src/core/yaml-read.ts';
import { fullConfig } from '../src/network/full-config.ts';

const argv = process.argv.slice(2);
const many = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const only = many('--only');
const platforms = many('--platform');
const noAnsible = argv.includes('--no-ansible');
const VENV = process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? '~/archtoolkit-ansible';

/**
 * Options of the config modules args-check has no documentation for, read
 * from the collections' argument specs (junipernetworks.junos 11,
 * arubanetworks.aoscx 4, cisco.fmcansible 1).
 */
const OWN_OPTIONS = {
  'junipernetworks.junos.junos_config': ['backup', 'backup_options', 'check_commit', 'comment', 'confirm', 'confirm_commit', 'lines', 'replace', 'rollback', 'src', 'src_format', 'update', 'zeroize'],
  'arubanetworks.aoscx.aoscx_config': ['after', 'backup', 'backup_options', 'before', 'diff_against', 'diff_ignore_lines', 'intended_config', 'lines', 'match', 'parents', 'replace', 'running_config', 'save_when', 'src'],
  'cisco.fmcansible.fmc_configuration': ['data', 'filters', 'operation', 'path_params', 'query_params', 'register_as'],
};

/** Blueprints that refuse at their defaults on purpose, until you confirm something. */
const REFUSE_BY_DESIGN = new Set(['f5_remove_tenant']);

const groups = NETWORK_BLUEPRINTS.filter((g) => platforms.length === 0 || platforms.includes(g.target));
const blueprints = groups
  .flatMap((g) => g.blueprints.map((b) => ({ target: g.target, blueprint: b })))
  .filter(({ blueprint: b }) => (only.length > 0 ? only.some((o) => b.id.includes(o)) : true));
if (blueprints.length === 0) {
  console.error('No blueprints matched.');
  process.exit(1);
}

function variants(blueprint) {
  const base = defaultValues(blueprint);
  const out = [{ label: blueprint.id, values: base, isDefault: true }];
  for (const input of blueprint.inputs) {
    const choices = input.control === 'toggle' ? [true, false] : input.control === 'select' ? (input.options ?? []).map((o) => o.value) : [];
    for (const value of choices) {
      if (String(value) === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${value}]`, values: { ...base, [input.id]: value } });
    }
  }
  return out;
}

/** Options a task uses that its module does not have, for the modules in OWN_OPTIONS. */
function ownOptionProblems(playbook) {
  const out = [];
  const plays = readYaml(playbook).documents[0];
  for (const play of Array.isArray(plays) ? plays : []) {
    for (const task of Array.isArray(play?.tasks) ? play.tasks : []) {
      for (const [module, args] of Object.entries(task ?? {})) {
        const known = OWN_OPTIONS[module];
        if (!known || typeof args !== 'object' || args === null) continue;
        for (const option of Object.keys(args)) if (!known.includes(option)) out.push(`${module} has no option "${option}"`);
        if (module.endsWith('fmc_configuration') && !args.operation) out.push(`${module} task has no operation`);
      }
    }
  }
  return out;
}

const problems = new Map();
const fail = (label, message) => problems.set(label, [...(problems.get(label) ?? []), message]);
const work = mkdtempSync(join(tmpdir(), 'archtoolkit-network-validate-'));
const playbooks = [];
let builds = 0;

for (const { blueprint } of blueprints) {
  for (const { label, values, isDefault } of variants(blueprint)) {
    builds++;
    let change;
    let files;
    try {
      change = networkChange(blueprint.id).change(values, 'check');
      files = blueprint.build(values, 'check').files;
    } catch (err) {
      fail(label, `build threw: ${err.message}`);
      continue;
    }
    for (const part of ['config', 'before', 'verify', 'backout']) if (!change[part]?.length) fail(label, `no ${part}`);
    if (isDefault && !REFUSE_BY_DESIGN.has(blueprint.id)) {
      for (const f of (change.findings ?? []).filter((f) => f.severity === 'error')) fail(label, `error at the defaults: ${f.message}`);
    }
    const playbook = files['check.yml'];
    if (!playbook) continue;
    for (const p of checkPlaybook(playbook)) fail(label, `${p.path}: ${p.message}`);
    for (const p of ownOptionProblems(playbook)) fail(label, p);
    if (isDefault) {
      const dir = join(work, blueprint.id);
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      playbooks.push(blueprint.id);
    }
  }
}

// Every platform's blueprints, merged into one device's configuration.
for (const group of groups) {
  const steps = group.blueprints
    .filter((b) => blueprints.some((x) => x.blueprint === b))
    .map((b) => ({ label: b.id, change: networkChange(b.id).change(defaultValues(b), b.id) }));
  if (steps.length === 0) continue;
  const whole = fullConfig(group.target, steps, 'check');
  for (const f of whole.findings.filter((f) => f.severity === 'error')) fail(`${group.target} (whole-device configuration)`, f.message);
}

// The syntax check, with the real collections.
function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}
function findDistro() {
  if (process.env.ARCHTOOLKIT_WSL_DISTRO) return process.env.ARCHTOOLKIT_WSL_DISTRO;
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le' });
  const distros = (listed.stdout ?? '').split(/\r?\n/).map((d) => d.replace(/\0/g, '').trim()).filter(Boolean);
  for (const distro of distros.filter((d) => !d.startsWith('docker-desktop'))) {
    if (spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', `test -x ${VENV}/bin/ansible-playbook`]).status === 0) return distro;
  }
  return null;
}

let syntaxChecked = 0;
if (!noAnsible && playbooks.length > 0) {
  const onWindows = process.platform === 'win32';
  const root = onWindows ? wslPath(work) : work;
  // One play at a time: a playbook with a module that does not resolve stops
  // the whole run, so each gets its own line in the report.
  writeFileSync(
    join(work, 'syntax.sh'),
    `#!/bin/bash
export PATH=${VENV}/bin:$PATH ANSIBLE_COLLECTIONS_PATH=${VENV}/collections:~/.ansible/collections ANSIBLE_NOCOLOR=1 ANSIBLE_DEPRECATION_WARNINGS=0
cd '${root}'
: > syntax.txt
n=0
for d in */; do
  d=\${d%/}
  [ -f "$d/check.yml" ] || continue
  n=$((n+1))
  ( cd "$d" && ansible-playbook -i inventory/hosts.yml --syntax-check check.yml >/dev/null 2>err.txt ) || echo "$d	$(grep -m1 ERROR "$d/err.txt")" >> syntax.txt
  [ $((n % 50)) -eq 0 ] && echo "  $n playbooks syntax-checked" >&2
done
echo "$n" > syntax-count.txt
`,
  );
  let ran = false;
  if (onWindows) {
    const distro = findDistro();
    if (!distro) console.log(`\nSkipping the syntax check: no WSL distro has Ansible in ${VENV} (wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh).`);
    else {
      console.log(`Syntax-checking ${playbooks.length} playbooks in WSL (${distro})…`);
      execFileSync('wsl', ['-d', distro, '--', 'bash', `${root}/syntax.sh`], { stdio: ['ignore', 'inherit', 'inherit'] });
      ran = true;
    }
  } else {
    console.log(`Syntax-checking ${playbooks.length} playbooks…`);
    execFileSync('bash', [join(work, 'syntax.sh')], { stdio: ['ignore', 'inherit', 'inherit'] });
    ran = true;
  }
  if (ran) {
    syntaxChecked = Number(readFileSync(join(work, 'syntax-count.txt'), 'utf8').trim()) || 0;
    for (const line of readFileSync(join(work, 'syntax.txt'), 'utf8').split('\n').filter(Boolean)) {
      const [id, message] = line.split('\t');
      fail(id, `--syntax-check: ${message || 'failed'}`);
    }
  }
}

for (const [label, lines] of problems) {
  console.log(`\n✗ ${label}`);
  for (const l of lines.slice(0, 8)) console.log(`    ${String(l).split('\n')[0].slice(0, 260)}`);
}
console.log(
  `\n${builds - [...problems.keys()].filter((k) => !k.includes('whole-device')).length} of ${builds} builds (${blueprints.length} blueprints, ${groups.length} platforms) pass the build and option checks` +
    `${syntaxChecked ? `; ${syntaxChecked} playbooks syntax-checked with Ansible` : ''}.`,
);
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(problems.size > 0 ? 1 : 0);

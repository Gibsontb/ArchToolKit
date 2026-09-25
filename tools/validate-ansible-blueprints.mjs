/**
 * Check what every Ansible blueprint generates with Ansible itself — the
 * counterpart of tools/validate-terraform-blueprints.mjs.
 *
 * Each blueprint's download is written out as its own project and checked with
 * ansible-lint's argument rule (`args`), which loads the module's real
 * argument_spec and validates the task against it: unknown options, wrong
 * types, values outside `choices`, missing required options, and the
 * mutually-exclusive / required-together / required-one-of rules the
 * documentation cannot express. `--syntax-check` alone would only prove the
 * YAML and the module names.
 *
 *   npm run ansible:validate                          # every blueprint
 *   npm run ansible:validate -- --platform network    # one platform (repeatable)
 *   npm run ansible:validate -- --only mod_cisco_ios  # ids containing this
 *   npm run ansible:validate -- --playbooks           # only the hand-written ones
 *   npm run ansible:validate -- --report out.json     # every error, as JSON
 *
 * A hand-written playbook is also built once per other choice of each
 * dropdown and yes/no, as the Terraform checker does. Needs the Ansible in
 * ~/archtoolkit-ansible (tools/setup-ansible-wsl.sh); on Windows, in WSL.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ANSIBLE_BLUEPRINTS } from '../src/ansible/blueprints/index.ts';
import { defaultValues } from '../src/kit/blueprint.ts';
import { checkPlaybook } from '../src/ansible/args-check.ts';

const argv = process.argv.slice(2);
const many = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const only = many('--only');
const platforms = many('--platform');
const playbooksOnly = argv.includes('--playbooks');
const modulesOnly = argv.includes('--modules');
const keep = argv.includes('--keep');
const reportAt = argv.indexOf('--report');
const reportFile = reportAt === -1 ? null : argv[reportAt + 1];
const idsAt = argv.indexOf('--ids');
const ids = idsAt === -1 ? null : new Set(readFileSync(argv[idsAt + 1], 'utf8').split(/\r?\n/).filter(Boolean));
const VENV = process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? '~/archtoolkit-ansible';
const PER_MODULE = /^mod_/;

const blueprints = ANSIBLE_BLUEPRINTS.filter((g) => platforms.length === 0 || platforms.includes(g.target))
  .flatMap((g) => g.blueprints.map((b) => ({ target: g.target, blueprint: b })))
  .filter(({ blueprint: b }) => (only.length > 0 ? only.some((o) => b.id.includes(o)) : true))
  .filter(({ blueprint: b }) => (ids ? ids.has(b.id) : true))
  .filter(({ blueprint: b }) => (playbooksOnly ? !PER_MODULE.test(b.id) : true))
  .filter(({ blueprint: b }) => (modulesOnly ? PER_MODULE.test(b.id) : true));

if (blueprints.length === 0) {
  console.error('No blueprints matched.');
  process.exit(1);
}

function variants(blueprint) {
  const base = defaultValues(blueprint);
  const out = [{ label: blueprint.id, values: base }];
  if (PER_MODULE.test(blueprint.id)) return out;
  for (const input of blueprint.inputs) {
    const choices = input.control === 'toggle' ? [true, false] : input.control === 'select' ? (input.options ?? []).map((o) => o.value) : [];
    for (const value of choices) {
      if (String(value) === String(base[input.id])) continue;
      out.push({ label: `${blueprint.id} [${input.id}=${value}]`, values: { ...base, [input.id]: value } });
    }
  }
  return out;
}

function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}

function findDistro() {
  if (process.env.ARCHTOOLKIT_WSL_DISTRO) return process.env.ARCHTOOLKIT_WSL_DISTRO;
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le' });
  const distros = (listed.stdout ?? '').split(/\r?\n/).map((d) => d.replace(/\0/g, '').trim()).filter(Boolean);
  for (const distro of distros.filter((d) => !d.startsWith('docker-desktop'))) {
    if (spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', `test -x ${VENV}/bin/ansible-lint`]).status === 0) return distro;
  }
  return null;
}

const work = mkdtempSync(join(tmpdir(), 'archtoolkit-ansible-validate-'));
const projects = [];
for (const { target, blueprint } of blueprints) {
  for (const { label, values } of variants(blueprint)) {
    const dir = `p${projects.length}`;
    let files;
    try {
      files = blueprint.build(values, 'check').files;
    } catch (err) {
      projects.push({ dir, label, buildError: err.message });
      continue;
    }
    for (const [name, text] of Object.entries(files)) {
      const path = join(work, dir, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const playbooks = Object.keys(files).filter((n) => /\.ya?ml$/.test(n) && !n.includes('/') && n !== 'requirements.yml');
    // Every option against the module's documentation too: ansible-lint's own
    // check skips modules it cannot load (a missing SDK) and every network CLI module.
    const options = playbooks.flatMap((p) => checkPlaybook(files[p]).map((x) => `options: ${x.message}`));
    projects.push({ dir, label, target, playbooks, options });
  }
}

// One Python pass inside the Ansible environment: ansible-lint over the
// playbooks a few hundred at a time — it spreads each run over every core and
// runs the syntax check itself — collected as JSON by project.
const script = join(work, 'lint.py');
writeFileSync(
  script,
  `import json, subprocess, sys, os
work = sys.argv[1]
skip = ('yaml,name,fqcn[canonical],no-changed-when,risky-file-permissions,package-latest,latest,'
        'command-instead-of-module,command-instead-of-shell,no-free-form,partial-become,key-order,'
        'var-naming,ignore-errors,run-once,schema,jinja,no-relative-paths,literal-compare,'
        'inline-env-var,no-handler,meta-no-info,galaxy')
books = []
for d in sorted(x for x in os.listdir(work) if x.startswith('p')):
    for f in sorted(os.listdir(os.path.join(work, d))):
        if f.endswith('.yml') and f != 'requirements.yml':
            books.append(f'{d}/{f}')
out = {}
BATCH = 400
for i in range(0, len(books), BATCH):
    part = books[i:i + BATCH]
    run = subprocess.run(['ansible-lint', '--offline', '--nocolor', '-q', '-f', 'json', '--skip-list', skip, *part],
                         cwd=work, capture_output=True, text=True)
    try:
        found = json.loads(run.stdout or '[]')
    except json.JSONDecodeError:
        found = [{'check_name': 'lint', 'description': (run.stderr or run.stdout)[-400:], 'location': {'path': p}} for p in part]
    for item in found:
        path = (item.get('location') or {}).get('path', '')
        project = path.split('/')[0]
        out.setdefault(project, []).append(f"{item.get('check_name')}: {item.get('description', '')}".strip())
    print(f'  {min(i + BATCH, len(books))} of {len(books)} playbooks', file=sys.stderr, flush=True)
json.dump(out, open(os.path.join(work, 'lint.json'), 'w'))
`,
);

console.log(`Validating ${blueprints.length} Ansible blueprints (${projects.length} builds) in ${work}`);
const setup = `export PATH=${VENV}/bin:$PATH ANSIBLE_COLLECTIONS_PATH=${VENV}/collections:~/.ansible/collections ANSIBLE_NOCOLOR=1 ANSIBLE_DEPRECATION_WARNINGS=0`;
if (process.platform === 'win32') {
  const distro = findDistro();
  if (!distro) {
    console.error(`No WSL distro has ansible-lint in ${VENV}. Set it up with:\n  wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh`);
    process.exit(1);
  }
  const runner = join(work, 'run.sh');
  writeFileSync(runner, `#!/bin/bash\n${setup}\npython3 '${wslPath(script)}' '${wslPath(work)}'\n`);
  execFileSync('wsl', ['-d', distro, '--', 'bash', wslPath(runner)], { stdio: ['ignore', 'inherit', 'inherit'] });
} else {
  execFileSync('bash', ['-lc', `${setup}; python3 '${script}' '${work}'`], { stdio: ['ignore', 'inherit', 'inherit'] });
}

const lint = JSON.parse(readFileSync(join(work, 'lint.json'), 'utf8'));
const problems = new Map();
for (const p of projects) {
  if (p.buildError) problems.set(p.label, [`build threw: ${p.buildError}`]);
  else if (lint[p.dir] || p.options?.length) problems.set(p.label, [...(p.options ?? []), ...(lint[p.dir] ?? [])]);
}
for (const [label, lines] of problems) {
  console.log(`\n✗ ${label}`);
  for (const l of lines.slice(0, 8)) console.log(`    ${l.split('\n')[0].slice(0, 260)}`);
}
if (reportFile) writeFileSync(reportFile, JSON.stringify(Object.fromEntries(problems), null, 1));
console.log(`\n${projects.length - problems.size} of ${projects.length} builds (${blueprints.length} blueprints) pass ansible-lint, --syntax-check and the option check.`);
if (!keep) {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    console.log(`(Could not remove ${work}; delete it later.)`);
  }
}
process.exit(problems.size > 0 ? 1 : 0);

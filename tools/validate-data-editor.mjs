/**
 * Check the Data Editor against the real tools — the counterpart of the
 * Terraform, Ansible and network validators.
 *
 * tools/editor-corpus/<profile>/ holds files named ok-* (valid) and bad-*
 * (each with one real mistake). Every file is checked three ways:
 *   - the editor: the profile's findings, after its schema data is loaded;
 *   - the real tool for that kind of file:
 *       terraform-json      terraform validate
 *       ansible-playbook    ansible-lint's argument rule (args[...], which it
 *                           reports as a warning) and --syntax-check
 *       aws-cloudformation  cfn-lint (errors only)
 *       kubernetes          kubeconform -strict
 *       azure-arm           none offline; the file name is the expectation
 *   - the file name: ok- must be clean, bad- must be caught.
 * A file passes when the editor and the tool both agree with its name. The
 * editor must never pass a bad file, and never flag an ok one as an error.
 *
 *   npm run editor:validate
 *   npm run editor:validate -- --no-tools     # the editor against the names only
 *
 * The tools run where they live: terraform on PATH, the rest in the WSL
 * Ansible environment (tools/setup-ansible-wsl.sh installs cfn-lint and
 * kubeconform there too).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileById } from '../src/editor/profiles/index.ts';
import { perDocument } from '../src/editor/profile.ts';
import { readYaml } from '../src/core/yaml-read.ts';
import { terraformEnv, terraformInit } from './terraform-init.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'editor-corpus');
const noTools = process.argv.includes('--no-tools');
const VENV = process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? '~/archtoolkit-ansible';

/** Every corpus file, with what the editor makes of it. */
const files = [];
for (const profileId of readdirSync(CORPUS)) {
  const profile = profileById(profileId);
  if (!profile) throw new Error(`editor-corpus/${profileId}: no such profile`);
  for (const name of readdirSync(join(CORPUS, profileId))) {
    const path = join(CORPUS, profileId, name);
    const text = readFileSync(path, 'utf8');
    const expectBad = name.startsWith('bad-');
    let docs;
    if (name.endsWith('.json')) docs = [JSON.parse(text)];
    else docs = readYaml(text).documents;
    const multi = docs.length > 1;
    const doc = multi ? docs : docs[0];
    const lifted = perDocument(profile, multi);
    // No prepare(): in Node the profiles read their schema data as they ask for it.
    const errors = (lifted.validate?.(doc) ?? []).filter((f) => f.severity === 'error');
    // `tool-blind:` in a file says why the real tool cannot judge it (ansible-lint
    // skips modules run through an action plugin): only the editor is held to it.
    files.push({ profileId, name, path, expectBad, blind: text.includes('tool-blind:'), editor: errors, tool: null });
  }
}

// ---------------------------------------------------------------- the tools
function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}
function findDistro() {
  if (process.env.ARCHTOOLKIT_WSL_DISTRO) return process.env.ARCHTOOLKIT_WSL_DISTRO;
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le' });
  const distros = (listed.stdout ?? '').split(/\r?\n/).map((d) => d.replace(/\0/g, '').trim()).filter(Boolean);
  for (const distro of distros.filter((d) => !d.startsWith('docker-desktop'))) {
    if (spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', `test -x ${VENV}/bin/cfn-lint`]).status === 0) return distro;
  }
  return null;
}
/** Run a bash script where the Linux tools are; returns stdout. */
function linux(script, work) {
  const file = join(work, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, `#!/bin/bash\nexport PATH=${VENV}/bin:$PATH ANSIBLE_COLLECTIONS_PATH=${VENV}/collections:~/.ansible/collections ANSIBLE_NOCOLOR=1\n${script}\n`);
  if (process.platform !== 'win32') return execFileSync('bash', [file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const distro = findDistro();
  if (!distro) throw new Error(`no WSL distro has cfn-lint in ${VENV}: wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh`);
  return execFileSync('wsl', ['-d', distro, '--', 'bash', wslPath(file)], { encoding: 'utf8', maxBuffer: 64 << 20 });
}
const here = (p) => (process.platform === 'win32' ? wslPath(p) : p);

if (!noTools) {
  const work = mkdtempSync(join(tmpdir(), 'archtoolkit-editor-validate-'));
  try {
    // Terraform: one root, each file a module of its own, one init.
    const tf = files.filter((f) => f.profileId === 'terraform-json');
    if (tf.length) {
      const root = join(work, 'tf');
      mkdirSync(root);
      const modules = [];
      tf.forEach((f, i) => {
        const dir = join(root, `m${i}`);
        mkdirSync(dir);
        const doc = JSON.parse(readFileSync(f.path, 'utf8'));
        // A module takes its variables from the root: give each one a value.
        const vars = Object.fromEntries(Object.keys(doc.variable ?? {}).map((v) => [v, 'example']));
        writeFileSync(join(dir, 'main.tf.json'), JSON.stringify(doc));
        modules.push([`m${i}`, { source: `./m${i}`, ...vars }]);
      });
      writeFileSync(join(root, 'main.tf.json'), JSON.stringify({ module: Object.fromEntries(modules) }));
      if (!terraformInit(root)) throw new Error('terraform init failed');
      const run = spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd: root, env: terraformEnv(), encoding: 'utf8', maxBuffer: 64 << 20 });
      const result = JSON.parse(run.stdout || '{}');
      tf.forEach((f, i) => {
        f.tool = (result.diagnostics ?? [])
          .filter((d) => d.severity === 'error' && (d.range?.filename ?? '').replace(/\\/g, '/').startsWith(`m${i}/`))
          .map((d) => `${d.summary}: ${d.detail ?? ''}`.trim());
      });
    }

    // The Linux tools, one script: each file's verdict on its own line.
    const linuxFiles = files.filter((f) => ['ansible-playbook', 'aws-cloudformation', 'kubernetes'].includes(f.profileId));
    if (linuxFiles.length) {
      const dir = join(work, 'lx');
      mkdirSync(dir);
      linuxFiles.forEach((f, i) => cpSync(f.path, join(dir, `f${i}-${f.name}`)));
      const lines = linuxFiles.map((f, i) => {
        const p = `'${here(join(dir, `f${i}-${f.name}`))}'`;
        const tag = `echo "@@${i}"`;
        if (f.profileId === 'ansible-playbook') {
          return `${tag}; printf 'all:\\n  hosts:\\n    h1:\\n  children:\\n    ios:\\n      hosts:\\n        s1:\\n' > /tmp/editor-inv.yml; ansible-playbook -i /tmp/editor-inv.yml --syntax-check ${p} >/dev/null 2>/tmp/e || grep -m1 ERROR /tmp/e; ansible-lint --offline --nocolor --format=pep8 ${p} 2>/dev/null | grep -F 'args['`;
        }
        if (f.profileId === 'aws-cloudformation') return `${tag}; cfn-lint --format parseable ${p} | grep ':E[0-9]'`;
        return `${tag}; kubeconform -strict -summary=false -output text ${p} | grep -v ' is valid'`;
      });
      const out = linux(lines.join('\n') + '\ntrue', work);
      for (const block of out.split('@@').slice(1)) {
        const [head, ...rest] = block.split('\n');
        const f = linuxFiles[Number(head.trim())];
        if (f) f.tool = rest.map((l) => l.trim()).filter(Boolean);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

// ------------------------------------------------------------- the verdicts
let failed = 0;
for (const f of files) {
  const editorBad = f.editor.length > 0;
  const toolBad = f.tool === null || f.blind ? null : f.tool.length > 0;
  const problems = [];
  if (editorBad !== f.expectBad) problems.push(f.expectBad ? 'the editor did not catch it' : `the editor flags it: ${f.editor[0].message}`);
  if (toolBad !== null && toolBad !== f.expectBad) problems.push(f.expectBad ? 'the real tool did not catch it (fix the fixture)' : `the real tool rejects it (fix the fixture): ${f.tool[0]}`);
  const tool = f.blind ? 'the tool cannot see this' : toolBad === null ? 'no offline tool' : toolBad ? 'tool: error' : 'tool: clean';
  const mark = problems.length ? '✗' : '✓';
  if (problems.length) failed++;
  console.log(`${mark} ${f.profileId}/${f.name}  (editor: ${editorBad ? `${f.editor.length} error(s)` : 'clean'}; ${tool})`);
  if (editorBad && f.expectBad) console.log(`    editor: ${f.editor[0].message.slice(0, 160)}`);
  if (toolBad && f.expectBad) console.log(`    tool:   ${String(f.tool[0]).slice(0, 160)}`);
  for (const p of problems) console.log(`    ${p.slice(0, 260)}`);
}
console.log(`\n${files.length - failed} of ${files.length} files: the editor agrees with ${noTools ? 'the expectation' : 'the real tools'}.`);
process.exit(failed > 0 ? 1 : 0);

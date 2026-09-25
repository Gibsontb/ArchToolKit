/**
 * Regenerates the Ansible module schemas the per-module blueprints are built
 * from — every option of every module in the Ansible package (~90 collections)
 * and the collections the toolkit adds to it (oracle.oci): ~10,000 modules.
 *
 * The Ansible counterpart of tools/fetch-provider-schemas.mjs. The options
 * come from `ansible-doc -j` — each module's own DOCUMENTATION — read by
 * tools/ansible-doc-dump.py next to a real Ansible install, so nothing about
 * an option is transcribed by hand. Written the way the cloud Terraform
 * schemas are, since there is as much of it:
 *
 *   src/ansible/module-schema-index.ts     every module: its file and summary
 *   web/data/ansible/<collection>/*.json   the options, ~40 modules a file,
 *                                          fetched when a module is picked
 *
 *   npm run ansible:schemas
 *
 * Needs Ansible in ~/archtoolkit-ansible (tools/setup-ansible-wsl.sh sets it
 * up). On Windows that is inside WSL, found in whichever distro has it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA_DIR = join(ROOT, 'web', 'data', 'ansible');
const INDEX = join(ROOT, 'src', 'ansible', 'module-schema-index.ts');
const CHUNK_SIZE = 40;
const VENV = process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? '~/archtoolkit-ansible';

/** `E:\Repos\x` → `/mnt/e/Repos/x`, for a path handed to WSL. */
function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}

/** The WSL distro that has the Ansible environment in it. */
function findDistro() {
  if (process.env.ARCHTOOLKIT_WSL_DISTRO) return process.env.ARCHTOOLKIT_WSL_DISTRO;
  const listed = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf16le' });
  const distros = (listed.stdout ?? '').split(/\r?\n/).map((d) => d.replace(/\0/g, '').trim()).filter(Boolean);
  for (const distro of distros.filter((d) => !d.startsWith('docker-desktop'))) {
    const probe = spawnSync('wsl', ['-d', distro, '--', 'bash', '-lc', `test -x ${VENV}/bin/ansible-doc`]);
    if (probe.status === 0) return distro;
  }
  return null;
}

/** Run a bash script next to the Ansible install: in WSL on Windows, here elsewhere. */
function bash(script) {
  if (process.platform !== 'win32') return execFileSync('bash', ['-lc', script], { stdio: ['ignore', 'inherit', 'inherit'] });
  const distro = findDistro();
  if (!distro) {
    console.error(`No WSL distro has Ansible in ${VENV}. Set it up with:\n  wsl -d Ubuntu-24.04 -- bash tools/setup-ansible-wsl.sh`);
    process.exit(1);
  }
  console.log(`Using Ansible in ${VENV} on WSL ${distro}`);
  // Through a file: on the command line, wsl.exe expands $PATH itself — into
  // Windows folders like "Program Files (x86)" that bash then cannot parse.
  const file = join(work, 'run.sh');
  writeFileSync(file, `#!/bin/bash\nset -e\n${script}\n`);
  return execFileSync('wsl', ['-d', distro, '--', 'bash', wslPath(file)], { stdio: ['ignore', 'inherit', 'inherit'] });
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

const work = mkdtempSync(join(tmpdir(), 'archtoolkit-ansible-schemas-'));
try {
  const out = join(work, 'modules.json');
  const onHost = process.platform === 'win32' ? wslPath : (p) => p;
  console.log('Reading every module\u2019s documentation (ansible-doc)…');
  bash(
    `export PATH=${VENV}/bin:$PATH ANSIBLE_COLLECTIONS_PATH=${VENV}/collections:~/.ansible/collections; ` +
      `python3 '${onHost(join(HERE, 'ansible-doc-dump.py'))}' '${onHost(out)}' --ansible-doc ${VENV}/bin/ansible-doc`,
  );
  const dump = JSON.parse(readFileSync(out, 'utf8'));

  // One directory per collection, CHUNK_SIZE modules to a file.
  rmSync(DATA_DIR, { recursive: true, force: true });
  const byCollection = new Map();
  for (const name of Object.keys(dump.modules).sort()) {
    const collection = name.split('.').slice(0, 2).join('.');
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection).push(name);
  }
  const index = {};
  let files = 0;
  for (const [collection, names] of byCollection) {
    const dir = join(DATA_DIR, collection);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < names.length; i += CHUNK_SIZE) {
      const part = names.slice(i, i + CHUNK_SIZE);
      const chunk = names.length > CHUNK_SIZE ? `${slug(collection)}-${i / CHUNK_SIZE + 1}` : slug(collection);
      const body = {};
      for (const name of part) {
        body[name] = dump.modules[name];
        index[name] = [chunk, (dump.modules[name].d ?? '').slice(0, 90)];
      }
      writeFileSync(join(dir, `${chunk}.json`), JSON.stringify(body));
      files++;
    }
  }
  const collections = Object.fromEntries([...byCollection.keys()].sort().map((c) => [c, dump.collections?.[c] ?? null]));
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    INDEX,
    `/**
 * Ansible module schemas: the index — GENERATED, do not edit by hand.
 *
 * Written by tools/fetch-ansible-schemas.mjs from \`ansible-doc -j\` over the
 * Ansible ${dump.package ?? ''} package (${dump.core}) and oracle.oci.
 * Refresh with: npm run ansible:schemas
 *
 * modules: FQCN → [schema file, short description]. The options themselves
 * are web/data/ansible/<collection>/<file>.json, read by
 * src/ansible/module-blueprints.ts when a module is picked.
 */

/** When this file was generated, ISO date. */
export const ANSIBLE_SCHEMA_FETCHED_AT = ${JSON.stringify(today)};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ANSIBLE_SCHEMA_INDEX: any = JSON.parse(${JSON.stringify(
      JSON.stringify({ package: dump.package, core: dump.core, collections, modules: index }),
    )});
`,
  );
  console.log(`\n${Object.keys(index).length} modules in ${byCollection.size} collections, ${files} schema files in web/data/ansible/`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

/**
 * Where the tools keep what they download, cache and build while they run:
 * `.work/` inside the toolkit's own folder, found from this file's location.
 * Nothing goes in a home directory or the system temp directory, and no drive
 * letter is fixed, so the folder can be moved or carried to another machine
 * whole. Deleting `.work/` removes all of it; the next run puts it back.
 *
 *   .work/tmp/      one working directory per tool run, removed after it
 *   .work/cache/    downloads kept between runs (provider plugins, docs)
 *   .work/ansible/  the Python environment with Ansible, ansible-lint,
 *                   cfn-lint, kubeconform and AppInspect (tools/setup-ansible-wsl.sh)
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The toolkit's folder. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Everything the tools write while they run. */
export const WORK = join(ROOT, '.work');
/** Per-run working directories: mkdtempSync(join(WORK_TMP, 'name-')). */
export const WORK_TMP = join(WORK, 'tmp');
/** Downloads kept between runs. */
export const WORK_CACHE = join(WORK, 'cache');
mkdirSync(WORK_TMP, { recursive: true });
mkdirSync(WORK_CACHE, { recursive: true });

/** `X:\a\b` → `/mnt/x/a/b`, for a path handed to WSL; other paths unchanged. */
export function wslPath(path) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : path;
}

/** The Ansible environment as the shell that runs it sees it (WSL on Windows). */
export const ANSIBLE_VENV =
  process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? (process.platform === 'win32' ? wslPath(join(WORK, 'ansible')) : join(WORK, 'ansible'));

/**
 * The shell exports every Ansible tool runs under: its own bin first, its own
 * collections only, and Ansible's and the linters' home and caches inside the
 * environment rather than in ~.
 */
export const ANSIBLE_EXPORTS =
  `export PATH=${ANSIBLE_VENV}/bin:$PATH ANSIBLE_COLLECTIONS_PATH=${ANSIBLE_VENV}/collections ` +
  `ANSIBLE_HOME=${ANSIBLE_VENV}/home ANSIBLE_LOCAL_TEMP=${ANSIBLE_VENV}/home/tmp XDG_CACHE_HOME=${ANSIBLE_VENV}/cache ` +
  `XDG_CONFIG_HOME=${ANSIBLE_VENV}/config PIP_CACHE_DIR=${ANSIBLE_VENV}/cache/pip`;

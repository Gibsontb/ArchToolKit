/**
 * Where the tools keep what they download, cache and build while they run:
 * `.work/` inside the toolkit's own folder, found from this file's location.
 * Nothing goes in a home directory or the system temp directory, and no drive
 * letter is fixed, so the folder can be moved or carried to another machine
 * whole. Deleting `.work/` removes all of it; the next run puts it back.
 *
 *   .work/tmp/      one working directory per tool run, removed after it
 *   .work/cache/    downloads kept between runs (provider plugins, docs)
 *   .work/ansible.tar.gz  the Python environment with Ansible, ansible-lint,
 *                   cfn-lint, kubeconform and AppInspect, packed; in WSL it runs
 *                   unpacked from /tmp/archtoolkit-ansible (tools/ansible-env.sh)
 *   .work/ansible/  the same environment on Linux or macOS, run in place
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

const ON_WINDOWS = process.platform === 'win32';
/** tools/ansible-env.sh as the shell that runs it sees it. */
const ENV_TOOL = ON_WINDOWS ? wslPath(join(ROOT, 'tools', 'ansible-env.sh')) : join(ROOT, 'tools', 'ansible-env.sh');

/**
 * The Ansible environment as the shell that runs it sees it: in WSL, the
 * scratch copy unpacked from the toolkit's .work/ansible.tar.gz.
 */
export const ANSIBLE_VENV = process.env.ARCHTOOLKIT_ANSIBLE_VENV ?? (ON_WINDOWS ? '/tmp/archtoolkit-ansible' : join(WORK, 'ansible'));

/**
 * A shell test that passes only in the WSL distro that built the environment:
 * another distro can see the pack on the shared drive but not run it.
 */
export const ANSIBLE_PROBE = process.env.ARCHTOOLKIT_ANSIBLE_VENV || !ON_WINDOWS ? `test -x ${ANSIBLE_VENV}/bin/ansible` : `bash '${ENV_TOOL}' here`;

/**
 * The shell exports every Ansible tool runs under: its own bin first, its own
 * collections only, and Ansible's and the linters' home and caches inside the
 * environment rather than in ~.
 */
export const ANSIBLE_EXPORTS =
  (ON_WINDOWS && !process.env.ARCHTOOLKIT_ANSIBLE_VENV ? `bash '${ENV_TOOL}' restore >/dev/null || exit 1; ` : '') +
  `export PATH=${ANSIBLE_VENV}/bin:$PATH ANSIBLE_COLLECTIONS_PATH=${ANSIBLE_VENV}/collections ` +
  `ANSIBLE_HOME=${ANSIBLE_VENV}/home ANSIBLE_LOCAL_TEMP=${ANSIBLE_VENV}/home/tmp XDG_CACHE_HOME=${ANSIBLE_VENV}/cache ` +
  `XDG_CONFIG_HOME=${ANSIBLE_VENV}/config PIP_CACHE_DIR=${ANSIBLE_VENV}/cache/pip`;

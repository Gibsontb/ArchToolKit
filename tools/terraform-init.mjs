/**
 * `terraform init` that waits out the registry's rate limit.
 *
 * update.bat (area T) asks registry.terraform.io for every provider several
 * times in a row: the schemas, then rule discovery, then validation platform
 * by platform. The registry answers a burst like that with 429 Too Many
 * Requests, and Terraform gives up after two attempts. This retries the whole
 * init with a growing pause, only for that error, and shares one plugin cache
 * so a provider downloaded once is not downloaded again.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORK_CACHE } from './work.mjs';

/** One provider cache for every tool, kept between runs. */
export const PLUGIN_CACHE = join(WORK_CACHE, 'tf-plugin-cache');

/** The environment to run terraform with: the shared cache and more registry retries. */
export function terraformEnv(extra = {}) {
  mkdirSync(PLUGIN_CACHE, { recursive: true });
  return {
    ...process.env,
    TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE,
    TF_IN_AUTOMATION: '1',
    // No update check, so nothing is written to ~/.terraform.d.
    CHECKPOINT_DISABLE: '1',
    // Terraform's own retry of registry requests (it counts 429 among them).
    TF_REGISTRY_DISCOVERY_RETRY: '8',
    ...extra,
  };
}

const RATE_LIMITED = /429|Too Many Requests/i;
const PAUSES = [60, 120, 240, 300, 300];
/**
 * Windows: a provider the last validate started is still closing, and holds
 * its binary in the shared plugin cache open for a moment.
 */
const FILE_BUSY = /being used by another process/i;
const BUSY_PAUSES = [5, 10, 20, 30];

/** Pause without a busy loop; the tools are synchronous scripts. */
function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/** Run terraform init in `cwd`; returns true, or false after printing why it failed. */
export function terraformInit(cwd, env = terraformEnv()) {
  for (let attempt = 0; ; attempt++) {
    const run = spawnSync('terraform', ['init', '-input=false', '-no-color', '-backend=false'], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status === 0) return true;
    const output = `${run.stderr ?? ''}${run.stdout ?? ''}`;
    if (FILE_BUSY.test(output) && attempt < BUSY_PAUSES.length) {
      const wait = BUSY_PAUSES[attempt];
      console.log(`  A provider binary is still in use by a closing process. Waiting ${wait} seconds, then trying again (${attempt + 1} of ${BUSY_PAUSES.length})…`);
      sleep(wait);
      continue;
    }
    if (!RATE_LIMITED.test(output) || attempt >= PAUSES.length) {
      process.stderr.write(run.stderr || output);
      return false;
    }
    const wait = PAUSES[attempt];
    console.log(`  The Terraform Registry is rate limiting (429). Waiting ${wait} seconds, then trying again (${attempt + 1} of ${PAUSES.length})…`);
    sleep(wait);
  }
}

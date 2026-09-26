/**
 * `terraform init` that waits out the registry's rate limit.
 *
 * update-terraform.bat asks registry.terraform.io for every provider several
 * times in a row: the schemas, then rule discovery, then validation platform
 * by platform. The registry answers a burst like that with 429 Too Many
 * Requests, and Terraform gives up after two attempts. This retries the whole
 * init with a growing pause, only for that error, and shares one plugin cache
 * so a provider downloaded once is not downloaded again.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One provider cache for every tool, kept between runs. */
export const PLUGIN_CACHE = join(tmpdir(), 'archtoolkit-tf-plugin-cache');

/** The environment to run terraform with: the shared cache and more registry retries. */
export function terraformEnv(extra = {}) {
  mkdirSync(PLUGIN_CACHE, { recursive: true });
  return {
    ...process.env,
    TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE,
    TF_IN_AUTOMATION: '1',
    // Terraform's own retry of registry requests (it counts 429 among them).
    TF_REGISTRY_DISCOVERY_RETRY: '8',
    ...extra,
  };
}

const RATE_LIMITED = /429|Too Many Requests/i;
const PAUSES = [60, 120, 240, 300, 300];

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
    if (!RATE_LIMITED.test(output) || attempt >= PAUSES.length) {
      process.stderr.write(run.stderr || output);
      return false;
    }
    const wait = PAUSES[attempt];
    console.log(`  The Terraform Registry is rate limiting (429). Waiting ${wait} seconds, then trying again (${attempt + 1} of ${PAUSES.length})…`);
    sleep(wait);
  }
}

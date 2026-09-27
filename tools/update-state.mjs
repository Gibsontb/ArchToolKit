/**
 * What update.bat has already done, so a step that is current is skipped
 * rather than run again.
 *
 *   node tools/update-state.mjs check  <key> [--within <hours>] [--inputs <path>...]
 *   node tools/update-state.mjs record <key> [--within <hours>] [--inputs <path>...]
 *
 * `check` exits 0 when the step is current and can be skipped, 1 when it has
 * to run. A step is current when it last passed and
 *   --within <hours>   it passed less than that many hours ago (downloads:
 *                      what was fetched this morning is still current), and
 *   --inputs <path>... the files it reads — folders are walked — are exactly
 *                      what they were when it passed (checks: nothing they
 *                      check has changed, so they would pass again).
 * `record` notes that the step passed, with the time and its inputs as they
 * are now. Only update.bat's :step calls it, and only after the step passes.
 *
 * The state is .work/update-state.json in the toolkit's folder; deleting it,
 * or `update.bat ... /force`, runs every step again.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, WORK } from './work.mjs';

const STATE = join(WORK, 'update-state.json');
const [action, key, ...rest] = process.argv.slice(2);
if (!['check', 'record'].includes(action) || !key) {
  console.error('usage: update-state.mjs check|record <key> [--within <hours>] [--inputs <path>...]');
  process.exit(2);
}
const withinAt = rest.indexOf('--within');
const within = withinAt === -1 ? null : Number(rest[withinAt + 1]);
const inputsAt = rest.indexOf('--inputs');
const inputs = inputsAt === -1 ? [] : rest.slice(inputsAt + 1).filter((p) => !p.startsWith('--'));

/** Every file under the paths, in a fixed order; a missing path counts as itself. */
function files(paths) {
  const out = [];
  const walk = (p) => {
    if (!existsSync(p)) return out.push(`${p} (missing)`);
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p).sort()) if (name !== 'node_modules' && name !== '__pycache__') walk(join(p, name));
    } else out.push(p);
  };
  for (const p of paths) walk(join(ROOT, p));
  return out;
}

/** One hash over the inputs' names and contents. */
function fingerprint(paths) {
  const hash = createHash('sha256');
  for (const f of files(paths)) {
    hash.update(relative(ROOT, f).replace(/\\/g, '/'));
    hash.update('\0');
    if (!f.endsWith(' (missing)')) hash.update(readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

let state = {};
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
} catch {
  // No state yet: everything runs.
}

if (action === 'record') {
  state[key] = { passed: new Date().toISOString(), ...(inputs.length > 0 ? { inputs: fingerprint(inputs) } : {}) };
  writeFileSync(STATE, `${JSON.stringify(state, null, 1)}\n`);
  process.exit(0);
}

const last = state[key];
if (!last) process.exit(1);
const hours = (Date.now() - Date.parse(last.passed)) / 3_600_000;
if (within !== null && !(hours < within)) process.exit(1);
if (inputs.length > 0 && last.inputs !== fingerprint(inputs)) process.exit(1);
const ago = hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours.toFixed(1)} hours`;
console.log(`  Current (passed ${ago} ago${inputs.length > 0 ? ', and nothing it reads has changed since' : ''}) - skipped.`);
process.exit(0);

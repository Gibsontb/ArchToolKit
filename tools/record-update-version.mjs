import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, WORK } from './work.mjs';

const steps = [...new Set(process.argv.slice(2))].sort();
if (!steps.length || steps.some((step) => !/^[a-z0-9-]+$/.test(step))) {
  throw new Error('Pass the keys of the update steps that completed.');
}

const target = join(ROOT, 'update-version.json');
let previous = { version: 0, steps: {} };
try {
  previous = JSON.parse(readFileSync(target, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!Number.isSafeInteger(previous.version) || previous.version < 0 || previous.version === Number.MAX_SAFE_INTEGER) {
  throw new Error('Invalid update version in update-version.json.');
}
const version = previous.version + 1;
const completedAt = new Date().toISOString();
const versions = {
  ...previous.steps,
  ...Object.fromEntries(steps.map((step) => [step, { version, completedAt }])),
};
const result = {
  version,
  completedAt,
  steps: Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b))),
};
const temporary = join(WORK, `update-version-${process.pid}.json`);
writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n');
renameSync(temporary, target);
console.log(`Recorded update version ${version}.`);

/**
 * The version the pages show and the version in `package.json` have to be the
 * same number, or the badge in the header is a lie the moment one is bumped
 * without the other.
 */

import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '../testing/expect.ts';
import { VERSION, VERSION_LABEL } from './version.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('is three numbers, so the badge reads "Version 0.0.0"', () => {
    expect(/^\d+\.\d+\.\d+$/.test(VERSION)).toBe(true);
    expect(VERSION_LABEL).toBe(`Version ${VERSION}`);
  });
});

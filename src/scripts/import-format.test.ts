/**
 * Every script, as the zip unpacks: a file its interpreter runs as it stands.
 *
 *  - The file is named what its own usage lines run it as (or what the page
 *    was told to call it), with the language's extension, and the README and
 *    header name that same file.
 *  - Bash and Python start with their shebang.
 *  - PowerShell and batch are plain ASCII: Windows PowerShell 5.1 reads a .ps1
 *    without a byte-order mark as ANSI, where an em dash turns into a closing
 *    quotation mark and the script stops parsing. Batch has CRLF line endings.
 *
 * Parsing each language needs its interpreter, which the suite does not have;
 * the release check runs `bash -n`, `python3 -m py_compile` and the PowerShell
 * parser over the same output. Across every select option and toggle.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type Blueprint, type BlueprintValues } from '../kit/blueprint.ts';
import { SCRIPT_BLUEPRINTS, SCRIPTS } from './blueprints/index.ts';
import { SCRIPT_PLATFORMS } from './script.ts';

function variants(blueprint: Blueprint): BlueprintValues[] {
  const base = defaultValues(blueprint);
  const out: BlueprintValues[] = [base];
  for (const input of blueprint.inputs) {
    if (input.control === 'toggle') out.push({ ...base, [input.id]: !(base[input.id] === true || base[input.id] === 'true') });
    if (input.control === 'select' && input.options && input.options.length <= 40) {
      for (const option of input.options) if (option.value !== base[input.id]) out.push({ ...base, [input.id]: option.value });
    }
  }
  return out;
}

describe('every script, as its interpreter reads the file', () => {
  const all = SCRIPT_BLUEPRINTS.flatMap((group) => group.blueprints);

  it('has the language extension, a shebang where the language takes one, and the encoding the host reads', () => {
    for (const blueprint of all) {
      const platform = SCRIPTS.find((s) => s.id === blueprint.id)?.platform ?? (blueprint.id.split('_')[0] as keyof typeof SCRIPT_PLATFORMS);
      const info = SCRIPT_PLATFORMS[platform];
      for (const values of variants(blueprint)) {
        const files = blueprint.build(values, '').files;
        const scripts = Object.keys(files).filter((n) => n !== 'README.md');
        expect([blueprint.id, scripts.length, scripts.every((n) => n.endsWith(info.extension))]).toEqual([blueprint.id, 1, true]);
        const text = files[scripts[0] as string] ?? '';
        if (info.shebang) expect([blueprint.id, text.startsWith(`${info.shebang}\n`)]).toEqual([blueprint.id, true]);
        if (platform === 'powershell' || platform === 'cmd') expect([blueprint.id, /[^\x00-\x7F]/.test(text)]).toEqual([blueprint.id, false]);
        if (platform === 'cmd') expect([blueprint.id, /(^|[^\r])\n/.test(text)]).toEqual([blueprint.id, false]);
      }
    }
  });

  it('is named what its usage runs it as, and nothing refers to another file name', () => {
    for (const blueprint of all) {
      const files = blueprint.build(defaultValues(blueprint), '').files;
      const file = Object.keys(files).find((n) => n !== 'README.md') as string;
      if (!blueprint.id.endsWith('_snippet')) expect([blueprint.id, file.startsWith('script.')]).toEqual([blueprint.id, false]);
      const extension = file.slice(file.lastIndexOf('.'));
      const readme = files['README.md'] ?? '';
      const running = readme.slice(readme.indexOf('## Running it'), readme.indexOf('## Undoing it') > 0 ? readme.indexOf('## Undoing it') : undefined);
      const named = [...running.matchAll(new RegExp(`(?<![A-Za-z0-9_.~%-])([A-Za-z0-9_][A-Za-z0-9_.-]*)\\${extension}\\b`, 'g'))].map((m) => `${m[1]}${extension}`).filter((n) => !/\.Tests\./.test(n));
      for (const name of named) expect([blueprint.id, name]).toEqual([blueprint.id, file]);
    }
  });

  it('follows a name given on the page through the header and the README', () => {
    const blueprint = all.find((b) => b.id === 'ps_disk_report') as Blueprint;
    const files = blueprint.build(defaultValues(blueprint), 'disk check').files;
    expect(Object.keys(files)).toContain('disk-check.ps1');
    expect(files['disk-check.ps1']).toContain('disk-check.ps1');
    expect(files['disk-check.ps1']).not.toContain('Get-DiskPressure.ps1');
    expect(files['README.md']).not.toContain('Get-DiskPressure.ps1');
  });

  it('uses the snippet\'s script name for its file', () => {
    const blueprint = all.find((b) => b.id === 'python_snippet') as Blueprint;
    const files = blueprint.build({ ...defaultValues(blueprint), script_name: 'rotate-logs' }, '').files;
    expect(Object.keys(files)).toContain('rotate_logs.py');
  });
});

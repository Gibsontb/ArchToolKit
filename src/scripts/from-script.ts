/**
 * A script, as the files someone can use.
 *
 * Two of them: the script itself, and the README that goes in the ticket or
 * beside it in a repository. They come from one structure, so the README cannot
 * describe a script that does something else — which is the usual fate of a
 * README written separately a week later.
 */

import type { Blueprint, BlueprintValues, BuildResult } from '../kit/blueprint.ts';
import { slug } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { SCRIPT_PLATFORMS, renderReadme, renderScript, standingFindings, type Script, type ScriptPlatform } from './script.ts';

export interface ScriptBlueprint extends Blueprint {
  /** The language this writes, so the bundle can group by it. */
  readonly platform: ScriptPlatform;
  /** The structured script, for the bundle to assemble. */
  readonly script: (values: BlueprintValues, name: string) => Script;
}

/** The file name the script's own usage lines run it as, without the extension. */
export function usageFileBase(script: Script): string | undefined {
  const extension = SCRIPT_PLATFORMS[script.platform].extension.replace(/^\./, '');
  const pattern = new RegExp(`(?:^|[\\s\\\\/])([A-Za-z0-9_][A-Za-z0-9_.-]*?)\\.${extension}\\b`);
  for (const line of script.usage) {
    const found = pattern.exec(line)?.[1];
    if (found && !/\.Tests$/i.test(found)) return found;
  }
  return undefined;
}

/**
 * The name the script file is saved under, and the one its text uses.
 *
 * A name given on the page wins. Without one, the name the script's usage
 * lines already run it as — `pwsh -File .\\Get-DiskPressure.ps1` — rather
 * than `script`: a zip holding `script.ps1` beside instructions to run
 * `Get-DiskPressure.ps1` is a first command that fails. Either way the
 * header, usage and README are made to name the file that is actually there.
 */
export function scriptFileBase(script: Script, name: string): string {
  if (name.trim() !== '') return slug(name, 'script').replace(/_/g, '-');
  return usageFileBase(script) ?? 'script';
}

function renamed(text: string, from: string | undefined, to: string, extension: string): string {
  if (!from || from === to) return text;
  const escaped = `${from}${extension}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_])`, 'g'), `${to}${extension}`);
}

/** Typographic characters, and the ASCII a Windows script host reads correctly. */
const ASCII: Readonly<Record<string, string>> = {
  '\u2014': '-', '\u2013': '-', '\u2010': '-', '\u2011': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2026': '...', '\u00D7': 'x', '\u2192': '->', '\u2190': '<-', '\u2264': '<=', '\u2265': '>=', '\u00A0': ' ',
};

/**
 * The script as its interpreter reads the file.
 *
 * Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as the ANSI
 * code page, not UTF-8, so an em dash (E2 80 94) arrives as `â€”` — and 0x94
 * there is a right double quotation mark, which PowerShell treats as a quote:
 * the string ends early and the script does not parse. cmd.exe reads a batch
 * file in the OEM code page, and finds its labels unreliably in a file with
 * bare LF line endings. So PowerShell and batch files are written as plain
 * ASCII, and batch files with CRLF. Bash and Python read UTF-8 and are left alone.
 */
export function forInterpreter(platform: Script['platform'], text: string): string {
  if (platform !== 'powershell' && platform !== 'cmd') return text;
  const ascii = text.replace(/[^\x00-\x7F]/g, (ch) => ASCII[ch] ?? '?');
  return platform === 'cmd' ? ascii.replace(/\r?\n/g, '\r\n') : ascii;
}

export function scriptFiles(script: Script, name: string): BuildResult {
  const platform = SCRIPT_PLATFORMS[script.platform];
  const base = scriptFileBase(script, name);
  const usedName = usageFileBase(script);
  const findings: Finding[] = [...(script.findings ?? []), ...standingFindings(script)];

  return {
    files: {
      [`${base}${platform.extension}`]: forInterpreter(script.platform, renamed(renderScript(script, base), usedName, base, platform.extension)),
      'README.md': renamed(`${renderReadme(script, base).join('\n')}\n`, usedName, base, platform.extension),
    },
    findings,
  };
}

/**
 * Declare a blueprint from a script builder.
 *
 * The page sees an ordinary `Blueprint`; the bundle sees the structured script
 * underneath it. Writing both by hand is how the two would eventually disagree.
 */
export function scriptBlueprint(
  spec: Omit<Blueprint, 'build' | 'emits'> & {
    readonly platform: ScriptPlatform;
    readonly emits?: readonly string[];
    readonly script: (values: BlueprintValues, name: string) => Script;
  },
): ScriptBlueprint {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values: BlueprintValues, name: string) => scriptFiles(spec.script(values, name), name),
  };
}

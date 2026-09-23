/**
 * One blueprint per language, over the whole catalogue.
 *
 * Hand-written task scripts do not scale: four languages have hundreds of
 * commands each, and writing a blueprint per task would be a lifetime's work
 * that still missed the thing someone actually needed. So this is the other
 * half of the catalogue-as-data idea — pick any catalogued command and get it
 * back wrapped in that language's house skeleton.
 *
 * What the wrapper adds is exactly what a command pasted from a search result
 * does not have: strict mode, logging with timestamps, argument parsing, a dry
 * run that short-circuits before anything happens, a loop over an input list
 * when you are doing this to more than one thing, and the command's own trap
 * written into the file as a comment so whoever runs it reads it first.
 */

import { bool, str, type BlueprintValues, type SelectOption } from '../../kit/blueprint.ts';
import { info, warning, type Finding } from '../../core/findings.ts';
import { scriptBlueprint, type ScriptBlueprint } from '../from-script.ts';
import type { Script, ScriptEffect, ScriptPlatform } from '../script.ts';
import { commandById, type CommandEntry } from '../catalog.ts';
import { catalogFor, commandsFor } from '../catalog-index.ts';

/** The catalogue as a grouped dropdown, in the order the catalogue declares. */
function optionsFor(platform: ScriptPlatform): readonly SelectOption[] {
  return catalogFor(platform).flatMap((group) =>
    group.commands.map((command) => ({
      value: command.id,
      label: `${command.name} — ${command.task}`,
      group: group.name,
    })),
  );
}

function firstReadCommand(platform: ScriptPlatform): CommandEntry {
  const commands = commandsFor(platform);
  const readable = commands.find((command) => command.effect === 'read');
  const chosen = readable ?? commands[0];
  if (!chosen) throw new Error(`no catalogued commands for ${platform}`);
  return chosen;
}

function chosenCommand(platform: ScriptPlatform, values: BlueprintValues): CommandEntry {
  const fallback = firstReadCommand(platform);
  return commandById(commandsFor(platform), str(values, 'command', fallback.id)) ?? fallback;
}

/**
 * The catalogue's effect in the script model's terms.
 *
 * `changes` becomes repeat-unsafe rather than idempotent on purpose: the
 * catalogue does not claim a command is safe to run twice, and guessing that it
 * is would be the one wrong guess that matters.
 */
const EFFECT: Readonly<Record<CommandEntry['effect'], ScriptEffect>> = {
  read: 'read',
  changes: 'repeat-unsafe',
  destructive: 'destructive',
};

function syntaxLines(command: CommandEntry): string[] {
  return command.syntax.split('\n');
}

function indent(lines: readonly string[], by: string): string[] {
  return lines.map((line) => (line.trim() === '' ? '' : `${by}${line}`));
}

/** The comment block that goes immediately above the command in the body. */
function commandComment(command: CommandEntry, comment: string, width = 70): string[] {
  const lines = [`${comment} ${command.name} — ${command.task}`];
  if (command.module) lines.push(`${comment} From: ${command.module}`);
  if (command.availability) lines.push(`${comment} Available: ${command.availability}`);
  if (command.deprecated) lines.push(`${comment} DEPRECATED. Use instead: ${command.deprecated}`);
  if (command.note) {
    lines.push(`${comment}`);
    let line = '';
    for (const word of command.note.split(/\s+/)) {
      if (line === '') line = word;
      else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
      else {
        lines.push(`${comment} ${line}`);
        line = word;
      }
    }
    if (line) lines.push(`${comment} ${line}`);
  }
  for (const parameter of command.parameters ?? []) {
    lines.push(`${comment}   ${parameter.name}: ${parameter.what}`);
  }
  return lines;
}

function findingsFor(command: CommandEntry): Finding[] {
  const findings: Finding[] = [
    info('scripts.snippet.source', `Wrapped from the catalogue: ${command.name} (${command.group}).`, {
      remediation: command.note,
      source: 'ArchToolKit',
    }),
  ];
  if (command.deprecated) {
    findings.push(
      warning('scripts.snippet.deprecated', `${command.name} is deprecated. It still works, which is the dangerous part — it keeps working until the release that removes it.`, {
        remediation: `Use ${command.deprecated} instead in anything new.`,
        source: 'ArchToolKit',
      }),
    );
  }
  if (command.effect === 'destructive') {
    findings.push(
      warning('scripts.snippet.destructive', `${command.name} deletes, overwrites or disables something. The wrapper asks for confirmation and runs the dry run by default, but there may be no way back.`, {
        remediation: 'Run it once with the dry run, read what it lists, and make sure something has a backup before you take the flag off.',
        source: 'ArchToolKit',
      }),
    );
  }
  return findings;
}

const COMMON_INPUTS = (platform: ScriptPlatform) => [
  {
    id: 'command',
    label: 'Command',
    control: 'select' as const,
    options: optionsFor(platform),
    default: firstReadCommand(platform).id,
    hint: 'Every catalogued command. The Commands tab is the same list, with the notes.',
  },
  { id: 'script_name', label: 'Script name', control: 'text' as const, default: 'run-command' },
  {
    id: 'iterate',
    label: 'Run it',
    control: 'select' as const,
    options: [
      { value: 'once', label: 'Once' },
      { value: 'list', label: 'For each line of an input file' },
    ],
    default: 'once',
  },
  { id: 'dry_run', label: 'Dry run by default', control: 'toggle' as const, default: true, hint: 'The script reports what it would do until the flag is taken off' },
  { id: 'log_file', label: 'Also write a log file', control: 'toggle' as const, default: false },
];

// ---------------------------------------------------------------- PowerShell

function powershellBody(command: CommandEntry, values: BlueprintValues): string[] {
  const perItem = str(values, 'iterate', 'once') === 'list';
  const dryRun = bool(values, 'dry_run', true);
  const logFile = bool(values, 'log_file', false);
  const changes = command.effect !== 'read';

  const lines: string[] = [
    '[CmdletBinding(SupportsShouldProcess)]',
    'param(',
  ];
  if (perItem) lines.push('    [Parameter(Mandatory)][string]$InputList,');
  lines.push(
    `    [Parameter()][switch]$Execute${dryRun ? '' : ','}`,
  );
  if (!dryRun) lines.push('    [Parameter()][switch]$WhatIfOnly');
  lines.push(')', '', "Set-StrictMode -Version Latest", "$ErrorActionPreference = 'Stop'", '');

  if (logFile) {
    lines.push(
      "$LogPath = Join-Path $PSScriptRoot ('{0}-{1}.log' -f $MyInvocation.MyCommand.Name, (Get-Date -Format 'yyyyMMdd-HHmmss'))",
      '',
    );
  }

  lines.push(
    'function Write-Log {',
    "    param([string]$Message, [ValidateSet('INFO','WARN','ERROR')][string]$Level = 'INFO')",
    "    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message",
    '    Write-Verbose $line -Verbose',
  );
  if (logFile) lines.push('    Add-Content -Path $LogPath -Value $line -Encoding utf8');
  lines.push('}', '');

  if (command.module) {
    lines.push(
      `if (-not (Get-Module -ListAvailable -Name '${command.module}')) {`,
      `    throw "The ${command.module} module is not installed. Install-Module ${command.module} -Scope CurrentUser"`,
      '}',
      `Import-Module '${command.module}' -ErrorAction Stop`,
      '',
    );
  }

  lines.push('function Invoke-Step {', '    [CmdletBinding(SupportsShouldProcess)]', '    param(');
  lines.push(perItem ? '        [Parameter(Mandatory)][string]$Item' : '        [Parameter()][string]$Item = $env:COMPUTERNAME');
  lines.push('    )', '');
  lines.push(...indent(commandComment(command, '#'), '    '));
  lines.push('');

  if (changes) {
    lines.push('    if (-not $PSCmdlet.ShouldProcess($Item, ' + `'${command.name}'` + ')) {');
    lines.push(`        Write-Log "DRY RUN: would run ${command.name} against $Item"`);
    lines.push('        return');
    lines.push('    }', '');
  }

  lines.push(...indent(syntaxLines(command), '    '));
  lines.push('}', '');

  if (dryRun && changes) {
    lines.push(
      '# The dry run is the default. -Execute is what takes it off, so nobody',
      '# changes anything by running the file to see what it does.',
      'if (-not $Execute) { $WhatIfPreference = $true }',
      '',
    );
  }

  lines.push('try {');
  if (perItem) {
    lines.push(
      '    $items = Get-Content -Path $InputList | Where-Object { $_ -and -not $_.StartsWith("#") }',
      '    Write-Log "$($items.Count) items from $InputList"',
      '    foreach ($item in $items) {',
      '        try {',
      '            Invoke-Step -Item $item.Trim()',
      '        } catch {',
      "            Write-Log \"$item failed: $($_.Exception.Message)\" -Level ERROR",
      '        }',
      '    }',
    );
  } else {
    lines.push('    Invoke-Step');
  }
  lines.push(
    '} catch {',
    "    Write-Log $_.Exception.Message -Level ERROR",
    '    throw',
    '}',
  );

  return lines;
}

// -------------------------------------------------------------------- Python

function pythonBody(command: CommandEntry, values: BlueprintValues): string[] {
  const perItem = str(values, 'iterate', 'once') === 'list';
  const dryRun = bool(values, 'dry_run', true);
  const logFile = bool(values, 'log_file', false);
  const changes = command.effect !== 'read';

  const lines: string[] = [
    '"""Wrapped from the ArchToolKit command catalogue. Read the notes below."""',
    '',
    'import argparse',
    'import logging',
    'import sys',
    ...(logFile ? ['from datetime import datetime', 'from pathlib import Path'] : []),
    '',
    'log = logging.getLogger(__name__)',
    '',
    '',
    'def parse_args() -> argparse.Namespace:',
    `    p = argparse.ArgumentParser(description=${JSON.stringify(command.task)})`,
  ];
  if (perItem) p_input(lines);
  if (changes) {
    lines.push(
      dryRun
        ? "    p.add_argument('--execute', action='store_true', help='actually run it; without this it only reports')"
        : "    p.add_argument('--dry-run', action='store_true', help='report without changing anything')",
    );
  }
  lines.push("    p.add_argument('-v', '--verbose', action='store_true')", '    return p.parse_args()', '', '');

  lines.push('def work(item: str | None = None) -> None:');
  lines.push(...indent(commandComment(command, '#'), '    '));
  lines.push(...indent(syntaxLines(command), '    '));
  lines.push('', '');

  lines.push('def main() -> int:', '    args = parse_args()');
  if (logFile) {
    lines.push(
      "    log_path = Path(__file__).with_suffix('') .with_name(Path(__file__).stem + datetime.now().strftime('-%Y%m%d-%H%M%S.log'))",
      '    handlers = [logging.StreamHandler(sys.stderr), logging.FileHandler(log_path, encoding="utf-8")]',
    );
  }
  lines.push(
    '    logging.basicConfig(',
    '        level=logging.DEBUG if args.verbose else logging.INFO,',
    "        format='%(asctime)s %(levelname)s %(message)s',",
    ...(logFile ? ['        handlers=handlers,'] : []),
    '    )',
    '',
  );

  if (changes) {
    const guard = dryRun ? 'not args.execute' : 'args.dry_run';
    lines.push(
      `    dry_run = ${guard}`,
      '    if dry_run:',
      `        log.info(${JSON.stringify(`DRY RUN: would run ${command.name}. Nothing is changed.`)})`,
      '        return 0',
      '',
    );
  }

  if (perItem) {
    lines.push(
      "    items = [line.strip() for line in open(args.input_list, encoding='utf-8') if line.strip() and not line.startswith('#')]",
      "    log.info('%d items from %s', len(items), args.input_list)",
      '    failures = 0',
      '    for item in items:',
      '        try:',
      '            work(item)',
      '        except Exception:',
      "            log.exception('%s failed', item)",
      '            failures += 1',
      '    return 1 if failures else 0',
    );
  } else {
    lines.push('    try:', '        work()', '    except Exception:', "        log.exception('failed')", '        return 1', '    return 0');
  }

  lines.push('', '', "if __name__ == '__main__':", '    sys.exit(main())');
  return lines;
}

function p_input(lines: string[]): void {
  lines.push("    p.add_argument('--input-list', required=True, help='a file with one item per line')");
}

// ---------------------------------------------------------------------- Bash

function bashBody(command: CommandEntry, values: BlueprintValues): string[] {
  const perItem = str(values, 'iterate', 'once') === 'list';
  const dryRun = bool(values, 'dry_run', true);
  const logFile = bool(values, 'log_file', false);
  const changes = command.effect !== 'read';

  const lines: string[] = [
    'set -euo pipefail',
    "IFS=$'\\n\\t'",
    '',
    `DRY_RUN=${changes && dryRun ? '1' : '0'}`,
    ...(perItem ? ['INPUT_LIST=""'] : []),
    ...(logFile ? ['LOG_FILE="${TMPDIR:-/tmp}/$(basename "${BASH_SOURCE[0]}" .sh)-$(date +%Y%m%d-%H%M%S).log"'] : []),
    '',
    'usage() {',
    '  cat <<USAGE',
    `Usage: $(basename "\${BASH_SOURCE[0]}") [options]`,
    `  ${command.task}`,
    ...(perItem ? ['  --list FILE     one item per line'] : []),
    ...(changes ? ['  --execute       actually do it (the default is a dry run)', '  --dry-run       report without changing anything'] : []),
    '  -h, --help      this',
    'USAGE',
    '}',
    '',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    ...(perItem ? ['    --list) INPUT_LIST="${2:-}"; shift ;;'] : []),
    ...(changes ? ['    --execute) DRY_RUN=0 ;;', '    --dry-run) DRY_RUN=1 ;;'] : []),
    '    -h|--help) usage; exit 0 ;;',
    '    *) printf \'unknown option: %s\\n\' "$1" >&2; usage; exit 2 ;;',
    '  esac',
    '  shift',
    'done',
    '',
    'log() {',
    ...(logFile
      ? ['  printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "${2:-INFO}" "$1" | tee -a "$LOG_FILE" >&2']
      : ['  printf \'%s [%s] %s\\n\' "$(date +\'%Y-%m-%d %H:%M:%S\')" "${2:-INFO}" "$1" >&2']),
    '}',
    'die() { log "$1" ERROR; exit 1; }',
    '',
    '# Everything registered here is removed however the script ends.',
    'CLEANUP=()',
    'cleanup() { local status=$?; for item in "${CLEANUP[@]:-}"; do [[ -e "$item" ]] && rm -rf -- "$item"; done; exit "$status"; }',
    'trap cleanup EXIT INT TERM',
    '',
  ];

  const binary = command.name.split(/[ .]/)[0] ?? command.name;
  if (/^[a-z][a-z0-9_-]*$/.test(binary)) {
    lines.push(`command -v ${binary} >/dev/null 2>&1 || die "${binary} is not installed or not on PATH"`, '');
  }

  lines.push('do_work() {', '  local item="${1:-}"');
  lines.push(...indent(commandComment(command, '#'), '  '));
  lines.push('');
  if (changes) {
    lines.push(
      '  if (( DRY_RUN )); then',
      `    log "DRY RUN: would run ${command.name}\${item:+ against $item}. Nothing is changed."`,
      '    return 0',
      '  fi',
      '',
    );
  }
  lines.push(...indent(syntaxLines(command), '  '));
  lines.push('}', '');

  if (perItem) {
    lines.push(
      '[[ -n "$INPUT_LIST" ]] || die "--list is required"',
      '[[ -r "$INPUT_LIST" ]] || die "cannot read $INPUT_LIST"',
      '',
      'failures=0',
      'while IFS= read -r line; do',
      '  [[ -z "$line" || "$line" == \\#* ]] && continue',
      '  if ! do_work "$line"; then',
      '    log "$line failed" WARN',
      '    failures=$((failures + 1))',
      '  fi',
      'done < "$INPUT_LIST"',
      '',
      'log "finished with $failures failures"',
      'exit $(( failures > 0 ? 1 : 0 ))',
    );
  } else {
    lines.push('do_work', 'log "finished"');
  }

  return lines;
}

// ----------------------------------------------------------------------- cmd

function cmdBody(command: CommandEntry, values: BlueprintValues): string[] {
  const perItem = str(values, 'iterate', 'once') === 'list';
  const dryRun = bool(values, 'dry_run', true);
  const logFile = bool(values, 'log_file', false);
  const changes = command.effect !== 'read';

  const lines: string[] = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    '',
    `set "DRY_RUN=${changes && dryRun ? '1' : '0'}"`,
    'set "INPUT_LIST="',
    ...(logFile ? ['set "LOG_FILE=%TEMP%\\%~n0-%DATE:/=-%.log"'] : []),
    '',
    ':parse',
    'if "%~1"=="" goto parsed',
    'if /i "%~1"=="/WHATIF" set "DRY_RUN=1" & shift & goto parse',
    'if /i "%~1"=="/EXECUTE" set "DRY_RUN=0" & shift & goto parse',
    ...(perItem ? ['if /i "%~1"=="/LIST" set "INPUT_LIST=%~2" & shift & shift & goto parse'] : []),
    'if /i "%~1"=="/?" goto usage',
    'echo Unknown option: %~1 & goto usage',
    ':parsed',
    '',
  ];

  if (perItem) {
    lines.push(
      'if not defined INPUT_LIST echo /LIST is required & goto usage',
      'if not exist "%INPUT_LIST%" call :log "cannot read %INPUT_LIST%" ERROR & exit /b 1',
      '',
      'set "FAILURES=0"',
      'for /f "usebackq eol=# delims=" %%a in ("%INPUT_LIST%") do (',
      '  call :do_work "%%a" || set /a FAILURES+=1',
      ')',
      'call :log "finished with !FAILURES! failures"',
      'if !FAILURES! gtr 0 (exit /b 1) else (exit /b 0)',
      '',
    );
  } else {
    lines.push('call :do_work ""', 'call :log "finished"', 'exit /b %errorlevel%', '');
  }

  lines.push(':do_work');
  lines.push('set "ITEM=%~1"');
  lines.push(...commandComment(command, 'REM'));
  lines.push('');
  if (changes) {
    lines.push(
      'if "%DRY_RUN%"=="1" (',
      `  call :log "DRY RUN: would run ${command.name} %ITEM%. Nothing is changed."`,
      '  goto :eof',
      ')',
      '',
    );
  }
  lines.push(...syntaxLines(command));
  lines.push('goto :eof', '');

  lines.push(
    ':log',
    ...(logFile
      ? ['echo %DATE% %TIME% [%~2] %~1 >> "%LOG_FILE%"', 'echo %DATE% %TIME% [%~2] %~1 1>&2']
      : ['echo %DATE% %TIME% [%~2] %~1 1>&2']),
    'goto :eof',
    '',
    ':usage',
    `echo Usage: %~n0 [/WHATIF^|/EXECUTE]${perItem ? ' /LIST file.txt' : ''}`,
    `echo   ${command.task}`,
    'exit /b 2',
  );

  return lines;
}

// ------------------------------------------------------------------ assembly

const BODY: Readonly<Record<ScriptPlatform, (command: CommandEntry, values: BlueprintValues) => string[]>> = {
  powershell: powershellBody,
  python: pythonBody,
  bash: bashBody,
  cmd: cmdBody,
};

function usageFor(platform: ScriptPlatform, command: CommandEntry, perItem: boolean, dryRun: boolean, name: string): string[] {
  const changes = command.effect !== 'read';
  switch (platform) {
    case 'powershell':
      return [
        `pwsh -File .\\${name}.ps1${perItem ? ' -InputList .\\items.txt' : ''}${changes && dryRun ? '' : ' -WhatIf'}`,
        ...(changes && dryRun ? [`pwsh -File .\\${name}.ps1${perItem ? ' -InputList .\\items.txt' : ''} -Execute   # once the dry run reads correctly`] : []),
      ];
    case 'python':
      return [
        `python3 ${name}.py${perItem ? ' --input-list items.txt' : ''}`,
        ...(changes ? [`python3 ${name}.py${perItem ? ' --input-list items.txt' : ''} ${dryRun ? '--execute' : '--dry-run'}`] : []),
      ];
    case 'bash':
      return [
        `./${name}.sh${perItem ? ' --list items.txt' : ''}`,
        ...(changes ? [`./${name}.sh${perItem ? ' --list items.txt' : ''} --execute   # once the dry run reads correctly`] : []),
      ];
    default:
      return [
        `${name}.cmd${perItem ? ' /LIST items.txt' : ''}`,
        ...(changes ? [`${name}.cmd${perItem ? ' /LIST items.txt' : ''} /EXECUTE   # once the /WHATIF run reads correctly`] : []),
      ];
  }
}

function undoFor(command: CommandEntry): string[] {
  switch (command.effect) {
    case 'read':
      return ['Nothing to undo. It reads and reports; it changes nothing.'];
    case 'changes':
      return [
        `There is no automatic undo. ${command.name} changes state, and what it takes to reverse depends on what you pointed it at.`,
        'Before running it for real, record the current state — the same command in its read-only form, or an export of the object you are about to change.',
      ];
    default:
      return [
        `There may be no way back. ${command.name} deletes, overwrites or disables something.`,
        'Run the dry run, read every line of what it lists, and confirm a backup exists and has been restored from at least once.',
      ];
  }
}

/** `script_name` as a file name the platform is happy with: Python wants underscores. */
function scriptName(platform: ScriptPlatform, values: BlueprintValues): string {
  const raw = str(values, 'script_name', 'run-command').replace(/\.(ps1|py|sh|cmd|bat)$/i, '');
  const safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'run-command';
  return platform === 'python' ? safe.replace(/[-.]/g, '_') : safe;
}

function buildScript(platform: ScriptPlatform, values: BlueprintValues): Script {
  const command = chosenCommand(platform, values);
  const perItem = str(values, 'iterate', 'once') === 'list';
  const dryRun = bool(values, 'dry_run', true);
  const changes = command.effect !== 'read';

  return {
    platform,
    title: `${command.name} — ${command.task}`,
    effect: EFFECT[command.effect],
    requires: [
      ...(command.module ? [{ what: `${command.module}`, how: platform === 'powershell' ? `Install-Module ${command.module} -Scope CurrentUser` : platform === 'python' ? `python3 -m pip install ${command.module}` : undefined }] : []),
      ...(command.availability ? [{ what: command.availability }] : []),
      { what: 'Rights to run this where you are pointing it. The command is run as whoever runs the script.' },
    ],
    parameters: [
      ...(perItem ? [{ name: platform === 'powershell' ? '-InputList' : platform === 'python' ? '--input-list' : platform === 'bash' ? '--list' : '/LIST', description: 'A file with one item per line. Blank lines and lines starting with # are skipped.', required: true, example: 'items.txt' }] : []),
      ...(changes
        ? [
            {
              name: platform === 'powershell' ? '-Execute' : platform === 'python' ? (dryRun ? '--execute' : '--dry-run') : platform === 'bash' ? '--execute' : '/EXECUTE',
              description: dryRun ? 'Takes the dry run off. Without it the script reports what it would do and changes nothing.' : 'Reports what it would do without changing anything.',
              required: false,
            },
          ]
        : [{ name: '(none required)', description: 'It reads and reports.', required: false }]),
    ],
    body: BODY[platform](command, values),
    // The name the file is saved under: the usage lines name it, and the
    // download names the file after them.
    usage: usageFor(platform, command, perItem, dryRun, scriptName(platform, values)),
    undo: undoFor(command),
    notes: [
      command.note ?? `${command.name}: ${command.task}`,
      ...(command.deprecated ? [`Deprecated. Use ${command.deprecated} in anything new.`] : []),
      ...(command.related && command.related.length > 0 ? [`Worth reading beside it: ${command.related.join(', ')} — all in the Commands tab.`] : []),
      'The wrapper is the point: strict mode, logging, a dry run and a loop. The command in the middle is one line of it, and it is the line to read before running this.',
    ],
    findings: findingsFor(command),
  };
}

function snippetBlueprint(platform: ScriptPlatform, label: string, description: string): ScriptBlueprint {
  return scriptBlueprint({
    id: `${platform}_snippet`,
    platform,
    label,
    group: 'From the catalogue',
    description,
    inputs: COMMON_INPUTS(platform),
    script: (values: BlueprintValues): Script => buildScript(platform, values),
  });
}

export const SNIPPET_SCRIPTS: readonly ScriptBlueprint[] = [
  snippetBlueprint(
    'powershell',
    'Any catalogued command',
    'Pick any command from the PowerShell catalogue and get it wrapped in an advanced function with strict mode, logging, ShouldProcess and an optional loop over an input list.',
  ),
  snippetBlueprint(
    'python',
    'Any catalogued command',
    'Pick any command from the Python catalogue and get it wrapped in a script with argparse, logging, a dry run and an optional loop over an input file.',
  ),
  snippetBlueprint(
    'bash',
    'Any catalogued command',
    'Pick any command from the shell catalogue and get it wrapped in a script with strict mode, a trap, logging, a dry run and an optional loop over an input file.',
  ),
  snippetBlueprint(
    'cmd',
    'Any catalogued command',
    'Pick any command from the Windows command line catalogue and get it wrapped in a batch file with argument parsing, logging, /WHATIF and an optional loop over an input file.',
  ),
];

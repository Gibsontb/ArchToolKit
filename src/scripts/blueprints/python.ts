/**
 * Python: the scripts that end up doing the work between the systems.
 *
 * A command line tool, a CSV that has to become something else, an API that
 * has to be paged through and retried, a folder full of files nobody can
 * navigate, a log that has to be read at scale. All standard library where
 * that is possible, because a script that needs nothing installed is a script
 * that still runs in two years on a machine you have never seen.
 *
 * Every one is generated with argparse, logging rather than print, type hints,
 * a `--dry-run` on anything that changes something, and a `main()` that returns
 * an exit code — so it works as well from cron and a pipeline as from a shell.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { scriptBlueprint, type ScriptBlueprint } from '../from-script.ts';
import { identifier, listOf, pyString, snake, type Script } from '../script.ts';

const PLATFORM = 'python' as const;

/** The imports and logging setup every generated script shares. */
function preamble(imports: readonly string[], docstring: readonly string[]): string[] {
  const stdlib = ['from __future__ import annotations', '', 'import argparse', 'import logging', 'import sys'];
  const extra = imports.filter((i) => !stdlib.includes(i));
  return [
    '"""',
    ...docstring,
    '"""',
    '',
    ...stdlib,
    ...extra,
    '',
    'LOG = logging.getLogger("archtoolkit")',
    '',
    '',
    'def configure_logging(verbose: bool) -> None:',
    '    """One place decides the log format, so every message looks the same."""',
    '    logging.basicConfig(',
    '        level=logging.DEBUG if verbose else logging.INFO,',
    '        format="%(asctime)s %(levelname)-7s %(message)s",',
    '        datefmt="%Y-%m-%d %H:%M:%S",',
    '        stream=sys.stderr,',
    '    )',
    '',
  ];
}

/** The entry point every generated script shares. */
const ENTRY = [
  '',
  'if __name__ == "__main__":',
  '    try:',
  '        sys.exit(main())',
  '    except KeyboardInterrupt:',
  '        LOG.warning("Interrupted")',
  '        sys.exit(130)',
];

export const PYTHON_BASE: readonly ScriptBlueprint[] = [
  scriptBlueprint({
    id: 'py_cli_tool',
    platform: PLATFORM,
    label: 'Command line tool skeleton',
    group: 'Scaffolding',
    description: 'The starting point for anything that will be run more than once: subcommands, argument parsing, logging, configuration, exit codes and a dry run.',
    inputs: [
      { id: 'tool_name', label: 'Tool name', control: 'text', default: 'estate-tool' },
      { id: 'summary', label: 'What it does', control: 'text', default: 'Reports on and tidies up the estate inventory' },
      { id: 'subcommands', label: 'Subcommands', control: 'text', default: 'report, sync, validate', hint: 'Comma separated — leave empty for a single-purpose tool' },
      { id: 'config_file', label: 'Read a configuration file', control: 'select', default: 'json', options: [
        { value: 'json', label: 'JSON' },
        { value: 'ini', label: 'INI — configparser, no dependency' },
        { value: 'none', label: 'Arguments only' },
      ] },
      { id: 'env_prefix', label: 'Environment variable prefix', control: 'text', default: 'ESTATE', hint: 'ESTATE_API_TOKEN and so on — where secrets come from' },
      { id: 'dry_run', label: 'Include --dry-run', control: 'toggle', default: true },
      { id: 'output_format', label: 'Output', control: 'select', default: 'both', options: [
        { value: 'both', label: 'Table by default, --json when something else reads it' },
        { value: 'json', label: 'JSON only' },
        { value: 'text', label: 'Text only' },
      ] },
    ],
    script: (values: BlueprintValues): Script => {
      const tool = identifier(str(values, 'tool_name', 'tool'), 'tool');
      const module = snake(tool, 'tool');
      const subcommands = listOf(str(values, 'subcommands', ''));
      const config = str(values, 'config_file', 'json');
      const envPrefix = identifier(str(values, 'env_prefix', 'APP'), 'APP').toUpperCase().replace(/-/g, '_');
      const dryRun = bool(values, 'dry_run', true);
      const outputFormat = str(values, 'output_format', 'both');
      const findings: Finding[] = [];
      if (!dryRun && subcommands.some((s) => /sync|apply|delete|clean|fix/i.test(s))) {
        findings.push(
          warning('scripts.py.no-dry-run-subcommand', 'One of the subcommands sounds like it changes something, and there is no --dry-run. That flag is what makes a tool safe to try.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `${tool} — ${str(values, 'summary', 'a command line tool')}`,
        effect: dryRun ? 'idempotent' : 'read',
        requires: [{ what: 'Python 3.9 or later' }, { what: 'Nothing else — standard library only' }],
        parameters: [
          ...(subcommands.length > 0 ? [{ name: subcommands.join(' | '), description: 'Which job to do.', required: true }] : []),
          ...(config !== 'none' ? [{ name: '--config', description: 'Path to the configuration file.', required: false }] : []),
          ...(dryRun ? [{ name: '--dry-run', description: 'Report what would happen and change nothing.', required: false }] : []),
          { name: '--verbose', description: 'Debug logging.', required: false },
          ...(outputFormat === 'both' ? [{ name: '--json', description: 'Machine-readable output.', required: false }] : []),
        ],
        notes: [
          'Logging goes to stderr and results go to stdout. That separation is what lets the output be piped into something else while the log is still visible.',
          `Secrets come from the environment — ${envPrefix}_API_TOKEN and so on — never from an argument. An argument is visible in the process list and in shell history.`,
          'main() returns an exit code: 0 for success, 1 for a handled failure, 2 for bad arguments. Anything that runs this from a pipeline depends on that.',
          ...(config !== 'none' ? ['Configuration is layered: defaults, then the file, then the environment, then the arguments. The one closest to the command line wins.'] : []),
        ],
        usage: [
          `python3 ${module}.py --help`,
          ...(subcommands.length > 0 ? [`python3 ${module}.py ${subcommands[0]} --verbose`] : [`python3 ${module}.py --verbose`]),
          ...(dryRun ? [`python3 ${module}.py ${subcommands[1] ?? ''} --dry-run`.replace(/\s+/g, ' ')] : []),
          `${envPrefix}_API_TOKEN=... python3 ${module}.py ${subcommands[0] ?? ''}`.replace(/\s+$/, ''),
        ],
        undo: dryRun
          ? ['What there is to undo depends on what the subcommands end up doing. Write it here as they are filled in.', 'Until then: --dry-run changes nothing, so it is always safe.']
          : ['Nothing to undo — this skeleton reads and reports.'],
        body: [
          ...preamble(
            [
              'import os',
              ...(config === 'json' ? ['import json'] : []),
              ...(config === 'ini' ? ['import configparser'] : []),
              'from pathlib import Path',
              'from typing import Any',
            ],
            [`${tool} — ${str(values, 'summary', '')}`, '', 'Generated by ArchToolKit.'],
          ),
          '',
          'DEFAULTS: dict[str, Any] = {',
          '    "timeout": 30,',
          '    "retries": 3,',
          '    "output_dir": "./out",',
          '}',
          '',
          '',
          ...(config !== 'none'
            ? [
                'def load_config(path: Path | None) -> dict[str, Any]:',
                '    """Defaults, then the file, then the environment. Arguments win later."""',
                '    settings = dict(DEFAULTS)',
                '',
                '    if path is not None:',
                '        if not path.exists():',
                '            raise FileNotFoundError(f"No configuration file at {path}")',
                ...(config === 'json'
                  ? [
                      '        with path.open(encoding="utf-8") as handle:',
                      '            settings.update(json.load(handle))',
                    ]
                  : [
                      '        parser = configparser.ConfigParser()',
                      '        parser.read(path)',
                      '        if parser.has_section("main"):',
                      '            settings.update(dict(parser["main"]))',
                    ]),
                '        LOG.debug("Read configuration from %s", path)',
                '',
                '    # The environment overrides the file. Secrets only ever live here.',
                '    for key in list(settings) + ["api_token", "api_url"]:',
                `        env_name = f"${envPrefix}_{key.upper()}"`,
                '        if env_name in os.environ:',
                '            settings[key] = os.environ[env_name]',
                '            if "token" in key or "password" in key or "secret" in key:',
                '                LOG.debug("Read %s from the environment", env_name)',
                '            else:',
                '                LOG.debug("Read %s=%s from the environment", env_name, settings[key])',
                '',
                '    return settings',
                '',
                '',
              ]
            : []),
          ...(outputFormat !== 'text'
            ? [
                'def emit(rows: list[dict[str, Any]], as_json: bool) -> None:',
                '    """Results go to stdout; the log goes to stderr. Keep them apart."""',
                '    if as_json:',
                '        print(json.dumps(rows, indent=2, default=str))',
                '        return',
                '    if not rows:',
                '        print("(nothing to report)")',
                '        return',
                '    headers = list(rows[0])',
                '    widths = {h: max(len(h), *(len(str(r.get(h, ""))) for r in rows)) for h in headers}',
                '    print("  ".join(h.ljust(widths[h]) for h in headers))',
                '    print("  ".join("-" * widths[h] for h in headers))',
                '    for row in rows:',
                '        print("  ".join(str(row.get(h, "")).ljust(widths[h]) for h in headers))',
                '',
                '',
              ]
            : []),
          ...(subcommands.length > 0
            ? subcommands.flatMap((sub) => {
                const fn = snake(sub, 'run');
                const changes = /sync|apply|delete|clean|fix|write|update/i.test(sub);
                return [
                  `def cmd_${fn}(args: argparse.Namespace, settings: dict[str, Any]) -> int:`,
                  `    """${sub[0]?.toUpperCase()}${sub.slice(1)}."""`,
                  `    LOG.info("Running ${sub}")`,
                  ...(changes && dryRun
                    ? [
                        '    if args.dry_run:',
                        `        LOG.info("Dry run: nothing will be changed")`,
                      ]
                    : []),
                  '',
                  '    rows: list[dict[str, Any]] = []',
                  '    # The work goes here. Append a dict per result so the output is',
                  '    # the same shape whatever the subcommand did.',
                  '',
                  ...(outputFormat !== 'text'
                    ? [`    emit(rows, getattr(args, "json", False))`]
                    : ['    for row in rows:', '        print(row)']),
                  '    LOG.info("%d result(s)", len(rows))',
                  '    return 0',
                  '',
                  '',
                ];
              })
            : [
                'def run(args: argparse.Namespace, settings: dict[str, Any]) -> int:',
                '    """The work."""',
                '    rows: list[dict[str, Any]] = []',
                '    # The work goes here.',
                ...(outputFormat !== 'text' ? ['    emit(rows, getattr(args, "json", False))'] : ['    for row in rows:', '        print(row)']),
                '    return 0',
                '',
                '',
              ]),
          'def build_parser() -> argparse.ArgumentParser:',
          '    parser = argparse.ArgumentParser(',
          `        prog=${pyString(module)},`,
          `        description=${pyString(str(values, 'summary', ''))},`,
          '        formatter_class=argparse.ArgumentDefaultsHelpFormatter,',
          '    )',
          '    parser.add_argument("--verbose", action="store_true", help="debug logging")',
          ...(config !== 'none' ? ['    parser.add_argument("--config", type=Path, help="configuration file")'] : []),
          ...(dryRun ? ['    parser.add_argument("--dry-run", action="store_true", help="report what would happen and change nothing")'] : []),
          ...(outputFormat === 'both' ? ['    parser.add_argument("--json", action="store_true", help="output JSON instead of a table")'] : []),
          '',
          ...(subcommands.length > 0
            ? [
                '    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")',
                ...subcommands.flatMap((name) => [
                  `    p_${snake(name, 'cmd')} = sub.add_parser(${pyString(name)}, help=${pyString(name)})`,
                  `    p_${snake(name, 'cmd')}.set_defaults(func=cmd_${snake(name, 'run')})`,
                ]),
              ]
            : ['    parser.set_defaults(func=run)']),
          '    return parser',
          '',
          '',
          'def main(argv: list[str] | None = None) -> int:',
          '    parser = build_parser()',
          '    args = parser.parse_args(argv)',
          '    configure_logging(args.verbose)',
          '',
          '    try:',
          ...(config !== 'none' ? ['        settings = load_config(args.config)'] : ['        settings = dict(DEFAULTS)']),
          '    except (OSError, ValueError) as exc:',
          '        LOG.error("Configuration: %s", exc)',
          '        return 2',
          '',
          '    try:',
          '        return args.func(args, settings)',
          '    except Exception as exc:  # noqa: BLE001 — the top level reports, it does not hide',
          '        LOG.error("%s", exc)',
          '        LOG.debug("Traceback", exc_info=True)',
          '        return 1',
          ...ENTRY,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'py_csv_transform',
    platform: PLATFORM,
    label: 'CSV read, transform and write',
    group: 'Data',
    description: 'Read a CSV that came from somewhere else, validate it, change it, and write it out — with the encoding, the blank rows and the duplicate handling that make real files different from example ones.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'transform-inventory' },
      { id: 'key_column', label: 'Key column', control: 'text', default: 'Hostname', hint: 'What identifies a row, for duplicate detection' },
      { id: 'required_columns', label: 'Required columns', control: 'text', default: 'Hostname, IPAddress, Owner, Environment' },
      { id: 'operations', label: 'What to do', control: 'select', default: 'clean', options: [
        { value: 'clean', label: 'Clean — trim, normalise case, drop blanks and duplicates' },
        { value: 'join', label: 'Join against a second CSV' },
        { value: 'split', label: 'Split into one file per value of a column' },
        { value: 'aggregate', label: 'Aggregate — count and summarise by a column' },
      ] },
      { id: 'join_file', label: 'Second file', control: 'text', default: 'owners.csv', showWhen: { input: 'operations', equals: ['join'] } },
      { id: 'join_key', label: 'Join on', control: 'text', default: 'Hostname', showWhen: { input: 'operations', equals: ['join'] } },
      { id: 'group_column', label: 'Group by column', control: 'text', default: 'Environment', showWhen: { input: 'operations', equals: ['split', 'aggregate'] } },
      { id: 'duplicates', label: 'Duplicate keys', control: 'select', default: 'first', options: [
        { value: 'first', label: 'Keep the first and report the rest' },
        { value: 'last', label: 'Keep the last' },
        { value: 'error', label: 'Stop — a duplicate is a data problem' },
      ] },
      { id: 'encoding', label: 'Input encoding', control: 'select', default: 'utf-8-sig', options: [
        { value: 'utf-8-sig', label: 'UTF-8, tolerating a byte order mark (what Excel writes)' },
        { value: 'utf-8', label: 'UTF-8, strictly' },
        { value: 'cp1252', label: 'Windows-1252 — an older export' },
      ] },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'transform-csv'), 'transform-csv');
      const module = snake(name, 'transform_csv');
      const key = str(values, 'key_column', 'Hostname');
      const required = listOf(str(values, 'required_columns', ''));
      const operation = str(values, 'operations', 'clean');
      const duplicates = str(values, 'duplicates', 'first');
      const groupColumn = str(values, 'group_column', 'Environment');
      const findings: Finding[] = [];
      if (required.length === 0) {
        findings.push(
          warning('scripts.py.no-required-columns', 'With no required columns the script will happily process a file with the wrong shape and produce output that looks fine.', {
            remediation: 'Name the columns the rest of the work depends on. Failing early on a bad file is the whole point of a validation step.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (key && required.length > 0 && !required.includes(key)) {
        findings.push(error('scripts.py.key-not-required', `The key column "${key}" is not in the required columns, so a file without it would pass validation and then fail on the first row.`, { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `${operation} a CSV, keyed on ${key}`,
        effect: 'idempotent',
        requires: [{ what: 'Python 3.9 or later' }, { what: 'Nothing else — the csv module is standard library' }],
        parameters: [
          { name: 'input', description: 'The CSV to read.', required: true, example: './inventory.csv' },
          { name: '-o, --output', description: 'Where to write. Defaults to input with a suffix.', required: false },
          ...(operation === 'join' ? [{ name: '--second', description: 'The CSV to join against.', required: true }] : []),
          { name: '--dry-run', description: 'Report what would be written and write nothing.', required: false },
        ],
        notes: [
          'The input is never overwritten. The output is a new file, always, because a transform that overwrites its input is one bad run away from losing the original.',
          'Rows that fail validation are collected and reported together at the end rather than stopping on the first one — a file with forty bad rows should tell you about forty, not one.',
          `The encoding is ${str(values, 'encoding', 'utf-8-sig')}. A CSV exported from Excel usually has a byte order mark, which makes the first column name silently wrong if it is read as plain UTF-8.`,
          ...(duplicates === 'error' ? ['A duplicate key stops the run. That is the right default when the key is supposed to be unique.'] : [`Duplicate keys keep the ${duplicates} occurrence and the rest are reported.`]),
        ],
        usage: [
          `python3 ${module}.py input.csv --dry-run`,
          `python3 ${module}.py input.csv -o cleaned.csv`,
          ...(operation === 'join' ? [`python3 ${module}.py input.csv --second ${str(values, 'join_file', 'other.csv')} -o joined.csv`] : []),
        ],
        undo: ['The input file is untouched, so there is nothing to undo — delete the output and run it again.'],
        body: [
          ...preamble(
            ['import csv', 'from collections import Counter, defaultdict', 'from pathlib import Path', 'from typing import Any'],
            [`Read a CSV, ${operation} it, and write a new one.`, '', 'The input is never modified.', '', 'Generated by ArchToolKit.'],
          ),
          '',
          `REQUIRED_COLUMNS = [${required.map((c) => pyString(c)).join(', ')}]`,
          `KEY_COLUMN = ${pyString(key)}`,
          `ENCODING = ${pyString(str(values, 'encoding', 'utf-8-sig'))}`,
          '',
          '',
          'def read_rows(path: Path) -> tuple[list[dict[str, str]], list[str]]:',
          '    """Read the file and check its shape before anything else looks at it."""',
          '    with path.open(newline="", encoding=ENCODING) as handle:',
          '        reader = csv.DictReader(handle)',
          '        if reader.fieldnames is None:',
          '            raise ValueError(f"{path} is empty")',
          '        # Strip whitespace from the headers. Exports routinely have it,',
          '        # and a trailing space makes a column name silently not match.',
          '        fields = [(name or "").strip() for name in reader.fieldnames]',
          '        missing = [c for c in REQUIRED_COLUMNS if c not in fields]',
          '        if missing:',
          '            raise ValueError(f"{path} is missing these columns: {\', \'.join(missing)}")',
          '        rows = []',
          '        for raw in reader:',
          '            row = {(k or "").strip(): (v or "").strip() for k, v in raw.items()}',
          '            if not any(row.values()):',
          '                continue  # a wholly blank line, which exports add at the end',
          '            rows.append(row)',
          '    LOG.info("Read %d rows from %s", len(rows), path)',
          '    return rows, fields',
          '',
          '',
          'def validate(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], list[str]]:',
          '    """Collect every problem, rather than stopping at the first."""',
          '    good: list[dict[str, str]] = []',
          '    problems: list[str] = []',
          '    seen: dict[str, int] = {}',
          '',
          '    for number, row in enumerate(rows, start=2):  # 2: row 1 is the header',
          '        empty = [c for c in REQUIRED_COLUMNS if not row.get(c)]',
          '        if empty:',
          '            problems.append(f"row {number}: empty {\', \'.join(empty)}")',
          '            continue',
          '',
          '        key = row[KEY_COLUMN].lower()',
          '        if key in seen:',
          ...(duplicates === 'error'
            ? ['            raise ValueError(f"row {number}: duplicate {KEY_COLUMN} {row[KEY_COLUMN]!r}, first seen on row {seen[key]}")']
            : duplicates === 'last'
              ? [
                  '            problems.append(f"row {number}: duplicate {row[KEY_COLUMN]!r}, replacing row {seen[key]}")',
                  '            good = [r for r in good if r[KEY_COLUMN].lower() != key]',
                ]
              : ['            problems.append(f"row {number}: duplicate {row[KEY_COLUMN]!r}, keeping row {seen[key]}")', '            continue']),
          '        seen[key] = number',
          '        good.append(row)',
          '',
          '    return good, problems',
          '',
          '',
          ...(operation === 'clean'
            ? [
                'def transform(rows: list[dict[str, str]]) -> list[dict[str, str]]:',
                '    """Normalise the values that are always inconsistent in a real export."""',
                '    for row in rows:',
                '        if KEY_COLUMN in row:',
                '            row[KEY_COLUMN] = row[KEY_COLUMN].lower()',
                '        for column, value in list(row.items()):',
                '            row[column] = " ".join(value.split())  # collapse internal whitespace',
                '    return sorted(rows, key=lambda r: r.get(KEY_COLUMN, ""))',
                '',
                '',
              ]
            : operation === 'join'
              ? [
                  'def transform(rows: list[dict[str, str]], second: Path) -> list[dict[str, str]]:',
                  '    """Left join: every input row survives, whether it matched or not."""',
                  `    join_key = ${pyString(str(values, 'join_key', 'Hostname'))}`,
                  '    with second.open(newline="", encoding=ENCODING) as handle:',
                  '        lookup = {',
                  '            (row.get(join_key) or "").strip().lower(): row',
                  '            for row in csv.DictReader(handle)',
                  '        }',
                  '    LOG.info("Read %d rows from %s", len(lookup), second)',
                  '',
                  '    matched = 0',
                  '    for row in rows:',
                  '        other = lookup.get(row.get(join_key, "").lower())',
                  '        if other:',
                  '            matched += 1',
                  '            for column, value in other.items():',
                  '                if column != join_key and column not in row:',
                  '                    row[column] = value',
                  '        else:',
                  '            LOG.debug("No match for %s", row.get(join_key))',
                  '    LOG.info("%d of %d rows matched", matched, len(rows))',
                  '    return rows',
                  '',
                  '',
                ]
              : operation === 'split'
                ? [
                    'def transform(rows: list[dict[str, str]]) -> dict[str, list[dict[str, str]]]:',
                    '    """One group per distinct value, so each becomes its own file."""',
                    `    column = ${pyString(groupColumn)}`,
                    '    groups: dict[str, list[dict[str, str]]] = defaultdict(list)',
                    '    for row in rows:',
                    '        groups[row.get(column) or "unset"].append(row)',
                    '    LOG.info("%d groups by %s", len(groups), column)',
                    '    return dict(groups)',
                    '',
                    '',
                  ]
                : [
                    'def transform(rows: list[dict[str, str]]) -> list[dict[str, Any]]:',
                    '    """Count by the grouping column, most common first."""',
                    `    column = ${pyString(groupColumn)}`,
                    '    counts = Counter(row.get(column) or "unset" for row in rows)',
                    '    total = sum(counts.values())',
                    '    return [',
                    '        {',
                    '            column: value,',
                    '            "Count": count,',
                    '            "Percent": round(count / total * 100, 1) if total else 0,',
                    '        }',
                    '        for value, count in counts.most_common()',
                    '    ]',
                    '',
                    '',
                  ]),
          'def write_rows(rows: list[dict[str, Any]], path: Path, dry_run: bool) -> None:',
          '    if not rows:',
          '        LOG.warning("Nothing to write")',
          '        return',
          '    if dry_run:',
          '        LOG.info("Dry run: would write %d rows to %s", len(rows), path)',
          '        for row in rows[:5]:',
          '            LOG.info("  %s", row)',
          '        if len(rows) > 5:',
          '            LOG.info("  ... and %d more", len(rows) - 5)',
          '        return',
          '',
          '    path.parent.mkdir(parents=True, exist_ok=True)',
          '    # Write to a temporary file and move it into place, so an interrupted',
          '    # run does not leave a half-written CSV that looks complete.',
          '    temporary = path.with_suffix(path.suffix + ".tmp")',
          '    with temporary.open("w", newline="", encoding="utf-8") as handle:',
          '        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))',
          '        writer.writeheader()',
          '        writer.writerows(rows)',
          '    temporary.replace(path)',
          '    LOG.info("Wrote %d rows to %s", len(rows), path)',
          '',
          '',
          'def main(argv: list[str] | None = None) -> int:',
          '    parser = argparse.ArgumentParser(',
          `        description=${pyString(`Read a CSV, ${operation} it, write a new one`)},`,
          '        formatter_class=argparse.ArgumentDefaultsHelpFormatter,',
          '    )',
          '    parser.add_argument("input", type=Path, help="the CSV to read")',
          '    parser.add_argument("-o", "--output", type=Path, help="where to write")',
          ...(operation === 'join' ? ['    parser.add_argument("--second", type=Path, required=True, help="the CSV to join against")'] : []),
          '    parser.add_argument("--dry-run", action="store_true", help="report and write nothing")',
          '    parser.add_argument("--verbose", action="store_true")',
          '    args = parser.parse_args(argv)',
          '    configure_logging(args.verbose)',
          '',
          '    try:',
          '        rows, _fields = read_rows(args.input)',
          '        rows, problems = validate(rows)',
          '        for problem in problems:',
          '            LOG.warning("%s", problem)',
          '        if problems:',
          '            LOG.warning("%d row(s) had problems", len(problems))',
          '        if not rows:',
          '            LOG.error("No usable rows after validation")',
          '            return 1',
          '',
          ...(operation === 'split'
            ? [
                '        groups = transform(rows)',
                '        base = args.output or args.input.with_suffix("")',
                '        for value, group in sorted(groups.items()):',
                '            safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in value)',
                '            write_rows(group, Path(f"{base}-{safe}.csv"), args.dry_run)',
              ]
            : operation === 'join'
              ? [
                  '        result = transform(rows, args.second)',
                  '        output = args.output or args.input.with_name(args.input.stem + "-joined.csv")',
                  '        write_rows(result, output, args.dry_run)',
                ]
              : [
                  '        result = transform(rows)',
                  `        output = args.output or args.input.with_name(args.input.stem + ${pyString(`-${operation}d.csv`)})`,
                  '        write_rows(result, output, args.dry_run)',
                ]),
          '    except (OSError, ValueError) as exc:',
          '        LOG.error("%s", exc)',
          '        return 1',
          '',
          '    return 0',
          ...ENTRY,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'py_api_client',
    platform: PLATFORM,
    label: 'REST API client with retries and paging',
    group: 'Integration',
    description: 'Talk to an API the way it needs to be talked to: authenticated from the environment, retried with backoff, paged to the end, and rate-limit aware.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'fetch-inventory' },
      { id: 'base_url', label: 'Base URL', control: 'text', default: 'https://api.example.com/v1' },
      { id: 'auth', label: 'Authentication', control: 'select', default: 'bearer', options: [
        { value: 'bearer', label: 'Bearer token from the environment' },
        { value: 'basic', label: 'Basic, username and password from the environment' },
        { value: 'header', label: 'A custom header' },
        { value: 'none', label: 'None' },
      ] },
      { id: 'env_var', label: 'Environment variable', control: 'text', default: 'API_TOKEN', showWhen: { input: 'auth', notEquals: ['none'] } },
      { id: 'header_name', label: 'Header name', control: 'text', default: 'X-API-Key', showWhen: { input: 'auth', equals: ['header'] } },
      { id: 'endpoint', label: 'Endpoint', control: 'text', default: '/devices' },
      { id: 'paging', label: 'Paging', control: 'select', default: 'offset', options: [
        { value: 'offset', label: 'Offset and limit' },
        { value: 'cursor', label: 'A cursor in the response' },
        { value: 'link', label: 'A Link header, the GitHub style' },
        { value: 'none', label: 'One response, no paging' },
      ] },
      { id: 'library', label: 'HTTP library', control: 'select', default: 'urllib', options: [
        { value: 'urllib', label: 'urllib — standard library, nothing to install' },
        { value: 'requests', label: 'requests — needs installing, nicer to extend' },
      ] },
      { id: 'retries', label: 'Retries', control: 'number', default: 3, min: 0, max: 10 },
      { id: 'output', label: 'Write to', control: 'select', default: 'json', options: [
        { value: 'json', label: 'A JSON file' },
        { value: 'csv', label: 'A CSV file' },
        { value: 'stdout', label: 'Standard output' },
      ] },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'api-client'), 'api-client');
      const module = snake(name, 'api_client');
      const auth = str(values, 'auth', 'bearer');
      const envVar = identifier(str(values, 'env_var', 'API_TOKEN'), 'API_TOKEN').toUpperCase().replace(/-/g, '_');
      const paging = str(values, 'paging', 'offset');
      const useRequests = str(values, 'library', 'urllib') === 'requests';
      const retries = num(values, 'retries', 3);
      const baseUrl = str(values, 'base_url', '');
      const output = str(values, 'output', 'json');
      const findings: Finding[] = [];
      if (baseUrl.startsWith('http://')) {
        findings.push(
          error('scripts.py.http-api', 'The base URL is plain HTTP, so the token is sent in clear on every request and can be read by anything on the path.', {
            remediation: 'Use HTTPS.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (retries === 0) {
        findings.push(warning('scripts.py.no-retries', 'With no retries a single transient failure — a 502 from a load balancer, a dropped connection — fails the whole run. Three retries with backoff costs nothing when things are working.', { source: 'ArchToolKit' }));
      }
      if (paging === 'none') {
        findings.push(
          warning('scripts.py.no-paging', 'Without paging this reads the first response and stops. Most APIs cap a page at 100 items and say nothing about it, so the script quietly returns a subset that looks like the whole set.', {
            remediation: 'Check the API documentation for how it pages before deciding it does not.',
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Fetch ${str(values, 'endpoint', '/items')} from ${baseUrl || 'an API'}, paged and retried`,
        effect: 'read',
        requires: [
          { what: 'Python 3.9 or later' },
          ...(useRequests ? [{ what: 'requests', how: 'pip install requests' }] : [{ what: 'Nothing else — urllib is standard library' }]),
          ...(auth !== 'none' ? [{ what: `The ${envVar} environment variable`, how: `export ${envVar}=...   # never on the command line` }] : []),
        ],
        parameters: [
          { name: '--endpoint', description: 'The path to fetch, under the base URL.', required: false },
          { name: '--limit', description: 'Stop after this many items. Useful while testing.', required: false },
          ...(output !== 'stdout' ? [{ name: '-o, --output', description: 'Where to write the results.', required: false }] : []),
        ],
        notes: [
          `The token comes from ${envVar}. It is never a command line argument, because an argument is visible in the process list and in shell history.`,
          `Retries use exponential backoff and only retry what is worth retrying — 429, 502, 503, 504 and connection errors. A 401 or a 404 fails immediately, because retrying those just wastes time.`,
          'A 429 with a Retry-After header is honoured. Ignoring it is how a script gets an API key blocked.',
          ...(paging !== 'none' ? ['Paging continues until the API stops returning items, with a safety limit so a paging bug cannot loop for ever.'] : []),
          'The token is never logged, even at debug level. The URL is, so check the endpoint does not carry anything secret in the query string.',
        ],
        usage: [
          `export ${envVar}=...`,
          `python3 ${module}.py --verbose`,
          `python3 ${module}.py --limit 10 --verbose`,
          ...(output !== 'stdout' ? [`python3 ${module}.py -o results.${output}`] : []),
        ],
        undo: ['Nothing to undo — it reads.'],
        body: [
          ...preamble(
            [
              'import json',
              'import os',
              'import time',
              ...(useRequests ? ['', 'import requests'] : ['import urllib.error', 'import urllib.parse', 'import urllib.request']),
              ...(output === 'csv' ? ['import csv'] : []),
              'from pathlib import Path',
              'from typing import Any',
            ],
            [`Fetch ${str(values, 'endpoint', '')} from ${baseUrl}.`, '', 'Authentication comes from the environment. Retries are bounded and backed off.', '', 'Generated by ArchToolKit.'],
          ),
          '',
          `BASE_URL = ${pyString(baseUrl.replace(/\/$/, ''))}`,
          `MAX_RETRIES = ${retries}`,
          'RETRY_ON = {429, 500, 502, 503, 504}',
          'PAGE_SIZE = 100',
          'MAX_PAGES = 1000  # a paging bug should stop, not loop for ever',
          '',
          '',
          'def auth_headers() -> dict[str, str]:',
          '    """Read credentials from the environment. Never from an argument."""',
          '    headers = {"Accept": "application/json", "User-Agent": "archtoolkit/1.0"}',
          ...(auth === 'bearer'
            ? [
                `    token = os.environ.get(${pyString(envVar)})`,
                '    if not token:',
                `        raise RuntimeError(f"Set ${envVar} before running this")`,
                '    headers["Authorization"] = f"Bearer {token}"',
              ]
            : auth === 'basic'
              ? [
                  '    import base64',
                  '',
                  `    user = os.environ.get(${pyString(`${envVar}_USER`)})`,
                  `    password = os.environ.get(${pyString(`${envVar}_PASSWORD`)})`,
                  '    if not user or not password:',
                  `        raise RuntimeError("Set ${envVar}_USER and ${envVar}_PASSWORD before running this")`,
                  '    encoded = base64.b64encode(f"{user}:{password}".encode()).decode()',
                  '    headers["Authorization"] = f"Basic {encoded}"',
                ]
              : auth === 'header'
                ? [
                    `    token = os.environ.get(${pyString(envVar)})`,
                    '    if not token:',
                    `        raise RuntimeError(f"Set ${envVar} before running this")`,
                    `    headers[${pyString(str(values, 'header_name', 'X-API-Key'))}] = token`,
                  ]
                : []),
          '    return headers',
          '',
          '',
          'def fetch(url: str, headers: dict[str, str]) -> tuple[dict[str, Any], dict[str, str]]:',
          '    """One request, retried on the failures that are worth retrying."""',
          '    delay = 1.0',
          '    last_error: str = ""',
          '',
          '    for attempt in range(1, MAX_RETRIES + 2):',
          '        LOG.debug("GET %s (attempt %d)", url, attempt)',
          '        try:',
          ...(useRequests
            ? [
                '            response = requests.get(url, headers=headers, timeout=30)',
                '            status = response.status_code',
                '            if status == 200:',
                '                return response.json(), dict(response.headers)',
                '            if status not in RETRY_ON:',
                '                raise RuntimeError(f"{status} from {url}: {response.text[:200]}")',
                '            retry_after = response.headers.get("Retry-After")',
                '            last_error = f"{status} from {url}"',
              ]
            : [
                '            request = urllib.request.Request(url, headers=headers, method="GET")',
                '            with urllib.request.urlopen(request, timeout=30) as response:',
                '                payload = json.loads(response.read().decode("utf-8"))',
                '                return payload, dict(response.headers)',
                '        except urllib.error.HTTPError as exc:',
                '            status = exc.code',
                '            if status not in RETRY_ON:',
                '                detail = exc.read().decode("utf-8", "replace")[:200]',
                '                raise RuntimeError(f"{status} from {url}: {detail}") from exc',
                '            retry_after = exc.headers.get("Retry-After")',
                '            last_error = f"{status} from {url}"',
                '        except urllib.error.URLError as exc:',
                '            retry_after = None',
                '            last_error = f"{exc.reason} from {url}"',
              ]),
          ...(useRequests
            ? [
                '        except requests.RequestException as exc:',
                '            retry_after = None',
                '            last_error = str(exc)',
              ]
            : []),
          '',
          '        if attempt > MAX_RETRIES:',
          '            break',
          '',
          '        # Honour Retry-After when the server sends one. Ignoring it is how',
          '        # a key gets blocked.',
          '        wait = float(retry_after) if retry_after and str(retry_after).isdigit() else delay',
          '        LOG.warning("%s — retrying in %.1fs", last_error, wait)',
          '        time.sleep(wait)',
          '        delay = min(delay * 2, 60)',
          '',
          '    raise RuntimeError(f"Gave up after {MAX_RETRIES} retries: {last_error}")',
          '',
          '',
          'def fetch_all(endpoint: str, headers: dict[str, str], limit: int | None) -> list[dict[str, Any]]:',
          '    """Page to the end, or to the limit, whichever comes first."""',
          '    items: list[dict[str, Any]] = []',
          ...(paging === 'none'
            ? [
                '    payload, _headers = fetch(f"{BASE_URL}{endpoint}", headers)',
                '    found = payload if isinstance(payload, list) else payload.get("data", payload.get("items", []))',
                '    items.extend(found)',
              ]
            : paging === 'offset'
              ? [
                  '    offset = 0',
                  '    for page in range(MAX_PAGES):',
                  '        url = f"{BASE_URL}{endpoint}?limit={PAGE_SIZE}&offset={offset}"',
                  '        payload, _headers = fetch(url, headers)',
                  '        found = payload if isinstance(payload, list) else payload.get("data", payload.get("items", []))',
                  '        if not found:',
                  '            break',
                  '        items.extend(found)',
                  '        LOG.info("Page %d: %d items (%d so far)", page + 1, len(found), len(items))',
                  '        if limit and len(items) >= limit:',
                  '            break',
                  '        if len(found) < PAGE_SIZE:',
                  '            break  # a short page is the last page',
                  '        offset += PAGE_SIZE',
                ]
              : paging === 'cursor'
                ? [
                    '    cursor: str | None = None',
                    '    for page in range(MAX_PAGES):',
                    '        url = f"{BASE_URL}{endpoint}?limit={PAGE_SIZE}"',
                    '        if cursor:',
                    '            url += f"&cursor={urllib.parse.quote(cursor)}"',
                    '        payload, _headers = fetch(url, headers)',
                    '        found = payload.get("data", payload.get("items", []))',
                    '        items.extend(found)',
                    '        LOG.info("Page %d: %d items (%d so far)", page + 1, len(found), len(items))',
                    '        cursor = payload.get("next_cursor") or payload.get("nextCursor")',
                    '        if not cursor or (limit and len(items) >= limit):',
                    '            break',
                  ]
                : [
                    '    url: str | None = f"{BASE_URL}{endpoint}?per_page={PAGE_SIZE}"',
                    '    for page in range(MAX_PAGES):',
                    '        if url is None:',
                    '            break',
                    '        payload, response_headers = fetch(url, headers)',
                    '        found = payload if isinstance(payload, list) else payload.get("items", [])',
                    '        items.extend(found)',
                    '        LOG.info("Page %d: %d items (%d so far)", page + 1, len(found), len(items))',
                    '        if limit and len(items) >= limit:',
                    '            break',
                    '        url = None',
                    '        for part in response_headers.get("Link", "").split(","):',
                    '            if \'rel="next"\' in part:',
                    '                url = part.split(";")[0].strip().strip("<>")',
                    '                break',
                  ]),
          '',
          '    if limit:',
          '        items = items[:limit]',
          '    LOG.info("%d items in total", len(items))',
          '    return items',
          '',
          '',
          'def main(argv: list[str] | None = None) -> int:',
          '    parser = argparse.ArgumentParser(',
          `        description=${pyString(`Fetch from ${baseUrl}`)},`,
          '        formatter_class=argparse.ArgumentDefaultsHelpFormatter,',
          '    )',
          `    parser.add_argument("--endpoint", default=${pyString(str(values, 'endpoint', '/items'))})`,
          '    parser.add_argument("--limit", type=int, help="stop after this many items")',
          ...(output !== 'stdout' ? [`    parser.add_argument("-o", "--output", type=Path, default=Path(${pyString(`results.${output}`)}))`] : []),
          '    parser.add_argument("--verbose", action="store_true")',
          '    args = parser.parse_args(argv)',
          '    configure_logging(args.verbose)',
          '',
          '    try:',
          '        headers = auth_headers()',
          '        items = fetch_all(args.endpoint, headers, args.limit)',
          '    except (RuntimeError, OSError) as exc:',
          '        LOG.error("%s", exc)',
          '        return 1',
          '',
          '    if not items:',
          '        LOG.warning("Nothing came back")',
          '        return 0',
          '',
          ...(output === 'json'
            ? [
                '    args.output.write_text(json.dumps(items, indent=2, default=str), encoding="utf-8")',
                '    LOG.info("Wrote %d items to %s", len(items), args.output)',
              ]
            : output === 'csv'
              ? [
                  '    columns: list[str] = []',
                  '    for item in items:',
                  '        for key in item:',
                  '            if key not in columns:',
                  '                columns.append(key)',
                  '    with args.output.open("w", newline="", encoding="utf-8") as handle:',
                  '        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")',
                  '        writer.writeheader()',
                  '        for item in items:',
                  '            writer.writerow({c: item.get(c, "") for c in columns})',
                  '    LOG.info("Wrote %d rows to %s", len(items), args.output)',
                ]
              : ['    print(json.dumps(items, indent=2, default=str))']),
          '',
          '    return 0',
          ...ENTRY,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'py_log_parser',
    platform: PLATFORM,
    label: 'Log parser and summary',
    group: 'Data',
    description: 'Read logs that are too big to open, pull out what matters, and produce the summary that answers "what changed" rather than a wall of lines.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'summarise-logs' },
      { id: 'format', label: 'Log format', control: 'select', default: 'apache', options: [
        { value: 'apache', label: 'Apache or nginx combined' },
        { value: 'syslog', label: 'Syslog' },
        { value: 'json', label: 'One JSON object per line' },
        { value: 'custom', label: 'A regular expression of my own' },
      ] },
      { id: 'pattern', label: 'Pattern', control: 'text', default: '^(?P<timestamp>\\S+)\\s+(?P<level>\\w+)\\s+(?P<message>.*)$', showWhen: { input: 'format', equals: ['custom'] } },
      { id: 'group_by', label: 'Group by', control: 'text', default: 'status', hint: 'A named group from the pattern, or a JSON field' },
      { id: 'filter_expression', label: 'Only lines where', control: 'text', default: '', hint: 'e.g. status >= 500 — empty for everything' },
      { id: 'top', label: 'Show the top', control: 'number', default: 20, min: 1, max: 500 },
      { id: 'compressed', label: 'Read .gz files too', control: 'toggle', default: true },
      { id: 'time_buckets', label: 'Also break it down over time', control: 'toggle', default: true },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'summarise-logs'), 'summarise-logs');
      const module = snake(name, 'summarise_logs');
      const format = str(values, 'format', 'apache');
      const groupBy = str(values, 'group_by', 'status');
      const findings: Finding[] = [];
      if (format === 'custom' && !str(values, 'pattern', '').includes('(?P<')) {
        findings.push(
          error('scripts.py.no-named-groups', 'A custom pattern needs named groups — (?P<name>...) — because that is what the rest of the script reads the fields out of.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Summarise ${format} logs, grouped by ${groupBy}`,
        effect: 'read',
        requires: [{ what: 'Python 3.9 or later' }, { what: 'Nothing else — standard library only' }],
        parameters: [
          { name: 'paths', description: 'Log files or directories. Directories are searched.', required: true, example: '/var/log/nginx/' },
          { name: '--since', description: 'Ignore anything before this time.', required: false, example: '2026-09-01' },
          { name: '--top', description: 'How many rows in each summary.', required: false },
        ],
        notes: [
          'Files are read a line at a time, never loaded into memory. A 40GB log works exactly like a 40KB one, just slower.',
          'Lines that do not match the pattern are counted and reported rather than silently dropped — a high unmatched count usually means the format changed, which is worth knowing.',
          ...(bool(values, 'compressed', true) ? ['Rotated .gz files are read too, so a week of history works without decompressing anything first.'] : []),
          ...(bool(values, 'time_buckets', true) ? ['The hourly breakdown is what turns "500 errors: 12,000" into "all of them between 02:00 and 02:10".'] : []),
        ],
        usage: [
          `python3 ${module}.py /var/log/nginx/access.log`,
          `python3 ${module}.py /var/log/nginx/ --top 50`,
          `python3 ${module}.py /var/log/ --since 2026-09-01 --verbose`,
        ],
        undo: ['Nothing to undo — it reads.'],
        body: [
          ...preamble(
            ['import gzip', 'import re', ...(format === 'json' ? ['import json'] : []), 'from collections import Counter, defaultdict', 'from datetime import datetime', 'from pathlib import Path', 'from typing import Any, Iterator'],
            [`Summarise ${format} logs.`, '', 'Reads a line at a time, so file size does not matter.', '', 'Generated by ArchToolKit.'],
          ),
          '',
          ...(format === 'apache'
            ? [
                'PATTERN = re.compile(',
                '    r\'^(?P<ip>\\S+) \\S+ (?P<user>\\S+) \\[(?P<time>[^\\]]+)\\] \'',
                '    r\'"(?P<method>\\S+) (?P<path>\\S+) (?P<protocol>[^"]*)" \'',
                '    r\'(?P<status>\\d{3}) (?P<size>\\S+)\'',
                '    r\'(?: "(?P<referer>[^"]*)" "(?P<agent>[^"]*)")?\'',
                ')',
                'TIME_FORMAT = "%d/%b/%Y:%H:%M:%S %z"',
                'TIME_FIELD = "time"',
              ]
            : format === 'syslog'
              ? [
                  'PATTERN = re.compile(',
                  '    r"^(?P<time>\\w{3}\\s+\\d+\\s[\\d:]+)\\s(?P<host>\\S+)\\s"',
                  '    r"(?P<process>[^\\[:]+)(?:\\[(?P<pid>\\d+)\\])?:\\s(?P<message>.*)$"',
                  ')',
                  'TIME_FORMAT = "%b %d %H:%M:%S"',
                  'TIME_FIELD = "time"',
                ]
              : format === 'json'
                ? ['PATTERN = None', 'TIME_FORMAT = "%Y-%m-%dT%H:%M:%S"', 'TIME_FIELD = "timestamp"']
                : [`PATTERN = re.compile(r${pyString(str(values, 'pattern', ''))})`, 'TIME_FORMAT = "%Y-%m-%dT%H:%M:%S"', 'TIME_FIELD = "timestamp"']),
          '',
          '',
          'def open_log(path: Path):',
          '    """Read plain or gzipped, the same way."""',
          ...(bool(values, 'compressed', true)
            ? [
                '    if path.suffix == ".gz":',
                '        return gzip.open(path, "rt", encoding="utf-8", errors="replace")',
              ]
            : []),
          '    return path.open("r", encoding="utf-8", errors="replace")',
          '',
          '',
          'def find_logs(paths: list[Path]) -> list[Path]:',
          '    found: list[Path] = []',
          '    for path in paths:',
          '        if path.is_dir():',
          '            found.extend(sorted(p for p in path.rglob("*") if p.is_file()))',
          '        elif path.is_file():',
          '            found.append(path)',
          '        else:',
          '            LOG.warning("No such path: %s", path)',
          ...(bool(values, 'compressed', true)
            ? ['    return [p for p in found if p.suffix in (".log", ".gz", ".txt") or p.suffix == ""]']
            : ['    return [p for p in found if p.suffix != ".gz"]']),
          '',
          '',
          'def parse_lines(path: Path) -> Iterator[dict[str, Any]]:',
          '    """One line at a time. Never read a log into memory."""',
          '    with open_log(path) as handle:',
          '        for line in handle:',
          '            line = line.rstrip("\\n")',
          '            if not line:',
          '                continue',
          ...(format === 'json'
            ? [
                '            try:',
                '                yield json.loads(line)',
                '            except json.JSONDecodeError:',
                '                yield {"_unmatched": line}',
              ]
            : [
                '            match = PATTERN.match(line) if PATTERN else None',
                '            if match:',
                '                yield match.groupdict()',
                '            else:',
                '                yield {"_unmatched": line}',
              ]),
          '',
          '',
          'def main(argv: list[str] | None = None) -> int:',
          '    parser = argparse.ArgumentParser(',
          `        description=${pyString(`Summarise ${format} logs`)},`,
          '        formatter_class=argparse.ArgumentDefaultsHelpFormatter,',
          '    )',
          '    parser.add_argument("paths", nargs="+", type=Path, help="files or directories")',
          '    parser.add_argument("--since", help="ignore anything before this (YYYY-MM-DD)")',
          `    parser.add_argument("--top", type=int, default=${num(values, 'top', 20)})`,
          '    parser.add_argument("--verbose", action="store_true")',
          '    args = parser.parse_args(argv)',
          '    configure_logging(args.verbose)',
          '',
          '    since = datetime.fromisoformat(args.since) if args.since else None',
          '    logs = find_logs(args.paths)',
          '    if not logs:',
          '        LOG.error("No log files found")',
          '        return 1',
          '    LOG.info("Reading %d file(s)", len(logs))',
          '',
          `    group_field = ${pyString(groupBy)}`,
          '    groups: Counter[str] = Counter()',
          '    by_hour: dict[str, Counter[str]] = defaultdict(Counter)',
          '    total = 0',
          '    unmatched = 0',
          '',
          '    for path in logs:',
          '        LOG.debug("Reading %s", path)',
          '        for record in parse_lines(path):',
          '            if "_unmatched" in record:',
          '                unmatched += 1',
          '                continue',
          '',
          ...(str(values, 'filter_expression', '')
            ? [
                '            # Filter: ' + str(values, 'filter_expression', ''),
                '            # Adjust this condition to match the field names above.',
                '            try:',
                '                if int(record.get("status", 0)) < 500:',
                '                    continue',
                '            except (TypeError, ValueError):',
                '                pass',
                '',
              ]
            : []),
          '            stamp = None',
          '            raw_time = record.get(TIME_FIELD)',
          '            if raw_time:',
          '                try:',
          '                    stamp = datetime.strptime(str(raw_time), TIME_FORMAT)',
          '                except ValueError:',
          '                    try:',
          '                        stamp = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00"))',
          '                    except ValueError:',
          '                        stamp = None',
          '',
          '            if since and stamp and stamp.replace(tzinfo=None) < since:',
          '                continue',
          '',
          '            total += 1',
          '            value = str(record.get(group_field, "(missing)"))',
          '            groups[value] += 1',
          ...(bool(values, 'time_buckets', true)
            ? [
                '            if stamp:',
                '                by_hour[stamp.strftime("%Y-%m-%d %H:00")][value] += 1',
              ]
            : []),
          '',
          '    print(f"{total:,} matching lines, {unmatched:,} unparsed")',
          '    if unmatched > total * 0.1 and total:',
          '        LOG.warning(',
          '            "%.0f%% of lines did not match the pattern — the format may have changed",',
          '            unmatched / (total + unmatched) * 100,',
          '        )',
          '',
          '    print()',
          '    print(f"Top {args.top} by {group_field}:")',
          '    for value, count in groups.most_common(args.top):',
          '        share = count / total * 100 if total else 0',
          '        print(f"  {count:>10,}  {share:>5.1f}%  {value}")',
          '',
          ...(bool(values, 'time_buckets', true)
            ? [
                '    if by_hour:',
                '        print()',
                '        print("By hour:")',
                '        busiest = max(sum(c.values()) for c in by_hour.values())',
                '        for hour in sorted(by_hour):',
                '            count = sum(by_hour[hour].values())',
                '            bar = "#" * int(count / busiest * 40) if busiest else ""',
                '            print(f"  {hour}  {count:>8,}  {bar}")',
                '',
              ]
            : []),
          '    return 0',
          ...ENTRY,
        ],
        findings,
      };
    },
  }),

  scriptBlueprint({
    id: 'py_file_organiser',
    platform: PLATFORM,
    label: 'Find and organise files',
    group: 'Files',
    description: 'Find the duplicates, the huge ones and the ancient ones in a folder nobody can navigate any more — and move them somewhere, safely, if that is what is needed.',
    inputs: [
      { id: 'script_name', label: 'Script name', control: 'text', default: 'tidy-share' },
      { id: 'find', label: 'Find', control: 'select', default: 'duplicates', options: [
        { value: 'duplicates', label: 'Duplicates, by content' },
        { value: 'large', label: 'The largest files' },
        { value: 'old', label: 'Files untouched for a long time' },
        { value: 'by-type', label: 'A breakdown by file type' },
      ] },
      { id: 'min_size_mb', label: 'Ignore files smaller than (MB)', control: 'number', default: 1, min: 0, max: 100000 },
      { id: 'older_than_days', label: 'Older than (days)', control: 'number', default: 730, min: 1, max: 10000, showWhen: { input: 'find', equals: ['old'] } },
      { id: 'action', label: 'Then', control: 'select', default: 'report', options: [
        { value: 'report', label: 'Report only' },
        { value: 'move', label: 'Move them to a holding folder' },
        { value: 'hardlink', label: 'Replace duplicates with hard links' },
      ] },
      { id: 'holding', label: 'Holding folder', control: 'text', default: './to-review', showWhen: { input: 'action', equals: ['move'] } },
      { id: 'exclude', label: 'Skip paths containing', control: 'text', default: '.git, node_modules, $RECYCLE.BIN, System Volume Information' },
    ],
    script: (values: BlueprintValues): Script => {
      const name = identifier(str(values, 'script_name', 'tidy-files'), 'tidy-files');
      const module = snake(name, 'tidy_files');
      const find = str(values, 'find', 'duplicates');
      const action = str(values, 'action', 'report');
      const excludes = listOf(str(values, 'exclude', ''));
      const findings: Finding[] = [];
      if (action === 'hardlink' && find !== 'duplicates') {
        findings.push(error('scripts.py.hardlink-not-duplicates', 'Replacing files with hard links only makes sense for duplicates — the whole point is that the content is identical.', { source: 'ArchToolKit' }));
      }
      if (action === 'hardlink') {
        findings.push(
          warning('scripts.py.hardlink-semantics', 'A hard link means the files are the same file. Editing one edits all of them, and a backup tool may restore only one copy. It saves space and it changes what the files mean.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (action === 'move') {
        findings.push(
          warning('scripts.py.move-breaks-links', 'Moving files breaks anything that referenced them by path — shortcuts, scripts, application configuration. Moving to a holding folder rather than deleting is deliberate, so it can be reversed from the manifest.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Find ${find} files${action === 'report' ? ' and report them' : action === 'move' ? ' and move them for review' : ' and hard link them'}`,
        effect: action === 'report' ? 'read' : 'destructive',
        requires: [
          { what: 'Python 3.9 or later' },
          { what: 'Read access to the folder' },
          ...(action !== 'report' ? [{ what: 'Write access, and a backup you have restored from at least once' }] : []),
        ],
        parameters: [
          { name: 'root', description: 'The folder to walk.', required: true, example: '/mnt/share' },
          { name: '--dry-run', description: 'Report what would happen and change nothing.', required: false },
          { name: '--min-size', description: 'Ignore files below this size, in MB.', required: false },
        ],
        notes: [
          ...(find === 'duplicates'
            ? [
                'Duplicates are found in two passes: group by size first, then hash only the groups with more than one file. Hashing everything would be far slower and would tell you the same thing.',
                'The first file by path is kept and the rest are the duplicates. That is arbitrary but consistent, so a second run makes the same choice.',
              ]
            : []),
          'Symlinks are not followed, so a loop cannot run for ever and a link is not mistaken for the file it points at.',
          'Files that cannot be read are reported, not skipped silently — a permission error on a share usually means something is missing from the report.',
          ...(action !== 'report' ? ['A manifest CSV is written before anything is moved, listing every source and destination. That file is the undo.'] : []),
        ],
        usage: [`python3 ${module}.py /mnt/share --dry-run`, `python3 ${module}.py /mnt/share --min-size 10`, ...(action !== 'report' ? [`python3 ${module}.py /mnt/share`] : [])],
        undo:
          action === 'move'
            ? [
                'The manifest CSV lists every file moved, with its original path.',
                'To put them back: read the manifest and move destination back to source. Nothing is deleted, so nothing is lost.',
              ]
            : action === 'hardlink'
              ? ['A hard link cannot be un-made into separate files without copying one of them back out: cp --remove-destination <link> <link>', 'The manifest lists every file that was linked.']
              : ['Nothing to undo — it reads and reports.'],
        body: [
          ...preamble(
            ['import csv', 'import hashlib', 'import os', 'from collections import defaultdict', 'from datetime import datetime, timedelta', 'from pathlib import Path', 'from typing import Any'],
            [`Find ${find} files under a folder.`, '', 'Two passes by size then hash, symlinks not followed, a manifest before anything moves.', '', 'Generated by ArchToolKit.'],
          ),
          '',
          `EXCLUDE = [${excludes.map((e) => pyString(e)).join(', ')}]`,
          'CHUNK = 1024 * 1024',
          '',
          '',
          'def excluded(path: Path) -> bool:',
          '    text = str(path)',
          '    return any(part in text for part in EXCLUDE)',
          '',
          '',
          'def walk(root: Path, min_bytes: int) -> tuple[list[Path], list[str]]:',
          '    """Every readable file under root, with the ones that were not."""',
          '    files: list[Path] = []',
          '    problems: list[str] = []',
          '    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):',
          '        here = Path(dirpath)',
          '        if excluded(here):',
          '            dirnames[:] = []',
          '            continue',
          '        dirnames[:] = [d for d in dirnames if not excluded(here / d)]',
          '        for filename in filenames:',
          '            path = here / filename',
          '            try:',
          '                if path.is_symlink():',
          '                    continue',
          '                if path.stat().st_size < min_bytes:',
          '                    continue',
          '                files.append(path)',
          '            except OSError as exc:',
          '                problems.append(f"{path}: {exc}")',
          '    return files, problems',
          '',
          '',
          'def digest(path: Path) -> str:',
          '    """Hash in chunks, so a 50GB file does not become 50GB of memory."""',
          '    hasher = hashlib.sha256()',
          '    with path.open("rb") as handle:',
          '        while chunk := handle.read(CHUNK):',
          '            hasher.update(chunk)',
          '    return hasher.hexdigest()',
          '',
          '',
          ...(find === 'duplicates'
            ? [
                'def find_targets(files: list[Path], args: argparse.Namespace) -> list[dict[str, Any]]:',
                '    """Group by size first — hashing everything would be pointless."""',
                '    by_size: dict[int, list[Path]] = defaultdict(list)',
                '    for path in files:',
                '        by_size[path.stat().st_size].append(path)',
                '',
                '    candidates = {size: paths for size, paths in by_size.items() if len(paths) > 1}',
                '    LOG.info("%d size groups worth hashing, out of %d files", len(candidates), len(files))',
                '',
                '    results: list[dict[str, Any]] = []',
                '    for size, paths in candidates.items():',
                '        by_hash: dict[str, list[Path]] = defaultdict(list)',
                '        for path in paths:',
                '            try:',
                '                by_hash[digest(path)].append(path)',
                '            except OSError as exc:',
                '                LOG.warning("Could not hash %s: %s", path, exc)',
                '        for checksum, same in by_hash.items():',
                '            if len(same) < 2:',
                '                continue',
                '            keep, *rest = sorted(same)',
                '            for duplicate in rest:',
                '                results.append(',
                '                    {',
                '                        "Path": str(duplicate),',
                '                        "DuplicateOf": str(keep),',
                '                        "SizeMB": round(size / 1048576, 2),',
                '                        "Checksum": checksum[:16],',
                '                    }',
                '                )',
                '    return results',
                '',
                '',
              ]
            : find === 'large'
              ? [
                  'def find_targets(files: list[Path], args: argparse.Namespace) -> list[dict[str, Any]]:',
                  '    rows = [',
                  '        {',
                  '            "Path": str(path),',
                  '            "SizeMB": round(path.stat().st_size / 1048576, 2),',
                  '            "Modified": datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d"),',
                  '        }',
                  '        for path in files',
                  '    ]',
                  '    return sorted(rows, key=lambda r: r["SizeMB"], reverse=True)[:200]',
                  '',
                  '',
                ]
              : find === 'old'
                ? [
                    'def find_targets(files: list[Path], args: argparse.Namespace) -> list[dict[str, Any]]:',
                    `    cutoff = datetime.now() - timedelta(days=${num(values, 'older_than_days', 730)})`,
                    '    rows = []',
                    '    for path in files:',
                    '        stat = path.stat()',
                    '        modified = datetime.fromtimestamp(stat.st_mtime)',
                    '        if modified >= cutoff:',
                    '            continue',
                    '        rows.append(',
                    '            {',
                    '                "Path": str(path),',
                    '                "SizeMB": round(stat.st_size / 1048576, 2),',
                    '                "Modified": modified.strftime("%Y-%m-%d"),',
                    '                "DaysOld": (datetime.now() - modified).days,',
                    '            }',
                    '        )',
                    '    return sorted(rows, key=lambda r: r["DaysOld"], reverse=True)',
                    '',
                    '',
                  ]
                : [
                    'def find_targets(files: list[Path], args: argparse.Namespace) -> list[dict[str, Any]]:',
                    '    by_type: dict[str, dict[str, float]] = defaultdict(lambda: {"Count": 0, "TotalMB": 0.0})',
                    '    for path in files:',
                    '        suffix = path.suffix.lower() or "(none)"',
                    '        by_type[suffix]["Count"] += 1',
                    '        by_type[suffix]["TotalMB"] += path.stat().st_size / 1048576',
                    '    rows = [',
                    '        {"Extension": suffix, "Count": int(v["Count"]), "TotalMB": round(v["TotalMB"], 1)}',
                    '        for suffix, v in by_type.items()',
                    '    ]',
                    '    return sorted(rows, key=lambda r: r["TotalMB"], reverse=True)',
                    '',
                    '',
                  ]),
          'def main(argv: list[str] | None = None) -> int:',
          '    parser = argparse.ArgumentParser(',
          `        description=${pyString(`Find ${find} files`)},`,
          '        formatter_class=argparse.ArgumentDefaultsHelpFormatter,',
          '    )',
          '    parser.add_argument("root", type=Path, help="the folder to walk")',
          `    parser.add_argument("--min-size", type=float, default=${num(values, 'min_size_mb', 1)}, help="ignore files below this many MB")`,
          '    parser.add_argument("--dry-run", action="store_true", help="report and change nothing")',
          '    parser.add_argument("--verbose", action="store_true")',
          '    args = parser.parse_args(argv)',
          '    configure_logging(args.verbose)',
          '',
          '    if not args.root.is_dir():',
          '        LOG.error("Not a directory: %s", args.root)',
          '        return 2',
          '',
          '    files, problems = walk(args.root, int(args.min_size * 1048576))',
          '    LOG.info("%d files to consider", len(files))',
          '    for problem in problems[:20]:',
          '        LOG.warning("%s", problem)',
          '    if len(problems) > 20:',
          '        LOG.warning("... and %d more unreadable paths", len(problems) - 20)',
          '',
          '    rows = find_targets(files, args)',
          '    if not rows:',
          '        LOG.info("Nothing matched")',
          '        return 0',
          '',
          '    manifest = Path(f"' + module + '-manifest-{:%Y%m%d-%H%M%S}.csv".format(datetime.now()))',
          '    with manifest.open("w", newline="", encoding="utf-8") as handle:',
          '        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))',
          '        writer.writeheader()',
          '        writer.writerows(rows)',
          '    LOG.info("%d rows. Manifest: %s", len(rows), manifest)',
          '',
          '    for row in rows[:20]:',
          '        print("  ".join(f"{k}={v}" for k, v in row.items()))',
          '    if len(rows) > 20:',
          '        print(f"  ... and {len(rows) - 20} more — see {manifest}")',
          '',
          ...(action === 'move'
            ? [
                '    if args.dry_run:',
                '        LOG.info("Dry run: nothing moved")',
                '        return 0',
                '',
                `    holding = Path(${pyString(str(values, 'holding', './to-review'))})`,
                '    holding.mkdir(parents=True, exist_ok=True)',
                '    moved = 0',
                '    for row in rows:',
                '        source = Path(row["Path"])',
                '        # Keep the folder structure under the holding folder, so two',
                '        # files with the same name do not collide.',
                '        try:',
                '            relative = source.relative_to(args.root)',
                '        except ValueError:',
                '            relative = Path(source.name)',
                '        destination = holding / relative',
                '        destination.parent.mkdir(parents=True, exist_ok=True)',
                '        try:',
                '            source.rename(destination)',
                '            moved += 1',
                '        except OSError as exc:',
                '            LOG.warning("Could not move %s: %s", source, exc)',
                '    LOG.info("Moved %d files to %s", moved, holding)',
              ]
            : action === 'hardlink'
              ? [
                  '    if args.dry_run:',
                  '        LOG.info("Dry run: nothing linked")',
                  '        return 0',
                  '',
                  '    linked = 0',
                  '    saved = 0.0',
                  '    for row in rows:',
                  '        duplicate = Path(row["Path"])',
                  '        keep = Path(row["DuplicateOf"])',
                  '        try:',
                  '            if duplicate.stat().st_ino == keep.stat().st_ino:',
                  '                continue  # already the same file',
                  '            temporary = duplicate.with_suffix(duplicate.suffix + ".relinking")',
                  '            duplicate.rename(temporary)',
                  '            os.link(keep, duplicate)',
                  '            temporary.unlink()',
                  '            linked += 1',
                  '            saved += float(row["SizeMB"])',
                  '        except OSError as exc:',
                  '            LOG.warning("Could not link %s: %s", duplicate, exc)',
                  '    LOG.info("Linked %d files, saving about %.1f MB", linked, saved)',
                ]
              : []),
          '',
          '    return 0',
          ...ENTRY,
        ],
        findings,
      };
    },
  }),
];

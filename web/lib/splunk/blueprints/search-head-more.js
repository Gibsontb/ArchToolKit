/**
 * Splunk search head, continued: the knowledge objects and operations that come
 * after the first saved search.
 *
 * Field extractions, KV store lookups, acceleration, risk-based alerting and a
 * platform-health app. All of it search-time. A search head never parses data
 * arriving from a forwarder, so nothing here sets line breaking, timestamps or
 * index-time transforms — the props.conf files below carry EXTRACT-, REPORT-,
 * FIELDALIAS-, EVAL- and LOOKUP- only, which are the settings a search head
 * actually reads.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { currentEstate } from '../../kit/estate-store.js';
import { isWorkload } from '../../vmware/inventory.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, foldSearch, listOf, searchTitle, searchWindow, splunkName, spreadCron,                } from '../splunk.js';

const TIER = 'search_head'         ;

// --- small helpers ----------------------------------------------------------

/** Non-empty, trimmed lines of a textarea. */
function linesOf(value        )           {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** Split "left | right" on the first pipe only, so the right side may contain pipes. */
function splitFirst(line        , separator = '|')                   {
  const at = line.indexOf(separator);
  if (at < 0) return [line.trim(), ''];
  return [line.slice(0, at).trim(), line.slice(at + separator.length).trim()];
}

/** The named groups a PCRE pattern declares, in either spelling. */
function namedGroups(pattern        )           {
  return [...pattern.matchAll(/\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((m) => m[1] ?? '').filter(Boolean);
}

/**
 * A JavaScript approximation of a Splunk (PCRE2) regex, for a build-time smoke
 * test against the sample. Null when the pattern uses something JavaScript does
 * not have — which is not an error, only a pattern this check cannot run.
 */
function jsRegex(pattern        , global = false)                {
  let source = pattern.replace(/\s+in\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, '');
  let flags = global ? 'g' : '';
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    flags += 'i';
  }
  source = source.replace(/\(\?P</g, '(?<');
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Throttle and email lines for an alert, as the reference alert blueprint writes them. */
function alertLines(title        , options                                                                                    )           {
  const fields = listOf(options.throttleFields);
  const perResult = fields.length > 0;
  return [
    'counttype = number of events',
    'relation = greater than',
    'quantity = 0',
    'alert.track = 1',
    `alert.severity = ${options.severity}`,
    ...(perResult
      ? [
          '# Per-result alerting, throttled per affected object. savedsearches.conf.spec:',
          '# alert.suppress.fields is the "list of fields to use when suppressing per-result',
          '# alerts". With alert.digest_mode = 1 (the default) the throttle applies to the',
          '# whole alert: once host A has alerted, host B going silent inside the period is',
          '# suppressed with it. digest_mode = 0 fires once per result row, and the throttle',
          `# then applies per ${fields.join(' + ')} value — one email per affected object per ${options.throttle}.`,
          'alert.digest_mode = 0',
          'alert.suppress = 1',
          `alert.suppress.period = ${options.throttle}`,
          `alert.suppress.fields = ${fields.join(', ')}`,
        ]
      : [
          '# One alert for the whole result set, throttled as a whole: nothing here',
          '# identifies an affected object to throttle on separately.',
          'alert.digest_mode = 1',
          'alert.suppress = 1',
          `alert.suppress.period = ${options.throttle}`,
        ]),
    ...(options.recipients
      ? [
          'action.email = 1',
          `action.email.to = ${options.recipients}`,
          `action.email.subject = [Splunk platform] ${title}${perResult ? `: ${fields.map((f) => `$result.${f}$`).join(' ')}` : ''}`,
          'action.email.format = table',
          'action.email.inline = 1',
          'action.email.sendresults = 1',
          'action.email.include.results_link = 1',
        ]
      : []),
  ];
}

// --- the regex test harness ---------------------------------------------------

/**
 * A Python harness for the extractions, kept with the app so the regexes are
 * tested against real events before they are deployed, and again after every
 * change. It runs under Splunk's own interpreter, so it needs nothing installed.
 */
const HARNESS = String.raw`#!/usr/bin/env python3
"""Run this app's search-time extractions over sample events before deploying them.

Usage (on any machine with Python 3, or on a Splunk host with its bundled interpreter):
    $SPLUNK_HOME/bin/splunk cmd python3 bin/test_extractions.py [sample_file]
    python3 bin/test_extractions.py bin/sample_events.log

What it tests: EXTRACT- regexes, the REPORT- transform (REGEX + FORMAT, or DELIMS)
and FIELDALIAS-. It does not evaluate EVAL- expressions or lookups; check those in
Splunk with | makeresults or against real events.

Python's re is not PCRE2, which is what Splunk uses. (?<name>...) is converted to
(?P<name>...). Atomic groups, possessive quantifiers and \K need Python 3.11 or
later; on an older interpreter the pattern is reported, not mis-tested.

Exit status: 0 when every extraction matched at least one sample event, 1 otherwise.
"""
import json
import re
import sys
from pathlib import Path

CONFIG = json.loads(__CONFIG__)

UNSUPPORTED_BEFORE_311 = [
    (r"\(\?>", "atomic group"),
    (r"[*+?}]\+", "possessive quantifier"),
    (r"\\K", "match reset (\\K)"),
]


def to_python(pattern):
    """PCRE named groups in Python's spelling; everything else unchanged."""
    return re.sub(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>", r"(?P<\1>", pattern)


def compile_or_report(label, pattern, problems):
    if sys.version_info < (3, 11):
        for probe, what in UNSUPPORTED_BEFORE_311:
            if re.search(probe, pattern):
                problems.append(label + ": uses a " + what + ", which this Python cannot test. Check it in Splunk with | rex.")
                return None
    try:
        return re.compile(to_python(pattern))
    except re.error as exc:
        problems.append(label + ": does not compile: " + str(exc))
        return None


def expand_format(fmt, match):
    """FORMAT = $1::$2 or name::$1 name2::$2, applied to one match."""
    if not fmt.strip():
        return {k: [v] for k, v in match.groupdict().items() if v is not None}
    out = {}

    def group(m):
        return match.group(int(m.group(1))) or ""

    for token in fmt.split():
        if "::" not in token:
            continue
        key, value = token.split("::", 1)
        key = re.sub(r"\$(\d+)", group, key)
        value = re.sub(r"\$(\d+)", group, value).strip('"')
        if key:
            out.setdefault(key, []).append(value)
    return out


def split_in(pattern):
    """EXTRACT-x = <regex> in <field> reads another field instead of _raw."""
    m = re.match(r"^(.*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*)\s*$", pattern, re.S)
    return (m.group(1), m.group(2)) if m else (pattern, "_raw")


def source_of(raw, fields, key):
    return raw if key == "_raw" else " ".join(fields.get(key, []))


def main():
    sample = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("sample_events.log")
    # Lines starting with # are comments (the generated file carries a header).
    events = [line for line in sample.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")]
    if not events:
        print("No events in " + str(sample))
        return 1

    problems = []
    extracts = []
    for ext in CONFIG["extract"]:
        pattern, in_field = split_in(ext["regex"])
        extracts.append((ext["name"], in_field, compile_or_report("EXTRACT-" + ext["name"], pattern, problems)))

    report = CONFIG.get("report")
    report_rx = None
    if report and report["mode"] == "regex":
        report_rx = compile_or_report("REPORT-" + report["name"], report["regex"], problems)

    hits = {"EXTRACT-" + name: 0 for name, _, _ in extracts}
    if report:
        hits["REPORT-" + report["name"]] = 0
    fill = {}

    for number, raw in enumerate(events, 1):
        fields = {}
        # 1. EXTRACT-, in lexical order of their class names, as Splunk applies them.
        for name, in_field, rx in sorted(extracts, key=lambda e: e[0]):
            if rx is None:
                continue
            m = rx.search(source_of(raw, fields, in_field))
            if m:
                hits["EXTRACT-" + name] += 1
                for k, v in m.groupdict().items():
                    if v is not None:
                        fields.setdefault(k, []).append(v)
        # 2. REPORT-.
        if report:
            text = source_of(raw, fields, report["source_key"])
            found = {}
            if report["mode"] == "regex" and report_rx is not None:
                for m in report_rx.finditer(text):
                    for k, v in expand_format(report["format"], m).items():
                        found.setdefault(k, []).extend(v)
            elif report["mode"] == "delims":
                pairs = re.split("[" + re.escape(report["pair_delims"]) + "]", text)
                kv = "[" + re.escape(report["kv_delims"]) + "]"
                for pair in pairs:
                    parts = re.split(kv, pair.strip(), maxsplit=1)
                    if len(parts) == 2 and parts[0].strip():
                        found.setdefault(parts[0].strip(), []).append(parts[1].strip().strip('"'))
            if found:
                hits["REPORT-" + report["name"]] += 1
                for k, v in found.items():
                    fields.setdefault(k, []).extend(v)
        # 3. FIELDALIAS-.
        for alias in CONFIG["aliases"]:
            if alias["from"] in fields and (alias["mode"] == "AS" or alias["to"] not in fields):
                fields[alias["to"]] = list(fields[alias["from"]])
        for k in fields:
            fill[k] = fill.get(k, 0) + 1
        if number <= 5:
            print("--- event " + str(number) + ": " + raw[:120])
            for k in sorted(fields):
                print("    " + k + " = " + ", ".join(fields[k]))

    total = len(events)
    print("")
    print("Extractions (events matched of " + str(total) + "):")
    failed = False
    for label, count in hits.items():
        flag = "" if count else "   <-- matched nothing"
        failed = failed or count == 0
        print("  " + label.ljust(40) + str(count).rjust(6) + flag)
    print("")
    print("Field fill rate:")
    for k in sorted(fill, key=lambda f: -fill[f]):
        print("  " + k.ljust(40) + str(round(100.0 * fill[k] / total, 1)).rjust(6) + "%")
    missing = [f for f in CONFIG["expected_fields"] if f not in fill]
    if missing:
        failed = True
        print("")
        print("Expected but never extracted: " + ", ".join(missing))
    if problems:
        failed = True
        print("")
        print("Problems:")
        for p in problems:
            print("  " + p)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
`;

// --- the estate, for the expected-hosts list --------------------------------

/**
 * Powered-on workload VMs of the imported estate, by the name Splunk will most
 * likely see in `host` — the guest's DNS name, short or fully qualified. Null
 * when no estate is loaded.
 */
function estateHostNames(fqdn         )                  {
  const inventory = currentEstate()?.inventory;
  if (!inventory) return null;
  const names = new Set        ();
  for (const vm of inventory.vms) {
    if (!isWorkload(vm) || vm.powerState !== 'poweredOn') continue;
    const name = String(vm.dnsName || vm.name || '')
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) continue;
    names.add(fqdn ? name : (name.split('.')[0] ?? name));
  }
  return [...names].sort();
}

const HTTP_STATUS_ROWS = [
  '200,OK,success',
  '201,Created,success',
  '204,No Content,success',
  '301,Moved Permanently,redirect',
  '302,Found,redirect',
  '304,Not Modified,redirect',
  '400,Bad Request,client_error',
  '401,Unauthorized,client_error',
  '403,Forbidden,client_error',
  '404,Not Found,client_error',
  '409,Conflict,client_error',
  '429,Too Many Requests,client_error',
  '500,Internal Server Error,server_error',
  '502,Bad Gateway,server_error',
  '503,Service Unavailable,server_error',
  '504,Gateway Timeout,server_error',
];

/** Commands that stop a report being accelerated when they come before the first transforming command. */
const NOT_ACCELERABLE = /\|\s*(sort|dedup|eventstats|streamstats|transaction|join|append|appendcols|appendpipe|head|tail|reverse|table|map|inputlookup|loadjob|savedsearch|multisearch|union|localize|delta|accum|autoregress|trendline|fillnull|timechart|chart|stats|top|rare|tstats|rest)\b/i;

/** Aggregations that cannot be re-aggregated from a summary without distortion. */
const NOT_REAGGREGATABLE = /\b(avg|mean|median|mode|dc|distinct_count|estdc|perc\d*|p\d+|exactperc\d*|upperperc\d*|stdev|stdevp|var|varp)\s*\(/i;

export const SEARCH_HEAD_MORE_BLUEPRINTS                             = [
  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_field_extractions',
    tier: TIER,
    label: 'Search-time field extractions',
    group: 'Knowledge objects',
    description:
      'EXTRACT- regexes, a REPORT- transform (REGEX and FORMAT, or DELIMS), field aliases, calculated fields and an automatic lookup for one sourcetype — search-time only — with a regex test harness that runs the patterns over sample events before they are deployed.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_fields_acme' },
      { id: 'stanza_type', label: 'Apply to', control: 'select', default: 'sourcetype', options: [
        { value: 'sourcetype', label: 'A sourcetype' },
        { value: 'source', label: 'A source (source::)' },
        { value: 'host', label: 'A host (host::)' },
      ] },
      { id: 'stanza', label: 'Sourcetype, source or host', control: 'text', default: 'acme:orders:log', hint: 'source:: and host:: accept wildcards: /var/log/acme/*.log' },
      { id: 'kv_mode', label: 'Automatic key=value (KV_MODE)', control: 'select', default: 'none', options: [
        { value: 'none', label: 'none — only the extractions below' },
        { value: 'auto', label: 'auto — every key=value pair in the event' },
        { value: 'auto_escaped', label: 'auto_escaped — as auto, honouring \\" inside quoted values' },
        { value: 'json', label: 'json — the event is JSON' },
        { value: 'xml', label: 'xml — the event is XML' },
      ] },
      {
        id: 'inline',
        label: 'Inline extractions (EXTRACT-)',
        control: 'textarea',
        default: String.raw`header | ^\S+\s+(?<log_level>[A-Z]+)\s+\[(?<thread>[^\]]+)\]\s+(?<src_ip>\d{1,3}(?:\.\d{1,3}){3})\s+(?<user>\S+)\s+(?<http_method>[A-Z]+)\s+(?<uri_path>\S+)\s+(?<status>\d{3})\s+(?<duration_ms>\d+)ms`,
        hint: 'name | PCRE with named groups — append "in <field>" to read another field',
      },
      { id: 'report_mode', label: 'Transform extraction (REPORT-)', control: 'select', default: 'regex', options: [
        { value: 'none', label: 'None' },
        { value: 'regex', label: 'REGEX and FORMAT — repeated key=value pairs, or anything positional' },
        { value: 'delims', label: 'DELIMS — delimiter-separated pairs' },
      ] },
      { id: 'report_regex', label: 'REGEX', control: 'text', default: String.raw`[|,]\s*([A-Za-z_][A-Za-z0-9_]*)=([^,\s|]+)`, showWhen: { input: 'report_mode', equals: ['regex'] } },
      { id: 'report_format', label: 'FORMAT', control: 'text', default: '$1::$2', hint: '$1::$2 names the field from the match; empty uses named groups', showWhen: { input: 'report_mode', equals: ['regex'] } },
      { id: 'pair_delims', label: 'Pair delimiters', control: 'text', default: ',', showWhen: { input: 'report_mode', equals: ['delims'] } },
      { id: 'kv_delims', label: 'Key/value delimiter', control: 'text', default: '=', showWhen: { input: 'report_mode', equals: ['delims'] } },
      { id: 'report_source', label: 'Read from (SOURCE_KEY)', control: 'text', default: '_raw', hint: '_raw, or a field an EXTRACT- above produced', showWhen: { input: 'report_mode', notEquals: ['none'] } },
      { id: 'aliases', label: 'Field aliases (FIELDALIAS-)', control: 'textarea', default: 'src_ip AS src\nlog_level AS severity\nhttp_method ASNEW method', hint: 'original AS alias — ASNEW only when the alias is not already set' },
      { id: 'evals', label: 'Calculated fields (EVAL-)', control: 'textarea', default: 'duration = round(duration_ms / 1000, 3)\naction = if(status >= 400, "failure", "success")\nvendor_product = "Acme Orders API"', hint: 'field = eval expression' },
      { id: 'lookup_name', label: 'Automatic lookup', control: 'text', default: 'http_status_codes', hint: 'Empty for none' },
      { id: 'lookup_input', label: 'Match on', control: 'text', default: 'status', showWhen: { input: 'lookup_name', notEquals: [''] } },
      { id: 'lookup_output', label: 'Add these fields', control: 'text', default: 'status_description, status_class', showWhen: { input: 'lookup_name', notEquals: [''] } },
      { id: 'lookup_overwrite', label: 'Overwrite fields the event already has (OUTPUT)', control: 'toggle', default: false, hint: 'Off writes OUTPUTNEW', showWhen: { input: 'lookup_name', notEquals: [''] } },
      {
        id: 'sample',
        label: 'Sample events',
        control: 'textarea',
        default: [
          '2026-09-23T10:15:02.114Z ERROR [orders-7] 10.20.4.17 jdoe POST /api/orders 502 1834ms | cart=18,items=3,region=eu-west',
          '2026-09-23T10:15:03.020Z INFO [orders-2] 10.20.4.22 asmith GET /api/orders/551 200 42ms | items=1,region=eu-west',
          '2026-09-23T10:15:04.871Z WARN [billing-1] 10.20.7.3 svc_batch PUT /api/invoices/88 404 97ms | region=us-east',
        ].join('\n'),
        hint: 'One event per line — real ones, copied from a search, including the odd ones',
      },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_fields'), 'org_fields');
      const stanzaType = str(values, 'stanza_type', 'sourcetype');
      const rawStanza = str(values, 'stanza', '').trim();
      const stanza = stanzaType === 'source' ? `source::${rawStanza.replace(/^source::/, '')}` : stanzaType === 'host' ? `host::${rawStanza.replace(/^host::/, '')}` : rawStanza;
      const kvMode = str(values, 'kv_mode', 'none');
      const reportMode = str(values, 'report_mode', 'regex');
      const reportRegex = str(values, 'report_regex', '');
      const reportFormat = str(values, 'report_format', '');
      const reportSource = str(values, 'report_source', '_raw') || '_raw';
      const pairDelims = str(values, 'pair_delims', ',');
      const kvDelims = str(values, 'kv_delims', '=');
      const className = splunkName(rawStanza, 'fields');
      const transformName = `${className}_kv`;
      const lookup = splunkName(str(values, 'lookup_name', ''), '');
      const lookupInput = str(values, 'lookup_input', '').trim();
      const lookupOutput = listOf(str(values, 'lookup_output', ''));
      const sample = linesOf(str(values, 'sample', ''));
      const findings            = [];

      const inline = linesOf(str(values, 'inline', '')).map((line) => {
        const [name, regex] = splitFirst(line);
        return { name: splunkName(name, 'extract'), regex };
      });
      const aliases = linesOf(str(values, 'aliases', ''))
        .map((line) => {
          const m = /^(\S+)\s+(AS|ASNEW)\s+(\S+)$/i.exec(line);
          return m ? { from: m[1] ?? '', mode: (m[2] ?? 'AS').toUpperCase(), to: m[3] ?? '' } : null;
        })
        .filter((a)                                                  => a !== null);
      const evals = linesOf(str(values, 'evals', ''))
        .map((line) => {
          const [field, expression] = splitFirst(line, '=');
          return { field: field.trim(), expression: expression.trim() };
        })
        .filter((e) => e.field && e.expression);

      if (!rawStanza) findings.push(error('splunk.no-stanza', 'No sourcetype, source or host was given, so these extractions would apply to nothing — or, as [default], to everything.', { source: 'ArchToolKit' }));
      if (inline.length === 0 && reportMode === 'none' && kvMode === 'none') {
        findings.push(error('splunk.no-extractions', 'Nothing extracts a field: no inline regex, no transform and KV_MODE = none.', { source: 'ArchToolKit' }));
      }

      // Every inline regex has to name what it extracts.
      for (const ext of inline) {
        if (!ext.regex) {
          findings.push(error('splunk.extract-empty', `EXTRACT-${ext.name} has no regex.`, { source: 'ArchToolKit' }));
          continue;
        }
        if (namedGroups(ext.regex).length === 0) {
          findings.push(
            error('splunk.extract-no-named-group', `EXTRACT-${ext.name} has no named capture group, so it matches and extracts nothing. An inline extraction names its fields with (?<field>...).`, {
              remediation: 'Name every group that should become a field; make the rest non-capturing with (?:...).',
              source: 'ArchToolKit',
            }),
          );
        }
        if (/^\.\*|^\(\.\*\)/.test(ext.regex)) {
          findings.push(warning('splunk.extract-leading-dotstar', `EXTRACT-${ext.name} starts with .*, which backtracks through the whole event on every match attempt. Anchor it with ^ or a literal instead.`, { source: 'ArchToolKit' }));
        }
      }
      const duplicated = inline.map((e) => e.name).filter((n, i, all) => all.indexOf(n) !== i);
      if (duplicated.length) findings.push(error('splunk.extract-duplicate-class', `EXTRACT-${duplicated[0]} is declared twice; the second silently replaces the first.`, { source: 'ArchToolKit' }));

      if (reportMode === 'regex') {
        if (!reportRegex) findings.push(error('splunk.report-no-regex', 'The REPORT- transform has no REGEX.', { source: 'ArchToolKit' }));
        const groups = (reportRegex.match(/\((?!\?)/g) ?? []).length;
        const referenced = [...reportFormat.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        if (referenced.some((n) => n > groups)) {
          findings.push(error('splunk.format-group-missing', `FORMAT refers to $${Math.max(...referenced)} but the REGEX has ${groups} capturing group${groups === 1 ? '' : 's'}.`, { source: 'ArchToolKit' }));
        }
        if (!reportFormat && namedGroups(reportRegex).length === 0) {
          findings.push(error('splunk.report-nothing-named', 'The transform has neither a FORMAT nor named groups, so it extracts nothing.', { source: 'ArchToolKit' }));
        }
      }
      if (reportMode === 'delims' && reportSource === '_raw') {
        findings.push(
          warning('splunk.delims-whole-event', 'DELIMS over _raw splits the whole event, header and all, into pairs — anything before the first delimiter becomes a field with a nonsense name. Extract the key=value block into a field first and point SOURCE_KEY at it.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (kvMode.startsWith('auto') && reportMode !== 'none') {
        findings.push(
          warning('splunk.kv-mode-twice', 'KV_MODE = auto extracts every key=value pair on its own, and the REPORT- transform extracts them again. Where both find the same pair the field can come out multivalued, and the automatic pass also picks up any "=" in free text. Use one or the other.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (kvMode !== 'json' && sample.length > 0 && sample.every((e) => e.startsWith('{'))) {
        findings.push(warning('splunk.json-without-kv-mode', 'The sample events are JSON. KV_MODE = json extracts every key with no regex at all — unless the add-on already uses INDEXED_EXTRACTIONS = json, in which case set KV_MODE = none to avoid extracting everything twice.', { source: 'ArchToolKit' }));
      }

      // Calculated fields are evaluated independently of one another: one
      // cannot see another's result.
      const evalFields = new Set(evals.map((e) => e.field));
      for (const e of evals) {
        const uses = [...evalFields].filter((f) => f !== e.field && new RegExp(`(^|[^A-Za-z0-9_."'])${f}([^A-Za-z0-9_]|$)`).test(e.expression));
        if (uses.length) {
          findings.push(
            warning('splunk.eval-chain', `EVAL-${e.field} refers to ${uses.join(', ')}, which is itself a calculated field. Splunk evaluates calculated fields independently, so ${e.field} sees the value from before any EVAL- ran — usually null.`, {
              remediation: 'Write the full expression in each calculated field rather than chaining them.',
              source: 'ArchToolKit',
            }),
          );
        }
        if (namedGroups(inline.map((i) => i.regex).join(' ')).includes(e.field)) {
          findings.push(warning('splunk.eval-overrides-extraction', `EVAL-${e.field} has the same name as an extracted field. A calculated field replaces the extracted value in every search, which is rarely what was meant.`, { source: 'ArchToolKit' }));
        }
      }

      // Everything the automatic lookup matches on must exist by the time it runs.
      const available = new Set        (['_raw', '_time', 'host', 'source', 'sourcetype', 'index', 'linecount', 'punct', ...namedGroups(inline.map((i) => i.regex).join(' ')), ...namedGroups(reportRegex), ...aliases.map((a) => a.to), ...evals.map((e) => e.field)]);
      if (lookup && !lookupInput) findings.push(error('splunk.lookup-no-input', 'The automatic lookup has no field to match on.', { source: 'ArchToolKit' }));
      if (lookup && lookupOutput.length === 0) findings.push(error('splunk.lookup-no-output', 'The automatic lookup adds no fields.', { source: 'ArchToolKit' }));
      if (lookup && lookupInput && !available.has(lookupInput) && !reportFormat.includes('$1::')) {
        findings.push(warning('splunk.lookup-input-unknown', `The lookup matches on "${lookupInput}", which nothing in this app extracts. It will only work if another app extracts it.`, { source: 'ArchToolKit' }));
      }

      // A smoke test in JavaScript. The harness in bin/ is the real one.
      if (sample.length === 0) {
        findings.push(warning('splunk.no-sample', 'No sample events, so the regexes have not been tried against anything. Paste real events — including the unusual ones — and run bin/test_extractions.py.', { source: 'ArchToolKit' }));
      } else {
        for (const ext of inline) {
          if (/\s+in\s+[A-Za-z_]\w*\s*$/.test(ext.regex)) continue;
          const rx = jsRegex(ext.regex);
          if (!rx) continue;
          const matched = sample.filter((e) => rx.test(e)).length;
          if (matched === 0) {
            findings.push(error('splunk.extract-matches-nothing', `EXTRACT-${ext.name} matches none of the ${sample.length} sample events.`, { remediation: 'Fix the regex against the sample, or replace the sample with events it is meant to match.', source: 'ArchToolKit' }));
          } else if (matched < sample.length) {
            findings.push(warning('splunk.extract-partial', `EXTRACT-${ext.name} matches ${matched} of ${sample.length} sample events. If the others are the same kind of event, the fields will be missing from them in every search.`, { source: 'ArchToolKit' }));
          }
        }
        if (reportMode === 'regex' && reportSource === '_raw') {
          const rx = jsRegex(reportRegex, true);
          if (rx && sample.every((e) => !rx.test(e))) findings.push(error('splunk.report-matches-nothing', 'The REPORT- regex matches none of the sample events.', { source: 'ArchToolKit' }));
        }
      }

      const harnessConfig = {
        extract: inline.filter((e) => e.regex).map((e) => ({ name: e.name, regex: e.regex })),
        report:
          reportMode === 'none'
            ? null
            : { name: className, mode: reportMode, regex: reportRegex, format: reportFormat, source_key: reportSource, pair_delims: pairDelims, kv_delims: kvDelims },
        aliases,
        expected_fields: [...new Set([...namedGroups(inline.map((i) => i.regex).join(' ')), ...(lookup && lookupInput ? [lookupInput] : [])])],
      };
      const harness = HARNESS.replace('__CONFIG__', () => JSON.stringify(JSON.stringify(harnessConfig))).split('\n');
      if (harness[harness.length - 1] === '') harness.pop();

      const q = (s        ) => `"${s.replace(/"/g, '\\"')}"`;

      return {
        tier: TIER,
        title: `Search-time field extractions for [${stanza}]`,
        app,
        activation: 'reload',
        notes: [
          'Everything here is search-time. It changes what searches see, never what is stored, so it applies to data already indexed as well as new data — and it can be changed or taken out without re-indexing anything.',
          'Splunk applies search-time settings in a fixed order: EXTRACT-, then REPORT-, then KV_MODE, then FIELDALIAS-, then EVAL-, then LOOKUP-. A later step can use an earlier step’s fields; an earlier step cannot see a later one’s. That is why the aliases and calculated fields below can use the extracted fields, and why the lookup can match on an alias.',
          'Run bin/test_extractions.py against real events before deploying and after every change. It runs on any Python 3, including Splunk’s own: $SPLUNK_HOME/bin/splunk cmd python3 bin/test_extractions.py bin/sample_events.log',
          'The extractions are shared (export = system in metadata/default.meta). Without that, fields extracted by this app appear only in searches run from inside this app, which looks exactly like a regex that does not work.',
          ...(stanzaType !== 'sourcetype' ? ['A source:: or host:: stanza takes precedence over a sourcetype stanza for the same setting name. That is useful for an exception and confusing as a default — prefer the sourcetype.'] : []),
          ...(lookup ? [`The lookup table is ${app}/lookups/${lookup}.csv. OUTPUT${bool(values, 'lookup_overwrite', false) ? '' : 'NEW'} ${bool(values, 'lookup_overwrite', false) ? 'overwrites fields the event already has' : 'fills only fields the event does not already have'}.`] : []),
        ],
        before: [
          `$SPLUNK_HOME/bin/splunk btool props list "${stanza}" --debug   # what already applies to this stanza, and from which app`,
          `$SPLUNK_HOME/bin/splunk cmd python3 $SPLUNK_HOME/etc/apps/${app}/bin/test_extractions.py`,
          `index=* ${stanzaType === 'sourcetype' ? `sourcetype=${q(rawStanza)}` : stanzaType === 'source' ? `source=${q(rawStanza)}` : `host=${q(rawStanza)}`} earliest=-4h | head 200 | fieldsummary | table field, count, distinct_count`,
          ...inline.slice(0, 2).map((e) => `index=* sourcetype=${q(rawStanza)} earliest=-1h | head 1000 | rex field=_raw ${q(e.regex.replace(/\s+in\s+\w+\s*$/, ''))} | stats count(${namedGroups(e.regex)[0] ?? '_raw'}) as matched, count as events`),
        ],
        files: {
          'default/props.conf': [
            '# Search-time only. A search head reads these when a search runs; it never',
            '# parses incoming data, so line breaking and timestamps do not belong here.',
            `[${stanza}]`,
            '',
            '# Automatic key=value extraction. none means only what is declared below runs,',
            '# which is faster and does not invent fields from every "=" in free text.',
            `KV_MODE = ${kvMode}`,
            '',
            ...(inline.length
              ? [
                  '# 1. Inline extractions. The class name after EXTRACT- decides the order they',
                  '#    run in (lexical), and the named groups become the fields.',
                  ...inline.map((e) => `EXTRACT-${e.name} = ${e.regex}`),
                  '',
                ]
              : []),
            ...(reportMode !== 'none'
              ? [
                  '# 2. Transform extraction, defined in transforms.conf. Use this for anything',
                  '#    that repeats in one event, or that one regex per field would make unreadable.',
                  `REPORT-${className} = ${transformName}`,
                  '',
                ]
              : []),
            ...(aliases.length
              ? [
                  '# 3. Field aliases, typically to the Common Information Model name. AS replaces',
                  '#    an existing value of the alias; ASNEW only sets it when it is empty. The',
                  '#    original field stays as it was.',
                  ...aliases.map((a) => `FIELDALIAS-${splunkName(a.to, 'alias')} = ${a.from} ${a.mode} ${a.to}`),
                  '',
                ]
              : []),
            ...(evals.length
              ? [
                  '# 4. Calculated fields. Each is evaluated on its own: one EVAL- cannot use',
                  '#    another EVAL-’s result, and an EVAL- replaces an extracted field of the',
                  '#    same name.',
                  ...evals.map((e) => `EVAL-${e.field} = ${e.expression}`),
                  '',
                ]
              : []),
            ...(lookup && lookupInput
              ? [
                  '# 5. Automatic lookup. Runs after everything above, so it can match on an',
                  '#    alias or a calculated field. It runs for every event of this stanza in',
                  '#    every search, so keep the table small.',
                  `LOOKUP-${lookup} = ${lookup} ${lookupInput} ${bool(values, 'lookup_overwrite', false) ? 'OUTPUT' : 'OUTPUTNEW'} ${lookupOutput.join(' ')}`,
                ]
              : []),
          ],
          ...(reportMode !== 'none' || lookup
            ? {
                'default/transforms.conf': [
                  '# Search-time transforms. No DEST_KEY: that is an index-time setting, and a',
                  '# transform with one is never used by a REPORT-.',
                  ...(reportMode === 'regex'
                    ? [
                        `[${transformName}]`,
                        ...(reportSource !== '_raw' ? ['# VERIFY: SOURCE_KEY at search time can name a field an EXTRACT- produced,', '# because EXTRACT- runs first. Confirm on your version with the harness and | extract reload=t.'] : []),
                        `SOURCE_KEY = ${reportSource}`,
                        `REGEX = ${reportRegex}`,
                        ...(reportFormat ? ['# $1::$2 names the field from the first group and takes the value from the', '# second. At search time the regex is applied repeatedly across the event.', `FORMAT = ${reportFormat}`] : []),
                        '# Key names are cleaned (characters other than letters, digits and _ become _).',
                        'CLEAN_KEYS = true',
                        '# A key seen twice in one event keeps both values as a multivalue field.',
                        'MV_ADD = true',
                        '',
                      ]
                    : []),
                  ...(reportMode === 'delims'
                    ? [
                        `[${transformName}]`,
                        ...(reportSource !== '_raw' ? ['# VERIFY: SOURCE_KEY at search time can name a field an EXTRACT- produced.'] : []),
                        `SOURCE_KEY = ${reportSource}`,
                        '# First string: characters that separate pairs. Second: characters that',
                        '# separate a key from its value.',
                        `DELIMS = ${q(pairDelims)}, ${q(kvDelims)}`,
                        'CLEAN_KEYS = true',
                        'MV_ADD = true',
                        '',
                      ]
                    : []),
                  ...(lookup
                    ? [
                        `[${lookup}]`,
                        `filename = ${lookup}.csv`,
                        'case_sensitive_match = false',
                        '# One row per match: enrichment, not a join that multiplies events.',
                        'max_matches = 1',
                      ]
                    : []),
                ],
              }
            : {}),
          ...(lookup
            ? {
                [`lookups/${lookup}.csv`]: [
                  [lookupInput, ...lookupOutput].join(','),
                  ...(lookup === 'http_status_codes' && lookupInput === 'status' && lookupOutput.join(',') === 'status_description,status_class' ? HTTP_STATUS_ROWS : []),
                ],
              }
            : {}),
          'bin/test_extractions.py': harness,
          'bin/sample_events.log': sample.length ? sample : ['# paste real events here, one per line'],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `$SPLUNK_HOME/bin/splunk btool props list "${stanza}" --debug | grep -E "EXTRACT-|REPORT-|FIELDALIAS-|EVAL-|LOOKUP-|KV_MODE"`,
          `| rest /servicesNS/-/-/data/props/extractions | search stanza="${stanza}" | table eai:acl.app, attribute, value, type`,
          `index=* sourcetype=${q(rawStanza)} earliest=-1h | extract reload=t | head 500 | stats ${[...namedGroups(inline.map((i) => i.regex).join(' ')).slice(0, 4), ...aliases.slice(0, 1).map((a) => a.to), ...evals.slice(0, 1).map((e) => e.field)].map((f) => `count(${f}) as ${f}`).join(', ') || 'count'}, count as events`,
          ...(lookup && lookupOutput[0] ? [`index=* sourcetype=${q(rawStanza)} earliest=-1h | head 500 | stats count by ${lookupOutput[0]}`] : []),
        ],
        backout: [
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # or remove it on the deployer and apply shcluster-bundle`,
          `| extract reload=t   # or open /debug/refresh — search-time settings reload without a restart`,
          '# Searches, dashboards and data models that use these field names lose them immediately. Check first:',
          `index=_audit action=search info=granted earliest=-30d | search search="*${namedGroups(inline.map((i) => i.regex).join(' '))[0] ?? rawStanza}*" | stats count by user, savedsearch_name`,
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_kvstore',
    tier: TIER,
    label: 'KV store collection and lookup',
    group: 'Knowledge objects',
    description:
      'A KV store collection with typed fields and accelerated fields, the lookup definition that reads it, a scheduled search that keeps it current by key, and a REST helper that reads the token from a private file.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_kvstore' },
      { id: 'collection', label: 'Collection', control: 'text', default: 'asset_inventory' },
      { id: 'lookup_name', label: 'Lookup definition', control: 'text', default: 'asset_inventory_lookup' },
      { id: 'fields', label: 'Fields', control: 'textarea', default: 'asset_id | string\nhost | string\nip | string\nowner | string\ncriticality | number\nlast_seen | time', hint: 'name | string, number, bool, time, cidr or array' },
      { id: 'key_field', label: 'Key (one record per)', control: 'text', default: 'asset_id', hint: 'Becomes _key, so an update replaces the record rather than adding one' },
      { id: 'accelerated', label: 'Accelerated fields', control: 'text', default: 'host, ip', hint: 'What lookups match on — each becomes an index in the KV store' },
      { id: 'enforce_types', label: 'Enforce field types', control: 'toggle', default: true },
      { id: 'replicate', label: 'Replicate to the indexers', control: 'toggle', default: false, hint: 'Needed only when the lookup runs before a transforming command, on the indexers' },
      { id: 'estimated_rows', label: 'Expected records', control: 'number', default: 20000, min: 0, max: 100000000 },
      { id: 'record_bytes', label: 'Average record size (bytes)', control: 'number', default: 400, min: 10, max: 1000000 },
      { id: 'maintain', label: 'Maintain it with a scheduled search', control: 'toggle', default: true },
      { id: 'index', label: 'Source index', control: 'text', default: 'cmdb', showWhen: { input: 'maintain', equals: ['true'] } },
      { id: 'sourcetype', label: 'Source sourcetype', control: 'text', default: 'cmdb:asset', showWhen: { input: 'maintain', equals: ['true'] } },
      {
        id: 'maintain_pipeline',
        label: 'Summarise to one row per key',
        control: 'textarea',
        default: '| stats latest(host) as host, latest(ip) as ip, latest(owner) as owner, latest(criticality) as criticality, max(_time) as last_seen by asset_id',
        showWhen: { input: 'maintain', equals: ['true'] },
      },
      { id: 'frequency', label: 'Update every', control: 'select', default: '60', options: [
        { value: '15', label: '15 minutes' },
        { value: '60', label: 'Hour' },
        { value: '1440', label: 'Day' },
      ], showWhen: { input: 'maintain', equals: ['true'] } },
      { id: 'prune_days', label: 'Remove records not seen for (days)', control: 'number', default: 30, min: 0, max: 3650, hint: '0 keeps them for ever', showWhen: { input: 'maintain', equals: ['true'] } },
      { id: 'splunk_url', label: 'Search head management URL', control: 'text', default: 'https://sh1.example.com:8089', hint: 'For the REST helper' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_kvstore'), 'org_kvstore');
      const collection = splunkName(str(values, 'collection', 'collection'), 'collection');
      const lookup = splunkName(str(values, 'lookup_name', `${collection}_lookup`), `${collection}_lookup`);
      const keyField = str(values, 'key_field', '').trim();
      const accelerated = listOf(str(values, 'accelerated', ''));
      const replicate = bool(values, 'replicate', false);
      const maintain = bool(values, 'maintain', true);
      const index = splunkName(str(values, 'index', ''), 'main');
      const sourcetype = str(values, 'sourcetype', '');
      const everyMinutes = Number(str(values, 'frequency', '60')) || 60;
      const pruneDays = num(values, 'prune_days', 30);
      const rows = num(values, 'estimated_rows', 20000);
      const recordBytes = num(values, 'record_bytes', 400);
      const sizeMb = Math.round((rows * recordBytes) / 1024 / 1024);
      const splunkUrl = str(values, 'splunk_url', 'https://localhost:8089').replace(/\/+$/, '');
      const types = new Set(['string', 'number', 'bool', 'time', 'cidr', 'array']);
      const fields = linesOf(str(values, 'fields', '')).map((line) => {
        const [name, type] = splitFirst(line);
        return { name: name.replace(/[^A-Za-z0-9_.]/g, '_'), type: (type || 'string').toLowerCase() };
      });
      const names = fields.map((f) => f.name);
      const title = searchTitle(`Maintain ${collection}`, 'Maintain collection');
      const pruneTitle = searchTitle(`Prune ${collection}`, 'Prune collection');
      const findings            = [];

      if (fields.length === 0) findings.push(error('splunk.kvstore-no-fields', 'The collection has no fields.', { source: 'ArchToolKit' }));
      for (const f of fields) {
        if (!types.has(f.type)) findings.push(error('splunk.kvstore-bad-type', `Field ${f.name} has type "${f.type}". The KV store accepts number, bool, string, time, cidr and array.`, { source: 'ArchToolKit' }));
        else if (f.type === 'cidr' || f.type === 'array') {
          findings.push(
            warning('splunk.kvstore-type-not-in-spec', `Field ${f.name} has type "${f.type}", which collections.conf.spec does not list (number, bool, string and time), and which Splunk AppInspect — the vetting a Splunk Cloud private app goes through — rejects.`, {
              remediation: f.type === 'cidr' ? 'Store the address as a string: matching an address against networks is the lookup definition’s job (match_type = CIDR(field) in transforms.conf).' : 'Store the list as a string, or as a multivalue field written by the search.',
              source: 'collections.conf.spec (Splunk Enterprise 10.4); Splunk AppInspect check_collections_conf_for_specified_name_field_type',
            }),
          );
        }
      }
      if (keyField && !names.includes(keyField)) findings.push(error('splunk.kvstore-key-not-a-field', `The key "${keyField}" is not one of the collection's fields.`, { source: 'ArchToolKit' }));
      for (const a of accelerated) {
        if (!names.includes(a)) findings.push(error('splunk.kvstore-accelerated-unknown', `Accelerated field "${a}" is not a field of the collection.`, { source: 'ArchToolKit' }));
      }
      if (accelerated.length === 0 && rows > 10000) {
        findings.push(
          warning('splunk.kvstore-no-acceleration', `A lookup against ${rows.toLocaleString('en-US')} records with no accelerated field is a full collection scan for every distinct value it looks up.`, {
            remediation: 'Accelerate the field the lookup matches on.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (replicate && sizeMb > 50) {
        findings.push(
          warning('splunk.kvstore-replicate-large', `replicate = true on a collection of about ${sizeMb}MB copies it into the knowledge bundle sent to every indexer, on every bundle replication. Large bundles are the usual cause of "bundle replication failed" and of searches waiting on the bundle — and the copy on the indexers is only as fresh as the last bundle.`, {
            remediation: 'Leave replicate off and put the lookup after the first transforming command (or use lookup local=true), so it runs on the search head against far fewer rows.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (replicate && sizeMb > 1024) {
        findings.push(error('splunk.kvstore-replicate-over-bundle', `About ${sizeMb}MB replicated would approach or exceed the default maximum bundle size (distsearch.conf maxBundleSize, 2048MB). Searches would stop distributing.`, { source: 'ArchToolKit' }));
      }
      if (maintain && keyField && !str(values, 'maintain_pipeline', '').includes(`by ${keyField}`)) {
        findings.push(warning('splunk.kvstore-maintain-not-by-key', `The maintenance search should end in "by ${keyField}" so there is exactly one row per key. Two rows with the same key are written one after the other, and the last one wins.`, { source: 'ArchToolKit' }));
      }
      if (maintain && pruneDays > 0 && !names.includes('last_seen')) {
        findings.push(error('splunk.kvstore-prune-no-last-seen', 'Pruning needs a last_seen time field to decide what is stale, and the collection has none.', { source: 'ArchToolKit' }));
      }

      const window = searchWindow(everyMinutes);
      const collectionPath = `/servicesNS/nobody/${app}/storage/collections`;

      const maintainPipeline = [
        `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''}`,
        ...linesOf(str(values, 'maintain_pipeline', '')),
        `| fields ${names.join(', ')}`,
        '# key_field makes the value of that field the record _key, so a key already in',
        '# the collection is updated in place and a new one is inserted.',
        `| outputlookup append=true key_field=${keyField || '_key'} ${lookup}`,
      ].filter((l) => !l.startsWith('#'));

      const pruneLines = [
        `| inputlookup ${lookup}`,
        `| where last_seen >= relative_time(now(), "-${pruneDays}d@d")`,
        `| outputlookup ${lookup}`,
      ];

      const restScript = String.raw`#!/usr/bin/env bash
# REST helper for the ${collection} KV store collection.
#
# The token is read from a file that only you can read (mode 600), written into
# a private header file for the duration of the call, and removed afterwards. It
# is never on a command line, never in the environment of another process, and
# never echoed. Create one in Settings > Tokens, then:
#   umask 077; mkdir -p ~/.splunk; read -rs T; printf "%s" "$T" > ~/.splunk/token; unset T
#
# Usage (sends the request when run; --dry-run prints it and sends nothing):
#   bash kvstore-rest.sh list [limit]
#   bash kvstore-rest.sh get <key>
#   bash kvstore-rest.sh upsert <record.json>        one JSON object; its _key decides insert or update
#   bash kvstore-rest.sh batch <records.json>        a JSON array, up to 1000 records per call by default
#   bash kvstore-rest.sh delete-query '{"owner":"nobody"}' [--confirm-count N]
#   bash kvstore-rest.sh config | status
#   add --dry-run to preview without sending
#
# delete-query always counts first — a GET with the same query, even in a dry run,
# so it needs the token — and shows how many records match. It refuses:
#   - a query that is not a non-empty JSON object ({} and { } delete everything);
#   - a query that matches every record in the collection (e.g. {"_key":{"$exists":true}});
#   - a count at the read cap (KV_READ_CAP, default 50000 = max_rows_per_query), where
#     the real number may be larger;
#   - more than KV_CONFIRM_ABOVE records (default 10) unless --confirm-count repeats
#     the count exactly.
# Records written between the count and the delete are deleted too if they match.
set -euo pipefail
EXECUTE=1; CONFIRM_COUNT=""; ARGS=()
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) EXECUTE=0; shift ;;
    --confirm-count) [ $# -ge 2 ] || { echo "--confirm-count needs the number of matching records" >&2; exit 2; }; CONFIRM_COUNT=$2; shift 2 ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
ACTION="\${ARGS[0]:-list}"
ARG="\${ARGS[1]:-}"
SPLUNK_URL="\${SPLUNK_URL:-${splunkUrl}}"
TOKEN_FILE="\${TOKEN_FILE:-$HOME/.splunk/token}"
BASE="$SPLUNK_URL${collectionPath}"
COLL="${collection}"
CONFIRM_ABOVE="\${KV_CONFIRM_ABOVE:-10}"
READ_CAP="\${KV_READ_CAP:-50000}"
[[ "$CONFIRM_ABOVE" =~ ^[0-9]+$ && "$READ_CAP" =~ ^[1-9][0-9]*$ ]] || { echo "KV_CONFIRM_ABOVE and KV_READ_CAP must be numbers" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
# Verify the certificate. Point SPLUNK_CA at your CA bundle if it is not in the system store.
CURL=(curl -sS --fail-with-body)
[[ -n "\${SPLUNK_CA:-}" ]] && CURL+=(--cacert "$SPLUNK_CA")
enc() { jq -rn --arg v "$1" '$v|@uri'; }
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$ACTION" in
  list)   METHOD=GET;    URL="$BASE/data/$COLL?limit=\${ARG:-20}"; BODY="" ;;
  get)    METHOD=GET;    URL="$BASE/data/$COLL/$(enc "\${ARG:?key required}")"; BODY="" ;;
  upsert) METHOD=POST;   URL="$BASE/data/$COLL/batch_save"; BODY="\${ARG:?record file required}" ;;
  batch)  METHOD=POST;   URL="$BASE/data/$COLL/batch_save"; BODY="\${ARG:?records file required}" ;;
  delete-query)
          METHOD=DELETE; Q="\${ARG:?JSON query required}"
          # A non-empty JSON object, compacted — not a string compare against "{}",
          # which "{ }" or "{\n}" would get past.
          jq -e 'type == "object" and length > 0' <<<"$Q" > /dev/null 2>&1 \
            || { echo "Refusing: the query must be a non-empty JSON object. An empty query deletes every record." >&2; exit 1; }
          QC="$(jq -c . <<<"$Q")"
          URL="$BASE/data/$COLL?query=$(enc "$QC")"; BODY="" ;;
  config) METHOD=GET;    URL="$BASE/config/$COLL?output_mode=json"; BODY="" ;;
  status) METHOD=GET;    URL="$SPLUNK_URL/services/kvstore/status?output_mode=json"; BODY="" ;;
  *) echo "Unknown action: $ACTION" >&2; exit 2 ;;
esac

if [[ "$ACTION" == "upsert" ]]; then
  # batch_save with a one-element array is an upsert by _key.
  [[ -f "$BODY" ]] || { echo "No such file: $BODY" >&2; exit 1; }
  jq -e 'type == "object"' "$BODY" > /dev/null || { echo "$BODY must hold one JSON object." >&2; exit 1; }
  jq -c "[.]" "$BODY" > "$WORK/body.json"; BODY="$WORK/body.json"
fi
if [[ "$ACTION" == "batch" ]]; then
  [[ -f "$BODY" ]] || { echo "No such file: $BODY" >&2; exit 1; }
  jq -e 'type == "array"' "$BODY" > /dev/null || { echo "$BODY must hold a JSON array of records." >&2; exit 1; }
fi

HDR="$WORK/auth.h"
auth() {
  [[ -f "$TOKEN_FILE" ]] || { echo "No token file: $TOKEN_FILE" >&2; exit 1; }
  local perm t=""
  perm="$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE")"
  [[ "$perm" == "600" || "$perm" == "400" ]] || { echo "$TOKEN_FILE must be mode 600." >&2; exit 1; }
  IFS= read -r t < "$TOKEN_FILE" || true
  t="\${t%$'\r'}"
  [[ -n "$t" ]] || { echo "$TOKEN_FILE is empty." >&2; exit 1; }
  printf "Authorization: Bearer %s\n" "$t" > "$HDR"
  t=""
}

# count URL: how many records a GET returns (only _key is fetched). Fails on an
# HTTP error or anything that is not a JSON array — never a silent 0.
count() {
  "\${CURL[@]}" -H @"$HDR" "$1" > "$WORK/count.json" || { echo "Could not count records: GET failed." >&2; exit 1; }
  jq -e 'if type == "array" then length else error("not a JSON array") end' "$WORK/count.json" \
    || { echo "Could not count records: the response is not a JSON array." >&2; exit 1; }
}

if [[ "$ACTION" == "delete-query" ]]; then
  auth
  matched="$(count "$BASE/data/$COLL?query=$(enc "$QC")&fields=_key&limit=$READ_CAP")"
  total="$(count "$BASE/data/$COLL?fields=_key&limit=$READ_CAP")"
  echo "query $QC matches $matched of $([[ "$total" -ge "$READ_CAP" ]] && echo "at least $total" || echo "$total") records in $COLL"
  [[ "$matched" -gt 0 ]] || { echo "Nothing matches; nothing to delete."; exit 0; }
  [[ "$matched" -lt "$READ_CAP" ]] || { echo "Refusing: $matched is the read cap ($READ_CAP), so the real count may be larger. Narrow the query." >&2; exit 1; }
  [[ "$matched" -lt "$total" ]] || { echo "Refusing: the query matches every record in $COLL. To empty the collection, DELETE $BASE/data/$COLL deliberately (see DEPLOY.md back-out)." >&2; exit 1; }
  if (( ! EXECUTE )); then
    echo "DRY RUN: DELETE $URL   ($matched records)"
    (( matched <= CONFIRM_ABOVE )) || echo "  Dry run: nothing was changed. More than $CONFIRM_ABOVE records: run it without --dry-run and with --confirm-count $matched to apply."
    (( matched > CONFIRM_ABOVE )) || echo "  Dry run: nothing was changed. Run it without --dry-run to apply."
    exit 0
  fi
  if (( matched > CONFIRM_ABOVE )) && [[ "$CONFIRM_COUNT" != "$matched" ]]; then
    echo "Refusing: $matched records match. Repeat the count to delete them: --confirm-count $matched" >&2
    exit 1
  fi
  "\${CURL[@]}" -X DELETE -H @"$HDR" "$URL" > /dev/null
  left="$(count "$BASE/data/$COLL?query=$(enc "$QC")&fields=_key&limit=$READ_CAP")"
  echo "deleted; $left matching records remain"
  [[ "$left" -eq 0 ]] || exit 1
  exit 0
fi

if (( ! EXECUTE )); then
  echo "DRY RUN: $METHOD $URL"
  [[ -n "$BODY" ]] && echo "  body: $BODY ($(jq length "$BODY") records)"
  echo "  Authorization header from $TOKEN_FILE (not shown). Dry run: nothing was changed. Run it without --dry-run to apply."
  exit 0
fi

auth
if [[ -n "$BODY" ]]; then
  "\${CURL[@]}" -X "$METHOD" -H @"$HDR" -H "Content-Type: application/json" --data-binary @"$BODY" "$URL"
else
  "\${CURL[@]}" -X "$METHOD" -H @"$HDR" "$URL"
fi
echo`
        .replace(/\\\$\{/g, '${')
        .split('\n');

      return {
        tier: TIER,
        title: `KV store collection ${collection} and lookup ${lookup}`,
        app,
        activation: 'restart',
        notes: [
          'A collection defined in collections.conf is created when splunkd reads the file, which for a new app means a restart of the search head (or of each member, through the deployer). Records are not configuration: they live in the KV store, not in the app, and survive redeploying it.',
          'On a search head cluster the KV store replicates between members on its own. Write to any member; every member sees it.',
          `The key is ${keyField || '_key'}. outputlookup with key_field= uses that value as _key, so running the maintenance search twice updates records rather than doubling them. append=true is what stops it replacing the whole collection.`,
          replicate
            ? `replicate = true: the collection is copied into the knowledge bundle so the lookup can run on the indexers. Roughly ${sizeMb}MB per bundle, refreshed only when the bundle is.`
            : 'replicate = false: the lookup runs on the search head. Put it after the first transforming command (| stats ... | lookup ...), so it looks up a few hundred rows rather than every event.',
          'Enforced types are converted on write: a number field given "n/a" is rejected rather than stored as text. Without enforcement the KV store stores whatever arrives and comparisons in searches become string comparisons.',
          `ops/kvstore-rest.sh reads the token from ~/.splunk/token (mode 600) and passes it in a private header file. It applies when run; --dry-run previews. delete-query counts the matching records first (a GET with the same query), refuses an empty or match-everything query, and above 10 records needs --confirm-count with that exact count. Batch writes are limited by [kvstore] max_documents_per_batch_save in limits.conf (1000 by default), and a read returns at most max_rows_per_query (50000) — VERIFY both on your version.`,
          ...(maintain && pruneDays > 0 ? [`"${pruneTitle}" rewrites the collection without records older than ${pruneDays} days. It is enabled and scheduled daily — outputlookup without append replaces the whole collection, so check the record counts after its first run.`] : []),
        ],
        before: [
          '| rest splunk_server=local /services/kvstore/status | table current.status, current.replicationStatus, current.storageEngine',
          `| rest splunk_server=local /servicesNS/-/-/storage/collections/config | search title="${collection}" | table eai:acl.app, title`,
          `$SPLUNK_HOME/bin/splunk btool collections list ${collection} --debug`,
          ...(maintain ? [`index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''} earliest=-24h | stats dc(${keyField || 'host'}) as keys, count`] : []),
          ...(replicate ? ['| rest splunk_server=local /services/search/distributed/bundle-replication-files | table *   # current bundle size — VERIFY endpoint on your version'] : []),
        ],
        files: {
          'default/collections.conf': [
            `[${collection}]`,
            '# Typed fields. With enforceTypes a wrong-typed value is rejected at write time;',
            '# without it everything is stored and compared as whatever arrived.',
            `enforceTypes = ${bool(values, 'enforce_types', true) ? 'true' : 'false'}`,
            ...fields.map((f) => `field.${f.name} = ${f.type}`),
            '',
            ...(accelerated.length
              ? [
                  '# Accelerated fields are indexes in the KV store. A lookup matching on a field',
                  '# without one scans the whole collection for every distinct value.',
                  ...accelerated.map((a) => `accelerated_fields.accel_${splunkName(a, 'field')} = {"${a}": 1}`),
                  '',
                ]
              : []),
            '# replicate = true copies the collection into the knowledge bundle so lookups',
            '# can run on the indexers (before a transforming command). It costs bundle',
            '# size on every replication and is only as fresh as the last bundle.',
            `replicate = ${replicate ? 'true' : 'false'}`,
          ],
          'default/transforms.conf': [
            `[${lookup}]`,
            'external_type = kvstore',
            `collection = ${collection}`,
            '# _key is listed so inputlookup returns it, which is what makes an edit-and-write-back',
            '# update records rather than add new ones.',
            `fields_list = _key, ${names.join(', ')}`,
            'max_matches = 1',
          ],
          ...(maintain
            ? {
                'default/savedsearches.conf': [
                  `[${title}]`,
                  ...foldSearch(maintainPipeline),
                  `description = Keeps the ${collection} KV store collection current, one record per ${keyField || 'key'}.`,
                  'enableSched = 1',
                  `cron_schedule = ${spreadCron(title, everyMinutes)}`,
                  `dispatch.earliest_time = ${window.earliest}`,
                  `dispatch.latest_time = ${window.latest}`,
                  'schedule_window = auto',
                  'dispatch.ttl = 2p',
                  '',
                  ...(pruneDays > 0
                    ? [
                        `[${pruneTitle}]`,
                        ...foldSearch(pruneLines),
                        `description = Removes records of ${collection} not seen for ${pruneDays} days by rewriting the collection.`,
                        'enableSched = 1',
                        `cron_schedule = ${spreadCron(pruneTitle, 1440)}`,
                        'dispatch.earliest_time = -1m',
                        'dispatch.latest_time = now',
                      ]
                    : []),
                ],
              }
            : {}),
          'ops/kvstore-rest.sh': restScript,
          'ops/example-record.json': [JSON.stringify(Object.fromEntries([['_key', 'example-001'], ...fields.map((f) => [f.name, f.type === 'number' || f.type === 'time' ? 0 : f.type === 'bool' ? false : f.type === 'array' ? [] : f.name === keyField ? 'example-001' : f.type === 'cidr' ? '10.0.0.1' : 'example'])]), null, 2)],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| inputlookup ${lookup} | head 10`,
          `| inputlookup ${lookup} | stats count, dc(_key) as keys   # equal when every record has its own key`,
          ...(accelerated[0] ? [`| makeresults | eval ${accelerated[0]}="example" | lookup ${lookup} ${accelerated[0]}`] : []),
          `bash ops/kvstore-rest.sh list 5`,
          ...(maintain ? [`index=_internal sourcetype=scheduler savedsearch_name="${title}" | table _time, status, result_count, run_time`] : []),
          'index=_internal sourcetype=splunkd component=KVStore* log_level IN (WARN, ERROR) earliest=-1h | stats count by component   # VERIFY component names on your version',
        ],
        backout: [
          ...(maintain ? [`| rest /servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(title)} disabled=1   # stop writing first`] : []),
          `bash ops/kvstore-rest.sh list 50000 >${collection}-backup.json   # keep the records`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then restart; the collection definition goes with the app`,
          '# Removing the app does not necessarily purge the records. To delete them as well, before removing the app:',
          `#   curl -X DELETE $SPLUNK_URL${collectionPath}/data/${collection}   (with the header file, as ops/kvstore-rest.sh builds it)`,
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_acceleration',
    tier: TIER,
    label: 'Summary indexing, report acceleration and tstats',
    group: 'Performance',
    description:
      'One slow report made fast three ways — a summary index filled by a scheduled search, report acceleration, and tstats over indexed fields or an accelerated data model — with the cost before and after worked out rather than hoped for.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_performance' },
      { id: 'title', label: 'Report name', control: 'text', default: 'Web server errors by endpoint' },
      { id: 'index', label: 'Index', control: 'text', default: 'web' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'access_combined' },
      { id: 'filter', label: 'Filter', control: 'text', default: 'status=5*' },
      { id: 'pre', label: 'Before the aggregation', control: 'text', default: '| eval uri_path=lower(uri_path)', hint: 'Streaming commands only (eval, rex, where, fields) if the report is to be accelerated' },
      { id: 'aggregate', label: 'Aggregate', control: 'text', default: 'count, sum(bytes) as bytes', hint: 'Prefer count and sum: they add up correctly from a summary' },
      { id: 'by_fields', label: 'By', control: 'text', default: 'uri_path, status' },
      { id: 'summary_index', label: 'Summary index', control: 'toggle', default: true },
      { id: 'summary_index_name', label: 'Summary index name', control: 'text', default: 'summary_web', hint: 'Must already exist on the indexers', showWhen: { input: 'summary_index', equals: ['true'] } },
      { id: 'summary_span', label: 'Summarise per', control: 'select', default: '60', options: [
        { value: '15', label: '15 minutes' },
        { value: '60', label: 'Hour' },
        { value: '1440', label: 'Day' },
      ], showWhen: { input: 'summary_index', equals: ['true'] } },
      { id: 'report_acceleration', label: 'Report acceleration', control: 'toggle', default: true },
      { id: 'accel_range', label: 'Accelerate the last', control: 'select', default: '7d', options: [
        { value: '1d', label: 'Day' },
        { value: '7d', label: '7 days' },
        { value: '30d', label: '30 days' },
        { value: '90d', label: '90 days' },
      ], showWhen: { input: 'report_acceleration', equals: ['true'] } },
      { id: 'tstats', label: 'tstats examples', control: 'toggle', default: true },
      { id: 'datamodel', label: 'Data model (CIM)', control: 'combo', default: 'Web', options: [
        { value: 'Web', label: 'Web' },
        { value: 'Authentication', label: 'Authentication' },
        { value: 'Network_Traffic', label: 'Network_Traffic' },
        { value: 'Endpoint', label: 'Endpoint' },
        { value: '', label: 'None — indexed fields only' },
      ], showWhen: { input: 'tstats', equals: ['true'] } },
      { id: 'report_window', label: 'People look at', control: 'select', default: '7', options: [
        { value: '1', label: 'The last day' },
        { value: '7', label: 'The last 7 days' },
        { value: '30', label: 'The last 30 days' },
      ] },
      { id: 'runs_per_day', label: 'Report runs per day', control: 'number', default: 40, min: 0, max: 100000, hint: 'Dashboard loads count — each is a run' },
      { id: 'daily_gb', label: 'Daily volume of the index (GB)', control: 'number', default: 50, min: 0, max: 1000000 },
      { id: 'groups', label: 'Distinct rows per summary period', control: 'number', default: 300, min: 1, max: 10000000, hint: 'Roughly: how many rows the report returns for one hour' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_performance'), 'org_performance');
      const title = searchTitle(str(values, 'title', 'Report'), 'Report');
      const index = splunkName(str(values, 'index', ''), 'main');
      const sourcetype = str(values, 'sourcetype', '');
      const filter = str(values, 'filter', '');
      const pre = str(values, 'pre', '').trim();
      const aggregate = str(values, 'aggregate', 'count').trim() || 'count';
      const byFields = listOf(str(values, 'by_fields', ''));
      const useSummary = bool(values, 'summary_index', true);
      const summaryIndex = splunkName(str(values, 'summary_index_name', 'summary'), 'summary');
      const spanMinutes = Number(str(values, 'summary_span', '60')) || 60;
      const span = spanMinutes >= 1440 ? '1d' : spanMinutes >= 60 ? '1h' : `${spanMinutes}m`;
      const useAccel = bool(values, 'report_acceleration', true);
      const accelRange = str(values, 'accel_range', '7d');
      const useTstats = bool(values, 'tstats', true);
      const model = str(values, 'datamodel', 'Web').replace(/[^A-Za-z0-9_]/g, '');
      const windowDays = Number(str(values, 'report_window', '7')) || 7;
      const runsPerDay = num(values, 'runs_per_day', 40);
      const dailyGb = num(values, 'daily_gb', 50);
      const groups = num(values, 'groups', 300);
      const findings            = [];

      const base = `index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''}${filter ? ` ${filter}` : ''}`;
      const by = byFields.length ? ` by ${byFields.join(', ')}` : '';
      const reportPipeline = [base, ...(pre ? [pre.startsWith('|') ? pre : `| ${pre}`] : []), `| stats ${aggregate}${by}`, '| sort - count'];

      // Report acceleration has rules, and a report that breaks them simply is
      // not accelerated — the checkbox is refused in the UI, and in a conf file
      // nothing is built and nothing says so.
      const preBad = pre ? NOT_ACCELERABLE.exec(pre.startsWith('|') ? pre : `| ${pre}`) : null;
      if (useAccel && preBad) {
        findings.push(
          error('splunk.acceleration-not-possible', `Report acceleration needs every command before the first transforming command to be streamable. "${preBad[1]}" is not, so this report cannot be accelerated: the summary is never built, and every run still searches the raw events.`, {
            remediation: 'Move that command after the stats, or make it part of the base search. If it cannot move, use the summary index instead.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (useAccel && /^\s*\|/.test(filter)) {
        findings.push(error('splunk.acceleration-generating', 'An accelerated report has to start with a search of events. A generating command (| inputlookup, | rest, | tstats) cannot be accelerated.', { source: 'ArchToolKit' }));
      }
      if (filter.startsWith('*')) findings.push(error('splunk.leading-wildcard', 'A leading wildcard cannot use the index, so every event in the range is read.', { source: 'ArchToolKit' }));
      const rangeDays = accelRange === '1d' ? 1 : accelRange === '7d' ? 7 : accelRange === '30d' ? 30 : 90;
      if (useAccel && windowDays > rangeDays) {
        findings.push(warning('splunk.acceleration-range-short', `The report is read over ${windowDays} days but only ${rangeDays} are accelerated. A search over a range the summary does not cover falls back to raw events for the part it does not have.`, { source: 'ArchToolKit' }));
      }
      if (useAccel && runsPerDay < 2) {
        findings.push(warning('splunk.acceleration-unused', 'Acceleration is built and maintained in the background whether the report runs or not. For a report run less than twice a day it is cost without benefit.', { source: 'ArchToolKit' }));
      }
      if (useSummary && NOT_REAGGREGATABLE.test(aggregate)) {
        findings.push(
          warning('splunk.summary-not-additive', `The summary stores ${aggregate}. An average, a distinct count or a percentile per ${span} cannot be combined into one for a week — the average of hourly averages is not the weekly average.`, {
            remediation: 'Store count and sum(x) and compute the average when reading the summary, or use sistats so the summary keeps what is needed.',
            source: 'ArchToolKit',
          }),
        );
      }
      if (!byFields.length) findings.push(warning('splunk.summary-no-by', 'With no by-clause the summary holds one number per period, which answers only this one question.', { source: 'ArchToolKit' }));

      // The cost, before and after. Deliberately coarse: it says which way and
      // by roughly how much, not to the megabyte.
      const rawPerRunGb = dailyGb * windowDays;
      const rawPerDayGb = rawPerRunGb * runsPerDay;
      const periodsPerDay = 1440 / spanMinutes;
      const summaryRowsPerDay = groups * periodsPerDay;
      const summaryMbPerDay = Math.round(((summaryRowsPerDay * 300) / 1024 / 1024) * 10) / 10;
      const summaryReadMbPerRun = Math.round(summaryMbPerDay * windowDays * 10) / 10;
      const accelGb = Math.round(dailyGb * rangeDays * 0.01 * 10) / 10;
      const round1 = (n        ) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 10) / 10));
      const estimate = [
        `Before: each run reads up to ${round1(rawPerRunGb)}GB of events (${windowDays} day${windowDays === 1 ? '' : 's'} of a ${dailyGb}GB/day index); ${runsPerDay} runs a day is up to ${round1(rawPerDayGb)}GB read per day.`,
        ...(useSummary
          ? [`Summary index: filling it reads each ${span} of new data once — about ${round1(dailyGb)}GB/day — and writes about ${summaryMbPerDay}MB/day (${summaryRowsPerDay.toLocaleString('en-US')} rows). A report over it reads about ${summaryReadMbPerRun}MB per run.`]
          : []),
        ...(useAccel ? [`Report acceleration: the summary is built from new data every 10 minutes (again about ${round1(dailyGb)}GB/day read) and holds roughly ${accelGb}GB for ${accelRange} — an estimate at 1% of raw; high-cardinality by-fields make it much larger.`] : []),
        ...(useTstats ? ['tstats: reads the tsidx files only, never the raw events. Over indexed fields (index, sourcetype, host, source, _time) it needs nothing built at all.'] : []),
        'Measure it rather than trusting this: compare total_run_time and scan_count in _audit for the report before and after.',
      ];

      if (rawPerDayGb > 5000 && !useSummary && !useAccel) {
        findings.push(warning('splunk.report-expensive', `As it stands the report reads up to ${round1(rawPerDayGb)}GB a day. That is what acceleration is for.`, { source: 'ArchToolKit' }));
      }

      const summaryTitle = searchTitle(`${title} - summary fill`, 'Summary fill');
      const summaryReadTitle = searchTitle(`${title} - from summary`, 'From summary');
      const summaryAgg = aggregate
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const as = /\bas\s+(\w+)$/i.exec(part);
          const name = as?.[1] ?? (part === 'count' ? 'count' : part.replace(/\W+/g, '_'));
          return `sum(${name}) as ${name}`;
        })
        .join(', ');

      // Summary windows are aligned and delayed, never overlapping: an overlap
      // that protects an alert double-counts in a summary.
      const summaryEarliest = spanMinutes >= 1440 ? '-1d@d' : spanMinutes >= 60 ? '-2h@h' : `-${spanMinutes * 2}m@m`;
      const summaryLatest = spanMinutes >= 1440 ? '@d' : spanMinutes >= 60 ? '-1h@h' : `-${spanMinutes}m@m`;
      const summaryCron = spanMinutes >= 1440 ? spreadCron(summaryTitle, 1440) : spanMinutes >= 60 ? `${(spreadCron(summaryTitle, 60).split(' ')[0] ?? '7')} * * * *` : spreadCron(summaryTitle, spanMinutes);

      const tstatsTitle = searchTitle(`${title} - tstats indexed fields`, 'tstats');
      const tstatsModelTitle = searchTitle(`${title} - tstats ${model}`, 'tstats model');
      const modelObject = model === 'Endpoint' ? 'Processes' : model;
      const modelFields                                                = {
        Web: { where: 'Web.status=5*', by: 'Web.uri_path, Web.status' },
        Authentication: { where: 'Authentication.action=failure', by: 'Authentication.src, Authentication.user' },
        Network_Traffic: { where: 'All_Traffic.action=blocked', by: 'All_Traffic.src, All_Traffic.dest_port' },
        Endpoint: { where: 'Processes.process_name=*', by: 'Processes.dest, Processes.process_name' },
      };
      const nodename = model === 'Network_Traffic' ? 'All_Traffic' : modelObject;
      const mf = modelFields[model] ?? { where: '', by: `${nodename}.dest` };

      return {
        tier: TIER,
        title: `Acceleration for "${title}"`,
        app,
        activation: 'reload',
        notes: [
          ...estimate,
          ...(useSummary
            ? [
                `The summary index ${summaryIndex} must exist on the indexers (indexes.conf there) before the fill search runs — collect into an index that does not exist writes nothing and logs one warning.`,
                `The fill search reads an aligned, delayed window (${summaryEarliest} to ${summaryLatest}) and nothing else. Overlapping windows are right for alerts and wrong for summaries: every overlap is counted twice.`,
                'collect writes with sourcetype stash, which does not count against the licence. Setting another sourcetype on collect makes it count.',
                'To backfill history, run the fill search over past windows with $SPLUNK_HOME/bin/splunk cmd python fill_summary_index.py -app ' + app + ` -name "${summaryTitle}" -et -30d@d -lt @h -dedup true — VERIFY its authentication options on your version; do not put a password on its command line.`,
              ]
            : []),
          ...(useAccel
            ? [
                'Report acceleration applies only when the report is shared (not private) and run with the same search string and a time range inside the accelerated range. Editing the search starts a new summary from nothing.',
                'The first build covers the whole accelerated range and is heavy; it starts on the next summary cron after deployment.',
              ]
            : []),
          ...(useTstats
            ? [
                'tstats reads only the index-time fields (index, sourcetype, host, source, _time and any indexed extractions) unless it reads an accelerated data model. It cannot see search-time fields such as uri_path from raw data.',
                ...(model ? [`summariesonly=t reads the ${model} acceleration summary only: fast, and blind to data not yet summarised. summariesonly=f fills the gap from raw events and is slower.`] : []),
              ]
            : []),
        ],
        before: [
          `index=_audit action=search info=completed savedsearch_name="${title}" earliest=-7d | stats count as runs, avg(total_run_time) as avg_seconds, avg(scan_count) as avg_scanned`,
          `| dbinspect index=${index} | stats sum(rawSize) as raw_bytes, sum(sizeOnDiskMB) as disk_mb by state`,
          ...(useSummary ? [`| rest /services/data/indexes splunk_server=* | search title=${summaryIndex} | table splunk_server, title, currentDBSizeMB   # must return every indexer`] : []),
          ...(useAccel ? ['| rest /services/admin/summarization by_tstats=t splunk_server=local | table summary.id, summary.complete, summary.size   # existing report summaries'] : []),
          ...(useTstats && model ? [`| rest /services/admin/summarization by_tstats=t splunk_server=local | search summary.id="*${model}*" | table summary.id, summary.complete`] : []),
        ],
        files: {
          'default/savedsearches.conf': [
            '# Cost estimate (from the form — measure it with the _audit search in DEPLOY.md):',
            ...estimate.map((line) => `#   ${line}`),
            '',
            `[${title}]`,
            ...foldSearch(reportPipeline),
            'description = The report itself.',
            'enableSched = 0',
            `dispatch.earliest_time = -${windowDays}d@d`,
            'dispatch.latest_time = now',
            'display.general.type = statistics',
            `request.ui_dispatch_app = ${app}`,
            ...(useAccel
              ? [
                  '',
                  '# Report acceleration. Splunk keeps a summary of the report’s results per',
                  '# time slice and answers from it. Only for a report whose commands before the',
                  '# first transforming command are all streamable.',
                  'auto_summarize = 1',
                  `auto_summarize.dispatch.earliest_time = -${accelRange}@h`,
                  'auto_summarize.cron_schedule = */10 * * * *',
                  '# Summaries that would be larger than this fraction of the raw data are not',
                  '# worth keeping and are suspended.',
                  'auto_summarize.max_summary_ratio = 0.1',
                  'auto_summarize.max_time = 3600',
                ]
              : []),
            '',
            ...(useSummary
              ? [
                  `[${summaryTitle}]`,
                  ...foldSearch([
                    base,
                    ...(pre ? [pre.startsWith('|') ? pre : `| ${pre}`] : []),
                    `| bin _time span=${span}`,
                    `| stats ${aggregate} by _time${byFields.length ? `, ${byFields.join(', ')}` : ''}`,
                    `| collect index=${summaryIndex} source="${summaryTitle}" marker="report=${splunkName(title, 'report')}"`,
                  ]),
                  `description = Fills ${summaryIndex} with one row per ${span}${byFields.length ? ` per ${byFields.join(' and ')}` : ''}.`,
                  'enableSched = 1',
                  `cron_schedule = ${summaryCron}`,
                  '# Aligned and one period behind, so late events are in and nothing is summarised twice.',
                  `dispatch.earliest_time = ${summaryEarliest}`,
                  `dispatch.latest_time = ${summaryLatest}`,
                  '# A missed run leaves a gap; schedule_window lets it start late rather than skip.',
                  `schedule_window = ${Math.max(5, Math.round(spanMinutes / 2))}`,
                  'realtime_schedule = 0',
                  'dispatch.ttl = 2p',
                  '',
                  `[${summaryReadTitle}]`,
                  ...foldSearch([`index=${summaryIndex} source="${summaryTitle}"`, `| stats ${summaryAgg}${by}`, '| sort - count']),
                  'description = The same report, read from the summary index.',
                  'enableSched = 0',
                  `dispatch.earliest_time = -${windowDays}d@d`,
                  'dispatch.latest_time = now',
                  'display.general.type = statistics',
                  '',
                ]
              : []),
            ...(useTstats
              ? [
                  `[${tstatsTitle}]`,
                  '# Indexed fields only: no data model, nothing to build, and usually the fastest',
                  '# search on the platform. Use it for volume, presence and "is it arriving".',
                  `search = | tstats count where index=${index}${sourcetype ? ` sourcetype=${sourcetype}` : ''} by _time span=${span}, host | timechart span=${span} sum(count) as events by host limit=20`,
                  'description = tstats over index-time fields.',
                  'enableSched = 0',
                  `dispatch.earliest_time = -${windowDays}d@d`,
                  'dispatch.latest_time = now',
                  '',
                  ...(model
                    ? [
                        `[${tstatsModelTitle}]`,
                        `# The CIM ${model} data model, accelerated (by the CIM add-on or ES) and read with`,
                        '# tstats. This is what makes search-time fields as fast as indexed ones.',
                        ...foldSearch([
                          `| tstats summariesonly=t count from datamodel=${model}.${nodename} where${mf.where ? ` ${mf.where}` : ''} by ${mf.by}, _time span=${span}`,
                          `| rename ${nodename}.* as *`,
                          `| stats sum(count) as count by ${mf.by.replace(new RegExp(`${nodename}\\.`, 'g'), '')}`,
                          '| sort - count',
                        ]),
                        `description = tstats over the ${model} data model.`,
                        'enableSched = 0',
                        `dispatch.earliest_time = -${windowDays}d@d`,
                        'dispatch.latest_time = now',
                      ]
                    : []),
                ]
              : []),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `index=_audit action=search info=completed (savedsearch_name="${title}"${useSummary ? ` OR savedsearch_name="${summaryReadTitle}"` : ''}${useTstats ? ` OR savedsearch_name="${tstatsTitle}"` : ''}) earliest=-24h | stats count, avg(total_run_time) as avg_seconds, avg(scan_count) as avg_scanned by savedsearch_name`,
          ...(useSummary
            ? [
                `index=_internal sourcetype=scheduler savedsearch_name="${summaryTitle}" | table _time, status, result_count, run_time`,
                `index=${summaryIndex} source="${summaryTitle}" earliest=-24h | stats count by _time | sort _time   # one group per ${span}, no gaps, no doubles`,
              ]
            : []),
          ...(useAccel ? [`| rest /services/admin/summarization by_tstats=f splunk_server=local | search saved_searches.*.name="${title}" | table summary.id, summary.complete, summary.size, summary.buckets   # VERIFY field names on your version`] : []),
          '# The search job inspector for the report shows "Using summaries" when acceleration is used.',
        ],
        backout: [
          ...(useAccel ? [`| rest /servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(title)} auto_summarize=0   # removes the report summary`] : []),
          ...(useSummary ? [`| rest /servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(summaryTitle)} disabled=1`, `# The summary data stays in ${summaryIndex} until it ages out; | delete needs the can_delete role and only hides it.`] : []),
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # or remove it from the deployer and apply shcluster-bundle`,
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_rba',
    tier: TIER,
    label: 'Risk-based alerting: risk rules and a risk incident rule',
    group: 'Security',
    description:
      'Risk rules that attribute a score, a risk object and threat objects with MITRE ATT&CK annotations instead of raising alerts, and one risk incident rule that raises a notable when an object’s accumulated risk and the number of distinct rules behind it both cross a threshold — for Splunk Enterprise Security.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_rba' },
      { id: 'es_version', label: 'Enterprise Security', control: 'select', default: '8', options: [
        { value: '7', label: 'ES 7.x — notables, Incident Review' },
        { value: '8', label: 'ES 8.x — findings, Mission Control' },
      ] },
      {
        id: 'rules',
        label: 'Risk rules',
        control: 'textarea',
        default: [
          'Excessive failed logins for a user | 20 | user:user | src:ip_address | T1110 | | tstats summariesonly=false count from datamodel=Authentication.Authentication where Authentication.action=failure by Authentication.user, Authentication.src | rename Authentication.* as * | where count > 10',
          'Script interpreter launched by an Office application | 40 | dest:system | process_name:process_name | T1566.001 | | tstats summariesonly=false count from datamodel=Endpoint.Processes where Processes.parent_process_name IN ("winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe") Processes.process_name IN ("powershell.exe", "cmd.exe", "wscript.exe", "cscript.exe", "mshta.exe", "rundll32.exe") by Processes.dest, Processes.user, Processes.process_name, Processes.parent_process_name | rename Processes.* as *',
          'User added to local Administrators | 30 | dest:system | user:user | T1098 | index=wineventlog sourcetype=XmlWinEventLog EventCode=4732 | stats count by dest, user, src_user',
        ].join('\n'),
        hint: 'Title | score | risk field:type | threat field:type or - | ATT&CK technique | search',
      },
      { id: 'rule_frequency', label: 'Run risk rules every', control: 'select', default: '60', options: [
        { value: '15', label: '15 minutes' },
        { value: '60', label: 'Hour' },
        { value: '1440', label: 'Day' },
      ] },
      { id: 'dedupe_hours', label: 'Count the same behaviour once per (hours)', control: 'number', default: 24, min: 0, max: 168, hint: 'Throttles each rule per risk object, so one noisy host does not score 24 times a day' },
      { id: 'incident_window', label: 'Incident rule looks back', control: 'select', default: '24h', options: [
        { value: '24h', label: '24 hours' },
        { value: '7d', label: '7 days' },
      ] },
      { id: 'threshold', label: 'Risk score threshold', control: 'number', default: 100, min: 1, max: 100000 },
      { id: 'min_sources', label: 'Distinct risk rules at least', control: 'number', default: 2, min: 1, max: 50 },
      { id: 'min_tactics', label: 'Distinct ATT&CK tactics at least', control: 'number', default: 0, min: 0, max: 14, hint: '0 does not require any' },
      { id: 'incident_frequency', label: 'Run the incident rule every', control: 'select', default: '60', options: [
        { value: '15', label: '15 minutes' },
        { value: '60', label: 'Hour' },
      ] },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_rba'), 'org_rba');
      const es8 = str(values, 'es_version', '8') === '8';
      const ruleEvery = Number(str(values, 'rule_frequency', '60')) || 60;
      const dedupeHours = num(values, 'dedupe_hours', 24);
      const incidentWindow = str(values, 'incident_window', '24h');
      const threshold = num(values, 'threshold', 100);
      const minSources = num(values, 'min_sources', 2);
      const minTactics = num(values, 'min_tactics', 0);
      const incidentEvery = Number(str(values, 'incident_frequency', '60')) || 60;
      const findings            = [];

      const rules = linesOf(str(values, 'rules', '')).map((line) => {
        const parts           = [];
        let rest = line;
        for (let i = 0; i < 5; i += 1) {
          const [head, tail] = splitFirst(rest);
          parts.push(head);
          rest = tail;
        }
        const [riskField, riskType] = (parts[2] ?? '').split(':').map((s) => s.trim());
        const [threatField, threatType] = (parts[3] ?? '').split(':').map((s) => s.trim());
        return {
          title: searchTitle(`RR - ${parts[0] ?? 'Risk rule'}`, 'RR - Risk rule'),
          name: parts[0] ?? 'Risk rule',
          score: Number(parts[1]) || 0,
          riskField: riskField ?? '',
          riskType: riskType || 'system',
          threatField: threatField && threatField !== '-' ? threatField : '',
          threatType: threatType || 'other',
          technique: (parts[4] ?? '').toUpperCase(),
          search: rest.trim().replace(/^\|\s*\|/, '|'),
        };
      });

      if (rules.length === 0) findings.push(error('splunk.rba-no-rules', 'No risk rules, so nothing ever contributes risk and the incident rule never fires.', { source: 'ArchToolKit' }));
      const titles = rules.map((r) => r.title);
      const dup = titles.find((t, i) => titles.indexOf(t) !== i);
      if (dup) findings.push(error('splunk.rba-duplicate-rule', `Two risk rules are called "${dup}". Saved search names are unique per app; the second replaces the first.`, { source: 'ArchToolKit' }));

      for (const r of rules) {
        if (!r.search) {
          findings.push(error('splunk.rba-empty-search', `${r.title} has no search.`, { source: 'ArchToolKit' }));
          continue;
        }
        if (!/^(index=|\|\s*(tstats|from|datamodel|inputlookup)\b)/i.test(r.search)) {
          findings.push(error('splunk.rba-no-index', `${r.title} does not start with index= or | tstats. A risk rule that searches every index is the one that gets skipped when the scheduler is busy.`, { source: 'ArchToolKit' }));
        }
        if (!r.riskField) findings.push(error('splunk.rba-no-risk-object', `${r.title} has no risk object field, so the risk has nothing to attach to.`, { source: 'ArchToolKit' }));
        if (!['system', 'user', 'other'].includes(r.riskType)) {
          findings.push(warning('splunk.rba-risk-type', `${r.title}: risk object type "${r.riskType}". Enterprise Security ships system, user and other; a custom type must exist in the risk object types before it is usable.`, { source: 'ArchToolKit' }));
        }
        if (r.riskField && !new RegExp(`\\b${r.riskField}\\b`).test(r.search)) {
          findings.push(warning('splunk.rba-risk-field-missing', `${r.title}: the risk object field "${r.riskField}" does not appear in the search, so the rule may produce results with no risk object — which ES drops without saying so.`, { source: 'ArchToolKit' }));
        }
        if (r.score > 80 || r.score >= threshold) {
          findings.push(
            warning('splunk.rba-score-high', `${r.title} scores ${r.score}, which crosses the threshold of ${threshold} on its own or nearly so. Then the incident rule is just a per-detection alert with extra steps.`, {
              remediation: 'Keep individual scores well under the threshold, so an incident needs corroboration.',
              source: 'ArchToolKit',
            }),
          );
        }
        if (r.score <= 0) findings.push(error('splunk.rba-no-score', `${r.title} has no score.`, { source: 'ArchToolKit' }));
        if (!/^T\d{4}(\.\d{3})?$/.test(r.technique)) {
          findings.push(warning('splunk.rba-no-mitre', `${r.title} has no ATT&CK technique id (T1234 or T1234.001). Without it the rule counts towards no tactic, and the tactic threshold cannot see it.`, { source: 'ArchToolKit' }));
        }
      }
      if (minSources < 2) {
        findings.push(warning('splunk.rba-single-source', 'With one distinct rule enough, a single noisy rule firing repeatedly raises an incident on its own. Requiring two distinct rules is what makes the incident mean corroborated behaviour.', { source: 'ArchToolKit' }));
      }
      if (minTactics > 0 && rules.filter((r) => r.technique).length < minTactics) {
        findings.push(warning('splunk.rba-tactics-unreachable', `The incident rule needs ${minTactics} distinct tactics and fewer rules than that carry a technique.`, { source: 'ArchToolKit' }));
      }
      if (dedupeHours === 0) {
        findings.push(warning('splunk.rba-no-dedupe', 'Without throttling, a rule that keeps matching the same object adds its score on every run: an hourly rule scoring 20 contributes 480 a day for one ongoing behaviour.', { source: 'ArchToolKit' }));
      }

      const ruleWindow = searchWindow(ruleEvery);
      const incidentTitle = searchTitle(`RIR - Risk threshold exceeded for object over ${incidentWindow}`, 'RIR - Risk threshold exceeded');
      const tuningTitle = searchTitle('RBA tuning - risk contribution by rule', 'RBA tuning');
      const incidentWindowSearch = searchWindow(incidentEvery);
      const severity = threshold >= 200 ? 'critical' : 'high';

      const incidentPipeline = [
        '| tstats summariesonly=false sum(All_Risk.calculated_risk_score) as risk_score, count as risk_event_count, dc(source) as source_count, values(source) as source, dc(All_Risk.annotations.mitre_attack.mitre_tactic_id) as mitre_tactic_id_count, values(All_Risk.annotations.mitre_attack.mitre_tactic_id) as mitre_tactic_id, values(All_Risk.annotations.mitre_attack.mitre_technique_id) as mitre_technique_id from datamodel=Risk.All_Risk where All_Risk.risk_object_type!="" by All_Risk.risk_object, All_Risk.risk_object_type',
        '| rename All_Risk.* as *',
        `| where risk_score >= ${threshold} AND source_count >= ${minSources}${minTactics > 0 ? ` AND mitre_tactic_id_count >= ${minTactics}` : ''}`,
        '| eval risk_score=round(risk_score, 0)',
      ];

      return {
        tier: TIER,
        title: `Risk-based alerting: ${rules.length} risk rule${rules.length === 1 ? '' : 's'} and a risk incident rule`,
        app,
        activation: 'reload',
        notes: [
          'Risk rules raise no alert. Each writes a risk event to index=risk with a score against a risk object (a user or a system); the incident rule reads the Risk data model and raises one notable when an object has accumulated enough risk from enough different rules. That is the point: many weak signals, one well-supported incident.',
          `Tune in this order. (1) Run each rule over 30 days with the score shown and look at which objects it would have scored. (2) Run "${tuningTitle}" weekly: the rules contributing most risk to objects that never become incidents are noise — lower their score, narrow them, or add an exception lookup. (3) Only then move the threshold.`,
          `The incident rule fires when sum(risk_score) ≥ ${threshold} and at least ${minSources} distinct rules contributed over ${incidentWindow}${minTactics > 0 ? `, across at least ${minTactics} ATT&CK tactics` : ''}. It is throttled per risk object for ${incidentWindow} so one object is one incident, not one per run.`,
          'Scores add up across rules, and risk modifiers (ES) can raise them for privileged users or critical assets — calculated_risk_score, which the incident rule uses, includes those. Watch that a VIP with a 2x modifier does not cross the threshold on one rule.',
          'The MITRE annotation is a technique id. ES maps it to tactics through its bundled ATT&CK data; the tactic count in the incident rule depends on that mapping — VERIFY it is populated: | tstats count from datamodel=Risk.All_Risk by All_Risk.annotations.mitre_attack.mitre_tactic_id',
          es8
            ? 'ES 8: notables are called findings, risk incident rules are finding-based detections, and investigation happens in Mission Control. The savedsearches.conf settings written here (action.risk, action.notable, action.correlationsearch.*) are the ones ES 7 uses; ES 8 still reads them for detections deployed as apps — VERIFY on your ES 8 release, and consider re-creating the incident rule as a finding-based detection in the ES 8 editor, which groups findings natively.'
            : 'ES 7: the incident rule creates a notable for Incident Review. Keep "Risk Notable" style rules few: this is the only one most organisations need.',
          'Deploy this app to the ES search head (or the ES search head cluster via its deployer). The Risk data model must be accelerated — it is, by default, in ES.',
        ],
        before: [
          '| rest splunk_server=local /services/apps/local | search title=SplunkEnterpriseSecuritySuite | table title, version',
          '| tstats summariesonly=false count from datamodel=Risk.All_Risk where earliest=-7d by All_Risk.risk_object_type',
          ...rules.slice(0, 3).map((r) => `# Over the last 30 days, in the search bar: ${r.search} | stats count as would_fire, dc(${r.riskField || 'host'}) as objects`),
          '| rest splunk_server=local /servicesNS/-/-/saved/searches | search action.risk=1 disabled=0 | stats count   # existing risk rules',
        ],
        files: {
          'default/savedsearches.conf': [
            ...rules.flatMap((r) => {
              const risk = [
                { risk_object_field: r.riskField, risk_object_type: r.riskType, risk_score: r.score },
                ...(r.threatField ? [{ threat_object_field: r.threatField, threat_object_type: r.threatType }] : []),
              ];
              const annotations = { mitre_attack: r.technique ? [r.technique] : [] };
              return [
                `[${r.title}]`,
                ...foldSearch(r.search.split(/\s(?=\|\s)/).map((s) => s.trim())),
                `description = Risk rule: ${r.name}. Scores ${r.score} against ${r.riskField} (${r.riskType}). MITRE ${r.technique || 'none'}.`,
                'enableSched = 1',
                `cron_schedule = ${spreadCron(r.title, ruleEvery)}`,
                `dispatch.earliest_time = ${ruleWindow.earliest}`,
                `dispatch.latest_time = ${ruleWindow.latest}`,
                'schedule_window = auto',
                'dispatch.ttl = 4p',
                'counttype = number of events',
                'relation = greater than',
                'quantity = 0',
                '',
                '# Enterprise Security correlation search metadata. The annotations are what',
                '# put this rule on the ATT&CK matrix and into the tactic count.',
                'action.correlationsearch.enabled = 1',
                `action.correlationsearch.label = ${r.title}`,
                `action.correlationsearch.annotations = ${JSON.stringify(annotations)}`,
                '',
                '# Risk attribution: the risk object gets the score; threat objects are what',
                '# the analyst pivots on (an IP, a process, a hash) and carry no score.',
                'action.risk = 1',
                `action.risk.param._risk = ${JSON.stringify(risk)}`,
                `action.risk.param._risk_message = ${r.name}: $${r.riskField}$${r.threatField ? ` (${r.threatField} $${r.threatField}$)` : ''}`,
                '# Scores come from _risk above; the legacy single score stays 0.',
                'action.risk.param._risk_score = 0',
                'action.risk.param.verbose = 0',
                ...(dedupeHours > 0
                  ? [
                      '',
                      '# Count the same behaviour on the same object once per period, so an ongoing',
                      '# condition does not add its score on every run. alert.suppress.fields only',
                      '# throttles per-result alerts (savedsearches.conf.spec); in digest mode (the',
                      '# default) the first object would suppress the whole rule and a second object',
                      '# behaving the same way inside the period would score nothing. digest_mode = 0',
                      '# runs the risk action once per result row, which is how each row becomes its',
                      '# own risk event anyway (VERIFY in a test run on your ES version: one risk event',
                      '# per object, and a second object within the period still scores).',
                      'alert.digest_mode = 0',
                      'alert.suppress = 1',
                      `alert.suppress.period = ${dedupeHours}h`,
                      `alert.suppress.fields = ${[r.riskField, r.threatField].filter(Boolean).join(', ')}`,
                    ]
                  : []),
                '',
              ];
            }),
            `[${incidentTitle}]`,
            ...foldSearch(incidentPipeline),
            `description = Risk incident rule: an object with accumulated risk >= ${threshold} from >= ${minSources} distinct risk rules over ${incidentWindow}.`,
            'enableSched = 1',
            `cron_schedule = ${spreadCron(incidentTitle, incidentEvery)}`,
            `dispatch.earliest_time = -${incidentWindow}`,
            `dispatch.latest_time = ${incidentWindowSearch.latest}`,
            'schedule_window = auto',
            'dispatch.ttl = 4p',
            'counttype = number of events',
            'relation = greater than',
            'quantity = 0',
            '',
            'action.correlationsearch.enabled = 1',
            `action.correlationsearch.label = ${incidentTitle}`,
            'action.correlationsearch.annotations = {}',
            '',
            `# The ${es8 ? 'finding' : 'notable'} the analyst works. One per risk object per window.`,
            'action.notable = 1',
            'action.notable.param.rule_title = Risk threshold exceeded for $risk_object_type$ $risk_object$ ($risk_score$ from $source_count$ rules)',
            `action.notable.param.rule_description = $risk_object$ accumulated a risk score of $risk_score$ from $source_count$ distinct risk rules over ${incidentWindow}. Review the contributing risk events before the individual alerts.`,
            'action.notable.param.security_domain = threat',
            `action.notable.param.severity = ${severity}`,
            'action.notable.param.drilldown_name = Risk events for $risk_object$',
            'action.notable.param.drilldown_search = | from datamodel:"Risk.All_Risk" | search risk_object="$risk_object$" | table _time, source, risk_score, risk_message, threat_object',
            'action.notable.param.drilldown_earliest_offset = $info_min_time$',
            'action.notable.param.drilldown_latest_offset = $info_max_time$',
            '# One per risk object per window: per-result alerting (digest_mode = 0) so the',
            '# throttle applies per risk_object value. In digest mode it would throttle the',
            '# whole search, and a second object crossing the threshold inside the window',
            '# would get no ' + (es8 ? 'finding' : 'notable') + '.',
            'alert.digest_mode = 0',
            'alert.suppress = 1',
            `alert.suppress.period = ${incidentWindow === '7d' ? '168h' : '24h'}`,
            'alert.suppress.fields = risk_object, risk_object_type',
            '',
            `[${tuningTitle}]`,
            '# Run weekly. The rules at the top that rarely lead to an incident are the ones',
            '# to lower, narrow or except — not the threshold.',
            ...foldSearch([
              '| tstats summariesonly=false sum(All_Risk.calculated_risk_score) as risk, count as events, dc(All_Risk.risk_object) as objects from datamodel=Risk.All_Risk by source',
              '| eventstats sum(risk) as total',
              '| eval share_pct=round(risk / total * 100, 1)',
              '| sort - risk',
              '| fields source, events, objects, risk, share_pct',
            ]),
            'description = RBA tuning: which risk rules contribute most risk.',
            'enableSched = 0',
            'dispatch.earliest_time = -7d@d',
            'dispatch.latest_time = now',
            'display.general.type = statistics',
          ],
          'metadata/default.meta': defaultMeta(['*'], ['admin', 'ess_admin']),
        },
        verify: [
          '| rest splunk_server=local /servicesNS/-/-/saved/searches | search eai:acl.app=' + app + ' | table title, disabled, cron_schedule, action.risk, action.notable',
          ...rules.slice(0, 2).map((r) => `index=risk search_name="${r.title}" earliest=-24h | stats count, sum(risk_score) as risk by risk_object, risk_object_type`),
          `index=_internal sourcetype=scheduler savedsearch_name IN ("${rules[0]?.title ?? ''}", "${incidentTitle}") earliest=-24h | table _time, savedsearch_name, status, result_count`,
          `index=notable search_name="${incidentTitle}" earliest=-7d | table _time, risk_object, risk_score, source_count${es8 ? '   # ES 8 findings are still written to index=notable — VERIFY' : ''}`,
          `| savedsearch "${incidentTitle}"   # results now, before throttling`,
        ],
        backout: [
          ...rules.map((r) => `| rest /servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(r.title)} disabled=1`),
          `| rest /servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(incidentTitle)} disabled=1`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # via the ES search head cluster deployer, if clustered`,
          '# Risk events and notables already written stay in index=risk and index=notable — they are data, not configuration.',
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_platform_health',
    tier: TIER,
    label: 'Platform health alerts and dashboard',
    group: 'Platform health',
    description:
      'A search-head app that watches the platform itself: forwarders that have gone quiet against an expected-hosts list (from the imported estate or your own), skipped searches, indexing latency, licence use against quota, blocked queues, HEC errors, KV store status and indexer-cluster trouble — each a throttled alert — plus a Dashboard Studio overview.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_platform_health' },
      { id: 'hosts_source', label: 'Expected hosts from', control: 'select', default: 'estate', options: [
        { value: 'estate', label: 'The imported estate (powered-on VMs), or the list below if none is loaded' },
        { value: 'list', label: 'The list below' },
      ] },
      { id: 'host_naming', label: 'Splunk sees hosts as', control: 'select', default: 'short', options: [
        { value: 'short', label: 'Short names — web01 (the forwarder default)' },
        { value: 'fqdn', label: 'Fully qualified — web01.example.com' },
      ], showWhen: { input: 'hosts_source', equals: ['estate'] } },
      { id: 'expected_hosts', label: 'Expected hosts', control: 'textarea', default: 'dc01\ndc02\nweb01\nweb02\ndb01', hint: 'One per line, as they appear in the host field' },
      { id: 'missing_minutes', label: 'A host is missing after (minutes)', control: 'number', default: 60, min: 5, max: 10080 },
      { id: 'check_skipped', label: 'Skipped and deferred searches', control: 'toggle', default: true },
      { id: 'skipped_pct', label: 'Skipped above (%)', control: 'number', default: 5, min: 0, max: 100, showWhen: { input: 'check_skipped', equals: ['true'] } },
      { id: 'check_latency', label: 'Indexing latency', control: 'toggle', default: true },
      { id: 'latency_seconds', label: 'Latency above (seconds, 95th percentile)', control: 'number', default: 300, min: 10, max: 86400, showWhen: { input: 'check_latency', equals: ['true'] } },
      { id: 'check_license', label: 'Licence use against quota', control: 'toggle', default: true },
      { id: 'license_pct', label: 'Licence above (%)', control: 'number', default: 80, min: 1, max: 200, showWhen: { input: 'check_license', equals: ['true'] } },
      { id: 'check_queues', label: 'Blocked queues', control: 'toggle', default: true },
      { id: 'check_hec', label: 'HEC errors', control: 'toggle', default: true },
      { id: 'check_kvstore', label: 'KV store status', control: 'toggle', default: true },
      { id: 'check_cluster', label: 'Indexer cluster: bucket fixup and replication errors', control: 'toggle', default: true },
      { id: 'recipients', label: 'Email alerts to', control: 'text', default: 'splunk-admins@example.com', hint: 'Empty lists them in Triggered Alerts only' },
      { id: 'throttle_hours', label: 'Repeat an alert for the same thing after (hours)', control: 'number', default: 4, min: 1, max: 168 },
      { id: 'dashboard', label: 'Dashboard Studio overview', control: 'toggle', default: true },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_platform_health'), 'org_platform_health');
      const fromEstate = str(values, 'hosts_source', 'estate') === 'estate';
      const fqdn = str(values, 'host_naming', 'short') === 'fqdn';
      const estateHosts = fromEstate ? estateHostNames(fqdn) : null;
      const listed = listOf(str(values, 'expected_hosts', '')).map((h) => h.toLowerCase());
      const expected = estateHosts && estateHosts.length > 0 ? estateHosts : listed;
      const missingMinutes = num(values, 'missing_minutes', 60);
      const skippedPct = num(values, 'skipped_pct', 5);
      const latencySeconds = num(values, 'latency_seconds', 300);
      const licensePct = num(values, 'license_pct', 80);
      const recipients = str(values, 'recipients', '').trim();
      const throttle = `${num(values, 'throttle_hours', 4)}h`;
      const findings            = [];

      if (fromEstate && !estateHosts) {
        findings.push(warning('splunk.health-no-estate', 'No estate is loaded, so the expected-hosts list comes from the form. Import an RVTools export or inventory to build it from the powered-on VMs.', { source: 'ArchToolKit' }));
      }
      if (expected.length === 0) {
        findings.push(error('splunk.health-no-expected-hosts', 'The expected-hosts list is empty, so a forwarder that stops sending is indistinguishable from one that never existed. The missing-forwarder alert would never fire.', { source: 'ArchToolKit' }));
      }
      if (missingMinutes < 15) {
        findings.push(warning('splunk.health-missing-too-soon', `A host counts as missing after ${missingMinutes} minutes. Forwarders restart, networks blip and quiet hosts are quiet: under 15 minutes this alert pages for reboots.`, { source: 'ArchToolKit' }));
      }
      if (!recipients) {
        findings.push(warning('splunk.health-no-recipients', 'No recipients: the alerts are listed under Triggered Alerts and nobody is told. Platform health alerts are the ones that fire when nobody is looking at Splunk.', { source: 'ArchToolKit' }));
      }

                    
                   
                      
                        
                      
                         
                       
                           
                               
                         
                                         
                      
                         
        

      const checks          = [
        {
          id: 'missing',
          title: 'Platform - Forwarder not reporting',
          purpose: `An expected host has sent nothing, not even its own _internal logs, for ${missingMinutes} minutes.`,
          every: 30,
          earliest: '-24h',
          latest: 'now',
          pipeline: [
            '| tstats latest(_time) as last_seen where (index=* OR index=_internal) by host',
            '| eval host=lower(host)',
            '| append [| inputlookup expected_hosts | eval host=lower(host), expected=1 | fields host, expected, owner]',
            '| stats max(last_seen) as last_seen, max(expected) as expected, values(owner) as owner by host',
            `| where expected=1 AND (isnull(last_seen) OR last_seen < relative_time(now(), "-${missingMinutes}m"))`,
            '| eval minutes_silent=if(isnull(last_seen), "over 1440", tostring(round((now() - last_seen) / 60, 0))), last_seen=if(isnull(last_seen), "not in the last 24 hours", strftime(last_seen, "%Y-%m-%d %H:%M:%S"))',
            '| table host, owner, last_seen, minutes_silent',
          ],
          throttleFields: 'host',
          severity: '4',
          viz: 'table',
          panel: 'Expected hosts not reporting',
        },
      ];
      if (bool(values, 'check_skipped', true)) {
        checks.push({
          id: 'skipped',
          title: 'Platform - Scheduled searches skipped',
          purpose: `More than ${skippedPct}% of scheduled runs on a search head were skipped in the last hour, or a search was deferred repeatedly.`,
          every: 60,
          earliest: '-65m@m',
          latest: 'now',
          pipeline: [
            'index=_internal sourcetype=scheduler (status=success OR status=skipped OR status=deferred OR status=continued)',
            '| stats count(eval(status="skipped")) as skipped, count(eval(status="deferred")) as deferred, count as runs, values(eval(if(status="skipped", reason, null()))) as reasons by host',
            '| eval skipped_pct=round(skipped / runs * 100, 1)',
            `| where skipped_pct > ${skippedPct} OR deferred > 10`,
            '| sort - skipped_pct',
          ],
          throttleFields: 'host',
          severity: '3',
          viz: 'table',
          panel: 'Skipped and deferred searches',
          extra: ['# The reasons say what to fix: "maximum number of concurrent ... searches reached" is', '# too many searches for the cores; "The maximum disk usage quota" is a user quota.'],
        });
      }
      if (bool(values, 'check_latency', true)) {
        checks.push({
          id: 'latency',
          title: 'Platform - Indexing latency high',
          purpose: `The 95th percentile gap between an event's timestamp and when it was indexed exceeds ${latencySeconds}s for a sourcetype.`,
          every: 15,
          earliest: '-4h',
          latest: '+1h',
          pipeline: [
            'index=* _index_earliest=-15m@m _index_latest=@m',
            '| eval lag=_indextime - _time',
            '| stats count, perc95(lag) as p95_lag, max(lag) as max_lag, min(lag) as min_lag by index, sourcetype',
            `| where p95_lag > ${latencySeconds} OR min_lag < -300`,
            '| eval problem=if(min_lag < -300, "timestamps in the future - check TZ", "arriving late")',
            '| sort - p95_lag',
          ],
          throttleFields: 'index, sourcetype',
          severity: '3',
          viz: 'table',
          panel: 'Indexing latency by sourcetype (p95 seconds)',
          extra: [
            '# Reads only events indexed in the last 15 minutes (_index_earliest), with a',
            '# 4-hour timestamp window. Latency over 4 hours is not seen here. Sampled',
            '# 1 in 10: a percentile does not need every event, and this touches every index.',
            'dispatch.sample_ratio = 10',
          ],
        });
      }
      if (bool(values, 'check_license', true)) {
        checks.push({
          id: 'license',
          title: 'Platform - Licence use approaching quota',
          purpose: `Today's ingestion in a licence pool has passed ${licensePct}% of the pool's quota.`,
          every: 60,
          earliest: '@d',
          latest: 'now',
          pipeline: [
            'index=_internal source=*license_usage.log* type=Usage',
            '| stats sum(b) as used_bytes, max(poolsz) as quota_bytes by pool',
            '| eval used_gb=round(used_bytes / 1024 / 1024 / 1024, 2), quota_gb=round(quota_bytes / 1024 / 1024 / 1024, 2), used_pct=round(used_bytes / quota_bytes * 100, 1)',
            `| where used_pct >= ${licensePct}`,
            '| table pool, used_gb, quota_gb, used_pct',
          ],
          throttleFields: 'pool',
          severity: '4',
          viz: 'table',
          panel: 'Licence use today by pool',
          extra: ['# license_usage.log is written on the licence manager. It is only searchable here', '# if the licence manager forwards its _internal to the indexers, which it should.'],
        });
      }
      if (bool(values, 'check_queues', true)) {
        checks.push({
          id: 'queues',
          title: 'Platform - Queues blocked',
          purpose: 'A pipeline queue on an indexer or forwarder reported blocked=true repeatedly in the last 20 minutes.',
          every: 10,
          earliest: '-20m@m',
          latest: 'now',
          pipeline: [
            'index=_internal source=*metrics.log* group=queue blocked=true',
            '| stats count as blocked_samples, latest(current_size_kb) as current_kb, latest(max_size_kb) as max_kb by host, name',
            '| where blocked_samples >= 3',
            '| sort - blocked_samples',
          ],
          throttleFields: 'host, name',
          severity: '4',
          viz: 'table',
          panel: 'Blocked queues',
          extra: ['# The first blocked queue in the chain is the cause; the ones before it are', '# symptoms. indexqueue blocked means disk; typingqueue means regex or props cost.'],
        });
      }
      if (bool(values, 'check_hec', true)) {
        checks.push({
          id: 'hec',
          title: 'Platform - HEC errors',
          purpose: 'The HTTP Event Collector is rejecting or failing to parse events.',
          every: 15,
          earliest: '-20m@m',
          latest: 'now',
          pipeline: [
            'index=_internal sourcetype=splunkd component=HttpInputDataHandler (log_level=ERROR OR log_level=WARN)',
            '| rex "name=(?<token_name>[^,\\s]+)"',
            '| rex "parsing_err=\\"(?<parsing_err>[^\\"]+)"',
            '| stats count, latest(parsing_err) as example_error by host, token_name',
            '| where count > 10',
            '| sort - count',
          ],
          throttleFields: 'host, token_name',
          severity: '3',
          viz: 'table',
          panel: 'HEC errors by token',
          extra: ['# VERIFY: the name= and parsing_err= keys in HttpInputDataHandler messages on your', '# version. The raw message is always in the results either way.'],
        });
      }
      if (bool(values, 'check_kvstore', true)) {
        checks.push({
          id: 'kvstore',
          title: 'Platform - KV store not ready',
          purpose: 'The KV store on this search head is not in the ready state.',
          every: 15,
          earliest: '-15m',
          latest: 'now',
          pipeline: [
            '| rest splunk_server=local /services/kvstore/status',
            '| rename current.status as status, current.replicationStatus as replication_status',
            '| eval host=splunk_server',
            '| where status!="ready"',
            '| table host, status, replication_status',
          ],
          throttleFields: 'host',
          severity: '4',
          viz: 'table',
          panel: 'KV store status (this search head)',
          extra: ['# | rest splunk_server=local sees this search head only. On a search head cluster', '# the scheduled run lands on one member; check every member from the Monitoring Console.'],
        });
      }
      if (bool(values, 'check_cluster', true)) {
        checks.push({
          id: 'cluster',
          title: 'Platform - Indexer cluster bucket and replication errors',
          purpose: 'The cluster manager or peers are logging bucket replication or fixup errors.',
          every: 15,
          earliest: '-20m@m',
          latest: 'now',
          pipeline: [
            'index=_internal sourcetype=splunkd (component=CMMaster OR component=CMManager OR component=CMPeer OR component=CMRepJob OR component=CMBucket OR component=CMSlave) (log_level=ERROR OR log_level=WARN)',
            '| stats count, latest(_raw) as example by host, component',
            '| where count > 5',
            '| sort - count',
          ],
          throttleFields: 'host, component',
          severity: '4',
          viz: 'table',
          panel: 'Indexer cluster errors',
          extra: ['# VERIFY component names on 10.4: some log components kept their older names', '# (CMMaster, CMSlave) after the manager/peer rename, so both are searched. For the authoritative view, on the cluster manager:', '#   | rest splunk_server=local /services/cluster/manager/health'],
        });
      }

      const searchLines = (c       ) => foldSearch(c.pipeline);

      const conf           = [];
      for (const c of checks) {
        conf.push(
          `[${c.title}]`,
          ...searchLines(c),
          `description = ${c.purpose}`,
          'enableSched = 1',
          `cron_schedule = ${spreadCron(c.title, c.every)}`,
          `dispatch.earliest_time = ${c.earliest}`,
          `dispatch.latest_time = ${c.latest}`,
          'schedule_window = auto',
          'dispatch.ttl = 2p',
          ...(c.extra ?? []),
          ...alertLines(c.title, { throttleFields: c.throttleFields, throttle, recipients, severity: c.severity }),
          '',
        );
      }

      const dashboardId = 'platform_health';
      const panelQuery = (c       ) => c.pipeline.filter((l) => !/^\| where /.test(l)).join('\n');
      const studio = {
        title: 'Platform health',
        description: 'Each panel is its alert without the threshold.',
        inputs: {
          input_time: { type: 'input.timerange', title: 'Time range', options: { token: 'global_time', defaultValue: '-24h@h,now' } },
        },
        defaults: {
          dataSources: {
            'ds.search': { options: { queryParameters: { earliest: '$global_time.earliest$', latest: '$global_time.latest$' } } },
          },
        },
        dataSources: Object.fromEntries([
          ...checks.map((c) => [
            `ds_${c.id}`,
            {
              type: 'ds.search',
              name: c.panel,
              options: {
                query: panelQuery(c),
                ...(c.id === 'license' || c.id === 'latency' || c.id === 'kvstore' ? { queryParameters: { earliest: c.earliest, latest: c.latest } } : {}),
              },
            },
          ]),
          [
            'ds_skipped_trend',
            {
              type: 'ds.search',
              name: 'Scheduler outcomes over time',
              options: { query: 'index=_internal sourcetype=scheduler\n| timechart span=15m count by status' },
            },
          ],
        ]),
        visualizations: Object.fromEntries([
          ...checks.map((c) => [`viz_${c.id}`, { type: 'splunk.table', title: c.panel, description: c.purpose, dataSources: { primary: `ds_${c.id}` }, options: { count: 10 } }]),
          ['viz_skipped_trend', { type: 'splunk.line', title: 'Scheduler outcomes over time', dataSources: { primary: 'ds_skipped_trend' }, options: { legendDisplay: 'bottom' } }],
        ]),
        layout: {
          type: 'grid',
          options: {},
          globalInputs: ['input_time'],
          structure: [...checks.map((c) => `viz_${c.id}`), 'viz_skipped_trend'].map((item, i) => ({
            item,
            type: 'block',
            position: { x: (i % 2) * 600, y: Math.floor(i / 2) * 320, w: 600, h: 320 },
          })),
        },
      };
      const studioJson = JSON.stringify(studio, null, 2).split('\n');

      return {
        tier: TIER,
        title: `Platform health: ${checks.length} alerts${bool(values, 'dashboard', true) ? ' and a dashboard' : ''}`,
        app,
        activation: 'reload',
        notes: [
          estateHosts && estateHosts.length > 0
            ? `Expected hosts come from the imported estate (${currentEstate()?.origin ?? 'current estate'}): ${estateHosts.length} powered-on VMs by ${fqdn ? 'fully qualified' : 'short'} DNS name. Remove the ones that have no forwarder by design — appliances, and hosts that send syslog through a collector — or they alert for ever.`
            : `Expected hosts come from the list on the form (${expected.length}). The lookup is lookups/expected_hosts.csv; keep it current from the onboarding lists or the CMDB, because a host that is not on it is never reported missing.`,
          'The missing-forwarder alert counts a host as present if it sent anything, including its own _internal logs. A forwarder that is up but whose inputs are broken is still "present" — that is a data-quality check per sourcetype, not this one.',
          'Everything here reads _internal, _audit or REST, which needs the admin role (or a role with access to internal indexes). The app is readable by admin roles only.',
          `Every alert is throttled per affected object for ${throttle}: one silent host is one email per ${throttle}, and a second host going silent still alerts.`,
          'On Splunk Cloud Platform the Cloud Monitoring Console covers licence, ingestion and skipped searches, and _internal from the indexers is available but the cluster checks are Splunk’s to act on — keep the forwarder, HEC and search checks, disable the cluster one.',
          ...(bool(values, 'dashboard', true) ? ['The dashboard is Dashboard Studio (JSON inside a version="2" view). Written for Splunk Enterprise 10.4 and Splunk Cloud Platform 10.5; edit it in the Studio editor rather than by hand.'] : []),
        ],
        before: [
          '| tstats latest(_time) as last_seen where (index=* OR index=_internal) earliest=-24h by host | eval age_min=round((now() - last_seen) / 60) | sort - age_min | head 20',
          'index=_internal source=*license_usage.log* type=Usage earliest=@d | stats count by host   # empty means the licence manager does not forward _internal',
          'index=_internal sourcetype=scheduler earliest=-24h | stats count by status',
          '| rest splunk_server=local /services/kvstore/status | table current.status',
          `$SPLUNK_HOME/bin/splunk btool savedsearches list --app=${app} --debug | grep -E "^\\S+\\s+\\[" | head`,
        ],
        files: {
          'default/savedsearches.conf': conf,
          'default/transforms.conf': ['[expected_hosts]', 'filename = expected_hosts.csv', '# Host names compare case-insensitively: DC01 and dc01 are the same forwarder.', 'case_sensitive_match = false', 'max_matches = 1'],
          'lookups/expected_hosts.csv': ['host,owner,source', ...expected.map((h) => `${h},,${estateHosts && estateHosts.length > 0 ? 'estate' : 'list'}`)],
          ...(bool(values, 'dashboard', true)
            ? {
                [`default/data/ui/views/${dashboardId}.xml`]: [
                  '<dashboard version="2" theme="dark">',
                  '  <label>Platform health</label>',
                  '  <description></description>',
                  '  <definition><![CDATA[',
                  ...studioJson.map((l) => `    ${l}`),
                  '  ]]></definition>',
                  '  <meta type="hiddenElements"><![CDATA[',
                  '    {"hideEdit": false, "hideOpenInSearch": false, "hideExport": false}',
                  '  ]]></meta>',
                  '</dashboard>',
                ],
              }
            : {}),
          'metadata/default.meta': defaultMeta(['admin', 'sc_admin'], ['admin', 'sc_admin']),
        },
        verify: [
          `| rest splunk_server=local /servicesNS/-/${app}/saved/searches | table title, disabled, cron_schedule, alert.suppress.period`,
          `| inputlookup expected_hosts | stats count`,
          ...checks.slice(0, 3).map((c) => `| savedsearch "${c.title}"`),
          `index=_internal sourcetype=scheduler app=${app} earliest=-24h | stats count by savedsearch_name, status`,
          `index=_audit action=alert_fired ss_app=${app} earliest=-7d | stats count by ss_name`,
          ...(bool(values, 'dashboard', true) ? [`# Open /app/${app}/${dashboardId}`] : []),
        ],
        backout: [
          ...checks.map((c) => `| rest /servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(c.title)} disabled=1`),
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # or remove it from the deployer and apply shcluster-bundle`,
        ],
        findings,
      };
    },
  }),
];

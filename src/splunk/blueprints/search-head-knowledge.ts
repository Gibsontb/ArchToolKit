/**
 * Splunk search head: the knowledge objects people share, and the ways a search
 * reaches someone.
 *
 * Event types and tags, field aliases, calculated fields and automatic lookups,
 * workflow actions, a webhook alert, a custom alert action app, a report
 * delivered by email, and Federated Search to another Splunk deployment. All of
 * it is search-time: nothing here parses data, so none of it needs re-indexing
 * to change or to take out again.
 *
 * Everything is created enabled. The scripts apply when they are run; --dry-run
 * shows what they would do and changes nothing.
 */

import { bool, num, str, type BlueprintValues, type SelectOption } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { splunkBlueprint, type SplunkBlueprint } from '../from-app.ts';
import { defaultMeta, foldSearch, listOf, searchTitle, searchWindow, splunkName, spreadCron, type SplunkApp } from '../splunk.ts';

const TIER = 'search_head' as const;

// --- small helpers ----------------------------------------------------------

/** Non-empty, trimmed lines of a textarea, without comments. */
function linesOf(value: string): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** The " | " columns of one grid row, trimmed. */
function cells(line: string): string[] {
  return line.split('|').map((cell) => cell.trim());
}

/** Split "left | right" on the first separator only, so the right side may contain it. */
function splitFirst(line: string, separator = '|'): [string, string] {
  const at = line.indexOf(separator);
  if (at < 0) return [line.trim(), ''];
  return [line.slice(0, at).trim(), line.slice(at + separator.length).trim()];
}

/** A value in double quotes, for SPL. */
const q = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/** A value safe inside bash single quotes. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A script as a template, with bash's own `${...}` written `\${...}`.
 * String.raw keeps `\n` in a printf as `\n`; only `${` needs escaping.
 */
function script(strings: TemplateStringsArray, ...values: unknown[]): string[] {
  return String.raw(strings, ...values)
    .replace(/\\\$\{/g, '${')
    .replace(/^\n/, '')
    .replace(/\n$/, '')
    .split('\n');
}

/** A field name a search-time setting can produce or read. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Five cron fields, each made of digits, names, *, /, - and commas. */
function cronProblem(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `"${cron}" has ${fields.length} field${fields.length === 1 ? '' : 's'}; a Splunk cron schedule has five: minute hour day-of-month month day-of-week.`;
  if (!fields.every((f) => /^[0-9A-Za-z*/,-]+$/.test(f))) return `"${cron}" contains characters a cron schedule does not use.`;
  return null;
}

/** An address a Splunk email action will send to, or a $result.field$ token. */
const EMAIL = /^([^@\s,;]+@[^@\s,;]+\.[^@\s,;]+|\$result\.[A-Za-z0-9_.]+\$)$/;

/** The $field$ tokens a workflow action or a webhook uses, without the special $@...$ ones. */
function tokens(text: string): string[] {
  return [...text.matchAll(/\$!?([A-Za-z_][A-Za-z0-9_.]*)\$/g)].map((m) => m[1] ?? '').filter(Boolean);
}

/** Tags the Common Information Model data models look for, grouped by data model. */
const cim = (group: string, values: readonly string[]): SelectOption[] => values.map((value) => ({ value, label: value, group }));
const CIM_TAGS: readonly SelectOption[] = [
  ...cim('Authentication', ['authentication', 'default', 'privileged', 'cleartext', 'insecure']),
  ...cim('Change', ['change', 'account', 'audit', 'endpoint', 'network']),
  ...cim('Network Traffic and Sessions', ['communicate', 'session', 'start', 'end']),
  ...cim('Web and DNS', ['web', 'proxy', 'dns', 'resolution']),
  ...cim('Email', ['email', 'delivery', 'filter', 'content']),
  ...cim('Intrusion Detection and Malware', ['ids', 'attack', 'malware', 'operations']),
  ...cim('Vulnerabilities and Alerts', ['vulnerability', 'report', 'alert']),
  ...cim('Performance and Inventory', ['performance', 'cpu', 'memory', 'storage', 'os', 'inventory', 'uptime']),
  ...cim('Endpoint', ['process', 'filesystem', 'registry', 'listening', 'port', 'service']),
  ...cim('Certificates and Databases', ['certificate', 'ssl', 'database', 'instance', 'query']),
];

/** Every few minutes as a schedule, spread off the hour by spreadCron. */
const EVERY_MINUTES: readonly SelectOption[] = [
  { value: '5', label: 'Every 5 minutes' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '30', label: 'Every 30 minutes' },
  { value: '60', label: 'Every hour' },
  { value: '1440', label: 'Once a day' },
];

const THROTTLES: readonly SelectOption[] = ['10m', '30m', '1h', '4h', '24h'].map((value) => ({ value, label: value }));

const CRON_PRESETS: readonly SelectOption[] = [
  { value: '0 7 * * 1-5', label: 'Weekdays at 07:00' },
  { value: '0 7 * * *', label: 'Every day at 07:00' },
  { value: '0 7 * * 1', label: 'Mondays at 07:00' },
  { value: '30 17 * * 5', label: 'Fridays at 17:30' },
  { value: '0 7 1 * *', label: 'The first of the month at 07:00' },
  { value: '0 */4 * * *', label: 'Every 4 hours' },
];

/** Alert actions Splunk ships, which a custom action cannot be named after. */
const BUILT_IN_ACTIONS = new Set(['email', 'webhook', 'script', 'lookup', 'rss', 'summary_index', 'populate_lookup', 'logevent', 'notable', 'risk']);

export const SEARCH_HEAD_KNOWLEDGE_BLUEPRINTS: readonly SplunkBlueprint[] = [
  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_eventtypes_tags',
    tier: TIER,
    label: 'Event types and tags',
    group: 'Knowledge objects',
    description:
      'Named event types for the searches people keep retyping, each tagged — with the Common Information Model tags a data model looks for, or your own — so eventtype= and tag= find them in every app.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_eventtypes_acme' },
      {
        id: 'eventtypes',
        label: 'Event types',
        control: 'textarea',
        default: [
          'acme_auth | sourcetype="acme:auth" | authentication',
          'acme_auth_privileged | sourcetype="acme:auth" user IN (root, admin, administrator) | authentication, privileged',
          'acme_web | sourcetype=access_combined host=acme-web* | web',
        ].join('\n'),
        hint: 'name | search | tags (comma separated)',
      },
      { id: 'extra_tags', label: 'Also tag every event type with', control: 'checklist', default: '', options: CIM_TAGS, hint: 'Common Information Model tags; custom tags go in the tags column' },
      { id: 'priority', label: 'Priority', control: 'select', default: '5', hint: '1 is highest: which event type colours an event that matches several', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map((value) => ({ value, label: value })) },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_eventtypes'), 'org_eventtypes');
      const extra = listOf(str(values, 'extra_tags', ''));
      const priority = str(values, 'priority', '5');
      const findings: Finding[] = [];

      const rows = linesOf(str(values, 'eventtypes', '')).map((line) => {
        const parts = cells(line);
        const name = parts[0] ?? '';
        return {
          line,
          name: splunkName(name, ''),
          given: name,
          search: parts.length > 3 ? parts.slice(1, -1).join(' | ') : (parts[1] ?? ''),
          tags: [...new Set([...listOf(parts.length >= 3 ? (parts[parts.length - 1] ?? '') : ''), ...extra])],
          columns: parts.length,
        };
      });

      if (rows.length === 0) findings.push(error('splunk.eventtype-none', 'No event types were given, so the app would define nothing.'));
      for (const row of rows) {
        if (!row.name) {
          findings.push(error('splunk.eventtype-no-name', `"${row.line}" has no event type name.`));
          continue;
        }
        if (row.name === 'default') findings.push(error('splunk.eventtype-reserved', '"default" is the stanza every event type inherits from, not a name one can have.'));
        if (row.given !== row.name) findings.push(warning('splunk.eventtype-renamed', `"${row.given}" is written as ${row.name}, which is the name eventtype= will need.`));
        if (!row.search) findings.push(error('splunk.eventtype-no-search', `Event type ${row.name} has no search.`));
        if (row.columns > 3) {
          findings.push(
            error('splunk.eventtype-pipe', `Event type ${row.name} has a pipe in its search. An event type is a filter — search terms only — and Splunk rejects one with a pipe or a transforming command.`, {
              remediation: 'Keep only the terms before the first pipe here, and put the rest in a saved search or a macro that uses eventtype=.',
              source: 'eventtypes.conf.spec',
            }),
          );
        }
        if (/\[/.test(row.search)) findings.push(error('splunk.eventtype-subsearch', `Event type ${row.name} has a subsearch ([...]). Event types cannot contain one.`, { source: 'eventtypes.conf.spec' }));
        if (new RegExp(`eventtype\\s*=\\s*"?${row.name}"?(\\s|$)`).test(row.search)) findings.push(error('splunk.eventtype-self', `Event type ${row.name} refers to itself.`));
        const badTags = row.tags.filter((t) => !/^[A-Za-z0-9_-]+$/.test(t));
        if (badTags.length) findings.push(error('splunk.tag-invalid', `Event type ${row.name} has tag${badTags.length === 1 ? '' : 's'} ${badTags.join(', ')}: a tag is letters, digits, _ and - only.`));
        if (row.tags.length === 0) findings.push(warning('splunk.eventtype-untagged', `Event type ${row.name} has no tags, so tag= searches and data models never see it.`));
      }
      const names = rows.map((r) => r.name).filter(Boolean);
      const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
      if (duplicated.length) findings.push(error('splunk.eventtype-duplicate', `Event type ${duplicated[0]} is defined twice; the second silently replaces the first.`));

      const valid = rows.filter((r) => r.name && r.search);
      const first = valid[0]?.name ?? 'acme_auth';

      return {
        tier: TIER,
        title: `Event types and tags: ${valid.map((r) => r.name).join(', ') || 'none'}`,
        app,
        activation: 'reload',
        notes: [
          'Event types and tags are search-time. They classify events when a search runs, so they apply to everything already indexed, and they come out again with the app.',
          'An event type carries no index on purpose: it is applied to whatever the user searched, so naming an index would stop the tags matching the moment the data moves.',
          'A data model finds events by tag. An event that has every field the model needs but not its tags is not in the model, and tstats over it returns nothing — so the tags matter as much as the fields.',
          'Shared with export = system in metadata/default.meta. Without it, the event types and tags work only in searches run inside this app.',
        ],
        before: [
          `| rest splunk_server=local /servicesNS/-/-/saved/eventtypes | search title IN (${valid.map((r) => r.name).join(', ') || first}) | table title, eai:acl.app, search`,
          `$SPLUNK_HOME/bin/splunk btool eventtypes list --debug | grep -E "^\\S+\\s+\\[(${valid.map((r) => r.name).join('|') || first})\\]"   # nothing else defines these names`,
          ...valid.slice(0, 3).map((r) => `${r.search} earliest=-24h | stats count by sourcetype, index   # what ${r.name} will match`),
        ],
        files: {
          'default/eventtypes.conf': [
            '# Search terms only: no pipes, no subsearch, no index. The priority decides',
            '# which event type colours an event that matches more than one (1 is highest).',
            ...valid.flatMap((r) => [`[${r.name}]`, `search = ${r.search}`, `priority = ${priority}`, '']),
          ],
          'default/tags.conf': [
            '# Each tag is enabled for everything the event type matches.',
            ...valid.filter((r) => r.tags.length > 0).flatMap((r) => [`[eventtype=${r.name}]`, ...r.tags.map((t) => `${t} = enabled`), '']),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `eventtype=${first} earliest=-4h | stats count by eventtype, tag`,
          ...valid
            .filter((r) => r.tags.length > 0)
            .slice(0, 2)
            .map((r) => `tag=${r.tags[0]} earliest=-4h | stats count by eventtype`),
          `| rest splunk_server=local /servicesNS/-/-/configs/conf-tags | search eai:acl.app=${app} | table title, *`,
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}   # then https://<search-head>:8000/debug/refresh, or through the deployer on a cluster`],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_field_enrichment',
    tier: TIER,
    label: 'Field aliases, calculated fields and automatic lookups',
    group: 'Knowledge objects',
    description:
      'For one sourcetype: FIELDALIAS- to the names searches and data models expect, EVAL- calculated fields, and LOOKUP- automatic lookups with their transforms.conf definitions and CSV tables — search-time, so they apply to data already indexed.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_enrich_acme' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'acme:orders:log' },
      {
        id: 'aliases',
        label: 'Field aliases (FIELDALIAS-)',
        control: 'textarea',
        default: ['src_ip | src | AS', 'log_level | severity | ASNEW', 'uname | user | AS'].join('\n'),
        hint: 'original | alias | mode (AS or ASNEW)',
      },
      {
        id: 'evals',
        label: 'Calculated fields (EVAL-)',
        control: 'textarea',
        default: ['duration | round(duration_ms / 1000, 3)', 'action | if(status >= 400, "failure", "success")', 'vendor_product | "Acme Orders API"'].join('\n'),
        hint: 'field | eval expression',
      },
      {
        id: 'lookups',
        label: 'Automatic lookups (LOOKUP-)',
        control: 'textarea',
        default: ['acme_http_status | status | status_description, status_class | OUTPUTNEW', 'acme_asset_owner | host AS dest | owner, business_unit | OUTPUTNEW'].join('\n'),
        hint: 'lookup | match field | output fields | mode (OUTPUT or OUTPUTNEW)',
      },
      { id: 'case_sensitive', label: 'Case-sensitive lookup matching', control: 'toggle', default: false },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_enrich'), 'org_enrich');
      const sourcetype = str(values, 'sourcetype', '').trim();
      const caseSensitive = bool(values, 'case_sensitive', false);
      const findings: Finding[] = [];

      const aliases = linesOf(str(values, 'aliases', '')).map((line) => {
        const [from = '', to = '', mode = 'AS'] = cells(line);
        return { line, from, to, mode: (mode || 'AS').toUpperCase() };
      });
      const evals = linesOf(str(values, 'evals', '')).map((line) => {
        const [field, expression] = splitFirst(line);
        return { field, expression };
      });
      const lookups = linesOf(str(values, 'lookups', '')).map((line) => {
        const parts = cells(line);
        const name = splunkName(parts[0] ?? '', '');
        const match = parts[1] ?? '';
        const m = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(match);
        const outputs = listOf(parts[2] ?? '');
        return { line, name, lookupField: m?.[1] ?? '', eventField: m?.[2] ?? m?.[1] ?? '', outputs, mode: (parts[3] || 'OUTPUTNEW').toUpperCase(), columns: parts.length };
      });

      if (!sourcetype) findings.push(error('splunk.enrich-no-sourcetype', 'No sourcetype was given, so these settings would apply to nothing.'));
      if (/[*?]/.test(sourcetype)) findings.push(error('splunk.enrich-wildcard-sourcetype', `A props.conf sourcetype stanza is matched literally: [${sourcetype}] applies only to a sourcetype with that exact name, asterisk and all.`, { remediation: 'Name the sourcetype exactly, or use a source:: stanza, which accepts wildcards.', source: 'props.conf.spec' }));
      if (aliases.length + evals.length + lookups.length === 0) findings.push(error('splunk.enrich-nothing', 'No aliases, calculated fields or lookups were given.'));

      for (const a of aliases) {
        if (!a.from || !a.to) findings.push(error('splunk.alias-incomplete', `"${a.line}" needs the original field and the alias.`));
        else if (!FIELD_NAME.test(a.from) || !FIELD_NAME.test(a.to)) findings.push(error('splunk.alias-bad-name', `"${a.line}" has a field name Splunk will not accept.`));
        else if (a.from === a.to) findings.push(error('splunk.alias-self', `${a.from} is aliased to itself.`));
        if (a.mode !== 'AS' && a.mode !== 'ASNEW') findings.push(error('splunk.alias-mode', `"${a.line}": the mode is AS or ASNEW, not ${a.mode}.`));
      }
      const aliasTargets = aliases.map((a) => a.to).filter(Boolean);
      const dupAlias = aliasTargets.filter((n, i) => aliasTargets.indexOf(n) !== i);
      if (dupAlias.length) findings.push(error('splunk.alias-duplicate', `FIELDALIAS-${splunkName(dupAlias[0] ?? '', 'alias')} is declared twice; the second silently replaces the first.`));

      const evalFields = new Set(evals.map((e) => e.field));
      for (const e of evals) {
        if (!e.field || !e.expression) {
          findings.push(error('splunk.eval-incomplete', `"${e.field} | ${e.expression}" needs a field name and an expression.`));
          continue;
        }
        if (!FIELD_NAME.test(e.field)) findings.push(error('splunk.eval-bad-name', `EVAL-${e.field}: not a field name Splunk will accept.`));
        const uses = [...evalFields].filter((f) => f !== e.field && new RegExp(`(^|[^A-Za-z0-9_."'])${f.replace(/\./g, '\\.')}([^A-Za-z0-9_]|$)`).test(e.expression));
        if (uses.length) {
          findings.push(
            warning('splunk.eval-chain', `EVAL-${e.field} uses ${uses.join(', ')}, which is itself a calculated field. Calculated fields are evaluated independently, so ${e.field} sees the value from before any EVAL- ran — usually null.`, {
              remediation: 'Write the full expression in each calculated field rather than chaining them.',
              source: 'props.conf.spec',
            }),
          );
        }
        if (aliasTargets.includes(e.field)) findings.push(warning('splunk.eval-replaces-alias', `EVAL-${e.field} and a FIELDALIAS- both set ${e.field}. Calculated fields run after aliases, so the alias is always replaced.`));
      }
      const evalNames = evals.map((e) => e.field).filter(Boolean);
      const dupEval = evalNames.filter((n, i) => evalNames.indexOf(n) !== i);
      if (dupEval.length) findings.push(error('splunk.eval-duplicate', `EVAL-${dupEval[0]} is declared twice; the second silently replaces the first.`));

      for (const l of lookups) {
        if (!l.name) findings.push(error('splunk.lookup-no-name', `"${l.line}" has no lookup name.`));
        if (!l.lookupField) findings.push(error('splunk.lookup-no-input', `"${l.line}" has no field to match on (lookup_field, or lookup_field AS event_field).`));
        if (l.outputs.length === 0) findings.push(error('splunk.lookup-no-output', `Lookup ${l.name || l.line} adds no fields.`));
        if (l.mode !== 'OUTPUT' && l.mode !== 'OUTPUTNEW') findings.push(error('splunk.lookup-mode', `Lookup ${l.name}: the mode is OUTPUT or OUTPUTNEW, not ${l.mode}.`));
        const outputNames = l.outputs.map((o) => o.split(/\s+AS\s+/i).pop() ?? o);
        if (outputNames.includes(l.eventField)) findings.push(warning('splunk.lookup-overwrites-key', `Lookup ${l.name} writes ${l.eventField}, the field it matches on, so a miss or a second match changes the key itself.`));
        if (l.mode === 'OUTPUT' && outputNames.some((o) => aliasTargets.includes(o) || evalFields.has(o))) {
          findings.push(warning('splunk.lookup-overwrites-field', `Lookup ${l.name} uses OUTPUT, so it replaces ${outputNames.filter((o) => aliasTargets.includes(o) || evalFields.has(o)).join(', ')} set above — and blanks it on events the table has no row for.`));
        }
      }
      const lookupNames = lookups.map((l) => l.name).filter(Boolean);
      const dupLookup = lookupNames.filter((n, i) => lookupNames.indexOf(n) !== i);
      if (dupLookup.length) findings.push(error('splunk.lookup-duplicate', `Lookup ${dupLookup[0]} is declared twice; the second silently replaces the first.`));

      const goodAliases = aliases.filter((a) => a.from && a.to && a.from !== a.to && (a.mode === 'AS' || a.mode === 'ASNEW'));
      const goodEvals = evals.filter((e) => e.field && e.expression);
      const goodLookups = lookups.filter((l) => l.name && l.lookupField && l.outputs.length > 0);
      const lookupColumns = (l: (typeof lookups)[number]): string[] => [l.lookupField, ...l.outputs.map((o) => o.split(/\s+AS\s+/i)[0] ?? o)];

      return {
        tier: TIER,
        title: `Aliases, calculated fields and lookups for [${sourcetype || 'sourcetype'}]`,
        app,
        activation: 'reload',
        notes: [
          'Search-time only: this changes what searches see, never what is stored, so it applies to data already indexed and comes out again without re-indexing.',
          'Splunk applies these in a fixed order: FIELDALIAS-, then EVAL-, then LOOKUP-. A calculated field can use an alias; a lookup can match on a calculated field; nothing can use a field from a later step.',
          'AS sets the alias even when the event already has a field of that name; ASNEW only when it has none. OUTPUTNEW fills only fields the event does not have; OUTPUT replaces them — and empties them on events the table has no row for.',
          ...(goodLookups.length ? [`The lookup tables are ${goodLookups.map((l) => `${app}/lookups/${l.name}.csv`).join(', ')}, with the header row only. Every automatic lookup runs for every event of this sourcetype in every search, so keep the tables small; a large or changing table belongs in the KV store.`] : []),
          'Shared with export = system in metadata/default.meta; without it the fields exist only in searches run inside this app, which looks exactly like a setting that does not work.',
        ],
        before: [
          `$SPLUNK_HOME/bin/splunk btool props list ${q(sourcetype)} --debug | grep -E "FIELDALIAS-|EVAL-|LOOKUP-"   # what already applies, and from which app`,
          `sourcetype=${q(sourcetype)} earliest=-4h | head 1000 | fieldsummary | table field, count, distinct_count`,
          ...goodLookups.map((l) => `| inputlookup ${l.name}.csv | stats count   # fails until the table has rows`),
        ],
        files: {
          'default/props.conf': [
            '# Search-time only. No line breaking, timestamps or TRANSFORMS- here: a search',
            '# head never parses incoming data.',
            `[${sourcetype}]`,
            '',
            ...(goodAliases.length
              ? ['# 1. Field aliases. The original field stays; the alias is added.', ...goodAliases.map((a) => `FIELDALIAS-${splunkName(a.to, 'alias')} = ${a.from} ${a.mode} ${a.to}`), '']
              : []),
            ...(goodEvals.length
              ? ['# 2. Calculated fields. Each is evaluated on its own and replaces an extracted', '#    field of the same name.', ...goodEvals.map((e) => `EVAL-${e.field} = ${e.expression}`), '']
              : []),
            ...(goodLookups.length
              ? [
                  '# 3. Automatic lookups, defined in transforms.conf. They run last, so they can',
                  '#    match on an alias or a calculated field.',
                  ...goodLookups.map((l) => `LOOKUP-${l.name} = ${l.name} ${l.lookupField}${l.eventField !== l.lookupField ? ` AS ${l.eventField}` : ''} ${l.mode} ${l.outputs.join(' ')}`),
                ]
              : []),
          ],
          ...(goodLookups.length
            ? {
                'default/transforms.conf': [
                  '# Lookup definitions for the automatic lookups in props.conf.',
                  ...goodLookups.flatMap((l) => [
                    `[${l.name}]`,
                    `filename = ${l.name}.csv`,
                    `case_sensitive_match = ${caseSensitive ? 'true' : 'false'}`,
                    '# One row per match: enrichment, not a join that multiplies events.',
                    'max_matches = 1',
                    '',
                  ]),
                ],
                ...Object.fromEntries(goodLookups.map((l) => [`lookups/${l.name}.csv`, [lookupColumns(l).join(',')]])),
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `$SPLUNK_HOME/bin/splunk btool props list ${q(sourcetype)} --debug | grep -E "FIELDALIAS-|EVAL-|LOOKUP-"`,
          `sourcetype=${q(sourcetype)} earliest=-1h | head 1000 | stats ${[...goodAliases.map((a) => a.to), ...goodEvals.map((e) => e.field), ...goodLookups.flatMap((l) => l.outputs.map((o) => o.split(/\s+AS\s+/i).pop() ?? o))].slice(0, 8).map((f) => `count(${f}) as ${splunkName(f, 'f')}`).join(', ') || 'count'}, count as events`,
          `| rest splunk_server=local /servicesNS/-/-/data/props/lookups | search stanza=${q(sourcetype)} | table stanza, attribute, value, eai:acl.app`,
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}   # then /debug/refresh, or through the deployer on a cluster; nothing to re-index`],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_workflow_action',
    tier: TIER,
    label: 'Workflow action',
    group: 'Knowledge objects',
    description:
      'A right-click action on a field or an event: open a link with the field value in it (GET or POST), or run a search for it — offered only on events that have the fields it needs.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_workflow_actions' },
      { id: 'action_name', label: 'Action name', control: 'text', default: 'ipam_lookup_src_ip' },
      { id: 'label', label: 'Label in the menu', control: 'text', default: 'Look up $src_ip$ in IPAM', hint: '$field$ puts the value in' },
      { id: 'action_type', label: 'Type', control: 'select', default: 'link', options: [
        { value: 'link', label: 'link — open a URL' },
        { value: 'search', label: 'search — run a search' },
      ] },
      { id: 'fields', label: 'Fields an event must have', control: 'text', default: 'src_ip', hint: 'comma-separated; * for every event' },
      { id: 'eventtypes', label: 'Only for these event types', control: 'text', default: '', hint: 'comma-separated; empty for any' },
      { id: 'display_location', label: 'Show it in', control: 'select', default: 'both', options: [
        { value: 'both', label: 'Both the field menu and the event menu' },
        { value: 'field_menu', label: 'The field menu only' },
        { value: 'event_menu', label: 'The event menu only' },
      ] },
      { id: 'link_uri', label: 'URL', control: 'text', default: 'https://ipam.example.com/search?q=$src_ip$', hint: '$field$ is URL-encoded; $!field$ is not', showWhen: { input: 'action_type', equals: ['link'] } },
      { id: 'link_method', label: 'Method', control: 'select', default: 'get', options: [
        { value: 'get', label: 'GET — values in the URL' },
        { value: 'post', label: 'POST — values in the form body' },
      ], showWhen: { input: 'action_type', equals: ['link'] } },
      { id: 'post_args', label: 'POST arguments', control: 'textarea', default: 'q | $src_ip$', hint: 'key | value', showWhen: { input: 'link_method', equals: ['post'] } },
      { id: 'link_target', label: 'Open in', control: 'select', default: 'blank', options: [
        { value: 'blank', label: 'A new window' },
        { value: 'self', label: 'The same window' },
      ], showWhen: { input: 'action_type', equals: ['link'] } },
      { id: 'search_string', label: 'Search', control: 'textarea', default: 'index=netfw src_ip=$src_ip$ | stats count by dest_ip, dest_port, action', showWhen: { input: 'action_type', equals: ['search'] } },
      { id: 'search_app', label: 'Run it in app', control: 'text', default: 'search', showWhen: { input: 'action_type', equals: ['search'] } },
      { id: 'search_target', label: 'Open results in', control: 'select', default: 'blank', options: [
        { value: 'blank', label: 'A new window' },
        { value: 'self', label: 'The same window' },
      ], showWhen: { input: 'action_type', equals: ['search'] } },
      { id: 'preserve_timerange', label: 'Keep the time range of the search it came from', control: 'toggle', default: true, showWhen: { input: 'action_type', equals: ['search'] } },
      { id: 'search_earliest', label: 'Otherwise, earliest', control: 'text', default: '-24h@h', showWhen: { input: 'preserve_timerange', equals: ['false'] } },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_workflow_actions'), 'org_workflow_actions');
      const name = splunkName(str(values, 'action_name', ''), '');
      const label = str(values, 'label', '');
      const type = str(values, 'action_type', 'link');
      const fields = listOf(str(values, 'fields', '*'));
      const eventtypes = listOf(str(values, 'eventtypes', ''));
      const display = str(values, 'display_location', 'both');
      const uri = str(values, 'link_uri', '');
      const method = str(values, 'link_method', 'get');
      const postArgs = linesOf(str(values, 'post_args', '')).map((line) => splitFirst(line));
      const linkTarget = str(values, 'link_target', 'blank');
      const search = linesOf(str(values, 'search_string', '')).join(' ');
      const searchApp = splunkName(str(values, 'search_app', 'search'), 'search');
      const searchTarget = str(values, 'search_target', 'blank');
      const preserve = bool(values, 'preserve_timerange', true);
      const earliest = str(values, 'search_earliest', '-24h@h');
      const findings: Finding[] = [];

      if (!name) findings.push(error('splunk.workflow-no-name', 'The workflow action has no name.'));
      if (!label) findings.push(error('splunk.workflow-no-label', 'The workflow action has no label, so the menu would show an empty entry.'));
      if (type === 'link') {
        if (!uri) findings.push(error('splunk.workflow-no-uri', 'A link action needs a URL.'));
        else if (!/^https?:\/\//i.test(uri)) findings.push(error('splunk.workflow-uri-scheme', `"${uri}" is not an http or https URL.`));
        else if (/^http:\/\//i.test(uri)) findings.push(warning('splunk.workflow-http', `The link sends field values over plain http (${uri}), unencrypted.`));
        if (method === 'post' && postArgs.length === 0) findings.push(error('splunk.workflow-post-empty', 'A POST link with no arguments sends an empty form.'));
      }
      if (type === 'search' && !search) findings.push(error('splunk.workflow-no-search', 'A search action needs a search.'));

      const used = [...new Set(tokens([label, type === 'link' ? uri : search, ...postArgs.map(([, v]) => v)].join(' ')))];
      const everyField = fields.includes('*') || fields.length === 0;
      const unlisted = everyField ? [] : used.filter((t) => !fields.includes(t));
      if (unlisted.length) {
        findings.push(
          warning('splunk.workflow-token-unlisted', `The action uses $${unlisted.join('$, $')}$ but only requires ${fields.join(', ')}, so it is offered on events without ${unlisted.length === 1 ? 'that field' : 'those fields'} and the value is empty.`, {
            remediation: `Add ${unlisted.join(', ')} to the fields an event must have.`,
          }),
        );
      }
      if (everyField && used.length > 0) findings.push(warning('splunk.workflow-every-event', `fields = * offers the action on every event, including those with no ${used.join(', ')}, where the link or search has an empty value.`));

      return {
        tier: TIER,
        title: `Workflow action ${name || 'unnamed'} (${type})`,
        app,
        activation: 'reload',
        notes: [
          `The action appears in the ${display === 'both' ? 'field and event menus' : display === 'field_menu' ? 'field menu' : 'event menu'} of events that have ${everyField ? 'any fields' : fields.join(', ')}${eventtypes.length ? ` and match eventtype ${eventtypes.join(' or ')}` : ''}.`,
          type === 'link'
            ? `$field$ is URL-encoded in the link; $!field$ is inserted as it is, which is only right for a value that is already a URL path. ${method === 'post' ? 'POST sends the arguments as a form, so they are not in the browser history or the target’s access log.' : 'GET puts the values in the URL, where they land in the browser history and the target’s access log.'}`
            : `The search runs in the ${searchApp} app as the user who clicked, with that user’s own index permissions.`,
          'Shared with export = system in metadata/default.meta so it is offered in every app, not only this one.',
        ],
        before: [
          `| rest splunk_server=local /servicesNS/-/-/data/ui/workflow-actions | search title=${q(name)} | table title, eai:acl.app, type`,
          ...(everyField ? [] : [`index=* earliest=-1h ${fields.map((f) => `${f}=*`).join(' ')} | head 1 | table ${fields.join(', ')}`]),
        ],
        files: {
          'default/workflow_actions.conf': [
            `[${name}]`,
            `type = ${type}`,
            `label = ${label}`,
            '# Offered only on events with every one of these fields.',
            `fields = ${everyField ? '*' : fields.join(', ')}`,
            ...(eventtypes.length ? [`eventtypes = ${eventtypes.join(', ')}`] : []),
            `display_location = ${display}`,
            ...(type === 'link'
              ? [
                  `link.uri = ${uri}`,
                  `link.method = ${method}`,
                  `link.target = ${linkTarget}`,
                  ...(method === 'post' ? postArgs.flatMap(([k, v], i) => [`link.postargs.${i + 1}.key = ${k}`, `link.postargs.${i + 1}.value = ${v}`]) : []),
                ]
              : [
                  `search.search_string = ${search}`,
                  `search.app = ${searchApp}`,
                  'search.view = search',
                  `search.target = ${searchTarget}`,
                  `search.preserve_timerange = ${preserve ? 'true' : 'false'}`,
                  ...(preserve ? [] : [`search.earliest = ${earliest}`, 'search.latest = now']),
                ]),
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest splunk_server=local /servicesNS/-/-/data/ui/workflow-actions/${name} | table title, eai:acl.app, eai:acl.sharing, type, fields, display_location`,
          `Search for an event with ${everyField ? 'any field' : fields.join(', ')}, open its ${display === 'field_menu' ? 'field' : 'event'} menu: "${label.replace(/\$!?[A-Za-z0-9_.]+\$/g, '…')}" is listed`,
        ],
        backout: [`rm -rf $SPLUNK_HOME/etc/apps/${app}   # then /debug/refresh, or through the deployer on a cluster`],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_webhook_alert',
    tier: TIER,
    label: 'Webhook alert with an allow list',
    group: 'Alerting and reports',
    description:
      'A scheduled alert that POSTs to a webhook, with the alert_actions.conf [webhook] allow list entries that let that URL through — checked here against the URL before it is deployed.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_alert_webhook' },
      { id: 'title', label: 'Alert name', control: 'text', default: 'Acme service fatal errors' },
      { id: 'search', label: 'Search', control: 'textarea', default: 'index=app_prod sourcetype=app:events log_level=FATAL\n| stats count, latest(message) as message by host, service' },
      { id: 'every', label: 'Runs', control: 'select', default: '15', options: EVERY_MINUTES },
      { id: 'threshold', label: 'Trigger when results are more than', control: 'number', default: 0, min: 0 },
      { id: 'throttle', label: 'Throttle for', control: 'combo', default: '1h', options: THROTTLES },
      { id: 'throttle_fields', label: 'Throttle per', control: 'text', default: 'host, service', hint: 'comma-separated; empty throttles the alert as a whole' },
      { id: 'webhook_url', label: 'Webhook URL', control: 'text', default: 'https://hooks.example.com/services/acme/alerts' },
      {
        id: 'allowlist',
        label: 'Webhook allow list (alert_actions.conf [webhook])',
        control: 'textarea',
        default: String.raw`acme_hooks | https://hooks\.example\.com/services/acme/.*`,
        hint: 'name | regex',
      },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_alert_webhook'), 'org_alert_webhook');
      const title = searchTitle(str(values, 'title', ''), 'Webhook alert');
      const pipeline = linesOf(str(values, 'search', ''));
      const every = num(values, 'every', 15);
      const threshold = Math.max(0, num(values, 'threshold', 0));
      const throttle = str(values, 'throttle', '1h');
      const throttleFields = listOf(str(values, 'throttle_fields', ''));
      const url = str(values, 'webhook_url', '');
      const window = searchWindow(every);
      const findings: Finding[] = [];

      const allow = linesOf(str(values, 'allowlist', '')).map((line) => {
        const [given, regex] = splitFirst(line);
        return { name: splunkName(given, ''), regex };
      });

      if (pipeline.length === 0) findings.push(error('splunk.alert-no-search', 'The alert has no search.'));
      if (!url) findings.push(error('splunk.webhook-no-url', 'No webhook URL was given.'));
      else if (!/^https?:\/\/[^\s/]+/i.test(url)) findings.push(error('splunk.webhook-bad-url', `"${url}" is not an http or https URL.`));
      else if (/^http:\/\//i.test(url)) findings.push(warning('splunk.webhook-http', 'The webhook URL is plain http: the alert’s first result row and its search name travel unencrypted.'));
      if (!/^\d+[smhd]$/.test(throttle)) findings.push(error('splunk.alert-throttle', `"${throttle}" is not a period Splunk accepts: a number and s, m, h or d.`));
      if (throttleFields.some((f) => !FIELD_NAME.test(f))) findings.push(error('splunk.alert-throttle-field', `Throttle fields must be field names: ${throttleFields.join(', ')}.`));

      const compiled: { name: string; rx: RegExp | null }[] = [];
      for (const a of allow) {
        if (!a.name || !a.regex) {
          findings.push(error('splunk.webhook-allow-incomplete', 'Each allow list row needs a name and a regex.'));
          continue;
        }
        let rx: RegExp | null = null;
        try {
          rx = new RegExp(a.regex);
        } catch {
          findings.push(error('splunk.webhook-allow-regex', `allowlist.${a.name} is not a valid regular expression.`));
        }
        compiled.push({ name: a.name, rx });
        if (/^\^?\.[*+]\$?$/.test(a.regex) || /^\^?https?:\/\/\.[*+]/.test(a.regex)) findings.push(warning('splunk.webhook-allow-any', `allowlist.${a.name} matches any host, which is the same as having no allow list.`));
        else if (/^\^?https?:\/\/[^\\]*\.[a-z]/i.test(a.regex) && !/\\\./.test(a.regex)) findings.push(warning('splunk.webhook-allow-dot', `allowlist.${a.name} has an unescaped "." in the host name, which matches any character: hooks.example.com also allows hooksXexample.com.`));
      }
      if (allow.length === 0) findings.push(warning('splunk.webhook-no-allowlist', 'No allow list entry was given. Where the webhook allow list is enforced, a URL that matches no entry is not called, and the alert fires with nothing sent.'));
      else if (url && compiled.every((c) => c.rx) && !compiled.some((c) => c.rx?.test(url))) {
        findings.push(error('splunk.webhook-not-allowed', `${url} matches none of the allow list entries, so the webhook would be blocked.`, { remediation: 'Add an entry that matches it, anchored and with the dots in the host escaped.' }));
      }

      return {
        tier: TIER,
        title: `Webhook alert: ${title}`,
        app,
        activation: 'reload',
        notes: [
          'Splunk POSTs a JSON body to the URL: the search name, the sid, the app, the owner, a results link and the first result row as "result". It does not send the whole result set, and it does not retry.',
          'The allow list is read from alert_actions.conf [webhook] allowlist.<name> across every app, like the rest of that file. Editing it through Settings needs the edit_webhook_allow_list capability.',
          'VERIFY: whether your version also needs [webhook] enable_allowlist set for the list to be enforced — check $SPLUNK_HOME/etc/system/README/alert_actions.conf.spec on the search head.',
          throttleFields.length
            ? `One webhook call per ${throttleFields.join(' + ')} per ${throttle}: the alert fires once per result row and is throttled per value.`
            : `One webhook call per run, throttled as a whole for ${throttle}.`,
          'The alert is created enabled and scheduled. Shared with export = system in metadata/default.meta so it is owned by nobody and survives its author leaving.',
        ],
        before: [
          '| rest splunk_server=local /services/configs/conf-alert_actions/webhook | table allowlist.*   # the allow list already in force',
          ...(url ? [`curl -sS -o /dev/null -w "%{http_code}\\n" -X POST -H "Content-Type: application/json" -d '{"test":true}' ${shq(url)}   # from the search head: reachable, and what it answers`] : []),
          `${pipeline.join(' ')} earliest=${window.earliest} latest=${window.latest}   # what one run returns`,
        ],
        files: {
          'default/alert_actions.conf': [
            '# Webhook allow list. A URL the webhook action is asked to call must match one',
            '# of these regexes. Anchor them and escape the dots in the host name.',
            '[webhook]',
            ...allow.filter((a) => a.name && a.regex).map((a) => `allowlist.${a.name} = ${a.regex}`),
          ],
          'default/savedsearches.conf': [
            `[${title}]`,
            ...foldSearch(pipeline),
            `description = Calls the webhook at ${url.replace(/\?.*$/, '')} when the search returns more than ${threshold} result${threshold === 1 ? '' : 's'}.`,
            'enableSched = 1',
            `cron_schedule = ${spreadCron(title, every)}`,
            `dispatch.earliest_time = ${window.earliest}`,
            `dispatch.latest_time = ${window.latest}`,
            'schedule_window = auto',
            'counttype = number of events',
            'relation = greater than',
            `quantity = ${threshold}`,
            'alert.track = 1',
            ...(throttleFields.length
              ? ['alert.digest_mode = 0', 'alert.suppress = 1', `alert.suppress.period = ${throttle}`, `alert.suppress.fields = ${throttleFields.join(', ')}`]
              : ['alert.digest_mode = 1', 'alert.suppress = 1', `alert.suppress.period = ${throttle}`]),
            'action.webhook = 1',
            `action.webhook.param.url = ${url}`,
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest splunk_server=local /servicesNS/-/${app}/saved/searches/${encodeURIComponent(title)} | table title, disabled, cron_schedule, action.webhook, action.webhook.param.url, next_scheduled_time`,
          `index=_internal sourcetype=scheduler savedsearch_name=${q(title)} | table _time, status, result_count, alert_actions`,
          'index=_internal sourcetype=splunkd component=sendmodalert action=webhook | table _time, log_level, _raw   # the call, and any refusal by the allow list',
        ],
        backout: [
          `curl -X POST -H @<header-file> https://<search-head>:8089/servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(title)} -d disabled=1   # stop it first`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then /debug/refresh; the allow list entries go with the app`,
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_custom_alert_action',
    tier: TIER,
    label: 'Custom alert action app',
    group: 'Alerting and reports',
    description:
      'A packaged alert action — alert_actions.conf with is_custom and a JSON payload, the .spec, the form Splunk shows in the alert editor, and a Python 3 script that POSTs to your endpoint over verified TLS with its token from Splunk’s credential store — plus a test script that runs it the way Splunk does.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'acme_ticket_alert' },
      { id: 'action_name', label: 'Action name', control: 'text', default: 'acme_ticket', hint: 'The name in savedsearches.conf: action.<name> = 1' },
      { id: 'label', label: 'Label in the alert editor', control: 'text', default: 'Open an Acme ticket' },
      { id: 'description', label: 'Description', control: 'text', default: 'Opens an incident in the Acme ticketing API for each alert.' },
      { id: 'endpoint', label: 'Default endpoint', control: 'text', default: 'https://tickets.example.com/api/v1/incidents', hint: 'https:// — an alert can override it' },
      { id: 'token_realm', label: 'Credential realm', control: 'text', default: 'acme_ticket', hint: 'The storage/passwords realm the API token is kept under; empty for no token' },
      {
        id: 'params',
        label: 'More parameters',
        control: 'textarea',
        default: ['severity | Severity | 3', 'assignment_group | Assignment group | Platform Operations'].join('\n'),
        hint: 'name | label | default',
      },
      { id: 'max_rows', label: 'Result rows to send', control: 'number', default: 50, min: 0, max: 10000, hint: '0 sends the first result row only' },
      { id: 'timeout', label: 'Request timeout (seconds)', control: 'number', default: 30, min: 5, max: 300 },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'custom_alert'), 'custom_alert');
      const action = splunkName(str(values, 'action_name', ''), '');
      const label = str(values, 'label', action);
      const description = str(values, 'description', label);
      const endpoint = str(values, 'endpoint', '');
      const realm = str(values, 'token_realm', '').trim();
      const maxRows = Math.max(0, Math.round(num(values, 'max_rows', 50)));
      const timeout = Math.max(5, Math.round(num(values, 'timeout', 30)));
      const findings: Finding[] = [];

      const params = linesOf(str(values, 'params', '')).map((line) => {
        const [name = '', plabel = '', dflt = ''] = cells(line);
        return { given: name, name: splunkName(name, ''), label: plabel || name, dflt };
      });

      if (!action) findings.push(error('splunk.alert-action-no-name', 'The alert action has no name.'));
      if (BUILT_IN_ACTIONS.has(action)) findings.push(error('splunk.alert-action-built-in', `"${action}" is the name of an alert action Splunk already has; a custom action of the same name collides with it.`));
      if (/^[0-9]/.test(action)) findings.push(error('splunk.alert-action-name', `"${action}" starts with a digit; the action name is used as a conf stanza, a script name and a Python module name.`));
      if (!endpoint) findings.push(error('splunk.alert-action-no-endpoint', 'No default endpoint was given, so every alert would have to supply one.'));
      else if (!/^https:\/\/[^\s/]+/i.test(endpoint)) findings.push(error('splunk.alert-action-endpoint', `"${endpoint}" is not an https:// URL. The script refuses anything else, so the payload never travels unencrypted.`));
      if (realm && !/^[A-Za-z0-9_.-]+$/.test(realm)) findings.push(error('splunk.alert-action-realm', `"${realm}" is not a usable credential realm: letters, digits, ., _ and - only.`));
      for (const p of params) {
        if (!p.name) findings.push(error('splunk.alert-action-param-name', 'A parameter row has no name.'));
        else if (p.name !== p.given) findings.push(warning('splunk.alert-action-param-renamed', `Parameter "${p.given}" is written as ${p.name}: param.${p.name} is what an alert sets.`));
        if (['endpoint', 'token_realm'].includes(p.name)) findings.push(error('splunk.alert-action-param-reserved', `param.${p.name} is already defined by this action.`));
      }
      const pnames = params.map((p) => p.name).filter(Boolean);
      const dup = pnames.filter((n, i) => pnames.indexOf(n) !== i);
      if (dup.length) findings.push(error('splunk.alert-action-param-duplicate', `param.${dup[0]} is declared twice.`));

      const good = params.filter((p) => p.name && !['endpoint', 'token_realm'].includes(p.name));
      const name = action || 'custom_action';
      const allParams = [
        { name: 'endpoint', label: 'Endpoint URL', dflt: endpoint, help: 'The https:// URL the alert is POSTed to.' },
        { name: 'token_realm', label: 'Credential realm', dflt: realm, help: 'The storage/passwords realm of the API token, sent as a Bearer token. Empty sends no token.' },
        ...good.map((p) => ({ name: p.name, label: p.label, dflt: p.dflt, help: `Sent in the request body as params.${p.name}.` })),
      ];
      const html = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

      const py = script`#!/usr/bin/env python3
"""${label}: a Splunk custom alert action.

Splunk runs this script with the alert's payload as JSON on stdin (payload_format
= json in alert_actions.conf). The payload carries "configuration" (the param.*
values, after the alert's own overrides), the search name, the sid, the app, the
owner, a results link, the first result row as "result", and "results_file", the
path to the full results as gzipped CSV.

It sends one HTTPS POST per alert to the configured endpoint, verifying the
certificate and the host name, with TLS 1.2 or later. The API token comes from
Splunk's credential store (storage/passwords, realm = token_realm), read with the
alert's own session key; it is never in a conf file. The script exits non-zero on
any failure, which Splunk logs as index=_internal sourcetype=splunkd
component=sendmodalert action=${name}.

ALERT_ACTION_DRY_RUN=1 in the environment prints the request instead of sending
it; ops/test_alert_action.sh --dry-run sets it.
"""
import csv
import gzip
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

APP = "${app}"
MAX_ROWS = ${maxRows}
TIMEOUT = ${timeout}
RESERVED = ("endpoint", "token_realm")


def log(level, message):
    # Lines on stderr land in splunkd.log under component=sendmodalert.
    sys.stderr.write(level + " " + message + "\n")
    sys.stderr.flush()


def read_results(path, limit):
    """The first rows of the full result set, without Splunk's __mv_ columns."""
    rows = []
    if not path or not os.path.exists(path):
        return rows
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for number, row in enumerate(csv.DictReader(handle)):
            if number >= limit:
                break
            rows.append({k: v for k, v in row.items() if k and not k.startswith("__mv_")})
    return rows


def stored_secret(session_key, realm):
    """The API token for this realm, from storage/passwords in this app."""
    try:
        import splunk.rest as rest  # Splunk's own library, present under splunk cmd python3
    except ImportError:
        raise RuntimeError("token_realm is set but splunk.rest is not available; run under Splunk's Python")
    if not session_key:
        raise RuntimeError("token_realm is set but the payload has no session key")
    _, body = rest.simpleRequest(
        "/servicesNS/nobody/" + APP + "/storage/passwords",
        sessionKey=session_key,
        getargs={"output_mode": "json", "count": "0"},
        raiseAllErrors=True,
    )
    for entry in json.loads(body).get("entry", []):
        content = entry.get("content", {})
        if content.get("realm") == realm:
            return content.get("clear_password", "")
    raise RuntimeError("no credential with realm " + realm + " in storage/passwords of " + APP)


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    config = payload.get("configuration", {})
    endpoint = str(config.get("endpoint", "")).strip()
    realm = str(config.get("token_realm", "")).strip()
    if not endpoint.startswith("https://"):
        log("ERROR", "endpoint must be an https:// URL, got " + repr(endpoint))
        return 2

    body = {
        "search_name": payload.get("search_name"),
        "sid": payload.get("sid"),
        "app": payload.get("app"),
        "owner": payload.get("owner"),
        "results_link": payload.get("results_link"),
        "server_host": payload.get("server_host"),
        "result": payload.get("result", {}),
        "params": {k: v for k, v in config.items() if k not in RESERVED},
    }
    if MAX_ROWS > 0:
        body["results"] = read_results(payload.get("results_file"), MAX_ROWS)
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "splunk-alert-${name}"}

    if os.environ.get("ALERT_ACTION_DRY_RUN") == "1":
        print("DRY RUN: POST " + endpoint)
        print("  Authorization: " + ("Bearer <storage/passwords realm " + realm + ", not read in a dry run>" if realm else "none"))
        print("  body: " + json.dumps(body, indent=2)[:4000])
        print("Dry run: nothing was sent. Run it without --dry-run to send.")
        return 0

    try:
        if realm:
            headers["Authorization"] = "Bearer " + stored_secret(payload.get("session_key", ""), realm)
    except Exception as exc:  # noqa: BLE001 - any failure here means no request
        log("ERROR", "could not read the API token: " + str(exc))
        return 2

    # The default context verifies the certificate chain and the host name.
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    request = urllib.request.Request(endpoint, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=context) as response:
            log("INFO", "POST " + endpoint + " answered HTTP " + str(response.status))
            return 0
    except urllib.error.HTTPError as exc:
        log("ERROR", "POST " + endpoint + " answered HTTP " + str(exc.code) + ": " + exc.read(500).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError) as exc:
        log("ERROR", "POST " + endpoint + " failed: " + str(exc))
    return 3


if __name__ == "__main__":
    sys.exit(main())
`;

      const testPayload = JSON.stringify(
        {
          search_name: `Test of ${name}`,
          sid: 'test',
          app,
          owner: 'nobody',
          results_link: '',
          server_host: 'test',
          session_key: '',
          result: { host: 'test-host', message: 'Test alert from ops/test_alert_action.sh' },
          configuration: Object.fromEntries(allParams.map((p) => [p.name, p.dflt])),
        },
        null,
        2,
      );

      const test = script`#!/usr/bin/env bash
# Runs bin/${name}.py the way Splunk does — the payload as JSON on stdin, under
# Splunk's own Python — and stores the endpoint's API token.
#
# Usage (applies when run; --dry-run shows what it would do and changes nothing):
#   bash ops/test_alert_action.sh [--dry-run]              send one test alert to the endpoint
#   bash ops/test_alert_action.sh set-token [--dry-run]    store the API token in storage/passwords
#
# A live test with a credential realm reads the token with a session key: export
# SPLUNK_SESSION_KEY first (from POST /services/auth/login, for a user whose role
# has list_storage_passwords). set-token uses a Splunk authentication token in
# ~/.splunk/token (mode 600); the API token is typed, never on a command line.
set -euo pipefail
EXECUTE=1; CMD=test
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) EXECUTE=0; shift ;;
    test|set-token) CMD=$1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
SPLUNK_HOME="\${SPLUNK_HOME:-/opt/splunk}"
SPLUNK_URL="\${SPLUNK_URL:-https://localhost:8089}"
TOKEN_FILE="\${TOKEN_FILE:-$HOME/.splunk/token}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REALM=${shq(realm)}
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ "$CMD" = test ]; then
  cat > "$WORK/payload.json" <<'JSON'
${testPayload}
JSON
  # The session key goes in from the environment, not from a command line.
  "$SPLUNK_HOME/bin/splunk" cmd python3 -c 'import json, os, sys; p = json.load(open(sys.argv[1])); p["session_key"] = os.environ.get("SPLUNK_SESSION_KEY", ""); json.dump(p, open(sys.argv[1], "w"))' "$WORK/payload.json"
  if (( EXECUTE )); then
    "$SPLUNK_HOME/bin/splunk" cmd python3 "$APP_DIR/bin/${name}.py" < "$WORK/payload.json"
  else
    ALERT_ACTION_DRY_RUN=1 "$SPLUNK_HOME/bin/splunk" cmd python3 "$APP_DIR/bin/${name}.py" < "$WORK/payload.json"
  fi
  exit $?
fi

# set-token
[ -n "$REALM" ] || { echo "This action has no credential realm; there is no token to store." >&2; exit 2; }
URL="$SPLUNK_URL/servicesNS/nobody/${app}/storage/passwords"
if (( ! EXECUTE )); then
  echo "DRY RUN: POST $URL  name=api realm=$REALM password=<typed>"
  echo "  (or POST $URL/$REALM:api: with the new password when it already exists)"
  echo "Dry run: nothing was changed. Run it without --dry-run to apply."
  exit 0
fi
[ -f "$TOKEN_FILE" ] || { echo "No token file: $TOKEN_FILE" >&2; exit 1; }
IFS= read -r t < "$TOKEN_FILE" || true
printf "Authorization: Bearer %s\n" "\${t%$'\r'}" > "$WORK/auth.h"; t=""
IFS= read -rs -p "API token for realm $REALM: " s; echo
printf "%s" "$s" > "$WORK/secret"; s=""
CURL=(curl -sS -H @"$WORK/auth.h")
[ -n "\${SPLUNK_CA:-}" ] && CURL+=(--cacert "$SPLUNK_CA")
code="$("\${CURL[@]}" -o "$WORK/out" -w "%{http_code}" -X POST "$URL" --data-urlencode name=api --data-urlencode "realm=$REALM" --data-urlencode "password@$WORK/secret")"
if [ "$code" = 409 ]; then
  code="$("\${CURL[@]}" -o "$WORK/out" -w "%{http_code}" -X POST "$URL/$REALM:api:" --data-urlencode "password@$WORK/secret")"
fi
[[ "$code" =~ ^20 ]] || { echo "storage/passwords answered HTTP $code" >&2; cat "$WORK/out" >&2; exit 1; }
echo "stored: realm $REALM, user api, in ${app}"
`;

      return {
        tier: TIER,
        title: `Custom alert action ${name}: ${label}`,
        app,
        activation: 'restart',
        notes: [
          `Alerts use it with action.${name} = 1 in savedsearches.conf, or by ticking "${label}" under Trigger actions. Every param.* in default/alert_actions.conf is a default an alert can override with action.${name}.param.<name>.`,
          'python.required = 3.9, 3.13 lets Splunk 10.2 and later run it under either interpreter; it uses the standard library and Splunk’s own splunk.rest only, so there is nothing to vendor and nothing compiled.',
          realm
            ? `The API token lives in storage/passwords of ${app} with realm ${realm} and user api: bash ops/test_alert_action.sh set-token. The alert runs as its owner, whose role needs list_storage_passwords to read it.`
            : 'No credential realm: the endpoint is called without an Authorization header.',
          `The request body is JSON: search_name, sid, app, owner, results_link, server_host, result (the first row), params (every other param.*)${maxRows > 0 ? `, and results — up to ${maxRows} rows of the full result set` : ''}.`,
          'bash ops/test_alert_action.sh sends one test alert when run; --dry-run prints the request and sends nothing. From a search, | sendalert runs it with real results.',
          'A new alert action is read when splunkd starts, so the first deployment needs a restart of the search head (or a rolling restart through the deployer). Later changes to the script do not.',
          'Splunk Cloud: package it as a private app (splunk-appinspect, then ACS app install). App vetting rejects scripts outside bin/, so leave ops/ out of the package you upload.',
        ],
        before: [
          `| rest splunk_server=local /services/alerts/alert_actions | search title=${q(name)} | table title, eai:acl.app   # no action of this name already`,
          ...(endpoint ? [`curl -sS -o /dev/null -w "%{http_code}\\n" ${shq(endpoint)}   # from the search head: DNS, the proxy and the certificate`] : []),
          'bash ops/test_alert_action.sh --dry-run',
        ],
        files: {
          'default/alert_actions.conf': [
            `[${name}]`,
            'is_custom = 1',
            `label = ${label}`,
            `description = ${description}`,
            '# The payload arrives on stdin as JSON.',
            'payload_format = json',
            'python.required = 3.9, 3.13',
            '# Deprecated, and python.required wins on 10.x; Splunk AppInspect, which',
            '# vets a Splunk Cloud private app, still requires it on a Python alert action.',
            'python.version = python3',
            '# Long enough for the request timeout and the token read, short enough that',
            '# a hung endpoint does not hold a scheduler slot.',
            `maxtime = ${Math.max(60, timeout * 2)}s`,
            ...allParams.map((p) => `param.${p.name} = ${p.dflt}`),
          ],
          'README/alert_actions.conf.spec': [
            `[${name}]`,
            ...allParams.flatMap((p) => [`param.${p.name} = <string>`, `* ${p.label}. ${p.help}`, `* Default: ${p.dflt || 'empty'}`, '']),
          ],
          [`default/data/ui/alerts/${name}.html`]: [
            '<form class="form-horizontal form-complex">',
            ...allParams.flatMap((p) => [
              '  <div class="control-group">',
              `    <label class="control-label" for="${name}_${p.name}">${html(p.label)}</label>`,
              '    <div class="controls">',
              `      <input type="text" class="input-xlarge" name="action.${name}.param.${p.name}" id="${name}_${p.name}" placeholder="${html(p.dflt)}"/>`,
              `      <span class="help-block">${html(p.help)}</span>`,
              '    </div>',
              '  </div>',
            ]),
            '</form>',
          ],
          [`bin/${name}.py`]: py,
          'ops/test_alert_action.sh': test,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest splunk_server=local /services/alerts/alert_actions/${name} | table title, label, is_custom, payload_format, python.required, eai:acl.app`,
          `| makeresults | eval host="test-host", message="verify ${name}" | sendalert ${name}`,
          `index=_internal sourcetype=splunkd component=sendmodalert action=${q(name)} earliest=-15m | table _time, log_level, _raw`,
        ],
        backout: [
          `| rest splunk_server=local /servicesNS/-/-/saved/searches | search action.${name}=1 | table title, eai:acl.app   # alerts that use it: remove the action from them first`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then restart; the stored token goes with the app's storage/passwords`,
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_report_email',
    tier: TIER,
    label: 'Scheduled report by email',
    group: 'Alerting and reports',
    description:
      'A report that runs on a schedule and emails its results — inline as a table, as a CSV attachment, as a PDF, or any of those — through the search head’s own mail settings.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_reports_email' },
      { id: 'title', label: 'Report name', control: 'text', default: 'Acme daily order errors' },
      { id: 'search', label: 'Search', control: 'textarea', default: 'index=app_prod sourcetype=app:events log_level=ERROR\n| stats count by service, message\n| sort - count\n| head 50' },
      { id: 'timerange', label: 'Time range', control: 'text', default: '-24h@h' },
      { id: 'cron', label: 'Schedule', control: 'combo', default: '0 7 * * 1-5', options: CRON_PRESETS, hint: 'cron: minute hour day-of-month month day-of-week, in the search head’s time zone' },
      { id: 'recipients', label: 'To', control: 'text', default: 'ops-team@example.com, service-owner@example.com', hint: 'comma-separated' },
      { id: 'cc', label: 'Cc', control: 'text', default: '', hint: 'comma-separated' },
      { id: 'subject', label: 'Subject', control: 'text', default: 'Splunk report: $name$' },
      { id: 'message', label: 'Message', control: 'textarea', default: 'The scheduled report $name$ has run. Results are below and attached.' },
      { id: 'delivery', label: 'Deliver as', control: 'checklist', default: 'inline, csv', options: [
        { value: 'inline', label: 'Inline table in the email' },
        { value: 'csv', label: 'CSV attachment' },
        { value: 'pdf', label: 'PDF attachment' },
      ] },
      { id: 'inline_format', label: 'Inline as', control: 'select', default: 'table', options: [
        { value: 'table', label: 'Table' },
        { value: 'raw', label: 'Raw events' },
        { value: 'csv', label: 'CSV text' },
      ] },
      { id: 'paper_size', label: 'PDF paper size', control: 'select', default: 'a4', hint: 'PDF only', options: ['a4', 'letter', 'legal', 'ledger', 'a3', 'a5'].map((value) => ({ value, label: value })) },
      { id: 'paper_orientation', label: 'PDF orientation', control: 'select', default: 'landscape', hint: 'PDF only', options: [
        { value: 'landscape', label: 'Landscape' },
        { value: 'portrait', label: 'Portrait' },
      ] },
      { id: 'max_results', label: 'At most this many result rows', control: 'number', default: 10000, min: 1, max: 50000 },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_reports_email'), 'org_reports_email');
      const title = searchTitle(str(values, 'title', ''), 'Scheduled report');
      const pipeline = linesOf(str(values, 'search', ''));
      const earliest = str(values, 'timerange', '-24h@h');
      const cron = str(values, 'cron', '0 7 * * 1-5');
      const to = listOf(str(values, 'recipients', ''));
      const cc = listOf(str(values, 'cc', ''));
      const subject = str(values, 'subject', 'Splunk report: $name$');
      const message = linesOf(str(values, 'message', '')).join(' ');
      const delivery = new Set(listOf(str(values, 'delivery', 'inline')));
      const inlineFormat = str(values, 'inline_format', 'table');
      const paperSize = str(values, 'paper_size', 'a4');
      const orientation = str(values, 'paper_orientation', 'landscape');
      const maxResults = Math.max(1, Math.round(num(values, 'max_results', 10000)));
      const findings: Finding[] = [];

      if (pipeline.length === 0) findings.push(error('splunk.report-no-search', 'The report has no search.'));
      if (to.length === 0) findings.push(error('splunk.report-no-recipients', 'The report has no recipients, so it would run and send nothing.'));
      const badAddresses = [...to, ...cc].filter((a) => !EMAIL.test(a));
      if (badAddresses.length) findings.push(error('splunk.report-bad-address', `Not an email address: ${badAddresses.join(', ')}.`));
      const cronIssue = cronProblem(cron);
      if (cronIssue) findings.push(error('splunk.report-cron', cronIssue));
      else if (cron.trim().split(/\s+/)[0] === '*' || /^\*\/[1-9]\s/.test(cron.trim())) findings.push(warning('splunk.report-cron-frequent', `"${cron}" sends the report every few minutes — an inbox full of identical emails, not a report.`));
      if (delivery.size === 0) findings.push(error('splunk.report-no-delivery', 'Nothing is delivered: choose inline, CSV, PDF or a combination.'));
      if (delivery.has('pdf') && pipeline.length > 0 && !/\|\s*(stats|chart|timechart|table|top|rare|tstats|head)\b/i.test(pipeline.join(' '))) {
        findings.push(warning('splunk.report-pdf-raw', 'The PDF of a search with no transforming command or table is pages of raw events. Add | stats, | table or | head before sending it as a PDF.'));
      }

      return {
        tier: TIER,
        title: `Scheduled report by email: ${title}`,
        app,
        activation: 'reload',
        notes: [
          `Runs ${cron} (the search head’s time zone) over ${earliest} to now, and emails ${to.join(', ') || 'nobody'}${cc.length ? `, cc ${cc.join(', ')}` : ''}: ${[...delivery].map((d) => (d === 'inline' ? `inline as ${inlineFormat}` : d === 'csv' ? 'a CSV attachment' : `a PDF (${paperSize}, ${orientation})`)).join(', ') || 'nothing'}.`,
          'Mail goes through the search head’s own settings in alert_actions.conf [email] (Settings > Server settings > Email settings): the mail server, TLS and the sender. If allowedDomainList is set there, every recipient’s domain must be in it or the email is not sent.',
          `At most ${maxResults} rows are included. The inline table and the CSV carry the rows; the PDF is rendered by the search head from the report’s results.`,
          'This covers reports. A Dashboard Studio dashboard is delivered by its own "Schedule export" in the dashboard’s UI, which is not a conf setting this app can carry; classic dashboard PDF delivery is deprecated since 9.4 and Simple XML dashboards do not load in 10.4.',
          'The report is created enabled and scheduled, owned by nobody (export = system in metadata/default.meta), so it keeps running after its author leaves.',
        ],
        before: [
          '| rest splunk_server=local /services/configs/conf-alert_actions/email | table mailserver, use_tls, use_ssl, from, allowedDomainList',
          `${pipeline.join(' ')} earliest=${earliest} latest=now | stats count   # rows one run sends`,
        ],
        files: {
          'default/savedsearches.conf': [
            `[${title}]`,
            ...foldSearch(pipeline),
            `description = Emailed to ${to.join(', ')} on the schedule ${cron}.`,
            'enableSched = 1',
            `cron_schedule = ${cron}`,
            `dispatch.earliest_time = ${earliest}`,
            'dispatch.latest_time = now',
            'schedule_window = auto',
            '# A report, not an alert: it sends every run, whether or not there are results.',
            'counttype = always',
            'alert.track = 0',
            'action.email = 1',
            `action.email.to = ${to.join(', ')}`,
            ...(cc.length ? [`action.email.cc = ${cc.join(', ')}`] : []),
            `action.email.subject = ${subject}`,
            ...(message ? [`action.email.message.report = ${message}`] : []),
            'action.email.content_type = html',
            'action.email.sendresults = 1',
            `action.email.maxresults = ${maxResults}`,
            `action.email.inline = ${delivery.has('inline') ? 1 : 0}`,
            ...(delivery.has('inline') ? [`action.email.format = ${inlineFormat}`] : []),
            `action.email.sendcsv = ${delivery.has('csv') ? 1 : 0}`,
            `action.email.sendpdf = ${delivery.has('pdf') ? 1 : 0}`,
            ...(delivery.has('pdf') ? [`action.email.reportPaperSize = ${paperSize}`, `action.email.reportPaperOrientation = ${orientation}`] : []),
            'action.email.include.results_link = 1',
            'action.email.include.view_link = 0',
            'action.email.include.search = 0',
            'action.email.include.trigger_time = 1',
          ],
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest splunk_server=local /servicesNS/-/${app}/saved/searches/${encodeURIComponent(title)} | table title, disabled, cron_schedule, next_scheduled_time, action.email.to, action.email.sendpdf, action.email.sendcsv`,
          `index=_internal sourcetype=scheduler savedsearch_name=${q(title)} | table _time, status, result_count, alert_actions`,
          'index=_internal sourcetype=splunk_python sendemail earliest=-24h | table _time, _raw   # the send, or why it failed',
        ],
        backout: [
          `curl -X POST -H @<header-file> https://<search-head>:8089/servicesNS/nobody/${app}/saved/searches/${encodeURIComponent(title)} -d disabled=1   # stop the emails first`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then /debug/refresh, or through the deployer on a cluster`,
        ],
        findings,
      };
    },
  }),

  // --------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_federated_search',
    tier: TIER,
    label: 'Federated Search to another Splunk deployment',
    group: 'Federated search',
    description:
      'Splunk-to-Splunk Federated Search: the provider on this search head (standard or transparent mode), federated indexes for standard mode, the service account role on the remote deployment, and a REST script that creates or updates all of it through data/federated/*.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_federated_acme_dc2' },
      { id: 'provider', label: 'Provider name', control: 'text', default: 'acme_dc2' },
      { id: 'mode', label: 'Mode', control: 'select', default: 'standard', options: [
        { value: 'standard', label: 'standard — search remote data through federated indexes (| from federated:…)' },
        { value: 'transparent', label: 'transparent — ordinary searches include the remote deployment' },
      ] },
      { id: 'host_port', label: 'Remote search head', control: 'text', default: 'sh1.dc2.example.com:8089', hint: 'host:management port' },
      { id: 'service_account', label: 'Service account on the remote', control: 'text', default: 'svc_fsh_acme' },
      { id: 'service_role', label: 'Its role', control: 'text', default: 'fsh_service_acme' },
      { id: 'service_indexes', label: 'Remote indexes it may search', control: 'text', default: 'web, os', hint: 'comma-separated' },
      { id: 'app_context', label: 'Remote app context', control: 'text', default: 'search', showWhen: { input: 'mode', equals: ['standard'] } },
      { id: 'use_fsh_ko', label: 'Use this search head’s knowledge objects', control: 'toggle', default: false, hint: 'Off uses the remote’s', showWhen: { input: 'mode', equals: ['standard'] } },
      {
        id: 'indexes',
        label: 'Federated indexes',
        control: 'textarea',
        default: ['fed_dc2_web | web', 'fed_dc2_os | os'].join('\n'),
        hint: 'federated index | remote index',
        showWhen: { input: 'mode', equals: ['standard'] },
      },
    ],
    app: (values: BlueprintValues): SplunkApp => {
      const app = splunkName(str(values, 'app_name', 'org_federated'), 'org_federated');
      const provider = splunkName(str(values, 'provider', ''), '');
      const mode = str(values, 'mode', 'standard');
      const hostPort = str(values, 'host_port', '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      const account = str(values, 'service_account', '').trim();
      const role = splunkName(str(values, 'service_role', ''), '');
      const serviceIndexes = listOf(str(values, 'service_indexes', ''));
      const appContext = splunkName(str(values, 'app_context', 'search'), 'search');
      const useFshKo = bool(values, 'use_fsh_ko', false);
      const standard = mode === 'standard';
      const findings: Finding[] = [];

      const indexRows = linesOf(str(values, 'indexes', '')).map((line) => {
        const [fed = '', remote = ''] = cells(line);
        return { given: fed, name: fed.toLowerCase(), remote: remote.trim() };
      });

      if (!provider) findings.push(error('splunk.fed-no-provider', 'The provider has no name.'));
      const hp = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(hostPort);
      if (!hp) findings.push(error('splunk.fed-host-port', `"${hostPort}" is not host:port. Federated search connects to the remote search head’s management port, usually 8089.`));
      else if (['9997', '9998', '8088', '8000', '443'].includes(hp[2] ?? '')) findings.push(error('splunk.fed-wrong-port', `Port ${hp[2]} is not the management port. The provider connects to splunkd’s REST port on the remote search head (8089 unless it was changed).`));
      if (!account) findings.push(error('splunk.fed-no-account', 'No service account was given; the provider logs in to the remote deployment as that user.'));
      if (!role) findings.push(error('splunk.fed-no-role', 'No role was given for the service account.'));
      if (serviceIndexes.length === 0) findings.push(error('splunk.fed-no-indexes-allowed', 'The service account may search no indexes, so every federated search returns nothing.'));
      if (serviceIndexes.some((i) => i === '*' || i === '_*')) findings.push(warning('splunk.fed-all-indexes', 'The service account may search every index on the remote deployment, including its internal ones. Name the indexes it serves.'));

      if (standard) {
        if (indexRows.length === 0) findings.push(error('splunk.fed-no-federated-indexes', 'Standard mode searches remote data only through federated indexes, and none were given.'));
        for (const r of indexRows) {
          if (!/^[a-z0-9][a-z0-9_-]*$/.test(r.name)) findings.push(error('splunk.fed-index-name', `"${r.given}" is not a name Splunk accepts for an index: lower case letters, digits, _ and -.`));
          if (!r.remote) findings.push(error('splunk.fed-no-remote-index', `Federated index ${r.name} names no remote index.`));
          else if (/[*,\s]/.test(r.remote)) findings.push(error('splunk.fed-remote-index-list', `Federated index ${r.name} maps to "${r.remote}"; a federated index maps to exactly one remote index.`));
          else if (!serviceIndexes.includes(r.remote) && !serviceIndexes.includes('*')) {
            findings.push(warning('splunk.fed-remote-not-allowed', `Federated index ${r.name} reads remote index ${r.remote}, which the service account’s role may not search, so it returns nothing.`, { remediation: `Add ${r.remote} to the remote indexes it may search.` }));
          }
        }
        const names = indexRows.map((r) => r.name);
        const dup = names.filter((n, i) => names.indexOf(n) !== i);
        if (dup.length) findings.push(error('splunk.fed-index-duplicate', `Federated index ${dup[0]} is defined twice.`));
      }

      const good = standard ? indexRows.filter((r) => r.name && r.remote && !/[*,\s]/.test(r.remote)) : [];

      const rest = script`#!/usr/bin/env bash
# Federated Search, Splunk-to-Splunk, through the REST API.
#
# Usage (applies when run; --dry-run prints each request and changes nothing):
#   bash ops/federated-rest.sh apply [--dry-run]                    on this search head: provider ${provider}${standard ? ' and its federated indexes' : ''}
#   bash ops/federated-rest.sh service-account --remote https://${hostPort} [--dry-run]
#                                                                   on the remote deployment: role ${role} and user ${account}
#   bash ops/federated-rest.sh status
#
# Each object is read first (GET) and then created or updated, so running it again
# changes only what differs; a dry run makes those reads too, so it needs the
# token as well. Authentication is a Splunk token in a file you alone
# can read (mode 600): ~/.splunk/token here, --token-file for the remote. The
# service account's password is typed when asked, written to a private temporary
# file and sent from there; it is never on a command line or echoed.
set -euo pipefail
EXECUTE=1; CMD="\${1:-help}"; [ $# -gt 0 ] && shift
SPLUNK_URL="\${SPLUNK_URL:-https://localhost:8089}"
TOKEN_FILE="\${TOKEN_FILE:-$HOME/.splunk/token}"
REMOTE=""
while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) EXECUTE=0; shift ;;
    --remote) REMOTE=$2; shift 2 ;;
    --token-file) TOKEN_FILE=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
PROVIDER=${shq(provider)}
HOST_PORT=${shq(hostPort)}
ACCOUNT=${shq(account)}
ROLE=${shq(role)}
MODE=${shq(mode)}
REMOTE_INDEXES=(${serviceIndexes.map(shq).join(' ')})
FED_INDEXES=(${good.map((r) => shq(`${r.name}=${r.remote}`)).join(' ')})
umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Verify the certificate. Point SPLUNK_CA at your CA bundle if it is not in the system store.
CURL=(curl -sS)
[ -n "\${SPLUNK_CA:-}" ] && CURL+=(--cacert "$SPLUNK_CA")

auth() {
  [ -f "$TOKEN_FILE" ] || { echo "No token file: $TOKEN_FILE" >&2; exit 1; }
  local perm t=""
  perm="$(stat -c %a "$TOKEN_FILE" 2>/dev/null || stat -f %Lp "$TOKEN_FILE")"
  [[ "$perm" == "600" || "$perm" == "400" ]] || { echo "$TOKEN_FILE must be mode 600." >&2; exit 1; }
  IFS= read -r t < "$TOKEN_FILE" || true
  printf "Authorization: Bearer %s\n" "\${t%$'\r'}" > "$WORK/auth.h"
  t=""
}

# exists BASE PATH: 0 when the object is there, 1 when it is not, exit on anything else.
exists() {
  local code
  code="$("\${CURL[@]}" -H @"$WORK/auth.h" -o /dev/null -w "%{http_code}" "$1$2?output_mode=json")"
  case $code in 200) return 0 ;; 404) return 1 ;; *) echo "GET $2 answered HTTP $code" >&2; exit 1 ;; esac
}

# send BASE PATH ARGS...: a POST, or in a dry run the POST it would make.
send() {
  local base=$1 path=$2 code; shift 2
  if (( ! EXECUTE )); then
    printf "DRY RUN: POST %s%s" "$base" "$path"; printf " %s" "$@" | sed -E "s/--data-urlencode //g"; echo
    return 0
  fi
  code="$("\${CURL[@]}" -H @"$WORK/auth.h" -o "$WORK/out" -w "%{http_code}" -X POST "$base$path" "$@")"
  [[ "$code" =~ ^20 ]] || { echo "POST $path answered HTTP $code" >&2; cat "$WORK/out" >&2; exit 1; }
  echo "ok: POST $path"
}

ask_password() {
  if (( ! EXECUTE )); then : > "$WORK/pw"; return 0; fi
  local s=""
  IFS= read -rs -p "Password of $ACCOUNT on the remote deployment: " s; echo
  [ -n "$s" ] || { echo "An empty password is not accepted." >&2; exit 1; }
  printf "%s" "$s" > "$WORK/pw"; s=""
}

case $CMD in
  apply)
    auth
    B="$SPLUNK_URL/services"
    SETTINGS=(--data-urlencode "type=splunk" --data-urlencode "hostPort=$HOST_PORT" --data-urlencode "serviceAccount=$ACCOUNT" --data-urlencode "mode=$MODE"${standard ? ` --data-urlencode "appContext=${appContext}" --data-urlencode "useFSHKnowledgeObjects=${useFshKo ? 'true' : 'false'}"` : ''})
    if exists "$B" "/data/federated/provider/$PROVIDER"; then
      echo "provider $PROVIDER exists: updating it (the password is asked for so it is set too)"
      ask_password
      send "$B" "/data/federated/provider/$PROVIDER" "\${SETTINGS[@]}" --data-urlencode "password@$WORK/pw"
    else
      echo "provider $PROVIDER does not exist: creating it"
      ask_password
      send "$B" "/data/federated/provider" --data-urlencode "name=$PROVIDER" "\${SETTINGS[@]}" --data-urlencode "password@$WORK/pw"
    fi
    for pair in "\${FED_INDEXES[@]}"; do
      name="\${pair%%=*}"; remote="\${pair#*=}"
      ARGS=(--data-urlencode "federated.provider=$PROVIDER" --data-urlencode "federated.dataset=index:$remote")
      if exists "$B" "/data/federated/index/$name"; then
        send "$B" "/data/federated/index/$name" "\${ARGS[@]}"
      else
        send "$B" "/data/federated/index" --data-urlencode "name=$name" "\${ARGS[@]}"
      fi
    done
    (( EXECUTE )) || echo "Dry run: nothing was changed. Run it without --dry-run to apply."
    ;;
  service-account)
    [ -n "$REMOTE" ] || { echo "--remote https://<remote-search-head>:8089 is required" >&2; exit 2; }
    auth
    B="$REMOTE/services"
    RARGS=(--data-urlencode "capabilities=search")
    for i in "\${REMOTE_INDEXES[@]}"; do RARGS+=(--data-urlencode "srchIndexesAllowed=$i"); done
    if exists "$B" "/authorization/roles/$ROLE"; then
      send "$B" "/authorization/roles/$ROLE" "\${RARGS[@]}"
    else
      send "$B" "/authorization/roles" --data-urlencode "name=$ROLE" "\${RARGS[@]}"
    fi
    if exists "$B" "/authentication/users/$ACCOUNT"; then
      send "$B" "/authentication/users/$ACCOUNT" --data-urlencode "roles=$ROLE"
      echo "user $ACCOUNT exists: its role is set; its password is unchanged"
    else
      ask_password
      send "$B" "/authentication/users" --data-urlencode "name=$ACCOUNT" --data-urlencode "roles=$ROLE" --data-urlencode "password@$WORK/pw"
    fi
    (( EXECUTE )) || echo "Dry run: nothing was changed. Run it without --dry-run to apply."
    ;;
  status)
    auth
    "\${CURL[@]}" -H @"$WORK/auth.h" "$SPLUNK_URL/services/data/federated/provider/$PROVIDER?output_mode=json" | head -c 4000; echo
    "\${CURL[@]}" -H @"$WORK/auth.h" "$SPLUNK_URL/services/data/federated/index?output_mode=json&count=0" | head -c 4000; echo
    ;;
  *) grep -E "^#   bash|^#  +on the remote" "$0"; exit 2 ;;
esac
`;

      return {
        tier: TIER,
        title: `Federated Search provider ${provider || 'unnamed'} (${mode}) to ${hostPort}`,
        app,
        activation: 'restart',
        notes: [
          standard
            ? `Standard mode: remote data is searched through the federated indexes, e.g. | from federated:${good[0]?.name ?? '<index>'}. Nothing changes for ordinary searches.`
            : 'Transparent mode: ordinary searches on this search head also run on the remote deployment, with this search head’s knowledge objects. No federated indexes are involved, and every user’s searches reach the remote side — size it for that.',
          `The provider logs in as ${account || 'the service account'}, whose role ${role || '(none)'} on the remote deployment may search ${serviceIndexes.join(', ') || 'no indexes'} and nothing else. Whoever runs a federated search gets that account’s view of the remote data, whatever their own roles there.`,
          'The password is not in default/federated.conf. bash ops/federated-rest.sh apply asks for it and sets it through data/federated/provider, and Splunk stores it encrypted in local/. Until then the provider cannot log in.',
          'bash ops/federated-rest.sh service-account --remote https://<remote>:8089 creates the role and the user on the remote deployment (or deploy ops/remote-provider/authorize.conf there in an app, and create the user yourself). Both scripts apply when run; --dry-run previews.',
          'Creating providers and federated indexes through REST needs admin_all_objects and edit_indexes on this search head.',
          'VERIFY: that the REST parameters of data/federated/provider are the federated.conf key names used here (type, hostPort, serviceAccount, password, appContext, useFSHKnowledgeObjects, mode).',
          ...(standard ? ['VERIFY: the federated index definition — [federated:<name>] with federated.provider and federated.dataset = index:<remote index> in indexes.conf, and the same parameters on data/federated/index. Check indexes.conf.spec on your version before deploying.'] : []),
          'VERIFY: whether the service account needs capabilities beyond search on your version (check the Federated Search manual for the remote deployment’s Splunk version).',
          'Splunk Cloud Platform on either side: the connection runs over the remote management port, which a Cloud stack opens through ACS (access/outbound-ports for the stack as the federated search head, the search-api allow list as the remote).',
        ],
        before: [
          ...(hostPort ? [`curl -sS -o /dev/null -w "%{http_code}\\n" https://${hostPort}/services/server/info   # from this search head: reachable, certificate trusted (401 is fine)`] : []),
          `| rest splunk_server=local /services/data/federated/provider | table title, type, hostPort, mode, serviceAccount`,
          ...(standard ? ['| rest splunk_server=local /services/data/federated/index | table title, federated.provider, federated.dataset'] : []),
          'bash ops/federated-rest.sh apply --dry-run',
        ],
        files: {
          'default/federated.conf': [
            '# The remote Splunk deployment. The password is set through REST',
            '# (ops/federated-rest.sh apply) and stored encrypted in local/, never here.',
            `[provider://${provider}]`,
            'type = splunk',
            `hostPort = ${hostPort}`,
            `serviceAccount = ${account}`,
            `mode = ${mode}`,
            ...(standard
              ? [
                  '# The app on the remote deployment searches run in, and whose knowledge',
                  '# objects they use when useFSHKnowledgeObjects is false.',
                  `appContext = ${appContext}`,
                  `useFSHKnowledgeObjects = ${useFshKo ? 'true' : 'false'}`,
                ]
              : []),
          ],
          ...(good.length
            ? {
                'default/indexes.conf': [
                  '# Federated indexes: each one reads one index on the remote deployment.',
                  '# VERIFY: federated.dataset = index:<remote index> against indexes.conf.spec.',
                  ...good.flatMap((r) => [`[federated:${r.name}]`, `federated.provider = ${provider}`, `federated.dataset = index:${r.remote}`, '']),
                ],
              }
            : {}),
          'ops/remote-provider/authorize.conf': [
            '# For the REMOTE deployment, not this search head: the role of the service',
            `# account ${account}. Deploy it in an app there, or run`,
            '# bash ops/federated-rest.sh service-account --remote https://<remote>:8089',
            `[role_${role}]`,
            `srchIndexesAllowed = ${serviceIndexes.join(';')}`,
            'srchIndexesDefault =',
            'search = enabled',
          ],
          'ops/federated-rest.sh': rest,
          'metadata/default.meta': defaultMeta(),
        },
        verify: [
          `| rest splunk_server=local /services/data/federated/provider/${provider} | table title, type, hostPort, mode, serviceAccount`,
          ...(standard
            ? [`| from federated:${good[0]?.name ?? '<index>'} | head 5`, `| rest splunk_server=local /services/data/federated/index | search federated.provider=${provider} | table title, federated.dataset`]
            : [`index=${serviceIndexes[0] ?? '<remote index>'} earliest=-15m | stats count by splunk_server   # remote servers appear alongside local ones`]),
          'index=_internal sourcetype=splunkd component=*Federated* log_level IN (WARN, ERROR) earliest=-1h | stats count by component   # VERIFY component names on your version',
        ],
        backout: [
          ...good.map((r) => `curl -X DELETE -H @<header-file> https://<search-head>:8089/services/data/federated/index/${r.name}`),
          `curl -X DELETE -H @<header-file> https://<search-head>:8089/services/data/federated/provider/${provider}`,
          `rm -rf $SPLUNK_HOME/etc/apps/${app}   # then restart`,
          `# On the remote deployment: remove user ${account} and role ${role} once nothing else uses them.`,
        ],
        findings,
      };
    },
  }),
];

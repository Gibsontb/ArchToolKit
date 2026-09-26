/**
 * VCF Operations setup: custom properties on objects, and global settings.
 *
 * Custom properties are how facts VCF Operations cannot collect — owner, cost
 * centre, service tier from the CMDB — end up on the objects, where custom
 * groups, views and reports can use them. Global settings are the handful of
 * instance-wide numbers (how long data is kept, how long a session lasts) that
 * are set once at install and then never looked at again.
 */

import { num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { scheduledEnv } from '../apply.js';
import { importMd, nothingToImportMd } from '../vcfops-import.js';
import { OBJECT_KINDS, csvRows, kindOf, opsScript, sh } from './vcf-ops-setup-lib.js';

const PLATFORM = 'vcf-operations'         ;
const SRC = 'ArchToolKit';

/** Global settings this offers, with the key each is believed to have. VERIFY: apply.sh checks every key against the export. */
const GLOBAL_SETTINGS                                                                                                                 = [
  { id: 'session_timeout', key: 'SESSION_TIMEOUT', label: 'Session timeout', unit: 'minutes', default: 30, min: 5, max: 1440 },
  { id: 'deleted_objects', key: 'DELETED_OBJECTS_RETENTION', label: 'Keep deleted objects for', unit: 'hours', default: 336, min: 24, max: 8760 },
  { id: 'time_series', key: 'TIME_SERIES_DATA_RETENTION', label: 'Time series data retention', unit: 'months', default: 6, min: 1, max: 120 },
  { id: 'additional_time_series', key: 'ADDITIONAL_TIME_SERIES_RETENTION', label: 'Additional (rolled-up) time series retention', unit: 'months', default: 36, min: 0, max: 120 },
  { id: 'object_history', key: 'OBJECT_HISTORY_RETENTION', label: 'Object history retention', unit: 'days', default: 300, min: 7, max: 3650 },
  { id: 'alerts', key: 'CANCELED_ALERTS_RETENTION', label: 'Keep cancelled alerts for', unit: 'days', default: 30, min: 1, max: 365 },
  { id: 'actions', key: 'ACTION_HISTORY_RETENTION', label: 'Action history retention', unit: 'days', default: 60, min: 1, max: 365 },
];

export const VCF_OPS_SETUP_MORE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_custom_properties',
    platform: PLATFORM,
    label: 'Set custom properties on objects (from a CSV)',
    group: 'Setup',
    description:
      'Writes object,key,value rows — owner, cost centre, service tier, whatever the CMDB knows and VCF Operations does not — onto the objects as properties (POST /resources/{id}/properties), so custom groups, views and reports can use them. Matches objects by name or id, changes at most N per run, records the previous value of everything it changes as an undo file, and can run on a schedule to keep the properties in step with the source.',
    inputs: [
      { id: 'object_kind', label: 'Object kind', control: 'select', options: OBJECT_KINDS, default: 'VMWARE/VirtualMachine' },
      {
        id: 'match_by',
        label: 'Match objects by',
        control: 'select',
        options: [
          { value: 'name', label: 'Name (must be unique for the kind)' },
          { value: 'id', label: 'VCF Operations object id' },
        ],
        default: 'name',
      },
      {
        id: 'rows',
        label: 'Properties',
        control: 'textarea',
        default: 'object,key,value\napp-web-01,Custom|Owner,payments-team\napp-web-01,Custom|Service Tier,gold\napp-db-01,Custom|Owner,payments-team',
        hint: 'CSV: object,key,value. Put keys under a group such as Custom| so they sit together in the property tree',
      },
      { id: 'max_changes', label: 'Never change more than (per run)', control: 'number', default: 50, min: 1, max: 5000 },
      {
        id: 'schedule',
        label: 'Run',
        control: 'select',
        options: [
          { value: 'once', label: 'Once, now' },
          { value: 'daily', label: 'Daily at 05:00, to keep in step with the CSV' },
          { value: 'hourly', label: 'Hourly' },
        ],
        default: 'once',
      },
    ],
    automation: (values                 , name        )             => {
      const kindValue = str(values, 'object_kind', 'VMWARE/VirtualMachine');
      const kind = kindOf(kindValue);
      const kindLabel = OBJECT_KINDS.find((option) => option.value === kindValue)?.label ?? kind.resourceKind;
      const matchBy = str(values, 'match_by', 'name');
      const { header, rows } = csvRows(str(values, 'rows', ''));
      const cap = num(values, 'max_changes', 50);
      const schedule = str(values, 'schedule', 'once');
      const base = slugOf(name || 'custom-properties', 'custom-properties');

      const findings            = [];
      if (header.join(',') !== 'object,key,value') {
        findings.push(error('vcfops.props.header', `The first line must be object,key,value (it is ${header.join(',') || 'empty'}).`, { source: SRC }));
      }
      const bad = rows.filter((row) => row.length !== 3 || !row[0] || !row[1]);
      if (bad.length > 0) {
        findings.push(error('vcfops.props.bad-row', `${bad.length} row(s) do not have exactly object,key,value: ${bad.map((row) => row.join(',')).slice(0, 3).join('; ')}.`, { remediation: 'A value with a comma in it needs another separator; write it without the comma.', source: SRC }));
      }
      const seen = new Set        ();
      for (const row of rows) {
        const key = `${row[0]}\u0000${row[1]}`;
        if (seen.has(key)) findings.push(error('vcfops.props.duplicate', `${row[0]} has ${row[1]} twice; only one value can win.`, { source: SRC }));
        seen.add(key);
      }
      const flat = [...new Set(rows.filter((row) => row[1] && !row[1].includes('|')).map((row) => row[1] ))];
      if (flat.length > 0) {
        findings.push(warning('vcfops.props.flat-key', `${flat.join(', ')} ${flat.length === 1 ? 'has' : 'have'} no group, so ${flat.length === 1 ? 'it lands' : 'they land'} loose at the top of every object’s property tree.`, { remediation: 'Write them as Custom|Owner, Custom|Service Tier and so on.', source: SRC }));
      }
      const systemKeys = rows.filter((row) => /^(summary|config|sys|runtime|cpu|mem|net|disk|guest|badge)\|/i.test(row[1] ?? ''));
      if (systemKeys.length > 0) {
        findings.push(error('vcfops.props.collected-key', `${[...new Set(systemKeys.map((row) => row[1]))].join(', ')} ${systemKeys.length === 1 ? 'is' : 'are'} collected by the adapter; a value written here is overwritten at the next collection, and until then is wrong.`, { remediation: 'Use your own group (Custom|…) for anything you set.', source: SRC }));
      }
      if (rows.length > cap) {
        findings.push(warning('vcfops.props.over-cap', `${rows.length} rows and a cap of ${cap} changes per run: the rest wait for the next run.`, { source: SRC }));
      }

      const cron = schedule === 'hourly' ? '17 * * * *' : '0 5 * * *';
      const apply = opsScript({
        about: [
          `Set custom properties on ${kindLabel} from properties.csv (object,key,value).`,
          `Objects are matched by ${matchBy}; a name that matches none or several stops the run.`,
          `At most ${cap} values are changed in one run; values already right are left alone.`,
          'Every previous value is written to undo-<time>.csv first: run this again with',
          'that file as the argument (./apply.sh undo-<time>.csv) to put them back.',
        ],
        body: [
          `KIND_ADAPTER=${sh(kind.adapterKind)}`,
          `KIND=${sh(kind.resourceKind)}`,
          `MAX_CHANGES=${cap}`,
          'CSV="$HERE/properties.csv"',
          'for arg in "$@"; do [[ "$arg" == *.csv ]] && CSV="$arg"; done',
          '[[ -f "$CSV" ]] || { echo "No $CSV." >&2; exit 2; }',
          'STAMP=$(date +%Y%m%d-%H%M%S)',
          'UNDO="$HERE/undo-${STAMP}.csv"',
          '(( DRY_RUN )) || echo "object,key,value" > "$UNDO"',
          'NOW_MS="$(date +%s)000"',
          'changed=0; same=0',
          '',
          '# Resolve every object before changing anything, so a bad name stops the run clean.',
          'declare -A IDS',
          'while IFS=, read -r object key value; do',
          '  [[ "$object" == object || -z "$object" ]] && continue',
          '  [[ -n "${IDS[$object]:-}" ]] && continue',
          ...(matchBy === 'id' ? ['  IDS[$object]="$object"'] : ['  IDS[$object]=$(resource_id "$object" "$KIND_ADAPTER" "$KIND")']),
          'done < "$CSV"',
          '',
          'while IFS=, read -r object key value; do',
          '  [[ "$object" == object || -z "$object" ]] && continue',
          '  id="${IDS[$object]}"',
          '  current=$(api GET "resources/${id}/properties" | jq -r --arg k "$key" \'[.property[]? | select(.name == $k) | .value] | .[0] // ""\')',
          '  if [[ "$current" == "$value" ]]; then same=$((same + 1)); continue; fi',
          '  if (( changed >= MAX_CHANGES )); then echo "Cap of ${MAX_CHANGES} changes reached; the rest wait for the next run." >&2; break; fi',
          '  echo "${object}: ${key} \\"${current}\\" -> \\"${value}\\""',
          '  (( DRY_RUN )) || printf \'%s,%s,%s\\n\' "$object" "$key" "$current" >> "$UNDO"',
          '  jq -n --arg k "$key" --arg v "$value" --argjson t "$NOW_MS" \'{"property-content": [{statKey: $k, timestamps: [$t], values: [$v]}]}\' |',
          '    send POST "resources/${id}/properties" >/dev/null',
          '  changed=$((changed + 1))',
          'done < "$CSV"',
          'echo "${changed} changed, ${same} already right."',
          '(( DRY_RUN )) || echo "Previous values: ${UNDO}"',
        ],
        undo: 'run ./apply.sh undo-<time>.csv — it sets every property back to the value recorded before the change (an empty value where there was none).',
      });

      return {
        platform: PLATFORM,
        title: `Custom properties on ${rows.length} ${kindLabel.toLowerCase()} row(s)${schedule === 'once' ? '' : `, ${schedule}`}`,
        effect: 'reversible',
        trigger: schedule === 'once' ? { kind: 'manual', detail: 'Run once, by a person.' } : { kind: 'schedule', detail: `${schedule === 'hourly' ? 'Hourly' : 'Daily at 05:00'}, from cron on the host that runs it`, worstCase: `${schedule === 'hourly' ? '24' : 'one'} run(s) a day, up to ${cap} changes each` },
        scope: {
          what: `The ${kindLabel.toLowerCase()} named in properties.csv, and only the keys in it.`,
          decidedBy: [`The rows of properties.csv (${rows.length} now).`, `Matching by ${matchBy}: a name matching none or several ${kindLabel.toLowerCase()} stops the run before anything changes.`, `The cap: ${cap} changes per run.`],
          ifWrong: 'Custom groups built on these properties change membership, and every policy, alert and automation scoped by those groups follows.',
        },
        guardrails: [
          { rule: 'Every object is resolved before anything changes', because: 'A half-applied CSV is harder to reason about than one that did not run.' },
          { rule: `At most ${cap} changes a run`, because: 'A CSV exported wrong from the CMDB should cost one run’s worth of changes, not all of them.' },
          { rule: 'Previous values are written to an undo file first', because: 'The API keeps history, but putting it back by hand for a hundred objects is not an undo.' },
        ],
        dryRun: ['./apply.sh --dry-run resolves every object and prints each change it would make, old value and new, and changes nothing.'],
        undo: ['./apply.sh undo-<time>.csv sets every property back to its previous value.', 'Properties cannot be deleted through the API; a property that did not exist before is set back to empty.'],
        told: schedule === 'once' ? ['Whoever runs it: every change is printed.'] : ['The cron log: every change is printed, and the undo files accumulate beside the script.'],
        requires: [`The ${kindLabel.toLowerCase()} collected in VCF Operations${matchBy === 'name' ? ', with unique names' : ''}.`, 'curl, jq and bash 4 on the host that runs it.'],
        files: {
          'properties.csv': `${['object,key,value', ...rows.map((row) => row.join(','))].join('\n')}\n`,
          'apply.sh': apply,
          ...(schedule !== 'once'
            ? {
                'crontab.txt': [
                  '# Keeps the custom properties in step with properties.csv. Written active.',
                  '# Replace properties.csv from the CMDB before each run; no secret here.',
                  `${cron} ${scheduledEnv(PLATFORM)} /opt/vcf-automation/${base}/apply.sh >>/var/log/vcf-automation/${base}.log 2>&1`,
                  '',
                ].join('\n'),
              }
            : {}),
          'IMPORT.md': nothingToImportMd('custom properties', [
            './apply.sh (add --dry-run first to preview) — POST /suite-api/api/resources/{id}/properties for each changed row, with {"property-content": [{statKey, timestamps, values}]}.',
            ...(schedule !== 'once' ? ['crontab.txt in the service account’s crontab on a host of your own; the line is active once installed.'] : []),
          ]),
        },
        notes: [
          'Properties set through the API show on the object under the key given, and can be used in custom group rules (a property rule on Custom|Owner), views and reports straight away.',
          'Names are matched exactly and within the object kind. VMs with the same name in two vCenters stop the run: match by id for those.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_global_settings',
    platform: PLATFORM,
    label: 'Global settings: retention and session timeout',
    group: 'Setup',
    description:
      'The instance-wide settings — time series and history retention, how long deleted objects and cancelled alerts are kept, session timeout — exported first (the undo), compared, and only the ticked ones that differ changed.',
    inputs: [
      {
        id: 'settings',
        label: 'Change these',
        control: 'checklist',
        options: GLOBAL_SETTINGS.map((setting) => ({ value: setting.id, label: setting.label })),
        default: 'session_timeout,deleted_objects',
      },
      ...GLOBAL_SETTINGS.map((setting) => ({ id: setting.id, label: `${setting.label} (${setting.unit})`, control: 'number'         , default: setting.default, min: setting.min, max: setting.max })),
    ],
    automation: (values                 , name        )             => {
      const ticked = listOf(str(values, 'settings', ''));
      const chosen = GLOBAL_SETTINGS.filter((setting) => ticked.includes(setting.id)).map((setting) => ({ ...setting, value: num(values, setting.id, setting.default) }));
      const base = slugOf(name || 'global-settings', 'global-settings');

      const findings            = [];
      const get = (id        ) => chosen.find((setting) => setting.id === id)?.value;
      if (chosen.length === 0) findings.push(warning('vcfops.global.nothing', 'Nothing is ticked, so nothing will change.', { source: SRC }));
      if ((get('session_timeout') ?? 0) > 120) findings.push(warning('vcfops.global.long-session', `A ${get('session_timeout')}-minute session outlives the person at the desk.`, { remediation: 'Thirty minutes is the product default and a sensible ceiling for an administrative console.', source: SRC }));
      if ((get('time_series') ?? 0) > 12) findings.push(warning('vcfops.global.retention-size', `${get('time_series')} months of full-resolution data multiplies disk use on every analytics node.`, { remediation: 'Keep full resolution short and use the additional (rolled-up) retention for trends; size the cluster for it before you change it.', source: SRC }));
      if (get('deleted_objects') !== undefined && (get('deleted_objects') ?? 0) < 72) findings.push(warning('vcfops.global.deleted-short', 'Deleted objects are purged within three days, so a VM removed on Friday has no history by Monday’s incident review.', { source: SRC }));

      const desired = Object.fromEntries(chosen.map((setting) => [setting.key, String(setting.value)]));
      const apply = opsScript({
        about: ['Export the global settings (the undo), then change only the listed keys whose value differs.', 'Every key is checked against the export first: a key this release does not have stops the run.'],
        body: [
          'BEFORE="$HERE/globalsettings-before-$(date +%Y%m%d-%H%M%S).json"',
          'api GET deployment/config/globalsettings > "$BEFORE"',
          'echo "Exported the current settings: $BEFORE (the undo)"',
          `WANT=$(jq -c . "$HERE/${base}.json")`,
          'MISSING=$(jq -r --argjson w "$WANT" \'[.keyValues[]?.key] as $have | $w | keys - $have | .[]\' "$BEFORE")',
          'if [[ -n "$MISSING" ]]; then',
          '  echo "VERIFY: this release has no global setting called:" >&2; echo "$MISSING" >&2',
          '  echo "The keys it has:" >&2; jq -r \'.keyValues[]?.key\' "$BEFORE" >&2',
          `  echo "Correct the keys in ${base}.json and run again." >&2`,
          '  exit 1',
          'fi',
          'jq -r --argjson w "$WANT" \'.keyValues[]? | select($w[.key] != null and ((.values // [.value]) | first | tostring) != $w[.key]) | "\\(.key)\\t\\((.values // [.value]) | first)\\t\\($w[.key])"\' "$BEFORE" |',
          'while IFS=$\'\\t\' read -r key old new; do',
          '  echo "${key}: ${old} -> ${new}"',
          '  if (( DRY_RUN )); then continue; fi',
          '  api PUT "deployment/config/globalsettings/$(uri "$key")/$(uri "$new")" >/dev/null',
          'done',
        ],
        undo: 'PUT each key back to the value in globalsettings-before-<time>.json: PUT /suite-api/api/deployment/config/globalsettings/{key}/{value}.',
      });

      return {
        platform: PLATFORM,
        title: `Global settings — ${chosen.map((setting) => `${setting.label.toLowerCase()} ${setting.value} ${setting.unit}`).join(', ') || 'nothing ticked'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once, as a change.' },
        scope: {
          what: 'The whole VCF Operations instance.',
          decidedBy: ['The ticked settings, and only those whose value differs from what is set now.'],
          ifWrong: 'Shorter retention deletes history at the next purge, and that cannot be brought back; longer retention fills the analytics nodes’ disks.',
        },
        guardrails: [
          { rule: 'The current settings are exported before anything changes', because: 'Nothing else records what they were.' },
          { rule: 'Every key is checked against the export', because: 'A key the release does not have is refused rather than written somewhere it means nothing.' },
          { rule: 'Only differing values are changed', because: 'A run that changes nothing should say so, not rewrite every setting.' },
        ],
        dryRun: ['./apply.sh --dry-run exports the settings and prints each change it would make, old value and new.'],
        undo: ['PUT each key back to the value in globalsettings-before-<time>.json.', 'History already purged because retention was shortened does not come back.'],
        told: ['Nobody automatically. Record it as a change.'],
        requires: ['An administrator token: global settings are administrator-only.'],
        files: {
          [`${base}.json`]: `${JSON.stringify(desired, null, 2)}\n`,
          'apply.sh': apply,
          'IMPORT.md': importMd({
            title: 'the global settings',
            intro: ['Global settings are not content and are not imported from a file. apply.sh sets them through the API; the interface has them under Infrastructure Operations → Configurations → Global Settings.'],
            steps: [{ heading: 'Export, compare, change', files: [`${base}.json`, 'apply.sh'], how: ['./apply.sh (add --dry-run first to preview) — GET /suite-api/api/deployment/config/globalsettings, then PUT /suite-api/api/deployment/config/globalsettings/{key}/{value} for each change.'], verify: ['the setting keys and the PUT form are the 8.x API reference’s; apply.sh stops and lists the real keys if they differ.'] }],
          }),
        },
        notes: ['Shortening retention takes effect at the next purge. Export anything you will want before it does.'],
        findings,
      };
    },
  }),
];

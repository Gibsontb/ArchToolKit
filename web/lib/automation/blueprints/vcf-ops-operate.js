/**
 * VCF Operations 9.1: operating the platform, and the logs that are now part of it.
 *
 * Two sets here.
 *
 * VCF_OPS_LOGS_91 is log management as 9.1 ships it: no longer a separate
 * appliance, but a containerised service inside VCF Operations, configured from
 * Operate → Administration → Configurations. In 9.1.1 the SDDC Manager log
 * configuration moved there too. Saved queries have a documented suite-API
 * resource (/suite-api/api/logs/queryconfigs); everything else is reached with
 * the KB 450054 ops-li token exchange (vcf-logs91-api.ts). Every blueprint here
 * applies what it writes: apply.sh creates it enabled, --dry-run only prints,
 * and where a path is not answered on a release the script stops without
 * changing anything and the APPLY.md beside it gives the exact manual steps.
 * The local tests (masking, filters, extraction) prove a rule does what it says
 * before it is applied. Content packs are End of General Support in 9.1 and
 * are not offered.
 *
 * VCF_OPS_OPERATE is the day-two side of 9.1: VCF Health across ESX,
 * vCenter, NSX and vSAN, the new Findings API, real-time investigation,
 * vSAN storage operations, the audit trail, Security Posture Management, and
 * Workload Automation with business intent (applied through the policy API).
 *
 * Sources: the VCF Operations 9.1 what's new and 9.1.1 release notes, the 9.1
 * log-analysis and VCF Health pages on techdocs, the Advanced Cyber Compliance
 * 9.1 Security Posture Management pages, the VCF Operations API reference
 * (9.1.1) on developer.broadcom.com, and KB 450054 / 442141 / 423960.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript, scheduledEnv } from '../apply.js';
import { policyMergeScript, withScriptsImportMd } from '../vcfops-import.js';
import { PAGED_HELPERS, WEBHOOK_HELPER, shq, workDirLines } from './vcf-operations-content.js';
import { CONDITION_OPERATORS, VALUELESS, condition, conditionRows, describe, describeAll, json, linesOf, logsApplyNote, logsApplyScript, logsCallLines, logsScriptHead, md, rowsOf, sq } from './vcf-logs91-api.js';
import { VCF_LOGS91_MORE } from './vcf-logs91-more.js';

const OPS = 'vcf-operations'         ;
const LOGS = 'vcf-operations-logs'         ;
const SRC = 'ArchToolKit';

const CONFIGURATIONS = 'Operate → Administration → Configurations';

// ===========================================================================
// Log management, 9.1
// ===========================================================================

                      
                         
                         
                            
                                       
                                            
 

const MASK_PRESETS                                       = {
  password_kv: {
    label: 'Passwords in key=value pairs',
    field: 'text',
    selector: '(?i)(?:password|passwd|pwd)\\s*[=:]\\s*([^\\s,;"\']+)',
    mustMask: [
      '2026-05-01T10:00:00Z app01 orders-api: login user=alice password=Tr0ub4dor&3 result=ok',
      '2026-05-01T10:00:02Z app01 orders-api: db connect url=jdbc:postgresql://db01/orders passwd:Winter2026!',
    ],
    mustNotChange: ['2026-05-01T10:00:01Z app01 orders-api: password policy updated for 3 users', '2026-05-01T10:00:03Z app01 orders-api: login user=alice result=ok'],
  },
  bearer: {
    label: 'Bearer tokens in HTTP headers',
    field: 'text',
    selector: '(?i)bearer\\s+([A-Za-z0-9._~+/=-]{16,})',
    mustMask: ['GET /api/v1/orders Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl status=200'],
    mustNotChange: ['Bearer authentication enabled for /api/v1', 'GET /api/v1/orders status=401'],
  },
  aws_key: {
    label: 'AWS access key ids',
    field: 'text',
    selector: '\\b(AKIA[0-9A-Z]{16})\\b',
    mustMask: ['s3 upload failed access_key_id=AKIAIOSFODNN7EXAMPLE bucket=backups'],
    mustNotChange: ['s3 upload ok bucket=backups size=1048576'],
  },
  email: {
    label: 'Email addresses (PII)',
    field: 'text',
    selector: '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})',
    mustMask: ['password reset requested for alice.smith@example.com from 10.1.2.3'],
    mustNotChange: ['smtp relay ready on port 25', 'reset link expired after 3600 seconds'],
  },
  card: {
    label: 'Card numbers, keeping the last four digits',
    field: 'text',
    selector: '\\b((?:\\d[ -]?){12})\\d{4}\\b',
    mustMask: ['payment declined card=4111 1111 1111 1111 amount=20.00', 'payment declined card=5500-0000-0000-0004 amount=12.50'],
    mustNotChange: ['order 1234 shipped to depot 77', 'payment accepted amount=20.00'],
  },
  custom: {
    label: 'Custom selector',
    field: 'text',
    selector: '',
    // These fit the default custom selector; replace them with lines for yours.
    mustMask: ['GET /api/v1/orders x-api-key: 3f9c1e7a2b4d4c8e9f00a1b2 status=200'],
    mustNotChange: ['GET /api/v1/orders status=200', 'x-api-key header missing, request rejected'],
  },
};

/** Whether a regex has at least one capturing group — 9.1 masks what the groups capture. */
function hasCaptureGroup(selector        )          {
  const stripped = selector.replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /\((?!\?)/.test(stripped) || /\(\?<[A-Za-z]/.test(stripped) || /\(\?P</.test(stripped);
}

const MASK_TEST = [
  '#!/usr/bin/env bash',
  '# Run the masking selector over the sample lines, the way 9.1 applies it:',
  '# whatever each capture group matches is replaced by the mask value.',
  '#',
  '# Local only; it talks to nothing. Exits 1 when a line that must be masked',
  '# comes out unchanged or still holds what was captured, or when a line that',
  '# must not change does. The Log Masking tab’s own preview is the authority —',
  '# this uses Python’s regex engine, which differs from the platform’s at the',
  '# edges (possessive quantifiers, some inline flags).',
  'set -euo pipefail',
  'command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }',
  'cd "$(dirname "$0")"',
  'python3 - masking-rule.json samples-must-mask.txt samples-must-not-change.txt <<\'PY\'',
  'import json, re, sys',
  'rule = json.load(open(sys.argv[1], encoding="utf-8"))',
  'rx = re.compile(rule["selector"])',
  'replacement = rule.get("maskValue", "")',
  'if rx.groups == 0:',
  '    print("FAIL  the selector has no capture group, so 9.1 would mask nothing")',
  '    sys.exit(1)',
  '',
  'def apply(line):',
  '    captured = []',
  '    def rep(m):',
  '        s, off = m.group(0), m.start(0)',
  '        for g in range(rx.groups, 0, -1):',
  '            if m.start(g) < 0:',
  '                continue',
  '            captured.append(m.group(g))',
  '            a, b = m.start(g) - off, m.end(g) - off',
  '            s = s[:a] + replacement + s[b:]',
  '        return s',
  '    return rx.sub(rep, line), captured',
  '',
  'bad = 0',
  'tested = 0',
  'for path, must in ((sys.argv[2], True), (sys.argv[3], False)):',
  '    for line in open(path, encoding="utf-8"):',
  '        line = line.rstrip("\\n")',
  '        if not line or line.startswith("#"):',
  '            continue',
  '        tested += 1',
  '        out, caps = apply(line)',
  '        leaked = [c for c in caps if c and c != replacement and c in out]',
  '        if must and (out == line or leaked):',
  '            print("FAIL  not masked: " + line)',
  '            bad += 1',
  '        elif not must and out != line:',
  '            print("FAIL  changed:    " + line + "  ->  " + out)',
  '            bad += 1',
  '        else:',
  '            print("ok    " + out)',
  'if tested == 0:',
  '    print("FAIL  no sample lines, so this proves nothing")',
  '    sys.exit(1)',
  'print(f"{tested} line(s) tested, {bad} failure(s)")',
  'sys.exit(1 if bad else 0)',
  'PY',
  '',
].join('\n');

const FILTER_TEST = [
  '#!/usr/bin/env bash',
  '# Run the filter’s match condition over sample message lines.',
  '#',
  '# Local only. Exits 1 when a line that must be kept would match (and so be',
  '# dropped), or a line meant to be dropped would not. Only the match condition',
  '# is simulated; the scope condition (which hosts or apps) is not — the',
  '# Log Filtering tab’s PREVIEW is where the combination is checked.',
  'set -euo pipefail',
  'command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }',
  'cd "$(dirname "$0")"',
  'python3 - log-filter.json samples-drop.txt samples-keep.txt <<\'PY\'',
  'import json, re, sys',
  'spec = json.load(open(sys.argv[1], encoding="utf-8"))',
  'cond = spec["match"]',
  'op, value = cond["operator"], cond.get("value", "")',
  'if op in ("Exists", "Does not exist"):',
  '    print("SKIP  an Exists condition cannot be simulated on message text; use PREVIEW")',
  '    sys.exit(0)',
  'def matches(line):',
  '    if op == "Contains": return value in line',
  '    if op == "Does not contain": return value not in line',
  '    if op == "Starts with": return line.startswith(value)',
  '    if op == "Does not start with": return not line.startswith(value)',
  '    if op == "Matches Regex": return re.search(value, line) is not None',
  '    raise SystemExit("unknown operator " + op)',
  'bad = 0',
  'tested = 0',
  'for path, drop in ((sys.argv[2], True), (sys.argv[3], False)):',
  '    for line in open(path, encoding="utf-8"):',
  '        line = line.rstrip("\\n")',
  '        if not line or line.startswith("#"):',
  '            continue',
  '        tested += 1',
  '        hit = matches(line)',
  '        if hit != drop:',
  '            print(("FAIL  would keep: " if drop else "FAIL  would DROP: ") + line)',
  '            bad += 1',
  '        else:',
  '            print(("ok    drop  " if drop else "ok    keep  ") + line)',
  'if tested == 0:',
  '    print("FAIL  no sample lines, so this proves nothing")',
  '    sys.exit(1)',
  'print(f"{tested} line(s) tested, {bad} failure(s)")',
  'sys.exit(1 if bad else 0)',
  'PY',
  '',
].join('\n');

export const VCF_OPS_LOGS_91                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_masking',
    platform: LOGS,
    label: 'Mask secrets and PII at ingestion (9.1)',
    group: 'Log management 9.1',
    description:
      'A 9.1 log masking rule — passwords, tokens, keys, email addresses or card numbers replaced as the event is ingested — applied through the log management API (KB 450054 token exchange) and created enabled, with sample lines that must be masked and lines that must not change, and a local test that fails if the selector gets either wrong. apply.sh runs the test first and refuses to apply a selector that fails it.',
    inputs: [
      { id: 'rule_name', label: 'Rule name', control: 'text', default: 'Mask passwords in key=value' },
      {
        id: 'preset',
        label: 'Mask',
        control: 'select',
        options: Object.entries(MASK_PRESETS).map(([value, preset]) => ({ value, label: preset.label })),
        default: 'password_kv',
      },
      { id: 'custom_selector', label: 'Selector (regex with capture groups)', control: 'text', default: '(?i)x-api-key:\\s*(\\S+)', showWhen: { input: 'preset', equals: ['custom'] }, hint: 'What each group captures is replaced' },
      { id: 'field_name', label: 'Field', control: 'text', default: 'text', hint: 'The field picked in the Field Name dropdown. text is the message body' },
      { id: 'mask_value', label: 'Replace with', control: 'text', default: '****', hint: 'The platform default is an empty string, which makes masked lines hard to recognise' },
      { id: 'filter_field', label: 'Only for events where', control: 'text', default: 'appname', hint: 'Optional filter criterion. Empty value applies the rule to every event' },
      { id: 'filter_op', label: 'Filter operator', control: 'select', options: CONDITION_OPERATORS, default: 'Contains' },
      { id: 'filter_value', label: 'Filter value', control: 'text', default: 'orders-api' },
      { id: 'samples_mask', label: 'Lines that must be masked', control: 'textarea', default: '', hint: 'One per line. Empty uses the preset’s own samples' },
      { id: 'samples_clean', label: 'Lines that must not change', control: 'textarea', default: '', hint: 'One per line. Empty uses the preset’s own samples' },
    ],
    automation: (values                 , name        )             => {
      const ruleName = str(values, 'rule_name', 'Mask secrets');
      const presetKey = str(values, 'preset', 'password_kv');
      const preset = MASK_PRESETS[presetKey] ?? MASK_PRESETS['password_kv'] ;
      const selector = presetKey === 'custom' ? str(values, 'custom_selector', '') : preset.selector;
      const field = str(values, 'field_name', preset.field);
      const maskValue = String(values['mask_value'] ?? '****');
      const filter = condition(str(values, 'filter_field', ''), str(values, 'filter_op', 'Contains'), str(values, 'filter_value', ''));
      const mustMask = linesOf(str(values, 'samples_mask', '')).length > 0 ? linesOf(str(values, 'samples_mask', '')) : [...preset.mustMask];
      const mustNot = linesOf(str(values, 'samples_clean', '')).length > 0 ? linesOf(str(values, 'samples_clean', '')) : [...preset.mustNotChange];
      const base = slugOf(name || ruleName, 'log-mask');

      const findings            = [];
      if (!selector) {
        findings.push(error('vcflog91.mask.no-selector', 'There is no selector, so there is nothing to mask.', { source: SRC }));
      } else if (!hasCaptureGroup(selector)) {
        findings.push(
          error('vcflog91.mask.no-group', 'The selector has no capture group. 9.1 replaces what the groups capture, so this rule would mask nothing.', {
            remediation: 'Wrap the part to hide in parentheses: password=(\\S+) masks the value and keeps the key.',
            source: SRC,
          }),
        );
      }
      if (/^\(?\^?\(\.\*\)\$?\)?$|\(\^\[\\s\\S\]\$\)/.test(selector) && !filter) {
        findings.push(
          warning('vcflog91.mask.whole-field', `This selector masks the whole ${field} field of every event, with no filter to narrow it.`, {
            remediation: 'Whole-field masking belongs on one application’s events. Add a filter criterion, or the log store fills with lines that say only the mask value.',
            source: SRC,
          }),
        );
      }
      if (mustMask.length === 0 || mustNot.length === 0) {
        findings.push(
          warning('vcflog91.mask.no-samples', 'Without lines that must be masked and lines that must not change, the test proves nothing.', {
            remediation: 'Paste two or three real lines of each kind, with the real secret replaced by a fake of the same shape.',
            source: SRC,
          }),
        );
      }

      const rule = {
        name: ruleName,
        fieldName: field,
        selector,
        maskValue,
        enabled: true,
        filterCriteria: filter ? [filter] : [],
      };

      return {
        platform: LOGS,
        title: `Log masking — ${preset.label.toLowerCase()}${filter ? `, where ${describe(filter)}` : ''}`,
        effect: 'reversible',
        trigger: {
          kind: 'manual',
          detail: `Applied once by apply.sh (the Log Masking tab of ${CONFIGURATIONS} → Log Processing shows it); from then it runs on every event ingested that ${filter ? `has ${describe(filter)}` : 'reaches log management'}.`,
          worstCase: 'on every ingested event, at the full ingestion rate',
        },
        scope: {
          what: `The ${field} field of ${filter ? `events where ${describe(filter)}` : 'every event log management ingests'}, from the moment the rule is enabled.`,
          decidedBy: [
            'The filter criteria on the rule, if any.',
            `The selector: only what its capture groups match within ${field} is replaced.`,
            'Time: events already stored are never rewritten; only events ingested after the rule is enabled are masked.',
          ],
          ifWrong: 'A selector that matches too much blanks the evidence an investigation needs, permanently, for every event ingested while it is on. One that matches too little leaves the secret in the store and in every forwarded copy.',
        },
        guardrails: [
          { rule: 'test-masking.sh exits 1 when a sample secret survives masking or a clean line is changed, and apply.sh runs it first and stops on a failure', because: 'A selector one character off masks nothing, and nobody notices until the secret turns up in a forwarded copy.' },
          { rule: 'The platform masks only events ingested after the rule is enabled', because: 'A bad selector cannot destroy the history already stored — it can only damage new events until it is turned off.' },
        ],
        dryRun: [
          'Run ./test-masking.sh. It reads only the files beside it.',
          'Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.',
          'In the Log Masking tab, use the rule form’s preview on real events before enabling it.',
          'After enabling, search Explore Logs for the next event from a sample source and check the value arrives masked.',
        ],
        undo: [
          'Log Processing → Log Masking → the rule → turn Enable Configuration off, or delete it (or DELETE it by the id apply.sh saved under before-<time>/). New events stop being masked at once.',
          'Events ingested while it was on stay masked. That part cannot be undone — which is the point of masking, and the risk of a selector that is too wide.',
        ],
        told: ['Nobody — masking is silent by design. Record the rule and its test output in the change that enabled it.'],
        requires: ['Log management 9.1 deployed and integrated with VCF Operations.', 'A VCF Operations account with rights to Operate → Administration → Configurations (VCFOPS_USER with VCFOPS_PASSWORD_FILE, or VCFOPS_TOKEN).', 'python3, jq and curl on the machine that runs apply.sh.'],
        files: {
          'masking-rule.json': json(rule),
          'samples-must-mask.txt': md(['# Lines that must come out masked. Fake secrets of the real shape only.', ...mustMask]),
          'samples-must-not-change.txt': md(['# Lines that must come out exactly as they went in.', ...mustNot]),
          'test-masking.sh': MASK_TEST,
          'apply.sh': logsApplyScript({
            purpose: `Test, then apply the log masking rule "${ruleName}" to VCF Operations 9.1 log management, enabled.`,
            extraTools: ['python3'],
            first: ['bash "$HERE/test-masking.sh" || { echo "test-masking.sh failed: nothing applied." >&2; exit 1; }', ''],
            calls: [{ what: `masking rule ${ruleName}`, key: 'masking', path: '/api/v2/log-masking', payload: 'masking-rule.json', name: ruleName }],
            undo: 'turn the rule off or delete it in Log Processing → Log Masking; events already masked stay masked.',
            manual: `${base}-APPLY.md`,
          }),
          [`${base}-APPLY.md`]: md([
            `# "${ruleName}" by hand (only when apply.sh stops with exit 3)`,
            '',
            '`./apply.sh` applies this rule. Use these steps only when it reports that the log management path is not answered on your release.',
            '',
            '1. Run `./test-masking.sh` and read every line. It must end with 0 failures.',
            `2. VCF Operations → ${CONFIGURATIONS} → **Log Processing** card → **Log Masking** tab → **Add**.`,
            `3. Name: \`${ruleName}\``,
            `4. Field Name: \`${field}\` (pick it from the dropdown — if it is not listed, the field is not extracted on these events).`,
            `5. Selector: \`${selector || '<REQUIRED>'}\``,
            `6. Mask Value: \`${maskValue}\``,
            ...(filter ? [`7. Add filter: ${filter.field} — ${filter.operator}${filter.value !== undefined ? ` — \`${filter.value}\`` : ''}`] : ['7. No filter: the rule applies to every event.']),
            '8. Preview against real events, then save with Enable Configuration on.',
            '9. Check the next event from a sample source in Explore Logs.',
            '',
            'Only events ingested after step 8 are masked. Stored events are never rewritten.',
          ]),
        },
        notes: [
          logsApplyNote(),
          'VERIFY: whether a forwarded copy is masked depends on whether forwarding runs after masking in the 9.1 pipeline, which the documentation does not state. Send one sample line and look at it on the far side before relying on it.',
          'Masking is not a substitute for fixing the application that logs the secret. Open a ticket against it as well.',
          'In 9.1.1 SDDC Manager log collection is also configured from VCF Operations, so its events pass through the same masking rules.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_filtering',
    platform: LOGS,
    label: 'Drop noisy events before they are stored (9.1)',
    group: 'Log management 9.1',
    description:
      'A 9.1 ingestion filter — debug and trace from non-production hosts, health-check chatter — with a scope condition so it cannot reach production by accident, a savings estimate from your own ingest numbers, and a local test that fails if a line you meant to keep would be dropped. apply.sh runs the test, then creates the filter enabled through the log management API.',
    inputs: [
      { id: 'filter_name', label: 'Filter name', control: 'text', default: 'Drop debug from non-production' },
      { id: 'scope_field', label: 'Only for events where', control: 'text', default: 'hostname', hint: 'The scope condition. Keep one — it is what keeps production out' },
      { id: 'scope_op', label: 'Scope operator', control: 'select', options: CONDITION_OPERATORS, default: 'Starts with' },
      { id: 'scope_value', label: 'Scope value', control: 'text', default: 'dev-' },
      { id: 'match_field', label: 'Drop when', control: 'text', default: 'text' },
      { id: 'match_op', label: 'Match operator', control: 'select', options: CONDITION_OPERATORS, default: 'Matches Regex' },
      { id: 'match_value', label: 'Match value', control: 'text', default: '\\b(DEBUG|TRACE)\\b' },
      { id: 'samples_drop', label: 'Lines that should be dropped', control: 'textarea', default: '2026-05-01T10:00:00Z dev-app01 orders-api: DEBUG cache miss key=sku-1234\n2026-05-01T10:00:01Z dev-app01 orders-api: TRACE entering handler /orders' },
      { id: 'samples_keep', label: 'Lines that must be kept', control: 'textarea', default: '2026-05-01T10:00:02Z dev-app01 orders-api: ERROR payment gateway timeout\n2026-05-01T10:00:03Z dev-app01 sshd[811]: Accepted publickey for deploy' },
      { id: 'daily_gb', label: 'Daily ingest today (GB)', control: 'number', default: 200, min: 0, max: 100000 },
      { id: 'noise_pct', label: 'Share this filter drops (%)', control: 'number', default: 25, min: 0, max: 100, hint: 'Measure it first — see the savings estimate file' },
      { id: 'retention_days', label: 'Retention (days)', control: 'number', default: 30, min: 1, max: 3650 },
      { id: 'cost_per_gb', label: 'Downstream cost per GB (optional)', control: 'number', default: 0, min: 0, max: 100000, hint: 'e.g. SIEM licence per GB forwarded. 0 leaves it out' },
    ],
    automation: (values                 , name        )             => {
      const filterName = str(values, 'filter_name', 'Drop noise');
      const scope = condition(str(values, 'scope_field', ''), str(values, 'scope_op', 'Starts with'), str(values, 'scope_value', ''));
      const matchOp = str(values, 'match_op', 'Matches Regex');
      const match = condition(str(values, 'match_field', 'text'), matchOp, str(values, 'match_value', ''));
      const daily = num(values, 'daily_gb', 200);
      const pct = num(values, 'noise_pct', 25);
      const retention = num(values, 'retention_days', 30);
      const cost = num(values, 'cost_per_gb', 0);
      const base = slugOf(name || filterName, 'log-filter');

      const savedDay = Math.round(daily * pct) / 100;
      const savedStored = Math.round(savedDay * retention * 10) / 10;

      const findings            = [];
      if (!match) {
        findings.push(error('vcflog91.filter.no-match', 'The match condition has no value, so the filter has nothing to test.', { source: SRC }));
      }
      if (!scope && VALUELESS.has(matchOp)) {
        findings.push(
          error('vcflog91.filter.drops-everything', `"${describe(match)}" with no scope condition drops every event that ${matchOp === 'Exists' ? 'has' : 'lacks'} that field, across the estate.`, {
            remediation: 'Add a scope condition — a hostname prefix, an appname — so the filter is about one noisy source.',
            source: SRC,
          }),
        );
      } else if (!scope) {
        findings.push(
          warning('vcflog91.filter.no-scope', 'No scope condition: the filter applies to production as well as everything else.', {
            remediation: 'Dropping debug in production is sometimes right, but decide it on purpose. A hostname or appname condition makes the decision visible.',
            source: SRC,
          }),
        );
      }
      if (/(audit|sshd|sudo|auth|login|vpxd-svcs|security)/i.test(`${scope?.value ?? ''} ${match?.value ?? ''}`)) {
        findings.push(
          warning('vcflog91.filter.security', 'This filter mentions security-relevant sources. Dropped events never reach the audit trail.', {
            remediation: 'Check the dropped set in PREVIEW contains no authentication or audit events before creating it.',
            source: SRC,
          }),
        );
      }
      if (pct > 50) {
        findings.push(
          warning('vcflog91.filter.optimistic', `${pct}% is a large share for one filter.`, {
            remediation: 'Measure before relying on the estimate: chart the count of matching events against the total over a normal week.',
            source: SRC,
          }),
        );
      }

      const spec = {
        name: filterName,
        enabled: true,
        scope: scope ?? null,
        match: match ?? { field: 'text', operator: matchOp },
        conditions: [scope, match].filter(Boolean),
      };

      const estimate = md([
        `# Savings estimate — ${filterName}`,
        '',
        `Ingest today: ${daily} GB/day. Share dropped: ${pct}%.`,
        '',
        `- Ingest avoided: **${savedDay} GB/day**, about ${Math.round(savedDay * 30)} GB/month.`,
        `- Stored data avoided at ${retention} days retention: about **${savedStored} GB**.`,
        ...(cost > 0 ? [`- Downstream cost avoided, if these events are forwarded today: about **${Math.round(savedDay * 30 * cost)}** per month at ${cost} per GB.`] : []),
        '',
        '## Measure the share before trusting this',
        '',
        '1. Explore Logs, last 7 days, no filter: note the event count.',
        `2. Add the scope condition (${describe(scope)}) and the match condition (${describe(match)}): note the count.`,
        '3. The second over the first is the share. Replace the input with it and regenerate.',
        '',
        'Event counts stand in for bytes; debug lines are often longer than average, so the byte saving is usually higher than the count suggests.',
      ]);

      return {
        platform: LOGS,
        title: `Ingestion filter — drop ${describe(match)}${scope ? ` where ${describe(scope)}` : ''}`,
        effect: 'reversible',
        trigger: {
          kind: 'manual',
          detail: `Applied once by apply.sh (it shows in ${CONFIGURATIONS} → Log Processing → Log Filtering); from then it runs on every event ingested.`,
          worstCase: 'on every ingested event',
        },
        scope: {
          what: `Events where ${describe(match)}${scope ? ` and ${describe(scope)}` : ', from any host'}.`,
          decidedBy: ['The scope condition, which decides which sources the filter looks at.', 'The match condition, which decides which of their events are dropped.', 'Both are ANDed in the rule form.'],
          ifWrong: 'Dropped events are never stored, never alert and never reach a forwarded copy. A filter wider than meant is found the day somebody searches for an event that was never kept.',
        },
        guardrails: [
          { rule: 'test-filter.sh exits 1 when a line meant to be kept would be dropped', because: 'A regex that also matches ERROR lines turns a debug filter into an outage blind spot.' },
          { rule: 'This generator refuses a field-exists filter with no scope condition (an error finding)', because: '"message exists" with no scope drops everything, and the rule form will accept it.' },
        ],
        dryRun: ['Run ./test-filter.sh.', 'Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.', 'After it is applied, open it in the Log Filtering tab and use PREVIEW to read what it drops.'],
        undo: ['Log Processing → Log Filtering → the filter → Enabled off, or delete it. Ingestion resumes at once.', 'Events dropped while it was on were never stored and cannot be recovered.'],
        told: ['Nobody. Record the PREVIEW result and the measured share in the change.'],
        requires: ['Log management 9.1.', 'Fewer than 10 filters already defined — the documented maximum is 10; apply.sh counts them and stops at 10.', 'python3, jq and curl on the machine that runs apply.sh.'],
        files: {
          'log-filter.json': json(spec),
          'samples-drop.txt': md(['# Lines the filter should drop.', ...linesOf(str(values, 'samples_drop', ''))]),
          'samples-keep.txt': md(['# Lines the filter must keep.', ...linesOf(str(values, 'samples_keep', ''))]),
          'test-filter.sh': FILTER_TEST,
          'savings-estimate.md': estimate,
          'apply.sh': logsApplyScript({
            purpose: `Test, then apply the ingestion filter "${filterName}" to VCF Operations 9.1 log management, enabled.`,
            extraTools: ['python3'],
            first: ['bash "$HERE/test-filter.sh" || { echo "test-filter.sh failed: nothing applied." >&2; exit 1; }', ''],
            calls: [
              {
                what: `ingestion filter ${filterName}`,
                key: 'filters',
                path: '/api/v2/log-filters',
                payload: 'log-filter.json',
                name: filterName,
                check: ['N=$(jq \'[.. | objects | select(has("name") and (has("conditions") or has("filters") or has("match")))] | length\' "$LIST")', '(( N < 10 )) || { echo "$N filters already defined: 10 is the documented maximum. Combine them first." >&2; exit 1; }'],
              },
            ],
            undo: 'turn the filter off or delete it in Log Processing → Log Filtering; ingestion of those events resumes at once.',
            manual: `${base}-APPLY.md`,
          }),
          [`${base}-APPLY.md`]: md([
            `# "${filterName}" by hand (only when apply.sh stops with exit 3)`,
            '',
            '1. Run `./test-filter.sh`; it must end with 0 failures.',
            `2. VCF Operations → ${CONFIGURATIONS} → **Log Processing** card → **Log Filtering** tab → **ADD**.`,
            `3. Name: \`${filterName}\`. Leave Enable Configuration on only once PREVIEW looks right.`,
            ...(scope ? [`4. ADD FILTER: ${scope.field} — ${scope.operator}${scope.value !== undefined ? ` — \`${scope.value}\`` : ''}`] : ['4. (No scope condition.)']),
            ...(match ? [`5. ADD FILTER: ${match.field} — ${match.operator}${match.value !== undefined ? ` — \`${match.value}\`` : ''}`] : []),
            '6. PREVIEW, read the sample it shows, then CREATE.',
            '',
            'VERIFY: the 9.1 page does not say in words whether matching events are dropped or kept. PREVIEW shows which; if it shows the events you meant to keep, the semantics are the other way round.',
          ]),
        },
        notes: [
          logsApplyNote(),
          '9.1 also offers volume control per log source — logical service groups on or off, and the log level per source (Info by default). Turning a source down to Info at the source is cheaper than filtering its debug at ingestion.',
          'The documented maximum is 10 filters. Combine related noise into one filter with a regex rather than spending them one source at a time.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_forwarding',
    platform: LOGS,
    label: 'Forward filtered logs out of VCF Operations (9.1)',
    group: 'Log management 9.1',
    description:
      'A 9.1 log forwarding rule — syslog over TLS, TCP or UDP, raw, or CFAPI to another log instance — to a SIEM, a Splunk heavy forwarder or another log store, with the CA chain it trusts, worker count, disk buffer and retry, tags added to every event, and filter rows so only what is needed leaves. apply.sh checks the destination, then creates the rule enabled.',
    inputs: [
      { id: 'dest_name', label: 'Name', control: 'text', default: 'SIEM — security events' },
      {
        id: 'dest_kind',
        label: 'Destination',
        control: 'select',
        options: [
          { value: 'syslog_tls', label: 'Syslog over TCP with TLS', group: 'Syslog' },
          { value: 'syslog_tcp', label: 'Syslog over TCP', group: 'Syslog' },
          { value: 'syslog_udp', label: 'Syslog over UDP', group: 'Syslog' },
          { value: 'raw', label: 'Raw (no syslog header)', group: 'Other' },
          { value: 'splunk', label: 'Splunk (syslog TLS to a heavy forwarder)', group: 'Other' },
          { value: 'logs_instance', label: 'Another log instance (CFAPI over TLS)', group: 'Other' },
        ],
        default: 'syslog_tls',
      },
      { id: 'host', label: 'Host', control: 'text', default: 'siem-collector01.example.com', hint: 'FQDN, IPv4 or IPv6 address' },
      { id: 'port', label: 'Port', control: 'number', default: 6514, min: 1, max: 65535, hint: '6514 syslog TLS, 514 plain, 9543 CFAPI TLS' },
      { id: 'ca_file', label: 'CA chain to trust (PEM file beside apply.sh)', control: 'text', default: 'destination-ca.pem', hint: 'Read when apply.sh runs; empty trusts the platform’s own store', showWhen: { input: 'dest_kind', equals: ['syslog_tls', 'splunk', 'logs_instance'] } },
      { id: 'workers', label: 'Worker count', control: 'number', default: 8, min: 1, max: 32, hint: 'Parallel connections to the destination' },
      { id: 'disk_buffer_mb', label: 'Disk buffer (MB)', control: 'number', default: 2000, min: 0, max: 50000, hint: 'Events queue here while the destination is down' },
      { id: 'retry_seconds', label: 'Retry every (seconds)', control: 'number', default: 30, min: 5, max: 3600, hint: 'VERIFY: field name on 9.1' },
      {
        id: 'filter_join',
        label: 'Forward events matching',
        control: 'select',
        options: [
          { value: 'ANY', label: 'Any filter row (OR)' },
          { value: 'ALL', label: 'Every filter row (AND)' },
        ],
        default: 'ANY',
      },
      {
        id: 'filters',
        label: 'Filters',
        control: 'textarea',
        default: 'appname | Starts with | sshd\nappname | Starts with | sudo\ntext | Contains | audit',
        hint: 'field | operator | value',
        help: 'Operators: Contains, Does not contain, Starts with, Does not start with, Matches Regex, Exists, Does not exist. No rows forwards everything.',
      },
      { id: 'custom_fields', label: 'Tags to add to every event', control: 'text', default: 'source_platform=vcf, site=dc1', hint: 'key=value pairs, comma separated' },
      { id: 'splunk_index', label: 'Splunk index', control: 'text', default: 'vcf', showWhen: { input: 'dest_kind', equals: ['splunk'] } },
    ],
    automation: (values                 , name        )             => {
      const destName = str(values, 'dest_name', 'External');
      const kind = str(values, 'dest_kind', 'syslog_tls');
      const host = str(values, 'host', '');
      const port = num(values, 'port', 6514);
      const workers = num(values, 'workers', 8);
      const buffer = num(values, 'disk_buffer_mb', 2000);
      const retry = num(values, 'retry_seconds', 30);
      const join = str(values, 'filter_join', 'ANY') === 'ALL' ? 'AND' : 'OR';
      const { conditions: filters, bad } = conditionRows(str(values, 'filters', ''));
      const custom = listOf(str(values, 'custom_fields', ''))
        .map((pair) => pair.split('='))
        .filter((pair) => pair.length === 2 && pair[0] .trim() && pair[1] .trim())
        .map(([key, value]) => ({ key: key .trim(), value: value .trim() }));
      const index = str(values, 'splunk_index', 'vcf');
      const base = slugOf(name || destName, 'log-forwarding');

      const tls = kind === 'syslog_tls' || kind === 'splunk' || kind === 'logs_instance';
      const caFile = tls ? str(values, 'ca_file', '') : '';
      const transport = kind === 'syslog_udp' ? 'UDP' : 'TCP';
      const protocol = kind === 'raw' ? 'Raw' : kind === 'logs_instance' ? 'CFAPI' : 'Syslog';
      const ipv6 = host.includes(':');
      const filterText = describeAll(filters, join);

      const findings            = [];
      if (!host) findings.push(error('vcflog91.fwd.no-host', 'No destination host.', { source: SRC }));
      for (const row of bad) findings.push(error('vcflog91.fwd.bad-filter', `Filter row "${row}" has an operator 9.1 does not offer, or no value.`, { source: SRC }));
      if (kind === 'syslog_udp') {
        findings.push(
          warning('vcflog91.fwd.udp', 'UDP drops events under load and cannot be encrypted.', {
            remediation: 'Use TCP with TLS for anything an auditor or an incident will depend on.',
            source: SRC,
          }),
        );
      }
      if (tls && port === 514) {
        findings.push(warning('vcflog91.fwd.tls-514', 'Port 514 is the plain syslog port. TLS listeners are normally on 6514.', { source: SRC }));
      }
      if (filters.length === 0) {
        findings.push(
          warning('vcflog91.fwd.unfiltered', 'Unfiltered: every event log management ingests is forwarded.', {
            remediation: 'Most destinations charge by volume. Forward the security and audit sources, not the debug of every appliance.',
            source: SRC,
          }),
        );
      }
      if (buffer === 0) {
        findings.push(warning('vcflog91.fwd.no-buffer', 'No disk buffer: while the destination is down, events for it are dropped.', { remediation: 'Size the buffer for the longest outage the destination owner will admit to, at this rule’s rate.', source: SRC }));
      }
      if (workers > 16) {
        findings.push(info('vcflog91.fwd.workers', `${workers} workers: each is a connection the destination has to accept. Check its limit.`, { source: SRC }));
      }
      if (kind === 'splunk') {
        findings.push(
          info('vcflog91.fwd.splunk', 'The 9.1 forwarding form offers Syslog and Raw; Splunk HTTP Event Collector is not a documented destination.', {
            remediation: 'This sends syslog over TLS to a heavy forwarder with a tcp-ssl input, which is the route that works. splunk-inputs.conf is the Splunk side.',
            source: SRC,
          }),
        );
      }

      const spec = {
        id: destName,
        name: destName,
        host,
        port,
        protocol: protocol.toLowerCase(),
        transportProtocol: transport,
        sslEnabled: tls,
        workerCount: workers,
        diskCacheSize: buffer,
        retryIntervalSeconds: retry,
        enabled: true,
        tags: Object.fromEntries(custom.map((field) => [field.key, field.value])),
        filterOperator: join,
        filters,
      };

      const check = [
        '#!/usr/bin/env bash',
        `# Check ${host}:${port} can take what the forwarding rule will send.`,
        '#',
        '# Reads only. Run it from a machine on the same network as the VCF Operations',
        '# and log management nodes. apply.sh runs it before it creates the rule.',
        '# Exits 1 on a name that does not resolve, a closed port, or (for TLS) a',
        '# certificate that does not verify or expires within 30 days.',
        'set -euo pipefail',
        `HOST="\${HOST:-${host}}"`,
        `PORT="\${PORT:-${port}}"`,
        ...(caFile ? [`CA_FILE="\${CA_FILE:-$(dirname "$0")/${caFile}}"`, '[[ -r "$CA_FILE" ]] || CA_FILE=""'] : []),
        'PROBLEMS=()',
        '',
        '# An IPv6 literal is its own address; anything else must resolve (A or AAAA).',
        'if [[ "$HOST" != *:* ]]; then getent ahosts "$HOST" >/dev/null || PROBLEMS+=("$HOST does not resolve"); fi',
        'TARGET="$HOST"; [[ "$HOST" == *:* ]] && TARGET="[$HOST]"',
        ...(transport === 'UDP'
          ? ['echo "UDP cannot be tested from here: nothing answers a UDP syslog packet. Check the collector’s own counters after the rule is created."']
          : [
              'if ! timeout 5 bash -c "exec 3<>/dev/tcp/$HOST/$PORT" 2>/dev/null; then',
              '  PROBLEMS+=("$HOST:$PORT is not accepting TCP connections")',
              ...(tls
                ? [
                    'else',
                    '  command -v openssl >/dev/null || { echo "openssl is required for the TLS check" >&2; exit 2; }',
                    '  CERT=$(openssl s_client -connect "$TARGET:$PORT" -servername "$HOST" ${CA_FILE:+-CAfile "$CA_FILE"} -verify_return_error </dev/null 2>/dev/null) \\',
                    '    || PROBLEMS+=("TLS to $HOST:$PORT does not verify — put the chain log management will trust in CA_FILE")',
                    '  if [[ -n "${CERT:-}" ]]; then',
                    '    echo "$CERT" | openssl x509 -noout -subject -enddate || true',
                    '    echo "$CERT" | openssl x509 -noout -checkend $((30*86400)) >/dev/null || PROBLEMS+=("the certificate on $HOST:$PORT expires within 30 days")',
                    '  fi',
                  ]
                : []),
              'fi',
            ]),
        '',
        'if (( ${#PROBLEMS[@]} )); then',
        '  printf "PROBLEM: %s\\n" "${PROBLEMS[@]}" >&2',
        '  exit 1',
        'fi',
        'echo "$HOST:$PORT looks ready."',
        '',
      ].join('\n');

      const files                         = {
        'forwarding-rule.json': json(spec),
        'check-destination.sh': check,
        'apply.sh': logsApplyScript({
          purpose: `Check the destination, then create the log forwarding rule "${destName}" in VCF Operations 9.1 log management, enabled.`,
          first: [
            '(( DRY_RUN )) || bash "$HERE/check-destination.sh" || { echo "check-destination.sh failed: nothing applied." >&2; exit 1; }',
            ...(caFile
              ? [
                  `CA="$HERE/${caFile}"`,
                  'if [[ -r "$CA" ]]; then',
                  '  jq --rawfile ca "$CA" \'. + {sslCertificate: $ca}\' "$HERE/forwarding-rule.json" > "$HERE/forwarding-rule.applied.json"',
                  'else',
                  `  echo "No ${caFile} beside this script: the rule will trust the platform’s own certificate store." >&2`,
                  '  cp "$HERE/forwarding-rule.json" "$HERE/forwarding-rule.applied.json"',
                  'fi',
                ]
              : ['cp "$HERE/forwarding-rule.json" "$HERE/forwarding-rule.applied.json"']),
            '',
          ],
          calls: [
            {
              what: `forwarding rule ${destName}`,
              key: 'forwarding',
              path: '/api/v1/forwarding',
              payload: 'forwarding-rule.applied.json',
              name: destName,
              check: ['N=$(jq \'[.. | objects | select(has("host") and has("port"))] | length\' "$LIST")', '(( N < 10 )) || { echo "$N forwarding rules already defined: 10 is the documented maximum." >&2; exit 1; }'],
            },
          ],
          undo: 'turn the rule off or delete it in the Log Forwarding card (or DELETE it by the id saved under before-<time>/). Events already sent stay at the destination.',
          manual: `${base}-APPLY.md`,
        }),
        [`${base}-APPLY.md`]: md([
          `# "${destName}" by hand (only when apply.sh stops with exit 3)`,
          '',
          '1. Run `./check-destination.sh` from the management network.',
          `2. VCF Operations → ${CONFIGURATIONS} → **Log Forwarding** card → **ADD**.`,
          `3. Name \`${destName}\`, Host \`${host}\`, Port \`${port}\`, Protocol ${protocol}${protocol === 'Syslog' ? `, Transport ${transport}` : ''}${tls ? `, SSL/TLS on${caFile ? `, paste the chain from ${caFile}` : ''}` : ''}.`,
          `4. Workers ${workers}, disk buffer ${buffer} MB, retry ${retry} s (where the form offers them).`,
          ...(custom.length > 0 ? [`5. Custom fields: ${custom.map((field) => `\`${field.key}=${field.value}\``).join(', ')}.`] : ['5. No custom fields.']),
          ...(filters.length > 0 ? [`6. Filters, matching ${join === 'AND' ? 'all' : 'any'}:`, ...filters.map((f) => `   - ${f.field} — ${f.operator}${f.value !== undefined ? ` — \`${f.value}\`` : ''}`)] : ['6. No filter (everything is forwarded).']),
          '7. VALIDATE CONNECTION, then CREATE with Enable Configuration on.',
          '8. On the destination, search for an event from the last minute that matches the filter.',
          '',
          'The documented maximum is 10 forwarding rules.',
        ]),
      };
      if (kind === 'splunk') {
        files['splunk-inputs.conf'] = md([
          `# On the heavy forwarder: a TLS syslog input for VCF log management.`,
          '# The server certificate and its key passphrase are configured in Splunk’s own',
          '# server.conf / inputs.conf [SSL] stanza, never in this file.',
          `[tcp-ssl:${port}]`,
          'sourcetype = syslog',
          `index = ${index}`,
          'connection_host = dns',
        ]);
      }

      return {
        platform: LOGS,
        title: `Forward ${filters.length > 0 ? `events where ${filterText}` : 'all events'} to ${host || 'an external destination'} (${protocol}${protocol === 'Syslog' ? `/${transport}` : ''}${tls ? ' + TLS' : ''})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Applied once by apply.sh (it shows in the Log Forwarding card); from then every matching event is sent as it is ingested.', worstCase: 'at the ingestion rate of every matching source' },
        scope: {
          what: filters.length > 0 ? `Events where ${filterText}.` : 'Every event log management ingests.',
          decidedBy: ['Which sources send to log management at all (Log Collection and the adapters’ log settings).', 'Ingestion filters, which drop events before they can be forwarded.', `This rule’s filter rows, matched ${join === 'AND' ? 'all together' : 'any one'}.`],
          ifWrong: 'Too wide, and the destination’s licence and storage fill with appliance chatter; too narrow, and the SIEM misses the event it was bought to see. Either way, forwarded events cannot be recalled.',
        },
        guardrails: [
          { rule: 'apply.sh runs check-destination.sh first and applies nothing when it fails (closed port, or a certificate that does not verify or expires within 30 days)', because: 'A forwarding rule to a dead or untrusted endpoint queues and then drops, silently.' },
          { rule: 'apply.sh stops at the documented maximum of 10 forwarding rules, and leaves a rule with the same name alone', because: 'Running it twice must not make two rules sending every event twice.' },
          ...(filters.length > 0 ? [{ rule: `Only events where ${filterText} leave`, because: 'The platform applies the rule’s filter before sending, so unrelated data never reaches a third party.' }] : []),
        ],
        dryRun: ['Run ./check-destination.sh.', 'Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.'],
        undo: ['Log Forwarding → the rule → turn Enable Configuration off, or delete it. Events already sent stay at the destination.'],
        told: [`${host || 'The destination'} receives the events; nobody is told the rule exists. Record it with the destination owner.`],
        requires: [`${host}:${port} reachable from the log management instance${tls ? ', with a certificate chain it trusts' : ''}${ipv6 ? ' over IPv6' : ''}.`, 'Log management 9.1.', 'curl, jq and openssl on the machine that runs apply.sh.'],
        files,
        notes: [
          logsApplyNote(),
          'Two different things are called log forwarding in 9.1. This one (the Log Forwarding card) forwards the logs log management collects. PUT /suite-api/api/logs/forwarding forwards VCF Operations’ own service logs (ANALYTICS, COLLECTOR, SUITEAPI…) and is not this.',
          'VERIFY: the payload field names (workerCount, diskCacheSize, retryIntervalSeconds, tags, filters, sslCertificate) follow the VCF Operations for Logs 8.18 forwarding API; check the saved before-<time>/forwarding-before.json after the first run for the 9.1 names.',
          'IPv6: a literal IPv6 destination is accepted by the check and the rule; the platform must have an IPv6 path to it.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_partitions',
    platform: LOGS,
    label: 'A partition with its own retention and archive (9.1)',
    group: 'Log management 9.1',
    description:
      'A 9.1 log partition — a separate index with its own filter rows, retention period, archive location on NFS or S3 and the roles allowed to search it — for the events that must be kept longer than the rest. Enforces the 9.1 limit of 9 partitions besides Audit & Logs (apply.sh counts what is there and stops), refuses a retention shorter than the requirement unless an archive covers the gap, and checks the archive target before it creates anything.',
    inputs: [
      { id: 'partition_name', label: 'Partition', control: 'text', default: 'security-audit' },
      {
        id: 'filter_join',
        label: 'Events matching',
        control: 'select',
        options: [
          { value: 'ANY', label: 'Any filter row (OR)' },
          { value: 'ALL', label: 'Every filter row (AND)' },
        ],
        default: 'ANY',
      },
      {
        id: 'filters',
        label: 'Filters',
        control: 'textarea',
        default: 'appname | Starts with | sshd\nappname | Starts with | sudo\nappname | Starts with | vpxd-svcs\nappname | Contains | nsx-audit',
        hint: 'field | operator | value',
        help: 'Operators: Contains, Does not contain, Starts with, Does not start with, Matches Regex, Exists, Does not exist.',
      },
      { id: 'retention_days', label: 'Keep searchable for (days)', control: 'number', default: 90, min: 1, max: 3650 },
      { id: 'required_days', label: 'Required retention (days)', control: 'number', default: 365, min: 1, max: 3650, hint: 'What policy or regulation requires' },
      { id: 'extra_partitions', label: 'Partitions besides Audit & Logs, including this one', control: 'number', default: 2, min: 1, max: 20, hint: '9.1 allows at most 9. apply.sh also counts what already exists' },
      { id: 'roles', label: 'Roles that may search it', control: 'text', default: 'Security Auditor, Administrator', hint: 'Comma separated. Empty leaves access to the defaults' },
      {
        id: 'archive',
        label: 'Archive to',
        control: 'select',
        options: [
          { value: 's3', label: 'S3-compatible object storage (preferred)' },
          { value: 'nfs', label: 'NFS v3 export' },
          { value: 'none', label: 'No archive' },
        ],
        default: 's3',
      },
      { id: 's3_endpoint', label: 'S3 endpoint', control: 'text', default: 'https://s3.example.com', showWhen: { input: 'archive', equals: ['s3'] } },
      { id: 's3_bucket', label: 'Bucket', control: 'text', default: 'vcf-log-archive', showWhen: { input: 'archive', equals: ['s3'] } },
      { id: 's3_region', label: 'Region', control: 'text', default: 'us-east-1', showWhen: { input: 'archive', equals: ['s3'] } },
      { id: 'nfs_address', label: 'NFS address', control: 'text', default: 'nfs://nas01.example.com:/exports/vcf-log-archive', showWhen: { input: 'archive', equals: ['nfs'] } },
      { id: 'change_ticket', label: 'Change number', control: 'text', default: 'CHG0012345', hint: 'Shortening retention deletes events; this goes in the spec' },
    ],
    automation: (values                 , name        )             => {
      const partition = str(values, 'partition_name', 'partition');
      const join = str(values, 'filter_join', 'ANY') === 'ALL' ? 'AND' : 'OR';
      const { conditions: filters, bad } = conditionRows(str(values, 'filters', ''));
      const retention = num(values, 'retention_days', 90);
      const required = num(values, 'required_days', 365);
      const extra = num(values, 'extra_partitions', 2);
      const roles = listOf(str(values, 'roles', ''));
      const archive = str(values, 'archive', 's3');
      const endpoint = str(values, 's3_endpoint', '');
      const bucket = str(values, 's3_bucket', '');
      const region = str(values, 's3_region', '');
      const nfs = str(values, 'nfs_address', '');
      const ticket = str(values, 'change_ticket', '');
      const base = slugOf(name || partition, 'log-partition');
      const filterText = describeAll(filters, join);

      const findings            = [];
      if (filters.length === 0) findings.push(error('vcflog91.part.no-filter', 'A partition needs at least one filter row to decide which events go into it.', { source: SRC }));
      for (const row of bad) findings.push(error('vcflog91.part.bad-filter', `Filter row "${row}" has an operator 9.1 does not offer, or no value.`, { source: SRC }));
      if (extra > 9) {
        findings.push(
          error('vcflog91.part.too-many', `${extra} partitions besides Audit & Logs: 9.1 allows at most 9.`, {
            remediation: 'Merge partitions that share a retention: a partition is for a different retention or a different audience, not for a different source.',
            source: SRC,
          }),
        );
      }
      if (/^(audit\s*&?\s*logs|logs|audit)$/i.test(partition)) {
        findings.push(error('vcflog91.part.reserved', `"${partition}" is the name of the default partition.`, { source: SRC }));
      }
      if (retention < required && archive === 'none') {
        findings.push(
          error('vcflog91.part.short', `Searchable for ${retention} days, required for ${required}, and nothing archived: the last ${required - retention} days of the requirement are simply not kept.`, {
            remediation: 'Archive the partition, or raise the retention — and check the size profile can hold it.',
            source: SRC,
          }),
        );
      }
      if (!ticket) {
        findings.push(error('vcflog91.part.no-change', 'No change number. Retention decides when events are deleted; it goes through change.', { source: SRC }));
      }
      if (archive === 's3' && /^http:\/\//i.test(endpoint)) {
        findings.push(error('vcflog91.part.s3-http', 'The S3 endpoint is plain HTTP. 9.1 requires a certificate issued by a trusted CA for S3.', { source: SRC }));
      }
      if (retention > 90) {
        findings.push(
          info('vcflog91.part.cap', `${retention} days searchable: retention has an upper limit set by the size profile and the number of partitions.`, {
            remediation: 'The design guide gives, for example, a medium profile with 8 partitions an upper limit of about 100 days. The partition form shows the limit for yours.',
            source: SRC,
          }),
        );
      }

      const storageName = `${partition}-archive`;
      const spec = {
        name: partition,
        enabled: true,
        filterOperator: join,
        filters,
        retentionPeriod: retention,
        requiredRetentionDays: required,
        archiveEnabled: archive !== 'none',
        ...(archive !== 'none' ? { archiveLocation: storageName } : {}),
        ...(roles.length > 0 ? { roles } : {}),
        change: ticket,
      };
      const storage =
        archive === 's3'
          ? { type: 'S3', name: storageName, endpoint, bucketName: bucket, region, serverSideEncryption: 'AES256', pathStyleAccess: true, accessKey: '<from S3_ACCESS_KEY_ID when apply.sh runs>', secretKey: '<from S3_SECRET_KEY_FILE when apply.sh runs>' }
          : archive === 'nfs'
            ? { type: 'NFS', name: storageName, hostAddress: nfs }
            : undefined;

      const nfsHost = nfs.replace(/^nfs:\/\//, '').replace(/^\[([^\]]+)\].*$/, '$1').split(/:\//)[0] .replace(/:$/, '');
      const s3Host = endpoint.replace(/^https?:\/\//, '').split('/')[0] ?? '';
      const check = storage
        ? [
            '#!/usr/bin/env bash',
            `# Is the ${archive.toUpperCase()} archive target for "${partition}" reachable?`,
            '#',
            '# Reads only. Run it from the management network; apply.sh runs it before',
            '# it creates anything. Exits 1 when the target cannot be reached.',
            'set -euo pipefail',
            'PROBLEMS=()',
            ...(archive === 's3'
              ? [
                  `S3_HOST="${s3Host}"`,
                  `BUCKET="${bucket}"`,
                  'command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 2; }',
                  '# An IPv6 endpoint is written bracketed, https://[2001:db8::10]/, as in any URL.',
                  'CONNECT="$S3_HOST"',
                  '[[ "$CONNECT" =~ :[0-9]+$ ]] || CONNECT="$CONNECT:443"',
                  'if ! openssl s_client -connect "$CONNECT" ${CA_FILE:+-CAfile "$CA_FILE"} -verify_return_error </dev/null >/dev/null 2>&1; then',
                  '  PROBLEMS+=("TLS to $S3_HOST does not verify with a trusted CA — 9.1 requires one for S3")',
                  'fi',
                  '# Optional: list the bucket with credentials from your own AWS profile.',
                  'if command -v aws >/dev/null && [[ -n "${AWS_PROFILE:-}" ]]; then',
                  `  aws s3 ls "s3://\${BUCKET}/" --endpoint-url "${endpoint}" >/dev/null || PROBLEMS+=("cannot list s3://$BUCKET with profile $AWS_PROFILE")`,
                  'fi',
                ]
              : [
                  `NFS_HOST="${nfsHost}"`,
                  'command -v showmount >/dev/null || { echo "showmount (nfs-utils) is required" >&2; exit 2; }',
                  'showmount -e "$NFS_HOST" || PROBLEMS+=("$NFS_HOST does not answer showmount — is NFSv3 exported?")',
                  'echo "The export must be owned by root and writable as the External Storage page documents."',
                ]),
            'if (( ${#PROBLEMS[@]} )); then printf "PROBLEM: %s\\n" "${PROBLEMS[@]}" >&2; exit 1; fi',
            'echo "Archive target reachable."',
            '',
          ].join('\n')
        : undefined;

      const countCheck = [
        '# 9.1 allows Audit & Logs plus at most 9 more.',
        'N=$(jq \'[.. | objects | select(has("retentionPeriod") or has("retentionDays"))] | length\' "$LIST")',
        `if has_named "$LIST" ${sq(partition)}; then :; elif (( N >= 10 )); then echo "$N partitions exist, Audit & Logs included: 9.1 allows 9 besides it. Nothing created." >&2; exit 1; fi`,
      ];

      const apply = logsApplyScript({
        purpose: `Create the log partition "${partition}"${storage ? ` and its ${archive.toUpperCase()} archive location` : ''} in VCF Operations 9.1 log management, enabled.`,
        first: [
          ...(storage ? ['(( DRY_RUN )) || bash "$HERE/check-archive.sh" || { echo "check-archive.sh failed: nothing applied." >&2; exit 1; }'] : []),
          ...(archive === 's3'
            ? [
                'STORAGE="$HERE/external-storage.json"',
                'if (( ! DRY_RUN )); then',
                '  : "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID to the access key limited to this bucket}"',
                '  : "${S3_SECRET_KEY_FILE:?set S3_SECRET_KEY_FILE to a file holding its secret key, mode 600}"',
                '  STORAGE="$PRIVATE/external-storage.json"',
                '  jq --arg a "$S3_ACCESS_KEY_ID" --rawfile s "$S3_SECRET_KEY_FILE" \'.accessKey = $a | .secretKey = ($s | rtrimstr("\\n"))\' "$HERE/external-storage.json" > "$STORAGE"',
                'fi',
              ]
            : archive === 'nfs'
              ? ['STORAGE="$HERE/external-storage.json"']
              : []),
          '',
        ],
        calls: [
          ...(storage ? [{ what: `archive location ${storageName}`, key: 'archive', path: '/api/v1/archiving', payload: '$STORAGE', name: storageName }] : []),
          { what: `partition ${partition}`, key: 'partitions', path: '/api/v2/partitions', payload: 'partition.json', name: partition, check: countCheck },
        ],
        undo: `raise the retention back, or delete the partition "${partition}"; events already aged out come back only from the archive.`,
        manual: `${base}-APPLY.md`,
      });

      return {
        platform: LOGS,
        title: `Partition "${partition}" — ${retention} days searchable${storage ? `, archived to ${archive.toUpperCase()}` : ', not archived'}`,
        effect: 'irreversible',
        trigger: { kind: 'schedule', detail: `Created once by apply.sh; from then log management deletes events in "${partition}" older than ${retention} days, continuously.`, worstCase: 'every day, on every event past its retention' },
        scope: {
          what: `Events where ${filterText}, stored in their own partition${roles.length > 0 ? `, searchable by ${roles.join(', ')}` : ''}.`,
          decidedBy: [`The partition’s filter rows, matched ${join === 'AND' ? 'all together' : 'any one'}.`, 'Ingestion filters, which drop events before any partition sees them.', 'The retention on this partition, independent of the others.', ...(roles.length > 0 ? ['The roles given access, for who can search it.'] : [])],
          ifWrong: 'A filter too wide pulls ordinary events into a long-retention partition and fills it; a retention too short deletes evidence that was required. Deleted events come back only from the archive.',
        },
        guardrails: [
          { rule: 'At most 9 partitions besides Audit & Logs: the generator refuses more, and apply.sh counts the partitions that exist and creates nothing at the limit', because: 'The platform refuses the tenth anyway, after the archive location has already been created for it.' },
          { rule: 'The generator refuses a retention below the required retention unless an archive is configured', because: 'The requirement is usually discovered in an audit, after the events have gone.' },
          { rule: `A change number is required (${ticket || 'none given'}); the generator refuses without one`, because: 'Retention is a delete schedule. Lowering it later deletes history at once.' },
          ...(storage ? [{ rule: 'apply.sh runs check-archive.sh first and applies nothing when the archive target cannot be reached or its certificate does not verify', because: 'An archive that fails to write is found when somebody needs to restore from it.' }] : []),
        ],
        dryRun: ['Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.', ...(storage ? ['Run ./check-archive.sh.'] : []), 'In Explore Logs, run the partition’s filter over the last day and count what it matches.'],
        undo: ['Raise the retention back. Events already aged out are gone unless they were archived.', ...(storage ? ['Archived events can be brought back with "Import archived logs into a partition (9.1)".'] : [])],
        told: ['Nobody when events age out — that is the design. Put the retention in the records-retention register.'],
        requires: [
          'Log management 9.1.',
          ...(archive === 's3' ? ['An S3 bucket with an access key limited to it: S3_ACCESS_KEY_ID and S3_SECRET_KEY_FILE (mode 600) in the environment of apply.sh — never in these files.'] : []),
          ...(archive === 'nfs' ? ['An NFSv3 export reachable from the VCF management network, owned by root.'] : []),
          ...(roles.length > 0 ? [`The roles ${roles.join(', ')} to exist in VCF Operations.`] : []),
        ],
        files: {
          'partition.json': json(spec),
          ...(storage ? { 'external-storage.json': json(storage), 'check-archive.sh': check  } : {}),
          'apply.sh': apply,
          [`${base}-APPLY.md`]: md([
            `# Partition "${partition}" by hand (only when apply.sh stops with exit 3)`,
            '',
            ...(storage
              ? [
                  `1. ${CONFIGURATIONS} → **External Storage** card → add the ${archive.toUpperCase()} location from external-storage.json; enter the keys in the form. **Validate**, **SAVE**, then **APPLY** (restarts the service). Up to 5 locations.`,
                ]
              : ['1. No archive.']),
            `2. Create the partition \`${partition}\` with the filter rows in partition.json (match ${join === 'AND' ? 'all' : 'any'}), retention ${retention} days, and the archive location.`,
            ...(roles.length > 0 ? [`3. Give ${roles.join(', ')} access to it (see "Control who can search which logs (9.1)").`] : ['3. No role changes.']),
            '4. Check the retention the form accepts: it is capped by the size profile and the number of partitions.',
            '',
            'Archives reach external storage within at most 24 hours, so an archive does not cover the most recent day.',
          ]),
        },
        notes: [
          logsApplyNote(),
          'In 9.1 a partition is a distinct index. The default is "Audit & Logs"; up to 9 more can be added, each with its own retention and archive location.',
          'Archive storage in 9.1 is NFSv3 or S3-compatible. S3 is the documented preference, and it must present a certificate from a trusted CA.',
          'VERIFY: the partition and archive payload field names follow VCF Operations for Logs 8.18; compare with before-<time>/partitions-before.json after the first run.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_agents',
    platform: LOGS,
    label: 'Agent configuration by OS and role: parsers, tags, filters, TLS (9.1)',
    group: 'Log management 9.1',
    description:
      'Central agent configuration for a group of servers — the log management agent on Linux and Windows, Fluent Bit on Kubernetes — with a parser per file (auto, CLF, CSV, JSON, KVP, syslog or your own regex), tags per source, event whitelist and blacklist, the protocol (CFAPI or syslog), TLS and reconnect. apply.sh creates the agent group through the log management API, or on Kubernetes applies the Fluent Bit ConfigMap and restarts the DaemonSet; a check on a server fails when its agent is not running or cannot reach its target.',
    inputs: [
      { id: 'group_name', label: 'Agent group', control: 'text', default: 'Linux — web tier' },
      {
        id: 'os',
        label: 'Platform',
        control: 'select',
        options: [
          { value: 'linux', label: 'Linux (log management agent)' },
          { value: 'windows', label: 'Windows (log management agent)' },
          { value: 'kubernetes', label: 'Kubernetes (Fluent Bit)' },
        ],
        default: 'linux',
      },
      { id: 'role', label: 'Role tag', control: 'text', default: 'web' },
      { id: 'hostname_filter', label: 'Servers named', control: 'text', default: 'web-*', hint: 'The group’s membership filter', showWhen: { input: 'os', notEquals: ['kubernetes'] } },
      {
        id: 'send_via',
        label: 'Send to',
        control: 'select',
        options: [
          { value: 'proxy', label: 'The local cloud proxy (aggregates, then forwards)' },
          { value: 'direct', label: 'The log management instance directly' },
        ],
        default: 'proxy',
      },
      { id: 'target', label: 'Target FQDN or address', control: 'text', default: 'cloudproxy-dc1.example.com', hint: 'FQDN, IPv4 or IPv6' },
      {
        id: 'protocol',
        label: 'Protocol',
        control: 'select',
        options: [
          { value: 'cfapi', label: 'CFAPI (the agent’s own protocol, keeps fields and tags)' },
          { value: 'syslog', label: 'Syslog' },
        ],
        default: 'cfapi',
        showWhen: { input: 'os', notEquals: ['kubernetes'] },
      },
      { id: 'port', label: 'Port', control: 'number', default: 9543, min: 1, max: 65535, hint: 'CFAPI 9543 with TLS / 9000 without; syslog 6514 with TLS / 514 without. VERIFY on 9.1' },
      { id: 'ssl', label: 'TLS', control: 'toggle', default: true },
      { id: 'ca_path', label: 'CA bundle on the servers', control: 'text', default: '/etc/pki/tls/certs/ca-bundle.crt', hint: 'Path the agent reads to verify the target', showWhen: { input: 'ssl', equals: ['true'] } },
      { id: 'reconnect_minutes', label: 'Reconnect every (minutes)', control: 'number', default: 30, min: 1, max: 1440, hint: 'Spreads load across targets behind a balancer', showWhen: { input: 'os', notEquals: ['kubernetes'] } },
      { id: 'disk_buffer_mb', label: 'Disk buffer (MB)', control: 'number', default: 200, min: 50, max: 8000, hint: 'Events queued while the target is unreachable' },
      {
        id: 'files',
        label: 'Files',
        control: 'textarea',
        default:
          'nginx-access | /var/log/nginx | access*.log | clf | log=access\nnginx-error | /var/log/nginx | error*.log | auto | log=error\norders-app | /var/log/orders | *.log | orders-regex | app=orders',
        hint: 'name | directory | include | parser | tags',
        help: 'parser: auto, clf, csv, json, kvp, syslog, or the name of a custom parser below. tags: key=value, separated by semicolons.',
        showWhen: { input: 'os', equals: ['linux'] },
      },
      {
        id: 'channels',
        label: 'Event channels',
        control: 'textarea',
        default: 'application | Application | log=application\nsystem | System | log=system\nsecurity | Security | log=security',
        hint: 'name | channel | tags',
        help: 'Any Windows event log channel, e.g. Microsoft-Windows-PowerShell/Operational. tags: key=value, separated by semicolons.',
        showWhen: { input: 'os', equals: ['windows'] },
      },
      {
        id: 'event_filters',
        label: 'Event whitelist and blacklist',
        control: 'textarea',
        default: 'orders-app | whitelist | level == "ERROR" or level == "WARN"\nsecurity | blacklist | eventid == 4662',
        hint: 'source name | whitelist or blacklist | expression',
        help: 'An expression on the parsed fields. whitelist keeps only matching events; blacklist drops them. The source name is a row name from Files or Event channels.',
        showWhen: { input: 'os', notEquals: ['kubernetes'] },
      },
      {
        id: 'parsers',
        label: 'Custom parsers',
        control: 'textarea',
        default: 'orders-regex | regex | (?<timestamp>\\S+) (?<level>[A-Z]+) (?<message>.*)',
        hint: 'name | base parser | format',
        help: 'base parser: regex (format is a regex with named groups), clf (format is a CLF pattern), csv (format is the field names, comma separated), kvp (format is the field names to keep).',
        showWhen: { input: 'os', equals: ['linux', 'windows'] },
      },
      { id: 'k8s_namespaces', label: 'Namespaces', control: 'text', default: 'orders, payments', hint: 'Comma separated. Empty collects every namespace', showWhen: { input: 'os', equals: ['kubernetes'] } },
      { id: 'k8s_labels', label: 'Only pods labelled', control: 'text', default: 'tier=frontend', hint: 'key=value pairs, comma separated. Empty takes every pod', showWhen: { input: 'os', equals: ['kubernetes'] } },
      {
        id: 'k8s_output',
        label: 'Fluent Bit output',
        control: 'select',
        options: [
          { value: 'syslog_tls', label: 'Syslog RFC 5424 over TLS' },
          { value: 'syslog_tcp', label: 'Syslog RFC 5424 over TCP' },
          { value: 'http', label: 'HTTP JSON (VERIFY the ingestion path on 9.1)' },
        ],
        default: 'syslog_tls',
        showWhen: { input: 'os', equals: ['kubernetes'] },
      },
      { id: 'k8s_namespace_fb', label: 'Fluent Bit runs in namespace', control: 'text', default: 'logging', showWhen: { input: 'os', equals: ['kubernetes'] } },
    ],
    automation: (values                 , name        )             => {
      const group = str(values, 'group_name', 'Agents');
      const os = str(values, 'os', 'linux');
      const k8s = os === 'kubernetes';
      const role = str(values, 'role', 'app');
      const hostFilter = str(values, 'hostname_filter', '*');
      const via = str(values, 'send_via', 'proxy');
      const target = str(values, 'target', '');
      const protocol = str(values, 'protocol', 'cfapi');
      const port = num(values, 'port', 9543);
      const ssl = bool(values, 'ssl', true);
      const caPath = str(values, 'ca_path', '');
      const reconnect = num(values, 'reconnect_minutes', 30);
      const diskBuffer = num(values, 'disk_buffer_mb', 200);
      const fileRows = rowsOf(str(values, 'files', ''), 5).filter((row) => row[0]);
      const channelRows = rowsOf(str(values, 'channels', ''), 3).filter((row) => row[0]);
      const filterRows = rowsOf(str(values, 'event_filters', ''), 3).filter((row) => row[0]);
      const parserRows = rowsOf(str(values, 'parsers', ''), 3).filter((row) => row[0]);
      const namespaces = listOf(str(values, 'k8s_namespaces', ''));
      const labels = listOf(str(values, 'k8s_labels', ''))
        .map((pair) => pair.split('='))
        .filter((pair) => pair.length === 2 && pair[0] .trim() && pair[1] .trim())
        .map(([key, value]) => ({ key: key .trim(), value: value .trim() }));
      const output = str(values, 'k8s_output', 'syslog_tls');
      const fbNamespace = str(values, 'k8s_namespace_fb', 'logging');
      const base = slugOf(name || group, 'agent-group');
      const ipv6 = target.includes(':');

      const BUILT_IN = ['auto', 'clf', 'csv', 'json', 'kvp', 'syslog'];
      const custom = new Set(parserRows.map((row) => row[0] ));
      const sources = os === 'windows' ? channelRows.map((row) => row[0] ) : fileRows.map((row) => row[0] );
      const tagsOf = (text        )                         =>
        Object.fromEntries([
          ['role', role],
          ...text
            .split(';')
            .map((pair) => pair.split('='))
            .filter((pair) => pair.length === 2 && pair[0] .trim() && pair[1] .trim())
            .map(([key, value]) => [key .trim(), value .trim()]),
        ]);

      const findings            = [];
      if (!target) findings.push(error('vcflog91.agent.no-target', 'No target to send to.', { source: SRC }));
      if (!k8s && (hostFilter === '*' || hostFilter === '')) {
        findings.push(
          warning('vcflog91.agent.all', 'The group matches every agent, so this configuration lands on every server of every role.', {
            remediation: 'Name a pattern. The point of a group per OS and role is that a web server does not tail a database’s logs.',
            source: SRC,
          }),
        );
      }
      if (os === 'linux' && fileRows.length === 0) findings.push(error('vcflog91.agent.no-files', 'No file rows: the agents would send nothing.', { source: SRC }));
      if (os === 'windows' && channelRows.length === 0) findings.push(error('vcflog91.agent.no-channels', 'No event channel rows: the agents would send nothing.', { source: SRC }));
      if (os === 'linux') {
        for (const row of fileRows) {
          const parser = row[3] || 'auto';
          if (!BUILT_IN.includes(parser) && !custom.has(parser)) {
            findings.push(error('vcflog91.agent.parser', `File row "${row[0]}" uses parser "${parser}", which is neither built in (${BUILT_IN.join(', ')}) nor a custom parser row.`, { source: SRC }));
          }
          if (!row[1] .startsWith('/')) findings.push(error('vcflog91.agent.relative', `File row "${row[0]}": the directory must be an absolute path.`, { source: SRC }));
        }
      }
      for (const row of parserRows) {
        if (!['regex', 'clf', 'csv', 'kvp'].includes(row[1] )) findings.push(error('vcflog91.agent.base-parser', `Custom parser "${row[0]}": base parser "${row[1]}" is not regex, clf, csv or kvp.`, { source: SRC }));
        else if (row[1] === 'regex' && !/\(\?<[A-Za-z_]/.test(row[2] )) findings.push(error('vcflog91.agent.regex-groups', `Custom parser "${row[0]}": a regex parser needs named groups, (?<field>…), or it extracts nothing.`, { source: SRC }));
      }
      if (!k8s) {
        for (const row of filterRows) {
          if (!sources.includes(row[0] )) findings.push(warning('vcflog91.agent.filter-source', `Filter row for "${row[0]}": no ${os === 'windows' ? 'channel' : 'file'} row has that name, so it is left out.`, { source: SRC }));
          if (row[1] !== 'whitelist' && row[1] !== 'blacklist') findings.push(error('vcflog91.agent.filter-kind', `Filter row for "${row[0]}": "${row[1]}" is not whitelist or blacklist.`, { source: SRC }));
        }
        if (!ssl) {
          findings.push(warning('vcflog91.agent.no-tls', 'TLS is off: every event, including authentication logs, crosses the network in clear.', { remediation: 'Turn TLS on; it costs the agent almost nothing.', source: SRC }));
        }
        if (protocol === 'cfapi' && (port === 514 || port === 6514)) findings.push(warning('vcflog91.agent.port', `Port ${port} is a syslog port; CFAPI listens on 9543 (TLS) or 9000.`, { source: SRC }));
        if (protocol === 'syslog' && (port === 9543 || port === 9000)) findings.push(warning('vcflog91.agent.port', `Port ${port} is a CFAPI port; syslog listens on 6514 (TLS) or 514.`, { source: SRC }));
        if (protocol === 'syslog') findings.push(info('vcflog91.agent.syslog', 'Over syslog the agent’s tags and extracted fields are not carried as fields. CFAPI keeps them.', { source: SRC }));
      }
      if (via === 'direct') {
        findings.push(info('vcflog91.agent.direct', 'Direct to log management skips the cloud proxy that would aggregate and buffer. Fine for a few servers; use the proxy for many.', { source: SRC }));
      }

      // --- the agent's configuration ---
      const filtersFor = (source        )           => filterRows.filter((row) => row[0] === source).map((row) => `${row[1]}=${row[2]}`);
      const server = [
        '[server]',
        `hostname=${target}`,
        `proto=${protocol}`,
        `port=${port}`,
        `ssl=${ssl ? 'yes' : 'no'}`,
        ...(ssl ? ['ssl_accept_any=no', ...(caPath ? [`ssl_ca_path=${caPath}`] : [])] : []),
        `reconnect=${reconnect}`,
        '',
        '[storage]',
        `max_disk_buffer=${diskBuffer}`,
        '',
      ];
      const parsers = parserRows.flatMap((row) => [
        `[parser|${row[0]}]`,
        `base_parser=${row[1]}`,
        row[1] === 'csv' || row[1] === 'kvp' ? `fields=${row[2]}` : `format=${row[2]}`,
        '',
      ]);
      const ini =
        os === 'windows'
          ? [
              '; Central configuration for the agent group — merged with each server’s own liagent.ini.',
              ...server,
              ...parsers,
              ...channelRows.flatMap((row) => [`[winlog|${slugOf(row[0] , 'channel')}]`, `channel=${row[1]}`, `tags=${JSON.stringify(tagsOf(row[2] ))}`, ...filtersFor(row[0] ), '']),
            ]
          : [
              '# Central configuration for the agent group — merged with each server’s own liagent.ini.',
              ...server,
              ...parsers,
              ...fileRows.flatMap((row) => [`[filelog|${slugOf(row[0] , 'file')}]`, `directory=${row[1]}`, `include=${row[2]}`, `parser=${row[3] || 'auto'}`, `tags=${JSON.stringify(tagsOf(row[4] ))}`, ...filtersFor(row[0] ), '']),
            ];

      const k8sPort = output === 'http' ? 443 : port === 9543 || port === 9000 ? (output === 'syslog_tls' ? 6514 : 514) : port;
      const k8sTls = output !== 'syslog_tcp';
      const nsRegex = namespaces.length > 0 ? `^(${namespaces.join('|')})$` : '';
      const fluent = [
        '[SERVICE]',
        '    Flush              5',
        '    Log_Level          info',
        '    storage.path       /var/fluent-bit/state/',
        `    storage.backlog.mem_limit ${Math.max(5, Math.round(diskBuffer / 10))}M`,
        '',
        '[INPUT]',
        '    Name              tail',
        `    Path              ${namespaces.length > 0 ? namespaces.map((ns) => `/var/log/containers/*_${ns}_*.log`).join(',') : '/var/log/containers/*.log'}`,
        '    multiline.parser  docker, cri',
        '    Tag               kube.*',
        '    Mem_Buf_Limit     50MB',
        '    storage.type      filesystem',
        '    DB                /var/fluent-bit/state/tail.db',
        '',
        '[FILTER]',
        '    Name       kubernetes',
        '    Match      kube.*',
        '    Merge_Log  On',
        '    Labels     On',
        '',
        ...(nsRegex ? ['[FILTER]', '    Name   grep', '    Match  kube.*', `    Regex  $kubernetes['namespace_name'] ${nsRegex}`, ''] : []),
        ...labels.flatMap((label) => ['[FILTER]', '    Name   grep', '    Match  kube.*', `    Regex  $kubernetes['labels']['${label.key}'] ^${label.value}$`, '']),
        '[FILTER]',
        '    Name    record_modifier',
        '    Match   *',
        `    Record  role ${role}`,
        `    Record  agent_group ${slugOf(group, 'group')}`,
        '',
        '[OUTPUT]',
        ...(output === 'http'
          ? ['    Name                http', '    Match               *', `    Host                ${target}`, `    Port                ${k8sPort}`, '    URI                 /api/v1/events/ingest/fluent-bit', '    Format              json', '    tls                 On', '    tls.verify          On']
          : [
              '    Name                syslog',
              '    Match               *',
              `    Host                ${target}`,
              `    Port                ${k8sPort}`,
              `    Mode                ${k8sTls ? 'tls' : 'tcp'}`,
              ...(k8sTls ? ['    tls                 On', '    tls.verify          On'] : []),
              '    Syslog_Format       rfc5424',
              '    Syslog_Message_Key  log',
              "    Syslog_Hostname_Key $kubernetes['host']",
              "    Syslog_Appname_Key  $kubernetes['container_name']",
            ]),
        `    Retry_Limit         ${Math.max(1, Math.round((reconnect * 60) / 30))}`,
        '    storage.total_limit_size ' + `${diskBuffer}M`,
        '',
      ];
      const configMap = [
        'apiVersion: v1',
        'kind: ConfigMap',
        'metadata:',
        '  name: fluent-bit-config',
        `  namespace: ${fbNamespace}`,
        '  labels:',
        `    agent-group: ${slugOf(group, 'group')}`,
        'data:',
        '  fluent-bit.conf: |',
        ...fluent.map((line) => (line ? `    ${line}` : '')),
        '',
      ];

      const checkLinux = [
        '#!/usr/bin/env bash',
        '# Run on a server in the group: is the agent running, and can it reach its target?',
        '# Reads only. Exits 1 when either is not true.',
        'set -euo pipefail',
        `TARGET="\${TARGET:-${target}}"`,
        `PORT="\${PORT:-${port}}"`,
        'PROBLEMS=()',
        'systemctl is-active --quiet liagentd || PROBLEMS+=("liagentd is not running")',
        'timeout 5 bash -c "exec 3<>/dev/tcp/$TARGET/$PORT" 2>/dev/null || PROBLEMS+=("cannot reach $TARGET:$PORT")',
        ...fileRows.map((row) => `ls ${row[1]}/${row[2]} >/dev/null 2>&1 || PROBLEMS+=("no files match ${row[1]}/${row[2]} (${row[0]}) — nothing to send")`),
        'if (( ${#PROBLEMS[@]} )); then printf "PROBLEM: %s\\n" "${PROBLEMS[@]}" >&2; exit 1; fi',
        'echo "Agent running and target reachable."',
        '',
      ].join('\n');
      const checkWindows = [
        '<#',
        '.SYNOPSIS',
        '    Run on a server in the group: is the agent running, and can it reach its target?',
        '.DESCRIPTION',
        '    Reads only. Exits 1 when either is not true.',
        '#>',
        `param([string]$Target = '${target}', [int]$Port = ${port})`,
        "$ErrorActionPreference = 'Stop'",
        '$problems = @()',
        "$svc = Get-Service -Name 'LogInsightAgentService' -ErrorAction SilentlyContinue",
        "if (-not $svc -or $svc.Status -ne 'Running') { $problems += 'the log management agent service is not running (VERIFY the service name on your build)' }",
        'if (-not (Test-NetConnection -ComputerName $Target -Port $Port -InformationLevel Quiet)) { $problems += "cannot reach ${Target}:$Port" }',
        'if ($problems.Count -gt 0) { $problems | ForEach-Object { Write-Error "PROBLEM: $_" -ErrorAction Continue }; exit 1 }',
        "Write-Output 'Agent running and target reachable.'",
        '',
      ].join('\n');

      const spec = {
        name: group,
        description: `${os} agents, role ${role}`,
        criteria: { os, hostname: hostFilter },
        tags: { role, os },
        sendTo: { via, target, port, protocol, ssl },
        agentConfig: md(ini),
      };

      const k8sApply = [
        '#!/usr/bin/env bash',
        `# Apply the Fluent Bit configuration for "${group}" to the cluster in KUBECONFIG, then`,
        '# restart the DaemonSet so every node reads it. --dry-run validates against the',
        '# API server and changes nothing.',
        'set -euo pipefail',
        'command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        `NS=${sq(fbNamespace)}`,
        'DS="${FLUENT_BIT_DAEMONSET:-fluent-bit}"',
        'if [[ "${1:-}" == "--dry-run" ]]; then',
        '  kubectl apply --dry-run=server -f "$HERE/fluent-bit-configmap.yaml"',
        '  echo "Dry run: nothing was changed."',
        '  exit 0',
        'fi',
        'kubectl -n "$NS" get daemonset "$DS" >/dev/null || { echo "No DaemonSet $DS in $NS: deploy Fluent Bit first (set FLUENT_BIT_DAEMONSET if it has another name)." >&2; exit 2; }',
        'kubectl -n "$NS" get configmap fluent-bit-config -o yaml > "$HERE/fluent-bit-config-before.yaml" 2>/dev/null || echo "No ConfigMap before this one."',
        'kubectl apply -f "$HERE/fluent-bit-configmap.yaml"',
        'kubectl -n "$NS" rollout restart daemonset "$DS"',
        'kubectl -n "$NS" rollout status daemonset "$DS" --timeout=300s',
        'echo "Applied. Undo: kubectl apply -f fluent-bit-config-before.yaml, then restart the DaemonSet."',
        '',
      ].join('\n');

      return {
        platform: LOGS,
        title: `Agent group "${group}" — ${k8s ? 'Fluent Bit' : `${os} agents named ${hostFilter}, ${os === 'windows' ? channelRows.length : fileRows.length} source(s), ${protocol}${ssl ? ' + TLS' : ''}`}, role ${role}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: k8s ? 'Applied by apply.sh as the Fluent Bit ConfigMap; the DaemonSet is restarted so every node reads it.' : 'Created by apply.sh as the group’s central configuration; each matching agent picks it up at its next check-in.', worstCase: 'on every matching agent at once' },
        scope: {
          what: k8s ? `Container logs in ${namespaces.length > 0 ? namespaces.join(', ') : 'every namespace'}${labels.length > 0 ? ` from pods labelled ${labels.map((l) => `${l.key}=${l.value}`).join(', ')}` : ''}.` : `Agents on ${os} servers whose hostname matches ${hostFilter}.`,
          decidedBy: k8s ? ['The namespaces in the tail path and the namespace filter.', 'The label filters.', 'Which nodes run the Fluent Bit DaemonSet.'] : ['The group’s filter on OS and hostname.', 'Which servers have the agent installed and pointed at this target.', 'The whitelist and blacklist rows, per source.'],
          ifWrong: 'The wrong servers start sending files nobody asked for — or the right ones stop sending, because a central section replaced a local one, or a whitelist was too narrow. Either shows as a gap in the logs, not an error.',
        },
        guardrails: [
          { rule: k8s ? 'Fluent Bit verifies the target’s TLS certificate (tls.verify On)' : 'Central configuration applies only to agents that match the group filter', because: k8s ? 'A collector that accepts any certificate will send logs to whoever answers.' : 'A configuration meant for web servers does not reach the database tier.' },
          ...(k8s ? [{ rule: 'apply.sh keeps the ConfigMap as it was before and waits for the rollout to finish', because: 'A DaemonSet that does not come back is found at once, with the previous configuration in hand.' }] : [{ rule: 'apply.sh leaves a group with the same name alone and keeps the list of groups as it was', because: 'Running it twice must not make two groups fighting over the same agents.' }]),
          ...(k8s ? [] : [{ rule: `${os === 'windows' ? 'Check-Agent.ps1' : 'check-agent.sh'} exits 1 when the agent is stopped or cannot reach ${target}`, because: 'A server that stopped sending looks exactly like a quiet server.' }]),
        ],
        dryRun: [k8s ? 'Run ./apply.sh --dry-run: kubectl validates the ConfigMap against the API server and changes nothing.' : 'Run ./apply.sh --dry-run: it prints what it would send and signs in to nothing.', ...(k8s ? [] : [`Apply to one server first: put the group filter on a single hostname, run the check there, then widen it to ${hostFilter}.`])],
        undo: [k8s ? 'kubectl apply -f fluent-bit-config-before.yaml and restart the DaemonSet.' : 'Delete the agent group. Agents drop the central configuration at their next check-in and fall back to their local liagent.ini.'],
        told: ['Nobody. Agent health is on the agents page; the checks here are what make a silent agent noisy.'],
        requires: [
          k8s ? `Fluent Bit deployed as a DaemonSet in ${fbNamespace} with read access to /var/log/containers, and kubectl with KUBECONFIG for the cluster.` : 'The log management agent installed on each server (RHEL 9/10, SLES 15 SP7/16, Ubuntu 22.04/24.04/26.04, Debian 12/13, Photon 4+, or Windows).',
          `${target}:${k8s ? k8sPort : port} reachable from the ${k8s ? 'nodes' : 'servers'}${ipv6 ? ' over IPv6' : ''}.`,
        ],
        files: k8s
          ? { 'fluent-bit-configmap.yaml': md(configMap), 'fluent-bit.conf': md(fluent), 'apply.sh': k8sApply }
          : {
              'liagent.ini': md(ini),
              'agent-group.json': json(spec),
              ...(os === 'windows' ? { 'Check-Agent.ps1': checkWindows } : { 'check-agent.sh': checkLinux }),
              'apply.sh': logsApplyScript({
                purpose: `Create the agent group "${group}" with its central configuration in VCF Operations 9.1 log management.`,
                calls: [{ what: `agent group ${group}`, key: 'agent groups', path: '/api/v1/agent/groups', payload: 'agent-group.json', name: group }],
                undo: 'delete the agent group; agents fall back to their local liagent.ini at the next check-in.',
                manual: `${base}-APPLY.md`,
              }),
              [`${base}-APPLY.md`]: md([
                `# Agent group "${group}" by hand (only when apply.sh stops with exit 3)`,
                '',
                `1. VCF Operations → ${CONFIGURATIONS} → Log Collection → agents → agent groups (VERIFY the card name on 9.1).`,
                `2. New group \`${group}\`, filter: OS ${os}, hostname matches \`${hostFilter}\`.`,
                '3. Paste liagent.ini into the group’s configuration and save.',
                `4. Run ${os === 'windows' ? 'Check-Agent.ps1' : 'check-agent.sh'} on one member, then search Explore Logs for \`role = ${role}\`.`,
              ]),
            },
        notes: [
          ...(k8s ? [] : [logsApplyNote()]),
          '9.1 standardises collection: the log management agent for servers, Fluent Bit for Kubernetes. Appliance and VCF component collection (ESX, vCenter, NSX, VCF Operations, Identity Broker, VCF Automation, and in 9.1.1 SDDC Manager) is configured by the platform — see "Log sources: which VCF components send, at what level (9.1)".',
          'Central configuration merges with each server’s local liagent.ini; a key set in both takes the central value.',
          'VERIFY: the liagent.ini whitelist/blacklist expression syntax and the [parser|name] keys follow the 8.18 agent documentation.',
          ...(k8s ? ['9.1 configures VKS clusters it manages itself; this is for clusters it does not.', ...(output === 'http' ? ['VERIFY: the HTTP ingestion URI on 9.1 log management; the syslog outputs are the documented route.'] : [])] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_alert_query',
    platform: LOGS,
    label: 'A saved log query, an extracted field and the alert on it, applied end to end (9.1)',
    group: 'Log management 9.1',
    description:
      'A log alert as 9.1 builds it, applied end to end: a saved query with several filters (AND), an aggregation (count, or unique count of a field) and group-by, created through /suite-api/api/logs/queryconfigs; a dynamic field extracted from the matching lines; a log-based symptom and alert definition that select the saved query; the alert enabled in a named policy (export, merge, import); and a notification rule to an outbound plugin instance. With a local test that the extraction pulls the value out of a real line.',
    inputs: [
      { id: 'query_name', label: 'Saved query', control: 'text', default: 'Orders API — payment gateway timeouts' },
      { id: 'query_text', label: 'Search text', control: 'text', default: 'payment gateway timeout' },
      {
        id: 'filters',
        label: 'Filters (all must match)',
        control: 'textarea',
        default: 'appname | Contains | orders-api\ntext | Contains | ERROR',
        hint: 'field | operator | value',
        help: 'Operators: Contains, Does not contain, Starts with, Does not start with, Matches Regex, Exists, Does not exist.',
      },
      { id: 'partition', label: 'Partition', control: 'text', default: '', hint: 'Empty searches the default. VERIFY: name or id' },
      {
        id: 'aggregation',
        label: 'Count',
        control: 'select',
        options: [
          { value: 'COUNT', label: 'Events' },
          { value: 'UNIQUE_COUNT', label: 'Unique values of a field' },
        ],
        default: 'COUNT',
      },
      { id: 'agg_field', label: 'Unique values of', control: 'text', default: 'order_id', showWhen: { input: 'aggregation', equals: ['UNIQUE_COUNT'] } },
      { id: 'group_by', label: 'Group by fields', control: 'text', default: 'hostname', hint: 'Comma separated. Empty counts across everything that matches' },
      { id: 'field_name', label: 'Extract field', control: 'text', default: 'gateway_latency_ms' },
      { id: 'pre_context', label: 'Text before the value', control: 'text', default: 'latency=' },
      { id: 'value_regex', label: 'The value', control: 'text', default: '\\d+' },
      { id: 'post_context', label: 'Text after the value', control: 'text', default: 'ms' },
      { id: 'sample_line', label: 'A real line to test against', control: 'text', default: '2026-05-01T10:00:00Z app01 orders-api: ERROR payment gateway timeout latency=30012ms order=A-1001' },
      {
        id: 'object_kind',
        label: 'Alert on',
        control: 'select',
        options: [
          { value: 'HostSystem', label: 'ESX host' },
          { value: 'VirtualMachine', label: 'Virtual machine' },
          { value: 'ClusterComputeResource', label: 'Cluster' },
          { value: 'VMwareAdapter Instance', label: 'vCenter' },
        ],
        default: 'VirtualMachine',
      },
      { id: 'threshold', label: 'More than', control: 'number', default: 10, min: 1, max: 100000 },
      { id: 'window_minutes', label: 'In (minutes)', control: 'number', default: 15, min: 1, max: 1440 },
      { id: 'severity', label: 'Severity', control: 'select', options: [{ value: 'CRITICAL', label: 'Critical' }, { value: 'IMMEDIATE', label: 'Immediate' }, { value: 'WARNING', label: 'Warning' }, { value: 'INFORMATION', label: 'Information' }], default: 'WARNING' },
      {
        id: 'impact',
        label: 'Impact badge',
        control: 'select',
        options: [
          { value: 'HEALTH', label: 'Health' },
          { value: 'RISK', label: 'Risk' },
          { value: 'EFFICIENCY', label: 'Efficiency' },
        ],
        default: 'HEALTH',
      },
      { id: 'recommendation', label: 'Recommendation', control: 'text', default: 'Check the payment gateway status page and the orders-api connection pool.' },
      { id: 'policy_name', label: 'Enable in policy', control: 'text', default: 'Tier 1 production', hint: 'Its id is looked up by name when apply.sh runs. Empty leaves the alert in no policy' },
      { id: 'notify_plugin', label: 'Notify through outbound plugin instance', control: 'text', default: 'Ops webhook', hint: 'The instance name. Empty creates no notification rule' },
    ],
    automation: (values                 , name        )             => {
      const queryName = str(values, 'query_name', 'Saved query');
      const queryText = str(values, 'query_text', '');
      const { conditions: filters, bad } = conditionRows(str(values, 'filters', ''));
      const partition = str(values, 'partition', '');
      const aggregation = str(values, 'aggregation', 'COUNT');
      const aggField = aggregation === 'UNIQUE_COUNT' ? str(values, 'agg_field', '') : '';
      const groupBy = listOf(str(values, 'group_by', ''));
      const field = str(values, 'field_name', 'value');
      const pre = str(values, 'pre_context', '');
      const valueRx = str(values, 'value_regex', '\\d+');
      const post = str(values, 'post_context', '');
      const sample = str(values, 'sample_line', '');
      const kind = str(values, 'object_kind', 'VirtualMachine');
      const threshold = num(values, 'threshold', 10);
      const windowMin = num(values, 'window_minutes', 15);
      const severity = str(values, 'severity', 'WARNING');
      const impact = str(values, 'impact', 'HEALTH');
      const recommendation = str(values, 'recommendation', '');
      const policy = str(values, 'policy_name', '');
      const plugin = str(values, 'notify_plugin', '');
      const base = slugOf(name || queryName, 'log-alert');
      const counted = aggregation === 'UNIQUE_COUNT' ? `unique ${aggField || '<field>'} values` : 'events';

      const findings            = [];
      if (!queryText && filters.length === 0) {
        findings.push(error('vcflog91.query.empty', 'Neither search text nor a filter: the saved query matches every event.', { source: SRC }));
      }
      for (const row of bad) findings.push(error('vcflog91.query.bad-filter', `Filter row "${row}" has an operator 9.1 does not offer, or no value.`, { source: SRC }));
      if (aggregation === 'UNIQUE_COUNT' && !aggField) findings.push(error('vcflog91.query.no-agg-field', 'A unique count needs the field whose values are counted.', { source: SRC }));
      if (!pre && !post) {
        findings.push(
          error('vcflog91.query.no-context', 'The extracted field has no text before or after the value, so it matches every number in every line.', {
            remediation: 'Anchor it: the key that precedes the value (latency=) and the unit that follows (ms).',
            source: SRC,
          }),
        );
      }
      if (threshold <= 1) {
        findings.push(warning('vcflog91.query.one', 'One matching event raises the alert. Log alerts on a single line page on every retry storm.', { source: SRC }));
      }
      if (/default/i.test(policy)) {
        findings.push(warning('vcflog91.query.default-policy', 'Enabling the alert in the default policy raises it on every object of that kind that logs the phrase.', { remediation: 'Enable it in the policy for the tier that runs the application.', source: SRC }));
      }
      if (!policy) findings.push(warning('vcflog91.query.no-policy', 'No policy: the alert definition is created but enabled nowhere, so it never fires.', { source: SRC }));
      if (!plugin) findings.push(info('vcflog91.query.no-notify', 'No notification rule: the alert shows in VCF Operations and tells nobody.', { source: SRC }));

      const OPERATOR_TYPE                                   = {
        Contains: 'CONTAINS',
        'Does not contain': 'NOT_CONTAINS',
        'Starts with': 'STARTS_WITH',
        'Does not start with': 'NOT_STARTS_WITH',
        'Matches Regex': 'MATCHES_REGEX',
        Exists: 'EXISTS',
        'Does not exist': 'NOT_EXISTS',
      };
      const queryConfig = {
        name: queryName,
        description: `Selected by the log-based alert "${queryName}".`,
        queryText: [queryText || '*'],
        dateRange: { fixedRange: 'LAST_7_DAYS' },
        queryFilters: {
          logQueryFiltersOperator: 'AND',
          partitions: partition ? [partition] : [],
          logQueryFilterConditions: filters.map((f) => ({ conditionField: f.field, conditionValues: f.value !== undefined ? [f.value] : [], queryFilterConditionOperatorType: OPERATOR_TYPE[f.operator] ?? 'CONTAINS' })),
        },
        aggregation: { function: aggregation, ...(aggField ? { field: aggField } : {}), groupBy },
      };

      const extraction = { name: field, preContext: pre, valueRegex: valueRx, postContext: post, appliesTo: filters.length > 0 ? describeAll(filters) : 'all events', sample };

      const symptom = {
        name: `${queryName} — more than ${threshold} ${counted} in ${windowMin} min`,
        adapterKindKey: 'VMWARE',
        resourceKindKey: kind,
        waitCycles: 1,
        cancelCycles: 1,
        state: {
          severity,
          condition: { type: 'CONDITION_LOG', queryConfigId: '<set by apply.sh>', operator: 'GT', value: threshold, timeWindowMinutes: windowMin, aggregation, ...(aggField ? { field: aggField } : {}), groupBy },
        },
      };
      const alertDef = {
        name: queryName,
        description: `More than ${threshold} ${counted} matching the saved log query "${queryName}" in ${windowMin} minutes.`,
        adapterKindKey: 'VMWARE',
        resourceKindKey: kind,
        waitCycles: 1,
        cancelCycles: 1,
        type: 15,
        subType: 19,
        states: [
          {
            severity,
            impact: { impactType: 'BADGE', detail: impact },
            'base-symptom-set': { type: 'SYMPTOM_SET', relation: 'SELF', aggregation: 'ALL', symptomSetOperator: 'AND', symptomDefinitionIds: ['<set by apply.sh>'] },
            recommendationPriorityMap: {},
          },
        ],
      };
      const recommendationDoc = recommendation ? { description: recommendation } : undefined;
      const rule = plugin
        ? { name: `${queryName} → ${plugin}`, pluginId: '<set by apply.sh>', alertControlStates: ['OPEN'], alertStatuses: ['NEW', 'UPDATED', 'CANCELED'], criticalities: [severity], alertDefinitionIdFilters: { values: ['<set by apply.sh>'] }, resourceKindFilters: [{ adapterKind: 'VMWARE', resourceKind: kind }] }
        : undefined;

      const test = [
        '#!/usr/bin/env bash',
        `# Does the extraction for ${field} pull a value out of the sample line?`,
        '# Local only. Exits 1 when it extracts nothing.',
        'set -euo pipefail',
        'command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }',
        'cd "$(dirname "$0")"',
        "python3 - extracted-field.json <<'PY'",
        'import json, re, sys',
        'f = json.load(open(sys.argv[1], encoding="utf-8"))',
        'rx = re.compile("(?:" + f["preContext"] + ")(" + f["valueRegex"] + ")(?:" + f["postContext"] + ")")',
        'hits = rx.findall(f["sample"])',
        'if not hits:',
        '    print("FAIL  nothing extracted from: " + f["sample"])',
        '    sys.exit(1)',
        'print(f["name"] + " = " + ", ".join(hits))',
        'if len(hits) > 1:',
        '    print("note  more than one value in one line; the field takes each")',
        'PY',
        '',
      ].join('\n');

      const apply = [
        ...logsScriptHead(`Create the saved log query "${queryName}", its extracted field, the log-based symptom and alert definition, enable it in a policy and notify on it.`),
        'bash "$HERE/test-extraction.sh" || { echo "test-extraction.sh failed: nothing applied." >&2; exit 1; }',
        `QNAME=${sq(queryName)}`,
        `POLICY_NAME=${sq(policy)}`,
        `PLUGIN_NAME=${sq(plugin)}`,
        'if (( DRY_RUN )); then',
        '  echo "DRY RUN: would POST queryconfig.json to /suite-api/api/logs/queryconfigs (unless $QNAME exists)"',
        '  echo "DRY RUN: would POST extracted-field.json to the log management extracted fields"',
        '  echo "DRY RUN: would POST symptom-definition.json, then alert-definition.json, to /suite-api/api/symptomdefinitions and /suite-api/api/alertdefinitions"',
        '  [[ -n "$POLICY_NAME" ]] && echo "DRY RUN: would enable the alert in \\"$POLICY_NAME\\" with merge-policy.sh"',
        '  [[ -n "$PLUGIN_NAME" ]] && echo "DRY RUN: would POST notification-rule.json to /suite-api/api/notifications/rules"',
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        '',
        '# 1. The saved query (documented: /suite-api/api/logs/queryconfigs, OpsToken).',
        'ops GET /suite-api/api/logs/queryconfigs > "$BEFORE_DIR/queryconfigs-before.json"',
        'QID=$(jq -r --arg n "$QNAME" \'[.. | objects | select(.name? == $n) | (.id // .queryConfigId)] | map(select(. != null)) | .[0] // empty\' "$BEFORE_DIR/queryconfigs-before.json")',
        'if [[ -z "$QID" ]]; then',
        '  QID=$(ops POST /suite-api/api/logs/queryconfigs "$HERE/queryconfig.json" | tee "$BEFORE_DIR/queryconfig-created.json" | jq -r \'.id // .queryConfigId // empty\')',
        '  [[ -n "$QID" ]] || { echo "POST queryconfigs returned no id." >&2; exit 1; }',
        '  echo "saved query $QID"',
        'else',
        '  echo "saved query exists, left alone: $QID"',
        'fi',
        '',
        '# 2. The extracted field (log management, ops-li JWT).',
        ...logsCallLines({ what: `extracted field ${field}`, key: 'extracted fields', path: '/api/v2/extracted-fields', payload: 'extracted-field.json', name: field }, `${base}-ALERT.md`, true),
        '# 3. The symptom that watches the saved query, and the alert on it.',
        'jq --arg q "$QID" \'.state.condition.queryConfigId = $q\' "$HERE/symptom-definition.json" > "$BEFORE_DIR/symptom.json"',
        'SID=$(ops POST /suite-api/api/symptomdefinitions "$BEFORE_DIR/symptom.json" | tee "$BEFORE_DIR/symptom-created.json" | jq -r \'.id // empty\')',
        '[[ -n "$SID" ]] || { echo "POST symptomdefinitions returned no id (VERIFY the log condition shape: see the ALERT.md)." >&2; exit 1; }',
        ...(recommendationDoc
          ? [
              'RID=$(ops POST /suite-api/api/recommendations "$HERE/recommendation.json" | tee "$BEFORE_DIR/recommendation-created.json" | jq -r \'.id // empty\')',
              'jq --arg s "$SID" --arg r "$RID" \'.states[0]["base-symptom-set"].symptomDefinitionIds = [$s] | if $r != "" then .states[0].recommendationPriorityMap = {($r): 1} else . end\' "$HERE/alert-definition.json" > "$BEFORE_DIR/alert.json"',
            ]
          : ['jq --arg s "$SID" \'.states[0]["base-symptom-set"].symptomDefinitionIds = [$s]\' "$HERE/alert-definition.json" > "$BEFORE_DIR/alert.json"']),
        'AID=$(ops POST /suite-api/api/alertdefinitions "$BEFORE_DIR/alert.json" | tee "$BEFORE_DIR/alert-created.json" | jq -r \'.id // empty\')',
        '[[ -n "$AID" ]] || { echo "POST alertdefinitions returned no id." >&2; exit 1; }',
        'echo "alert definition $AID"',
        '',
        '# 4. Enabled in the policy: export, merge this one <Alert>, import (merge-policy.sh).',
        'if [[ -n "$POLICY_NAME" ]]; then',
        '  if [[ -z "${POLICY_ID:-}" ]]; then',
        '    POLICY_ID=$(ops GET /suite-api/api/policies | jq -r --arg n "$POLICY_NAME" \'[.. | objects | select(.name? == $n) | .id] | .[0] // empty\')',
        '  fi',
        '  [[ -n "$POLICY_ID" ]] || { echo "No policy named $POLICY_NAME: the alert exists ($AID) but is enabled nowhere." >&2; exit 1; }',
        `  printf '<PolicyOverrides>\\n  <Alerts adapterKind="VMWARE" resourceKind="%s">\\n    <Alert id="%s" enabled="true"/>\\n  </Alerts>\\n</PolicyOverrides>\\n' ${sq(kind)} "$AID" > "$HERE/policy-overrides.xml"`,
        '  # merge-policy.sh signs in the same way, from the same environment.',
        '  POLICY_ID="$POLICY_ID" bash "$HERE/merge-policy.sh"',
        'fi',
        '',
        '# 5. The notification rule.',
        'if [[ -n "$PLUGIN_NAME" ]]; then',
        '  PID=$(ops GET /suite-api/api/alertplugins | jq -r --arg n "$PLUGIN_NAME" \'[(.notificationPluginInstances[]?, .pluginInstances[]?) | select(.name == $n) | .pluginId] | .[0] // empty\')',
        '  [[ -n "$PID" ]] || { echo "No outbound plugin instance named $PLUGIN_NAME: the alert is enabled but tells nobody." >&2; exit 1; }',
        '  jq --arg p "$PID" --arg a "$AID" \'.pluginId = $p | .alertDefinitionIdFilters.values = [$a]\' "$HERE/notification-rule.json" > "$BEFORE_DIR/rule.json"',
        '  ops POST /suite-api/api/notifications/rules "$BEFORE_DIR/rule.json" | tee "$BEFORE_DIR/rule-created.json"',
        '  echo',
        'fi',
        'echo "Applied: query $QID, symptom $SID, alert $AID. Ids and payloads are in $BEFORE_DIR."',
        '# Undo: DELETE the notification rule, the alert definition, the symptom definition, then /suite-api/api/logs/queryconfigs/{id}, by the ids above; re-import policy-before-*.zip.',
        '',
      ].join('\n');

      return {
        platform: LOGS,
        title: `Log alert "${queryName}" — more than ${threshold} ${counted} in ${windowMin} minutes${groupBy.length > 0 ? ` per ${groupBy.join(', ')}` : ''}`,
        effect: 'reversible',
        trigger: { kind: 'alert', detail: `More than ${threshold} ${counted} matching the saved query "${queryName}" within ${windowMin} minutes${groupBy.length > 0 ? `, per ${groupBy.join(', ')}` : ''}, on a ${kind}`, worstCase: `once per ${kind} per ${windowMin} minutes while the errors continue` },
        scope: {
          what: `${kind} objects whose log events match the saved query, in the policy "${policy || 'none'}".`,
          decidedBy: ['The saved query: search text, filter rows (all must match) and partition.', 'The mapping of log events to objects (hostname to inventory object).', `The policy "${policy || 'none'}" the alert is enabled in.`, plugin ? `The notification rule to "${plugin}", which decides who hears.` : 'No notification rule: nobody is told.'],
          ifWrong: 'Too broad a query raises the alert on every object that logs the phrase, including ones that log it harmlessly; too narrow and it never fires. Neither changes anything in the estate.',
        },
        guardrails: [
          { rule: 'apply.sh runs test-extraction.sh first and applies nothing when the sample line yields no value', because: 'An extracted field that never matches makes every chart built on it empty, and nobody notices for weeks.' },
          { rule: 'A saved query with the same name is reused, not created again', because: 'Every run of the POST would otherwise create another saved query with the same name.' },
          { rule: 'The policy is changed by export, merge of this one alert, import — and the export is kept', because: 'Importing a fragment would replace every other override the policy has.' },
        ],
        dryRun: ['Run ./apply.sh --dry-run: it prints every call and signs in to nothing.', 'Run ./test-extraction.sh.', `Run the query in Explore Logs over the last 7 days and count how often more than ${threshold} arrived in ${windowMin} minutes — that is how often this will fire.`],
        undo: ['DELETE the notification rule, the alert definition, the symptom definition and /suite-api/api/logs/queryconfigs/{queryConfigId}, by the ids apply.sh saved under before-<time>/.', 'Re-import policy-before-<time>.zip (merge-policy.sh saved it) to put the policy back.', 'Delete the extracted field in Explore Logs.'],
        told: plugin ? [`The outbound plugin instance "${plugin}", through the notification rule apply.sh creates.`] : ['Nobody until a notification rule matches the alert.'],
        requires: ['VCF Operations 9.1 with log management.', 'A VCF Operations account allowed to manage log queries, alert definitions, policies and notifications.', 'curl, jq and python3.', ...(plugin ? [`The outbound plugin instance "${plugin}".`] : [])],
        files: {
          'queryconfig.json': json(queryConfig),
          'extracted-field.json': json(extraction),
          'symptom-definition.json': json(symptom),
          'alert-definition.json': json(alertDef),
          ...(recommendationDoc ? { 'recommendation.json': json(recommendationDoc) } : {}),
          ...(rule ? { 'notification-rule.json': json(rule) } : {}),
          ...(policy ? { 'merge-policy.sh': policyMergeScript('policy-overrides.xml', policy) } : {}),
          'test-extraction.sh': test,
          'apply.sh': apply,
          [`${base}-ALERT.md`]: md([
            `# Log-based alert on "${queryName}" — by hand, only where apply.sh stops`,
            '',
            '`./apply.sh` does all of this. Where a step fails on your release, it stops there; finish from that step.',
            '',
            `1. Saved query: \`${queryName}\`, search \`${queryText || '*'}\`${filters.length > 0 ? `, filters (all): ${describeAll(filters)}` : ''}${groupBy.length > 0 ? `, group by ${groupBy.join(', ')}` : ''}${aggregation === 'UNIQUE_COUNT' ? `, unique count of ${aggField}` : ''}.`,
            `2. Explore Logs → run the saved query → select \`${pre}…\` in a result → Extract Field → name \`${field}\`, before \`${pre}\`, value \`${valueRx}\`, after \`${post}\`.`,
            '3. Infrastructure Operations → Configurations → Alert Definitions → Add.',
            `4. Base Object Type: ${kind}. Impact ${impact.toLowerCase()}. Next.`,
            `5. Drag **Add Log Condition**; Filter By: \`${queryName}\`; time period ${windowMin} minutes; ${aggregation === 'UNIQUE_COUNT' ? `unique count of ${aggField}` : 'count'} greater than ${threshold}.`,
            `6. Severity ${severity}${recommendation ? `; recommendation "${recommendation}"` : ''}; enable it in "${policy || '<a policy>'}"; Create.`,
            ...(plugin ? [`7. Configure → Alerts → Notifications → Add: plugin "${plugin}", filter on this alert definition.`] : []),
            '',
            'VERIFY: the log condition in symptom-definition.json (CONDITION_LOG, queryConfigId, timeWindowMinutes, aggregation, groupBy), the queryFilters operator names other than CONTAINS, the aggregation block in queryconfig.json, and whether partitions takes names or ids are not in the 9.1 API reference. Create one by hand and GET /suite-api/api/symptomdefinitions/{id} to see the shape your release uses.',
          ]),
        },
        notes: [
          'queryconfigs is the log-management object with a documented public API in 9.1 (GET/POST/PUT /suite-api/api/logs/queryconfigs, GET/DELETE …/{queryConfigId}), authenticated with the ordinary OpsToken.',
          logsApplyNote(),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcflog91_upgrade',
    platform: LOGS,
    label: 'Move from standalone Logs 8.18 / 9.0 to 9.1 log management',
    group: 'Log management 9.1',
    description:
      'The inventory to take before the upgrade and the checklist to work through after it: a read-only script that exports content packs, alerts, forwarding, partitions, archiving and agent groups from the old appliance’s API, and the list of what 9.1 carries over, what it does not, and what has to be redone by hand.',
    inputs: [
      {
        id: 'source',
        label: 'Upgrading from',
        control: 'select',
        options: [
          { value: '8.18', label: 'VCF Operations for Logs 8.18' },
          { value: '9.0', label: 'VCF Operations for Logs 9.0' },
        ],
        default: '9.0',
      },
      { id: 'new_fqdn', label: 'Log management 9.1 FQDN', control: 'text', default: 'logmgmt.example.com', hint: 'A new name, on the management network' },
      {
        id: 'size',
        label: 'Size',
        control: 'select',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'medium', label: 'Medium' },
          { value: 'large', label: 'Large' },
        ],
        default: 'medium',
      },
      { id: 'out_dir', label: 'Export folder', control: 'text', default: 'logs-inventory' },
    ],
    automation: (values                 , name        )             => {
      const source = str(values, 'source', '9.0');
      const fqdn = str(values, 'new_fqdn', '');
      const size = str(values, 'size', 'medium');
      const outDir = str(values, 'out_dir', 'logs-inventory');
      const base = slugOf(name || `logs-${source}-to-91`, 'logs-upgrade');

      const findings            = [];
      if (!fqdn) findings.push(error('vcflog91.up.no-fqdn', '9.1 log management needs a new FQDN that resolves on the VCF management network.', { source: SRC }));
      if (source === '8.18') {
        findings.push(
          warning('vcflog91.up.818', 'From 8.18, agents and log sources are not reconfigured automatically, and copied forwarders are left inactive.', {
            remediation: 'Legacy appliances keep collecting until each source is moved. Plan the cut-over per source, and activate the forwarders by hand after checking them.',
            source: SRC,
          }),
        );
      }

      const script = readScript(LOGS, `Export the configuration of the standalone VCF Operations for Logs ${source} appliance before moving to 9.1.`, [
        `OUT="\${OUT_DIR:-${outDir}}-$(date +%Y%m%d)"`,
        'mkdir -p "$OUT"',
        'READ=0',
        'MISSING=()',
        '',
        '# Each item is tried at the v2 path first, then v1. Paths differ between',
        '# releases; whatever answers is saved, and what nothing answers is listed.',
        'fetch() {',
        '  local name="$1" p body',
        '  shift',
        '  for p in "$@"; do',
        '    if body=$(get "$p" 2>/dev/null); then',
        '      echo "$body" | jq -S . > "$OUT/$name.json"',
        '      echo "saved  $name  ($p)"',
        '      READ=$((READ + 1))',
        '      return 0',
        '    fi',
        '  done',
        '  MISSING+=("$name (tried: $*)")',
        '}',
        '',
        'fetch version        /api/v2/version /api/v1/version',
        'fetch content-packs  /api/v2/content/contentpack/list /api/v1/content/contentpack/list',
        'fetch alerts         /api/v2/alerts /api/v1/alerts',
        'fetch forwarding     /api/v2/forwarding /api/v1/forwarding',
        'fetch partitions     /api/v2/partitions /api/v1/partitions',
        'fetch archiving      /api/v2/archiving /api/v1/archiving',
        'fetch agent-groups   /api/v2/agent/groups /api/v1/agent/groups',
        'fetch agents         /api/v2/agent/agents /api/v1/agent/agents',
        '',
        '{',
        '  echo "Standalone Logs inventory, $(date -u +%FT%TZ), from ${VCFLOGS_HOST}"',
        '  for f in "$OUT"/*.json; do',
        '    [[ -e "$f" ]] || continue',
        '    n=$(jq \'if type == "array" then length elif type == "object" then ([.[] | arrays | length] | add // 1) else 1 end\' "$f")',
        '    printf "%-16s %s item(s)\\n" "$(basename "$f" .json)" "$n"',
        '  done',
        '} | tee "$OUT/summary.txt"',
        '',
        'if (( ${#MISSING[@]} )); then',
        '  printf "NOT EXPORTED: %s\\n" "${MISSING[@]}" | tee -a "$OUT/summary.txt" >&2',
        '  echo "Export those from the interface (or screenshot them) before the upgrade." >&2',
        '  exit 1',
        'fi',
        '(( READ > 0 )) || exit 1',
        'echo "Inventory in $OUT. Keep it with the change record."',
      ]);

      const checklist = md([
        `# Standalone Logs ${source} → VCF Operations 9.1 log management`,
        '',
        '## Before',
        '',
        `- [ ] Run \`./export-inventory.sh\` against the ${source} appliance; it must exit 0. Keep the folder with the change.`,
        '- [ ] Export custom dashboards, saved queries and user alerts from the interface too — **custom content is not transferred automatically**.',
        `- [ ] New FQDN \`${fqdn || '<REQUIRED>'}\` in DNS (forward and reverse), on the network that hosts the VCF management services. Log management cannot run on a custom NSX overlay segment.`,
        `- [ ] Size ${size}. Replicas scale separately from the size profile (small 1–19, medium and large 3–19).`,
        ...(source === '8.18' ? ['- [ ] You are on 8.18.x. Earlier 8.x releases have no direct path to 9.1; go to 8.18 first.'] : []),
        '- [ ] Decide what happens to history: the transfer utility, importing archived logs, or leaving the old cluster queryable for its 90-day window.',
        '',
        '## Upgrade',
        '',
        '- [ ] VCF Operations → Build → Lifecycle → VCF Management → Upgrade tab: set the log management FQDN and size, then Upgrade next to the VCF Operations for logs instance.',
        '- [ ] Watch Upgrade details; download the upgrade report from Tasks.',
        '',
        '## After',
        '',
        ...(source === '9.0'
          ? ['- [ ] Agents and log sources configured in the 9.0 VCF Operations UI are reconfigured automatically. Check each source appears under Log Collection.']
          : ['- [ ] Agents and log sources: reconfigure each one to the new target. The 8.18 appliance keeps collecting until you do.']),
        `- [ ] Log forwarding: forwarders are copied${source === '8.18' ? ' but left inactive — compare with forwarding.json, then activate each one' : ' — compare each with forwarding.json'}.`,
        '- [ ] Partitions and archiving: recreate from partitions.json and archiving.json (see "A partition with its own retention and archive (9.1)").',
        '- [ ] Content packs: convert to management packs (Converting Content Packs to Management Packs), using content-packs.json as the list.',
        '- [ ] Alerts: recreate as log-based alert definitions from alerts.json (see "A saved log query, an extracted field and the alert on it (9.1)").',
        '- [ ] vCenter and NSX log collection: enable it on each adapter in VCF Operations. VCF management services are enabled automatically.',
        '- [ ] 9.1.1: SDDC Manager log configuration is managed from VCF Operations; check it appears under Log Collection.',
        '',
        '## If VCF Operations is unavailable',
        '',
        `The standalone emergency UI is at \`https://${fqdn || '<log-management-fqdn>'}\`, signed in as the VMSP vmware-system-user account. It is read-only — Analyze Logs only, no configuration — and bypasses the Identity Broker, so restrict it to emergencies.`,
        '',
        'Known issue in 9.1.1: Log Management disaster recovery displays an error after restoration.',
      ]);

      return {
        platform: LOGS,
        title: `Standalone Logs ${source} → 9.1 log management: inventory and checklist`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run once before the upgrade, and again the day of it to catch changes since.', worstCase: 'twice' },
        scope: {
          what: `The configuration of one standalone VCF Operations for Logs ${source} appliance.`,
          decidedBy: ['What the Logs account used for the session can read. An account with the admin role sees everything the script asks for.'],
          ifWrong: 'An item the account cannot read is listed as not exported and the script exits 1. Nothing on the appliance is changed either way.',
        },
        guardrails: [
          { rule: 'Reads only; every call is a GET', because: 'An inventory taken before an upgrade must not be the thing that changes the system.' },
          { rule: 'Exits 1 when any item could not be exported', because: 'A gap found after the old appliance is gone is a gap for good.' },
        ],
        dryRun: ['It only reads. Run it and read summary.txt.'],
        undo: ['Nothing to undo.'],
        told: ['The export folder and summary.txt. Attach them to the upgrade change.'],
        requires: ['jq and bash 4 on the machine running it.', `Network access to the ${source} appliance API (port 9543) and a session (VCFLOGS_TOKEN, or VCFLOGS_USER with VCFLOGS_PASSWORD_FILE).`],
        files: { 'export-inventory.sh': script, [`${base}-CHECKLIST.md`]: checklist },
        notes: [
          'VERIFY: the old appliance API paths — the script tries /api/v2 then /api/v1 for each, because they moved between releases. An item neither answers is exported by hand.',
          '9.1 log management is a containerised service in the VCF management services platform. The old appliance’s /api/v2 (and its /api/v2/sessions login, which this script uses) does not exist on it: this script is for the standalone 8.18 / 9.0 appliance only. Calls to 9.1 log management go through VCF Operations with the KB 450054 token exchange (POST /suite-api/api/auth/token/exchange {"serviceKeys":["ops-li"]}).',
        ],
        findings,
      };
    },
  }),
  ...VCF_LOGS91_MORE,
];

// ===========================================================================
// Operate: health, findings, investigation, vSAN, audit, posture
// ===========================================================================

/** The object kinds VCF Health covers, as adapter kind | resource kind | label. */
const HEALTH_KINDS                                                                          = [
  { id: 'include_esx', label: 'ESX hosts', spec: 'VMWARE|HostSystem|ESX host', verify: false },
  { id: 'include_vcenter', label: 'vCenter instances', spec: 'VMWARE|VMwareAdapter Instance|vCenter', verify: false },
  { id: 'include_nsx', label: 'NSX', spec: 'NSXTAdapter|ManagementCluster|NSX manager cluster', verify: true },
  { id: 'include_vsan', label: 'vSAN clusters', spec: 'VirtualAndPhysicalSANAdapter|VirtualSANDCCluster|vSAN cluster', verify: true },
];

const HEALTH_LEVELS                                              = {
  red: ['RED'],
  orange: ['ORANGE', 'RED'],
  yellow: ['YELLOW', 'ORANGE', 'RED'],
};

export const VCF_OPS_OPERATE                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_health_fleet',
    platform: OPS,
    label: 'VCF Health report: ESX, vCenter, NSX and vSAN',
    group: 'Health',
    description:
      'A scheduled read of what 9.1 VCF Health shows — ESX, vCenter, NSX and vSAN — as health badges and active alerts per object, written to JSON and CSV, posted to a webhook and turned into an exit code a scheduler can page on. It also fails when an object type returns nothing, because an empty section is a blind spot, not a healthy one.',
    inputs: [
      ...HEALTH_KINDS.map((kind) => ({ id: kind.id, label: `Include ${kind.label}`, control: 'toggle'         , default: true })),
      { id: 'nsx_kind', label: 'NSX object kind', control: 'text', default: 'NSXTAdapter|ManagementCluster', hint: 'adapterKind|resourceKind. VERIFY with GET /suite-api/api/adapterkinds/NSXTAdapter/resourcekinds', showWhen: { input: 'include_nsx', equals: ['true'] } },
      { id: 'vsan_kind', label: 'vSAN object kind', control: 'text', default: 'VirtualAndPhysicalSANAdapter|VirtualSANDCCluster', hint: 'adapterKind|resourceKind. VERIFY as above', showWhen: { input: 'include_vsan', equals: ['true'] } },
      {
        id: 'fail_on',
        label: 'Fail when health is',
        control: 'select',
        options: [
          { value: 'red', label: 'Red (critical)' },
          { value: 'orange', label: 'Orange or worse' },
          { value: 'yellow', label: 'Yellow or worse' },
        ],
        default: 'orange',
      },
      { id: 'fail_on_critical_alerts', label: 'Also fail on any critical alert', control: 'toggle', default: true },
      { id: 'max_objects', label: 'At most (objects per kind)', control: 'number', default: 2000, min: 10, max: 10000 },
      { id: 'webhook', label: 'Post problems to', control: 'text', default: 'https://runbooks.example.com/hooks/vcf-health', hint: 'Somewhere that is not VCF Operations' },
    ],
    automation: (values                 , name        )             => {
      const nsxKind = str(values, 'nsx_kind', 'NSXTAdapter|ManagementCluster');
      const vsanKind = str(values, 'vsan_kind', 'VirtualAndPhysicalSANAdapter|VirtualSANDCCluster');
      const kinds = HEALTH_KINDS.filter((kind) => bool(values, kind.id, true)).map((kind) => {
        if (kind.id === 'include_nsx') return `${nsxKind}|NSX`;
        if (kind.id === 'include_vsan') return `${vsanKind}|vSAN cluster`;
        return kind.spec;
      });
      const failOn = str(values, 'fail_on', 'orange');
      const levels = HEALTH_LEVELS[failOn] ?? HEALTH_LEVELS['orange'] ;
      const critical = bool(values, 'fail_on_critical_alerts', true);
      const max = num(values, 'max_objects', 2000);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'vcf-health', 'vcf-health');

      const findings            = [];
      if (kinds.length === 0) findings.push(error('vcfops.health.nothing', 'Every object type is switched off, so the report reads nothing.', { source: SRC }));
      if (webhook && /vcfops|vcf-operations/i.test(webhook) && !/hooks/i.test(webhook)) {
        findings.push(warning('vcfops.health.self', 'The problem report goes back to VCF Operations, which is part of what is being checked.', { source: SRC }));
      }

      const script = readScript(OPS, 'VCF Health: health badge and active alerts per ESX host, vCenter, NSX and vSAN object.', [
        `MAX=${max}`,
        `FAIL_LEVELS='${JSON.stringify(levels)}'`,
        `FAIL_ON_CRITICAL=${critical ? 1 : 0}`,
        'KINDS=(',
        ...kinds.map((kind) => `  '${kind}'`),
        ')',
        'STAMP=$(date +%Y%m%d-%H%M)',
        'PROBLEMS=()',
        '',
        ...workDirLines(OPS),
        ...PAGED_HELPERS,
        ...WEBHOOK_HELPER,
        '',
        '# Active alerts once, joined to objects below. GET /alerts has no activeOnly',
        '# parameter; the query form does. Paged, and kept in files: a large estate’s',
        '# alert list is far over the 128 KB limit on one argument.',
        'echo \'{"activeOnly": true}\' > "$WORK/active.json"',
        'post_all /suite-api/api/alerts/query alerts "$WORK/alerts-raw.json" "$WORK/active.json" || exit 2',
        'jq \'[.[] | {resourceId, level: .alertLevel, name: .alertDefinitionName}]\' "$WORK/alerts-raw.json" > "$WORK/alerts.json"',
        '',
        ': > "$WORK/rows.items"',
        'for spec in "${KINDS[@]}"; do',
        '  IFS="|" read -r ak rk label <<<"$spec"',
        '  rk_uri=$(jq -rn --arg v "$rk" \'$v | @uri\')',
        '  if ! get_all "/suite-api/api/resources?adapterKind=${ak}&resourceKind=${rk_uri}" resourceList "$WORK/res.json"; then',
        '    PROBLEMS+=("could not read $label objects ($ak / $rk)")',
        '    continue',
        '  fi',
        '  n=$(jq length "$WORK/res.json")',
        '  echo "$label: $n object(s)"',
        '  (( n > 0 )) || PROBLEMS+=("no $label objects returned for $ak / $rk — a blind spot; check the kind key and the adapter")',
        '  (( n <= MAX )) || PROBLEMS+=("$n $label objects, more than the $MAX this report is set for: only the first $MAX are checked")',
        '  jq -c --arg l "$label" --argjson max "$MAX" \'.[:$max][] | {kind: $l, id: .identifier, name: .resourceKey.name, health: (.resourceHealth // "UNKNOWN"), score: (.resourceHealthValue // null)}\' "$WORK/res.json" >> "$WORK/rows.items"',
        'done',
        'jq -s . "$WORK/rows.items" > "$WORK/rows.json"',
        '',
        'REPORT="vcf-health-$STAMP.json"',
        'jq -n --slurpfile rows "$WORK/rows.json" --slurpfile alerts "$WORK/alerts.json" \'',
        '  ($alerts[0] | group_by(.resourceId) | map({key: .[0].resourceId, value: .}) | from_entries) as $by',
        '  | [$rows[0][] | . as $r | ($by[$r.id] // []) as $al',
        '     | $r + {critical: ($al | map(select(.level == "CRITICAL")) | length),',
        '             immediate: ($al | map(select(.level == "IMMEDIATE")) | length),',
        '             warning: ($al | map(select(.level == "WARNING")) | length),',
        '             alerts: ($al | map(.name) | unique)}]\' > "$REPORT"',
        'jq -r \'(["kind","name","health","score","critical","immediate","warning","alerts"] | @csv), (.[] | [.kind, .name, .health, .score, .critical, .immediate, .warning, (.alerts | join("; "))] | @csv)\' "$REPORT" > "vcf-health-$STAMP.csv"',
        '',
        'jq -r --argjson lv "$FAIL_LEVELS" --argjson c "$FAIL_ON_CRITICAL" \'',
        '  .[] | select((.health as $h | $lv | index($h)) or ($c == 1 and .critical > 0))',
        '  | "\\(.kind) \\(.name): health \\(.health)\\(if .critical > 0 then ", \\(.critical) critical alert(s): \\(.alerts | join("; "))" else "" end)"\' "$REPORT" > "$WORK/unhealthy.txt"',
        'while IFS= read -r line; do PROBLEMS+=("$line"); done < "$WORK/unhealthy.txt"',
        '',
        'echo "Report: vcf-health-$STAMP.json / .csv"',
        'if (( ${#PROBLEMS[@]} == 0 )); then',
        '  echo "VCF Health: nothing at or above the threshold."',
        '  exit 0',
        'fi',
        'printf "PROBLEM: %s\\n" "${PROBLEMS[@]}" >&2',
        ...(webhook
          ? [`printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vcf-health", problems: .}' > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        'finish 1',
      ]);

      return {
        platform: OPS,
        title: `VCF Health report — ${HEALTH_KINDS.filter((kind) => bool(values, kind.id, true)).map((kind) => kind.label).join(', ') || 'nothing selected'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Hourly, from a scheduler outside VCF Operations', worstCase: 'every hour while something is unhealthy' },
        scope: {
          what: `Every object of the selected kinds that VCF Operations knows about, up to ${max} per kind.`,
          decidedBy: ['Which adapters are configured — an NSX or vSAN instance with no adapter is invisible here.', 'The kind keys in the script.', 'What the account can see: a scoped account reports only its scope.'],
          ifWrong: 'An object left out is not checked; an empty kind is reported as a problem precisely so that this is visible.',
        },
        guardrails: [
          { rule: 'Reads only', because: 'A health check with write rights is a larger risk than the failures it looks for.' },
          { rule: 'Fails when an included object kind returns no objects, or when a read fails', because: 'A misspelt kind key or a broken adapter otherwise reads as "all healthy".' },
          { rule: 'Reads every page of objects and active alerts through files, and says when a kind has more objects than the cap', because: 'An unpaged read stops at one page and the rest of the estate is silently unchecked; a list passed as an argument fails at 128 KB.' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f and a failed post exits 3', because: 'A problem report that did not arrive must not look like one that did.' }] : []),
        ],
        dryRun: ['It only reads. Run it once and compare the counts per kind with Operate → VCF Health.'],
        undo: ['Nothing to undo.'],
        told: webhook ? [`${webhook}, whenever a check fails.`, 'The JSON and CSV files, every run.'] : ['The exit code and the JSON and CSV files.'],
        requires: ['jq and bash 4.', 'A read-only VCF Operations account.'],
        files: {
          [`${base}.sh`]: script,
          'crontab.txt': `# Hourly. The script logs in for itself from the password file (mode 600);\n# no token or password is in this line.\n0 * * * * cd /var/lib/vcf-health && ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/${base}.sh >> /var/log/vcf-health.log 2>&1\n`,
        },
        notes: [
          'What 9.1 VCF Health shows beyond a badge — ESX reachability, connectivity, services, hardware (memory and SSD), PSOD history, utilisation; vCenter endpoint monitoring of the vSphere Client and APIs and the 17–18 services (KB 381709), the VM Operations Task ID backtrace and the Error Stack panel; snapshot and vMotion capability checks — is in Operate → VCF Health. This report sees it when it moves the health badge or raises an alert, not otherwise.',
          'VERIFY: the NSX and vSAN kind keys. Run GET /suite-api/api/adapterkinds/{adapterKind}/resourcekinds and pick the kind VCF Health reports on.',
          'resourceHealth and resourceHealthValue are the fields GET /suite-api/api/resources returns for the health badge; an object with no badge yet reports UNKNOWN.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_findings',
    platform: OPS,
    label: 'Open findings report from the 9.1 Findings API',
    group: 'Health',
    description:
      'The 9.1 Findings API, read on a schedule: every open diagnostic finding grouped by severity, with the objects it affects, as CSV and JSON, posted to a webhook for the ticketing or risk system, and an exit code for the severities you choose.',
    inputs: [
      { id: 'severities', label: 'Only severities', control: 'text', default: '', hint: 'Comma separated, as the API returns them. Empty reads all' },
      { id: 'fail_regex', label: 'Fail when a finding’s severity matches', control: 'text', default: 'CRITICAL', hint: 'Case-insensitive regex. VERIFY the values your release returns' },
      { id: 'since_days', label: 'Occurred in the last (days)', control: 'number', default: 0, min: 0, max: 365, hint: '0 reads all open findings' },
      { id: 'include_objects', label: 'List affected objects', control: 'toggle', default: true },
      { id: 'max_rules', label: 'Fetch objects for at most (findings)', control: 'number', default: 200, min: 1, max: 5000, showWhen: { input: 'include_objects', equals: ['true'] } },
      { id: 'webhook', label: 'Post the report to', control: 'text', default: 'https://itsm.example.com/hooks/vcf-findings' },
    ],
    automation: (values                 , name        )             => {
      const severities = listOf(str(values, 'severities', ''));
      const failRx = str(values, 'fail_regex', 'CRITICAL');
      const since = num(values, 'since_days', 0);
      const objects = bool(values, 'include_objects', true);
      const maxRules = num(values, 'max_rules', 200);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'vcf-findings', 'vcf-findings');

      const findings            = [];
      if (!failRx) findings.push(info('vcfops.findings.never-fails', 'No severity fails the run, so the exit code is always 0 and only the files report.', { source: SRC }));

      const script = readScript(OPS, 'Open VCF Operations 9.1 findings, grouped by severity, with affected objects.', [
        ...workDirLines(OPS),
        ...PAGED_HELPERS,
        ...WEBHOOK_HELPER,
        '',
        `SEVERITIES='${JSON.stringify(severities).replace(/'/g, '')}'`,
        `FAIL_RX='${failRx.replace(/'/g, '')}'`,
        `SINCE_DAYS=${since}`,
        `MAX_RULES=${maxRules}`,
        'PAGE_SIZE=500',
        'STAMP=$(date +%Y%m%d)',
        'FROM_MS=0',
        '(( SINCE_DAYS > 0 )) && FROM_MS=$(( ($(date +%s) - SINCE_DAYS * 86400) * 1000 ))',
        '',
        'jq -n --argjson sev "$SEVERITIES" --argjson from "$FROM_MS" \'{filter: ((if ($sev | length) > 0 then {severities: $sev} else {} end) + (if $from > 0 then {fromOccurrenceTime: $from} else {} end))}\' > "$WORK/body.json"',
        '',
        '# The 9.1.1 reference lists the operations under /api/diagnostics/findings; the',
        '# category page says /api/findings. Use whichever answers.',
        'FINDINGS_PATH=""',
        'for p in /suite-api/api/diagnostics/findings/query /suite-api/api/findings/query; do',
        '  if post "${p}?page=0&pageSize=1" < "$WORK/body.json" >/dev/null 2>&1; then FINDINGS_PATH="$p"; break; fi',
        'done',
        '[[ -n "$FINDINGS_PATH" ]] || { echo "Neither findings path answered — is this VCF Operations 9.1 or later?" >&2; exit 2; }',
        'OBJ_BASE="${FINDINGS_PATH%/query}"',
        '',
        '# Every page, into a file (a large result is over the 128 KB argument limit).',
        'post_all "${FINDINGS_PATH}?sortBy=SEVERITY&sortOrder=DESCENDING" findings "$WORK/all.json" "$WORK/body.json" || exit 2',
        'echo "$(jq length "$WORK/all.json") finding(s) via $FINDINGS_PATH"',
        ...(objects
          ? [
              '',
              '# Affected objects per finding. A query that fails stops the report (exit 2):',
              '# an empty list would read as "affects nothing". VERIFY: the rule id field on',
              '# a finding; the documented response lists ruleName but the object query',
              '# needs ruleUuid.',
              'echo \'{"filter":{}}\' > "$WORK/objbody.json"',
              ': > "$WORK/with.items"',
              'i=0',
              'while IFS= read -r f; do',
              '  i=$((i + 1))',
              '  uuid=$(jq -r \'.ruleUuid // .ruleId // .uuid // empty\' <<<"$f")',
              '  echo \'[]\' > "$WORK/objs.json"',
              '  if [[ -n "$uuid" ]] && (( i <= MAX_RULES )); then',
              '    post_all "${OBJ_BASE}/${uuid}/affectedobjects/query" affectedObjects "$WORK/objs-raw.json" "$WORK/objbody.json" \\',
              '      || { echo "Could not read the affected objects of finding $uuid." >&2; exit 2; }',
              '    jq \'[.[] | {name, resourceId, resourceKind}]\' "$WORK/objs-raw.json" > "$WORK/objs.json"',
              '  fi',
              '  jq -c --slurpfile o "$WORK/objs.json" \'. + {objects: $o[0]}\' <<<"$f" >> "$WORK/with.items"',
              'done < <(jq -c \'.[]\' "$WORK/all.json")',
              'jq -s . "$WORK/with.items" > "$WORK/all.json"',
            ]
          : []),
        '',
        'jq \'group_by(.severity) | map({severity: .[0].severity, count: length, findings: .})\' "$WORK/all.json" > "findings-$STAMP.json"',
        'jq -r \'(["severity","rule","category","affected","lastObserved","objects"] | @csv), (.[] | [.severity, .ruleName, .category, .affectedObjectsCount, (if .lastObservedTimeInMillis then (.lastObservedTimeInMillis / 1000 | floor | todate) else "" end), ((.objects // []) | map(.name) | join("; "))] | @csv)\' "$WORK/all.json" > "findings-$STAMP.csv"',
        'jq -r \'group_by(.severity)[] | "\\(.[0].severity): \\(length)"\' "$WORK/all.json"',
        ...(webhook
          ? [`jq '{source: "vcf-operations-findings", bySeverity: .}' "findings-$STAMP.json" > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        '',
        'FAILING=0',
        '[[ -n "$FAIL_RX" ]] && FAILING=$(jq --arg rx "$FAIL_RX" \'[.[] | select((.severity // "") | test($rx; "i"))] | length\' "$WORK/all.json")',
        'echo "Report: findings-$STAMP.json / .csv"',
        '(( FAILING == 0 )) || { echo "$FAILING finding(s) at a failing severity" >&2; finish 1; }',
        'finish 0',
      ]);

      return {
        platform: OPS,
        title: `Open findings report${severities.length > 0 ? ` (${severities.join(', ')})` : ''}${failRx ? `, failing on ${failRx}` : ''}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily, from a scheduler outside VCF Operations', worstCase: 'once a day' },
        scope: {
          what: `Every finding VCF Operations health and diagnostics holds${since > 0 ? ` that occurred in the last ${since} days` : ''}${severities.length > 0 ? `, of severity ${severities.join(', ')}` : ''}.`,
          decidedBy: ['The filter in the query body.', 'What the account can see.', `For affected objects, the first ${maxRules} findings only.`],
          ifWrong: 'Findings outside the filter are not reported. Nothing is changed.',
        },
        guardrails: [
          { rule: 'Reads only — the POSTs are queries', because: 'The Findings API is read-only; so is the account this should run as.' },
          { rule: `Affected objects are fetched for at most ${maxRules} findings`, because: 'One call per finding against a large estate is thousands of calls a day.' },
          { rule: 'Every page is read into files, and a failed read of findings or affected objects stops the run (exit 2)', because: 'A list passed as an argument fails at 128 KB, and a failed read turned into an empty list reports "affects nothing".' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f and a failed post exits 3', because: 'The ticketing system not receiving the report must not look like it did.' }] : []),
        ],
        dryRun: ['It only reads. Run it and compare the counts with the Findings page.'],
        undo: ['Nothing to undo.'],
        told: webhook ? [`${webhook}, daily, with every finding grouped by severity.`] : ['The JSON and CSV files and the exit code.'],
        requires: ['VCF Operations 9.1 or later (the Findings API is new in 9.1).', 'jq and bash 4.', 'A read-only VCF Operations account.'],
        files: {
          [`${base}.sh`]: script,
          'crontab.txt': `# Daily at 06:15. The script logs in for itself from the password file (mode 600).\n15 6 * * * cd /var/lib/vcf-findings && ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/${base}.sh >> /var/log/vcf-findings.log 2>&1\n`,
        },
        notes: [
          'Documented: POST …/findings/query (page, pageSize up to 1000, sortBy RULE_ID|SUBTYPE|SEVERITY|AFFECTED_OBJECTS_COUNT|RESOURCE_ID|RESOURCE_NAME|CHECK_TIME|OCCURRENCE_TIME|COMPONENT; filter by resourceIds, resourceKinds, adapterKinds, capabilities, categories, severities, ruleUuids, refreshTypes, findingTypes, fromOccurrenceTime) and POST …/findings/{ruleUuid}/affectedobjects/query.',
          'VERIFY: the severity values, and the field on a finding that carries its ruleUuid — the published response schema lists ruleName, severity, category, capabilities, refreshMode, affectedObjectsCount, findingType and lastObservedTimeInMillis only.',
          'Log Assist in 9.1 generates support bundles automatically for the VCF Operations cluster, management services, cloud proxies, log management and the Identity Broker, and can bundle selected nodes rather than the whole cluster. When a finding needs a support case, generate the bundle from the node it names.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_realtime',
    platform: OPS,
    label: 'Real-time investigation kit: PromQL, sessions, CLI tools',
    group: 'Investigate',
    description:
      'The kit for a 9.1 real-time investigation: PromQL queries to paste into metric search (top-N CPU ready, network drops), an investigation-session template to save and share, the command-line tools the Actions tab runs, and a script that pulls the same numbers from the suite API when the PromQL view is not to hand.',
    inputs: [
      {
        id: 'metric',
        label: 'Look at',
        control: 'select',
        options: [
          { value: 'VirtualMachine::cpu|readyPct', label: 'CPU ready % — virtual machines' },
          { value: 'HostSystem::cpu|readyPct', label: 'CPU ready % — ESX hosts' },
          { value: 'HostSystem::net|droppedPct', label: 'Network packets dropped % — ESX hosts' },
        ],
        default: 'VirtualMachine::cpu|readyPct',
      },
      { id: 'top_n', label: 'Top', control: 'number', default: 10, min: 1, max: 100 },
      { id: 'warn_at', label: 'Flag values above', control: 'number', default: 5, min: 0, max: 100 },
      { id: 'object_name', label: 'And chart one object', control: 'text', default: '', hint: 'Its name. Empty skips the per-object series' },
      { id: 'hours', label: 'Over the last (hours)', control: 'number', default: 4, min: 1, max: 168 },
      { id: 'max_objects', label: 'Look at most (objects)', control: 'number', default: 5000, min: 10, max: 20000 },
    ],
    automation: (values                 , name        )             => {
      const metricValue = str(values, 'metric', 'VirtualMachine::cpu|readyPct');
      const [kind = 'VirtualMachine', key = 'cpu|readyPct'] = metricValue.split('::');
      const topN = num(values, 'top_n', 10);
      const warnAt = num(values, 'warn_at', 5);
      const objectName = str(values, 'object_name', '');
      const hours = num(values, 'hours', 4);
      const max = num(values, 'max_objects', 5000);
      const base = slugOf(name || 'realtime-investigation', 'realtime');
      const label = key === 'net|droppedPct' ? 'network packets dropped %' : 'CPU ready %';

      const findings            = [];
      if (max > 10000) {
        findings.push(warning('vcfops.realtime.wide', `${max} objects in one latest-stats query is a heavy call. Narrow it to a cluster’s objects if it times out.`, { source: SRC }));
      }

      const script = readScript(OPS, `Top ${topN} ${kind} by ${label}, from the suite API.`, [
        ...workDirLines(OPS),
        ...PAGED_HELPERS,
        '',
        `KIND='${kind}'`,
        `KEY='${key}'`,
        `TOPN=${topN}`,
        `WARN_AT=${warnAt}`,
        `MAX=${max}`,
        `OBJECT_NAME="\${OBJECT_NAME:-${objectName}}"`,
        `HOURS=${hours}`,
        '',
        '# Every page of objects, into a file: 5000 ids are far over the 128 KB limit',
        '# on one argument.',
        'get_all "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=${KIND}" resourceList "$WORK/res.json" || exit 2',
        'jq --argjson max "$MAX" \'[.[:$max][] | {id: .identifier, name: .resourceKey.name}]\' "$WORK/res.json" > "$WORK/objs.json"',
        'N=$(jq length "$WORK/objs.json")',
        'TOTAL=$(jq length "$WORK/res.json")',
        'echo "${N} ${KIND} object(s)$( (( TOTAL > N )) && echo " of ${TOTAL} — raise MAX to look at the rest")"',
        '(( N > 0 )) || { echo "No ${KIND} objects returned: nothing to rank." >&2; exit 2; }',
        '',
        '# Latest value per object. The stat shape is read by recursion so a',
        '# difference in nesting between releases does not break it.',
        'jq --arg k "$KEY" \'{resourceId: [.[].id], statKey: [$k]}\' "$WORK/objs.json" | post /suite-api/api/resources/stats/latest/query > "$WORK/latest.json"',
        'jq -e \'has("values")\' "$WORK/latest.json" >/dev/null || { echo "stats/latest/query returned no values list — VERIFY the response shape." >&2; exit 2; }',
        'TOP=$(jq --slurpfile r "$WORK/objs.json" --argjson n "$TOPN" \'',
        '  ($r[0] | map({key: .id, value: .name}) | from_entries) as $names',
        '  | [.values[]? | {id: .resourceId, v: ([.. | objects | select(has("statKey")) | .data[-1]?] | .[0])}]',
        '  | map(select(.v != null)) | sort_by(-.v) | .[:$n] | map(. + {name: ($names[.id] // .id)})\' "$WORK/latest.json")',
        `printf '%-8s %s\\n' "${label.split(' ')[0]}" "object"`,
        'jq -r \'.[] | "\\(.v * 100 | round / 100)\\t\\(.name)"\' <<<"$TOP"',
        'OVER=$(jq --argjson w "$WARN_AT" \'[.[] | select(.v > $w)] | length\' <<<"$TOP")',
        '',
        'if [[ -n "$OBJECT_NAME" ]]; then',
        '  name_uri=$(jq -rn --arg v "$OBJECT_NAME" \'$v | @uri\')',
        '  key_uri=$(jq -rn --arg v "$KEY" \'$v | @uri\')',
        '  ID=$(get "/suite-api/api/resources?name=${name_uri}&resourceKind=${KIND}" | jq -r \'.resourceList[0].identifier // empty\')',
        '  if [[ -z "$ID" ]]; then',
        '    echo "No ${KIND} named $OBJECT_NAME" >&2',
        '  else',
        '    END=$(( $(date +%s) * 1000 )); BEGIN=$(( END - HOURS * 3600 * 1000 ))',
        '    echo; echo "$OBJECT_NAME, last ${HOURS}h (5-minute averages):"',
        '    get "/suite-api/api/resources/${ID}/stats?statKey=${key_uri}&begin=${BEGIN}&end=${END}&rollUpType=AVG&intervalType=MINUTES&intervalQuantifier=5" \\',
        '      | jq -r \'[.. | objects | select(has("statKey"))][0] | [.timestamps, .data] | transpose[] | "\\(.[0] / 1000 | todate)\\t\\(.[1])"\'',
        '  fi',
        'fi',
        '',
        '(( OVER == 0 )) || { echo "$OVER of the top ${TOPN} are above ${WARN_AT}" >&2; exit 1; }',
      ]);

      const promql = md([
        '# PromQL for VCF Operations 9.1 metric search.',
        '#',
        '# VERIFY: the metric names below are placeholders in angle brackets. 9.1',
        '# documents PromQL-based search but not the metric naming it exposes; open',
        '# metric search, find the metric, and copy its exact name and labels in.',
        '',
        `# Top ${topN} virtual machines by CPU ready, averaged over 5 minutes`,
        `topk(${topN}, avg_over_time(<vm_cpu_ready_percent>[5m]))`,
        '',
        `# Top ${topN} ESX hosts by CPU ready`,
        `topk(${topN}, avg_over_time(<host_cpu_ready_percent>[5m]))`,
        '',
        `# Top ${topN} ESX hosts by dropped packets (receive + transmit), per second`,
        `topk(${topN}, sum by (host) (rate(<host_net_dropped_rx_total>[5m]) + rate(<host_net_dropped_tx_total>[5m])))`,
        '',
        '# VMs whose CPU ready has been above 5% for the whole last 15 minutes',
        'min_over_time(<vm_cpu_ready_percent>[15m]) > 5',
        '',
        '# Save a query you use twice as a dashboard; 9.1 can build dashboards from PromQL.',
      ]);

      const session = md([
        '# Investigation — <title>',
        '',
        'Save this as a 9.1 investigation session so it has a lifecycle and can be shared.',
        '',
        '- Opened: <date, by>',
        '- Symptom: <what was reported, by whom, which objects>',
        '- Hypothesis: <e.g. CPU contention on cluster X since the 14:00 migration>',
        '',
        '## Queries run',
        '',
        `- queries.promql → top ${topN} by ${label}`,
        '- Real-time granularity: 20 s by default; set as low as 2 s for ESX metrics through policy while investigating, and put it back afterwards.',
        '- Network flows: traffic, volume, session count or flow count between the objects involved.',
        '',
        '## Commands run from the Actions tab',
        '',
        '| Tool | Target | Why | Result |',
        '|---|---|---|---|',
        '| | | | |',
        '',
        '## Outcome',
        '',
        '- Cause:',
        '- Fix / change:',
        '- Shared with:',
        '- Closed:',
      ]);

      const tools = md([
        '# Command-line tools in VCF Operations 9.1 (Actions tab)',
        '',
        'Run against an object from its Actions tab. Each one runs on the target, so treat it as a change-free read and record what you ran in the investigation.',
        '',
        '| Tool | Use it to |',
        '|---|---|',
        '| ipconfig | See the addresses and interfaces the guest actually has |',
        '| nslookup | Check a name resolves, and to what, from the target’s point of view |',
        '| dig | The same, with the full answer, TTLs and the server that gave it |',
        '| route | See which gateway traffic to a destination takes |',
        '| arp | Check the next hop’s MAC is what the network thinks it is |',
        '| netstat | See listening ports and established connections |',
        '| iptables | See the host firewall rules that apply |',
        '| tcpdump | Capture packets — keep the filter tight and the capture short |',
      ]);

      return {
        platform: OPS,
        title: `Real-time investigation — top ${topN} ${kind === 'HostSystem' ? 'ESX hosts' : 'VMs'} by ${label}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run by an engineer during an investigation.', worstCase: 'as often as someone runs it' },
        scope: {
          what: `Up to ${max} ${kind} objects, read for one metric; one object’s series when named.`,
          decidedBy: ['What the account can see.', `The object kind ${kind} under the VMware adapter.`],
          ifWrong: 'The top list is drawn from the wrong population. Nothing is changed.',
        },
        guardrails: [{ rule: 'Reads only', because: 'An investigation that changes the system while measuring it destroys its own evidence.' }],
        dryRun: ['It only reads.'],
        undo: ['Nothing to undo. If real-time granularity was lowered in a policy for the investigation, set it back.'],
        told: ['The terminal. Paste the output into the investigation session.'],
        requires: ['jq and bash 4.', 'A read-only VCF Operations account.'],
        files: { [`${base}.sh`]: script, 'queries.promql': promql, 'investigation-session.md': session, 'cli-tools.md': tools },
        notes: [
          'The suite API returns stats at the collection interval (five minutes by default), not at real-time granularity. The script is for when the PromQL view is not to hand; the 20-second (down to 2-second for ESX) series are in metric search.',
          `VERIFY: the stat key ${key} on ${kind} — copy it from the object’s metric picker if it differs.`,
          'VERIFY: no PromQL query API is documented for 9.1, only the metric search interface.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_vsan_ops',
    platform: OPS,
    label: 'vSAN storage operations report (health, findings, capacity)',
    group: 'Health',
    description:
      'A read-only daily report per vSAN cluster: its health score and active alerts, the diagnostic findings and performance insights 9.1 raises against it, and every capacity, efficiency and data-reduction metric it exposes — which is where the new effective-capacity view gets its numbers.',
    inputs: [
      { id: 'vsan_kind', label: 'vSAN cluster kind', control: 'text', default: 'VirtualAndPhysicalSANAdapter|VirtualSANDCCluster', hint: 'adapterKind|resourceKind. VERIFY with GET /suite-api/api/adapterkinds/VirtualAndPhysicalSANAdapter/resourcekinds' },
      { id: 'capacity_regex', label: 'Capacity metrics matching', control: 'text', default: 'capacity|effective|dedup|compression|savings|ratio|usable|overhead', hint: 'Regex over stat keys' },
      { id: 'health_below', label: 'Fail when health score is below', control: 'number', default: 75, min: 0, max: 100 },
      { id: 'fail_on_findings', label: 'Fail on critical findings', control: 'toggle', default: true },
      { id: 'webhook', label: 'Post problems to', control: 'text', default: '' },
    ],
    automation: (values                 , name        )             => {
      const vsanKind = str(values, 'vsan_kind', 'VirtualAndPhysicalSANAdapter|VirtualSANDCCluster');
      const [adapterKind = 'VirtualAndPhysicalSANAdapter', resourceKind = 'VirtualSANDCCluster'] = vsanKind.split('|');
      const capRx = str(values, 'capacity_regex', 'capacity');
      const below = num(values, 'health_below', 75);
      const failFindings = bool(values, 'fail_on_findings', true);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'vsan-ops-report', 'vsan-ops');

      const findings            = [];
      if (!/\|/.test(vsanKind)) findings.push(error('vcfops.vsan.kind', 'The kind must be adapterKind|resourceKind.', { source: SRC }));

      const script = readScript(OPS, 'vSAN clusters: health, active alerts, findings and capacity metrics.', [
        ...workDirLines(OPS),
        ...PAGED_HELPERS,
        ...WEBHOOK_HELPER,
        '',
        `AK='${adapterKind.replace(/'/g, '')}'`,
        `RK='${resourceKind.replace(/'/g, '')}'`,
        `CAP_RX='${capRx.replace(/'/g, '')}'`,
        `BELOW=${below}`,
        `FAIL_FINDINGS=${failFindings ? 1 : 0}`,
        'STAMP=$(date +%Y%m%d)',
        'PROBLEMS=()',
        '',
        'rk_uri=$(jq -rn --arg v "$RK" \'$v | @uri\')',
        'get_all "/suite-api/api/resources?adapterKind=${AK}&resourceKind=${rk_uri}" resourceList "$WORK/res.json" || exit 2',
        'jq \'[.[] | {id: .identifier, name: .resourceKey.name, health: (.resourceHealth // "UNKNOWN"), score: (.resourceHealthValue // null)}]\' "$WORK/res.json" > "$WORK/clusters.json"',
        'N=$(jq length "$WORK/clusters.json")',
        'echo "$N vSAN cluster(s)"',
        '(( N > 0 )) || { echo "No vSAN clusters returned for $AK / $RK — check the kind key and the vSAN adapter." >&2; exit 1; }',
        '',
        '# Active alerts: the query form (GET /alerts has no activeOnly), every page.',
        'echo \'{"activeOnly": true}\' > "$WORK/active.json"',
        'post_all /suite-api/api/alerts/query alerts "$WORK/alerts-raw.json" "$WORK/active.json" || exit 2',
        'jq \'[.[] | {resourceId, level: .alertLevel, name: .alertDefinitionName}]\' "$WORK/alerts-raw.json" > "$WORK/alerts.json"',
        '',
        '# Findings raised by the vSAN adapter — diagnostics findings from the vSAN',
        '# Health Service and, VERIFY, performance insights. Either findings path; if',
        '# neither answers, that is a failure, not "no findings".',
        'jq -n --arg ak "$AK" \'{filter: {adapterKinds: [$ak]}}\' > "$WORK/fbody.json"',
        'FOUND_PATH=""',
        'for p in /suite-api/api/diagnostics/findings/query /suite-api/api/findings/query; do',
        '  if post "${p}?page=0&pageSize=1" < "$WORK/fbody.json" >/dev/null 2>&1; then FOUND_PATH="$p"; break; fi',
        'done',
        '[[ -n "$FOUND_PATH" ]] || { echo "Neither findings path answered — is this VCF Operations 9.1 or later?" >&2; exit 2; }',
        'post_all "$FOUND_PATH" findings "$WORK/findings.json" "$WORK/fbody.json" || exit 2',
        '',
        ': > "$WORK/out.items"',
        'while IFS= read -r c; do',
        '  id=$(jq -r .id <<<"$c")',
        '  get "/suite-api/api/resources/${id}/stats/latest" > "$WORK/cap-raw.json" || { echo "Could not read the latest stats of $(jq -r .name <<<"$c")." >&2; exit 2; }',
        '  jq --arg rx "$CAP_RX" \'[.. | objects | select(has("statKey")) | {key: .statKey.key, value: (.data[-1]? // null)}] | map(select(.key | test($rx; "i"))) | sort_by(.key)\' "$WORK/cap-raw.json" > "$WORK/cap.json"',
        '  jq -c --slurpfile cap "$WORK/cap.json" --slurpfile al "$WORK/alerts.json" \'. as $c | $c + {capacity: $cap[0], alerts: [$al[0][] | select(.resourceId == $c.id)]}\' <<<"$c" >> "$WORK/out.items"',
        'done < <(jq -c \'.[]\' "$WORK/clusters.json")',
        'jq -s . "$WORK/out.items" > "$WORK/out.json"',
        '',
        'jq -n --slurpfile clusters "$WORK/out.json" --slurpfile findings "$WORK/findings.json" \'{clusters: $clusters[0], findings: $findings[0]}\' > "vsan-ops-$STAMP.json"',
        'jq -r \'.[] | "\\n\\(.name)  health \\(.health) score \\(.score // "n/a")  alerts \\(.alerts | length)", (.capacity[] | "  \\(.key) = \\(.value)")\' "$WORK/out.json"',
        'echo; jq -r \'group_by(.category // "uncategorised")[] | "findings, \\(.[0].category // "uncategorised"): \\(length)"\' "$WORK/findings.json"',
        '',
        'jq -r --argjson b "$BELOW" \'.[] | select((.score != null and .score < $b) or (.alerts | map(select(.level == "CRITICAL")) | length) > 0) | "\\(.name): health \\(.health) score \\(.score), \\(.alerts | map(select(.level == "CRITICAL")) | length) critical alert(s)"\' "$WORK/out.json" > "$WORK/bad.txt"',
        'while IFS= read -r line; do PROBLEMS+=("$line"); done < "$WORK/bad.txt"',
        'if (( FAIL_FINDINGS )); then',
        '  C=$(jq \'[.[] | select((.severity // "") | test("critical"; "i"))] | length\' "$WORK/findings.json")',
        '  (( C == 0 )) || PROBLEMS+=("$C critical vSAN finding(s)")',
        'fi',
        '',
        'echo "Report: vsan-ops-$STAMP.json"',
        '(( ${#PROBLEMS[@]} == 0 )) && exit 0',
        'printf "PROBLEM: %s\\n" "${PROBLEMS[@]}" >&2',
        ...(webhook
          ? [`printf '%s\\n' "\${PROBLEMS[@]}" | jq -R . | jq -s '{source: "vsan-ops", problems: .}' > "$WORK/webhook.json"`, `post_webhook ${shq(webhook)} "$WORK/webhook.json"`]
          : []),
        'finish 1',
      ]);

      return {
        platform: OPS,
        title: `vSAN operations report — health below ${below}${failFindings ? ' or critical findings' : ''} fails`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Daily, from a scheduler outside VCF Operations', worstCase: 'once a day' },
        scope: {
          what: 'Every vSAN cluster VCF Operations knows about, with its alerts, its findings and its capacity metrics.',
          decidedBy: ['The vSAN adapter and the kind key.', 'The capacity regex, which decides which metrics appear.', 'What the account can see.'],
          ifWrong: 'A cluster outside the kind is not reported; no clusters at all fails the run. Nothing is changed.',
        },
        guardrails: [
          { rule: 'Reads only', because: 'Capacity reports are read by people deciding purchases; they must not be run with rights to change the thing they measure.' },
          { rule: 'Fails when no vSAN cluster is returned, and stops (exit 2) when alerts, findings or a cluster’s stats cannot be read', because: 'A broken vSAN adapter or a failed read otherwise produces an empty, reassuring report.' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f and a failed post exits 3', because: 'A problem report that did not arrive must not look like one that did.' }] : []),
        ],
        dryRun: ['It only reads. Run it once and compare one cluster’s numbers with Operate → Overview → Storage.'],
        undo: ['Nothing to undo.'],
        told: webhook ? [`${webhook}, when a check fails.`, 'The JSON report, daily.'] : ['The JSON report and the exit code.'],
        requires: ['The vSAN adapter configured in VCF Operations.', 'jq and bash 4.', 'A read-only account.'],
        files: {
          [`${base}.sh`]: script,
          'crontab.txt': `# Daily at 06:30. The script logs in for itself from the password file (mode 600).\n30 6 * * * cd /var/lib/vsan-ops && ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/${base}.sh >> /var/log/vsan-ops.log 2>&1\n`,
        },
        notes: [
          '9.1 vSAN Effective Capacity abstracts RAID policy and system overhead and shows the saving from deduplication and compression. The capacity section of this report lists the raw metrics behind it; the effective number itself is read in Operate → Overview → Storage.',
          'The vSAN Health Service scores a cluster out of 100 (100 is best) and 9.1 exposes its detailed findings with remediation guidance — those arrive here through the Findings API.',
          'VERIFY: whether performance insights surface through the Findings API or only in the Performance Insights view; the report groups findings by category so either shows.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_audit',
    platform: OPS,
    label: 'Audit trail: daily copy to an external store',
    group: 'Audit and compliance',
    description:
      'The 9.1 centralised audit trail, kept outside VCF Operations: a daily read-only export of the system audit report to S3, a remote host or a mounted share, the steps for the time-sliced CSV export of user activity, and — optionally — a forwarding rule that streams the underlying audit events to the same store as they happen.',
    inputs: [
      {
        id: 'store',
        label: 'Copy to',
        control: 'select',
        options: [
          { value: 's3', label: 'S3 bucket (aws cli)' },
          { value: 'scp', label: 'A remote host (scp)' },
          { value: 'dir', label: 'A mounted share or directory' },
        ],
        default: 's3',
      },
      { id: 'destination', label: 'Destination', control: 'text', default: 's3://audit-archive/vcf-operations/', hint: 's3://bucket/prefix/, user@host:/path/ or /mnt/audit/' },
      { id: 'hour', label: 'Run at (hour, local)', control: 'number', default: 2, min: 0, max: 23 },
      { id: 'keep_local_days', label: 'Keep local copies for (days)', control: 'number', default: 14, min: 1, max: 365 },
      { id: 'stream_events', label: 'Also stream audit events via log forwarding', control: 'toggle', default: false },
      { id: 'syslog_host', label: 'Audit collector (syslog TLS)', control: 'text', default: 'audit-collector.example.com', showWhen: { input: 'stream_events', equals: ['true'] } },
      { id: 'audit_filter', label: 'Audit events are those where text matches', control: 'text', default: '(?i)audit|session opened|login|logout|sudo', showWhen: { input: 'stream_events', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const store = str(values, 'store', 's3');
      const destination = str(values, 'destination', '');
      const hour = num(values, 'hour', 2);
      const keep = num(values, 'keep_local_days', 14);
      const stream = bool(values, 'stream_events', false);
      const syslogHost = str(values, 'syslog_host', '');
      const auditFilter = str(values, 'audit_filter', '');
      const base = slugOf(name || 'vcf-audit-export', 'vcf-audit');

      const findings            = [];
      if (!destination) findings.push(error('vcfops.audit.no-dest', 'No destination: the export would stay on the machine that made it.', { source: SRC }));
      if (store === 's3' && !/^s3:\/\//.test(destination)) findings.push(error('vcfops.audit.s3-uri', 'An S3 destination is written s3://bucket/prefix/.', { source: SRC }));
      if (store === 'scp' && !/^[^@\s]+@[^:\s]+:/.test(destination)) findings.push(error('vcfops.audit.scp-uri', 'An scp destination is written user@host:/path/.', { source: SRC }));
      if (store === 'dir' && !destination.startsWith('/')) findings.push(error('vcfops.audit.dir', 'A directory destination is an absolute path.', { source: SRC }));

      const copy =
        store === 's3'
          ? ['aws s3 cp "$FILE" "${DEST}$(basename "$FILE")" --only-show-errors']
          : store === 'scp'
            ? ['scp -q -o BatchMode=yes "$FILE" "${DEST}"']
            : ['mkdir -p "$DEST"', 'cp -p "$FILE" "$DEST/"'];

      const script = readScript(OPS, `Daily copy of the VCF Operations audit report to ${destination || 'an external store'}.`, [
        `DEST="\${AUDIT_DEST:-${destination}}"`,
        'DAY=$(date -d yesterday +%F 2>/dev/null || date -v-1d +%F)',
        'OUTDIR="${AUDIT_LOCAL_DIR:-/var/lib/vcf-audit}"',
        'mkdir -p "$OUTDIR"',
        'FILE="$OUTDIR/vcf-operations-audit-${VCFOPS_HOST}-${DAY}.json"',
        '',
        '# GET /api/audit/system is the documented audit endpoint in the 9.1 API',
        '# reference: the system audit report (users, roles and objects, with counts).',
        'get /suite-api/api/audit/system | jq -S --arg day "$DAY" --arg host "$VCFOPS_HOST" \'{exportedFor: $day, host: $host, report: .}\' > "$FILE"',
        '[[ -s "$FILE" ]] || { echo "empty audit report" >&2; exit 1; }',
        'sha256sum "$FILE" > "$FILE.sha256"',
        '',
        '# Copy, never delete, on the far side.',
        'for FILE in "$FILE" "$FILE.sha256"; do',
        ...copy.map((line) => `  ${line} || { echo "copy to $DEST failed" >&2; exit 1; }`),
        'done',
        '',
        `find "$OUTDIR" -name 'vcf-operations-audit-*' -mtime +${keep} -delete`,
        'echo "Audit report for $DAY copied to $DEST"',
      ]);

      const forwarding = {
        name: 'Audit events → external store',
        host: syslogHost,
        port: 6514,
        protocol: 'Syslog',
        transport: 'TCP',
        useSsl: true,
        enabled: true,
        filters: [{ field: 'text', operator: 'Matches Regex', value: auditFilter }],
      };

      const exportUi = md([
        '# Export the time-sliced audit trail (VCF Operations 9.1)',
        '',
        'The per-action audit records — who did what, across vCenter, NSX, VCF Operations, VKS and the other components — are in the 9.1 audit trail, a centralised, time-sliced view built on log management. The public API does not expose those records; the interface exports them.',
        '',
        '1. VCF Operations → Protect → Audit (VERIFY the exact menu name in your build).',
        '2. Choose the interval — yesterday, 00:00 to 24:00 — and expand the time slices to check the aggregated action summaries.',
        '3. Export as CSV.',
        `4. Copy the CSV beside the daily JSON in \`${destination || '<destination>'}\`, named \`vcf-audit-trail-<date>.csv\`.`,
        '',
        stream
          ? 'Log forwarding (audit-forwarding.json, created by apply-forwarding.sh) also streams the underlying audit events to the collector as they happen, so the CSV is a convenience rather than the record.'
          : 'For a record that does not depend on a person exporting it, turn on "Also stream audit events via log forwarding".',
      ]);

      return {
        platform: OPS,
        title: `Audit trail — daily copy to ${store === 's3' ? 'S3' : store === 'scp' ? 'a remote host' : 'a share'}${stream ? ', plus streamed audit events' : ''}`,
        effect: stream ? 'reversible' : 'read',
        trigger: { kind: 'schedule', detail: `Daily at ${String(hour).padStart(2, '0')}:10, covering the previous day`, worstCase: 'once a day' },
        scope: {
          what: `The system audit report of one VCF Operations instance${stream ? ', and every event matching the audit filter, forwarded as it is ingested' : ''}.`,
          decidedBy: ['The VCF Operations instance the script points at.', ...(stream ? ['The forwarding rule’s filter.'] : [])],
          ifWrong: stream ? 'A filter too narrow misses audit events; too wide sends ordinary logs to the audit store. The daily export is unaffected.' : 'Nothing is changed; a failed copy exits 1.',
        },
        guardrails: [
          { rule: 'The export reads from VCF Operations and only copies to the store — it never deletes there', because: 'An audit store a job can prune is not an audit store.' },
          { rule: 'Exits 1 on an empty report or a failed copy, and writes a SHA-256 beside each file', because: 'A missing day is found by the scheduler, and a changed file is found by the checksum.' },
          ...(stream ? [{ rule: 'Forwarded over TLS, filtered to audit events', because: 'Audit events carry user names and source addresses; they cross the network encrypted and nothing else goes with them.' }] : []),
        ],
        dryRun: ['Run it once by hand with AUDIT_DEST pointing at a scratch location and read the file.', ...(stream ? ['Run ./apply-forwarding.sh --dry-run, and after it is applied check the rule’s filter with PREVIEW in the Log Forwarding card.'] : [])],
        undo: ['Nothing to undo for the export.', ...(stream ? ['Turn the forwarding rule off. Events already sent stay in the store.'] : [])],
        told: [`${destination || 'The store'}, daily.`, ...(stream ? [`${syslogHost}, continuously.`] : [])],
        requires: [
          'jq, bash 4 and sha256sum.',
          store === 's3' ? 'The aws cli, with credentials from its own profile or instance role — write-only to the prefix is enough.' : store === 'scp' ? 'An SSH key for the job’s user, authorised on the destination.' : 'The share mounted before the job runs.',
          'A read-only VCF Operations account.',
        ],
        files: {
          [`${base}.sh`]: script,
          'crontab.txt': `# Daily. The script logs in for itself from the password file (mode 600).\n10 ${hour} * * * ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/${base}.sh >> /var/log/vcf-audit.log 2>&1\n`,
          'EXPORT-AUDIT-TRAIL.md': exportUi,
          ...(stream
            ? {
                'audit-forwarding.json': json(forwarding),
                'apply-forwarding.sh': logsApplyScript({
                  purpose: `Create the log forwarding rule that streams audit events to ${syslogHost}, enabled.`,
                  calls: [{ what: 'audit forwarding rule', key: 'forwarding', path: '/api/v1/forwarding', payload: 'audit-forwarding.json', name: forwarding.name }],
                  undo: 'turn the rule off in the Log Forwarding card; events already sent stay in the store.',
                  manual: 'EXPORT-AUDIT-TRAIL.md',
                }),
              }
            : {}),
        },
        notes: [
          'The 9.1 API reference documents one audit operation, GET /api/audit/system ("Get system audit report": auditReports[].name and audits[] with name and count). It is a summary, not the per-action trail — which is why the trail itself goes out through the CSV export or log forwarding.',
          'Make the destination write-once where the store allows it: S3 Object Lock, or a share the job can write but not delete on.',
          ...(stream ? [logsApplyNote(), 'VERIFY the audit filter with PREVIEW: 9.1 does not document a single field that marks audit events.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_workload_automation',
    platform: OPS,
    label: 'Workload Automation and business intent for a datacenter (9.1)',
    group: 'Workload Automation',
    description:
      'Workload Automation settings for a datacenter or custom datacenter — balance level, consolidation, cluster headroom, 9.1 storage-based eviction, business-intent placement by vSphere tag (cluster- or host-based, for licence-bound workloads), the optimisation schedule and whether it runs automatically — applied to the policy that covers it by export, merge and import, with the export kept as the undo.',
    inputs: [
      {
        id: 'scope_kind',
        label: 'Optimise',
        control: 'select',
        options: [
          { value: 'Datacenter', label: 'A vCenter datacenter' },
          { value: 'CustomDatacenter', label: 'A custom datacenter' },
        ],
        default: 'Datacenter',
      },
      { id: 'scope_name', label: 'Named', control: 'text', default: 'DC1' },
      { id: 'policy_name', label: 'In policy', control: 'text', default: 'Tier 1 production', hint: 'The policy that covers the datacenter. Its id is looked up by name' },
      {
        id: 'balance',
        label: 'Balance',
        control: 'select',
        options: [
          { value: 'CONSERVATIVE', label: 'Conservative — move only when a cluster is under stress' },
          { value: 'MODERATE', label: 'Moderate' },
          { value: 'AGGRESSIVE', label: 'Aggressive — keep clusters evenly loaded' },
        ],
        default: 'MODERATE',
      },
      { id: 'consolidate', label: 'Consolidate workloads', control: 'toggle', default: false, hint: 'Packs VMs onto fewer clusters to free whole clusters' },
      {
        id: 'consolidation_level',
        label: 'Consolidation',
        control: 'select',
        options: [
          { value: 'CONSERVATIVE', label: 'Conservative' },
          { value: 'MODERATE', label: 'Moderate' },
          { value: 'AGGRESSIVE', label: 'Aggressive' },
        ],
        default: 'CONSERVATIVE',
        showWhen: { input: 'consolidate', equals: ['true'] },
      },
      { id: 'headroom_pct', label: 'Cluster headroom (%)', control: 'number', default: 20, min: 0, max: 50, hint: 'Capacity kept free on every cluster; placement treats it as used' },
      { id: 'storage_eviction', label: 'Storage-based eviction (9.1)', control: 'toggle', default: true, hint: 'Also move VMs off a cluster whose datastores are under pressure' },
      {
        id: 'intent',
        label: 'Business intent placement',
        control: 'select',
        options: [
          { value: 'NONE', label: 'None' },
          { value: 'CLUSTER', label: 'Cluster-based — VMs go to clusters with the matching tag' },
          { value: 'HOST', label: 'Host-based — VMs go to hosts with the matching tag (licence-bound workloads)' },
        ],
        default: 'HOST',
      },
      { id: 'intent_categories', label: 'Match tags in categories', control: 'text', default: 'License, Environment', hint: 'Comma separated vSphere tag categories. A VM is placed where the tag in each category matches its own', showWhen: { input: 'intent', notEquals: ['NONE'] } },
      {
        id: 'schedule',
        label: 'Optimise on a schedule',
        control: 'select',
        options: [
          { value: 'NONE', label: 'No schedule' },
          { value: 'DAILY', label: 'Daily' },
          { value: 'WEEKLY', label: 'Weekly' },
          { value: 'MONTHLY', label: 'Monthly, first week' },
        ],
        default: 'WEEKLY',
      },
      {
        id: 'schedule_day',
        label: 'On',
        control: 'select',
        options: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].map((day) => ({ value: day, label: day.charAt(0) + day.slice(1).toLowerCase() })),
        default: 'SUNDAY',
        showWhen: { input: 'schedule', equals: ['WEEKLY', 'MONTHLY'] },
      },
      { id: 'schedule_time', label: 'At (HH:MM, VCF Operations time zone)', control: 'text', default: '02:00', showWhen: { input: 'schedule', notEquals: ['NONE'] } },
      { id: 'automate', label: 'Automate (act without asking)', control: 'toggle', default: true, hint: 'Off leaves optimisation as a recommendation someone runs' },
    ],
    automation: (values                 , name        )             => {
      const scopeKind = str(values, 'scope_kind', 'Datacenter');
      const scopeName = str(values, 'scope_name', '');
      const policy = str(values, 'policy_name', '');
      const balance = str(values, 'balance', 'MODERATE');
      const consolidate = bool(values, 'consolidate', false);
      const consolidation = consolidate ? str(values, 'consolidation_level', 'CONSERVATIVE') : 'OFF';
      const headroom = num(values, 'headroom_pct', 20);
      const eviction = bool(values, 'storage_eviction', true);
      const intent = str(values, 'intent', 'HOST');
      const categories = intent === 'NONE' ? [] : listOf(str(values, 'intent_categories', ''));
      const schedule = str(values, 'schedule', 'WEEKLY');
      const day = str(values, 'schedule_day', 'SUNDAY');
      const time = str(values, 'schedule_time', '02:00');
      const automate = bool(values, 'automate', true);
      const base = slugOf(name || `workload-automation-${scopeName}`, 'workload-automation');
      const scopeLabel = scopeKind === 'CustomDatacenter' ? 'custom datacenter' : 'datacenter';
      const when = schedule === 'NONE' ? 'whenever it is needed' : schedule === 'DAILY' ? `daily at ${time}` : schedule === 'WEEKLY' ? `every ${day.toLowerCase()} at ${time}` : `on the first ${day.toLowerCase()} of the month at ${time}`;

      const findings            = [];
      if (!scopeName) findings.push(error('vcfops.wla.no-scope', `No ${scopeLabel} named.`, { source: SRC }));
      if (!policy) findings.push(error('vcfops.wla.no-policy', 'No policy: Workload Automation settings live in the policy that covers the datacenter.', { source: SRC }));
      if (/default/i.test(policy)) {
        findings.push(warning('vcfops.wla.default-policy', 'The default policy covers every datacenter; these settings would move VMs everywhere it applies.', { remediation: 'Use a policy assigned to this datacenter’s group.', source: SRC }));
      }
      if (intent !== 'NONE' && categories.length === 0) {
        findings.push(error('vcfops.wla.no-categories', 'Business intent placement with no tag category matches nothing.', { remediation: 'Name the tag categories whose values must match, e.g. License.', source: SRC }));
      }
      if (intent === 'HOST' && !categories.some((c) => /licen[cs]e/i.test(c))) {
        findings.push(info('vcfops.wla.host-intent', 'Host-based intent is what licence-bound workloads (per-host database or OS licences) need; the categories named do not look like a licence category.', { source: SRC }));
      }
      if (balance === 'AGGRESSIVE' && headroom < 10) {
        findings.push(warning('vcfops.wla.churn', `Aggressive balancing with ${headroom}% headroom: VMs move often and clusters sit close to full.`, { remediation: 'Keep at least 10–20% headroom, or balance less aggressively.', source: SRC }));
      }
      if (consolidate && consolidation === 'AGGRESSIVE' && headroom < 15) {
        findings.push(warning('vcfops.wla.pack', 'Aggressive consolidation with little headroom packs clusters to the point where one host failure has nowhere to go.', { remediation: 'Keep headroom at least one host’s worth of capacity per cluster.', source: SRC }));
      }
      if (schedule !== 'NONE' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) findings.push(error('vcfops.wla.time', `"${time}" is not HH:MM.`, { source: SRC }));
      if (automate && schedule === 'NONE') {
        findings.push(info('vcfops.wla.unscheduled', 'Automated with no schedule: VMs move whenever the datacenter goes out of balance, at any hour.', { remediation: 'A weekly window in the quiet hours keeps vMotion traffic out of the working day.', source: SRC }));
      }

      const settings = {
        scope: { resourceKind: scopeKind, name: scopeName },
        policy,
        workloadAutomation: {
          balanceLevel: balance,
          consolidationLevel: consolidation,
          clusterHeadroomPercent: headroom,
          storageBasedEviction: eviction,
          businessIntent: { placement: intent, tagCategories: categories },
          schedule: schedule === 'NONE' ? null : { recurrence: schedule, ...(schedule === 'DAILY' ? {} : { dayOfWeek: day }), time },
          automate,
        },
      };

      const merge = [
        '#!/usr/bin/env bash',
        `# Workload Automation for the ${scopeLabel} "${scopeName}", in the policy "${policy}".`,
        '#',
        '# Checks the datacenter exists, exports the policy (kept as the undo), merges',
        '# the Workload Automation settings from workload-automation.json into its XML,',
        '# shows what changed, and imports it: POST /suite-api/api/policies/import?',
        '# forceImport=true. Applies when run; --dry-run stops before the import.',
        'set -euo pipefail',
        '',
        ...authPreamble(OPS),
        'for tool in curl jq python3; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
        'EXECUTE=1',
        '[[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'mkdir -p "$HERE/import"',
        'api() { curl -sS -f "https://${VCFOPS_HOST}/suite-api/api/$1" -H "' + authHeader(OPS) + '" -H "Accept: application/json"; }',
        '',
        `SCOPE_KIND=${sq(scopeKind)}`,
        `SCOPE_NAME=${sq(scopeName)}`,
        `POLICY_NAME=${sq(policy)}`,
        'N=$(api "resources?resourceKind=${SCOPE_KIND}&name=$(jq -rn --arg v "$SCOPE_NAME" \'$v | @uri\')" | jq --arg n "$SCOPE_NAME" \'[.resourceList[]? | select(.resourceKey.name == $n)] | length\')',
        '(( N == 1 )) || { echo "Expected one $SCOPE_KIND named $SCOPE_NAME, found $N. Nothing changed." >&2; exit 1; }',
        'if [[ -z "${POLICY_ID:-}" ]]; then',
        '  POLICY_ID=$(api policies | jq -r --arg n "$POLICY_NAME" \'[.. | objects | select(.name? == $n) | .id] | map(select(. != null)) | .[0] // empty\')',
        'fi',
        '[[ -n "$POLICY_ID" ]] || { echo "No policy named $POLICY_NAME (set POLICY_ID to override the lookup). Nothing changed." >&2; exit 1; }',
        '',
        'BEFORE="$HERE/policy-before-$(date +%Y%m%d-%H%M%S).zip"',
        `curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=\${POLICY_ID}" -H "${authHeader(OPS)}" -H "Accept: application/zip" -o "$BEFORE"`,
        'echo "Exported the policy as it is now: $BEFORE (the undo)"',
        '',
        `python3 - "$BEFORE" "$HERE/workload-automation.json" "$HERE/import/policy-merged.zip" <<'PY'`,
        'import json, re, sys, zipfile, xml.etree.ElementTree as ET',
        'src, spec_path, out = sys.argv[1:4]',
        'spec = json.load(open(spec_path, encoding="utf-8"))["workloadAutomation"]',
        'with zipfile.ZipFile(src) as z:',
        '    names = z.namelist()',
        '    xmls = [n for n in names if n.lower().endswith(".xml")]',
        '    if len(xmls) != 1:',
        '        sys.exit("expected one XML file in the policy export, found %r" % xmls)',
        '    name = xmls[0]',
        '    raw = z.read(name)',
        '    others = {n: z.read(n) for n in names if n != name}',
        'for prefix, uri in re.findall(r\'xmlns(?::([A-Za-z_][\\w.-]*))?="([^"]+)"\', raw.decode("utf-8")):',
        '    ET.register_namespace(prefix or "", uri)',
        'root = ET.fromstring(raw)',
        'policies = root.findall(".//{*}Policy")',
        'if len(policies) != 1:',
        '    sys.exit("expected exactly one <Policy> in the export, found %d" % len(policies))',
        'policy = policies[0]',
        'ns = policy.tag[: policy.tag.index("}") + 1] if policy.tag.startswith("{") else ""',
        'package = policy.find("{*}PackageSettings")',
        'if package is None:',
        '    package = ET.SubElement(policy, ns + "PackageSettings")',
        '# VERIFY: the element and attribute names. An export of a policy where Workload',
        '# Automation was set once in the interface shows the names your release uses;',
        '# an existing element whose name mentions workload automation or optimization',
        '# is updated in place, so those names win over the ones below.',
        'target = None',
        'for el in package.iter():',
        '    local = el.tag.split("}")[-1]',
        '    if re.search(r"workload.?(automation|optimi[sz]ation)", local, re.I):',
        '        target = el',
        '        break',
        'if target is None:',
        '    target = ET.SubElement(package, ns + "WorkloadAutomation")',
        'before = ET.tostring(target, encoding="unicode")',
        'attrs = {',
        '    "balanceLevel": spec["balanceLevel"],',
        '    "consolidationLevel": spec["consolidationLevel"],',
        '    "clusterHeadroom": str(spec["clusterHeadroomPercent"]),',
        '    "storageBasedEviction": str(spec["storageBasedEviction"]).lower(),',
        '    "automate": str(spec["automate"]).lower(),',
        '}',
        'for key, value in attrs.items():',
        '    target.set(key, value)',
        'for child in list(target):',
        '    if child.tag.split("}")[-1] in ("BusinessIntent", "Schedule"):',
        '        target.remove(child)',
        'intent = spec["businessIntent"]',
        'if intent["placement"] != "NONE":',
        '    bi = ET.SubElement(target, ns + "BusinessIntent", {"placement": intent["placement"]})',
        '    for category in intent["tagCategories"]:',
        '        ET.SubElement(bi, ns + "TagCategory", {"name": category})',
        'if spec["schedule"]:',
        '    ET.SubElement(target, ns + "Schedule", {k: str(v) for k, v in spec["schedule"].items()})',
        'after = ET.tostring(target, encoding="unicode")',
        'print("before: " + before)',
        'print("after:  " + after)',
        'data = ET.tostring(root, encoding="utf-8", xml_declaration=True)',
        'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:',
        '    z.writestr(name, data)',
        '    for n, b in others.items():',
        '        z.writestr(n, b)',
        'print("wrote " + out)',
        'PY',
        '',
        'if (( ! EXECUTE )); then',
        '  echo "DRY RUN: would POST import/policy-merged.zip to https://${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true"',
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        `curl -sS -f -X POST "https://\${VCFOPS_HOST}/suite-api/api/policies/import?forceImport=true" -H "${authHeader(OPS)}" -H "Accept: application/json" -F "policy=@$HERE/import/policy-merged.zip;type=application/zip"`,
        'echo',
        '# Read back: the policy must now carry the settings.',
        `curl -sS -f "https://\${VCFOPS_HOST}/suite-api/api/policies/export?id=\${POLICY_ID}" -H "${authHeader(OPS)}" -H "Accept: application/zip" -o "$HERE/policy-after.zip"`,
        'python3 -c \'import sys,zipfile,re; z=zipfile.ZipFile(sys.argv[1]); x=b"".join(z.read(n) for n in z.namelist() if n.lower().endswith(".xml")).decode("utf-8","replace"); sys.exit(0 if re.search(r"workload.?(automation|optimi[sz]ation)", x, re.I) else 1)\' "$HERE/policy-after.zip" \\',
        '  || { echo "Imported, but the policy read back carries no Workload Automation element: this release keeps it elsewhere. Set it from the APPLY.md steps; undo with $BEFORE." >&2; exit 1; }',
        'echo "Applied. Undo: import $BEFORE the same way (POST /suite-api/api/policies/import?forceImport=true)."',
        '',
      ].join('\n');

      return {
        platform: OPS,
        title: `Workload Automation for ${scopeLabel} "${scopeName}" — balance ${balance.toLowerCase()}, ${consolidate ? `consolidate ${consolidation.toLowerCase()}` : 'no consolidation'}, ${headroom}% headroom${intent !== 'NONE' ? `, ${intent.toLowerCase()}-based intent on ${categories.join(', ')}` : ''}, ${automate ? 'automated' : 'recommend only'} ${when}`,
        effect: 'reversible',
        trigger: { kind: automate ? 'schedule' : 'manual', detail: automate ? `Workload Automation acts on the ${scopeLabel} ${when}.` : `Optimisation is proposed ${when}; someone runs it from Workload Optimization.`, worstCase: automate ? `every VM in "${scopeName}" moved by vMotion ${when}` : 'never without someone pressing Optimize' },
        scope: {
          what: `Every VM in the ${scopeLabel} "${scopeName}", moved between its clusters${intent === 'HOST' ? ' and hosts' : ''}.`,
          decidedBy: [`The ${scopeLabel} "${scopeName}" and the clusters in it.`, `The policy "${policy}" that covers it, which carries these settings.`, 'DRS and its rules inside each cluster, which Workload Automation works with, not around.', ...(intent !== 'NONE' ? [`The vSphere tags in ${categories.join(', ')} on VMs, and on clusters${intent === 'HOST' ? ' and hosts' : ''}.`] : [])],
          ifWrong: 'VMs move between clusters when nobody expected it — vMotion load in the working day, or a licence-bound VM placed on a host that is not licensed for it when a tag is missing.',
        },
        guardrails: [
          { rule: 'The datacenter must exist exactly once, and the policy by name, before anything is changed', because: 'A typo must not end up as settings on the wrong policy.' },
          { rule: 'The policy is exported before the import and the export is kept; the merge prints the element before and after', because: 'The undo is that export, and the diff is what goes in the change.' },
          { rule: 'The policy is read back after the import and the script fails when the settings are not in it', because: 'A policy import that silently drops an element it does not know would otherwise look like success.' },
          ...(intent !== 'NONE' ? [{ rule: `Placement follows the tags in ${categories.join(', ')}`, because: 'A licence-bound VM goes only where the licence tag matches; untagged targets are not candidates.' }] : []),
        ],
        dryRun: ['Run ./apply-workload-automation.sh --dry-run: it checks the datacenter, exports and merges the policy, prints the change, and imports nothing.', `Leave "Automate" off for the first ${schedule === 'NONE' ? 'week' : 'run'}: Workload Optimization then shows what it would move without moving it.`],
        undo: ['Import policy-before-<time>.zip the same way (POST /suite-api/api/policies/import?forceImport=true). VMs already moved stay where they are.'],
        told: ['Workload Optimization shows each run and what it moved; vCenter records every vMotion as an event. Nobody is notified by default — add a notification rule on the optimisation alerts if they should be.'],
        requires: [`The ${scopeLabel} "${scopeName}" in VCF Operations${scopeKind === 'CustomDatacenter' ? ' (Custom Datacenters)' : ''}.`, `The policy "${policy}" assigned to the group that holds it.`, 'DRS fully automated on the clusters, and vMotion between them.', ...(intent !== 'NONE' ? [`vSphere tags in ${categories.join(', ')} on the VMs and on the target ${intent === 'HOST' ? 'hosts' : 'clusters'}.`] : []), 'curl, jq and python3.'],
        files: {
          'workload-automation.json': json(settings),
          'apply-workload-automation.sh': merge,
          [`${base}-APPLY.md`]: md([
            `# Workload Automation for "${scopeName}" by hand (only where the script stops)`,
            '',
            '`./apply-workload-automation.sh` applies all of this through the policy. Where the read-back says the settings are not in the policy on your release, set them here:',
            '',
            `1. Infrastructure Operations → Configurations → Policies → "${policy}" → Edit → Workload Automation.`,
            `2. Balance: ${balance.toLowerCase()}. Consolidate: ${consolidate ? consolidation.toLowerCase() : 'off'}. Cluster headroom: ${headroom}%. Storage-based eviction: ${eviction ? 'on' : 'off'}.`,
            ...(intent !== 'NONE' ? [`3. Business intent: ${intent === 'HOST' ? 'host-based' : 'cluster-based'} placement, tag categories ${categories.join(', ')}.`] : ['3. Business intent: none.']),
            '4. Save.',
            `5. Optimize → Workload Optimization → ${scopeName} → ${automate ? 'Automate on' : 'Automate off'}${schedule !== 'NONE' ? `; Schedule → ${when}` : ''}.`,
          ]),
        },
        notes: [
          'VERIFY: the policy XML element and attribute names for Workload Automation (WorkloadAutomation, balanceLevel, consolidationLevel, clusterHeadroom, storageBasedEviction, automate, BusinessIntent, Schedule) are not published. The script updates an existing workload-automation element in place when the export has one, and fails loudly on read-back when the release keeps the settings elsewhere.',
          '9.1 adds storage-based eviction: balancing also considers datastore pressure, not only CPU and memory.',
          'Business intent needs the same tag categories on VMs and on targets. A VM whose tag matches no target is left where it is and flagged, not moved.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_security_posture',
    platform: OPS,
    label: 'Security Posture Management drift report, and confidential computing hosts',
    group: 'Audit and compliance',
    description:
      'A weekly read of 9.1 Security Posture Management against the benchmarks it ships — the VCF 9.x Security Configuration Guide, PCI DSS v4.0.1 for VCF 9 and VCF 9 General Controls, one or all three — what fails now, what is newly failing since last week and what was fixed — plus a report of which ESX hosts the platform profiles as confidential-computing capable. Reports only; remediation stays in the interface and in change.',
    inputs: [
      {
        id: 'benchmark',
        label: 'Benchmark',
        control: 'select',
        options: [
          { value: 'VCF 9.x Security Configuration Guide v1.0', label: 'VCF 9.x Security Configuration Guide v1.0' },
          { value: 'PCI DSS v4.0.1 for VCF 9 v1.0', label: 'PCI DSS v4.0.1 for VCF 9 v1.0' },
          { value: 'VCF 9 General Controls v1.0', label: 'VCF 9 General Controls v1.0' },
          { value: 'ALL', label: 'All three, each with its own drift' },
        ],
        default: 'VCF 9.x Security Configuration Guide v1.0',
      },
      { id: 'policy_name', label: 'Enabled in policy', control: 'text', default: 'Tier 1 production' },
      {
        id: 'source',
        label: 'Read results from',
        control: 'select',
        options: [
          { value: 'alerts', label: 'Compliance alerts through the suite API' },
          { value: 'csv', label: 'The View Results CSV export' },
        ],
        default: 'alerts',
      },
      { id: 'rule_filter', label: 'Only alerts named like', control: 'text', default: '', hint: 'Regex on the alert name, to separate this benchmark from others. Empty takes every compliance alert', showWhen: { input: 'source', equals: ['alerts'] } },
      { id: 'fail_on_new', label: 'Fail on any new failure', control: 'toggle', default: true },
      { id: 'fail_over', label: 'Also fail when total failures exceed', control: 'number', default: 0, min: 0, max: 1000000, hint: '0 turns this off' },
      { id: 'confidential', label: 'Include the confidential computing report', control: 'toggle', default: true },
      { id: 'max_hosts', label: 'At most (hosts)', control: 'number', default: 500, min: 1, max: 5000, showWhen: { input: 'confidential', equals: ['true'] } },
      { id: 'webhook', label: 'Weekly report to', control: 'text', default: 'https://runbooks.example.com/hooks/security-posture' },
    ],
    automation: (values                 , name        )             => {
      const benchmark = str(values, 'benchmark', 'VCF 9.x Security Configuration Guide v1.0');
      const policy = str(values, 'policy_name', '');
      const source = str(values, 'source', 'alerts');
      const ruleFilter = str(values, 'rule_filter', '');
      const failNew = bool(values, 'fail_on_new', true);
      const failOver = num(values, 'fail_over', 0);
      const confidential = bool(values, 'confidential', true);
      const maxHosts = num(values, 'max_hosts', 500);
      const webhook = str(values, 'webhook', '');
      const base = slugOf(name || 'security-posture', 'security-posture');
      const SPM_BENCHMARKS = ['VCF 9.x Security Configuration Guide v1.0', 'PCI DSS v4.0.1 for VCF 9 v1.0', 'VCF 9 General Controls v1.0'];
      const benchmarks = benchmark === 'ALL' ? SPM_BENCHMARKS : [benchmark];
      const benchLabel = benchmark === 'ALL' ? 'All 9.1 Security Posture Management benchmarks' : benchmark;
      const pci = benchmarks.some((b) => /PCI/.test(b));

      const findings            = [];
      if (/default/i.test(policy)) {
        findings.push(
          warning('vcfops.spm.default-policy', 'The benchmark’s scope is every object the assigned policy covers. In the default policy, that is the estate.', {
            remediation: pci ? 'PCI DSS applies to the cardholder-data environment. Assign the benchmark to a policy for that scope only.' : 'Start with a policy for one tier and widen it once the baseline is agreed.',
            source: SRC,
          }),
        );
      }
      if (source === 'alerts' && !ruleFilter) {
        findings.push(
          info('vcfops.spm.all-compliance', 'Without a name filter, the drift covers every compliance alert, including any 8.x-style packs still enabled.', {
            remediation: 'Set a regex that matches this benchmark’s rule names, or read the View Results CSV instead.',
            source: SRC,
          }),
        );
      }

      const slugOfBench = (b        )         => slugOf(b, 'benchmark');
      const drift = readScript(OPS, `Security Posture Management drift: ${benchLabel}.`, [
        ...workDirLines(OPS),
        ...PAGED_HELPERS,
        ...WEBHOOK_HELPER,
        '# One state directory per benchmark, so each has its own baseline and drift.',
        `BENCH="\${POSTURE_BENCHMARK:-${benchLabel}}"`,
        'SLUG=$(printf "%s" "$BENCH" | tr "A-Z" "a-z" | tr -c "a-z0-9" "-" | sed "s/--*/-/g; s/^-//; s/-$//")',
        'STATE_DIR="${POSTURE_STATE_DIR:-/var/lib/vcf-posture}/$SLUG"',
        'mkdir -p "$STATE_DIR"',
        `FAIL_NEW=${failNew ? 1 : 0}`,
        `FAIL_OVER=${failOver}`,
        'STAMP=$(date +%Y%m%d)',
        'CURRENT="$STATE_DIR/current-$STAMP.txt"',
        'PREVIOUS=$(ls -1 "$STATE_DIR"/current-*.txt 2>/dev/null | grep -v "$CURRENT" | tail -1 || true)',
        '',
        ...(source === 'csv'
          ? [
              '# Mode: the CSV exported from Protect → Security Posture Management → the',
              '# benchmark → View Results → Export. Pass its path as the first argument.',
              '# VERIFY: the column layout; each non-compliant row is kept whole, so drift',
              '# is by row and does not depend on knowing the columns.',
              'CSV="${1:?pass the View Results CSV export as the first argument}"',
              '[[ -r "$CSV" && -s "$CSV" ]] || { echo "$CSV is missing or empty: an empty export is not a clean result." >&2; exit 2; }',
              '(( $(wc -l < "$CSV") >= 2 )) || { echo "$CSV has a header and no rows: export the results again." >&2; exit 2; }',
              'tail -n +2 "$CSV" > "$WORK/rows.csv"',
              '# grep exits 1 when no row is non-compliant, which is a result, not an error.',
              '{ grep -i "non[- ]compliant" "$WORK/rows.csv" || [[ $? -eq 1 ]]; } | sort -u > "$WORK/current.txt"',
            ]
          : [
              '# Mode: active compliance alerts (subtype 21). VERIFY that 9.1 Security',
              '# Posture Management results raise compliance alerts in your build; if they',
              '# do not, switch this blueprint to the CSV mode.',
              `RULE_RX='${ruleFilter.replace(/'/g, '')}'`,
              '# The compliance alert definitions (subType 21) named like RULE_RX, then their',
              '# active alerts — every page, through files. None matching stops the run.',
              'get_all /suite-api/api/alertdefinitions alertDefinitions "$WORK/defs.json" || exit 2',
              'jq --arg rx "$RULE_RX" \'{activeOnly: true, alertDefinitionId: [.[] | select(.subType == 21 and ($rx == "" or ((.name // "") | test($rx; "i")))) | .id]}\' "$WORK/defs.json" > "$WORK/query.json"',
              '(( $(jq \'.alertDefinitionId | length\' "$WORK/query.json") > 0 )) || { echo "No compliance alert definition matches /$RULE_RX/: nothing to compare, which is not the same as compliant." >&2; exit 2; }',
              'post_all /suite-api/api/alerts/query alerts "$WORK/alerts.json" "$WORK/query.json" || exit 2',
              'jq -r \'.[] | "\\(.resourceId)\\t\\(.alertDefinitionName)"\' "$WORK/alerts.json" | sort -u > "$WORK/current.txt"',
            ]),
        '',
        '# Saved only once the whole result was read, so a failed run leaves no',
        '# half-written week behind to compare against.',
        'mv "$WORK/current.txt" "$CURRENT"',
        'TOTAL=$(wc -l < "$CURRENT" | tr -d " ")',
        '# New and fixed go through files: a first week of thousands of failures is',
        '# over the 128 KB limit on one argument.',
        'if [[ -n "$PREVIOUS" ]]; then',
        '  comm -13 "$PREVIOUS" "$CURRENT" > "$WORK/new.txt"',
        '  comm -23 "$PREVIOUS" "$CURRENT" > "$WORK/fixed.txt"',
        'else',
        '  : > "$WORK/new.txt"; : > "$WORK/fixed.txt"',
        '  echo "First run: this is the baseline, not drift."',
        'fi',
        'NEW_N=$(grep -c . "$WORK/new.txt" || true)',
        'FIXED_N=$(grep -c . "$WORK/fixed.txt" || true)',
        'echo "$BENCH: $TOTAL failing, $NEW_N new since last run, $FIXED_N fixed"',
        '(( NEW_N > 0 )) && { echo "NEW:"; sed "s/^/  /" "$WORK/new.txt"; }',
        '(( FIXED_N > 0 )) && { echo "FIXED:"; sed "s/^/  /" "$WORK/fixed.txt"; }',
        '',
        'jq -n --arg b "$BENCH" --argjson t "$TOTAL" --rawfile new "$WORK/new.txt" --rawfile fixed "$WORK/fixed.txt" \\',
        '  \'{benchmark: $b, failing: $t, new: ($new | split("\\n") | map(select(. != ""))), fixed: ($fixed | split("\\n") | map(select(. != "")))}\' > "$STATE_DIR/drift-$STAMP.json"',
        ...(webhook ? [`post_webhook ${shq(webhook)} "$STATE_DIR/drift-$STAMP.json"`] : []),
        '',
        'RC=0',
        '(( FAIL_NEW == 1 && NEW_N > 0 )) && RC=1',
        '(( FAIL_OVER > 0 && TOTAL > FAIL_OVER )) && RC=1',
        'finish $RC',
      ]);

      const cc = readScript(OPS, 'Which ESX hosts does VCF Operations profile as confidential-computing capable, and is it enabled?', [
        `MAX=${maxHosts}`,
        'STAMP=$(date +%Y%m%d)',
        '# VERIFY: 9.1 profiles hosts for confidential computing (AMD SEV-SNP, Intel TDX)',
        '# but does not document the property keys. This reads every host property',
        '# and keeps the ones whose names mention them, so it finds them whatever',
        '# they are called — and says so when it finds none.',
        'KEY_RX="${CC_KEY_RX:-sev|snp|tdx|sgx|confidential|trust.?domain}"',
        ...workDirLines(OPS),
        ...PAGED_HELPERS,
        'get_all "/suite-api/api/resources?adapterKind=VMWARE&resourceKind=HostSystem" resourceList "$WORK/hosts-raw.json" || exit 2',
        'jq -c --argjson max "$MAX" \'.[:$max][] | {id: .identifier, name: .resourceKey.name}\' "$WORK/hosts-raw.json" > "$WORK/hosts.items"',
        '[[ -s "$WORK/hosts.items" ]] || { echo "No ESX hosts returned." >&2; exit 2; }',
        'OUT="confidential-computing-$STAMP.json"',
        ': > "$WORK/out.items"',
        'while IFS= read -r h; do',
        '  id=$(jq -r .id <<<"$h")',
        '  # A host whose properties cannot be read stops the report rather than',
        '  # being listed as having none.',
        '  get "/suite-api/api/resources/${id}/properties" > "$WORK/props.json" || { echo "Could not read the properties of $(jq -r .name <<<"$h")." >&2; exit 2; }',
        '  jq -c --arg rx "$KEY_RX" --argjson h "$h" \'$h + {properties: ([.property[]? | select(.name | test($rx; "i")) | {(.name): .value}] | add // {})}\' "$WORK/props.json" >> "$WORK/out.items"',
        'done < "$WORK/hosts.items"',
        'jq -s . "$WORK/out.items" > "$OUT"',
        'jq -r \'.[] | "\\(.name)\\t\\(if (.properties | length) == 0 then "no confidential-computing properties reported" else (.properties | to_entries | map("\\(.key)=\\(.value)") | join("; ")) end)"\' "$OUT"',
        'FOUND=$(jq \'[.[] | select((.properties | length) > 0)] | length\' "$OUT")',
        'echo "$FOUND of $(jq length "$OUT") host(s) report confidential-computing properties."',
        '(( FOUND > 0 )) || echo "None found: check Protect → Security Operations for the capability view, and set CC_KEY_RX to the property names it uses." >&2',
      ]);

      return {
        platform: OPS,
        title: `${benchLabel} — weekly drift report${confidential ? ', with confidential computing hosts' : ''}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: 'Weekly, after the benchmark’s assessment has run', worstCase: 'once a week' },
        scope: {
          what: `Objects covered by the policy "${policy}", assessed against ${benchmarks.join(', ')}${confidential ? `; and up to ${maxHosts} ESX hosts for the confidential computing report` : ''}.`,
          decidedBy: [`The policy "${policy}" the benchmark is enabled in — the documented scope of an assessment is every object that policy covers.`, source === 'alerts' ? 'The compliance alerts it raises, narrowed by the name filter.' : 'The rows of the View Results export.'],
          ifWrong: 'The drift covers the wrong objects or rules. Nothing is changed either way; that is why remediation is not here.',
        },
        guardrails: [
          { rule: 'Reports; never remediates', because: 'Remediation in 9.1 is a button on the results page, and a hardening change applied by a scheduled job at 3am takes down the host an engineer is logged into.' },
          { rule: 'Drift is computed against last week’s saved result, and the first run says it is a baseline', because: 'A first report of four hundred failures is a starting point, not four hundred incidents.' },
          { rule: 'A missing or empty CSV, no matching compliance alert definition, or a failed read stops the run (exit 2) without writing a result', because: 'An empty result saved as this week’s would read as every rule fixed, and next week’s as every rule newly broken.' },
          ...(webhook ? [{ rule: 'The webhook post uses curl -f and a failed post exits 3', because: 'A drift report that did not arrive must not look like one that did.' }] : []),
        ],
        dryRun: ['It only reads. Run it twice, a day apart, and check the NEW and FIXED lists against the results page.'],
        undo: ['Nothing to undo. Delete the state directory to start a new baseline.'],
        told: webhook ? [`${webhook}, weekly, with failing, new and fixed.`] : ['The drift JSON in the state directory and the exit code.'],
        requires: [
          `${benchmarks.join(', ')} enabled: Protect → Security Posture Management → ⋮ → Enable Benchmark → assign "${policy}". No API to enable a benchmark is documented in 9.1, so this is the one manual step (see the ENABLE.md).`,
          'VERIFY licensing: the 9.1 Security Posture Management pages are published under VMware Advanced Cyber Compliance, and VMware’s 9.1 announcement ties the PCI and baseline benchmarks and remediation to that add-on.',
          'jq, bash 4 and coreutils comm.',
          'A read-only VCF Operations account.',
        ],
        files: {
          'posture-drift.sh': drift,
          ...(confidential ? { 'confidential-computing.sh': cc } : {}),
          'crontab.txt': `# Weekly, Monday 07:00. The scripts log in for themselves from the password file (mode 600).\n${
            source === 'csv'
              ? benchmarks.map((b) => `0 7 * * 1 POSTURE_BENCHMARK=${shq(b)} ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/posture-drift.sh /var/lib/vcf-posture/${slugOfBench(b)}/latest-results.csv >> /var/log/vcf-posture.log 2>&1\n`).join('')
              : `0 7 * * 1 ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/posture-drift.sh >> /var/log/vcf-posture.log 2>&1\n`
          }${confidential ? `5 7 * * 1 cd /var/lib/vcf-posture && ${scheduledEnv(OPS, 'svc-vcfops-readonly')} /usr/local/bin/confidential-computing.sh >> /var/log/vcf-posture.log 2>&1\n` : ''}`,
          [`${base}-ENABLE.md`]: md([
            `# ${benchLabel} in Security Posture Management (9.1)`,
            '',
            'No API to enable a benchmark or assign it to a policy is documented in 9.1: this is the one step done in the interface. Everything after it is read by posture-drift.sh.',
            '',
            '1. Protect → Security Posture Management.',
            ...benchmarks.map((b) => `2. ⋮ next to "${b}" → Enable Benchmark → assign "${policy}" → OK.`),
            '3. Open the benchmark → View Control Set. Rules marked with an asterisk need a site-specific value; Edit Rule and set them before the first assessment, or they report as failing.',
            '4. Run Assessment. Results appear under View Results as compliant, non-compliant or unknown, with a compliance score.',
            '5. Export as CSV from View Results for the record; generate the compliance report for the control-level summary.',
            '6. Remediation: select rules on the results page and run remediation — through change, not from this report.',
            '',
            ...(source === 'csv' ? [`7. Save each export where the crontab reads it: ${benchmarks.map((b) => `/var/lib/vcf-posture/${slugOfBench(b)}/latest-results.csv`).join(', ')}.`] : []),
            '',
            'Other benchmarks are offered from the Solutions Catalog (browse more benchmarks).',
          ]),
        },
        notes: [
          'Out of the box in 9.1 Security Posture Management: VCF 9.x Security Configuration Guide v1.0, PCI DSS v4.0.1 for VCF 9 v1.0, and VCF 9 General Controls v1.0. Compliance (with its CIS, DISA STIG, HIPAA and ISO 27001 packs) is deprecated in 9.1 and replaced by Security Posture Management; this is the blueprint for it.',
          'No public API for Security Posture Management results is documented in the 9.1 API reference; hence the two modes.',
          'Confidential computing: 9.1 profiles ESX hosts to find those capable of running confidential VMs (Intel TDX, AMD SEV-SNP) and shows whether it is enabled. The report reads what the host properties expose; the SecOps dashboard is the authoritative view.',
        ],
        findings,
      };
    },
  }),
].map(withScriptsImportMd);

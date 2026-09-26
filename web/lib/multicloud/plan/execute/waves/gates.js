/**
 * Go / no-go gates as the wave scripts see them (addendum A.7.3, WP-12):
 * the gate file schema, the per-wave `gates.md`, and the landing-zone gate
 * that keeps production waves waiting until the foundation is green
 * (research 6(e) 13 and master checklist F01–F14).
 *
 * The gate files themselves are written by the tracker (track/gates.ts
 * `gateFile`): `status/gates/wave-<n>-<slug>.json` with the slugs ready, go,
 * commit and decommission, and `status/gates/programme-lights-out.json`. The
 * scripts check them with `atk_gate G1..G5` (lib/atk.sh), which also accepts
 * `wave-<n>-G<k>.json`. Everything here is built on the same constants, so
 * the names cannot drift.
 *
 * The landing-zone gate is a programme-level file,
 * `status/gates/programme-landing-zone.json`, of its own kind
 * (`archtoolkit.landing-zone-gate`): the gate id enum of the migration-gate
 * schema (G1–G5) is left as it is.
 *
 * Pure: no DOM, no file system.
 */

import { ITEM_STATE_RANK, PLATFORM_LABELS } from '../../options.js';
                                                                                               
import { GATE_FILE_KIND, GATE_SLUG, gateFilePath } from '../../track/gates.js';
                                            

export { GATE_FILE_KIND, GATE_SLUG, gateFilePath };

// ---------------------------------------------------------------------------
// The gate file
// ---------------------------------------------------------------------------

/** JSON Schema of `status/gates/wave-<n>-<slug>.json` (the tracker's export, A.7.3), blockers included. */
export const GATE_FILE_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'gate.schema.json',
  title: 'Migration gate decision',
  type: 'object',
  required: ['kind', 'v', 'planId', 'wave', 'gate', 'decision', 'at', 'criteria', 'by'],
  properties: {
    kind: { const: GATE_FILE_KIND },
    v: { const: 1 },
    planId: { type: 'string', minLength: 1 },
    wave: { oneOf: [{ type: 'integer', minimum: 0 }, { const: 'programme' }] },
    gate: { enum: ['G1', 'G2', 'G3', 'G4', 'G5'] },
    decision: { enum: ['go', 'no-go'] },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' },
    by: { type: 'string', description: 'The RACI role that decided, never a name.' },
    comment: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'auto', 'met', 'detail'],
        properties: { id: { type: 'string' }, auto: { type: 'boolean' }, met: { type: 'boolean' }, detail: { type: 'string' } },
      },
    },
    blockers: {
      type: 'array',
      description: 'Open coupling blockers per item of the wave (the pre-check refuses these items).',
      items: { type: 'object', required: ['item', 'issues'], properties: { item: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } } },
    },
  },
});

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** What is wrong with a gate file (empty when it is valid), checked as the schema does. */
export function gateFileProblems(value         )           {
  const out           = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['not an object'];
  const o = value                           ;
  if (o['kind'] !== GATE_FILE_KIND) out.push('kind');
  if (o['v'] !== 1) out.push('v');
  if (typeof o['planId'] !== 'string' || !(o['planId']          )) out.push('planId');
  const w = o['wave'];
  if (!(w === 'programme' || (typeof w === 'number' && Number.isInteger(w) && w >= 0))) out.push('wave');
  if (!['G1', 'G2', 'G3', 'G4', 'G5'].includes(o['gate']          )) out.push('gate');
  if (!['go', 'no-go'].includes(o['decision']          )) out.push('decision');
  if (typeof o['at'] !== 'string' || !ISO.test(o['at']          )) out.push('at');
  if (typeof o['by'] !== 'string') out.push('by');
  const c = o['criteria'];
  if (!Array.isArray(c)) out.push('criteria');
  else c.forEach((x, i) => {
    const r = x                           ;
    if (!r || typeof r.id !== 'string' || typeof r.auto !== 'boolean' || typeof r.met !== 'boolean' || typeof r.detail !== 'string') out.push(`criteria[${i}]`);
  });
  if ('blockers' in o && !Array.isArray(o['blockers'])) out.push('blockers');
  return out;
}

// ---------------------------------------------------------------------------
// The gates, as the scripts and gates.md describe them
// ---------------------------------------------------------------------------

                           
                        
                         
                                                                
                        
                                   
                                     
                                                                           
                             
 

export const WAVE_GATES                      = Object.freeze([
  {
    gate: 'G1', title: 'Ready', when: 'T−5 days',
    auto: [
      'every item in sync (prepared for rebuild paths) and tested, or its test skipped with a rollback rehearsal (`rollback.sh --rehearse --item <nonprod item>`)',
      'no open coupling blockers', 'quotas checked (`precheck.sh`)', 'the change request approved',
    ],
    manual: ['the app owners’ test sign-off', 'the T−14 and T−2 notices sent'],
    checkedBy: 'precheck.sh --stage cutover (reported); the tracker decides',
  },
  {
    gate: 'G2', title: 'Go', when: 'T−1 (the go / no-go meeting, 24–48 hours before), checked at T−0 before the freeze',
    auto: ['`precheck.sh` passes', 'replication lag within the setting', 'a rollback path known for every item'],
    manual: ['the go decision by the RACI Accountable for cutover', 'the named rollback decision-maker present'],
    checkedBy: 'cutover.sh (step 0; exit 4 when it is not open)',
  },
  {
    gate: 'G3', title: 'Commit (point of no return)', when: 'after validation, at the end of the acceptance window',
    auto: ['validation passed for every item', 'no Sev1 / Sev2 open for the wave'],
    manual: ['the app owners’ acceptance'],
    checkedBy: 'commit.sh (exit 4 when it is not open)',
  },
  {
    gate: 'G4', title: 'Decommission', when: 'after the keep-days (by criticality)',
    auto: ['keep-days elapsed since cut-over', 'a first target backup succeeded per item (`decommission.sh --check-backups`)', 'no Sev1 / Sev2 for 7 days', 'no source still powered on (reconciliation)'],
    manual: ['the decommission approval'],
    checkedBy: 'decommission.sh (before any delete; exit 4 when it is not open)',
  },
  {
    gate: 'G5', title: 'Lights-out', when: 'programme end (data-centre exit)',
    auto: ['every item decommissioned or retired'],
    manual: ['the lights-out sign-off'],
    checkedBy: 'the data-centre exit runbook',
  },
]                     );

// ---------------------------------------------------------------------------
// Landing-zone gate (production waves wait for a green foundation)
// ---------------------------------------------------------------------------

export const LANDING_ZONE_GATE_KIND = 'archtoolkit.landing-zone-gate';
/** Relative to the project's `status/`. */
export const LANDING_ZONE_GATE_FILE = 'gates/programme-landing-zone.json';

                                 
                      
                        
                                                                            
                         
 

const METHODOLOGY = 'cloud-migration-methodologies research (b), master checklist F01–F14';

/** The foundation items of the master checklist (research (b) F01–F14). */
export const FOUNDATION_ITEMS                            = Object.freeze([
  { id: 'F01', text: 'Landing zone in place before production migration', auto: true },
  { id: 'F02', text: 'Landing zone built as code (the generated landing-zone Terraform applied)', auto: true },
  { id: 'F03', text: 'Resource hierarchy (accounts / subscriptions / projects / compartments / workload domains)', auto: false },
  { id: 'F04', text: 'Identity and access (hybrid identity; AD and DNS built first)', auto: false },
  { id: 'F05', text: 'Connectivity and IP plan (Direct Connect / ExpressRoute / Interconnect / FastConnect / VPN; HCX service mesh)', auto: false },
  { id: 'F06', text: 'Security baseline (CIS benchmark; Security Hub / Defender / SCC / Cloud Guard)', auto: false },
  { id: 'F07', text: 'Logging, monitoring and management baseline', auto: false },
  { id: 'F08', text: 'Governance guardrails (policy as code, naming, tagging)', auto: false },
  { id: 'F09', text: 'Budgets and cost controls', auto: false },
  { id: 'F10', text: 'Account / subscription / project vending', auto: false },
  { id: 'F11', text: 'Service quotas and capacity reservations checked', auto: false },
  { id: 'F12', text: 'Migration-tool prerequisites (IAM roles, ports, vault, buckets, appliance, VDDK)', auto: false },
  { id: 'F13', text: 'Shared services first (AD domain controllers, DNS)', auto: true },
  { id: 'F14', text: 'Backup and DR onboarding for migrated workloads', auto: false },
]                           );
export const FOUNDATION_SOURCE = METHODOLOGY;

                                       
                      
                                                                                              
                                                                                                  
                             
                                                          
                                                      
 

/**
 * The landing-zone gate's criteria: one per foundation item. F01 / F02 are met
 * when every target platform of a production wave has its landing zone
 * generated (`plan.execution.landingZones`); F13 when every item of the
 * foundation waves is accepted (or further) in the tracker, or there are
 * none; the rest are attestations.
 */
export function evaluateLandingZoneGate(input                      )                  {
  const prod = input.waves.filter((w) => w.production);
  const platforms = [...new Set(prod.flatMap((w) => w.platforms))].sort()              ;
  const lz = input.plan.execution?.landingZones ?? {};
  const missing = platforms.filter((p) => lz[p] !== 'generated');
  const label = (p          )         => PLATFORM_LABELS[p] ?? p;
  const foundationWaves = [...new Set(prod.flatMap((w) => w.foundationWaves))].sort((a, b) => a - b);
  const items = input.tracker ? Object.values(input.tracker.items).filter((s) => !s.removed && foundationWaves.includes(s.wave)) : [];
  const notGreen = items.filter((s) => ITEM_STATE_RANK[s.state] < ITEM_STATE_RANK.accepted).map((s) => s.item);
  const attest = (id        )          => input.attest?.[id] === true;
  return FOUNDATION_ITEMS.map((f)                => {
    if (f.id === 'F01' || f.id === 'F02') {
      return {
        id: `lz.${f.id}`, auto: true, met: platforms.length > 0 && missing.length === 0,
        detail: !platforms.length ? 'No production wave has a target platform yet.'
          : missing.length ? `Landing zone not generated for: ${missing.map(label).join(', ')}.` : `Landing zones generated for ${platforms.map(label).join(', ')}.`,
      };
    }
    if (f.id === 'F13') {
      const met = foundationWaves.length === 0 ? attest('F13') : input.tracker !== undefined && notGreen.length === 0;
      return {
        id: 'lz.F13', auto: foundationWaves.length > 0, met,
        detail: foundationWaves.length === 0 ? (met ? 'Shared services attested.' : 'No foundation wave: attest that AD and DNS are in place on the target.')
          : !input.tracker ? 'No tracker: the foundation waves cannot be checked.'
            : notGreen.length ? `Foundation wave item(s) not yet accepted: ${notGreen.slice(0, 5).join(', ')}${notGreen.length > 5 ? ` and ${notGreen.length - 5} more` : ''}.`
              : `Foundation wave(s) ${foundationWaves.join(', ')} accepted.`,
      };
    }
    return { id: `lz.${f.id}`, auto: false, met: attest(f.id), detail: attest(f.id) ? `${f.text}: attested.` : `${f.text}: not attested yet.` };
  });
}

/** The landing-zone gate file the pre-check reads (`status/gates/programme-landing-zone.json`). */
export function landingZoneGateFile(planId        , decision                , at        , by          , criteria                          , comment         )                                 {
  const body = { kind: LANDING_ZONE_GATE_KIND, v: 1, planId, wave: 'programme', gate: 'landing-zone', decision, at, criteria, by, ...(comment ? { comment } : {}) };
  return { path: LANDING_ZONE_GATE_FILE, text: `${JSON.stringify(body, null, 2)}\n` };
}

// ---------------------------------------------------------------------------
// gates.md
// ---------------------------------------------------------------------------

/** `waves/wave-<n>/gates.md`: the wave's gates, their files, criteria, timing and the override. */
export function renderGatesMd(wave          )         {
  const rows = WAVE_GATES.filter((g) => g.gate !== 'G5').map((g) =>
    `| **${g.gate} ${g.title}** | ${g.when} | \`status/${gateFilePath(wave.n, g.gate)}\` | ${g.auto.join('; ')} | ${g.manual.join('; ')} | ${g.checkedBy} |`);
  const lz = wave.production
    ? [
      '## Landing-zone gate',
      '',
      `This is a production wave, so \`precheck.sh\` also needs \`status/${LANDING_ZONE_GATE_FILE}\` (kind \`${LANDING_ZONE_GATE_KIND}\`) with \`decision: "go"\` for this plan: the foundation items below are green${wave.foundationWaves.length ? `, including the foundation wave(s) ${wave.foundationWaves.join(', ')}` : ''}. Target platforms: ${wave.platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(', ') || 'none'}.`,
      '',
      '| Item | Check | How |',
      '|---|---|---|',
      ...FOUNDATION_ITEMS.map((f) => `| ${f.id} | ${f.text} | ${f.auto ? 'evaluated from the plan and the tracker' : 'attested in the tracker'} |`),
      '',
      `Source: ${FOUNDATION_SOURCE}.`,
      '',
    ]
    : [];
  return [
    `# Wave ${wave.n}${wave.name ? `: ${wave.name}` : ''} — gates`,
    '',
    'Gates are decided in the tracker (Migration & Utilities › Track › Execute, **Record decision**), which downloads the gate file. Put it in the project’s `status/gates/` before running the script that checks it. A file counts only when its `decision` is `"go"` and its `planId` is this plan’s. The file names the role that decided, never a person.',
    '',
    '| Gate | When | File | Auto criteria | Manual criteria | Checked by |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    'A closed gate stops the script with exit 4. `--gate-override "<reason>"` proceeds anyway and records the reason in a `gate` event (`data.override = true`), which the tracker logs as a decision. There is no prompt: the operator owns the decision.',
    '',
    ...lz,
    '## Gate file',
    '',
    '```json',
    JSON.stringify({ kind: GATE_FILE_KIND, v: 1, planId: wave.planId, wave: wave.n, gate: 'G2', decision: 'go', at: 'yyyy-mm-ddThh:mm:ssZ', criteria: [{ id: 'g2.precheck', auto: true, met: true, detail: 'Pre-checks passed.' }], by: 'migration-lead', blockers: [] }, null, 2),
    '```',
    '',
  ].join('\n');
}

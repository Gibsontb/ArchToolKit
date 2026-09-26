/**
 * The default wave timeline and the runbook seeds (WP-12; research 6(e) 13
 * and 14, section 1.8).
 *
 * Timeline: the AWS communication-gate model (T−minus schedule, T−28 commit,
 * T−21 replication start, T−14 checkpoint, T−7 RFCs approved, T−1 go / no-go,
 * T−0 cutover, hypercare start, hypercare end), with this kit's own steps
 * placed on it: baselines at T−7 and T−1, DNS TTL lowered at T−2 (48 hours),
 * G1 at T−5, G2 decided at T−1 and checked at T−0, G3 after validation, G4
 * after the keep-days, and the landing-zone gate before the first production
 * wave. With a wave start date the rows are dated; without one they say T−n.
 *
 * Runbooks: seeded from the AWS cutover-runbook guide's pre-migration
 * checklist (P1–P15), cutover runbook (C1–C13, with milestones) and rollback
 * plan (R1–R10), with the provider's own step names per path and the kit's
 * commands beside each task.
 *
 * Pure: the dates are computed from the wave's start, never from "now".
 */

import type { ExecPath } from '../contract.ts';
import { DATA_LOSS, DATA_LOSS_DEFAULT, NO_TEST_PATHS, type WaveSpec } from './common.ts';
import { LANDING_ZONE_GATE_FILE } from './gates.ts';

export const GOVERNANCE_SOURCE = 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/task-follow-communication-gates.html';
export const CUTOVER_RUNBOOK_SOURCE = 'https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/cutover-runbook/cutover-runbook.pdf';

// ---------------------------------------------------------------------------
// The T-minus timeline
// ---------------------------------------------------------------------------

export type TimelineKind = 'comms-gate' | 'gate' | 'kit' | 'hypercare';

export interface TimelineRow {
  readonly id: string;
  /** Days from T−0 (the cutover day); business days for the hypercare rows. */
  readonly offset: number;
  readonly business?: boolean;
  /** 'T-28', 'T-0', 'T+1 (business)'. */
  readonly label: string;
  readonly title: string;
  readonly kind: TimelineKind;
  /** Exit criteria / what happens. */
  readonly exit: readonly string[];
  /** The kit command, relative to migration/execute/. */
  readonly command?: string;
  readonly source?: string;
  /** Only for production waves. */
  readonly productionOnly?: boolean;
}

/**
 * The AWS gates 1–9 (governance playbook) plus the kit's steps. Gate 1 has no
 * fixed day ("before the wave plan is complete"); the kit places it at T−35
 * so it sorts first (a toolkit default, not AWS guidance). Hypercare end
 * defaults to the item's hypercare days (by criticality) instead of AWS's
 * "typically 1–4 days".
 */
export const T_MINUS: readonly TimelineRow[] = Object.freeze([
  { id: 'aws-gate-1', offset: -35, label: 'T-35', title: 'Gate 1: T-minus schedule', kind: 'comms-gate', exit: ['Shared repository created', 'Per-wave T-minus schedule and task list', 'T-28 meeting booked', 'Wave plan and metadata finished by the portfolio team'], source: GOVERNANCE_SOURCE },
  { id: 'landing-zone', offset: -30, label: 'T-30', title: 'Landing-zone gate (production waves)', kind: 'gate', exit: ['Foundation items F01–F14 green', `status/${LANDING_ZONE_GATE_FILE} recorded with decision "go"`], command: 'waves/wave-<n>/precheck.sh --stage replicate', productionOnly: true },
  { id: 'aws-gate-2', offset: -28, label: 'T-28', title: 'Gate 2: T-28 commit meeting', kind: 'comms-gate', exit: ['Application owners commit and learn they must supply test plans', 'Escalation plan reviewed', 'RFCs submitted', 'T-14, T-1 and T-0 meetings booked'], source: GOVERNANCE_SOURCE },
  { id: 'aws-gate-3', offset: -21, label: 'T-21', title: 'Gate 3: T-21 communication, replication started', kind: 'comms-gate', exit: ['Source servers verified against the replication prerequisites', 'Replication started'], command: 'waves/wave-<n>/replicate.sh', source: GOVERNANCE_SOURCE },
  { id: 'aws-gate-4', offset: -14, label: 'T-14', title: 'Gate 4: T-14 checkpoint', kind: 'comms-gate', exit: ['Replication health checked', 'Test plans received', 'Attendance confirmed', 'T-14 notice sent'], command: 'waves/wave-<n>/replicate.sh --once', source: GOVERNANCE_SOURCE },
  { id: 'test', offset: -10, label: 'T-10', title: 'Test migration and UAT', kind: 'kit', exit: ['Per path test, validation on the test copies, the app owners’ UAT, test clean-up', 'Paths without a test: rollback rehearsal on a nonprod item'], command: 'waves/wave-<n>/test.sh' },
  { id: 'baseline-1', offset: -7, label: 'T-7', title: 'Performance baseline, first capture', kind: 'kit', exit: ['Three samples per host into status/baseline/'], command: 'waves/wave-<n>/validate.sh --baseline' },
  { id: 'aws-gate-5', offset: -7, label: 'T-7', title: 'Gate 5: T-7 communication', kind: 'comms-gate', exit: ['All RFCs approved', 'Target infrastructure validated', 'Test instances shut down', 'Cutover task list validated'], source: GOVERNANCE_SOURCE },
  { id: 'g1', offset: -5, label: 'T-5', title: 'G1 Ready', kind: 'gate', exit: ['Recorded in the tracker; gate file status/gates/wave-<n>-ready.json'], command: 'waves/wave-<n>/precheck.sh --stage cutover' },
  { id: 'dns-ttl', offset: -2, label: 'T-2', title: 'DNS TTL lowered to 300 s (48 hours ahead); T-2 notice sent', kind: 'kit', exit: ['Every record in dns/records.csv at or under 300 s'], command: 'dns/dns.sh ttl --set 300 --wave <n>' },
  { id: 'baseline-2', offset: -1, label: 'T-1', title: 'Performance baseline, second capture', kind: 'kit', exit: ['Three samples per host into status/baseline/'], command: 'waves/wave-<n>/validate.sh --baseline' },
  { id: 'aws-gate-6', offset: -1, label: 'T-1', title: 'Gate 6: T-1 go / no-go (G2), 24–48 hours before', kind: 'comms-gate', exit: ['Checklist reviewed with everyone in the RACI', 'Go: T-1 email sent; no-go: stakeholders told the decision and next steps', 'G2 recorded; gate file status/gates/wave-<n>-go.json'], source: GOVERNANCE_SOURCE },
  { id: 'aws-gate-7', offset: 0, label: 'T-0', title: 'Gate 7: T-0 cutover', kind: 'comms-gate', exit: ['Migrate with the runbook; application owners test straight away', 'An application that is not functioning, or has significant issues, is rolled back and moved to a later wave'], command: 'waves/wave-<n>/cutover.sh', source: GOVERNANCE_SOURCE },
  { id: 'g3', offset: 1, label: 'T+1', title: 'G3 Commit after acceptance (point of no return)', kind: 'gate', exit: ['Validation passed, no Sev1 / Sev2, the app owners’ acceptance'], command: 'waves/wave-<n>/commit.sh' },
  { id: 'aws-gate-8', offset: 1, business: true, label: 'T+1 (business)', title: 'Gate 8: hypercare start', kind: 'hypercare', exit: ['Stakeholders review', 'Issues fixed', 'Cloud operations confirms it is ready to take over'], source: GOVERNANCE_SOURCE },
  { id: 'aws-gate-9', offset: 4, business: true, label: 'T+hypercare', title: 'Gate 9: hypercare end', kind: 'hypercare', exit: ['Handoff to cloud operations', 'CMDB and ITSM updated', 'Hypercare-complete email sent', 'Post-move right-sizing proposals (rightsize-after.sh)', 'Source decommissioning can start'], command: 'rightsize-after.sh --wave <n>', source: GOVERNANCE_SOURCE },
  { id: 'g4', offset: 14, label: 'T+keep-days', title: 'G4 Decommission after the keep-days', kind: 'gate', exit: ['Keep-days elapsed, a target backup per item, no Sev1 / Sev2 for 7 days, no source still on, the decommission approval'], command: 'waves/wave-<n>/decommission.sh' },
] satisfies TimelineRow[]);

/** yyyy-mm-dd plus days (calendar, or business days skipping Saturday and Sunday). */
export function addDays(date: string, days: number, business = false): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  if (!business) {
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  let left = Math.abs(days);
  const step = days < 0 ? -1 : 1;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

export interface WaveTimelineRow extends TimelineRow {
  /** yyyy-mm-dd when the wave has a start (the cutover day), else undefined. */
  readonly date?: string;
}

/**
 * The wave's timeline: the default rows with its own hypercare and keep days
 * (the longest of its items), production-only rows dropped for other waves,
 * and dates when the wave has a start.
 */
export function waveTimeline(wave: WaveSpec): WaveTimelineRow[] {
  const hyper = Math.max(1, ...wave.items.map((i) => i.hypercareDays));
  const keep = Math.max(1, ...wave.items.map((i) => i.keepDays));
  const t0 = wave.start;
  return T_MINUS
    .filter((r) => !r.productionOnly || wave.production)
    .map((r): WaveTimelineRow => {
      const offset = r.id === 'aws-gate-9' ? hyper : r.id === 'g4' ? keep : r.offset;
      const label = r.id === 'aws-gate-9' ? `T+${hyper} (business)` : r.id === 'g4' ? `T+${keep}` : r.label;
      const command = r.command?.replace(/<n>/g, String(wave.n));
      const exit = r.exit.map((e) => e.replace(/<n>/g, String(wave.n)));
      const date = t0 ? addDays(t0, offset, r.business) : undefined;
      return { ...r, offset, label, exit, ...(command ? { command } : {}), ...(date ? { date } : {}) };
    })
    .sort((a, b) => a.offset - b.offset || (a.business ? 1 : 0) - (b.business ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Runbook seeds
// ---------------------------------------------------------------------------

export interface RunbookTask {
  readonly id: string;
  readonly task: string;
  readonly dependency?: string;
  readonly team: string;
  /** A milestone that closes after this task. */
  readonly milestone?: string;
  /** The kit command, relative to migration/execute/ (`<n>` = the wave). */
  readonly command?: string;
  /** Not in the AWS guide's own list: reconstructed from its summary (verify). */
  readonly reconstructed?: boolean;
}

/** Pre-migration checklist P1–P15 (AWS cutover-runbook guide). */
export const PRE_MIGRATION: readonly RunbookTask[] = Object.freeze([
  { id: 'P1', task: 'Target architecture approved', team: 'Architecture' },
  { id: 'P2', task: 'Target account / subscription / project exists', team: 'Cloud platform', dependency: 'P1' },
  { id: 'P3', task: 'Networks (VPC / VNet) and subnets exist', team: 'Network', dependency: 'P2', command: 'waves/wave-<n>/precheck.sh --stage replicate' },
  { id: 'P4', task: 'Migration team has cloud access (IAM)', team: 'Cloud platform', dependency: 'P2', command: 'controller-check.sh' },
  { id: 'P5', task: 'Application team has access', team: 'Cloud platform', dependency: 'P2' },
  { id: 'P6', task: 'Change request approved', team: 'Change management' },
  { id: 'P7', task: 'Connectivity tested', team: 'Network', dependency: 'P3' },
  { id: 'P8', task: 'Contact list documented', team: 'Migration lead' },
  { id: 'P9', task: 'Cutover plan reviewed', team: 'Migration lead' },
  { id: 'P10', task: 'Pre-migration backups done', team: 'Operations', command: 'waves/wave-<n>/precheck.sh --stage cutover' },
  { id: 'P11', task: 'Extra support contacts arranged', team: 'Migration lead' },
  { id: 'P12', task: 'Start / stop owners confirmed per application', team: 'App owners' },
  { id: 'P13', task: 'Final plan issued', team: 'Migration lead', dependency: 'P9' },
  { id: 'P14', task: 'Commencement communication sent', team: 'Migration lead', dependency: 'P13' },
  { id: 'P15', task: 'Retrospective scheduled', team: 'Migration lead' },
] satisfies RunbookTask[]);

/** Cutover runbook C1–C13 with the guide's milestones, each beside the kit step that does it. */
export const CUTOVER: readonly RunbookTask[] = Object.freeze([
  { id: 'C1', task: 'Notify stakeholders (cutover start)', team: 'Migration lead' },
  { id: 'C2', task: 'Confirm backups', team: 'Operations', dependency: 'C1', command: 'waves/wave-<n>/precheck.sh --stage cutover' },
  { id: 'C3', task: 'Stop application and database services (freeze; load balancer drained)', team: 'App owners', dependency: 'C2', command: 'waves/wave-<n>/cutover.sh (steps 0–4)' },
  { id: 'C4', task: 'Shut down the source', team: 'Infrastructure', dependency: 'C3', milestone: 'Milestone 1: pre-cutover complete', command: 'waves/wave-<n>/cutover.sh (step 5)' },
  { id: 'C5', task: 'Perform the migration (the path’s cutover)', team: 'Migration engineers', dependency: 'C4', command: 'waves/wave-<n>/cutover.sh (step 6)' },
  { id: 'C6', task: 'Verify the infrastructure (target running, adopted into Terraform)', team: 'Cloud platform', dependency: 'C5', milestone: 'Milestone 2: migration complete', command: 'waves/wave-<n>/cutover.sh (steps 7–8)' },
  { id: 'C7', task: 'Update DNS (and the load balancer)', team: 'Network', dependency: 'C6', command: 'waves/wave-<n>/cutover.sh (step 9)' },
  { id: 'C8', task: 'Verify DNS', team: 'Network', dependency: 'C7', milestone: 'Milestone 3: infrastructure complete', command: 'dns/dns.sh check --wave <n>' },
  { id: 'C9', task: 'Start application and database services on the target', team: 'App owners', dependency: 'C8', command: 'waves/wave-<n>/cutover.sh (step 10)' },
  { id: 'C10', task: 'Apply application configuration (new addresses, identity, certificates)', team: 'App owners', dependency: 'C9', milestone: 'Milestone 3: applications complete', command: 'waves/wave-<n>/cutover.sh (steps 11–12)' },
  { id: 'C11', task: 'Technical verification', team: 'Migration engineers', dependency: 'C10', command: 'waves/wave-<n>/cutover.sh (step 13)' },
  { id: 'C12', task: 'Business verification', team: 'App owners', dependency: 'C11', milestone: 'Milestone 4: testing complete' },
  { id: 'C13', task: 'Communicate completion', team: 'Migration lead', dependency: 'C12' },
] satisfies RunbookTask[]);

/** Rollback plan R1–R10. R1–R5 are the guide's list; R6–R10 are reconstructed from its summary ("sync data back if needed, test, communicate"). */
export const ROLLBACK: readonly RunbookTask[] = Object.freeze([
  { id: 'R1', task: 'Stop target services', team: 'App owners', command: 'waves/wave-<n>/rollback.sh' },
  { id: 'R2', task: 'Shut down the target servers (kept for analysis, not deleted)', team: 'Cloud platform', dependency: 'R1', command: 'waves/wave-<n>/rollback.sh (step 2)' },
  { id: 'R3', task: 'Revert DNS (and the load balancer)', team: 'Network', dependency: 'R2', command: 'waves/wave-<n>/rollback.sh (step 1)' },
  { id: 'R4', task: 'Verify DNS', team: 'Network', dependency: 'R3', command: 'dns/dns.sh check --wave <n>' },
  { id: 'R5', task: 'Start the source servers', team: 'Infrastructure', dependency: 'R4', command: 'waves/wave-<n>/rollback.sh (step 4)' },
  { id: 'R6', task: 'Start source application and database services (unfreeze)', team: 'App owners', dependency: 'R5', command: 'waves/wave-<n>/rollback.sh (step 5)', reconstructed: true },
  { id: 'R7', task: 'Sync data back if needed (database reverse replication; see the data-loss statement)', team: 'DBA', dependency: 'R6', command: 'waves/wave-<n>/rollback.sh (step 3)', reconstructed: true },
  { id: 'R8', task: 'Technical verification on the source', team: 'Migration engineers', dependency: 'R7', command: 'waves/wave-<n>/validate.sh --phase rollback --target source', reconstructed: true },
  { id: 'R9', task: 'Business verification on the source', team: 'App owners', dependency: 'R8', reconstructed: true },
  { id: 'R10', task: 'Communicate the rollback; re-pattern the items and move them to a later wave', team: 'Migration lead', dependency: 'R9', reconstructed: true },
] satisfies RunbookTask[]);

/** The provider's own step names per path family (research 6(e) 14). */
export function providerSteps(path: ExecPath): { test: string; cutover: string; finalize: string } | undefined {
  if (path === 'aws-mgn') return { test: 'MGN: launch test instances', cutover: 'MGN: launch cutover instances', finalize: 'MGN: finalize cutover, then archive and disconnect' };
  if (path.startsWith('azure-migrate')) return { test: 'Azure Migrate: test migration', cutover: 'Azure Migrate: migrate', finalize: 'Azure Migrate: complete migration' };
  if (path === 'gcp-m2vm') return { test: 'M2VM: test-clone', cutover: 'M2VM: cut-over', finalize: 'M2VM: finalize' };
  if (path.startsWith('oracle-zdm')) return { test: 'ZDM: -eval', cutover: 'ZDM: resume after -pauseafter (switchover)', finalize: 'ZDM: post phases, clean-up' };
  if (path.startsWith('hcx-')) return { test: 'HCX: validate the Mobility Group', cutover: 'HCX: schedule, Go (switchover)', finalize: 'HCX: clean-up of the retained source' };
  if (path === 'oci-ocm') return { test: 'Oracle Cloud Migrations: validate the target asset', cutover: 'Oracle Cloud Migrations: deploy the migration plan', finalize: 'Oracle Cloud Migrations: mark the migration complete' };
  return undefined;
}

const md = (s: string): string => s.replace(/\|/g, '\\|');

function taskTable(tasks: readonly RunbookTask[], n: number, withTimes: boolean): string[] {
  const head = withTimes
    ? ['| Task ID | Task | Dependency | Team | Owner | Planned start | Planned end | Actual start | Actual end | Status | Notes |', '|---|---|---|---|---|---|---|---|---|---|---|']
    : ['| Task ID | Task | Dependency | Team | Owner | Completion date | Status | Notes |', '|---|---|---|---|---|---|---|---|'];
  const rows: string[] = [];
  for (const t of tasks) {
    const note = [t.command ? `\`${t.command.replace(/<n>/g, String(n))}\`` : '', t.reconstructed ? '(reconstructed: verify against the guide)' : ''].filter(Boolean).join(' ');
    rows.push(withTimes
      ? `| ${t.id} | ${md(t.task)} | ${t.dependency ?? ''} | ${t.team} |  |  |  |  |  |  | ${note} |`
      : `| ${t.id} | ${md(t.task)} | ${t.dependency ?? ''} | ${t.team} |  |  |  | ${note} |`);
    if (t.milestone) rows.push(withTimes ? `| | **${t.milestone}** | | | | | | | | | |` : `| | **${t.milestone}** | | | | | | |`);
  }
  return [...head, ...rows];
}

/** `waves/wave-<n>/runbook.md`: the timeline, then the pre-migration, cutover and rollback runbooks. */
export function renderRunbookMd(wave: WaveSpec): string {
  const tl = waveTimeline(wave);
  const paths = [...new Set(wave.items.map((i) => i.item.path))].sort();
  const provider = paths.map((p) => [p, providerSteps(p)] as const).filter((x): x is readonly [ExecPath, NonNullable<ReturnType<typeof providerSteps>>] => !!x[1]);
  const noTest = paths.filter((p) => NO_TEST_PATHS.has(p));
  const loss = paths.map((p) => `| \`${p}\` | ${md(DATA_LOSS[p] ?? DATA_LOSS_DEFAULT)} |`);
  return [
    `# Wave ${wave.n}${wave.name ? `: ${wave.name}` : ''} — runbook`,
    '',
    `${wave.items.length} item(s)${wave.production ? ', production' : ''}${wave.start ? `; cutover (T-0) ${wave.start}` : '; no start date yet, so the timeline is in T-minus days'}. Seeded from the AWS migration governance playbook (communication gates) and the AWS cutover-runbook guide; fill in the owners (people, not teams) and the planned times, and hold at least two walkthroughs, the last one 2–3 days before cutover.`,
    '',
    '## Timeline',
    '',
    '| When | Date | Step | Exit criteria | Command |',
    '|---|---|---|---|---|',
    ...tl.map((r) => `| ${r.label} | ${r.date ?? ''} | ${md(r.title)} | ${md(r.exit.join('; '))} | ${r.command ? `\`${r.command}\`` : ''} |`),
    '',
    `Sources: ${GOVERNANCE_SOURCE}; ${CUTOVER_RUNBOOK_SOURCE}. Gate 1 at T-35 and the kit rows are this toolkit's placement; the hypercare end uses the wave's hypercare days (by criticality).`,
    '',
    ...(provider.length ? ['## Provider steps', '', '| Path | Test | Cutover | Finalize |', '|---|---|---|---|', ...provider.map(([p, s]) => `| \`${p}\` | ${s.test} | ${s.cutover} | ${s.finalize} |`), ''] : []),
    ...(noTest.length ? [`Paths without a test migration: ${noTest.map((p) => `\`${p}\``).join(', ')}. G1 needs a rollback rehearsal for each: \`waves/wave-${wave.n}/rollback.sh --rehearse --item <a nonprod item on that path>\`.`, ''] : []),
    '## Pre-migration checklist',
    '',
    ...taskTable(PRE_MIGRATION, wave.n, false),
    '',
    '## Cutover runbook',
    '',
    ...taskTable(CUTOVER, wave.n, true),
    '',
    '## Rollback plan',
    '',
    'Agree the outage window and the rollback triggers (error rates, performance thresholds) in advance. Before commit, `rollback.sh` is fully automatic; after commit it needs `--after-commit "<reason>"` and prints the data-loss statement below first.',
    '',
    ...taskTable(ROLLBACK, wave.n, true),
    '',
    '| Path | What a rollback after commit loses |',
    '|---|---|',
    ...loss,
    '',
  ].join('\n');
}

/**
 * RACI and the operating model (addendum A.10.6; research 6(e) 19).
 *
 * `Plan.governance.raci` is a grid: one row per activity, one column per role,
 * each cell R, A, C, I or blank. It is prefilled with the migration activities
 * (Discover … Decommission, the gates, communications, change requests) and the
 * run activities (monitoring, patching, backup and restore tests, incidents,
 * changes, capacity, cost, DR tests) per platform in use.
 *
 * Exactly one A per activity is enforced (an error otherwise), and at least
 * one R. AWS's governance guidance goes further — one R and one A per task —
 * so more than one R is a warning, not an error: many teams split the doing.
 *
 * The RACI roles are the sign-off roles (signoffs.ts) and the "Acting as" role
 * of the audit trail: a role, never a person.
 */

import { error, warning,              } from '../../../core/findings.js';
import { parseCsv } from '../../../core/csv.js';
import { PLATFORM_INFO } from '../../platforms.js';
import { labelOf, RACI_ROLE_OPTIONS, RACI_ROLE_VALUES } from '../options.js';
                                                                                          

export const RACI_ROLES                      = RACI_ROLE_VALUES;
export const raciRoleLabel = (role          )         => labelOf(RACI_ROLE_OPTIONS, role);

/** Stable activity ids used by the gates, sign-offs and comms to find "who is accountable". */
                            
                                                                                                                     
                                                                                                                    
                                                                                                           
                                                                                                                                      

                    
                              
                            
                            
                                                                
 

/**
 * The default grid. One A each. The lead is accountable for running the
 * programme; the app owner for accepting what happens to the app; the change
 * manager for change control; operations for the run activities.
 */
export const RACI_TEMPLATE                      = Object.freeze([
  { id: 'discover', activity: 'Discover the estate and dependencies', phase: 'migrate', cells: { 'migration-lead': 'A', 'infra-vmware': 'R', network: 'R', 'app-owner': 'C', dba: 'C', security: 'I' } },
  { id: 'assess', activity: 'Assess and choose the strategy per app', phase: 'migrate', cells: { 'migration-lead': 'A', 'cloud-platform': 'R', 'app-owner': 'C', dba: 'C', security: 'C', vendor: 'C' } },
  { id: 'plan-approval', activity: 'Approve the app plan', phase: 'migrate', cells: { 'app-owner': 'A', 'migration-lead': 'R', security: 'C', 'change-manager': 'I' } },
  { id: 'design-approval', activity: 'Approve the target design', phase: 'migrate', cells: { 'app-owner': 'A', 'cloud-platform': 'R', security: 'C', network: 'C', dba: 'C' } },
  { id: 'plan-waves', activity: 'Plan move groups and waves', phase: 'migrate', cells: { 'migration-lead': 'A', 'cloud-platform': 'R', 'app-owner': 'C', 'change-manager': 'C', 'service-desk': 'I' } },
  { id: 'landing-zone', activity: 'Build the landing zone', phase: 'migrate', cells: { 'cloud-platform': 'A', network: 'R', security: 'R', 'migration-lead': 'I' } },
  { id: 'prepare', activity: 'Prepare servers and replication', phase: 'migrate', cells: { 'migration-lead': 'A', 'infra-vmware': 'R', 'cloud-platform': 'R', 'app-owner': 'I' } },
  { id: 'replicate', activity: 'Replicate servers and databases', phase: 'migrate', cells: { 'migration-lead': 'A', 'cloud-platform': 'R', dba: 'R', 'infra-vmware': 'C' } },
  { id: 'test', activity: 'Test migration and application tests', phase: 'migrate', cells: { 'app-owner': 'A', 'cloud-platform': 'R', dba: 'C', 'migration-lead': 'C' } },
  { id: 'cutover', activity: 'Cut over', phase: 'migrate', cells: { 'migration-lead': 'A', 'cloud-platform': 'R', dba: 'R', network: 'R', 'app-owner': 'C', 'service-desk': 'I' } },
  { id: 'rollback', activity: 'Decide and run a rollback', phase: 'migrate', cells: { 'migration-lead': 'A', 'cloud-platform': 'R', 'app-owner': 'C', 'change-manager': 'I', 'service-desk': 'I' } },
  { id: 'validate', activity: 'Validate after cutover', phase: 'migrate', cells: { 'app-owner': 'A', 'cloud-platform': 'R', dba: 'R', security: 'C' } },
  { id: 'accept', activity: 'Accept the migrated app', phase: 'migrate', cells: { 'app-owner': 'A', 'migration-lead': 'R', 'service-desk': 'I' } },
  { id: 'hypercare', activity: 'Hypercare and handover to operations', phase: 'migrate', cells: { 'migration-lead': 'A', 'cloud-platform': 'R', 'service-desk': 'R', 'app-owner': 'C' } },
  { id: 'decommission', activity: 'Decommission the source', phase: 'migrate', cells: { 'infra-vmware': 'A', dba: 'R', 'app-owner': 'C', security: 'C', 'change-manager': 'I' } },
  { id: 'licence-reclaim', activity: 'Reclaim and reassign licences', phase: 'migrate', cells: { 'migration-lead': 'A', 'infra-vmware': 'R', vendor: 'C' } },
  { id: 'gate-g1', activity: 'G1 Ready to cut over (gate)', phase: 'migrate', cells: { 'migration-lead': 'A', 'app-owner': 'R', 'change-manager': 'C', security: 'C' } },
  { id: 'gate-g2', activity: 'G2 Go / no-go (gate)', phase: 'migrate', cells: { 'app-owner': 'A', 'migration-lead': 'R', 'change-manager': 'C', 'service-desk': 'I' } },
  { id: 'gate-g3', activity: 'G3 Accepted (gate)', phase: 'migrate', cells: { 'app-owner': 'A', 'migration-lead': 'R', 'service-desk': 'I' } },
  { id: 'gate-g4', activity: 'G4 Decommission (gate)', phase: 'migrate', cells: { 'infra-vmware': 'A', 'app-owner': 'R', security: 'C', 'change-manager': 'C' } },
  { id: 'gate-g5', activity: 'G5 Programme close / lights out (gate)', phase: 'migrate', cells: { 'migration-lead': 'A', 'infra-vmware': 'R', 'change-manager': 'C', vendor: 'I' } },
  { id: 'communications', activity: 'Communications and notices', phase: 'migrate', cells: { 'migration-lead': 'A', 'service-desk': 'R', 'app-owner': 'C' } },
  { id: 'change-requests', activity: 'Change requests', phase: 'migrate', cells: { 'change-manager': 'A', 'migration-lead': 'R', 'app-owner': 'C' } },
  { id: 'cmdb', activity: 'CMDB and asset register updates', phase: 'migrate', cells: { 'change-manager': 'A', 'service-desk': 'R', 'infra-vmware': 'C' } },
  { id: 'run-monitoring', activity: 'Monitoring and alerting', phase: 'run', cells: { 'cloud-platform': 'A', 'service-desk': 'R', 'app-owner': 'I' } },
  { id: 'run-patching', activity: 'Patching', phase: 'run', cells: { 'cloud-platform': 'A', 'service-desk': 'R', 'app-owner': 'C', security: 'I' } },
  { id: 'run-backup', activity: 'Backup and restore tests', phase: 'run', cells: { 'cloud-platform': 'A', dba: 'R', 'app-owner': 'I' } },
  { id: 'run-incidents', activity: 'Incidents', phase: 'run', cells: { 'service-desk': 'A', 'cloud-platform': 'R', 'app-owner': 'C', vendor: 'C' } },
  { id: 'run-changes', activity: 'Changes', phase: 'run', cells: { 'change-manager': 'A', 'cloud-platform': 'R', 'app-owner': 'C' } },
  { id: 'run-capacity', activity: 'Capacity and right-sizing', phase: 'run', cells: { 'cloud-platform': 'A', 'app-owner': 'C' } },
  { id: 'run-cost', activity: 'Cost management', phase: 'run', cells: { 'app-owner': 'A', 'cloud-platform': 'R' } },
  { id: 'run-dr-tests', activity: 'DR tests', phase: 'run', cells: { 'app-owner': 'A', 'cloud-platform': 'R', dba: 'R', network: 'C' } },
]);

const TEMPLATE_BY_ID = new Map(RACI_TEMPLATE.map((t) => [t.id, t]));

/** The platforms whose run activities get their own rows. */
function platformsInUse(plan                                         )             {
  return [...(plan.decision?.platforms ?? plan.requirements.allowed)];
}

/** Separator between a run activity and its platform: "Patching — Amazon Web Services". */
const ON = ' — ';

/**
 * The prefilled grid: every migration activity, and each run activity once
 * per platform in use (so the VMware team can own patching there while the
 * cloud team owns it on AWS). VMware run rows move the A to infra-vmware.
 */
export function defaultRaci(plan                                         )            {
  const rows            = [];
  const platforms = platformsInUse(plan);
  for (const t of RACI_TEMPLATE) {
    if (t.phase === 'migrate') {
      rows.push({ activity: t.activity, phase: t.phase, cells: { ...t.cells } });
      continue;
    }
    for (const p of platforms) {
      let cells                                      = { ...t.cells };
      if (p === 'vmware' && cells['cloud-platform'] !== undefined) {
        const moved = cells['cloud-platform'];
        const { 'cloud-platform': _c, ...rest } = cells;
        cells = { ...rest, 'infra-vmware': moved };
      }
      rows.push({ activity: `${t.activity}${ON}${PLATFORM_INFO[p].label}`, phase: 'run', cells });
    }
  }
  return rows;
}

/** The row for an activity id (a migration activity) or a run activity on a platform. */
export function raciRowFor(rows                    , id                , platform           )                      {
  const t = TEMPLATE_BY_ID.get(id);
  if (!t) return undefined;
  const name = t.phase === 'run' && platform ? `${t.activity}${ON}${PLATFORM_INFO[platform].label}` : t.activity;
  return rows.find((r) => r.activity === name) ?? rows.find((r) => r.activity.startsWith(t.activity));
}

export function rolesWith(row                     , cell          )             {
  if (!row) return [];
  return RACI_ROLES.filter((r) => row.cells[r] === cell);
}

/** The accountable role for an activity: from the plan's grid, else the template. */
export function accountable(rows                    , id                , platform           )                       {
  const row = raciRowFor(rows, id, platform);
  const fromRow = rolesWith(row, 'A')[0];
  if (fromRow) return fromRow;
  const t = TEMPLATE_BY_ID.get(id);
  return t ? RACI_ROLES.find((r) => t.cells[r] === 'A') : undefined;
}

/** Roles with R or A on the activity: the roles that may sign for it. */
export function signingRoles(rows                    , id                )             {
  const row = raciRowFor(rows, id);
  const src = row ?? (TEMPLATE_BY_ID.get(id) ? { activity: '', phase: 'migrate'         , cells: TEMPLATE_BY_ID.get(id) .cells } : undefined);
  return RACI_ROLES.filter((r) => src?.cells[r] === 'A' || src?.cells[r] === 'R');
}

/** Roles with any run activity on a platform: the operational contacts. */
export function runRoles(rows                    , platform           )             {
  const suffix = platform ? `${ON}${PLATFORM_INFO[platform].label}` : '';
  const set = new Set          ();
  for (const row of rows) {
    if (row.phase !== 'run' || (suffix && !row.activity.endsWith(suffix))) continue;
    for (const r of RACI_ROLES) if (row.cells[r] === 'A' || row.cells[r] === 'R') set.add(r);
  }
  return RACI_ROLES.filter((r) => set.has(r));
}

/** Exactly one A per activity (error); at least one R (error); more than one R (warning). */
export function validateRaci(rows                    )            {
  const findings            = [];
  const seen = new Set        ();
  rows.forEach((row, i) => {
    const path = `governance.raci[${i}]`;
    const name = row.activity.trim();
    if (!name) {
      findings.push(error('raci.no-activity', `RACI row ${i + 1} has no activity.`, { path }));
      return;
    }
    if (seen.has(name.toLowerCase())) findings.push(error('raci.duplicate', `The RACI lists "${name}" twice.`, { path }));
    seen.add(name.toLowerCase());
    const a = rolesWith(row, 'A');
    const r = rolesWith(row, 'R');
    if (a.length !== 1) {
      findings.push(error('raci.one-accountable', `"${name}" has ${a.length} accountable roles; it needs exactly one A.`, {
        path, remediation: a.length === 0 ? 'Mark one role A.' : `Keep one A among ${a.map(raciRoleLabel).join(', ')}; make the others R or C.`,
      }));
    }
    if (r.length === 0 && a.length === 1) {
      // The accountable role doing the work itself is common for small activities: fine with a note.
      findings.push(warning('raci.no-responsible', `"${name}" has no R: the accountable role (${raciRoleLabel(a[0] )}) is assumed to do it.`, { path }));
    } else if (r.length === 0) {
      findings.push(error('raci.no-responsible', `"${name}" has no responsible role.`, { path }));
    } else if (r.length > 1) {
      findings.push(warning('raci.many-responsible', `"${name}" has ${r.length} responsible roles; AWS's governance guidance asks for one R per task.`, {
        path, source: 'https://docs.aws.amazon.com/prescriptive-guidance/latest/large-migration-governance-playbook/introduction.html',
      }));
    }
  });
  return findings;
}

/** The CSV and grid header: Activity | Phase | the ten roles. */
export const RACI_COLUMNS                    = Object.freeze(['Activity', 'Phase', ...RACI_ROLES.map(raciRoleLabel)]);

const csvField = (t        )         => (/[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);

export function raciCsv(rows                    )         {
  const lines = [RACI_COLUMNS.map(csvField).join(',')];
  for (const row of rows) lines.push([row.activity, row.phase, ...RACI_ROLES.map((r) => row.cells[r] ?? '')].map(csvField).join(','));
  return `${lines.join('\n')}\n`;
}

/** Read a RACI CSV (headers by role label or role id, any order). */
export function parseRaciCsv(text        )                                           {
  const table = parseCsv(text);
  const norm = (s        ) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const col = new Map(table.headers.map((h, i) => [norm(h), i]));
  const roleCol = RACI_ROLES.map((r) => col.get(norm(raciRoleLabel(r))) ?? col.get(norm(r)) ?? -1);
  const act = col.get('activity') ?? 0;
  const ph = col.get('phase') ?? -1;
  const rows            = [];
  const findings            = [];
  table.rows.forEach((cells, i) => {
    const activity = (cells[act] ?? '').trim();
    if (!activity) return;
    const phaseRaw = ph >= 0 ? (cells[ph] ?? '').trim().toLowerCase() : '';
    const phase            = phaseRaw === 'run' ? 'run' : 'migrate';
    const out                                      = {};
    RACI_ROLES.forEach((role, k) => {
      const v = (roleCol[k]  >= 0 ? cells[roleCol[k] ] ?? '' : '').trim().toUpperCase();
      if (v === 'R' || v === 'A' || v === 'C' || v === 'I') out[role] = v;
      else if (v) findings.push(warning('raci.bad-cell', `Row ${i + 2}: "${v}" is not R, A, C or I; left blank.`));
    });
    rows.push({ activity, phase, cells: out });
  });
  return { rows, findings: [...findings, ...validateRaci(rows)] };
}

export function raciMarkdown(rows                    , title = 'RACI')         {
  const lines = [`# ${title}`, '', 'R responsible · A accountable (exactly one) · C consulted · I informed. Roles, not people.', ''];
  for (const phase of ['migrate', 'run']         ) {
    const list = rows.filter((r) => r.phase === phase);
    if (list.length === 0) continue;
    lines.push(`## ${phase === 'migrate' ? 'During the migration' : 'In operation'}`, '');
    lines.push(`| Activity | ${RACI_ROLES.map(raciRoleLabel).join(' | ')} |`);
    lines.push(`|---|${RACI_ROLES.map(() => ':-:').join('|')}|`);
    for (const r of list) lines.push(`| ${r.activity.replace(/\|/g, '\\|')} | ${RACI_ROLES.map((role) => r.cells[role] ?? '').join(' | ')} |`);
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

/** raci.md and raci.csv under governance/. */
export function raciFiles(rows                    )                         {
  return { 'governance/raci.md': raciMarkdown(rows), 'governance/raci.csv': raciCsv(rows) };
}

/**
 * Approvals and sign-offs (addendum A.10.2).
 *
 * A `SignOff` is `{scope, id, kind, role, decision, at, comment}`. Who may sign
 * comes from the RACI (the roles with R or A on the matching activity), and
 * the record keeps the role only — the house rule on footprints. A name goes
 * in the comment if the user wants one.
 *
 * | Kind            | Scope        | Needed by                               |
 * |-----------------|--------------|-----------------------------------------|
 * | plan-approved   | app          | the app status `approved`               |
 * | design-approved | app          | Generate includes the app               |
 * | test-passed     | app per wave | G1                                      |
 * | go              | wave         | G2                                      |
 * | accepted        | app per wave | G3 / the `accepted` state               |
 * | decom-approved  | wave         | G4                                      |
 * | lights-out      | dc           | G5                                      |
 *
 * Research 6(e) 19 asks for approvals by role in the providers' own model (AWS
 * Transform Administrator / Approver / Contributor / Reader; the Azure Migrate
 * roles): `PROVIDER_APPROVER_ROLES` names the provider role that should hold
 * the approval in the tool itself.
 */

import { error, warning,              } from '../../../core/findings.js';
import { labelOf, SIGN_OFF_DECISION_OPTIONS, SIGN_OFF_KIND_OPTIONS, SIGN_OFF_KIND_VALUES } from '../options.js';
             
                                                                                                                      
                     
import { raciRoleLabel, signingRoles,                     } from './raci.js';

                              
                             
                               
                                                                             
                            
                            
                         
                                                      
                                    
 

export const SIGN_OFF_RULES                         = Object.freeze([
  { kind: 'plan-approved', scope: 'app', perWave: false, neededBy: 'The app status "approved" (Application Migration)', activity: 'plan-approval' },
  { kind: 'design-approved', scope: 'app', perWave: false, neededBy: 'Generate includes the app', activity: 'design-approval' },
  { kind: 'test-passed', scope: 'app', perWave: true, neededBy: 'G1 Ready to cut over', gate: 'G1', activity: 'test' },
  { kind: 'go', scope: 'wave', perWave: false, neededBy: 'G2 Go / no-go', gate: 'G2', activity: 'gate-g2' },
  { kind: 'accepted', scope: 'app', perWave: true, neededBy: 'G3 and the "accepted" state', gate: 'G3', activity: 'accept' },
  { kind: 'decom-approved', scope: 'wave', perWave: false, neededBy: 'G4 Decommission', gate: 'G4', activity: 'gate-g4' },
  { kind: 'lights-out', scope: 'dc', perWave: false, neededBy: 'G5 Programme close', gate: 'G5', activity: 'gate-g5' },
]);
const RULE = new Map(SIGN_OFF_RULES.map((r) => [r.kind, r]));
export const signOffRule = (kind             )              => RULE.get(kind) ;

/**
 * The approver role in each provider's migration tool, for the approval to be
 * enforced there as well as recorded here (research 6(b) G05).
 */
export const PROVIDER_APPROVER_ROLES                                                                                                                      = Object.freeze({
  aws: { role: 'AWS Transform: Approver (the roles are Administrator, Approver, Contributor, Reader)', source: 'https://docs.aws.amazon.com/transform/latest/userguide/', verification: 'V-DOC' },
  azure: { role: 'Azure Migrate: a built-in role on the project (verify the role names on the tenant)', source: 'https://learn.microsoft.com/en-us/azure/migrate/', verification: 'I' },
  google: { role: 'Migrate to Virtual Machines: an IAM role with cut-over rights (verify the role id)', source: 'https://cloud.google.com/migrate/virtual-machines/docs', verification: 'I' },
  oci: { role: 'OCI IAM policy on the migration compartment', source: 'https://docs.oracle.com/en-us/iaas/Content/cloud-migration/home.htm', verification: 'I' },
  vmware: { role: 'HCX: a role with migration rights (vCenter / HCX role-based access)', source: 'https://techdocs.broadcom.com/', verification: 'I' },
});

/** The id a sign-off carries: the app name, the wave number, `<app>@<wave>`, 'plan' or the DC name. */
export function signOffId(rule             , target                                                                         )         {
  if (rule.scope === 'wave') return `wave-${target.wave ?? 0}`;
  if (rule.scope === 'dc') return target.dc ?? 'dc';
  if (rule.scope === 'plan') return 'plan';
  return rule.perWave ? `${target.app ?? ''}@${target.wave ?? 0}` : (target.app ?? '');
}

/** The roles that may give a kind of sign-off, from the plan's RACI. */
export function whoCanSign(raci                    , kind             )             {
  return signingRoles(raci, signOffRule(kind).activity);
}

/** Check a sign-off before it is recorded: the role must have R or A on the activity. */
export function checkSignOff(raci                    , s         )            {
  const rule = RULE.get(s.kind);
  if (!rule) return [error('signoff.kind', `"${s.kind}" is not a sign-off kind.`)];
  const out            = [];
  if (rule.scope !== s.scope) out.push(error('signoff.scope', `A ${labelOf(SIGN_OFF_KIND_OPTIONS, s.kind)} sign-off is per ${rule.scope}, not per ${s.scope}.`));
  const roles = whoCanSign(raci, s.kind);
  if (!roles.includes(s.role)) {
    out.push(error('signoff.role', `${raciRoleLabel(s.role)} is not R or A for "${rule.activity}" in the RACI, so cannot give ${labelOf(SIGN_OFF_KIND_OPTIONS, s.kind)}.`, {
      remediation: `Sign as one of: ${roles.map(raciRoleLabel).join(', ') || 'no role — fix the RACI first'}.`,
    }));
  }
  if (!s.at) out.push(error('signoff.date', 'A sign-off needs its date.'));
  return out;
}

/** Record a sign-off in the tracker (a new record; the latest per scope/id/kind/role counts). */
export function recordSignOff(tracker         , raci                    , s         )                                            {
  const findings = checkSignOff(raci, s);
  if (findings.some((f) => f.severity === 'error')) return { tracker, findings };
  return { tracker: { ...tracker, signoffs: [...tracker.signoffs, s] }, findings };
}

                                                               

/** The latest decision for a scope/id/kind, over all roles (a rejection by anyone after the last approval stands). */
export function signOffState(tracker                           , kind             , id        )               {
  const list = tracker.signoffs.filter((s) => s.kind === kind && s.id === id).sort((a, b) => a.at.localeCompare(b.at));
  const last = list[list.length - 1];
  return last ? last.decision : 'missing';
}

/** A gate criterion from a sign-off, for the gate engine (WP-12). */
export function signOffCriterion(tracker                           , kind             , id        )                {
  const state = signOffState(tracker, kind, id);
  return {
    id: `signoff.${kind}.${id}`, auto: true, met: state === 'approved',
    detail: `${labelOf(SIGN_OFF_KIND_OPTIONS, kind)} for ${id}: ${state}.`,
  };
}

                                                                                                                                                                                     

/**
 * Every sign-off the plan needs, with its state. `waves` is app name → wave
 * number (from the wave plan); apps with no wave get only the app-level kinds.
 */
export function requiredSignOffs(
  plan                                      ,
  raci                    ,
  tracker                           ,
  waves                                   = {},
)                    {
  const out                    = [];
  const add = (kind             , id        ) => {
    const rule = signOffRule(kind);
    out.push({ kind, scope: rule.scope, id, roles: whoCanSign(raci, kind), state: signOffState(tracker, kind, id) });
  };
  const waveNumbers = [...new Set(Object.values(waves))].sort((a, b) => a - b);
  for (const app of [...plan.apps].sort((a, b) => a.name.localeCompare(b.name))) {
    add('plan-approved', app.name);
    add('design-approved', app.name);
    const wave = waves[app.name];
    if (wave !== undefined) {
      add('test-passed', `${app.name}@${wave}`);
      add('accepted', `${app.name}@${wave}`);
    }
  }
  for (const w of waveNumbers) {
    add('go', `wave-${w}`);
    add('decom-approved', `wave-${w}`);
  }
  if (plan.mode === 'dc-exit') add('lights-out', 'dc');
  return out;
}

const cell = (t                    )         => (t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * `governance/signoffs/<app>.md`: a printable sheet, one table per kind
 * (`Role | Decision | Date | Comment`), pre-filled from the tracker, with an
 * empty row per role that may still sign.
 */
export function signOffSheet(app        , raci                    , tracker                           , wave         )         {
  const lines = [`# Sign-off sheet: ${app}`, '', 'Each approval records the role only. Write a name in the comment if you want one.', ''];
  for (const kind of SIGN_OFF_KIND_VALUES) {
    const rule = signOffRule(kind);
    if (rule.scope !== 'app') continue;
    if (rule.perWave && wave === undefined) continue;
    const id = signOffId(rule, { app, ...(wave !== undefined ? { wave } : {}) });
    const given = tracker.signoffs.filter((s) => s.kind === kind && s.id === id).sort((a, b) => a.at.localeCompare(b.at));
    lines.push(`## ${labelOf(SIGN_OFF_KIND_OPTIONS, kind)}`, '', `Needed by: ${rule.neededBy}.${rule.perWave ? ` Wave ${wave}.` : ''}`, '');
    lines.push('| Role | Decision | Date | Comment |', '|---|---|---|---|');
    for (const s of given) lines.push(`| ${raciRoleLabel(s.role)} | ${labelOf(SIGN_OFF_DECISION_OPTIONS, s.decision)} | ${s.at.slice(0, 10)} | ${cell(s.comment)} |`);
    const signed = new Set(given.map((s) => s.role));
    for (const role of whoCanSign(raci, kind)) if (!signed.has(role)) lines.push(`| ${raciRoleLabel(role)} |  |  |  |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** A wave-level sheet (go, decom-approved). */
export function waveSignOffSheet(wave        , raci                    , tracker                           )         {
  const lines = [`# Sign-off sheet: wave ${wave}`, ''];
  for (const kind of ['go', 'decom-approved']         ) {
    const id = `wave-${wave}`;
    const given = tracker.signoffs.filter((s) => s.kind === kind && s.id === id).sort((a, b) => a.at.localeCompare(b.at));
    lines.push(`## ${labelOf(SIGN_OFF_KIND_OPTIONS, kind)}`, '', `Needed by: ${signOffRule(kind).neededBy}.`, '', '| Role | Decision | Date | Comment |', '|---|---|---|---|');
    for (const s of given) lines.push(`| ${raciRoleLabel(s.role)} | ${labelOf(SIGN_OFF_DECISION_OPTIONS, s.decision)} | ${s.at.slice(0, 10)} | ${cell(s.comment)} |`);
    const signed = new Set(given.map((s) => s.role));
    for (const role of whoCanSign(raci, kind)) if (!signed.has(role)) lines.push(`| ${raciRoleLabel(role)} |  |  |  |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Path-safe name for a file. */
export const fileSlug = (name        )         => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

/** Every sheet: governance/signoffs/<app>.md and wave-<n>.md. */
export function signOffFiles(
  plan                    ,
  raci                    ,
  tracker                           ,
  waves                                   = {},
)                         {
  const files                         = {};
  for (const app of plan.apps) files[`governance/signoffs/${fileSlug(app.name)}.md`] = signOffSheet(app.name, raci, tracker, waves[app.name]);
  for (const w of [...new Set(Object.values(waves))].sort((a, b) => a - b)) files[`governance/signoffs/wave-${w}.md`] = waveSignOffSheet(w, raci, tracker);
  return files;
}

/** Findings for sign-offs that block the next step. */
export function signOffFindings(required                            )            {
  return required
    .filter((r) => r.state === 'rejected')
    .map((r) => warning('signoff.rejected', `${labelOf(SIGN_OFF_KIND_OPTIONS, r.kind)} for ${r.id} was rejected; ${signOffRule(r.kind).neededBy} is blocked.`));
}

/**
 * The wizard in the chosen provider's own words.
 *
 * Each cloud migrates by its own method, with its own phase names and its own
 * words for the same thing (research 6(a) and 6(d), `PROVIDER_TERMS`, and the
 * approved flows in ./provider-flows.ts). When a cloud is chosen, every step
 * says which of that provider's phases it belongs to, and its title and text
 * use the provider's words: Azure "test migration", "migrate", "complete
 * migration", "stabilization"; Google Cloud "test-clone", "cut-over",
 * "finalize"; AWS "move group", "test instance", "hypercare"; OCI "migration
 * project", "mark migration complete" (and "ArchToolKit wave", since OCI has no
 * waves of its own); VCF "Mobility Group", "switchover". The 7R labels follow
 * the provider ("Replace" on Azure and OCI, "Repurchase" on AWS and Google).
 *
 * A new service and a change to a running service are not migrations: their
 * steps name the provider's build, deploy and operate stages instead.
 */

import { providerTerm, strategyLabel } from '../plan/methodology.js';
                                                                    
import { PROVIDER_FLOWS } from './provider-flows.js';
import { WIZARD_CLOUD_TO_TARGET,                 } from './steps.js';

                              
                                                                 
                         
                         
                            
                        
 

                                                              

export const flowKindOf = (initiative        )           =>
  (initiative === 'new-service' ? 'new-service' : initiative === 'existing-service' || initiative === 'maintenance' ? 'change' : 'migration');

/** The platform of a wizard cloud id. */
export const platformOfCloud = (cloud        )           => (WIZARD_CLOUD_TO_TARGET[cloud] ?? 'azure')            ;

const SHORT                                     = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud', oci: 'OCI', vmware: 'VCF' };

/** The provider's phase for each step of a migration (the approved mapping of its phases onto the flow). */
const MIGRATION_PHASE                                                               = {
  aws: { 1: 'Assess', 2: 'Assess (portfolio discovery)', 10: 'Assess (7 Rs)', 3: 'Mobilize (design)', 4: 'Mobilize (security, risk & compliance)', 5: 'Assess (right-sizing)', 6: 'Mobilize (landing zone)', 7: 'Migrate: Initialize', 11: 'Migrate: Implement', 12: 'Migrate: Implement (T-1 go/no-go, T-0 cutover)', 13: 'Hypercare' },
  azure: { 1: 'Strategy and Plan', 2: 'Strategy and Plan (discover)', 10: 'Strategy and Plan (choose the strategy)', 3: 'Strategy and Plan (assess)', 4: 'Ready (baselines)', 5: 'Strategy and Plan (assess)', 6: 'Ready', 7: 'Migrate: plan and prepare', 11: 'Migrate: execute', 12: 'Migrate: execute', 13: 'Optimize and decommission' },
  google: { 1: 'Assess', 2: 'Assess (inventory)', 10: 'Assess (technical fit)', 3: 'Plan', 4: 'Plan', 5: 'Assess (sizing preference)', 6: 'Plan (build the foundation)', 7: 'Plan', 11: 'Deploy', 12: 'Deploy', 13: 'Optimize' },
  oci: { 1: 'Manage assets', 2: 'Manage assets', 10: 'Plan and migrate (migration plan)', 3: 'Plan and migrate', 4: 'Plan and migrate', 5: 'Plan and migrate (target assets)', 6: 'Plan and migrate (landing zone)', 7: 'Plan and migrate', 11: 'Plan and migrate (replication)', 12: 'Verify', 13: 'Verify' },
  vmware: { 1: 'Analyze', 2: 'Analyze', 10: 'Analyze', 3: 'Waves', 4: 'Waves', 5: 'Analyze (capacity)', 6: 'Management and workload domains; HCX site pairing', 7: 'Mobility Groups', 11: 'Migrate and switchover (replicate)', 12: 'Migrate and switchover', 13: 'Commit' },
};
const NEW_PHASE                                   = { 1: 'Define', 9: 'Define the service', 3: 'Design', 4: 'Design', 5: 'Design (size)', 6: 'Foundation', 7: 'Build', 14: 'Deploy', 15: 'Hand over' };
const CHANGE_PHASE                                   = { 1: 'Operate', 8: 'Operate: choose the change', 16: 'Operate: apply', 17: 'Operate: record' };

/** The test run → cutover → post-cutover line in the provider's words. */
export function cutoverWords(p          )         {
  return `${providerTerm('test-run', p)} → ${providerTerm('cutover', p)} → ${providerTerm('hypercare', p)}`;
}

/** A step's title, subtitle, hint and phase, for a cloud and an initiative type. */
export function stepWording(step            , cloud        , initiative        )              {
  const p = platformOfCloud(cloud);
  const kind = flowKindOf(initiative);
  const flow = PROVIDER_FLOWS[p];
  const phaseName = kind === 'migration' ? MIGRATION_PHASE[p][step.number] : kind === 'new-service' ? NEW_PHASE[step.number] : CHANGE_PHASE[step.number];
  const phase = `${SHORT[p]} · ${phaseName ?? flow.phases[0]?.[0] ?? ''}`;
  const group = providerTerm('move-group', p);
  const lz = providerTerm('landing-zone', p);
  const test = providerTerm('test-run', p);
  const cut = providerTerm('cutover', p);
  const back = providerTerm('rollback', p);
  const after = providerTerm('hypercare', p);
  let { title, subtitle, hint } = step;
  switch (step.number) {
    case 1:
      if (kind === 'new-service') subtitle = 'Set up a new service: nothing to move. The cloud, the pattern and the basics';
      else if (kind === 'change') subtitle = 'Change a running service: the cloud and the basics';
      break;
    case 2:
      subtitle = `What the application runs on today, as ${flow.discover.split(';')[0] .replace(/\.$/, '')} would find it`;
      hint = `Confirm the source; readiness is judged as ${providerTerm('readiness', p)}.`;
      break;
    case 10:
      subtitle = `How it moves, in ${SHORT[p]}'s list of strategies; it moves as one ${group.toLowerCase()}`;
      break;
    case 5:
      if (kind === 'new-service') subtitle = 'Sized from the load profile: the data volume, the environments and the regions';
      break;
    case 6:
      title = `Foundation: ${lz} & connectivity`;
      subtitle = `${flow.first} Then the link back to the data centre (${flow.connect.replace(/\.$/, '')}) and the connectors to the apps it depends on`;
      break;
    case 7:
      title = kind === 'new-service' ? 'Build: Terraform, Ansible & pipeline' : 'Build: Terraform & Ansible';
      subtitle = kind === 'new-service'
        ? `What gets built on ${SHORT[p]}, the ${lz.toLowerCase()} reused or built, and the stack and its pipeline, in the form ${SHORT[p]} takes`
        : `What gets built on ${SHORT[p]}, and the stack in the form ${SHORT[p]} takes`;
      break;
    case 11:
      title = `Replicate & ${test.toLowerCase()}`;
      subtitle = `Start replication per server and database, then the ${test.toLowerCase()}; fix what it finds and mark it ready`;
      break;
    case 12:
      title = `${cut} & ${back.toLowerCase()}`;
      subtitle = flow.cutover;
      hint = flow.gates;
      break;
    case 13:
      title = p === 'vmware' ? 'Commit & decommission' : `${after} & decommission`;
      subtitle = `${after} after the move, the hand-over to operations, then the source is retired`;
      break;
    default:
      break;
  }
  return { phase, title, subtitle, hint };
}

const STRATEGY_OF_ANSWER                                              = {
  rehost: 'rehost', replatform: 'replatform', refactor: 'refactor', repurchase: 'repurchase', retain: 'retain', retire: 'retire', relocate: 'relocate',
};

/** An option's label in the provider's words where it has its own ("Replace" for repurchase on Azure and OCI); else the given label. */
export function optionLabel(fieldId        , value        , label        , cloud        )         {
  if (fieldId !== 'migrationApproach') return label;
  const strategy = STRATEGY_OF_ANSWER[value];
  if (!strategy) return label;
  const provider = strategyLabel(strategy, platformOfCloud(cloud));
  const base = label.split(' (')[0] ;
  if (provider.toLowerCase() === base.toLowerCase()) return label;
  const tail = label.includes('(') ? ` ${label.slice(label.indexOf('('))}` : '';
  return `${provider}${tail}`;
}

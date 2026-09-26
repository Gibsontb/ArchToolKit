/**
 * Per-app and stacked generation (addendum A.2.5).
 *
 * `generateAppStack(plan, appIds, options)` builds the app slice (one app or
 * many: the same code) and generates:
 *
 *   1. `decidePlan(slice, { extraRules })` with the pattern rules, each app
 *      placed on its chosen platform (else its recommendation, so an app never
 *      straddles clouds), then `designPlan` with the pattern designers;
 *   2. Terraform per platform: `terraformFiles(slice, …, { scope: 'apps',
 *      landingZone })` — one root module per platform holding every selected
 *      app on it, so apps on one cloud share state and the landing-zone
 *      contract. `shared` leaves the landing zone, identity and connectivity
 *      out (`var.landing_zone`, with the one-line bridge in the README);
 *   3. Ansible for the slice's hosts (`ansibleFiles` with the apps);
 *   4. `README.md`, `app-plan.json` (the slice as a plan envelope, loadable on
 *      both pages) and `decision/app-record.md` (each app's comparison and
 *      reasons).
 *
 * Files sit under `<slug(app)>/` for one app, `<slug(plan)>-apps/` for a
 * stack. An error finding in the selection blocks Download (it names the
 * app); the findings are returned for the page to show. Everything applies as
 * generated; no credential and no footprint is written (the dates are the
 * plan's own `savedAt`).
 */

import { error,              } from '../../../core/findings.js';
                                                   
import { writeSettings } from '../../../kit/settings-file.js';
                                                             
                                                        
import { designPlan } from '../design/index.js';
import { ansibleFiles } from '../generate/ansible.js';
import { terraformFiles } from '../generate/terraform.js';
import { DEFAULT_GENERATE, PLATFORM_LABELS, PLATFORM_VALUES, slugName } from '../options.js';
import { withPatternMappers } from '../patterns/index.js';
import { planEnvelope } from '../store.js';
             
                                                                                                                                                       
                     
import { compareApp } from './compare.js';
import { deployPaths,                 } from './deploy-paths.js';
import { cloudFormationFiles } from '../generate/native/cloudformation.js';
import { bicepFiles } from '../generate/native/bicep.js';
import { appPlanOf, defaultAppPlan, findApp, withAppPlan, withoutServiceSynthetics } from './components.js';
import { decideApps, recommendApp, recommendationDecision } from './recommend.js';
import { appSlice, selectedApps, sliceFolder } from './slice.js';
import { variantFindings } from './translate.js';

                                  
     
                                                                   
                                                                            
                                                                        
                                                                       
     
                                         
                                  
                                                                          
                                   
                                           
                             
                                  
                                                           
                                    
                                  
                                           
                                                                   
                                             
                                                                      
                            
 

                                                          
                                          
                          
                       
                                  
                                
                                               
                                                                              
                                                  
                                      
                                                                   
                                         
 

/**
 * The slice with each app placed: its chosen platform, else its
 * recommendation (read from a decision without the choices).
 */
export function placedSlice(plan      , appIds                   , engine                )       {
  let slice = appSlice(plan, appIds);
  const unplaced = selectedApps(slice, appIds).filter((a) => !appPlanOf(slice, a.id)?.platform);
  if (unplaced.length === 0) return slice;
  const free = recommendationDecision(slice, engine);
  for (const a of unplaced) {
    const rec = recommendApp(slice, free, a.id);
    if (!rec.recommended) continue;
    const ap = appPlanOf(slice, a.id) ?? defaultAppPlan(a);
    slice = withAppPlan(slice, { ...ap, platform: rec.recommended });
  }
  return slice;
}

/**
 * The landing-zone mode per platform: the option; else shared when the
 * landing zone is designed on Migration & Utilities; else shared when every
 * selected app on the platform reuses another app's landing zone (the design
 * rule: the first app on a cloud builds it, the later ones reuse it); else
 * included.
 */
function modeOf(plan      , slice      , p          , option                             )                  {
  if (option) return option;
  if (plan.execution?.landingZones?.[p]) return 'shared';
  const here = (slice.appPlans ?? []).filter((ap) => ap.platform === p);
  return here.length > 0 && here.every((ap) => ap.landingZone === 'shared') ? 'shared' : 'included';
}

function readme(plan      , slice      , folder        , modes                                                      , files                                  , deploy                        = [])         {
  const apps = slice.apps.map((a) => {
    const ap = appPlanOf(slice, a.id);
    return `- ${a.name}${ap?.platform ? ` → ${PLATFORM_LABELS[ap.platform]}` : ''}${ap?.origin === 'new' ? ' (new application)' : ''}`;
  });
  const platforms = PLATFORM_VALUES.filter((p) => Object.keys(files).some((f) => f.startsWith(`${folder}/terraform/${p}/`)));
  const lines = [
    `# ${slice.apps.length === 1 ? slice.apps[0] .name : `${plan.name}: applications`}`,
    '',
    'The target presence of these applications, generated from the application plans. It applies as generated.',
    '',
    '## Applications',
    '',
    ...apps,
    '',
    '## What is in it',
    '',
    ...platforms.map((p) => `- \`terraform/${p}/\`: one root module for ${PLATFORM_LABELS[p]}, holding every application here that lands on it. The landing zone is ${modes[p] === 'shared' ? 'shared: it comes from the landing-zone project' : 'included in the stack'}.`),
    ...(Object.keys(files).some((f) => f.startsWith(`${folder}/ansible/`)) ? ['- `ansible/`: the configuration of these applications\' servers (`ansible-playbook site.yml`).'] : []),
    '- `app-plan.json`: these applications as a plan, to open on Application Migration or Migration & Utilities.',
    '- `decision/app-record.md`: why each application lands where it does, compared across the platforms.',
    '',
    ...(platforms.some((p) => modes[p] === 'shared')
      ? [
        '## The shared landing zone',
        '',
        'Before the first apply, bring the landing zone of the landing-zone project into each shared stack:',
        '',
        '```sh',
        ...platforms.filter((p) => modes[p] === 'shared').map((p) => `terraform -chdir=<landing-zone project>/terraform/${p} output -json landing_zone | jq '{landing_zone: .}' > terraform/${p}/landing_zone.auto.tfvars.json`),
        '```',
        '',
      ]
      : []),
    '## Apply',
    '',
    '```sh',
    ...platforms.map((p) => `terraform -chdir=terraform/${p} init && terraform -chdir=terraform/${p} apply`),
    ...(Object.keys(files).some((f) => f.startsWith(`${folder}/ansible/`)) ? ['cd ansible && ansible-galaxy install -r requirements.yml && ansible-playbook site.yml'] : []),
    '```',
    '',
    'Each `terraform/<platform>/README.md` lists what to sign in with and the sensitive variables to export from your vault. Credentials are never written into these files.',
    '',
    ...(deploy.length > 0 ? ['## How each cloud takes it', '', ...deploy.flatMap((d) => d.readme)] : []),
  ];
  return lines.join('\n');
}

function appRecord(plan      , slice      , options                 )         {
  const out           = ['# Application decision record', ''];
  for (const a of slice.apps) {
    const cmp = compareApp(plan, a.id, { ...(options.rateCard ? { rateCard: options.rateCard } : {}), ...(options.engine ? { engine: options.engine } : {}) });
    const ap = appPlanOf(slice, a.id);
    const rec = cmp.recommendation;
    out.push(`## ${a.name}`, '');
    out.push(`- Kind: ${a.kind ?? 'unknown'}; pattern: ${a.pattern ?? 'generic'}; criticality: ${a.criticality}.`);
    out.push(`- Recommended: ${rec.recommended ? PLATFORM_LABELS[rec.recommended] : 'none (no eligible platform)'}${rec.tooClose ? ' (too close to call)' : ''}; margin ${rec.margin} points.`);
    out.push(`- Placed on: ${ap?.platform ? PLATFORM_LABELS[ap.platform] : 'the recommendation'}.`, '');
    out.push('| Platform | Eligible | Score | Δ to recommended | Components | Findings (E / W / I) |', '|---|---|---|---|---|---|');
    for (const c of cmp.columns) {
      out.push(`| ${c.label} | ${c.verdict.eligible ? (c.verdict.withGaps ? 'yes, with gaps' : 'yes') : 'no'} | ${c.verdict.score} | ${c.verdict.delta} | ${c.components.length} | ${c.findings.error} / ${c.findings.warning} / ${c.findings.info} |`);
    }
    out.push('');
    for (const c of cmp.columns) {
      out.push(`### ${c.label}`, '');
      if (c.why.length > 0) {
        out.push('Why:', '');
        for (const h of c.why) out.push(`- ${h.rule} (${h.delta > 0 ? '+' : ''}${h.delta}, ${h.verification}): ${h.reason}${h.source ? ` — ${h.source}` : ''}`);
        out.push('');
      }
      if (c.components.length > 0) {
        out.push('| Component | Tier pattern | Service | Size / class | Translation |', '|---|---|---|---|---|');
        for (const k of c.components) out.push(`| ${k.name} | ${k.tierPattern ?? ''} | ${k.service.replace(/\|/g, '/')} | ${k.sizes.join(', ')} | ${k.outcome} |`);
        out.push('');
      }
      if (c.licences.length > 0) out.push(`Licences: ${c.licences.map((l) => `${l.count} ${l.kind} (${l.model})`).join(', ')}.`, '');
      if (c.estimate) out.push(`Estimate — ${c.estimate.label}: ${c.estimate.monthly.map((m) => `${m.amount} ${m.currency} a month`).join(', ') || 'no priced run cost'}; one-time ${c.estimate.oneTime.map((m) => `${m.amount} ${m.currency}`).join(', ') || 'none priced'}.`, '');
      if (c.eliminatedBecause.length > 0) {
        out.push('Eliminated because:', '');
        for (const e of c.eliminatedBecause) out.push(`- ${e.item}: ${e.rules.map((r) => `${r.rule} — ${r.reason}`).join('; ')}`);
        out.push('');
      }
    }
  }
  return `${out.join('\n')}`;
}

/**
 * Generate the Terraform and Ansible for one app or a stack of apps. The
 * `.tf` an app gets is the same whether it is generated alone or stacked
 * with others on the same platform: its own items' files are byte for byte
 * the same, and its rows in the shared grids are the same rows.
 */
export function generateAppStack(plan      , appIds                   , options                  = {})                 {
  const findings            = [];
  const folder = sliceFolder(plan, appIds);
  let slice = placedSlice(plan, appIds, options.engine);
  if (options.backend) slice = { ...slice, generate: { ...(slice.generate ?? DEFAULT_GENERATE), backend: options.backend } };
  const decision = decideApps(slice, options.engine);
  const design = withoutServiceSynthetics(slice, designPlan(slice, decision, withPatternMappers()));
  findings.push(...decision.findings, ...design.findings);

  // Translation blockers per app on its platform.
  const blocked = new Set        ();
  for (const a of slice.apps) {
    const ap = appPlanOf(slice, a.id);
    if (!ap?.platform) continue;
    for (const f of variantFindings(ap, ap.platform)) {
      findings.push({ ...f, message: `${a.name}: ${f.message}` });
      if (f.severity === 'error') blocked.add(a.name);
    }
  }

  // Terraform, grouped by landing-zone mode.
  const files                         = {};
  const envelopes                                                       = {};
  const modes                                             = {};
  for (const p of design.platforms.map((d) => d.platform)) modes[p] = modeOf(plan, slice, p, options.landingZone);
  for (const mode of ['included', 'shared']         ) {
    const platforms = design.platforms.filter((d) => modes[d.platform] === mode);
    if (platforms.length === 0) continue;
    const part               = { platforms, findings: [] };
    const tf = terraformFiles(slice, decision, part, {
      scope: 'apps', landingZone: mode, apps: slice.apps.map((a) => a.id),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    for (const [path, text] of Object.entries(tf.files)) files[`${folder}/${path}`] = text;
    Object.assign(envelopes, tf.envelopes);
    findings.push(...tf.findings);
  }

  // Ansible for the slice's hosts.
  const an = ansibleFiles(slice, decision, design, { apps: slice.apps.map((a) => a.id), ...(options.ansibleLookup ? { lookup: options.ansibleLookup } : {}) });
  for (const [path, text] of Object.entries(an.files)) files[`${folder}/${path}`] = text;
  findings.push(...an.findings);

  // Each cloud's own deployment path (Infrastructure Manager, a Resource Manager stack, a VCF Automation template).
  const title = slice.apps.length === 1 ? slice.apps[0] .name : `${plan.name} apps`;
  const deploy = deployPaths(slice, design, folder, files, title);
  Object.assign(files, deploy.files);

  // AWS and Azure also get their own template formats, built from the same design.
  const onPlatform = new Set(design.platforms.map((d) => d.platform));
  const nativeOptions = { scope: 'apps'         , apps: slice.apps.map((a) => a.id), ...(options.environment ? { environment: options.environment } : {}) };
  for (const [platform, make] of [['aws', cloudFormationFiles], ['azure', bicepFiles]]         ) {
    if (!onPlatform.has(platform)) continue;
    const native = make(slice, decision, design, nativeOptions);
    for (const [path, text] of Object.entries(native.files)) files[`${folder}/${path}`] = text;
    findings.push(...native.findings);
  }

  files[`${folder}/app-plan.json`] = writeSettings(planEnvelope(slice)                   , 'json');
  if (options.record !== false) files[`${folder}/decision/app-record.md`] = appRecord(plan, slice, options);
  files[`${folder}/README.md`] = readme(plan, slice, folder, modes, files, deploy.paths);

  // An error names its app when it can, and blocks that app's Download.
  for (const f of findings) {
    if (f.severity !== 'error') continue;
    const who = slice.apps.find((a) => f.message.includes(a.name) || (f.path ?? '').includes(slugName(a.name)));
    if (who) blocked.add(who.name);
  }
  if (blocked.size > 0) {
    findings.push(error('apps.generate.blocked', `Download is blocked by error findings in: ${[...blocked].sort().join(', ')}.`, { remediation: 'Resolve the errors named above for these applications, or leave them out of the selection.' }));
  }

  const sorted                         = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k] ;
  return {
    files: sorted,
    findings,
    handoffs: { terraform: envelopes, ansible: an.envelope },
    folder,
    slice,
    decision,
    design,
    landingZones: modes,
    blocked: [...blocked].sort(),
    deploy: deploy.paths,
  };
}

/** "Select planned": the apps whose plan is `planned` or `approved`. */
export function plannedApps(plan      )           {
  return plan.apps.filter((a) => {
    const s = appPlanOf(plan, a.id)?.status;
    return s === 'planned' || s === 'approved';
  }).map((a) => a.id);
}

/** The app plan of an app, or a fresh one (for the `#stack` grid). */
export const appPlanOrDefault = (plan      , appId        ) => {
  const app = findApp(plan, appId);
  return app ? appPlanOf(plan, app.id) ?? defaultAppPlan(app) : undefined;
};

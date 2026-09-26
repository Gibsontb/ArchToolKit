/**
 * Per-app and stacked generation for the panes (addendum A.2.5, A.10.11):
 * `generateAppStack` (WP-19) for the Terraform and Ansible, plus the CI/CD
 * pipeline (WP-20's pipeline module) beside it, and the archive.
 *
 * The resource and module components are lazy blueprints: their schemas are
 * fetched a file at a time. `loadComponentSchemas` fetches every one the
 * selection uses before generating, so a component added from the picker is
 * built into the stack (and one whose schema cannot load is an error that
 * names the file, blocking that app's Download).
 */

import { error,              } from '../../core/findings.js';
import { zip, tarGz } from '../../kit/archive.js';
import { appPlanOf, findApp } from '../../multicloud/plan/apps/components.js';
import { generateAppStack, placedSlice,                     } from '../../multicloud/plan/apps/generate.js';
import { BOOTSTRAP_BACKEND, backendBootstrapFiles } from '../../multicloud/plan/pipeline/backend-bootstrap.js';
import { azureDevOpsFiles } from '../../multicloud/plan/pipeline/ci-azdo.js';
                                                                             
import { githubActionsFiles } from '../../multicloud/plan/pipeline/ci-github.js';
import { gitlabCiFiles } from '../../multicloud/plan/pipeline/ci-gitlab.js';
                                                                                  
import { PLATFORM_VALUES } from '../../multicloud/plan/options.js';
                                                                                                           
import { loadResource } from '../../terraform/schema-blueprints.js';
import { loadModule } from '../../ansible/module-blueprints.js';
import { moduleFromBlueprintId } from '../../terraform/equivalence.js';

/** The FQCN a `mod_*` blueprint id names (dots are underscores in the id). */
export function moduleOfBlueprint(id        , names                         )                     {
  if (!id.startsWith('mod_')) return undefined;
  return moduleFromBlueprintId(id) ?? names().find((n) => `mod_${n.replace(/\./g, '_')}` === id);
}

/**
 * Fetch the schema of every resource and module component the selection
 * builds (on each app's placed platform). Failures come back as error
 * findings naming the component and the file.
 */
export async function loadComponentSchemas(plan      , appIds                   , moduleNames                         )                     {
  const slice = placedSlice(plan, appIds);
  const findings            = [];
  const jobs                  = [];
  for (const ap of slice.appPlans ?? []) {
    const p = ap.platform;
    if (!p) continue;
    const app = findApp(slice, ap.app);
    for (const c of ap.variants[p] ?? []) {
      if (c.kind === 'resource') {
        jobs.push(loadResource(c.type).catch((e         ) => {
          findings.push(error('app.component.schema-failed', `${app?.name ?? ap.app}: ${c.name} (${c.type}) could not load its schema: ${String(e instanceof Error ? e.message : e)}.`, { path: c.id }));
        }));
      } else if (c.kind === 'config') {
        const fqcn = moduleOfBlueprint(c.blueprintId, moduleNames);
        if (!fqcn) continue;
        jobs.push(loadModule(fqcn).catch((e         ) => {
          findings.push(error('app.component.schema-failed', `${app?.name ?? ap.app}: ${c.name} (${fqcn}) could not load its options: ${String(e instanceof Error ? e.message : e)}.`, { path: c.id }));
        }));
      }
    }
  }
  await Promise.all(jobs);
  return findings;
}

                               
                                         
                                                                                                                        
                       
                            
 

                             
                                  
                                                       
                                                   
                                        
                                                                                                                                           
                                       
 

const stateBackendOf = (plan      , p          )                         => {
  const b = plan.generate?.backend ?? 'platform';
  if (b === 'platform') return BOOTSTRAP_BACKEND[p] ?? 'local';
  return b;
};

/** The CI/CD pipeline for a generated app stack: one deploy stack per platform folder. */
export function pipelineFor(plan      , result                , cicd      )                                                         {
  if (cicd === 'none') return { files: {}, findings: [] };
  const folder = result.folder;
  const inner                         = {};
  for (const [k, v] of Object.entries(result.files)) if (k.startsWith(`${folder}/`)) inner[k.slice(folder.length + 1)] = v;
  const platforms = PLATFORM_VALUES.filter((p) => Object.keys(inner).some((k) => k.startsWith(`terraform/${p}/`)));
  if (platforms.length === 0) return { files: {}, findings: [] };
  const stacks                = platforms.map((p) => ({ platform: p, env: 'prod', dir: `terraform/${p}`, name: 'apps', backend: stateBackendOf(plan, p) }));
  const boot = backendBootstrapFiles(result.slice, result.design, stacks);
  const ci            = { planId: plan.id, stacks, files: { ...inner, ...boot.files } };
  const made = cicd === 'gitlab-ci' ? gitlabCiFiles(ci) : cicd === 'azure-devops' ? azureDevOpsFiles(ci) : githubActionsFiles(ci);
  const files                         = {};
  for (const [k, v] of Object.entries(boot.files)) files[`${folder}/${k}`] = v;
  for (const [k, v] of Object.entries(made.files)) files[`${folder}/${k}`] = v;
  return { files, findings: [...boot.findings, ...made.findings] };
}

/** Generate one app or a stack of apps: Terraform, Ansible, README, app plan, record, and the pipeline. */
export function buildStack(plan      , appIds                   , options               = {})             {
  const result = generateAppStack(plan, appIds, {
    ...(options.landingZone ? { landingZone: options.landingZone } : {}),
    ...(options.record !== undefined ? { record: options.record } : {}),
  });
  const cicd       = options.cicd ?? (plan.governance?.cicd && plan.governance.cicd !== 'none' ? plan.governance.cicd : 'github-actions');
  const pipe = pipelineFor(plan, result, cicd);
  const all                         = { ...result.files, ...pipe.files };
  const files                         = {};
  for (const k of Object.keys(all).sort()) files[k] = all[k] ;
  return { result, files, findings: [...result.findings, ...pipe.findings], pipeline: Object.keys(pipe.files).sort() };
}

/** The archive, dated from the plan's `savedAt` (the same plan gives the same bytes; no footprint). */
export function stackArchive(plan                       , files                                  , format                = 'zip')                      {
  const stamp = new Date(plan.savedAt);
  const when = Number.isNaN(stamp.getTime())
    ? new Date(1980, 0, 1)
    : new Date(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate(), stamp.getUTCHours(), stamp.getUTCMinutes(), stamp.getUTCSeconds());
  return format === 'tar.gz' ? tarGz(files, when) : zip(files, when);
}

/** The files as a tree for display: folder → file names. */
export function fileTree(files                                  )                                        {
  const by = new Map                  ();
  for (const path of Object.keys(files)) {
    const at = path.lastIndexOf('/');
    const folder = at >= 0 ? path.slice(0, at) : '';
    const list = by.get(folder) ?? [];
    list.push(path.slice(at + 1));
    by.set(folder, list);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, list]) => ({ folder, files: list.sort() }));
}

/** Whether an app's plan has been saved as planned or approved. */
export function isPlanned(plan      , appId        )          {
  const s = appPlanOf(plan, appId)?.status;
  return s === 'planned' || s === 'approved';
}

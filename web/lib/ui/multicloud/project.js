/**
 * The migration project the `#generate` pane downloads (addendum A.5.3).
 *
 * **Swap point.** `assembleMigrationProject` is the one function that glues
 * the generators together. WP-9's `generateProject` will do this assembly
 * (with the runbooks, the BOM and the decision record); when it lands, this
 * function's body becomes a call to it and the pane is unchanged.
 *
 * Every part is a folder of the project; each part's findings are kept apart
 * so the pane can show them under the part. The zip is dated from the plan's
 * `savedAt`, so the same plan gives the same bytes and no footprint.
 */

import { error,              } from '../../core/findings.js';
import { zip, tarGz } from '../../kit/archive.js';
import { writeSettings } from '../../kit/settings-file.js';
                                                
import { generateAppStack } from '../../multicloud/plan/apps/generate.js';
import { sliceFolder } from '../../multicloud/plan/apps/slice.js';
import { couplingFiles } from '../../multicloud/plan/coupling/collectors.js';
import { exitSequenceMarkdown } from '../../multicloud/plan/dcexit/sequence.js';
import { fetchQuotasScript } from '../../multicloud/plan/estate/fetch-quotas.js';
import { EXECUTE_DIR, executionKit } from '../../multicloud/plan/execute/kit.js';
import { ansibleFiles } from '../../multicloud/plan/generate/ansible.js';
import { planToStacks, terraformFiles,                    } from '../../multicloud/plan/generate/terraform.js';
import { changeRequestFiles, changeRequests } from '../../multicloud/plan/governance/changes.js';
import { cmdbFiles } from '../../multicloud/plan/governance/cmdb.js';
import { commsFiles, waveViews } from '../../multicloud/plan/governance/comms.js';
import { opsFiles } from '../../multicloud/plan/governance/ops-runbooks.js';
import { defaultRaci, raciFiles } from '../../multicloud/plan/governance/raci.js';
import { capacityGrids, executiveSummary, gridCsv } from '../../multicloud/plan/governance/reports.js';
import { collectorFiles } from '../../multicloud/plan/intake/sources/collectors.js';
import { backendBootstrapFiles } from '../../multicloud/plan/pipeline/backend-bootstrap.js';
import { azureDevOpsFiles } from '../../multicloud/plan/pipeline/ci-azdo.js';
                                                                             
import { githubActionsFiles } from '../../multicloud/plan/pipeline/ci-github.js';
import { gitlabCiFiles } from '../../multicloud/plan/pipeline/ci-gitlab.js';
import {
  environmentDeployStacks, environmentFiles, environmentStacks, estateDeployStacks,                                           
} from '../../multicloud/plan/pipeline/environments.js';
import { packerFiles } from '../../multicloud/plan/pipeline/packer.js';
import { defaultGovernance, slugName } from '../../multicloud/plan/options.js';
import { planEnvelope } from '../../multicloud/plan/store.js';
             
                                                                                                                   
                                        
import { exitPlanOf } from './wave-model.js';

/** The parts a migration project can hold, in the order the checklist shows them. */
                         
                                                                                                                                                      

export const PROJECT_PARTS                                                                                                                  = [
  { id: 'plan', label: 'Plan', folder: 'plan/', note: 'The plan itself, loadable on both pages.' },
  { id: 'landing-zones', label: 'Landing zones', folder: 'terraform/<platform>/', note: 'The landing zone, identity, connectivity and governance per platform (Terraform).' },
  { id: 'app-stacks', label: 'App stacks', folder: 'apps/<platform>/<env>/', note: 'Every app on a platform in one root module per environment, on the shared landing zone.' },
  { id: 'app-slices', label: 'Per-app projects', folder: 'apps/slices/<app>/', note: 'One project per selected application (Terraform, Ansible, its record).' },
  { id: 'ansible', label: 'Ansible', folder: 'ansible/', note: 'The site, inventories and roles for every planned server.' },
  { id: 'execution', label: 'Execution kit', folder: 'migration/execute/', note: 'Replication, test, cutover, rollback, validation and decommission scripts per path.' },
  { id: 'waves', label: 'Waves', folder: 'migration/', note: 'waves.csv and move-groups.csv (and the exit sequence in data-centre exit mode).' },
  { id: 'governance', label: 'Governance', folder: 'governance/', note: 'RACI, communications per wave, change requests, CMDB feeds and the operations runbooks.' },
  { id: 'reports', label: 'Reports', folder: 'reports/, capacity/', note: 'The executive summary, the capacity grids and the fetch-quotas script.' },
  { id: 'pipeline', label: 'Pipeline', folder: 'images/, ci/, backend-bootstrap/', note: 'Golden images (Packer), the CI/CD pipeline and the state-store bootstrap.' },
  { id: 'collectors', label: 'Collectors', folder: 'discovery/, coupling/', note: 'The discovery and coupling collectors to run on the source servers.' },
];

                                 
                                         
                                          
                                    
                                  
                                                                                         
                       
                                                                              
                                         
                                   
 

                                   
                                                               
                                                   
                                        
                                                      
                                                                                                                                      
                                                  
                        
 

                               
                      
                                  
                                
                           
 

const csvCell = (v         )         => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head                   , rows                                 )         => [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

/** The migration project: the swap point for WP-9's `generateProject`. */
export function assembleMigrationProject(input              , options                )                   {
  const { plan, decision, design, waves } = input;
  const withDecision       = { ...plan, decision };
  const root = slugName(plan.name) || 'migration-plan';
  const want = new Set(options.parts);
  const backend = options.backend ?? plan.generate?.backend ?? 'platform';
  const planB       = { ...withDecision, generate: { parts: plan.generate?.parts ?? ['terraform', 'ansible', 'waves', 'bom', 'record'], archive: plan.generate?.archive ?? 'zip', backend } };
  const governance = plan.governance ?? defaultGovernance();
  const raci = governance.raci.length > 0 ? governance.raci : defaultRaci(withDecision);
  const views = waveViews(plan, waves);
  const out                         = {};
  const parts                                                                = [];
  const handoffs                                                                                                              = { terraform: {} };

  const run = (part             , make                                                                                  )       => {
    if (!want.has(part)) return;
    const findings            = [];
    const paths           = [];
    try {
      const made = make();
      findings.push(...(made.findings ?? []));
      for (const [p, text] of Object.entries(made.files)) {
        out[p] = text;
        paths.push(p);
      }
    } catch (e) {
      findings.push(error('project.part-failed', `${PROJECT_PARTS.find((x) => x.id === part)?.label ?? part} could not be generated: ${e instanceof Error ? e.message : String(e)}`));
    }
    parts.push({ part, findings, paths: paths.sort() });
  };
  const prefix = (dir        , files                                  )                         =>
    Object.fromEntries(Object.entries(files).map(([p, t]) => [`${dir}/${p}`, t]));

  run('plan', () => ({ files: { 'plan/plan.json': writeSettings(planEnvelope(plan)                   , 'json') } }));

  run('landing-zones', () => {
    const tf = terraformFiles(planB, decision, design, { scope: 'landing-zone' });
    Object.assign(handoffs.terraform, tf.envelopes);
    return tf;
  });

  // App stacks per platform and environment, on the shared landing zone; the pipeline deploys them.
  const envOptions                     = { environments: options.environments ?? governance.environments, nonprodPct: options.nonprodPct ?? 25 };
  let appDeploy                = [];
  run('app-stacks', () => {
    const apps = planToStacks(planB, decision, design, { scope: 'apps', landingZone: 'shared' });
    const envs = environmentStacks(apps, envOptions, design);
    appDeploy = environmentDeployStacks(envs.stacks);
    const files = environmentFiles(planB, envs.stacks, envOptions);
    return { files: files.files, findings: [...apps.findings, ...envs.findings, ...files.findings] };
  });

  run('app-slices', () => {
    const files                         = {};
    const findings            = [];
    for (const id of options.apps ?? []) {
      const one = generateAppStack(planB, [id], { backend });
      const folder = sliceFolder(planB, [id]);
      for (const [p, t] of Object.entries(one.files)) files[`apps/slices/${p}`] = t;
      findings.push(...one.findings.map((f) => ({ ...f, path: f.path ? `apps/slices/${folder}/${f.path}` : `apps/slices/${folder}` })));
    }
    return { files, findings };
  });

  run('ansible', () => {
    const an = ansibleFiles(planB, decision, design);
    handoffs.ansible = an.envelope;
    return an;
  });

  run('execution', () => {
    const kit = executionKit(planB, decision, design, waves);
    return { files: prefix(EXECUTE_DIR, kit.files), findings: kit.findings };
  });

  run('waves', () => {
    const groupWave = new Map(waves.groups.map((g) => [g.id, g.wave]));
    const files                         = {
      'migration/waves.csv': csv(['wave', 'name', 'kind', 'start', 'end', 'move_groups', 'limited_by'], [...waves.waves].sort((a, b) => a.n - b.n).map((w) => [w.n, w.name ?? '', w.kind ?? 'app', w.start ?? '', w.end ?? '', w.groups.join(' '), w.limitedBy ?? ''])),
      'migration/move-groups.csv': csv(['group', 'name', 'wave', 'method', 'apps', 'items', 'why'], waves.groups.map((g) => [g.id, g.name ?? '', groupWave.get(g.id) ?? g.wave, g.method, (g.apps ?? []).join(' '), g.items.join(' '), g.why])),
    };
    const exit = exitPlanOf(plan, { ...waves, waves: waves.waves.filter((w) => w.kind !== 'exit') });
    if (exit) files['migration/exit-sequence.md'] = exitSequenceMarkdown(exit);
    return { files, findings: waves.findings };
  });

  run('governance', () => {
    const files                         = { ...raciFiles(raci) };
    const findings            = [];
    for (const wave of views) Object.assign(files, commsFiles({ plan: withDecision, wave, raci, ...(plan.execution ? { execution: plan.execution } : {}), governance }));
    const crs = changeRequests(withDecision, views, { on: plan.savedAt.slice(0, 10), ...(plan.execution ? { execution: plan.execution } : {}) });
    Object.assign(files, changeRequestFiles(crs, { script: governance.cr.system === 'servicenow' }));
    const cmdb = cmdbFiles(withDecision, { design });
    Object.assign(files, cmdb.files);
    findings.push(...cmdb.findings);
    const ops = opsFiles(withDecision, raci, { design });
    Object.assign(files, ops.files);
    findings.push(...ops.findings);
    return { files, findings };
  });

  run('reports', () => {
    const ctx = { plan: withDecision, waves: views, design, raci };
    const summary = executiveSummary(ctx);
    const files                         = {
      'reports/executive-summary.md': summary.markdown,
      'reports/executive-summary.html': summary.html,
      'capacity/fetch-quotas.sh': fetchQuotasScript(plan),
    };
    for (const g of capacityGrids(ctx)) files[`reports/capacity/${slugName(g.name) || 'grid'}.csv`] = gridCsv(g);
    return { files };
  });

  run('pipeline', () => {
    const lz = planToStacks(planB, decision, design, { scope: 'landing-zone' });
    const lzStacks = Object.values(lz.perPlatform).filter((s)                     => !!s);
    const deploy = [...estateDeployStacks(lz, 'landing-zone'), ...appDeploy];
    const apps = planToStacks(planB, decision, design, { scope: 'apps', landingZone: 'shared' });
    const appStacks = Object.values(apps.perPlatform).filter((s)                     => !!s);
    const packer = packerFiles(planB, design, [...lzStacks, ...appStacks]);
    const boot = backendBootstrapFiles(planB, design, deploy);
    const flavour = options.cicd ?? (governance.cicd === 'none' ? 'github-actions' : governance.cicd);
    const ci            = { planId: plan.id, stacks: deploy, images: packer.images, files: { ...out, ...packer.files, ...boot.files } };
    const made = flavour === 'gitlab-ci' ? gitlabCiFiles(ci) : flavour === 'azure-devops' ? azureDevOpsFiles(ci) : githubActionsFiles(ci);
    return {
      files: { ...packer.files, ...boot.files, ...prefix('ci', made.files) },
      findings: [...packer.findings, ...boot.findings, ...made.findings],
    };
  });

  run('collectors', () => ({ files: { ...prefix('discovery', collectorFiles()), ...prefix('coupling', couplingFiles()) } }));

  out['README.md'] = readme(plan, parts);
  const files                         = {};
  for (const k of Object.keys(out).sort()) files[`${root}/${k}`] = out[k]          ;
  return {
    files,
    findings: parts.flatMap((p) => p.findings),
    parts: parts.map((p) => ({ ...p, paths: p.paths.map((x) => `${root}/${x}`) })),
    handoffs,
    root,
  };
}

function readme(plan      , parts                                                            )         {
  const lines = [
    `# ${plan.name}: migration project`,
    '',
    'Everything here applies as generated. Credentials are never in these files: they come from environment variables, Ansible Vault (`vault_*`, `no_log: true`), sensitive Terraform variables or the cloud\'s own secret stores.',
    '',
    '## Parts',
    '',
    ...parts.map((p) => {
      const info = PROJECT_PARTS.find((x) => x.id === p.part);
      return `- **${info?.label ?? p.part}** (\`${info?.folder ?? ''}\`): ${info?.note ?? ''} ${p.paths.length} file${p.paths.length === 1 ? '' : 's'}.`;
    }),
    '',
    '## Order of operations',
    '',
    '1. `backend-bootstrap/<platform>/` once, where the stacks keep remote state.',
    '2. `terraform/<platform>/`: the landing zones (wave 0).',
    '3. `apps/…`: the application stacks, then `ansible/`.',
    '4. `migration/execute/`: replicate, test, cut over, validate and decommission, wave by wave (see `migration/waves.csv`).',
    '',
  ];
  return lines.join('\n');
}

/** The zip's date: the plan's `savedAt`, as a zone-free local date, so the bytes do not depend on where it is built. */
export function projectDate(plan                       )       {
  const stamp = new Date(plan.savedAt);
  return Number.isNaN(stamp.getTime())
    ? new Date(1980, 0, 1)
    : new Date(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate(), stamp.getUTCHours(), stamp.getUTCMinutes(), stamp.getUTCSeconds());
}

/** The project as one archive. */
export function archiveProject(plan                       , files                                  , format                = 'zip')                      {
  return format === 'tar.gz' ? tarGz(files, projectDate(plan)) : zip(files, projectDate(plan));
}

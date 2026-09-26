/**
 * Deploy a new service (addendum A.9.3): a greenfield application plan
 * (origin `new`, status planned or approved) deployed into an existing
 * landing zone, with no waves, replication or cutover.
 *
 *   1. Pick the app plan and the environment (dev → test → preprod → prod).
 *   2. Generate the app stack for that environment in `shared` landing-zone
 *      mode (`generateAppStack`), its Ansible, and the pipeline (A.10.11)
 *      when the plan has a CI/CD system.
 *   3. Wire: the ingress DNS names (the stack writes the records in a cloud
 *      zone; a Windows DNS or Infoblox zone is a step), the security rules
 *      the app's dependencies need (listed, with the open-port utility), and
 *      the monitoring and backup tags the stack carries.
 *   4. Validate: the app's smoke checks (HTTP, TCP) from the controller.
 *   5. Track: the events use the `deploy` path with the app as the item, so
 *      the tracker moves it planned → prepared (the `deploy` step) →
 *      validated (the `validate` step); accepted is a person's call.
 */

import { generateAppStack } from '../plan/apps/generate.ts';
import { appPlanOf, findApp, appWorkloads } from '../plan/apps/components.ts';
import { ENV_OPTIONS, PLATFORM_LABELS } from '../plan/options.ts';
import { BOOTSTRAP_BACKEND } from '../plan/pipeline/backend-bootstrap.ts';
import { azureDevOpsFiles } from '../plan/pipeline/ci-azdo.ts';
import { githubActionsFiles } from '../plan/pipeline/ci-github.ts';
import { gitlabCiFiles } from '../plan/pipeline/ci-gitlab.ts';
import type { DeployStack } from '../plan/pipeline/environments.ts';
import type { Cicd, Env, Platform } from '../plan/types.ts';
import {
  ALL_PLATFORMS, error, info, opt, platformInput, platformOf, val, warning, yq,
  type ChangeStep, type ChangeUtility, type Finding, type UtilityResult,
} from './utilities/common.ts';

const CICD_OPTIONS = [opt('plan', 'The plan\'s choice'), opt('none', 'None'), opt('github-actions', 'GitHub Actions'), opt('azure-devops', 'Azure DevOps'), opt('gitlab-ci', 'GitLab CI')];

/** The smoke checks as a playbook run on the controller (http: uri, tcp: wait_for). */
export function smokePlaybook(app: string, checks: readonly { kind: string; target: string; expect?: string; maxMs?: number }[]): string {
  const tasks: string[] = [];
  checks.forEach((c, i) => {
    if (c.kind === 'http') {
      tasks.push(`    - name: Smoke ${i + 1} - ${c.target.replace(/[{}]/g, '')} answers
      ansible.builtin.uri:
        url: ${yq(c.target)}
        status_code: ${/^\d{3}$/.test(c.expect ?? '') ? c.expect : 200}
        timeout: ${Math.max(1, Math.ceil((c.maxMs ?? 5000) / 1000))}
      register: change_smoke_${i + 1}
      retries: 10
      delay: 15
      until: change_smoke_${i + 1}.status is defined and change_smoke_${i + 1}.status == ${/^\d{3}$/.test(c.expect ?? '') ? c.expect : 200}`);
    } else if (c.kind === 'tcp') {
      const [host = c.target, port = '443'] = c.target.includes(']:') ? [c.target.slice(1, c.target.indexOf(']')), c.target.split(']:')[1]] : c.target.split(':');
      tasks.push(`    - name: Smoke ${i + 1} - ${host} port ${port} answers
      ansible.builtin.wait_for:
        host: ${yq(host)}
        port: ${Number(port) || 443}
        timeout: 300`);
    } else {
      tasks.push(`    - name: Smoke ${i + 1} - ${c.kind} check is by hand
      ansible.builtin.debug:
        msg: ${yq(`Run the ${c.kind} check against ${c.target} by hand.`)}`);
    }
  });
  if (!tasks.length) {
    tasks.push(`    - name: No smoke checks in the app plan
      ansible.builtin.debug:
        msg: Add smoke checks to the app plan on Application Migration so the deployment is validated.`);
  }
  return [
    `# Smoke checks of ${app}, run from the controller after the deployment (validate_phase=deploy).`,
    '---',
    `- name: Validate ${app}`,
    '  hosts: localhost',
    '  connection: local',
    '  gather_facts: false',
    '  vars:',
    '    validate_phase: deploy',
    '  tasks:',
    tasks.join('\n\n'),
    '',
  ].join('\n');
}

export const deployService: ChangeUtility = {
  id: 'deploy-service',
  label: 'Deploy a new service',
  category: 'deploy',
  description: 'A new application (a greenfield app plan, planned or approved) into the existing landing zone, one environment at a time: its app stack in shared landing-zone mode, its Ansible, the pipeline, the DNS and rule wiring, and its smoke checks. No waves, replication or cutover; the tracker shows it planned → prepared → validated → accepted.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Destroys the environment\'s app stack (terraform destroy); its data goes with it.',
  source: 'A.9.3',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'app', label: 'Application', control: 'combo', default: 'portal', from: 'new-app', hint: 'A new application whose plan is planned or approved.' },
    { id: 'env', label: 'Environment', control: 'select', default: 'dev', options: ENV_OPTIONS.map((o) => opt(o.value, o.label)), hint: 'Promote in order: dev, test, preprod, prod.' },
    { id: 'cicd', label: 'Pipeline', control: 'select', default: 'plan', options: CICD_OPTIONS },
  ],
  build(values, ctx): UtilityResult {
    let platform = platformOf(values, deployService);
    const findings: Finding[] = [];
    const appRef = val(values, 'app', 'portal');
    const env = val(values, 'env', 'dev') as Env;
    const plan = ctx.plan;
    const app = plan ? findApp(plan, appRef) : undefined;
    const ap = plan && app ? appPlanOf(plan, app.id) : undefined;
    const item = app?.id ?? `a:${appRef}`;
    if (!plan || !app || !ap) {
      findings.push(error('change.deploy.no-app', `No application plan for ${appRef}: create it on Application Migration (a new application) first.`, { path: 'app' }));
      return {
        platform, target: appRef, route: 'manual', summary: `Deploy ${appRef} to ${env}`, files: {}, findings, channel: 'deploy', item,
        apply: [{ kind: 'manual', title: 'Plan the application', text: `create ${appRef} on Application Migration and set its plan to planned` }],
        rollback: [{ kind: 'manual', title: 'Nothing to undo', text: 'nothing was deployed' }],
        needs: [],
      };
    }
    if (ap.origin !== 'new') findings.push(warning('change.deploy.not-new', `${app.name} is a migrating application: it moves with waves on the Migrate area; this deploys its stack without moving anything.`, { path: 'app' }));
    if (ap.status !== 'planned' && ap.status !== 'approved') findings.push(error('change.deploy.draft', `${app.name}'s plan is a draft: set it to planned (or approved) first.`, { path: 'app' }));
    if (ap.platform && ap.platform !== platform) {
      findings.push(info('change.deploy.platform', `${app.name} is planned on ${PLATFORM_LABELS[ap.platform]}: it deploys there.`));
      platform = ap.platform;
    }
    const envs = ap.load?.environments ?? ['prod'];
    if (!envs.includes(env)) findings.push(warning('change.deploy.env', `${env} is not one of ${app.name}'s environments (${envs.join(', ')}).`, { path: 'env' }));
    const g = generateAppStack(plan, [app.id], { landingZone: 'shared', environment: env, record: false, ...(ctx.lookup ? { lookup: ctx.lookup } : {}), ...(ctx.ansibleLookup ? { ansibleLookup: ctx.ansibleLookup } : {}) });
    findings.push(...g.findings.filter((f) => f.severity !== 'info'));
    const files: Record<string, string> = {};
    for (const [k, t] of Object.entries(g.files)) files[`app/${k.slice(g.folder.length + 1)}`] = t;
    const platforms = [...new Set(Object.keys(files).map((f) => /^app\/terraform\/([a-z]+)\//.exec(f)?.[1]).filter((p): p is Platform => !!p))];
    if (!platforms.length) findings.push(error('change.deploy.empty', `The app stack of ${app.name} has no Terraform for ${env}: check its components on Application Migration.`));
    const apply: ChangeStep[] = platforms.map((p) => ({ kind: 'terraform', title: `Build ${app.name} (${env}) on ${PLATFORM_LABELS[p]}`, dir: `app/terraform/${p}`, lz: true }));
    const rollback: ChangeStep[] = [...platforms].reverse().map((p) => ({ kind: 'terraform-destroy', title: `Destroy ${app.name} (${env}) on ${PLATFORM_LABELS[p]}`, dir: `app/terraform/${p}`, lz: true }));
    if (files['app/ansible/site.yml']) apply.push({ kind: 'ansible', title: `Configure ${app.name}'s servers`, playbook: 'site.yml', dir: 'app/ansible' });

    // Wiring: DNS in zones the stack does not write, and the rules the dependencies need.
    const zones = plan.execution?.dnsZones ?? [];
    for (const fqdn of ap.ingress?.fqdns ?? []) {
      const zone = zones.filter((z) => fqdn === z.zone || fqdn.endsWith(`.${z.zone}`)).sort((a, b) => b.zone.length - a.zone.length)[0];
      if (zone && (zone.provider === 'windows-dns' || zone.provider === 'infoblox')) {
        apply.push({ kind: 'manual', title: `Point ${fqdn} at the ingress`, text: `add ${fqdn} in ${zone.provider === 'infoblox' ? 'Infoblox' : 'Windows DNS'} with the ingress address from "terraform -chdir=app/terraform/${platform} output" (the Add a DNS record utility does it)` });
      }
    }
    const names = new Set([app.name, ...appWorkloads(plan, app).map((w) => w.name)]);
    const deps = plan.edges.filter((e) => names.has(e.from) && !names.has(e.to));
    if (deps.length) {
      findings.push(info('change.deploy.rules', `${app.name} depends on ${[...new Set(deps.map((d) => d.to))].join(', ')}: open those flows with the Open a port utility if the landing zone's tier rules do not already allow them.`));
    }

    // The pipeline (A.10.11).
    const choice = val(values, 'cicd', 'plan');
    const cicd = (choice === 'plan' ? plan.governance?.cicd ?? 'none' : choice) as Cicd;
    if (cicd !== 'none') {
      const stacks: DeployStack[] = platforms.map((p) => ({ platform: p, env, dir: `app/terraform/${p}`, name: 'apps', backend: BOOTSTRAP_BACKEND[p] ?? 'local' }));
      const ci = { planId: plan.id, stacks, files };
      const out = cicd === 'github-actions' ? githubActionsFiles(ci) : cicd === 'azure-devops' ? azureDevOpsFiles(ci) : gitlabCiFiles(ci);
      Object.assign(files, out.files);
      findings.push(...out.findings.filter((f) => f.severity !== 'info'));
    }

    files['validate/ansible.cfg'] = '[defaults]\ninventory = localhost,\n';
    files['validate/smoke.yml'] = smokePlaybook(app.name, ap.smoke ?? []);
    const validate: ChangeStep[] = [{ kind: 'ansible', title: `Smoke checks of ${app.name}`, playbook: 'smoke.yml', dir: 'validate' }];
    return {
      platform, target: `${app.name}-${env}`, route: 'mixed', summary: `Deploy ${app.name} to ${env} on ${PLATFORM_LABELS[platform]}`, files, findings, channel: 'deploy', item,
      apply, rollback, validate, needs: [],
      notes: [
        `The tracker item is ${item} (path deploy): apply.sh moves it to prepared, the smoke checks to validated; accept it on the board.`,
        'Deploy dev first, then test, preprod and prod: generate one bundle per environment.',
      ],
    };
  },
};

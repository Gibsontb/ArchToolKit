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

import { error, type Finding } from '../../core/findings.ts';
import { zip, tarGz } from '../../kit/archive.ts';
import { appPlanOf, findApp } from '../../multicloud/plan/apps/components.ts';
import { generateAppStack, placedSlice, type AppStackResult } from '../../multicloud/plan/apps/generate.ts';
import { BOOTSTRAP_BACKEND, backendBootstrapFiles } from '../../multicloud/plan/pipeline/backend-bootstrap.ts';
import { azureDevOpsFiles } from '../../multicloud/plan/pipeline/ci-azdo.ts';
import type { CiOptions } from '../../multicloud/plan/pipeline/ci-common.ts';
import { githubActionsFiles } from '../../multicloud/plan/pipeline/ci-github.ts';
import { gitlabCiFiles } from '../../multicloud/plan/pipeline/ci-gitlab.ts';
import type { DeployStack } from '../../multicloud/plan/pipeline/environments.ts';
import { PLATFORM_VALUES } from '../../multicloud/plan/options.ts';
import type { ArchiveFormat, Cicd, LandingZoneMode, Plan, Platform } from '../../multicloud/plan/types.ts';
import { loadResource } from '../../terraform/schema-blueprints.ts';
import { loadModule } from '../../ansible/module-blueprints.ts';
import { moduleFromBlueprintId } from '../../terraform/equivalence.ts';

/** The FQCN a `mod_*` blueprint id names (dots are underscores in the id). */
export function moduleOfBlueprint(id: string, names: () => readonly string[]): string | undefined {
  if (!id.startsWith('mod_')) return undefined;
  return moduleFromBlueprintId(id) ?? names().find((n) => `mod_${n.replace(/\./g, '_')}` === id);
}

/**
 * Fetch the schema of every resource and module component the selection
 * builds (on each app's placed platform). Failures come back as error
 * findings naming the component and the file.
 */
export async function loadComponentSchemas(plan: Plan, appIds: readonly string[], moduleNames: () => readonly string[]): Promise<Finding[]> {
  const slice = placedSlice(plan, appIds);
  const findings: Finding[] = [];
  const jobs: Promise<void>[] = [];
  for (const ap of slice.appPlans ?? []) {
    const p = ap.platform;
    if (!p) continue;
    const app = findApp(slice, ap.app);
    for (const c of ap.variants[p] ?? []) {
      if (c.kind === 'resource') {
        jobs.push(loadResource(c.type).catch((e: unknown) => {
          findings.push(error('app.component.schema-failed', `${app?.name ?? ap.app}: ${c.name} (${c.type}) could not load its schema: ${String(e instanceof Error ? e.message : e)}.`, { path: c.id }));
        }));
      } else if (c.kind === 'config') {
        const fqcn = moduleOfBlueprint(c.blueprintId, moduleNames);
        if (!fqcn) continue;
        jobs.push(loadModule(fqcn).catch((e: unknown) => {
          findings.push(error('app.component.schema-failed', `${app?.name ?? ap.app}: ${c.name} (${fqcn}) could not load its options: ${String(e instanceof Error ? e.message : e)}.`, { path: c.id }));
        }));
      }
    }
  }
  await Promise.all(jobs);
  return findings;
}

export interface StackOptions {
  readonly landingZone?: LandingZoneMode;
  /** The CI/CD flavour; 'none' leaves the pipeline out. Default: the plan's governance setting, else GitHub Actions. */
  readonly cicd?: Cicd;
  readonly record?: boolean;
}

export interface StackBuild {
  readonly result: AppStackResult;
  /** The stack's files plus the pipeline's, sorted. */
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  /** The pipeline's files (the CI definition and `ci/` scripts at the folder's root, and the state-store bootstrap), when one was made. */
  readonly pipeline: readonly string[];
}

const stateBackendOf = (plan: Plan, p: Platform): DeployStack['backend'] => {
  const b = plan.generate?.backend ?? 'platform';
  if (b === 'platform') return BOOTSTRAP_BACKEND[p] ?? 'local';
  return b;
};

/** The CI/CD pipeline for a generated app stack: one deploy stack per platform folder. */
export function pipelineFor(plan: Plan, result: AppStackResult, cicd: Cicd): { files: Record<string, string>; findings: Finding[] } {
  if (cicd === 'none') return { files: {}, findings: [] };
  const folder = result.folder;
  const inner: Record<string, string> = {};
  for (const [k, v] of Object.entries(result.files)) if (k.startsWith(`${folder}/`)) inner[k.slice(folder.length + 1)] = v;
  const platforms = PLATFORM_VALUES.filter((p) => Object.keys(inner).some((k) => k.startsWith(`terraform/${p}/`)));
  if (platforms.length === 0) return { files: {}, findings: [] };
  const stacks: DeployStack[] = platforms.map((p) => ({ platform: p, env: 'prod', dir: `terraform/${p}`, name: 'apps', backend: stateBackendOf(plan, p) }));
  const boot = backendBootstrapFiles(result.slice, result.design, stacks);
  const ci: CiOptions = { planId: plan.id, stacks, files: { ...inner, ...boot.files } };
  const made = cicd === 'gitlab-ci' ? gitlabCiFiles(ci) : cicd === 'azure-devops' ? azureDevOpsFiles(ci) : githubActionsFiles(ci);
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(boot.files)) files[`${folder}/${k}`] = v;
  for (const [k, v] of Object.entries(made.files)) files[`${folder}/${k}`] = v;
  return { files, findings: [...boot.findings, ...made.findings] };
}

/** Generate one app or a stack of apps: Terraform, Ansible, README, app plan, record, and the pipeline. */
export function buildStack(plan: Plan, appIds: readonly string[], options: StackOptions = {}): StackBuild {
  const result = generateAppStack(plan, appIds, {
    ...(options.landingZone ? { landingZone: options.landingZone } : {}),
    ...(options.record !== undefined ? { record: options.record } : {}),
  });
  const cicd: Cicd = options.cicd ?? (plan.governance?.cicd && plan.governance.cicd !== 'none' ? plan.governance.cicd : 'github-actions');
  const pipe = pipelineFor(plan, result, cicd);
  const all: Record<string, string> = { ...result.files, ...pipe.files };
  const files: Record<string, string> = {};
  for (const k of Object.keys(all).sort()) files[k] = all[k]!;
  return { result, files, findings: [...result.findings, ...pipe.findings], pipeline: Object.keys(pipe.files).sort() };
}

/** The archive, dated from the plan's `savedAt` (the same plan gives the same bytes; no footprint). */
export function stackArchive(plan: Pick<Plan, 'savedAt'>, files: Readonly<Record<string, string>>, format: ArchiveFormat = 'zip'): Promise<Uint8Array> {
  const stamp = new Date(plan.savedAt);
  const when = Number.isNaN(stamp.getTime())
    ? new Date(1980, 0, 1)
    : new Date(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate(), stamp.getUTCHours(), stamp.getUTCMinutes(), stamp.getUTCSeconds());
  return format === 'tar.gz' ? tarGz(files, when) : zip(files, when);
}

/** The files as a tree for display: folder → file names. */
export function fileTree(files: Readonly<Record<string, string>>): { folder: string; files: string[] }[] {
  const by = new Map<string, string[]>();
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
export function isPlanned(plan: Plan, appId: string): boolean {
  const s = appPlanOf(plan, appId)?.status;
  return s === 'planned' || s === 'approved';
}

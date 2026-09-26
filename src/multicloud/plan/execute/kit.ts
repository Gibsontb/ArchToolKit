/**
 * `executionKit`: a decided, designed and waved plan becomes the execution
 * kit, `migration/execute/` (addendum A.6.2).
 *
 *   1. every workload and database gets its path (`paths.ts`);
 *   2. the manifest lists the items with a path (`manifest.ts`);
 *   3. the items are grouped by the generator registered for their path
 *      (`registry.ts`); a path with no generator goes to the pending script;
 *   4. each generator writes its files; the kit adds the libraries, the
 *      schema, the manifest, `controller-check.sh` and the README.
 *
 * File keys are relative to `migration/execute/` (`EXECUTE_DIR`); WP-9's
 * `generateProject` puts them there. The files are sorted and carry no
 * footprint, so the same plan gives the same kit byte for byte.
 */

import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { defaultExecution } from '../options.ts';
import type { ItemId, Plan, PlanDecision, TargetDesign, Tracker, WavePlan } from '../types.ts';
import { contractViolations, EXECUTE_DIR, type ExecPath } from './contract.ts';
import { BASE_NEEDS, PWSH_NEED, renderControllerCheck, renderReadme, type ReadmePath } from './controller.ts';
import { renderLibPs } from './lib-ps.ts';
import { renderLibSh } from './lib-sh.ts';
import { buildManifest, renderItemsJson, renderItemsTsv, renderWavesJson, type Manifest, type ManifestItem } from './manifest.ts';
import { resolvePlanPaths, type PathResolution } from './paths.ts';
import { PATH_OWNERS, PATH_REGISTRY, pendingGenerator, type PathContext, type PathGenerator, type PathRegistry, type ToolNeed } from './registry.ts';
import { renderStatusSchema } from './schema.ts';
import { waveKit } from './waves/index.ts';

export interface ExecutionKitOptions {
  /** The generators to use; default `PATH_REGISTRY`. */
  readonly registry?: PathRegistry;
  /** Check every generated script against the contract and report violations as errors (default true). */
  readonly checkContract?: boolean;
}

export interface ExecutionKit {
  /** Relative to `migration/execute/`. */
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  readonly manifest: Manifest;
  /** Every workload's and database's resolution, retained items included. */
  readonly resolutions: ReadonlyMap<ItemId, PathResolution<ExecPath>>;
  readonly needs: readonly ToolNeed[];
}

export { EXECUTE_DIR };

const HOOKS_README = `# Wave hooks

Put executables in \`hooks/<wave>/pre-cutover.d/\` or \`hooks/<wave>/post-cutover.d/\` (for example \`hooks/3/pre-cutover.d/10-drain-batch\`). The wave's \`cutover.sh\` runs them in name order before the freeze and after the post-configuration; a hook that exits non-zero stops the wave for its items. Hooks get \`ATK_RUN_ID\`, \`ATK_WAVE\` and \`ATK_DRY_RUN\` in the environment and must honour a dry run themselves.
`;

/** Aggregates the per-item path warnings into one finding per path and code. */
function aggregate(findings: readonly Finding[]): Finding[] {
  const per = new Map<string, { f: Finding; items: Set<string> }>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (f.code === 'exec.path.no-fallback' || f.code === 'exec.path.tool-retired' || f.code === 'exec.path.tool-renamed' || f.code.startsWith('exec.hcx.')) {
      const key = `${f.code}|${f.message}`;
      const had = per.get(key);
      if (had) { if (f.path) had.items.add(f.path); } else per.set(key, { f, items: new Set(f.path ? [f.path] : []) });
    } else {
      out.push(f);
    }
  }
  for (const { f, items } of per.values()) {
    const { path: _p, ...rest } = f;
    out.push({ ...rest, message: items.size > 1 ? `${f.message} (${items.size} items)` : f.message, ...(items.size === 1 ? { path: [...items][0]! } : {}) });
  }
  return out;
}

export function executionKit(
  plan: Plan,
  decision: PlanDecision,
  design: TargetDesign,
  waves: WavePlan,
  tracker?: Tracker,
  options: ExecutionKitOptions = {},
): ExecutionKit {
  const registry = options.registry ?? PATH_REGISTRY;
  const findings: Finding[] = [];
  if (tracker && tracker.planId !== plan.id) {
    findings.push(warning('exec.kit.tracker-other-plan', 'The tracker belongs to another plan, so its states are not written into the manifest.'));
    tracker = undefined;
  }

  // 1. paths
  const resolved = resolvePlanPaths(plan, decision);
  const all: PathResolution<ExecPath>[] = [...resolved.workloads, ...resolved.databases];
  const resolutions = new Map<ItemId, PathResolution<ExecPath>>(all.map((r) => [r.item, r]));
  findings.push(...aggregate(all.flatMap((r) => r.findings)));

  // 2. manifest (scripts are filled in once the generators are known)
  const base = buildManifest(plan, decision, design, waves, all, tracker);

  // 3. generators
  const inUse = [...new Set(base.items.map((i) => i.path))].sort();
  const missing = inUse.filter((p) => !registry.get(p));
  const pending = missing.length ? pendingGenerator(missing) : undefined;
  const generatorOf = (p: ExecPath): PathGenerator => registry.get(p) ?? pending!;
  for (const p of missing) {
    findings.push(warning('exec.path.no-generator', `No generator for the ${p} path is installed (it comes from ${PATH_OWNERS[p]}); its items get a script that fails every verb and says so.`, { remediation: 'Move those items by hand and record them in the tracker, or regenerate the kit once the generator is installed.' }));
  }
  const items: ManifestItem[] = base.items.map((i) => ({ ...i, script: generatorOf(i.path).entry(i.path) }));
  const manifest: Manifest = { ...base, items };
  const settings = plan.execution ?? defaultExecution();
  const ctx: PathContext = { plan, decision, design, waves, settings, manifest, resolutions, ...(tracker ? { tracker } : {}) };

  const files: Record<string, string> = {};
  const owner = new Map<string, string>();
  const put = (path: string, text: string, by: string): void => {
    if (!path || path.startsWith('/') || path.split('/').includes('..') || /^[A-Za-z]:/.test(path) || path.includes('\\')) {
      findings.push(error('exec.kit.bad-file', `${by} wrote a file outside the kit: ${path}`));
      return;
    }
    const had = files[path];
    if (had !== undefined && had !== text) {
      findings.push(error('exec.kit.file-clash', `${by} and ${owner.get(path)} both write ${path}, differently.`));
      return;
    }
    files[path] = text;
    owner.set(path, by);
  };

  const groups = new Map<PathGenerator, ManifestItem[]>();
  for (const i of items) {
    const g = generatorOf(i.path);
    const list = groups.get(g) ?? [];
    list.push(i);
    groups.set(g, list);
  }
  const needs: ToolNeed[] = [...BASE_NEEDS];
  for (const [g, list] of [...groups.entries()].sort((a, b) => a[0].id.localeCompare(b[0].id))) {
    needs.push(...g.needs);
    let out: Readonly<Record<string, string>>;
    try {
      out = g.files(list, ctx);
      findings.push(...(g.findings?.(list, ctx) ?? []));
    } catch (e) {
      findings.push(error('exec.kit.generator-failed', `The ${g.id} path generator failed: ${e instanceof Error ? e.message : String(e)}`));
      continue;
    }
    for (const [path, text] of Object.entries(out)) put(path, text, g.id);
    for (const p of new Set(list.map((i) => i.path))) {
      const entry = g.entry(p);
      if (!(entry in out)) findings.push(error('exec.kit.no-entry', `The ${g.id} path generator names ${entry} as the ${p} script but does not write it.`));
    }
  }

  // The wave orchestrators, DNS / LB switching and the kit-level plays.
  const wk = waveKit(ctx);
  for (const [p, t] of Object.entries(wk.files)) put(p, t, 'waves');
  needs.push(...wk.needs);
  findings.push(...wk.findings);

  // 4. the kit's own files
  const hasPs = Object.keys(files).some((f) => f.endsWith('.ps1')) || needs.some((n) => n.kind === 'pwsh-module');
  if (hasPs) needs.push(PWSH_NEED);
  put('lib/atk.sh', renderLibSh(), 'core');
  put('lib/Atk.psm1', renderLibPs(), 'core');
  put('status.schema.json', renderStatusSchema(), 'core');
  put('manifest/items.json', renderItemsJson(manifest), 'core');
  put('manifest/items.tsv', renderItemsTsv(manifest), 'core');
  put('manifest/waves.json', renderWavesJson(manifest), 'core');
  put('controller-check.sh', renderControllerCheck(needs), 'core');
  put('hooks/README.md', HOOKS_README, 'core');
  const counts = new Map<ExecPath, number>();
  for (const i of items) counts.set(i.path, (counts.get(i.path) ?? 0) + 1);
  const readmePaths: ReadmePath[] = [...counts.entries()].map(([path, n]) => ({
    path, items: n, script: generatorOf(path).entry(path), owner: PATH_OWNERS[path], pending: !registry.get(path),
  }));
  const waveNumbers = [...new Set(items.map((i) => i.wave).filter((w): w is number => w !== null))].sort((a, b) => a - b);
  put('README.md', renderReadme({ paths: readmePaths, needs, warnings: findings, waves: waveNumbers, hasPs }), 'core');

  const unwaved = items.filter((i) => i.wave === null);
  if (unwaved.length) {
    findings.push(info('exec.kit.no-wave', `${unwaved.length} item(s) with a path are in no wave; their scripts run them only without --wave.`, { remediation: 'Plan the waves, then regenerate the kit.' }));
  }

  if (options.checkContract ?? true) {
    for (const [path, text] of Object.entries(files)) {
      for (const v of contractViolations(path, text)) findings.push(error('exec.kit.contract', v));
    }
  }

  const sorted: Record<string, string> = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k]!;
  return { files: sorted, findings, manifest, resolutions, needs };
}

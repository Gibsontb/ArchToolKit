/**
 * What the wizard's design builds on the chosen cloud, read from the real
 * generators, so the "What gets built" lists can never disagree with the
 * download:
 *
 *   - the app placed on its cloud (`previewDesign` → `placedSlice`), decided
 *     and designed (`decideApps`, `designPlan` with the pattern mappers);
 *   - the Terraform items `planToStacks` would write for it (each with its
 *     blueprint's resource types) and the Ansible plays `planToSite` would
 *     run on its hosts;
 *   - every server's and database's migration path (`resolveMovePath`,
 *     `resolveDbPath`), the licences the decision counts, the connectors, the
 *     landing-zone decision and how the cloud takes the output.
 *
 * Anything the wizard names that the generator cannot build is listed as
 * "named, not generated" with the reason, never left out.
 */

import type { Finding } from '../../../core/findings.ts';
import type { BlueprintLookup } from '../../../kit/stack.ts';
import { findAnsibleBlueprint } from '../../../ansible/blueprints/index.ts';
import { findTerraformBlueprint } from '../../../terraform/blueprints/index.ts';
import { DB_SERVICES } from '../db-catalog.ts';
import { designPlan } from '../design/index.ts';
import { pathLabel, resolveDbPath, resolveMovePath } from '../execute/paths.ts';
import { planToSite } from '../generate/ansible.ts';
import { planToStacks, withPlanBlueprints } from '../generate/terraform.ts';
import { LICENCE_KIND_OPTIONS, LICENCE_MODEL_OPTIONS, PLATFORM_LABELS, TIER_PATTERN_OPTIONS, labelOf } from '../options.ts';
import { isNone, tierTarget, withPatternMappers } from '../patterns/index.ts';
import type { LicenceKind, LicenceModel, Plan, PlanDecision, Platform, TargetDesign, TierPattern } from '../types.ts';
import { appConnectors, type AppConnector } from './connectors.ts';
import { appDatabases, appPlanOf, appWorkloads, findApp, withoutServiceSynthetics } from './components.ts';
import { DEPLOY_HOW } from './deploy-paths.ts';
import { designAnswers, landingZoneBuilder, previewDesign } from './design.ts';
import { placedSlice } from './generate.ts';
import { decideApps } from './recommend.ts';
import { mapRow, wantsF5, type WizardCard } from './wizard-map.ts';

export interface BuiltItem {
  readonly card: WizardCard;
  /** What it is, in the provider's words. */
  readonly service: string;
  /** The Terraform resource types (or the Ansible role / module). */
  readonly builds: readonly string[];
  /** The blueprint or role that builds it. */
  readonly by: string;
  readonly generated: boolean;
  readonly reason?: string;
  /** The servers / databases / sizes it covers. */
  readonly detail?: string;
}

export interface PathRow {
  readonly item: string;
  readonly kind: 'server' | 'database';
  readonly path?: string;
  readonly label: string;
  readonly why: string;
  readonly target?: string;
}

export interface LicenceRow { readonly kind: string; readonly model: string; readonly count: number; readonly note: string }

export interface DesignResult {
  readonly platform: Platform;
  readonly built: readonly BuiltItem[];
  readonly paths: readonly PathRow[];
  readonly licences: readonly LicenceRow[];
  readonly connectors: readonly AppConnector[];
  readonly landingZone: { readonly mode: 'included' | 'shared'; readonly text: string };
  readonly deploy: string;
  readonly compute: readonly { readonly name: string; readonly size: string; readonly vcpu: number; readonly ramGib: number; readonly disks: string; readonly method: string }[];
  readonly databases: readonly { readonly name: string; readonly service: string; readonly shape: string; readonly ha: string; readonly storageGib: number }[];
  readonly findings: readonly Finding[];
  readonly slice: Plan;
  readonly decision: PlanDecision;
  readonly design: TargetDesign;
}

/** The card a Terraform blueprint belongs to, by its id. */
export function cardOfBlueprint(id: string, values: Readonly<Record<string, unknown>> = {}): WizardCard {
  const k = id.replace(/^[a-z]+_(mig|app)_/, '');
  if (/connector|connectivity/.test(k)) return 'connectivity';
  if (/landing_zone|identity|ingress/.test(k)) return 'security';
  if (k === 'appliance') return String(values.vendor ?? '') === 'f5' || String(values.vendor ?? '') === '' ? 'security' : 'compute';
  if (/databases|oracle_at|nosql|managed_cache|managed_search|file_service|file_transfer|object/.test(k)) return 'data';
  if (/messaging|kafka|api_gateway|workflow/.test(k)) return 'integration';
  if (/monitoring|governance|backup|context/.test(k)) return 'ops';
  if (/relocate|replication/.test(k)) return 'migration';
  return 'compute';
}

/** The card an Ansible play belongs to. */
function cardOfPlay(id: string): WizardCard {
  if (/oracle|mssql|postgres|mysql/.test(id)) return 'data';
  if (/join|ad_dc/.test(id)) return 'security';
  if (/iis|nginx/.test(id)) return 'compute';
  if (/tools|source/.test(id)) return 'migration';
  return 'ops';
}

const TIER_CARD: Readonly<Record<string, WizardCard>> = { compute: 'compute', data: 'data', integration: 'integration' };

/**
 * The design's result on `platform`: everything the stack builds for the app,
 * what is named but not generated, the paths, licences, connectors and how
 * the cloud takes it. Pure (the plan is not changed).
 */
export function designResult(plan: Plan, appId: string, platform: Platform, options: { readonly lookup?: BlueprintLookup; readonly ansibleLookup?: BlueprintLookup; readonly today?: string } = {}): DesignResult {
  const app = findApp(plan, appId);
  const empty: DesignResult = {
    platform, built: [], paths: [], licences: [], connectors: [], landingZone: { mode: 'included', text: '' }, deploy: DEPLOY_HOW[platform],
    compute: [], databases: [], findings: [], slice: plan, decision: { engineVersion: '', platforms: [], subsetScores: [], items: {}, findings: [] }, design: { platforms: [], findings: [] },
  };
  if (!app) return empty;
  const answers = designAnswers(plan, app.id).answers;
  const designed = previewDesign(plan, app.id, platform);
  const slice = placedSlice(designed, [app.id]);
  const engine = options.today ? { today: options.today } : {};
  const decision = decideApps(slice, engine);
  const design = withoutServiceSynthetics(slice, designPlan(slice, decision, withPatternMappers()));
  const lookup = withPlanBlueprints(options.lookup ?? findTerraformBlueprint);
  const ap = appPlanOf(slice, app.id);
  const lzMode: 'included' | 'shared' = slice.execution?.landingZones?.[platform] ? 'shared' : ap?.landingZone === 'shared' ? 'shared' : 'included';
  const stacks = planToStacks(slice, decision, design, { scope: 'apps', apps: [app.id], landingZone: lzMode, lookup });
  const site = planToSite(slice, decision, design, { apps: [app.id], lookup: options.ansibleLookup ?? findAnsibleBlueprint });
  const built: BuiltItem[] = [];
  const pd = design.platforms.find((d) => d.platform === platform);
  const ws = appWorkloads(slice, app).filter((w) => !w.synthetic);
  const byWid = new Map(slice.workloads.map((w) => [w.id, w]));
  const byDid = new Map(slice.databases.map((d) => [d.id, d]));

  // Terraform items.
  const stack = stacks.perPlatform[platform];
  const added = new Map((pd?.added ?? []).map((w) => [w.id, w.name]));
  const nameOfW = (id: string): string => byWid.get(id)?.name ?? added.get(id) ?? id;
  for (const it of stack?.items ?? []) {
    // The connectors (and the data-centre link) are listed from the connector catalogue below, with both ends named.
    if (/_app_connector$|_mig_connectivity$/.test(it.blueprintId)) continue;
    const bp = lookup(it.blueprintId);
    const card = cardOfBlueprint(it.blueprintId, it.values);
    let detail: string | undefined;
    if (/_mig_compute$|_mig_vms$/.test(it.blueprintId)) detail = (pd?.compute ?? []).map((c) => `${nameOfW(c.workload)}: ${c.size}`).join(', ');
    if (/_mig_databases$|_mig_oracle_at$/.test(it.blueprintId)) detail = (pd?.databases ?? []).map((d) => `${byDid.get(d.database)?.name ?? d.database}: ${DB_SERVICES[d.service]?.label ?? d.service} ${d.classOrShape}`).join(', ');
    built.push({ card, service: it.label, builds: [...(bp?.emits ?? [])], by: `Terraform: ${it.blueprintId}`, generated: true, ...(detail ? { detail } : {}) });
  }
  for (const m of stack?.manual ?? []) built.push({ card: 'migration', service: m, builds: [], by: 'Runbook', generated: false, reason: 'Not a Terraform resource: a step in the runbook.' });
  // Ansible plays on the app's hosts.
  for (const it of site.items) built.push({ card: cardOfPlay(it.blueprintId), service: it.label, builds: [it.blueprintId], by: `Ansible: ${it.blueprintId}`, generated: true, detail: String(it.values.hosts ?? '') });

  // Named by the wizard, not generated.
  const findings: Finding[] = [...decision.findings, ...design.findings, ...stacks.findings, ...site.findings];
  for (const f of stacks.findings) {
    if (f.code === 'plan.tf.pattern-not-generated') built.push({ card: 'compute', service: f.message.replace(/^[^:]+: /, ''), builds: [], by: 'Terraform', generated: false, reason: 'No Terraform blueprint for this tier pattern yet: the service is in the design and the runbook, not in the stack.' });
  }
  for (const card of ['compute', 'data', 'integration'] as const) {
    const row = mapRow(card, answers, platform);
    if (!row || row.tierPattern === 'engine') continue;
    const t = tierTarget(row.tierPattern as TierPattern, platform);
    if (isNone(t)) built.push({ card: TIER_CARD[card]!, service: `${labelOf(TIER_PATTERN_OPTIONS, row.tierPattern)} (${row.when})`, builds: [], by: '—', generated: false, reason: t.none });
    else if (t.noTerraform) built.push({ card: TIER_CARD[card]!, service: t.service, builds: [], by: 'Runbook', generated: false, reason: t.noTerraform });
  }
  if (wantsF5(answers) && platform !== 'vmware') {
    if (!built.some((b) => /appliance/.test(b.by))) built.push({ card: 'security', service: 'F5 BIG-IP (WAAP / ADC)', builds: [], by: '—', generated: false, reason: 'The F5 appliance component could not be placed; see the Components list.' });
  }
  if (ap?.ingress?.waf || ['cloud-fw-only', 'cloud-plus-f5'].includes(String(answers.perimeterPattern ?? ''))) {
    if (!built.some((b) => /_app_ingress/.test(b.by))) {
      built.push({ card: 'security', service: `The ${PLATFORM_LABELS[platform]} load balancer with a WAF in front of the web tier`, builds: [], by: `${platform === 'vmware' ? 'vsphere' : platform}_app_ingress`, generated: false, reason: 'The ingress item is added from the source VIPs (the network translation on Sources) or a new service\'s template; add it on Components (Advanced) with its members and DNS names.' });
    }
  }
  const multiRegion = ['2', '2-active', '3plus'].includes(String(answers.regionCount ?? ''));
  if (multiRegion && !slice.requirements.regions[platform]?.dr) {
    built.push({ card: 'ops', service: 'A DR region stack', builds: [], by: 'terraform/<p>-dr', generated: false, reason: `Two regions are asked for but no DR region is set for ${PLATFORM_LABELS[platform]} on Constraints: set it and the DR stack is generated.` });
  }
  const connectors = appConnectors(designed, app.id, platform, answers);
  for (const c of connectors) {
    const side = c.option.sides.find((s) => s.end === platform) ?? c.option.sides[1];
    built.push({
      card: 'connectivity',
      service: `${c.option.name}${c.peer ? ` to ${c.peer}` : ' to the data centre'}`,
      builds: side?.terraform ?? [],
      by: c.build.by ?? '—',
      generated: c.build.generated && (c.purpose === 'dependency' || lzMode === 'included'),
      ...(c.build.generated && c.purpose === 'data-centre' && lzMode === 'shared' ? { reason: 'Built by the stack that builds the landing zone (this app reuses it).' } : c.build.reason ? { reason: c.build.reason } : {}),
    });
  }

  // Paths.
  const paths: PathRow[] = [];
  const isNew = ap?.origin === 'new';
  for (const w of isNew ? [] : ws) {
    const r = resolveMovePath(w, slice, decision);
    paths.push({ item: w.name, kind: 'server', ...(r.path ? { path: r.path } : {}), label: r.path ? pathLabel(r.path) : 'Not moved', why: r.why, ...(r.target ? { target: String(r.target) } : {}) });
  }
  for (const d of isNew ? [] : appDatabases(slice, app)) {
    const r = resolveDbPath(d, slice, decision);
    paths.push({ item: d.name, kind: 'database', ...(r.path ? { path: r.path } : {}), label: r.path ? pathLabel(r.path) : 'Not moved', why: r.why, ...(r.service ? { target: DB_SERVICES[r.service]?.label ?? r.service } : {}) });
  }

  // Licences.
  const lic = new Map<string, LicenceRow>();
  for (const id of [...ws.map((w) => w.id), ...appDatabases(slice, app).map((d) => d.id)]) {
    const l = decision.items[id]?.chosen?.licence;
    if (!l || l.kind === 'none' || l.count === 0) continue;
    const key = `${l.kind}|${l.model}`;
    const cur = lic.get(key);
    lic.set(key, { kind: labelOf(LICENCE_KIND_OPTIONS, l.kind as LicenceKind), model: labelOf(LICENCE_MODEL_OPTIONS, l.model as LicenceModel), count: (cur?.count ?? 0) + l.count, note: cur?.note ?? l.note });
  }

  // Landing zone.
  const builder = landingZoneBuilder(designed, platform);
  const lzText = platform === 'vmware'
    ? 'VCF: the management and workload domains are there already; the stack builds into the workload domain.'
    : builder?.kind === 'project'
      ? `Reused: the ${PLATFORM_LABELS[platform]} landing zone is designed on Migration & Utilities (the landing-zone project); this stack reads it.`
      : builder?.kind === 'app' && builder.app.id !== app.id
        ? `Reused: ${builder.app.name} is the first application on ${PLATFORM_LABELS[platform]} and builds its landing zone and connectivity; this stack reads it (shared).`
        : `Built here: ${app.name} is the first application on ${PLATFORM_LABELS[platform]}, so its stack builds the landing zone and its connectivity; later applications on ${PLATFORM_LABELS[platform]} reuse it.`;

  return {
    platform, built, paths, licences: [...lic.values()], connectors,
    landingZone: { mode: lzMode, text: lzText },
    deploy: DEPLOY_HOW[platform],
    compute: (pd?.compute ?? []).map((c) => ({ name: nameOfW(c.workload), size: c.size, vcpu: c.vcpu, ramGib: c.ramGib, disks: c.disks.map((d) => `${d.gib} GiB ${d.type}`).join(', '), method: c.method ?? '' })),
    databases: (pd?.databases ?? []).map((d) => ({ name: byDid.get(d.database)?.name ?? d.database, service: DB_SERVICES[d.service]?.label ?? d.service, shape: d.classOrShape, ha: d.ha, storageGib: d.storageGib })),
    findings, slice, decision, design,
  };
}

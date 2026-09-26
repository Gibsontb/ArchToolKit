/**
 * The two migration pages' panes, and which of them a plan shows.
 *
 * Application Migration (`migration.html`) plans every application; Multi-Cloud
 * Migration & Utilities (`multicloud.html`) moves the estate and makes day-2
 * changes. Both read one `Plan`, and the plan's mode (data-centre exit,
 * migrate, one service, new services only) decides which panes matter.
 *
 * Visibility is computed, never stored (addendum A.1.7): a pane shows when the
 * mode needs it OR the plan already has data for it, so a `new` plan that later
 * gains a migrating app shows the migration panes, and changing the mode never
 * hides work that exists. The step bars list only the visible panes.
 *
 * Everything here is pure (no DOM, no storage), so the rules are tested on
 * fixtures and both shells share them.
 */

import type { AppOrigin, ItemState, Plan, PlanMode } from '../multicloud/plan/types.ts';

export type PageId = 'application-migration' | 'migration-utilities';

export type ApplicationMigrationPaneId =
  | 'sources' | 'servers' | 'databases' | 'applications' | 'app' | 'constraints' | 'sizing' | 'stack';
export type MigrationUtilitiesPaneId =
  | 'overview' | 'landing-zones' | 'capacity' | 'datacentre' | 'waves' | 'execute'
  | 'board' | 'timeline' | 'raid' | 'reports' | 'generate' | 'utilities';
export type PaneId = ApplicationMigrationPaneId | MigrationUtilitiesPaneId;

export interface PaneInfo {
  readonly id: PaneId;
  readonly label: string;
  /** Step-bar group (Migration & Utilities has two: Migrate and Utilities). */
  readonly group?: string;
  /** Numbered in the step bar. Unnumbered panes still have a tab. */
  readonly step: boolean;
  /** Never listed in the step bar; its tab appears only while it is open (the app workspace). */
  readonly routeOnly?: boolean;
  /** Old anchors that also open this pane. */
  readonly alsoMatches?: readonly string[];
}

/** The retired migration page's tabs; old bookmarks open the catalogue (A.1.5). */
export const LEGACY_MIGRATION_HASHES = Object.freeze(['intake', 'ratings', 'results', 'portfolio', 'help'] as const);

/** Application Migration's panes, in step-bar order (A.1.2). */
export const APPLICATION_MIGRATION_PANES: readonly PaneInfo[] = Object.freeze([
  { id: 'sources', label: 'Sources', step: true },
  // `#workloads` is the base design's name for this screen.
  { id: 'servers', label: 'Servers', step: true, alsoMatches: ['workloads'] },
  { id: 'databases', label: 'Databases', step: true },
  { id: 'applications', label: 'Applications', step: true, alsoMatches: [...LEGACY_MIGRATION_HASHES, 'apps'] },
  { id: 'app', label: 'Application', step: false, routeOnly: true },
  { id: 'constraints', label: 'Constraints', step: true, alsoMatches: ['requirements'] },
  { id: 'sizing', label: 'Sizing', step: false },
  { id: 'stack', label: 'Stack', step: true },
]);

/** Migration & Utilities' panes, in step-bar order (A.1.3), in the two areas. */
export const MIGRATION_UTILITIES_PANES: readonly PaneInfo[] = Object.freeze([
  { id: 'overview', label: 'Overview', group: 'Migrate', step: true },
  { id: 'landing-zones', label: 'Landing zones', group: 'Migrate', step: true },
  { id: 'capacity', label: 'Estate capacity', group: 'Migrate', step: true },
  { id: 'datacentre', label: 'Data centre', group: 'Migrate', step: true },
  { id: 'waves', label: 'Waves', group: 'Migrate', step: true },
  { id: 'execute', label: 'Execute', group: 'Migrate', step: true },
  { id: 'board', label: 'Board', group: 'Migrate', step: true },
  { id: 'timeline', label: 'Timeline', group: 'Migrate', step: true },
  { id: 'raid', label: 'RAID', group: 'Migrate', step: true },
  { id: 'reports', label: 'Reports', group: 'Migrate', step: true },
  { id: 'generate', label: 'Generate', group: 'Migrate', step: true },
  // `#changes` was the addendum's name for the Utilities area.
  { id: 'utilities', label: 'Utilities', group: 'Utilities', step: false, alsoMatches: ['changes'] },
]);

export function panesOf(page: PageId): readonly PaneInfo[] {
  return page === 'application-migration' ? APPLICATION_MIGRATION_PANES : MIGRATION_UTILITIES_PANES;
}

// ---------------------------------------------------------------------------
// What the plan has
// ---------------------------------------------------------------------------

/** The counts visibility and landing depend on; built from a plan (and the tracker) by `planFacts`. */
export interface PlanFacts {
  readonly mode: PlanMode;
  readonly workloads: number;
  readonly databases: number;
  readonly apps: number;
  /** Apps that migrate: every app whose plan is not `origin: 'new'`. */
  readonly migratingApps: number;
  readonly newApps: number;
  /** The one app's slug, when the plan has exactly one app. */
  readonly onlyAppSlug?: string;
  /** The plan has data-centre exit data (an exit date, or any non-server row). */
  readonly dcExitData: boolean;
  /** Tracked items (not removed). */
  readonly trackerItems: number;
  /** Tracked items past `planned`. */
  readonly trackerPastPlanned: number;
}

/** What `planFacts` reads of a tracker: its items' states. */
export interface TrackerLike {
  readonly items: Readonly<Record<string, { readonly state: ItemState; readonly removed?: boolean }>>;
}

/** The slug in `#app:<slug>`: an app id is `a:<slug>`. */
export function appSlug(appId: string): string {
  const bare = appId.startsWith('a:') ? appId.slice(2) : appId;
  return bare.trim().toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^-+|-+$/g, '');
}

export function planFacts(plan: Plan, tracker?: TrackerLike | null): PlanFacts {
  const origin = new Map<string, AppOrigin>();
  for (const p of plan.appPlans ?? []) origin.set(p.app, p.origin);
  // An app plan can exist before its App row (a new service added on the catalogue).
  const appIds = new Set<string>([...plan.apps.map((a) => a.id), ...origin.keys()]);
  let newApps = 0;
  for (const id of appIds) if (origin.get(id) === 'new') newApps += 1;
  const dc = plan.dcExit;
  const items = Object.values(tracker?.items ?? {}).filter((i) => i && !i.removed);
  const only = appIds.size === 1 ? [...appIds][0] : undefined;
  return {
    mode: plan.mode ?? 'migrate',
    // A new service's sized placeholders are not servers anyone moves.
    workloads: plan.workloads.filter((w) => !w.synthetic).length,
    databases: plan.databases.length,
    apps: appIds.size,
    migratingApps: appIds.size - newApps,
    newApps,
    ...(only ? { onlyAppSlug: appSlug(only) } : {}),
    dcExitData: Boolean(
      dc && (Boolean(dc.exitDate) || dc.infra.length > 0 || dc.external.length > 0 || dc.contracts.length > 0 || dc.assets.length > 0),
    ),
    trackerItems: items.length,
    trackerPastPlanned: items.filter((i) => i.state !== 'planned').length,
  };
}

/** Anything that moves: servers, databases, or an app that is not new. */
export function hasMigratingWork(f: PlanFacts): boolean {
  return f.workloads > 0 || f.databases > 0 || f.migratingApps > 0;
}

// ---------------------------------------------------------------------------
// Visibility (A.1.7)
// ---------------------------------------------------------------------------

/**
 * Whether a pane belongs in the step bar for these facts. `routeOnly` panes
 * (the app workspace) are never listed; the shell shows their tab while open.
 *
 * - `dc-exit`: everything, including Data centre.
 * - `migrate` (default): everything but Data centre (unless it has data).
 * - `single`: one wave and the service checklist; the programme views
 *   (Estate capacity, Timeline) go unless the plan has more than one app.
 * - `new`: Application Migration hides Sources, Servers and Databases;
 *   Migration & Utilities hides Waves, Execute and the Board. Each comes back
 *   as soon as the plan has something that migrates (or the board has items).
 */
export function isPaneVisible(page: PageId, id: PaneId, f: PlanFacts): boolean {
  const migrating = hasMigratingWork(f);
  if (page === 'application-migration') {
    switch (id as ApplicationMigrationPaneId) {
      case 'sources':
        return f.mode !== 'new' || migrating;
      case 'servers':
        return f.mode !== 'new' || f.workloads > 0;
      case 'databases':
        return f.mode !== 'new' || f.databases > 0;
      case 'app':
        return false;
      case 'applications':
      case 'constraints':
      case 'sizing':
      case 'stack':
        return true;
      default:
        return false;
    }
  }
  switch (id as MigrationUtilitiesPaneId) {
    case 'datacentre':
      return f.mode === 'dc-exit' || f.dcExitData;
    case 'capacity':
    case 'timeline':
      return f.mode !== 'single' || f.apps > 1;
    case 'waves':
    case 'execute':
      return f.mode !== 'new' || migrating;
    case 'board':
      return f.mode !== 'new' || migrating || f.trackerItems > 0;
    case 'overview':
    case 'landing-zones':
    case 'raid':
    case 'reports':
    case 'generate':
    case 'utilities':
      return true;
    default:
      return false;
  }
}

export function visiblePanes(page: PageId, f: PlanFacts): readonly PaneId[] {
  return panesOf(page)
    .filter((p) => isPaneVisible(page, p.id, f))
    .map((p) => p.id);
}

/**
 * The hash (without `#`) a page opens on when the URL has none.
 *
 * - Application Migration: the one app's workspace in `single` mode; else
 *   Applications when the plan has apps, else Sources (or Applications, when
 *   Sources is hidden in `new` mode, where it starts with New application).
 * - Migration & Utilities: the Board when a tracker has any item past
 *   `planned`, else Overview.
 */
export function landingHash(page: PageId, f: PlanFacts): string {
  if (page === 'application-migration') {
    if (f.mode === 'single' && f.onlyAppSlug) return `app:${f.onlyAppSlug}`;
    if (f.apps > 0) return 'applications';
    return isPaneVisible(page, 'sources', f) ? 'sources' : 'applications';
  }
  if (f.trackerPastPlanned > 0 && isPaneVisible(page, 'board', f)) return 'board';
  return 'overview';
}

// ---------------------------------------------------------------------------
// Old URLs (A.1.5)
// ---------------------------------------------------------------------------

/**
 * The old Multi-Cloud planner's intake and decision anchors, which now live on
 * Application Migration. `#waves` and `#generate` stay on `multicloud.html`.
 */
export const LEGACY_MULTICLOUD_TO_MIGRATION: Readonly<Record<string, ApplicationMigrationPaneId>> = Object.freeze({
  sources: 'sources',
  workloads: 'servers',
  databases: 'databases',
  apps: 'applications',
  requirements: 'constraints',
  decision: 'applications',
  design: 'applications',
});

/**
 * Where an old address must go instead, or null to stay. Only
 * `multicloud.html` sends a hash away (to `migration.html`); the retired
 * migration page's own anchors are `alsoMatches` on Applications, so they
 * stay on the page.
 */
export function legacyRedirect(page: PageId, hash: string): string | null {
  if (page !== 'migration-utilities') return null;
  const wanted = hash.replace(/^#/, '').split(':')[0] ?? '';
  const to = Object.prototype.hasOwnProperty.call(LEGACY_MULTICLOUD_TO_MIGRATION, wanted) ? LEGACY_MULTICLOUD_TO_MIGRATION[wanted] : undefined;
  return to ? `migration.html#${to}` : null;
}

/** The pane a hash opens (before the colon), matching `alsoMatches`; undefined when none. */
export function paneForHash(page: PageId, hash: string): PaneInfo | undefined {
  const wanted = hash.replace(/^#/, '').split(':')[0] ?? '';
  if (!wanted) return undefined;
  return panesOf(page).find((p) => p.id === wanted || (p.alsoMatches ?? []).includes(wanted));
}

/** The argument after the colon: `#app:billing/target` → `billing/target`. */
export function hashArgument(hash: string): string {
  const bare = hash.replace(/^#/, '');
  const at = bare.indexOf(':');
  return at < 0 ? '' : bare.slice(at + 1);
}

// ---------------------------------------------------------------------------
// The application workspace's tabs (A.2.2, A.1.7)
// ---------------------------------------------------------------------------

export type WorkspaceTabId =
  | 'overview' | 'components' | 'configuration' | 'dependencies' | 'coupling'
  | 'assessment' | 'target' | 'sizing' | 'compare' | 'generate';

export const WORKSPACE_TABS: readonly { readonly id: WorkspaceTabId; readonly label: string }[] = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'components', label: 'Components' },
  { id: 'configuration', label: 'Configuration' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'coupling', label: 'Coupling' },
  { id: 'assessment', label: 'Assessment' },
  { id: 'target', label: 'Target' },
  { id: 'sizing', label: 'Sizing' },
  { id: 'compare', label: 'Compare' },
  { id: 'generate', label: 'Generate' },
]);

/**
 * The workspace tabs for one app. A new (greenfield) app has nothing to
 * couple or assess, so Coupling and Assessment go; in `new` mode an app with
 * no plan yet counts as new.
 */
export function workspaceTabs(mode: PlanMode, origin: AppOrigin | undefined): readonly WorkspaceTabId[] {
  const isNew = origin === 'new' || (origin === undefined && mode === 'new');
  return WORKSPACE_TABS.map((t) => t.id).filter((id) => !(isNew && (id === 'coupling' || id === 'assessment')));
}

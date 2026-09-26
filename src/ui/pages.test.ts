/**
 * The two migration pages' shells (WP-14): old addresses, computed pane
 * visibility per plan mode, landing rules, the plan sync and its conflict
 * banner, the old portfolio, and the retirement of the old pages.
 */

import { describe, it } from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '../testing/expect.ts';
import {
  APPLICATION_MIGRATION_PANES, LEGACY_MIGRATION_HASHES, LEGACY_MULTICLOUD_TO_MIGRATION, MIGRATION_UTILITIES_PANES,
  appSlug, hashArgument, isPaneVisible, landingHash, legacyRedirect, paneForHash, planFacts, visiblePanes, workspaceTabs,
  type PaneId, type PlanFacts,
} from './page-modes.ts';
import { onOtherSave, openPlanSession, type PlanStoreApi } from './plan-sync.ts';
import { planWithPortfolio, portfolioFromFile } from './legacy-portfolio.ts';
import { APPLICATION_MIGRATION_SPECS } from './application-migration-page.ts';
import { MIGRATION_UTILITIES_SPECS } from './migration-utilities-page.ts';
import { migrationLabel, migrationOf } from './inventory-page.ts';
import { emptyPlan } from '../multicloud/plan/store.ts';
import type { App, AppPlan, Database, Plan, PlanMode, Workload } from '../multicloud/plan/types.ts';
import { STORES } from '../kit/idb.ts';
import { entryFor, exportJson } from '../migration/portfolio.ts';
import { EMPTY_APPLICATION } from '../migration/types.ts';
import { scopedKey } from '../vmware/inventory.ts';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..', 'web', 'app');

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const app = (name: string): App => ({ id: `a:${name}`, name } as unknown as App);
const workload = (name: string): Workload => ({ id: `w:${name}`, name, app: 'billing' } as unknown as Workload);
const database = (name: string): Database => ({ id: `d:${name}`, name, app: 'billing' } as unknown as Database);
const appPlan = (id: string, origin: 'migrate' | 'new'): AppPlan => ({ app: id, origin } as unknown as AppPlan);

function fixture(mode: PlanMode, parts: { apps?: string[]; newApps?: string[]; workloads?: number; databases?: number; dc?: boolean } = {}): Plan {
  const base = emptyPlan('Fixture', '2026-01-01T00:00:00.000Z');
  const apps = [...(parts.apps ?? []), ...(parts.newApps ?? [])].map(app);
  return {
    ...base,
    mode,
    apps,
    appPlans: (parts.newApps ?? []).map((n) => appPlan(`a:${n}`, 'new')),
    workloads: Array.from({ length: parts.workloads ?? 0 }, (_, i) => workload(`vm${i}`)),
    databases: Array.from({ length: parts.databases ?? 0 }, (_, i) => database(`db${i}`)),
    ...(parts.dc ? { dcExit: { dualRunningDays: 0, hardwareRemovalDays: 0, infra: [], external: [], contracts: [], assets: [], exitDate: '2027-06-30' } } : {}),
  };
}

const amVisible = (f: PlanFacts) => visiblePanes('application-migration', f);
const muVisible = (f: PlanFacts) => visiblePanes('migration-utilities', f);

// ---------------------------------------------------------------------------

describe('old addresses (A.1.5)', () => {
  it('sends the retired planner anchors from multicloud.html to Application Migration', () => {
    expect(legacyRedirect('migration-utilities', '#sources')).toBe('migration.html#sources');
    expect(legacyRedirect('migration-utilities', '#workloads')).toBe('migration.html#servers');
    expect(legacyRedirect('migration-utilities', '#databases')).toBe('migration.html#databases');
    expect(legacyRedirect('migration-utilities', '#apps')).toBe('migration.html#applications');
    expect(legacyRedirect('migration-utilities', '#requirements')).toBe('migration.html#constraints');
    expect(legacyRedirect('migration-utilities', '#decision')).toBe('migration.html#applications');
    expect(legacyRedirect('migration-utilities', '#design')).toBe('migration.html#applications');
    expect(Object.keys(LEGACY_MULTICLOUD_TO_MIGRATION).sort()).toEqual(['apps', 'databases', 'decision', 'design', 'requirements', 'sources', 'workloads']);
  });

  it('keeps #waves and #generate on multicloud.html, and every current pane', () => {
    for (const hash of ['#waves', '#generate', '#waves:governance', '#overview', '#board', '#utilities:add-disk', '', '#']) {
      expect(legacyRedirect('migration-utilities', hash)).toBeNull();
    }
    expect(paneForHash('migration-utilities', '#waves')?.id).toBe('waves');
    expect(paneForHash('migration-utilities', '#generate')?.id).toBe('generate');
  });

  it('opens the catalogue for the retired migration page anchors, without leaving the page', () => {
    for (const hash of LEGACY_MIGRATION_HASHES) {
      expect(paneForHash('application-migration', `#${hash}`)?.id).toBe('applications');
      expect(legacyRedirect('application-migration', `#${hash}`)).toBeNull();
    }
  });

  it('opens the redirected anchors on Application Migration', () => {
    for (const to of Object.values(LEGACY_MULTICLOUD_TO_MIGRATION)) {
      expect(paneForHash('application-migration', `#${to}`)?.id).toBe(to);
    }
    expect(paneForHash('application-migration', '#workloads')?.id).toBe('servers');
    expect(paneForHash('application-migration', '#requirements')?.id).toBe('constraints');
  });

  it("reads the addendum's #changes as Utilities", () => {
    expect(paneForHash('migration-utilities', '#changes')?.id).toBe('utilities');
    expect(paneForHash('migration-utilities', '#changes:add-disk')?.id).toBe('utilities');
  });

  it('points the portfolio redirect at Sources', () => {
    const html = readFileSync(join(web, 'migration-portfolio.html'), 'utf8');
    expect(html.includes("location.replace('migration.html#sources')")).toBe(true);
    expect(html.includes('url=migration.html#sources')).toBe(true);
    expect(html.includes('#portfolio')).toBe(false);
  });
});

describe('hashes and arguments', () => {
  it('splits the pane from its argument', () => {
    expect(paneForHash('application-migration', '#app:billing/target')?.id).toBe('app');
    expect(hashArgument('#app:billing/target')).toBe('billing/target');
    expect(hashArgument('#execute:3/cutover')).toBe('3/cutover');
    expect(hashArgument('#board')).toBe('');
    expect(paneForHash('application-migration', '#nothing-here')).toBeUndefined();
  });

  it('makes the app slug from the app id', () => {
    expect(appSlug('a:billing-api')).toBe('billing-api');
    expect(appSlug('Billing API')).toBe('billing-api');
  });
});

describe('pane visibility follows the mode and the data (A.1.7)', () => {
  const allAm = APPLICATION_MIGRATION_PANES.filter((p) => !p.routeOnly).map((p) => p.id);
  const allMu = MIGRATION_UTILITIES_PANES.map((p) => p.id);

  it('dc-exit shows everything, including Data centre', () => {
    const f = planFacts(fixture('dc-exit', { apps: ['billing'], workloads: 3 }));
    expect(amVisible(f)).toEqual(allAm);
    expect(muVisible(f)).toEqual(allMu);
  });

  it('migrate hides only Data centre', () => {
    const f = planFacts(fixture('migrate', { apps: ['billing'], workloads: 3 }));
    expect(amVisible(f)).toEqual(allAm);
    expect(muVisible(f)).toEqual(allMu.filter((id) => id !== 'datacentre'));
  });

  it('shows Data centre in any mode once the plan has exit data', () => {
    const f = planFacts(fixture('migrate', { apps: ['billing'], dc: true }));
    expect(isPaneVisible('migration-utilities', 'datacentre', f)).toBe(true);
  });

  it('single drops the programme views (capacity, timeline) for one app', () => {
    const f = planFacts(fixture('single', { apps: ['billing'], workloads: 2 }));
    expect(muVisible(f)).toEqual(allMu.filter((id) => !['datacentre', 'capacity', 'timeline'].includes(id)));
    expect(amVisible(f)).toEqual(allAm);
    // ...and brings them back when the plan outgrows one app.
    const g = planFacts(fixture('single', { apps: ['billing', 'crm'] }));
    expect(isPaneVisible('migration-utilities', 'capacity', g)).toBe(true);
  });

  it('new hides the migration panes on both pages', () => {
    const f = planFacts(fixture('new', { newApps: ['portal'] }));
    expect(amVisible(f)).toEqual(['applications', 'constraints', 'sizing', 'stack'] as PaneId[]);
    expect(muVisible(f)).toEqual(allMu.filter((id) => !['datacentre', 'waves', 'execute', 'board'].includes(id)));
  });

  it('a new plan that gains a migrating app shows the migration panes again', () => {
    const f = planFacts(fixture('new', { newApps: ['portal'], apps: ['billing'], workloads: 1 }));
    // Databases stays hidden: the plan still has none.
    expect(amVisible(f)).toEqual(allAm.filter((id) => id !== 'databases'));
    expect(muVisible(f)).toEqual(allMu.filter((id) => id !== 'datacentre'));
  });

  it('in new mode, shows Databases only when there are databases', () => {
    const f = planFacts(fixture('new', { newApps: ['portal'], databases: 1 }));
    expect(isPaneVisible('application-migration', 'databases', f)).toBe(true);
    expect(isPaneVisible('application-migration', 'servers', f)).toBe(false);
  });

  it('shows the board in new mode when the tracker has deployments', () => {
    const plan = fixture('new', { newApps: ['portal'] });
    const f = planFacts(plan, { items: { 'a:portal': { state: 'prepared' } } });
    expect(isPaneVisible('migration-utilities', 'board', f)).toBe(true);
  });

  it('never lists the app workspace in the step bar', () => {
    for (const mode of ['dc-exit', 'migrate', 'single', 'new'] as PlanMode[]) {
      expect(amVisible(planFacts(fixture(mode, { apps: ['x'] }))).includes('app')).toBe(false);
    }
  });

  it('changing the mode keeps the data', () => {
    const plan = fixture('migrate', { apps: ['billing'], workloads: 2 });
    const changed: Plan = { ...plan, mode: 'new' };
    expect(changed.workloads.length).toBe(2);
    expect(isPaneVisible('application-migration', 'servers', planFacts(changed))).toBe(true);
  });

  it('hides Coupling and Assessment for a new app', () => {
    expect(workspaceTabs('migrate', 'migrate')).toHaveLength(10);
    expect(workspaceTabs('migrate', 'new').includes('coupling')).toBe(false);
    expect(workspaceTabs('new', undefined).includes('assessment')).toBe(false);
    expect(workspaceTabs('new', 'migrate').includes('assessment')).toBe(true);
  });
});

describe('landing rules', () => {
  it('Application Migration opens the start card on an empty plan, Sources with servers and no apps, and Applications once there are apps', () => {
    expect(landingHash('application-migration', planFacts(fixture('migrate')))).toBe('app:');
    expect(landingHash('application-migration', planFacts(fixture('migrate', { workloads: 3 })))).toBe('sources');
    expect(landingHash('application-migration', planFacts(fixture('migrate', { apps: ['billing'] })))).toBe('applications');
  });

  it("opens the one app's workspace in single mode", () => {
    expect(landingHash('application-migration', planFacts(fixture('single', { apps: ['billing'] })))).toBe('app:billing');
  });

  it('opens the start card in new mode with nothing in the plan', () => {
    expect(landingHash('application-migration', planFacts(fixture('new')))).toBe('app:');
  });

  it('Migration & Utilities opens the board only once something is past planned', () => {
    const plan = fixture('migrate', { apps: ['billing'], workloads: 1 });
    expect(landingHash('migration-utilities', planFacts(plan))).toBe('overview');
    expect(landingHash('migration-utilities', planFacts(plan, { items: { 'w:vm0': { state: 'planned' } } }))).toBe('overview');
    expect(landingHash('migration-utilities', planFacts(plan, { items: { 'w:vm0': { state: 'replicating' } } }))).toBe('board');
    // A removed item does not count.
    expect(landingHash('migration-utilities', planFacts(plan, { items: { 'w:vm0': { state: 'replicating', removed: true } } }))).toBe('overview');
  });
});

// ---------------------------------------------------------------------------
// the plan sync
// ---------------------------------------------------------------------------

function fakeStore(initial: Plan | null, saveResult: 'saved' | 'conflict' | 'failed' = 'saved') {
  let stored: Plan | null = initial;
  let listener: ((m: { planId: string; savedAt: string }) => void) | undefined;
  const calls: { basedOn: string }[] = [];
  const api: PlanStoreApi = {
    load: async () => stored,
    saveIfUnchanged: async (plan, basedOn) => {
      calls.push({ basedOn });
      if (saveResult === 'saved') stored = plan;
      return saveResult;
    },
    saveAnyway: async (plan) => {
      stored = plan;
      return true;
    },
    onSaved: (l) => {
      listener = l;
      return () => undefined;
    },
  };
  return {
    api,
    calls,
    setStored: (p: Plan) => (stored = p),
    stored: () => stored,
    announce: (m: { planId: string; savedAt: string }) => listener?.(m),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
let clock = 0;
const now = () => `2026-02-01T00:00:${String(++clock % 60).padStart(2, '0')}.000Z`;

describe('plan sync across pages (A.1.1)', () => {
  it('reloads silently when another page saves and nothing here is unsaved; asks when something is', () => {
    expect(onOtherSave({ basedOn: 'a', dirty: false }, { planId: 'p', savedAt: 'b' })).toBe('reload');
    expect(onOtherSave({ basedOn: 'a', dirty: true }, { planId: 'p', savedAt: 'b' })).toBe('ask');
    expect(onOtherSave({ basedOn: 'a', dirty: true }, { planId: 'p', savedAt: 'a' })).toBe('ignore');
    expect(onOtherSave({ basedOn: null, dirty: false }, { planId: 'p', savedAt: 'a' })).toBe('reload');
  });

  it('saves conditionally, based on the savedAt it loaded', async () => {
    const plan = fixture('migrate');
    const store = fakeStore(plan);
    const session = await openPlanSession(store.api, { debounceMs: 1, now });
    session.update((p) => ({ ...p, mode: 'dc-exit' }));
    expect(session.dirty()).toBe(true);
    expect(await session.save()).toBe('saved');
    expect(store.calls[0]?.basedOn).toBe(plan.savedAt);
    expect(session.dirty()).toBe(false);
    expect(store.stored()?.mode).toBe('dc-exit');
    session.dispose();
  });

  it('shows the banner when a save conflicts, and Keep mine overwrites', async () => {
    const store = fakeStore(fixture('migrate'), 'conflict');
    const session = await openPlanSession(store.api, { debounceMs: 1, now });
    const seen: (string | null)[] = [];
    session.onConflict((c) => seen.push(c?.reason ?? null));
    session.update((p) => ({ ...p, name: 'Mine' }));
    expect(await session.save()).toBe('conflict');
    expect(session.conflict()?.reason).toBe('save-conflict');
    expect(seen).toEqual(['save-conflict']);
    expect(await session.keepMine()).toBe(true);
    expect(session.conflict()).toBeNull();
    expect(store.stored()?.name).toBe('Mine');
    session.dispose();
  });

  it('asks (banner) when the other page saves over unsaved edits, and Reload takes theirs', async () => {
    const store = fakeStore(fixture('migrate'));
    const session = await openPlanSession(store.api, { debounceMs: 10_000, now });
    session.update((p) => ({ ...p, name: 'Unsaved here' }));
    const theirs: Plan = { ...fixture('dc-exit'), name: 'Theirs', savedAt: '2026-03-01T00:00:00.000Z' };
    store.setStored(theirs);
    store.announce({ planId: theirs.id, savedAt: theirs.savedAt });
    expect(session.conflict()?.reason).toBe('other-page');
    await session.reload();
    expect(session.conflict()).toBeNull();
    expect(session.plan().name).toBe('Theirs');
    expect(session.dirty()).toBe(false);
    session.dispose();
  });

  it('reloads silently when the other page saves and nothing is unsaved', async () => {
    const store = fakeStore(fixture('migrate'));
    const session = await openPlanSession(store.api, { debounceMs: 1, now });
    const kinds: string[] = [];
    session.subscribe((_p, kind) => kinds.push(kind));
    const theirs: Plan = { ...fixture('new'), savedAt: '2026-03-02T00:00:00.000Z' };
    store.setStored(theirs);
    store.announce({ planId: theirs.id, savedAt: theirs.savedAt });
    await tick();
    expect(session.conflict()).toBeNull();
    expect(session.plan().mode).toBe('new');
    expect(kinds).toEqual(['reload']);
    session.dispose();
  });

  it('starts an empty plan when nothing is stored, without saving it', async () => {
    const store = fakeStore(null);
    const session = await openPlanSession(store.api, { debounceMs: 1, now });
    expect(session.stored()).toBe(false);
    expect(session.plan().mode).toBe('migrate');
    expect(store.calls).toHaveLength(0);
    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// the old portfolio
// ---------------------------------------------------------------------------

describe('the old portfolio stays importable', () => {
  const entries = [
    entryFor({ ...EMPTY_APPLICATION, name: 'Billing' }),
    entryFor({ ...EMPTY_APPLICATION, name: 'CRM' }),
  ];

  it('merges the portfolio apps into the plan', () => {
    const { plan, added } = planWithPortfolio(fixture('migrate'), entries);
    expect(added).toBe(2);
    expect(plan.apps.map((a) => a.name).sort()).toEqual(['Billing', 'CRM']);
    // Again: merged by name, nothing doubled.
    expect(planWithPortfolio(plan, entries).plan.apps).toHaveLength(2);
  });

  it('reads the archtoolkit.migration-portfolio v1 file', () => {
    const read = portfolioFromFile(exportJson(entries), 'migration-portfolio.json');
    expect(read.entries.map((e) => e.application.name)).toEqual(['Billing', 'CRM']);
  });

  it('keeps the IndexedDB store, and nothing on these pages deletes it', () => {
    expect((STORES as readonly string[]).includes('portfolio')).toBe(true);
    const mine = ['page-modes.ts', 'plan-sync.ts', 'plan-shell.ts', 'pane-stub.ts', 'legacy-portfolio.ts', 'application-migration-page.ts', 'migration-utilities-page.ts', 'inventory-page.ts'];
    for (const file of mine) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(/clearPortfolio|deleteObjectStore|['"]portfolio['"][^\n]*delete/.test(text)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// the shells and the retirement
// ---------------------------------------------------------------------------

describe('the page shells', () => {
  it('has a pane module for every pane of both pages, each exporting mount', async () => {
    expect(APPLICATION_MIGRATION_SPECS.map((s) => s.id)).toEqual(APPLICATION_MIGRATION_PANES.map((p) => p.id));
    expect(MIGRATION_UTILITIES_SPECS.map((s) => s.id)).toEqual(MIGRATION_UTILITIES_PANES.map((p) => p.id));
    for (const spec of [...APPLICATION_MIGRATION_SPECS, ...MIGRATION_UTILITIES_SPECS]) {
      const mod = await spec.load();
      expect(typeof mod.mount).toBe('function');
      for (const load of Object.values(spec.sub ?? {})) expect(typeof (await load()).mount).toBe('function');
    }
  });

  it('retires the old page modules', () => {
    expect(existsSync(join(here, 'migration-page.ts'))).toBe(false);
    expect(existsSync(join(here, 'multicloud-page.ts'))).toBe(false);
    const stale = readdirSync(here).filter((f) => /^(migration|multicloud)-page\.ts$/.test(f));
    expect(stale).toEqual([]);
  });

  it('loads the new shells from the two pages, with the new navigation', () => {
    const am = readFileSync(join(web, 'migration.html'), 'utf8');
    const mu = readFileSync(join(web, 'multicloud.html'), 'utf8');
    expect(am.includes('../lib/ui/application-migration-page.js')).toBe(true);
    expect(mu.includes('../lib/ui/migration-utilities-page.js')).toBe(true);
    expect(am.includes('<title>Application Migration · ArchToolKit</title>')).toBe(true);
    expect(mu.includes('<title>Multi-Cloud Migration &amp; Utilities · ArchToolKit</title>')).toBe(true);
    for (const html of [am, mu]) {
      expect(html.includes('<a href="migration.html"') && html.includes('>Application Migration</a>')).toBe(true);
      expect(html.includes('>Migration &amp; Utilities</a>')).toBe(true);
      expect(html.includes('>Multi-Cloud</a>')).toBe(false);
      expect(html.includes('id="plan-header"')).toBe(true);
      expect(/ui\/(migration|multicloud)-page\.js/.test(html)).toBe(false);
    }
    expect(am.includes('<a href="migration.html" aria-current="page">')).toBe(true);
    expect(mu.includes('<a href="multicloud.html" aria-current="page">')).toBe(true);
  });

  it('gives the manual a section for each page', () => {
    const manual = readFileSync(join(web, 'manual.html'), 'utf8');
    expect(/<h2 id="application-migration">\d+\. Application Migration<\/h2>/.test(manual)).toBe(true);
    expect(/<h2 id="migration-and-utilities">\d+\. Multi-Cloud Migration &amp; Utilities<\/h2>/.test(manual)).toBe(true);
  });
});

describe('the Inventory page', () => {
  it('sends "Plan the applications" to Sources', () => {
    const text = readFileSync(join(here, 'inventory-page.ts'), 'utf8');
    expect(text.includes("text: 'Plan the applications', attrs: { href: 'migration.html#sources' }")).toBe(true);
    expect(text.includes('Decide where it goes')).toBe(false);
  });

  it('reads the Migration column by source key, then by lower-cased name', () => {
    const index = new Map([
      [scopedKey('VC01.corp', 'app01'), { state: 'replicating', wave: 2 }],
      ['db07', { state: 'cut-over', wave: 3 }],
    ]);
    expect(migrationOf(index, { vcenter: 'vc01.corp', name: 'app01' })).toEqual({ state: 'replicating', wave: 2 });
    expect(migrationOf(index, { vcenter: 'other', name: 'DB07' })).toEqual({ state: 'cut-over', wave: 3 });
    expect(migrationOf(index, { name: 'missing' })).toBeUndefined();
    expect(migrationLabel({ state: 'replicating', wave: 2 })).toBe('replicating · wave 2');
  });
});

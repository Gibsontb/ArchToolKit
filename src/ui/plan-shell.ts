/**
 * What the two migration pages share: the header (plan mode, the plan's file
 * bar, the link to the other page), the conflict banner, and the pane shell.
 *
 * The panes are `mountTabs` panes. Each is a module loaded with dynamic
 * `import()` the first time it opens, so a page loads only the code of the
 * panes someone looks at (the tracker panes stay light; the planner engine
 * is loaded by the panes that need it). Every pane module exports
 *
 *     export function mount(root: HTMLElement, ctx: PaneContext): void | Promise<void>
 *
 * and reads and writes the plan through `ctx.session`. A hash may carry an
 * argument after the colon (`#app:billing/target`, `#execute:3/cutover`,
 * `#utilities:add-disk`); the pane reads it with `ctx.arg()` and hears changes
 * through `ctx.onArg`. A pane can also name sub-views that are modules of their
 * own (`#waves:governance`), which the shell loads in place of the pane's body.
 *
 * The step bar is `mountTabs`'s strip, decorated: numbered steps, the area
 * labels (Migrate, Utilities), and only the panes the plan's mode and data
 * make visible (page-modes.ts). A hidden pane still opens from a link; its
 * tab shows while it is open.
 */

import { el, append, clear } from './dom.ts';
import { field, select } from './components.ts';
import { fileBar } from './file-bar.ts';
import { mountTabs } from './tab-shell.ts';
import type { Json } from '../editor/doc.ts';
import { PLAN_MODE_OPTIONS } from '../multicloud/plan/options.ts';
import { emptyPlan, planEnvelope, planFromEnvelope } from '../multicloud/plan/store.ts';
import type { PlanMode } from '../multicloud/plan/types.ts';
import {
  hashArgument, isPaneVisible, landingHash, legacyRedirect, paneForHash, panesOf, planFacts,
  type PageId, type PaneId, type PaneInfo, type PlanFacts, type TrackerLike,
} from './page-modes.ts';
import { mountConflictBanner, openPlanSession, type PlanSession } from './plan-sync.ts';

/** What a pane module is handed. */
export interface PaneContext {
  readonly page: PageId;
  readonly pane: PaneId;
  /** The shared plan: read with `session.plan()`, change with `session.update(...)`. */
  readonly session: PlanSession;
  /** The plan's counts and mode, as visibility sees them. */
  facts(): PlanFacts;
  /** The hash argument after the colon, '' when none. */
  arg(): string;
  /** Called when the argument changes while this pane is open. Returns the unsubscribe. */
  onArg(listener: (arg: string) => void): () => void;
  /** Open a hash (`'app:billing/target'`, `'board'`). */
  go(hash: string): void;
  /** Recompute which panes show (after something the plan does not carry changed, like the tracker). */
  refresh(): Promise<void>;
}

export interface PaneModule {
  mount(root: HTMLElement, ctx: PaneContext): void | Promise<void>;
}

export interface PaneSpec {
  readonly id: PaneId;
  readonly load: () => Promise<PaneModule>;
  /** Sub-views with modules of their own, keyed by the argument's first segment. */
  readonly sub?: Readonly<Record<string, () => Promise<PaneModule>>>;
}

export interface PlanPageOptions {
  readonly page: PageId;
  /** Where the header controls go (inside the page-header card). */
  readonly header: HTMLElement;
  /** Where the banner and the panes go. */
  readonly root: HTMLElement;
  readonly panes: readonly PaneSpec[];
  readonly otherPage: { readonly href: string; readonly label: string };
  /** The tracker, for the landing rule and the board's visibility. */
  readonly tracker?: () => Promise<TrackerLike | null>;
}

const MODE_HINT: Readonly<Record<PlanMode, string>> = {
  'dc-exit': 'Everything in the data centre goes, stays or is retired by a date. Adds the Data centre pane and the exit waves.',
  migrate: 'Move some applications.',
  single: 'Move one application or service: one wave, with the service checklist.',
  new: 'Add new services; nothing moves. Deploy a new service is the path.',
};

function currentHash(): string {
  return globalThis.location?.hash ?? '';
}

function setHash(hash: string): void {
  if (!globalThis.location) return;
  const url = new URL(globalThis.location.href);
  url.hash = hash;
  globalThis.history?.replaceState(null, '', url.toString());
}

/** Mount a migration page. Resolves once the panes are mounted (or a legacy address was sent on). */
export async function mountPlanPage(options: PlanPageOptions): Promise<PlanSession | null> {
  const { page } = options;

  // An old address of the retired planner goes to the page that has it now.
  const away = legacyRedirect(page, currentHash());
  if (away) {
    globalThis.location.replace(away);
    return null;
  }

  const session = await openPlanSession();
  let tracker: TrackerLike | null = options.tracker ? await options.tracker().catch(() => null) : null;
  let facts = planFacts(session.plan(), tracker);

  // No hash, or one that names nothing: the landing rule.
  if (!paneForHash(page, currentHash())) setHash(landingHash(page, facts));

  // ---- header ------------------------------------------------------------
  const modeSelect = select(PLAN_MODE_OPTIONS, facts.mode);
  modeSelect.setAttribute('data-control', 'plan-mode');
  const modeHint = el('div', { class: 'field-hint', text: MODE_HINT[facts.mode] });
  modeSelect.addEventListener('change', () => {
    const mode = modeSelect.value as PlanMode;
    session.update((p) => ({ ...p, mode }), { immediate: true });
  });
  const status = el('span', { class: 'small muted', attrs: { 'data-control': 'plan-status', role: 'status' } });
  const describe = () => {
    const p = session.plan();
    const state = session.dirty() ? 'unsaved changes' : session.stored() ? 'saved in this browser' : 'not saved yet';
    status.textContent = `${p.name} · ${facts.apps} app${facts.apps === 1 ? '' : 's'} · ${facts.workloads} server${facts.workloads === 1 ? '' : 's'} · ${state}`;
  };

  const modeField = field('Plan mode', modeSelect);
  append(modeField, modeHint);
  append(
    options.header,
    el(
      'div',
      { class: 'plan-bar', style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'flex-end', marginTop: 'var(--space-4)' } },
      el('div', { style: { minWidth: '14rem', flex: '0 1 22rem' } }, modeField),
      el('a', { class: 'btn', text: `${options.otherPage.label} →`, attrs: { href: options.otherPage.href, 'data-control': 'other-page' } }),
    ),
    el(
      'div',
      { style: { marginTop: 'var(--space-3)' } },
      fileBar({
        noun: 'the migration plan',
        fileName: () => {
          const name = session.plan().name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          return name || 'migration-plan';
        },
        save: () => planEnvelope(session.plan()) as unknown as Json,
        header: () => ['ArchToolKit migration plan (archtoolkit.multicloud-plan).', 'Credentials are never written to this file.'],
        load: (value) => {
          const read = planFromEnvelope(value);
          if ('error' in read) throw new Error(read.error);
          void session.replace(read.ok);
          return `Loaded "${read.ok.name}".`;
        },
        clear: () => void session.replace(emptyPlan()),
      }),
      status,
    ),
  );

  // ---- banner and panes ----------------------------------------------------
  const bannerSlot = el('div', { attrs: { 'data-control': 'plan-banner' } });
  const tabsRoot = el('div', { class: 'plan-panes' });
  clear(options.root);
  append(options.root, bannerSlot, tabsRoot);
  mountConflictBanner(bannerSlot, session);

  const argListeners = new Map<PaneId, Set<(arg: string) => void>>();
  const infoOf = new Map<PaneId, PaneInfo>(panesOf(page).map((p) => [p.id, p]));

  const refresh = async () => {
    if (options.tracker) tracker = await options.tracker().catch(() => tracker);
    facts = planFacts(session.plan(), tracker);
    decorate();
  };

  const contextFor = (pane: PaneId): PaneContext => ({
    page,
    pane,
    session,
    facts: () => facts,
    arg: () => (paneForHash(page, currentHash())?.id === pane ? hashArgument(currentHash()) : ''),
    onArg(listener) {
      const set = argListeners.get(pane) ?? new Set();
      set.add(listener);
      argListeners.set(pane, set);
      return () => set.delete(listener);
    },
    go(hash) {
      if (globalThis.location) globalThis.location.hash = hash.replace(/^#/, '');
    },
    refresh,
  });

  /** Mount a pane (and its sub-views) into its body: the modules load on first open. */
  const mountPane = (spec: PaneSpec, body: HTMLElement) => {
    const ctx = contextFor(spec.id);
    const main = el('div', { class: 'pane-main' });
    append(body, main);
    loadInto(main, spec.load, ctx);
    if (!spec.sub) return;
    const subs = new Map<string, HTMLElement>();
    const route = (arg: string) => {
      const key = arg.split('/')[0] ?? '';
      const loader = spec.sub?.[key];
      main.style.display = loader ? 'none' : '';
      for (const [k, node] of subs) node.style.display = k === key ? '' : 'none';
      if (loader && !subs.has(key)) {
        const node = el('div', { class: 'pane-sub', dataset: { sub: key } });
        subs.set(key, node);
        append(body, node);
        loadInto(node, loader, ctx);
      }
    };
    route(ctx.arg());
    ctx.onArg(route);
  };

  const specs = new Map(options.panes.map((s) => [s.id, s]));
  mountTabs(
    tabsRoot,
    panesOf(page)
      .filter((info) => specs.has(info.id))
      .map((info) => ({
        id: info.id,
        label: info.label,
        ...(info.alsoMatches ? { alsoMatches: info.alsoMatches } : {}),
        mount: (body: HTMLElement) => mountPane(specs.get(info.id) as PaneSpec, body),
      })),
    paneForHash(page, currentHash())?.id ?? landingHash(page, facts).split(':')[0],
  );

  // ---- the step bar ----------------------------------------------------------
  const strip = tabsRoot.querySelector<HTMLElement>('.tabs');
  if (strip) {
    strip.setAttribute('role', 'tablist');
    strip.setAttribute('aria-label', 'Steps');
    strip.style.alignItems = 'center';
  }
  const groupLabels = new Map<string, HTMLElement>();
  if (strip) {
    let lastGroup: string | undefined;
    for (const tab of Array.from(strip.querySelectorAll<HTMLElement>('.tab'))) {
      const info = infoOf.get(tab.dataset['tab'] as PaneId);
      if (info?.group && info.group !== lastGroup) {
        const label = el('span', {
          class: 'tab-group small muted',
          text: info.group,
          style: { fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.04em', marginLeft: lastGroup ? 'var(--space-3)' : '0' },
        });
        strip.insertBefore(label, tab);
        groupLabels.set(info.group, label);
        lastGroup = info.group;
      }
    }
  }

  function decorate(): void {
    if (!strip) return;
    const activePane = paneForHash(page, currentHash())?.id ?? strip.querySelector<HTMLElement>('.tab.active')?.dataset['tab'];
    const shownGroups = new Set<string>();
    let n = 0;
    for (const tab of Array.from(strip.querySelectorAll<HTMLElement>('.tab'))) {
      const info = infoOf.get(tab.dataset['tab'] as PaneId);
      if (!info) continue;
      const visible = isPaneVisible(page, info.id, facts);
      const shown = visible || info.id === activePane;
      tab.style.display = shown ? '' : 'none';
      if (shown && info.group) shownGroups.add(info.group);
      if (info.routeOnly) {
        const arg = hashArgument(currentHash()).split('/')[0];
        tab.textContent = arg ? `${info.label}: ${arg}` : info.label;
      } else if (info.step && visible) {
        n += 1;
        tab.textContent = `${n}. ${info.label}`;
      } else {
        tab.textContent = info.label;
      }
    }
    for (const [group, label] of groupLabels) label.style.display = shownGroups.has(group) ? '' : 'none';
    if (modeSelect.value !== facts.mode) modeSelect.value = facts.mode;
    modeHint.textContent = MODE_HINT[facts.mode];
    describe();
  }

  const routeArgs = () => {
    const pane = paneForHash(page, currentHash())?.id;
    if (pane) for (const l of [...(argListeners.get(pane) ?? [])]) l(hashArgument(currentHash()));
    decorate();
  };
  globalThis.addEventListener?.('hashchange', () => {
    // An old planner anchor typed on this page after load goes where it lives now.
    const moved = legacyRedirect(page, currentHash());
    if (moved) {
      globalThis.location.replace(moved);
      return;
    }
    routeArgs();
  });
  // mountTabs rewrites the hash without a hashchange when a tab is clicked.
  strip?.addEventListener('click', () => routeArgs());
  strip?.addEventListener('keydown', () => setTimeout(routeArgs, 0));

  session.subscribe(() => {
    facts = planFacts(session.plan(), tracker);
    decorate();
  });
  decorate();
  return session;
}

/** Load a pane module into `node`: a line while it loads, the error in words if it fails. */
function loadInto(node: HTMLElement, load: () => Promise<PaneModule>, ctx: PaneContext): void {
  append(node, el('div', { class: 'empty', text: 'Loading…' }));
  void load()
    .then(async (mod) => {
      clear(node);
      await mod.mount(node, ctx);
    })
    .catch((error: unknown) => {
      clear(node);
      append(
        node,
        el('div', { class: 'tip warn' }, el('strong', { text: 'This pane could not be built. ' }), el('span', { text: String(error) })),
      );
    });
}

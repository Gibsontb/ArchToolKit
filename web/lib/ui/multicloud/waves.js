/**
 * Waves (`#waves`) on Multi-Cloud Migration & Utilities (base Screen 8,
 * addendum A.5.5.2, A.12.3 WP-9).
 *
 * - The wave settings (`plan.waveSettings`): mode, the limit per wave, waves
 *   in parallel, wave length, the start date and the change-freeze windows.
 * - The team's capacity per window (`waveSettings.capacity`): cutovers,
 *   replication set-ups a day, DBA cutovers and parallel app teams.
 * - Capacity per wave: what each wave carries, and what limited it.
 * - Move groups against waves: a move group is cut over together; a wave is
 *   a batch of move groups in one window. Each group's wave can be pinned
 *   (`App.wave`).
 * - The data-centre exit waves (`dcexit/sequence.ts` `exitWaves`) after the
 *   last app wave, in `dc-exit` mode.
 *
 * The waves come from `wavePlanFor` (wave-model.ts), the one function to swap
 * for WP-9's `planWaves` when it lands.
 */

import { el, append, clear } from '../dom.js';
import { card, findingsList } from '../components.js';
import { renderBlueprintForm } from '../blueprint-form.js';
                                                    
                                                                                            
import { WAVE_MODES } from '../../migration/waves.js';
import { waveViews } from '../../multicloud/plan/governance/comms.js';
import { METHOD_OPTIONS, WAVE_KIND_OPTIONS, WAVE_PARALLEL_OPTIONS, WAVE_WEEKS_OPTIONS } from '../../multicloud/plan/options.js';
                                                                                                                                        
import { planModel } from './plan-model.js';
import { fill, note, rowsTable, watchPlan } from './pane-kit.js';
import { exitPlanOf, waveLoads, wavePlanFor, waveSettingsOf } from './wave-model.js';

const opts = (list                                             )                 => list.map((o) => ({ value: o.value, label: o.label }));

export const DEFAULT_CAPACITY               = { cutoversPerWindow: 20, replicationSetupsPerDay: 10, dbaCutoversPerWindow: 4, parallelAppTeams: 3 };

const SETTINGS_INPUTS                            = [
  { id: 'mode', label: 'Planning mode', control: 'select', options: WAVE_MODES.map((m) => ({ value: m.id, label: m.label })), help: WAVE_MODES.map((m) => `${m.label}: ${m.description}`).join(' ') },
  { id: 'maxPerWave', label: 'Most servers and databases per wave', control: 'number', min: 1, max: 1000 },
  { id: 'parallel', label: 'Waves in parallel', control: 'select', options: opts(WAVE_PARALLEL_OPTIONS) },
  { id: 'weeks', label: 'Wave length', control: 'select', options: opts(WAVE_WEEKS_OPTIONS) },
  { id: 'start', label: 'Start date', control: 'text', placeholder: 'yyyy-mm-dd', hint: 'Blank: the runbooks say "Week N"' },
  {
    id: 'freezes', label: 'Change-freeze windows', control: 'textarea', hint: 'From | To | Reason',
    // The default only declares the grid's shape; the value is the plan's.
    default: 'yyyy-mm-dd | yyyy-mm-dd | reason',
    help: 'No wave runs across a freeze: a wave that would is moved to start the day after it ends.',
  },
];

const CAPACITY_INPUTS                            = [
  { id: 'limited', label: 'Limit the waves by the team\'s capacity', control: 'select', options: [{ value: 'no', label: 'No: only the limit per wave' }, { value: 'yes', label: 'Yes' }] },
  { id: 'cutoversPerWindow', label: 'Server cutovers per window', control: 'number', min: 1, showWhen: { input: 'limited', equals: ['yes'] } },
  { id: 'dbaCutoversPerWindow', label: 'Database cutovers per window (DBAs)', control: 'number', min: 1, showWhen: { input: 'limited', equals: ['yes'] } },
  { id: 'parallelAppTeams', label: 'Application teams in parallel', control: 'number', min: 1, hint: 'Apps per wave', showWhen: { input: 'limited', equals: ['yes'] } },
  { id: 'replicationSetupsPerDay', label: 'Replication set-ups a day', control: 'number', min: 1, hint: 'Checked against each wave', showWhen: { input: 'limited', equals: ['yes'] } },
];

/** The freeze grid's text, and back. */
export function freezesText(freezes                         )         {
  return freezes.map((f) => `${f.from} | ${f.to} | ${f.reason}`).join('\n');
}
export function parseFreezes(text        )                 {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [from = '', to = '', ...rest] = l.split(' | ').map((c) => c.trim());
    return { from, to, reason: rest.join(' | ') };
  });
}

/** Wave settings with one form value applied. */
export function withWaveSetting(settings              , id        , value        )               {
  const n = (fallback        ) => {
    const x = Math.round(Number(value));
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  switch (id) {
    case 'mode': return { ...settings, mode: value             };
    case 'maxPerWave': return { ...settings, maxPerWave: n(settings.maxPerWave) };
    case 'parallel': return { ...settings, parallel: Number(value)                 };
    case 'weeks': return { ...settings, weeks: Number(value)              };
    case 'start': {
      const { start: _s, ...rest } = settings;
      return value.trim() ? { ...rest, start: value.trim() } : rest;
    }
    case 'freezes': return { ...settings, freezes: parseFreezes(value) };
    case 'limited': {
      const { capacity: _c, ...rest } = settings;
      return value === 'yes' ? { ...rest, capacity: settings.capacity ?? DEFAULT_CAPACITY } : rest;
    }
    case 'cutoversPerWindow': case 'dbaCutoversPerWindow': case 'parallelAppTeams': case 'replicationSetupsPerDay': {
      const cap = settings.capacity ?? DEFAULT_CAPACITY;
      return { ...settings, capacity: { ...cap, [id]: n(cap[id]) } };
    }
    default: return settings;
  }
}

/** A plan with a move group's apps pinned to a wave (0 = unpinned). */
export function withPinnedWave(plan      , apps                   , wave        )       {
  return {
    ...plan,
    apps: plan.apps.map((a) => {
      if (!apps.includes(a.name)) return a;
      const { wave: _w, ...rest } = a;
      const edited = [...new Set([...(a.edited ?? []), 'wave'         ])];
      return wave > 0 ? { ...rest, wave, edited } : { ...rest, edited };
    }),
  };
}

export function mount(root             , ctx             )       {
  const settingsCard = el('div');
  const capacityCard = el('div');
  const output = el('div', { class: 'stack', attrs: { 'data-control': 'wave-output' }, style: { overflowWrap: 'anywhere' } });
  append(root, el('div', { class: 'stack' }, intro(ctx), settingsCard, capacityCard, output));

  const settingsValues = ()                  => {
    const s = waveSettingsOf(ctx.session.plan());
    return { mode: s.mode, maxPerWave: String(s.maxPerWave), parallel: String(s.parallel), weeks: String(s.weeks), start: s.start ?? '', freezes: freezesText(s.freezes) };
  };
  const capacityValues = ()                  => {
    const s = waveSettingsOf(ctx.session.plan());
    const c = s.capacity ?? DEFAULT_CAPACITY;
    return {
      limited: s.capacity ? 'yes' : 'no',
      cutoversPerWindow: String(c.cutoversPerWindow), dbaCutoversPerWindow: String(c.dbaCutoversPerWindow),
      parallelAppTeams: String(c.parallelAppTeams), replicationSetupsPerDay: String(c.replicationSetupsPerDay),
    };
  };
  const set = (id        , v        )       => ctx.session.update((p) => ({ ...p, waveSettings: withWaveSetting(waveSettingsOf(p), id, v) }));

  const drawCapacity = ()       => {
    fill(capacityCard, card(
      'Team capacity',
      note('Your team\'s numbers per window. With them, a wave also stops filling when it reaches the cutovers, the DBA cutovers or the app teams a window can take.'),
      el('div', { class: 'two' }, ...renderBlueprintForm({ inputs: CAPACITY_INPUTS }, { values: capacityValues, set, rerender: drawCapacity })),
    ));
  };
  const draw = ()       => {
    fill(settingsCard, card(
      'Wave settings',
      el('div', { class: 'two' }, ...renderBlueprintForm({ inputs: SETTINGS_INPUTS.filter((i) => i.id !== 'freezes') }, { values: settingsValues, set })),
      ...renderBlueprintForm({ inputs: SETTINGS_INPUTS.filter((i) => i.id === 'freezes') }, { values: settingsValues, set }),
    ));
    drawCapacity();
    drawOutput();
  };
  const drawOutput = ()       => {
    clear(output);
    const plan = ctx.session.plan();
    const model = planModel(plan);
    if (model.failure) {
      append(output, card('Waves', el('div', { class: 'tip warn' }, el('strong', { text: 'The plan could not be decided: ' }), el('span', { text: model.failure }))));
      return;
    }
    const waves = wavePlanFor(plan, model.decision);
    const views = new Map(waveViews(plan, waves).map((v) => [v.n, v]));
    const loads = waveLoads(plan, waves);
    const kindLabel = (k        ) => WAVE_KIND_OPTIONS.find((o) => o.value === k)?.label ?? k;
    append(output, card(
      'Capacity per wave',
      loads.length <= 1 ? note('Nothing moves yet: no server or database has a migration method.') : null,
      rowsTable(
        ['Wave', 'Kind', 'Move groups', 'Apps', 'Servers', 'Databases', 'Data (GiB)', 'Start', 'End', 'Limited by'],
        loads.map((l) => [l.name, kindLabel(l.kind), String(l.groups), views.get(l.n)?.apps.join(', ') || (l.apps ? String(l.apps) : '—'), String(l.workloads), String(l.databases), String(l.dataGib), l.start ?? '', l.end ?? '', l.limitedBy ?? '']),
        { numeric: [2, 4, 5, 6], control: 'wave-table' },
      ),
      waves.settings.start ? null : note('No start date: the waves are not dated, and the runbooks count weeks.'),
    ));

    const appGroups = waves.groups.filter((g) => g.id !== 'foundation');
    const waveChoices = ['auto', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const pinOf = (apps                   )         => {
      const pins = plan.apps.filter((a) => apps.includes(a.name) && a.wave !== undefined).map((a) => a.wave          );
      return pins.length > 0 ? String(Math.max(1, Math.min(...pins))) : 'auto';
    };
    append(output, card(
      'Move groups and waves',
      note('A move group is what is cut over together (an application, joined with the ones it depends on synchronously). A wave is a batch of move groups run in one window. Pin a group to a wave, or leave it on Auto.'),
      appGroups.length === 0
        ? note('No move groups yet.')
        : rowsTable(
            ['Move group', 'Items', 'Why grouped', 'Method', 'Wave', 'Pin'],
            appGroups.map((g) => {
              const pick = el('select', { attrs: { 'aria-label': `Pin ${g.name ?? g.id} to a wave`, 'data-control': `pin-${g.id}` } })                     ;
              const current = pinOf(g.apps ?? []);
              for (const c of waveChoices) {
                const o = el('option', { text: c === 'auto' ? 'Auto' : `Wave ${c}`, attrs: { value: c } })                     ;
                if (c === current) o.selected = true;
                pick.appendChild(o);
              }
              pick.disabled = (g.apps ?? []).length === 0;
              pick.addEventListener('change', () => {
                ctx.session.update((p) => withPinnedWave(p, g.apps ?? [], pick.value === 'auto' ? 0 : Number(pick.value)));
              });
              return [g.name ?? g.id, String(g.items.length), g.why, METHOD_OPTIONS.find((o) => o.value === g.method)?.label ?? g.method, String(g.wave), pick];
            }),
            { numeric: [1], control: 'move-groups' },
          ),
    ));

    const exit = plan.mode === 'dc-exit' ? exitPlanOf(plan, { ...waves, waves: waves.waves.filter((w) => w.kind !== 'exit') }) : undefined;
    const exitWaveNumbers = waves.waves.filter((w) => w.kind === 'exit');
    append(output, card(
      'Data-centre exit waves',
      plan.mode !== 'dc-exit'
        ? note('Only in data-centre exit mode (the plan mode in the header).')
        : !exit || exit.waves.length === 0
          ? note('No exit steps yet: describe what else is in the building on the Data centre pane.')
          : rowsTable(['Wave', 'Exit wave', 'After app wave', 'Date', 'Steps'], exit.waves.map((w, i) => [String(exitWaveNumbers[i]?.n ?? w.n), w.label, String(w.afterWave), w.date ?? '', w.steps.map((s) => s.title).join('; ')]), { control: 'exit-waves' }),
      exit && exit.findings.length > 0 ? findingsList(exit.findings) : null,
    ));

    append(output, card(
      'Findings',
      note('The wave engine (WP-9) is not in yet: these waves are a simple grouping by application and pinned wave, under the limits above.', 'wave-engine-note'),
      findingsList(waves.findings, 'No issues found.'),
      el('div', { class: 'btn-row' }, el('a', { class: 'btn btn-small', text: 'Governance: RACI, communications, change requests →', attrs: { href: '#waves:governance' } })),
    ));
  };
  draw();
  watchPlan(ctx, draw, () => {
    drawOutput();
    return false;
  });
}

function intro(ctx             )              {
  const mode = ctx.session.plan().mode ?? 'migrate';
  return card(
    'Waves',
    el('p', { text: 'Wave 0 stands up the landing zones. The application waves follow, each a batch of move groups in one window; in a data-centre exit the exit waves come last.' }),
    mode === 'new' ? note('This plan adds new services only: nothing moves, so there are no application waves.') : null,
  );
}


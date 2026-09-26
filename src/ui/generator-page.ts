/**
 * The generator page, shared by Terraform and Ansible.
 *
 * Three steps, in the order someone actually works:
 *
 *   1. Platform, then what you are building.
 *   2. That thing's parameters.
 *   3. The generated code, with Download and Copy.
 *
 * The platform is picked once and remembered for the tab, so arriving here from
 * the decision matrix — or from the other generator — does not mean picking the
 * cloud again. Changing it here changes it everywhere.
 *
 * The page knows nothing about any particular blueprint. It renders whatever
 * inputs the selected one declares and calls its build function, so adding a
 * blueprint is adding one object to one file.
 */

import { el, append, replace, clear, downloadFile } from './dom.ts';
import { tarGz, zip } from '../kit/archive.ts';
import { buildVroPackage, readPackageSpec } from '../kit/vro-package.ts';
import { openCalculator } from './net-calc.ts';
import { openInArchPad } from '../archpad/handoff.ts';
import { card, findingsList } from './components.ts';
import { getTarget, setTarget, type TargetId } from '../kit/target.ts';
import {
  defaultValues,
  isVisible,
  blueprintsFor,
  type Blueprint,
  type BlueprintGroup,
  type BlueprintValues,
  type BuildResult,
} from '../kit/blueprint.ts';
import { tableShape } from './multi-editors.ts';
import { blueprintField, fillOptions, labelledField, remember, renderBlueprintForm, withCurrentTags } from './blueprint-form.ts';
import type { Finding } from '../core/findings.ts';
import { fileBar } from './file-bar.ts';
import { envelope, openEnvelope, SETTINGS_KINDS, stripSecrets } from '../kit/settings-file.ts';
import { isRecord, type Json } from '../editor/doc.ts';
import type { StackBuild, StackItem, StackReference } from '../terraform/stack.ts';

export interface GeneratorOptions {
  readonly groups: readonly BlueprintGroup[];
  /** "Terraform (HCL)" or "Ansible" — used in labels and the status line. */
  readonly kindLabel: string;
  /** The label for one platform, when it is not what the page is named for. */
  readonly kindLabelFor?: (platform: string) => string | undefined;
  /** What to call the thing being built, e.g. "blueprint" or "playbook". */
  readonly noun: string;
  /** Shown under step 3 before anything is generated. */
  readonly idleHint: string;
  /** Extension for the combined download. */
  readonly downloadExtension: string;
  /**
   * Extra package downloads beside the zip, for targets that import a package
   * of their own — a Splunk app as .spl. Each is built from the same files.
   */
  readonly packages?: readonly {
    readonly label: string;
    readonly extension: '.zip' | '.tgz' | '.spl' | '.tar.gz';
    /** Which of the generated files go in; all of them when absent. */
    readonly include?: (path: string) => boolean;
  }[];
  /**
   * The blueprint group to open on when the platform has one — the estate
   * blueprints, once an estate is loaded. Otherwise the first blueprint.
   */
  readonly preferGroup?: () => string | undefined;
  /** Findings that always apply, e.g. catalog age. */
  readonly standingFindings?: () => readonly Finding[];
  /** A reference page for this platform's resources, linked from step 1. */
  readonly mapHref?: string;
  /**
   * Extra panels rendered under the generated output.
   *
   * The Terraform page uses this to show the map rows that talk about the
   * resources it has just written. It gets the platform and the files, because
   * a panel about the output can only be built from the output — a blueprint's
   * declared `emits` is a declaration, and most blueprints declare nothing.
   */
  readonly panels?: (platform: string, files: Readonly<Record<string, string>>) => readonly HTMLElement[];
  /**
   * Open on a particular blueprint, with some of its inputs already filled.
   *
   * The Commands tab uses this: a row there links to the generator with the
   * command's id, and the page opens on the catalogue blueprint with that
   * command selected rather than making you find it again in a list of four
   * hundred. Returns undefined when the link said nothing.
   */
  readonly openWith?: () => { readonly blueprint: string; readonly values: BlueprintValues } | undefined;
  /** The `kind` written into saved settings, e.g. `archtoolkit.terraform-generator`. */
  readonly settingsKind: string;
  /**
   * Whether the platform picker is the toolkit-wide cloud.
   *
   * True for Terraform and Ansible: the cloud is chosen once and every page
   * agrees. False for a page whose platforms are not clouds at all — a network
   * kit picks between Cisco IOS and PAN-OS — where writing the choice into the
   * shared target would tell the other pages the cloud had changed to something
   * they have never heard of. Such a page remembers its own platform instead,
   * under its settings kind. Defaults to true.
   */
  readonly sharedPlatform?: boolean;
  /**
   * Assemble several blueprints into one configuration.
   *
   * With this, the page grows a build list: add what you are building one
   * piece at a time, then generate the lot as a single project, with each
   * item able to reference what the ones before it create. Without it the
   * page behaves as it always has, one blueprint at a time.
   */
  readonly workspace?: (blueprint: Blueprint) => GeneratorWorkspace | undefined;
  readonly stack?: {
    /** "stack" for Terraform, "site playbook" for Ansible. */
    readonly noun: string;
    /** The button that adds to the list, when "Add to build" is not the words. */
    readonly addLabel?: string;
    /** What the picker offers, in words: "a shared variable". */
    readonly referenceLabel?: string;
    /** How a reference is written into a field. Terraform's `${…}` by default. */
    readonly wrap?: (expression: string) => string;
    readonly build: (items: readonly StackItem[], blueprintFor: (id: string) => Blueprint | undefined, options: { target?: string; stackName?: string }) => StackBuild;
  };
}

/**
 * A full-width editor for one blueprint, above its steps.
 *
 * Some blueprints are edited better on a canvas than as a column of fields —
 * a dashboard is widgets placed on a grid. Such a blueprint gets a workspace
 * the width of the page; the inputs it owns leave Step 2, and it reads and
 * writes them through the same values the form uses, so saving, loading and
 * generating are unchanged.
 */
export interface GeneratorWorkspace {
  /** The inputs the workspace edits; Step 2 leaves them out. */
  readonly owns: (inputId: string) => boolean;
  readonly mount: (context: WorkspaceContext) => HTMLElement;
}

export interface WorkspaceContext {
  readonly blueprint: Blueprint;
  /** The values as they stand. */
  values(): BlueprintValues;
  /** Change some values (without redrawing the workspace). */
  set(patch: BlueprintValues): void;
  /** The page's own field for an input, bound to the values; onChange after each change. */
  field(inputId: string, onChange?: () => void): HTMLElement | null;
  /** Generate, as the Generate button does, and bring the result into view. */
  generate(): void;
}

/**
 * The page shows errors and warnings about the values given, not general
 * advice: info findings and the page's standing notes are left out.
 */
function aboutTheInput(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.severity !== 'info');
}

/**
 * What `terraform apply` will create from the generated call.
 *
 * The module block names one thing; the plan creates many, and which ones
 * depends on the answers. This is the registry page's resource list with each
 * row decided: created, not created, or depends — the last with the condition
 * shown, because it could not be worked out without guessing.
 */
function buildsPanel(builds: NonNullable<BuildResult['builds']>): HTMLElement {
  const yes = builds.filter((b) => b.status === 'yes').length;
  const maybe = builds.filter((b) => b.status === 'depends').length;
  const rows = [...builds].sort((a, b) => order(a.status) - order(b.status));

  const body = el('tbody');
  for (const b of rows) {
    body.appendChild(
      el(
        'tr',
        { class: `build-${b.status}` },
        el('td', {}, el('span', { class: `build-mark is-${b.status}`, text: MARK[b.status] })),
        el(
          'td',
          {},
          el('code', { class: 'build-address', text: b.address }),
          // The reason sits under the name rather than in a third column: the
          // generated-code card is narrow, and a condition beside the address
          // was cut off exactly where it said why.
          b.status === 'depends' && b.condition
            ? el('div', { class: 'build-why' }, el('span', { text: 'When ' }), el('code', { text: b.condition }))
            : b.because
              ? el('div', { class: 'build-why', text: b.because })
              : null,
        ),
      ),
    );
  }

  return el(
    'div',
    { class: 'builds' },
    el(
      'div',
      { class: 'builds-head' },
      el('strong', { text: 'What this will create' }),
      el('span', {
        class: 'muted',
        text: `${yes} resource${yes === 1 ? '' : 's'}${maybe > 0 ? `, ${maybe} depending on values outside the form` : ''}, of ${builds.length} the module can make`,
      }),
    ),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table builds-table' },
        el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { text: 'Resource, and what decided it' }))),
        body,
      ),
    ),
  );
}

const MARK = { yes: 'Created', no: 'Not created', depends: 'Depends' } as const;
const order = (s: 'yes' | 'no' | 'depends'): number => (s === 'yes' ? 0 : s === 'depends' ? 1 : 2);

export function mountGeneratorPage(root: HTMLElement, options: GeneratorOptions): void {
  const shared = options.sharedPlatform !== false;
  const ownKey = `${options.settingsKind}.platform`;

  /** The platform this page is on, for a page that does not share the cloud. */
  const recallOwn = (): string | null => {
    try {
      return globalThis.sessionStorage?.getItem(ownKey) ?? null;
    } catch {
      return null;
    }
  };
  const rememberPlatform = (next: string, origin: string): void => {
    if (shared) {
      setTarget(next as TargetId, origin);
      return;
    }
    try {
      globalThis.sessionStorage?.setItem(ownKey, next);
    } catch {
      // Not remembering the platform is survivable; failing to render is not.
    }
  };
  const known = (value: string | null | undefined): string | undefined =>
    options.groups.some((g) => g.target === value) ? (value as string) : undefined;

  // Declared above everything that can reach them: a `let` below the code that
  // uses it left a page dead on arrival once already, and neither the tests nor
  // the typechecker noticed.
  let target: TargetId = ((shared ? known(getTarget()?.target) : known(recallOwn())) ?? options.groups[0]?.target ?? 'aws') as TargetId;
  let blueprint: Blueprint | undefined;
  let values: BlueprintValues = {};
  let generated: Readonly<Record<string, string>> | null = null;
  let stackItems: StackItem[] = [];
  let stackRefs: readonly StackReference[] = [];
  let editing: string | null = null;
  let builds: BuildResult['builds'] = undefined;
  let findings: readonly Finding[] = [];

  const stepOne = el('div', { class: 'stack' });
  const kindLabel = (): string => options.kindLabelFor?.(target) ?? options.kindLabel;
  const buildList = el('div', { class: 'stack' });
  const stepTwo = el('div', { class: 'stack' });
  const stepThree = el('div', { class: 'stack' });
  // A blueprint with a wide input (the tag standard) gets the parameters the width of two columns.
  const workspaceHolder = el('div', { class: 'generator-workspace', attrs: { hidden: true } });
  const stepThreeHolder = el('div', {}, stepThree);
  const grid = el('div', { class: 'generator-grid' }, el('div', {}, stepOne), el('div', {}, stepTwo), workspaceHolder, stepThreeHolder);

  append(root, buildList);
  append(
    root,
    fileBar({
      noun: `the ${options.noun} and its parameters`,
      fileName: () => `${String(values.__name ?? '').trim() || blueprint?.id || options.noun}-settings`,
      header: () => [
        `ArchToolKit ${kindLabel()} settings: ${blueprint?.label ?? ''}`,
        'Load this file on the same page to carry on. Passwords and keys are not saved.',
      ],
      save: () =>
        envelope(options.settingsKind, {
          target,
          blueprint: blueprint?.id ?? null,
          values: stripSecrets(values as unknown as Json),
          ...(options.stack
            ? {
                stackName: stackName.value.trim(),
                stack: stripSecrets(stackItems.map((i) => ({ id: i.id, blueprintId: i.blueprintId, label: i.label, values: i.values })) as unknown as Json),
              }
            : {}),
        }) as unknown as Json,
      load: (value, name) => {
        const opened = openEnvelope(value, options.settingsKind, SETTINGS_KINDS);
        if ('error' in opened) throw new Error(opened.error);
        const file = opened.ok;
        const group = options.groups.find((g) => g.target === file.target);
        if (!group) throw new Error(`the platform ${String(file.target)} is not one this page builds for.`);
        target = group.target as TargetId;
        rememberPlatform(target, `loaded from ${name}`);
        const next = available().find((b) => b.id === file.blueprint);
        if (!next) throw new Error(`there is no ${options.noun} called ${String(file.blueprint)} for ${group.label}.`);
        selectBlueprint(next);
        const loaded = isRecord(file.values) ? file.values : {};
        // A form still loading cannot say which fields it has; keep them all.
        const waiting = !!next.load && next.inputs.length === 0;
        const known = new Set(['__name', ...next.inputs.map((i) => i.id)]);
        const ignored = waiting ? [] : Object.keys(loaded).filter((k) => !known.has(k));
        const kept: BlueprintValues = {};
        for (const [k, v] of Object.entries(loaded)) if (waiting || known.has(k)) (kept as Record<string, unknown>)[k] = v;
        values = { ...values, ...kept };
        if (options.stack) {
          const saved = Array.isArray(file.stack) ? file.stack : [];
          stackItems = saved
            .filter((entry): entry is Record<string, Json> => isRecord(entry) && typeof entry.blueprintId === 'string')
            .map((entry, i) => ({
              id: typeof entry.id === 'string' ? entry.id : `i${i}`,
              blueprintId: String(entry.blueprintId),
              label: typeof entry.label === 'string' ? entry.label : `Item ${i + 1}`,
              values: isRecord(entry.values) ? (entry.values as unknown as BlueprintValues) : {},
            }));
          stackName.value = typeof file.stackName === 'string' ? file.stackName : '';
          editing = null;
          refreshStack();
          renderBuildList();
        }
        renderOne();
        renderTwo();
        renderThree();
        const inList = options.stack && stackItems.length > 0 ? ` The build list has ${stackItems.length} item${stackItems.length === 1 ? '' : 's'}.` : '';
        return `Loaded ${next.label} from ${name}${ignored.length ? `; ${ignored.length} field${ignored.length === 1 ? '' : 's'} this ${options.noun} no longer has were skipped (${ignored.slice(0, 4).join(', ')})` : ''}.${inList}`;
      },
      clear: () => {
        selectBlueprint(first());
        stackItems = [];
        editing = null;
        stackName.value = '';
        refreshStack();
        renderBuildList();
        renderOne();
        renderTwo();
        renderThree();
      },
    }),
    grid,
  );

  // If the tab has no target yet, record the one being shown so the other pages
  // agree with this one rather than each defaulting on their own.
  if (shared ? getTarget() === null : recallOwn() === null) rememberPlatform(target, 'chosen on this page');

  function available(): readonly Blueprint[] {
    return blueprintsFor(options.groups, target);
  }

  function first(): Blueprint | undefined {
    const preferred = options.preferGroup?.();
    return (preferred ? available().find((b) => b.group === preferred) : undefined) ?? available()[0];
  }

  /**
   * A blueprint whose form is fetched when it is picked (the per-resource cloud
   * ones) has no inputs until then. This starts whatever is missing and runs
   * `then` once it has arrived; true means everything was already there.
   */
  function ensureLoaded(list: readonly (Blueprint | undefined)[], then: () => void): boolean {
    const pending = list.filter((b): b is Blueprint => !!b?.load && b.inputs.length === 0);
    if (pending.length === 0) return true;
    void Promise.all(pending.map((b) => (b.load as () => Promise<void>)())).then(then, (err: unknown) => {
      findings = [
        {
          code: 'generator.load-failed',
          severity: 'error',
          message: `The ${options.noun}'s schema could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
      renderThree();
    });
    return false;
  }

  function selectBlueprint(next: Blueprint | undefined): void {
    blueprint = next;
    values = next ? withCurrentTags(next, defaultValues(next)) : {};
    generated = null;
    builds = undefined;
    findings = [];
    if (next) {
      ensureLoaded([next], () => {
        if (blueprint !== next) return;
        // Defaults under whatever is already set — a loaded settings file, the name.
        values = { ...withCurrentTags(next, defaultValues(next)), ...values };
        renderOne();
        renderTwo();
      });
    }
  }

  function generate(): void {
    if (!blueprint) return;
    if (!ensureLoaded([blueprint], generate)) return;
    const name = String(values.__name ?? '').trim();
    try {
      const out = blueprint.build(values, name);
      generated = out.files;
      builds = out.builds;
      findings = aboutTheInput(out.findings ?? []);
      // What was built here is offered in the other blueprints (an index defined here, in every index field).
      for (const input of blueprint.inputs) if (input.remember) remember(input.remember, String(values[input.id] ?? ''));
    } catch (err) {
      generated = null;
      findings = [
        {
          code: 'generator.build-failed',
          severity: 'error',
          message: `The ${options.noun} could not be generated: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
    }
    renderThree();
  }

  // --- the build list ------------------------------------------------------
  const blueprintById = (id: string): Blueprint | undefined =>
    options.groups.flatMap((g) => g.blueprints).find((b) => b.id === id);

  /** What the items expose, recalculated whenever the list changes. */
  function refreshStack(): void {
    if (!options.stack || stackItems.length === 0) {
      stackRefs = [];
      return;
    }
    const redo = (): void => {
      refreshStack();
      renderBuildList();
      renderTwo();
    };
    if (!ensureLoaded(stackItems.map((i) => blueprintById(i.blueprintId)), redo)) {
      stackRefs = [];
      return;
    }
    stackRefs = options.stack.build(stackItems, blueprintById, { target }).references;
  }

  function addToBuild(): void {
    if (!blueprint || !options.stack) return;
    const label = String(values.__name ?? '').trim() || blueprint.label;
    const entry: StackItem = { id: editing ?? `i${Date.now().toString(36)}`, blueprintId: blueprint.id, label, values: { ...values } };
    const at = stackItems.findIndex((i) => i.id === entry.id);
    if (at >= 0) stackItems[at] = entry;
    else stackItems.push(entry);
    editing = null;
    refreshStack();
    renderBuildList();
    renderTwo();
  }

  function generateStack(): void {
    if (!options.stack) return;
    if (!ensureLoaded(stackItems.map((i) => blueprintById(i.blueprintId)), generateStack)) return;
    const result = options.stack.build(stackItems, blueprintById, { target, stackName: stackName.value.trim() || undefined });
    generated = result.files;
    builds = undefined;
    findings = aboutTheInput(result.findings);
    stackRefs = result.references;
    renderThree();
  }

  const stackName = el('input', {
    attrs: { type: 'text', placeholder: 'Name for the whole stack, e.g. prod-landing-zone', 'data-control': 'stack-name' },
  }) as HTMLInputElement;

  function renderBuildList(): void {
    if (!options.stack) return;
    const rows = stackItems.map((entry, index) => {
      const blueprintOf = blueprintById(entry.blueprintId);
      const move = (by: -1 | 1) => {
        const to = index + by;
        if (to < 0 || to >= stackItems.length) return;
        const copy = [...stackItems];
        [copy[index], copy[to]] = [copy[to] as StackItem, copy[index] as StackItem];
        stackItems = copy;
        refreshStack();
        renderBuildList();
      };
      const small = (text: string, title: string, act: () => void, disabled = false) =>
        el('button', {
          class: 'btn btn-small',
          text,
          attrs: { type: 'button', title, ...(disabled ? { disabled: 'disabled' } : {}) },
          on: { click: act },
        });
      return el(
        'div',
        { class: `build-item${editing === entry.id ? ' is-editing' : ''}`, attrs: { 'data-item': entry.label } },
        el('span', { class: 'build-order', text: String(index + 1) }),
        el(
          'span',
          { class: 'build-what' },
          el('strong', { text: entry.label }),
          el('span', { class: 'muted small', text: blueprintOf?.label ?? entry.blueprintId }),
        ),
        el(
          'span',
          { class: 'je-actions' },
          small('↑', 'Move up', () => move(-1), index === 0),
          small('↓', 'Move down', () => move(1), index === stackItems.length - 1),
          small('Edit', 'Load this item back into the form', () => {
            const loaded = blueprintById(entry.blueprintId);
            if (!loaded) return;
            blueprint = loaded;
            values = { ...defaultValues(loaded), ...entry.values };
            editing = entry.id;
            renderOne();
            renderTwo();
            renderBuildList();
          }),
          small('Remove', 'Take this out of the build', () => {
            stackItems = stackItems.filter((i) => i.id !== entry.id);
            if (editing === entry.id) editing = null;
            refreshStack();
            renderBuildList();
            renderTwo();
          }),
        ),
      );
    });

    replace(
      buildList,
      card(
        `Build list (${stackItems.length})`,
        el('p', {
          class: 'muted small',
          text: `Add each piece, then generate the whole ${options.stack.noun} as one project: one file per item, the shared files around them, and a README. A field can take ${options.stack.referenceLabel ?? 'a value from an item already in the list'}.`,
        }),
        stackItems.length === 0
          ? el('div', { class: 'empty', text: `Nothing added yet. Fill in the parameters and press "${options.stack?.addLabel ?? 'Add to build'}".` })
          : el('div', { class: 'build-list' }, ...rows),
        el('div', { class: 'field' }, el('label', { text: `Name for this ${options.stack.noun}` }), stackName),
        el(
          'div',
          { class: 'btn-row' },
          el('button', {
            class: 'btn btn-primary btn-small',
            text: `Generate ${options.stack.noun}`,
            attrs: { type: 'button', 'data-control': 'generate-stack', ...(stackItems.length === 0 ? { disabled: 'disabled' } : {}) },
            on: { click: generateStack },
          }),
          el('button', {
            class: 'btn btn-small',
            text: 'Clear list',
            attrs: { type: 'button', 'data-control': 'clear-stack', ...(stackItems.length === 0 ? { disabled: 'disabled' } : {}) },
            on: {
              click: () => {
                stackItems = [];
                editing = null;
                refreshStack();
                renderBuildList();
                renderTwo();
              },
            },
          }),
          // Working out subnets is part of building the change, so the calculator is here too.
          el('button', {
            class: 'btn btn-small btn-netcalc',
            text: 'Network calculator',
            attrs: { type: 'button', 'data-control': 'netcalc-stack', title: 'Subnets, splits, VLSM and overlap checks — IPv4 and IPv6' },
            on: { click: () => openCalculator() },
          }),
        ),
      ),
    );
  }

  /** A button that drops a reference to another item's value into a field. */
  function referenceButton(set: (expression: string) => void): HTMLElement | null {
    if (stackRefs.length === 0) return null;
    const picker = el('select', { class: 'ref-picker', attrs: { 'aria-label': 'Use a value from the build list' } }) as HTMLSelectElement;
    picker.appendChild(el('option', { text: '⇢', attrs: { value: '' } }));
    picker.title = `Use ${options.stack?.referenceLabel ?? 'a value from an item in the build list'}`;
    let group: HTMLOptGroupElement | null = null;
    let groupName: string | undefined;
    for (const reference of stackRefs) {
      if (reference.item !== groupName) {
        groupName = reference.item;
        group = el('optgroup', { attrs: { label: groupName } }) as HTMLOptGroupElement;
        picker.appendChild(group);
      }
      (group ?? picker).appendChild(el('option', { text: reference.expression, attrs: { value: reference.expression } }));
    }
    picker.addEventListener('change', () => {
      if (!picker.value) return;
      set(options.stack?.wrap ? options.stack.wrap(picker.value) : `\${${picker.value}}`);
      picker.value = '';
    });
    return picker;
  }

  // --- step 1 --------------------------------------------------------------
  function renderOne(): void {
    const platform = el('select') as HTMLSelectElement;
    for (const group of options.groups) {
      const opt = el('option', { text: group.label, attrs: { value: group.target } });
      if (group.target === target) (opt as HTMLOptionElement).selected = true;
      platform.appendChild(opt);
    }
    platform.addEventListener('change', () => {
      target = platform.value as TargetId;
      rememberPlatform(target, 'chosen on this page');
      selectBlueprint(first());
      renderOne();
      renderTwo();
      renderThree();
    });

    const list = el('select') as HTMLSelectElement;
    fillOptions(
      list,
      available().map((item) => ({ value: item.id, label: item.label, group: item.group })),
      blueprint?.id ?? '',
    );
    list.addEventListener('change', () => {
      selectBlueprint(available().find((b) => b.id === list.value));
      renderTwo();
      renderThree();
    });

    const origin = getTarget()?.origin;

    replace(
      stepOne,
      card(
        'Step 1 — Platform and what to build',
        labelledField(
          {
            id: 'platform',
            label: 'Platform',
            control: 'select',
            // A page whose platforms are device operating systems keeps its own
            // selection, so saying "used everywhere" there would be a lie.
            hint: shared ? 'Chosen once, used everywhere' : 'This page only',
          },
          platform,
        ),
        labelledField(
          {
            id: 'blueprint',
            label: options.noun.charAt(0).toUpperCase() + options.noun.slice(1),
            control: 'select',
            hint: 'What to build',
          },
          list,
        ),
        origin ? el('div', { class: 'section-note', text: `Platform ${origin}.` }) : null,
        options.mapHref
          ? el(
              'div',
              { class: 'btn-row' },
              el('a', {
                class: 'btn btn-small',
                text: 'Which resource does what →',
                attrs: { href: options.mapHref, title: 'The map of resources for this platform, by domain' },
              }),
            )
          : null,
      ),
    );
  }

  // --- step 2 --------------------------------------------------------------
  /** A labelled field for one input, bound to the values; used by workspaces. */
  function boundField(inputId: string, after?: () => void): HTMLElement | null {
    const raw = blueprint?.inputs.find((i) => i.id === inputId);
    if (!raw) return null;
    return blueprintField(raw, {
      target,
      values: () => values,
      set: (id, v) => {
        values = { ...values, [id]: v };
      },
    }, after);
  }

  function renderWorkspace(space: GeneratorWorkspace | undefined): void {
    grid.classList.toggle('generator-grid-workspace', !!space);
    if (!space || !blueprint) {
      workspaceHolder.hidden = true;
      clear(workspaceHolder);
      return;
    }
    const current = blueprint;
    workspaceHolder.hidden = false;
    replace(
      workspaceHolder,
      space.mount({
        blueprint: current,
        values: () => values,
        set: (patch) => {
          values = { ...values, ...patch };
        },
        field: boundField,
        generate: () => {
          generate();
          stepThree.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        },
      }),
    );
  }

  function renderTwo(): void {
    // A wide input — the tag standard, or a grid of three or more columns — gets the
    // parameters the width of two columns, so its cells are not cut short.
    const space = blueprint && !(blueprint.load && blueprint.inputs.length === 0) ? options.workspace?.(blueprint) : undefined;
    grid.classList.toggle('generator-grid-wide', !space && !!blueprint?.inputs.some((i) => i.control === 'tag-standard' || (isVisible(i, values) && (tableShape(i)?.columns.length ?? 0) >= 3)));
    renderWorkspace(space);
    if (!blueprint) {
      replace(stepTwo, card('Step 2 — Parameters', el('p', { text: 'Choose something to build.' })));
      return;
    }
    if (blueprint.load && blueprint.inputs.length === 0) {
      replace(stepTwo, card('Step 2 — Parameters', el('p', { text: 'Loading every argument this resource takes…' })));
      return;
    }

    const fields: HTMLElement[] = [];

    const nameInput = el('input', {
      attrs: { type: 'text', placeholder: 'Used in comments, tags and the filename' },
    }) as HTMLInputElement;
    nameInput.value = String(values.__name ?? '');
    nameInput.addEventListener('input', () => {
      values = { ...values, __name: nameInput.value };
    });
    fields.push(
      labelledField(
        { id: '__name', label: 'Name for the files and comments', control: 'text', hint: 'Optional' },
        nameInput,
      ),
    );

    fields.push(
      ...renderBlueprintForm(blueprint, {
        target,
        values: () => values,
        set: (id, v) => {
          values = { ...values, [id]: v };
        },
        rerender: renderTwo,
        skip: (id) => !!space?.owns(id),
        reference: referenceButton,
      }),
    );

    replace(
      stepTwo,
      card(
        'Step 2 — Parameters',
        el('p', { class: 'blueprint-description', text: blueprint.description }),
        ...fields,
        el(
          'div',
          { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
          el('button', {
            class: 'btn btn-primary',
            text: `Generate ${kindLabel()}`,
            attrs: { type: 'button', 'data-control': 'generate' },
            on: { click: generate },
          }),
          options.stack
            ? el('button', {
                class: 'btn',
                text: editing ? 'Update in the list' : (options.stack.addLabel ?? 'Add to build'),
                attrs: { type: 'button', title: `Put this in the build list, to generate with the rest of the ${options.stack.noun}`, 'data-control': 'add-to-build' },
                on: { click: addToBuild },
              })
            : null,
          el('button', {
            class: 'btn',
            text: 'Reset',
            on: {
              click: () => {
                selectBlueprint(blueprint);
                renderTwo();
                renderThree();
              },
            },
          }),
        ),
      ),
    );
  }

  // --- step 3 --------------------------------------------------------------
  function renderThree(): void {
    const children: HTMLElement[] = [];

    if (generated === null) {
      children.push(el('p', { class: 'muted', text: options.idleHint }));
    } else {
      // Orchestrator packages come first, built and signed, one button each:
      // that is what VCF Automation imports. Their text sources stay below,
      // folded away, for anyone who wants to review them.
      const packages = orchestratorPackages(generated);
      if (packages.length > 0) children.push(packagePanel(packages));
      const packageSource: HTMLElement[] = [];
      for (const [filename, body] of Object.entries(generated)) {
        (PACKAGE_PATH.test(filename) ? packageSource : children).push(
          el(
            'div',
            { class: 'file-head' },
            el('strong', { text: filename }),
            el(
              'span',
              { class: 'btn-row' },
              el('button', {
                class: 'btn btn-small',
                text: 'Copy',
                on: {
                  click: (event: Event) => {
                    const button = event.currentTarget as HTMLButtonElement;
                    void navigator.clipboard?.writeText(body).then(
                      () => {
                        button.textContent = 'Copied';
                        globalThis.setTimeout(() => {
                          button.textContent = 'Copy';
                        }, 1200);
                      },
                      () => {
                        button.textContent = 'Copy failed';
                      },
                    );
                  },
                },
              }),
              el('button', {
                class: 'btn btn-small',
                text: 'Download',
                on: { click: () => downloadFile(filename, body, 'text/plain') },
              }),
              archPadButton('Open in ArchPad', () => [{ name: filename, text: body }]),
            ),
          ),
          el('pre', { class: 'mono code-block' }, body),
        );
      }
      if (packageSource.length > 0) {
        children.push(
          el(
            'details',
            { class: 'package-source' },
            el('summary', { text: `Orchestrator package source — ${packageSource.length / 2} text files, for review only (the buttons above build the importable .package)` }),
            ...packageSource,
          ),
        );
      }

      if (builds && builds.length > 0) children.push(buildsPanel(builds));

      if (Object.keys(generated).length > 0) {
        const all = generated;
        const base = String(values.__name ?? blueprint?.id ?? 'generated')
          .trim()
          .replace(/[^A-Za-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'generated';
        const archive = async (button: HTMLButtonElement, extension: string, include?: (path: string) => boolean) => {
          const label = button.textContent;
          button.disabled = true;
          button.textContent = 'Building…';
          try {
            const chosen = Object.fromEntries(Object.entries(all).filter(([path]) => (include ? include(path) : true)));
            const bytes = extension === '.zip' ? await zip(chosen) : await tarGz(chosen);
            downloadFile(`${base}${extension}`, bytes, extension === '.zip' ? 'application/zip' : 'application/gzip');
          } finally {
            button.disabled = false;
            button.textContent = label;
          }
        };
        children.push(
          el(
            'div',
            { class: 'btn-row', style: { marginTop: 'var(--space-3)' } },
            // The zip is the import format: every file keeps its name, its
            // folder and, for scripts, its executable bit, and anything the
            // target takes as a package inside it is already packaged.
            el('button', {
              class: orchestratorPackages(all).length > 0 ? 'btn' : 'btn btn-primary',
              text: orchestratorPackages(all).length > 0 ? 'Download everything as .zip (packages, scripts, manual-import files)' : 'Download as .zip',
              attrs: { title: 'Every file with its real name and folder — unzip and import or run as it stands' },
              on: { click: (event: Event) => void archive(event.currentTarget as HTMLButtonElement, '.zip') },
            }),
            ...(options.packages ?? []).map((pkg) =>
              el('button', {
                class: 'btn',
                text: pkg.label,
                on: { click: (event: Event) => void archive(event.currentTarget as HTMLButtonElement, pkg.extension, pkg.include) },
              }),
            ),
            // Terraform: one .tf of every .tf file is still a configuration
            // Terraform runs as it stands (versions, providers, resources and
            // variables may share a file), so it is offered as HCL. The README
            // and the tfvars example are left out; they are not HCL it reads.
            options.downloadExtension === '.tf'
              ? el('button', {
                  class: 'btn',
                  text: 'Download as one .tf file (HCL)',
                  attrs: { title: 'versions.tf, providers.tf, main.tf, variables.tf and outputs.tf in one main.tf — terraform init && terraform apply work on it as it stands' },
                  on: {
                    click: () =>
                      downloadFile(
                        `${base}.tf`,
                        Object.entries(all)
                          .filter(([n]) => n.endsWith('.tf'))
                          .map(([n, b]) => `# ===== ${n} =====\n\n${b.trimEnd()}\n`)
                          .join('\n'),
                        'text/plain',
                      ),
                  },
                })
              : el('button', {
                  class: 'btn',
                  text: 'Download all as one text file',
                  attrs: { title: 'For reading or attaching to a change record. Not an import format.' },
                  on: {
                    click: () =>
                      downloadFile(
                        `${base}${options.downloadExtension}`,
                        Object.entries(all)
                          .map(([n, b]) => `# ===== ${n} =====\n${b}`)
                          .join('\n'),
                        'text/plain',
                      ),
                  },
                }),
            archPadButton('Open all in ArchPad', () => Object.entries(all).map(([name, text]) => ({ name, text }))),
          ),
        );
      }
    }

    const errors = findings.filter((f) => f.severity === 'error').length;
    const status =
      generated === null
        ? 'Idle — nothing generated yet.'
        : errors > 0
          ? `${errors} error${errors === 1 ? '' : 's'} — see below.`
          : 'Generated. No errors.';

    const extra = generated === null ? [] : (options.panels?.(target, generated) ?? []);

    replace(
      stepThree,
      card(
        `Step 3 — Generated ${kindLabel()}`,
        el(
          'div',
          { class: `status-line ${errors > 0 ? 'is-bad' : generated ? 'is-good' : ''}` },
          el('span', { text: status }),
        ),
        ...children,
      ),
      findings.length > 0 ? card('Findings', findingsList(findings)) : el('div'),
      ...extra,
    );
  }

  // A link from elsewhere can name the blueprint to open on and prefill it —
  // the Commands tab sends a catalogued command here that way. It is applied
  // after the defaults so a missing or renamed blueprint simply does nothing.
  const opening = options.openWith?.();
  const wanted = opening ? available().find((b) => b.id === opening.blueprint) : undefined;
  if (opening && wanted) {
    selectBlueprint(wanted);
    values = { ...values, ...opening.values };
  } else {
    selectBlueprint(first());
  }

  renderOne();
  renderTwo();
  renderThree();
  renderBuildList();
}

// --- Orchestrator packages ----------------------------------------------------

/**
 * Hands generated text to ArchPad — an ArchPad tab already open if there is
 * one, else a new tab. The files are read at click time so the button always
 * sends what is on screen.
 */
function archPadButton(label: string, files: () => { name: string; text: string }[]): HTMLButtonElement {
  return el('button', {
    class: 'btn btn-small',
    text: label,
    attrs: { title: 'Edit in ArchPad, the toolkit’s text editor' },
    on: {
      click: (event: Event) => {
        const button = event.currentTarget as HTMLButtonElement;
        void openInArchPad(files()).then((where) => {
          button.textContent = where === 'blocked' ? 'Pop-up blocked — open ArchPad from the menu' : where === 'tab' ? 'Sent to ArchPad' : label;
          if (where !== 'new') globalThis.setTimeout(() => (button.textContent = label), 2500);
        });
      },
    },
  });
}

/** A file inside a package folder: import/<name>.package/<path>. */
const PACKAGE_PATH = /^(?:.*\/)?[^/]+\.package\//;

interface PackageFolder {
  /** vcf.automation.core */
  readonly name: string;
  readonly version: string;
  readonly files: Record<string, string>;
}

/** The package folders in the output, the core library first. */
function orchestratorPackages(files: Readonly<Record<string, string>>): PackageFolder[] {
  const folders = new Map<string, Record<string, string>>();
  for (const [path, body] of Object.entries(files)) {
    const m = /^(?:.*\/)?([^/]+)\.package\/(.+)$/.exec(path);
    if (!m) continue;
    const folder = folders.get(m[1]!) ?? {};
    folder[m[2]!] = body;
    folders.set(m[1]!, folder);
  }
  const out: PackageFolder[] = [];
  for (const [name, folder] of folders) {
    let version = '1.0.0';
    try {
      version = String((JSON.parse(folder['package.json'] ?? '{}') as { version?: string }).version ?? version);
    } catch {
      // readPackageSpec reports a broken package.json when the button is used.
    }
    out.push({ name, version, files: folder });
  }
  return out.sort((a, b) => (a.name === 'vcf.automation.core' ? -1 : b.name === 'vcf.automation.core' ? 1 : a.name.localeCompare(b.name)));
}

function packagePanel(packages: readonly PackageFolder[]): HTMLElement {
  // One button builds and downloads every package, core library first.
  const build = async (button: HTMLButtonElement) => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Building…';
    try {
      for (const pkg of packages) {
        const bytes = await buildVroPackage(readPackageSpec(pkg.files));
        downloadFile(`${pkg.name}-${pkg.version}.package`, bytes, 'application/octet-stream');
      }
      button.textContent = label;
    } catch (error) {
      button.textContent = `Could not build: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      button.disabled = false;
    }
  };
  return el(
    'div',
    { class: 'callout', style: { marginBottom: 'var(--space-3)' } },
    el('strong', { text: 'Import into VCF Automation' }),
    el('p', {
      text: 'Build the package, then import it: VCF Automation → Orchestrate tab (All Apps organization) or Orchestrator tab (VM Apps organization) → Assets → Packages → Import. Trust the publisher certificate when asked. Then fill the settings (Assets → Configurations) and run the workflow once as a dry run — IMPORT.md, in the zip, has every step.',
    }),
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary',
        text: 'Build package',
        on: { click: (event: Event) => void build(event.currentTarget as HTMLButtonElement) },
      }),
    ),
  );
}

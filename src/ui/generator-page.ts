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
import { card, findingsList } from './components.ts';
import { getTarget, setTarget, type TargetId } from '../kit/target.ts';
import { estateOptionsFor } from '../kit/estate.ts';
import {
  defaultValues,
  isVisible,
  blueprintsFor,
  type Blueprint,
  type BlueprintGroup,
  type BlueprintInput,
  type BlueprintValues,
  type BuildResult,
  type SelectOption,
} from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { fileBar } from './file-bar.ts';
import { envelope, openEnvelope, SETTINGS_KINDS, stripSecrets } from '../kit/settings-file.ts';
import { isRecord, type Json } from '../editor/doc.ts';
import type { StackBuild, StackItem, StackReference } from '../terraform/stack.ts';

export interface GeneratorOptions {
  readonly groups: readonly BlueprintGroup[];
  /** "Terraform (HCL)" or "Ansible" — used in labels and the status line. */
  readonly kindLabel: string;
  /** What to call the thing being built, e.g. "blueprint" or "playbook". */
  readonly noun: string;
  /** Shown under step 3 before anything is generated. */
  readonly idleHint: string;
  /** Extension for the combined download. */
  readonly downloadExtension: string;
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
 * The input, with anything the imported estate can answer folded in.
 *
 * A blueprint cannot know your datastore names, but the inventory does. Where
 * it has an answer the field becomes a dropdown you can still type into, so an
 * estate that was imported after the blueprint was written is still offered.
 */
function withEstate(input: BlueprintInput, target: string): BlueprintInput {
  const estate = estateOptionsFor(target, input.id);
  if (!estate) return input;
  const existing = (input.options ?? []).map((o) => o.value);
  const added = estate.values.filter((v) => !existing.includes(v));
  if (added.length === 0) return input;
  return {
    ...input,
    control: 'combo',
    hint: input.hint ? `${input.hint} · from ${estate.origin}` : `From ${estate.origin}`,
    options: [...added.map((value) => ({ value, label: value })), ...(input.options ?? [])],
  };
}

/**
 * Fills a `<select>`, opening an `<optgroup>` whenever the group changes.
 *
 * The long sets carry a group on every option and arrive already sorted into
 * them, so following the changes in order is enough — no regrouping, and an
 * ungrouped set costs nothing.
 */
function fillOptions(
  select: HTMLSelectElement,
  options: readonly SelectOption[],
  selected: string,
): void {
  let group: HTMLOptGroupElement | null = null;
  let groupName: string | undefined;
  for (const option of options) {
    const opt = el('option', { text: option.label, attrs: { value: option.value } });
    if (option.value === selected) (opt as HTMLOptionElement).selected = true;
    if (option.group !== groupName) {
      groupName = option.group;
      group =
        groupName === undefined
          ? null
          : (el('optgroup', { attrs: { label: groupName } }) as HTMLOptGroupElement);
      if (group) select.appendChild(group);
    }
    (group ?? select).appendChild(opt);
  }
}

/**
 * The options, led by an empty one when the input says what empty means.
 *
 * On an optional module input, empty is "leave it to the module". Without an
 * empty option a dropdown cannot say that — and drawing it would quietly pick
 * its first entry and write it into the call.
 */
function withBlank(input: BlueprintInput): readonly SelectOption[] {
  const options = input.options ?? [];
  if (input.blankLabel === undefined || options.some((o) => o.value === '')) return options;
  return [{ value: '', label: input.blankLabel }, ...options];
}

function control(input: BlueprintInput, value: unknown, onChange: () => void): HTMLElement {
  if (input.control === 'select') {
    const node = el('select') as HTMLSelectElement;
    fillOptions(node, withBlank(input), String(value ?? ''));
    node.addEventListener('change', onChange);
    return node;
  }

  if (input.control === 'toggle') {
    // A yes/no is a two-option dropdown rather than a checkbox, so it reads the
    // same way as every other choice on the form and carries its own labels.
    const node = el('select') as HTMLSelectElement;
    for (const option of [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]) {
      const opt = el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === String(value)) (opt as HTMLOptionElement).selected = true;
      node.appendChild(opt);
    }
    node.addEventListener('change', onChange);
    return node;
  }

  if (input.control === 'combo') {
    /*
     * A real dropdown, with a way out.
     *
     * This was a datalist first, which was a mistake: a datalist shows no arrow
     * and no list until you type into it, so a field with thirteen machine
     * types in it looked exactly like an empty text box. A select shows what is
     * on offer without being asked.
     *
     * The last entry swaps in a text box, because these sets are the common
     * answers rather than the only ones — a machine type the list has not heard
     * of still has to be typeable.
     */
    const CUSTOM = '__custom__';
    const options = withBlank(input);
    const current = String(value ?? '');
    const known = options.some((o) => o.value === current);

    const select = el('select') as HTMLSelectElement;
    fillOptions(select, options, current);
    const customOption = el('option', {
      text: 'Other — type a value…',
      attrs: { value: CUSTOM },
    }) as HTMLOptionElement;
    if (!known && current !== '') customOption.selected = true;
    select.appendChild(customOption);

    const custom = el('input', {
      attrs: { type: 'text', placeholder: input.placeholder ?? 'Type a value' },
    }) as HTMLInputElement;
    custom.value = known ? '' : current;
    custom.style.display = known || current === '' ? 'none' : '';
    custom.style.marginTop = 'var(--space-2)';

    const wrap = el('div', { class: 'combo' }, select, custom);

    select.addEventListener('change', () => {
      const picked = select.value === CUSTOM;
      custom.style.display = picked ? '' : 'none';
      if (picked) custom.focus();
      onChange();
    });
    custom.addEventListener('input', onChange);
    return wrap;
  }

  if (input.control === 'textarea') {
    const node = el('textarea', {
      attrs: {
        rows: String(Math.min(8, Math.max(3, (input.placeholder ?? '').split('\n').length))),
        spellcheck: 'false',
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      },
    }) as HTMLTextAreaElement;
    node.value = String(value ?? '');
    node.addEventListener('input', onChange);
    return node;
  }

  const node = el('input', {
    attrs: {
      type: input.control === 'number' ? 'number' : 'text',
      ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      ...(input.min !== undefined ? { min: String(input.min) } : {}),
      ...(input.max !== undefined ? { max: String(input.max) } : {}),
    },
  }) as HTMLInputElement;
  node.value = String(value ?? '');
  node.addEventListener('input', onChange);
  return node;
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

/** Label on the left, hint on the right, control underneath. */
function labelledField(input: BlueprintInput, node: HTMLElement): HTMLElement {
  return el(
    'div',
    {
      class: 'field',
      attrs: { 'data-search': `${input.id} ${input.label} ${input.help ?? ''}`.toLowerCase() },
    },
    el(
      'div',
      { class: 'field-head' },
      el('label', { text: input.label }),
      input.hint ? el('span', { class: 'field-hint', text: input.hint, attrs: { title: input.hint } }) : null,
    ),
    node,
    input.help ? el('div', { class: 'field-help', text: input.help }) : null,
  );
}

/**
 * A collapsed section of optional inputs, with a filter.
 *
 * A module can take two hundred inputs. Laid out flat they would bury the
 * dozen that matter; hidden they would make the kit look like it only knew a
 * dozen. So they are here, closed until opened, and searchable by name or by
 * what the description says.
 */
function inputSection(title: string, fields: readonly HTMLElement[], touched: number): HTMLElement {
  const filter = el('input', {
    attrs: { type: 'search', placeholder: `Filter ${fields.length} inputs by name or description` },
  }) as HTMLInputElement;
  const list = el('div', { class: 'input-section-list' }, ...fields);
  const count = el('span', { class: 'muted', text: '' });

  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const field of fields) {
      const hit = q === '' || (field.getAttribute('data-search') ?? '').includes(q);
      field.style.display = hit ? '' : 'none';
      if (hit) shown += 1;
    }
    count.textContent = q === '' ? '' : `${shown} match${shown === 1 ? '' : 'es'}`;
  });

  const summary = el(
    'summary',
    {},
    el('span', { text: title }),
    touched > 0 ? el('span', { class: 'pill', text: `${touched} set` }) : null,
  );
  return el(
    'details',
    { class: 'input-section' },
    summary,
    el('div', { class: 'input-section-filter' }, filter, count),
    list,
  );
}

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
  const buildList = el('div', { class: 'stack' });
  const stepTwo = el('div', { class: 'stack' });
  const stepThree = el('div', { class: 'stack' });

  append(root, buildList);
  append(
    root,
    fileBar({
      noun: `the ${options.noun} and its parameters`,
      fileName: () => `${String(values.__name ?? '').trim() || blueprint?.id || options.noun}-settings`,
      header: () => [
        `ArchToolKit ${options.kindLabel} settings: ${blueprint?.label ?? ''}`,
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
        const known = new Set(['__name', ...next.inputs.map((i) => i.id)]);
        const ignored = Object.keys(loaded).filter((k) => !known.has(k));
        const kept: BlueprintValues = {};
        for (const [k, v] of Object.entries(loaded)) if (known.has(k)) (kept as Record<string, unknown>)[k] = v;
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
    el(
      'div',
      { class: 'generator-grid' },
      el('div', {}, stepOne),
      el('div', {}, stepTwo),
      el('div', {}, stepThree),
    ),
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

  function selectBlueprint(next: Blueprint | undefined): void {
    blueprint = next;
    values = next ? defaultValues(next) : {};
    generated = null;
    builds = undefined;
    findings = [];
  }

  function generate(): void {
    if (!blueprint) return;
    const name = String(values.__name ?? '').trim();
    try {
      const out = blueprint.build(values, name);
      generated = out.files;
      builds = out.builds;
      findings = [...(out.findings ?? []), ...(options.standingFindings?.() ?? [])];
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
    const result = options.stack.build(stackItems, blueprintById, { target, stackName: stackName.value.trim() || undefined });
    generated = result.files;
    builds = undefined;
    findings = [...result.findings, ...(options.standingFindings?.() ?? [])];
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
            hint: `What ${options.kindLabel} should build`,
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
  function renderTwo(): void {
    if (!blueprint) {
      replace(stepTwo, card('Step 2 — Parameters', el('p', { text: 'Choose something to build.' })));
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

    const sectioned = new Map<string, HTMLElement[]>();
    const touchedIn = new Map<string, number>();

    for (const raw of blueprint.inputs) {
      if (!isVisible(raw, values)) continue;
      const input = withEstate(raw, target);
      const node = control(input, values[input.id], () => {
        let raw: string;
        if (node.classList.contains('combo')) {
          const picker = node.querySelector('select') as HTMLSelectElement;
          const typed = node.querySelector('input') as HTMLInputElement;
          raw = picker.value === '__custom__' ? typed.value : picker.value;
        } else {
          raw = (node as HTMLInputElement | HTMLSelectElement).value;
        }
        values = { ...values, [input.id]: raw };
        // A follow-up question may have appeared or gone away.
        if (blueprint?.inputs.some((i) => i.showWhen?.input === input.id)) renderTwo();
      });
      const setValue = (text: string) => {
        const box = (node.classList.contains('combo') ? node.querySelector('input') : node) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!box) return;
        if (node.classList.contains('combo')) {
          const picker = node.querySelector('select') as HTMLSelectElement;
          picker.value = '__custom__';
          (box as HTMLInputElement).style.display = '';
        }
        box.value = text;
        box.dispatchEvent(new Event('input'));
        box.focus();
      };
      const reference =
        input.control === 'select' || input.control === 'toggle' ? null : referenceButton(setValue);
      const field = labelledField(input, reference ? el('div', { class: 'with-ref' }, node, reference) : node);
      if (input.section === undefined) {
        fields.push(field);
      } else {
        const list = sectioned.get(input.section) ?? [];
        list.push(field);
        sectioned.set(input.section, list);
        if (String(values[input.id] ?? '') !== '') {
          touchedIn.set(input.section, (touchedIn.get(input.section) ?? 0) + 1);
        }
      }
    }

    for (const [title, list] of sectioned) {
      fields.push(inputSection(title, list, touchedIn.get(title) ?? 0));
    }

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
            text: `Generate ${options.kindLabel}`,
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
      for (const [filename, body] of Object.entries(generated)) {
        children.push(
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
            ),
          ),
          el('pre', { class: 'mono code-block' }, body),
        );
      }

      if (builds && builds.length > 0) children.push(buildsPanel(builds));

      if (Object.keys(generated).length > 1) {
        const all = generated;
        children.push(
          el(
            'div',
            { class: 'btn-row', style: { marginTop: 'var(--space-3)' } },
            el('button', {
              class: 'btn',
              text: 'Download all as one file',
              on: {
                click: () =>
                  downloadFile(
                    `${String(values.__name ?? blueprint?.id ?? 'generated')}${options.downloadExtension}`,
                    Object.entries(all)
                      .map(([n, b]) => `# ===== ${n} =====\n${b}`)
                      .join('\n'),
                    'text/plain',
                  ),
              },
            }),
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
        `Step 3 — Generated ${options.kindLabel}`,
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

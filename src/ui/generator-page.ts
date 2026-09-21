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
  // Declared above everything that can reach them: a `let` below the code that
  // uses it left a page dead on arrival once already, and neither the tests nor
  // the typechecker noticed.
  let target: TargetId = (getTarget()?.target ?? options.groups[0]?.target ?? 'aws') as TargetId;
  let blueprint: Blueprint | undefined;
  let values: BlueprintValues = {};
  let generated: Readonly<Record<string, string>> | null = null;
  let builds: BuildResult['builds'] = undefined;
  let findings: readonly Finding[] = [];

  const stepOne = el('div', { class: 'stack' });
  const stepTwo = el('div', { class: 'stack' });
  const stepThree = el('div', { class: 'stack' });

  append(
    root,
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
  if (getTarget() === null) setTarget(target, 'chosen on this page');

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
      setTarget(target, 'chosen on this page');
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
          { id: 'platform', label: 'Platform', control: 'select', hint: 'Chosen once, used everywhere' },
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
        origin
          ? el('div', { class: 'section-note', text: `Platform ${origin}.` })
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
        { id: '__name', label: 'Module / file label', control: 'text', hint: 'Optional' },
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
      const field = labelledField(input, node);
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
            on: { click: generate },
          }),
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
    );
  }

  selectBlueprint(first());
  renderOne();
  renderTwo();
  renderThree();
}

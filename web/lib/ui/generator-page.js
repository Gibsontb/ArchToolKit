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

import { el, append, replace, clear, downloadFile } from './dom.js';
import { card, findingsList } from './components.js';
import { getTarget, setTarget,               } from '../kit/target.js';
import { estateOptionsFor } from '../kit/estate.js';
import {
  defaultValues,
  isVisible,
  blueprintsFor,
                 
                      
                      
                       
} from '../kit/blueprint.js';
                                                   

                                   
                                             
                                                                             
                             
                                                                            
                        
                                                         
                            
                                             
                                     
                                                      
                                                       
 

/**
 * The input, with anything the imported estate can answer folded in.
 *
 * A blueprint cannot know your datastore names, but the inventory does. Where
 * it has an answer the field becomes a dropdown you can still type into, so an
 * estate that was imported after the blueprint was written is still offered.
 */
function withEstate(input                , target        )                 {
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

function control(input                , value         , onChange            )              {
  if (input.control === 'select') {
    const node = el('select')                     ;
    for (const option of input.options ?? []) {
      const opt = el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === String(value)) (opt                     ).selected = true;
      node.appendChild(opt);
    }
    node.addEventListener('change', onChange);
    return node;
  }

  if (input.control === 'toggle') {
    // A yes/no is a two-option dropdown rather than a checkbox, so it reads the
    // same way as every other choice on the form and carries its own labels.
    const node = el('select')                     ;
    for (const option of [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]) {
      const opt = el('option', { text: option.label, attrs: { value: option.value } });
      if (option.value === String(value)) (opt                     ).selected = true;
      node.appendChild(opt);
    }
    node.addEventListener('change', onChange);
    return node;
  }

  if (input.control === 'combo') {
    // A native datalist: the field shows a dropdown of the usual answers and
    // still accepts anything, which is what a long or partly-private list
    // needs. No dependency and no custom widget to get wrong.
    const listId = `dl-${input.id}`;
    const node = el('input', {
      attrs: {
        type: 'text',
        list: listId,
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
      },
    })                    ;
    node.value = String(value ?? '');
    node.addEventListener('input', onChange);
    const list = el('datalist', { attrs: { id: listId } });
    for (const option of input.options ?? []) {
      list.appendChild(el('option', { attrs: { value: option.value } }));
    }
    return el('div', { class: 'combo' }, node, list);
  }

  if (input.control === 'textarea') {
    const node = el('textarea', { attrs: { rows: '4' } })                       ;
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
  })                    ;
  node.value = String(value ?? '');
  node.addEventListener('input', onChange);
  return node;
}

/** Label on the left, hint on the right, control underneath. */
function labelledField(input                , node             )              {
  return el(
    'div',
    { class: 'field' },
    el(
      'div',
      { class: 'field-head' },
      el('label', { text: input.label }),
      input.hint ? el('span', { class: 'field-hint', text: input.hint }) : null,
    ),
    node,
  );
}

export function mountGeneratorPage(root             , options                  )       {
  // Declared above everything that can reach them: a `let` below the code that
  // uses it left a page dead on arrival once already, and neither the tests nor
  // the typechecker noticed.
  let target           = (getTarget()?.target ?? options.groups[0]?.target ?? 'aws')            ;
  let blueprint                       ;
  let values                  = {};
  let generated                                          = null;
  let findings                     = [];

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

  function available()                       {
    return blueprintsFor(options.groups, target);
  }

  function selectBlueprint(next                       )       {
    blueprint = next;
    values = next ? defaultValues(next) : {};
    generated = null;
    findings = [];
  }

  function generate()       {
    if (!blueprint) return;
    const name = String(values.__name ?? '').trim();
    try {
      const out = blueprint.build(values, name);
      generated = out.files;
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
  function renderOne()       {
    const platform = el('select')                     ;
    for (const group of options.groups) {
      const opt = el('option', { text: group.label, attrs: { value: group.target } });
      if (group.target === target) (opt                     ).selected = true;
      platform.appendChild(opt);
    }
    platform.addEventListener('change', () => {
      target = platform.value            ;
      setTarget(target, 'chosen on this page');
      selectBlueprint(available()[0]);
      renderOne();
      renderTwo();
      renderThree();
    });

    const list = el('select')                     ;
    for (const item of available()) {
      const opt = el('option', { text: item.label, attrs: { value: item.id } });
      if (item.id === blueprint?.id) (opt                     ).selected = true;
      list.appendChild(opt);
    }
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
  function renderTwo()       {
    if (!blueprint) {
      replace(stepTwo, card('Step 2 — Parameters', el('p', { text: 'Choose something to build.' })));
      return;
    }

    const fields                = [];

    const nameInput = el('input', {
      attrs: { type: 'text', placeholder: 'Used in comments, tags and the filename' },
    })                    ;
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

    for (const raw of blueprint.inputs) {
      if (!isVisible(raw, values)) continue;
      const input = withEstate(raw, target);
      const node = control(input, values[input.id], () => {
        const field = (node.classList.contains('combo')
          ? node.querySelector('input')
          : node)                                        ;
        const raw = field.value;
        values = { ...values, [input.id]: raw };
        // A follow-up question may have appeared or gone away.
        if (blueprint?.inputs.some((i) => i.showWhen?.input === input.id)) renderTwo();
      });
      fields.push(labelledField(input, node));
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
  function renderThree()       {
    const children                = [];

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
                  click: (event       ) => {
                    const button = event.currentTarget                     ;
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

  selectBlueprint(available()[0]);
  renderOne();
  renderTwo();
  renderThree();
}

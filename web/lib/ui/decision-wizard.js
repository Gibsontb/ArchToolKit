/**
 * The Multi-Cloud Decision & Onboarding Wizard, as a reusable mount.
 *
 * The layout and the interaction are the original's: one cloud chosen at the
 * top ("Currently designing for Microsoft Azure"), a left card that walks the
 * steps ("Step N · Title", "Step N of M", the questions two to a row with a
 * hint under each, Back / Next, Finish on the last step), and a right card
 * with the recommendation for THAT cloud ("<Provider> recommendation · Based
 * on your answers so far"): the answer pills, Generate recommendation, Full
 * view, Print and Save as Word, and the service cards, each a bold one-line
 * recommendation with notes. The recommendation updates as you answer.
 *
 * The engine (../multicloud/wizard/engine.js) reads the answers out of the
 * page by element id, so ONLY ONE wizard can be mounted on a page at a time:
 * mounting another while the first is still on the page throws, and a
 * wizard whose root has left the page is unmounted by the next mount.
 *
 * The host passes the answers in and hears every change (`onChange`), the
 * cloud switch (`onCloud`) and the step (`onStep`); it can put content under
 * a step's questions (`stepExtras`) and fill the sections the engine does not
 * write (`onRecommendation`: the `*Plan` blocks under the engine's cards and
 * the Migration path, Connectivity, Licensing and What gets built cards).
 * Those are inside the results, so Full view, Print and Word carry them.
 */

import { el, append, clear } from './dom.js';
import {
  WIZARD_CLOUDS, WIZARD_PROVIDER, WIZARD_STEPS, isField, stepsFor,
                                                     
} from '../multicloud/wizard/steps.js';
import { optionLabel, stepWording } from '../multicloud/wizard/wording.js';
import {
  clearErrors, exportRecommendationAsWord, generateRecommendation, openFullViewWindow, openPrintView, readWizardAnswers,
  setCurrentCloud, setCurrentStep, stateFromAnswers, validateStep,
                                       
} from '../multicloud/wizard/engine.js';

                                                                                 

/** A section of the recommendation: its heading and the element ids the engine (or the host) writes. */
                                
                       
                         
                        
                          
                          
                                                                                    
                         
 

/**
 * The sections, in order. The engine writes `main` / `notes` / `extra` of the
 * original cards; `plan` blocks and the cards with no engine text
 * (Migration path, Connectivity, Licensing, What gets built) are the host's.
 */
export const RESULT_SECTIONS                           = [
  { key: 'compute', title: 'Compute pattern', main: 'computeMain', notes: 'computeNotes', plan: 'computePlan' },
  { key: 'data', title: 'Data & storage', main: 'dataMain', notes: 'dataNotes', plan: 'dataPlan' },
  { key: 'integration', title: 'Integration & messaging', main: 'integrationMain', notes: 'integrationNotes', plan: 'integrationPlan' },
  { key: 'ops', title: 'Ops, resilience & governance', main: 'opsMain', notes: 'opsNotes', plan: 'opsPlan' },
  { key: 'security', title: 'Security & network controls', main: 'securityMain', notes: 'securityNotes', plan: 'securityPlan' },
  { key: 'controls', title: 'Controls & cyber checklist', main: 'controlsMain' },
  { key: 'migration', title: 'Migration & onboarding focus', main: 'migrationMain', notes: 'migrationNotes', plan: 'migrationPlan' },
  { key: 'paths', title: 'Migration path per server / database', main: 'pathsMain' },
  { key: 'connectivity', title: 'Connectivity & cross-cloud connectors', main: 'connectivityMain', plan: 'connectivityPlan' },
  { key: 'licensing', title: 'Licensing', main: 'licensingMain' },
  { key: 'dr', title: 'DR pattern by cloud', main: 'drPatternMain', plan: 'drPlan' },
  { key: 'assumptions', title: 'Assumptions & gaps', main: 'assumptionsMain', plan: 'assumptionsPlan' },
  { key: 'sizing', title: 'Sizing & environment footprint', main: 'sizingMain', notes: 'sizingNotes', extra: 'sizingMatrix', plan: 'sizingPlan' },
  { key: 'built', title: 'What gets built', main: 'builtMain' },
  { key: 'playbook', title: 'Implementation playbook · copy into Word', main: 'howToMain', notes: 'howToNotes' },
];

                                        
                                                              
                         
                                                                             
                                  
                                                                                         
                                           
                                        
                          
                                                                                                   
                            
                                                               
                                            
                                                          
                         
                                            
                                      
                                                                                     
                          
                                                                                              
                                                                           
                                                                                                             
                                
                              
                                                                                                         
                                                                                                        
 

                                       
                             
                                                
                                               
                 
                           
                                        
                     
                                         
                  
 

let mounted                                                             = null;

/** The wizard mounted on this page, if any. */
export function mountedWizard()                              {
  return mounted && mounted.root.isConnected ? mounted.handle : null;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function fieldControl(field             )              {
  const marker = { 'data-wizard-field': field.id };
  if (field.control === 'select') {
    const node = el('select', { attrs: { id: field.id, ...marker } })                     ;
    // The original opens on an empty "Select..." so an unanswered question is
    // visibly unanswered rather than silently defaulted to the first option.
    node.appendChild(el('option', { text: 'Select...', attrs: { value: '' } }));
    for (const option of field.options ?? []) node.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
    return node;
  }
  if (field.control === 'multiselect') {
    const node = el('select', { attrs: { id: field.id, multiple: 'multiple', size: '4', ...marker } })                     ;
    for (const option of field.options ?? []) node.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
    return node;
  }
  if (field.control === 'checkboxes') {
    // Several answers can be true at once, so these share a name rather than
    // carrying ids; the engine reads them with getCheckedValues(name).
    return el('div', { class: 'checkbox-group', attrs: { ...marker, role: 'group', 'aria-label': field.label } },
      ...(field.options ?? []).map((option) =>
        el('label', { class: 'checkbox' },
          el('input', { attrs: { type: 'checkbox', name: field.id, value: option.value } }),
          el('span', { text: option.label }))));
  }
  if (field.control === 'textarea') {
    return el('textarea', { attrs: { id: field.id, rows: '3', ...marker, ...(field.placeholder ? { placeholder: field.placeholder } : {}) } });
  }
  return el('input', {
    attrs: { id: field.id, type: field.control === 'number' ? 'number' : 'text', ...marker, ...(field.placeholder ? { placeholder: field.placeholder } : {}) },
  });
}

function fieldBlock(field             )              {
  return el('div', { class: 'field', attrs: { 'data-field-block': field.id } },
    el('div', { class: 'field-head' },
      el('label', field.control === 'checkboxes' ? {} : { attrs: { for: field.id } },
        field.label,
        field.required ? el('span', { class: 'required', text: ' *' }) : null),
      el('span', { class: 'field-source', attrs: { 'data-source-for': field.id }, text: '' })),
    fieldControl(field),
    field.hint ? el('div', { class: 'field-hint', text: field.hint }) : null);
}

/** A question, or a sub-heading (which takes a grid cell of its own, as in the original). */
function itemBlock(item            )              {
  return item.kind === 'heading' ? el('div', { class: 'field-group-title', text: item.text }) : fieldBlock(item);
}

function stepBlock(step            )              {
  const groups = (step.groups ?? []).map((group) =>
    el('div', { class: 'path-group field-grid', attrs: { id: group.id, 'data-show-for': group.showFor } },
      el('div', { class: 'field-group-title', style: { gridColumn: '1 / -1', paddingBottom: '0' } },
        'Path details (depends on initiative type)',
        el('div', { class: 'field-hint', text: 'Refine what kind of initiative this is. Change Step 1 to switch paths.' })),
      ...group.items.map(itemBlock)));
  return el('div', { class: 'wizard-step', attrs: { id: `step-${step.number}`, 'data-step': step.number } },
    ...groups,
    step.items.length > 0 ? el('div', { class: 'field-grid' }, ...step.items.map(itemBlock)) : null,
    el('div', { class: 'wizard-step-extra', attrs: { 'data-step-extra': step.number } }),
    el('div', { class: 'error', attrs: { id: `error-step-${step.number}`, role: 'status' } }));
}

function resultSection(section               )              {
  return el('div', { class: 'result-section', attrs: { 'data-section': section.key } },
    el('h3', { text: section.title, attrs: { 'data-section-title': section.key } }),
    el('div', { class: 'result-main', attrs: { id: section.main } }),
    section.notes ? el('div', { class: 'result-notes', attrs: { id: section.notes } }) : null,
    section.extra ? el('div', { attrs: { id: section.extra } }) : null,
    section.plan ? el('div', { class: 'result-plan', attrs: { id: section.plan } }) : null);
}

/** Put answers into the page's controls. */
function writeAnswers(scope             , answers               )       {
  for (const field of WIZARD_STEPS.flatMap((s) => [...s.items, ...(s.groups ?? []).flatMap((g) => g.items)]).filter(isField)) {
    const value = answers[field.id];
    if (field.control === 'checkboxes') {
      const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
      for (const box of scope.querySelectorAll                  (`input[name="${field.id}"]`)) box.checked = list.includes(box.value);
      continue;
    }
    const node = scope.querySelector                                                            (`#${field.id}`);
    if (!node) continue;
    const text = Array.isArray(value) ? String(value[0] ?? '') : value === undefined ? '' : String(value);
    if (node instanceof HTMLSelectElement && text && ![...node.options].some((o) => o.value === text)) continue;
    node.value = text;
  }
}

// ---------------------------------------------------------------------------
// The mount
// ---------------------------------------------------------------------------

export function mountDecisionWizard(root             , options                       )                       {
  if (mounted && mounted.root.isConnected && mounted.root !== root) {
    throw new Error('A decision wizard is already on this page: its engine reads the answers by element id, so only one can be mounted at a time.');
  }
  if (mounted) mounted.handle.destroy();

  const live = options.live !== false;
  let step = WIZARD_STEPS.some((s) => s.number === options.step) ? (options.step          ) : 1;
  let cloud = options.cloud;
  let generated = false;
  let timer                                           ;
  const built = new Set        ();
  const prefilled = new Set(options.prefilled ?? []);
  const touched = new Set        ();

  const clouds = WIZARD_CLOUDS.filter((c) => !options.clouds || options.clouds.includes(c.value));
  const cloudPicker = el('select', { attrs: { id: 'cloudProvider', 'aria-label': 'Cloud', 'data-control': 'wizard-cloud' } })                     ;
  for (const c of clouds) cloudPicker.appendChild(el('option', { text: c.label, attrs: { value: c.value } }));
  cloudPicker.value = cloud;

  const designingFor = el('strong', { attrs: { 'data-control': 'wizard-designing-for' } });
  const header = el('div', { class: 'wizard-header', attrs: { 'data-control': 'wizard-header' } },
    el('div', { class: 'wizard-header-title' },
      el('h2', { text: options.title ?? 'Multi-Cloud Decision & Onboarding Wizard' }),
      el('p', { class: 'muted' }, options.subject ? `Designing ${options.subject}, currently for ` : 'Currently designing for ', designingFor, '.')),
    el('div', { class: 'wizard-header-controls' },
      options.headerExtra ?? null,
      el('label', { class: 'cloud-picker' }, el('span', { class: 'cloud-picker-label', text: 'Cloud:' }), cloudPicker)));

  const title = el('h2', { attrs: { id: 'step-title' } });
  const subtitle = el('p', { class: 'muted', attrs: { id: 'step-subtitle' } });
  const counter = el('span', { class: 'step-counter', attrs: { id: 'step-counter' } });
  const miniHint = el('div', { class: 'section-note', attrs: { id: 'mini-hint' } });
  const phaseLine = el('div', { class: 'wizard-phase', attrs: { 'data-control': 'wizard-phase' } });
  const pathLabel = el('span', { attrs: { id: 'path-label' } });
  const pathNote = el('div', { class: 'path-note' }, pathLabel);
  const backBtn = el('button', { class: 'btn', text: '← Back', attrs: { id: 'backBtn', type: 'button', 'data-control': 'wizard-back' } })                     ;
  const nextBtn = el('button', { class: 'btn btn-primary', text: 'Next →', attrs: { id: 'nextBtn', type: 'button', 'data-control': 'wizard-next' } })                     ;
  const stepDots = el('ol', { class: 'wizard-steps-list', attrs: { 'aria-label': 'Steps', 'data-control': 'wizard-steps' } });
  const stepsPane = el('div', {}, ...WIZARD_STEPS.map(stepBlock));

  const summaryPills = el('div', { class: 'pill-row', attrs: { id: 'summaryPills' } });
  const resultsContent = el('div', { attrs: { id: 'resultsContent', 'data-control': 'wizard-results' }, style: { display: 'none' } }, ...RESULT_SECTIONS.map(resultSection));
  const recTitle = el('h2', { attrs: { id: 'cloudTitle' } });
  const recBadge = el('span', { class: 'badge wizard-badge', attrs: { id: 'cloudBadge' } });
  const recSubtitle = el('p', { class: 'muted', attrs: { id: 'cloudSubtitle' }, text: 'Based on your answers so far' });
  const fullViewBtn = el('button', { class: 'btn', text: 'Full view', attrs: { id: 'fullViewBtn', type: 'button', disabled: true, 'data-control': 'wizard-full-view' } })                     ;
  const printBtn = el('button', { class: 'btn', text: 'Print', attrs: { id: 'printBtn', type: 'button', disabled: true, 'data-control': 'wizard-print' } })                     ;
  const wordBtn = el('button', { class: 'btn', text: 'Save as Word', attrs: { id: 'exportWordBtn', type: 'button', disabled: true, 'data-control': 'wizard-word' } })                     ;
  const generateBtn = el('button', { class: 'btn btn-primary', text: 'Generate recommendation', attrs: { type: 'button', 'data-control': 'wizard-generate' } })                     ;
  const intro = el('div', { class: 'wizard-intro' },
    el('p', {}, 'Complete the steps and click ', el('strong', { text: 'Generate recommendation' }), ' (or ', el('strong', { text: 'Finish' }), ') to see suggested services, the migration path, the connectors and a full onboarding playbook for the selected cloud.'),
    el('div', { class: 'wizard-intro-row' },
      el('p', { class: 'small muted', text: 'You can tweak answers, change the cloud, and re-generate as many times as you like.' }),
      generateBtn));

  const wrapper = el('div', { class: 'decision-wizard', attrs: { 'data-control': 'decision-wizard' } },
    header,
    el('div', { class: 'wizard-grid' },
      el('section', { class: 'card wizard-questions', attrs: { 'data-control': 'wizard-questions' } },
        el('div', { class: 'card-title wizard-head' }, el('div', {}, title, subtitle, phaseLine), counter),
        stepDots,
        pathNote,
        stepsPane,
        el('div', { class: 'btn-row wizard-nav' }, miniHint, el('div', { class: 'btn-row' }, backBtn, nextBtn))),
      el('section', { class: 'card wizard-results', attrs: { 'data-control': 'wizard-recommendation' } },
        el('div', { class: 'card-title wizard-head' }, el('div', {}, recTitle, recSubtitle), recBadge),
        intro,
        summaryPills,
        el('div', { class: 'btn-row wizard-exports' }, fullViewBtn, printBtn, wordBtn),
        resultsContent)));
  clear(root);
  append(root, wrapper);

  writeAnswers(stepsPane, options.answers);

  const markSources = ()       => {
    for (const node of stepsPane.querySelectorAll             ('[data-source-for]')) {
      const id = node.getAttribute('data-source-for') ?? '';
      const fromPlan = prefilled.has(id) && !touched.has(id);
      node.textContent = fromPlan ? 'from the plan' : '';
      node.classList.toggle('is-from-plan', fromPlan);
    }
  };

  function applyCloud()       {
    setCurrentCloud(cloud);
    const label = WIZARD_CLOUDS.find((c) => c.value === cloud)?.label ?? cloud;
    const provider = WIZARD_PROVIDER[cloud] ?? label;
    designingFor.textContent = label;
    recTitle.textContent = `${provider} recommendation`;
    recBadge.textContent = provider;
    wrapper.setAttribute('data-cloud', cloud);
  }

  function updatePathGroups()       {
    const chosen = (stepsPane.querySelector                   ('#initiativeType'))?.value ?? '';
    const human                         = {
      'new-service': 'new service', 'existing-service': 'existing service change', maintenance: 'maintenance / operations', migration: 'migration',
    };
    pathLabel.textContent = chosen
      ? `Showing the questions for a ${human[chosen] ?? 'initiative'}.`
      : 'Pick an initiative type in step 1 to see its questions here.';
    for (const group of stepsPane.querySelectorAll             ('.path-group')) {
      group.classList.toggle('is-active', group.getAttribute('data-show-for') === chosen);
    }
  }

  const initiative = ()         => stepsPane.querySelector                   ('#initiativeType')?.value ?? '';
  const visible = ()                        => stepsFor(initiative());

  /** Relabel the options that the provider words its own way (the 7 Rs). */
  function relabel()       {
    for (const field of WIZARD_STEPS.flatMap((x) => [...x.items, ...(x.groups ?? []).flatMap((g) => g.items)]).filter(isField)) {
      const node = stepsPane.querySelector                   (`select#${field.id}`);
      if (!node) continue;
      for (const o of field.options ?? []) {
        const opt = [...node.options].find((x) => x.value === o.value);
        if (opt) opt.textContent = optionLabel(field.id, o.value, o.label, cloud);
      }
    }
  }

  function showStep(next        )       {
    const list = visible();
    step = list.some((x) => x.number === next) ? next : (list.find((x) => x.number > next) ?? list[list.length - 1] ?? list[0] ).number;
    const pos = list.findIndex((x) => x.number === step);
    setCurrentStep(step);
    for (const node of stepsPane.querySelectorAll             ('.wizard-step')) {
      node.classList.toggle('is-active', Number(node.getAttribute('data-step')) === step);
    }
    const current = list[pos]              ;
    const words = stepWording(current, cloud, initiative());
    title.textContent = `Step ${pos + 1} · ${words.title}`;
    subtitle.textContent = words.subtitle;
    phaseLine.textContent = words.phase;
    counter.textContent = `Step ${pos + 1} of ${list.length}`;
    miniHint.textContent = `Step ${pos + 1} · ${words.hint}`;
    pathNote.style.display = (current.groups ?? []).length > 0 ? '' : 'none';
    backBtn.disabled = pos === 0;
    nextBtn.textContent = pos === list.length - 1 ? 'Finish' : 'Next →';
    wrapper.setAttribute('data-step', String(step));
    clear(stepDots);
    list.forEach((s, i) => {
      const w = stepWording(s, cloud, initiative());
      const b = el('button', {
        class: s.number === step ? 'wizard-dot is-active' : 'wizard-dot',
        text: String(i + 1),
        attrs: { type: 'button', title: w.title, 'aria-label': `Step ${i + 1}: ${w.title}`, 'aria-current': s.number === step ? 'step' : undefined, 'data-step-dot': s.number },
      });
      b.addEventListener('click', () => { showStep(s.number); });
      stepDots.appendChild(el('li', {}, b));
    });
    if (!built.has(step)) {
      built.add(step);
      const make = options.stepExtras?.[step];
      const slot = stepsPane.querySelector             (`[data-step-extra="${step}"]`);
      if (make && slot) {
        try {
          const node = make();
          if (node) append(slot, node);
        } catch (e) {
          append(slot, el('div', { class: 'tip warn', text: `This part of the step could not be drawn: ${e instanceof Error ? e.message : String(e)}` }));
        }
      }
    }
    options.onStep?.(step);
  }

  /** Move by `delta` visible steps. */
  const move = (delta        )       => {
    const list = visible();
    const pos = list.findIndex((x) => x.number === step);
    const target = list[Math.min(list.length - 1, Math.max(0, pos + delta))];
    if (target) showStep(target.number);
  };

  const write = (id        , html        )       => {
    const node = resultsContent.querySelector             (`#${id}`);
    if (node) node.innerHTML = html;
  };

  function generate()       {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const state = generateRecommendation(stateFromAnswers(readWizardAnswers()));
    generated = true;
    intro.classList.add('is-generated');
    try {
      options.onRecommendation?.(state, cloud, write);
    } catch (e) {
      write('builtMain', `<p class="error">The plan-side cards could not be built: ${String(e instanceof Error ? e.message : e).replace(/</g, '&lt;')}</p>`);
    }
  }

  const schedule = ()       => {
    if (!live && !generated) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(generate, 250);
  };

  const onInput = (event       )       => {
    const target = event.target               ;
    const holder = target.closest             ('[data-wizard-field]') ?? (target.hasAttribute('data-wizard-field') ? target : null);
    const id = holder?.getAttribute('data-wizard-field') ?? (target                    ).name ?? '';
    if (!id) return;
    const answers = readWizardAnswers();
    touched.add(id);
    markSources();
    if (id === 'initiativeType') {
      updatePathGroups();
      showStep(step);
    }
    options.onChange?.(id, answers[id] ?? '', answers);
    schedule();
  };
  stepsPane.addEventListener('change', onInput);

  cloudPicker.addEventListener('change', () => {
    cloud = cloudPicker.value;
    applyCloud();
    relabel();
    showStep(step);
    options.onCloud?.(cloud);
    schedule();
  });
  nextBtn.addEventListener('click', () => {
    validateStep(step);
    const list = visible();
    if (list[list.length - 1]?.number === step) {
      generate();
      resultsContent.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      return;
    }
    move(1);
  });
  backBtn.addEventListener('click', () => { clearErrors(); move(-1); });
  generateBtn.addEventListener('click', generate);
  fullViewBtn.addEventListener('click', () => openFullViewWindow());
  printBtn.addEventListener('click', () => openPrintView());
  wordBtn.addEventListener('click', () => exportRecommendationAsWord());

  applyCloud();
  relabel();
  updatePathGroups();
  markSources();
  showStep(step);
  if (live) generate();

  const handle                       = {
    root,
    answers: () => readWizardAnswers(),
    step: () => step,
    goTo: (n) => showStep(n),
    regenerate: generate,
    destroy: () => {
      if (timer !== undefined) clearTimeout(timer);
      stepsPane.removeEventListener('change', onInput);
      wrapper.remove();
      if (mounted?.handle === handle) mounted = null;
    },
  };
  mounted = { root, handle };
  return handle;
}

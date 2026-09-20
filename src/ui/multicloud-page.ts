/**
 * Multi-Cloud Decision & Onboarding Wizard.
 *
 * The questions and the recommendation engine are the previous toolkit's, kept
 * as they were. This is the page around them, rebuilt so it belongs to the rest
 * of the toolkit: the same shell, the same cards and fields, the same header
 * and navigation.
 *
 * The cloud is chosen once, at the top, and drives three things: which services
 * the recommendation names, which of the four path groups step 2 asks about,
 * and — through the shared selection — which platform the Terraform and Ansible
 * generators open on. Choosing it here means not choosing it again there.
 *
 * The engine reads every answer out of the DOM by element id, so this renders
 * the inputs with the ids WIZARD_STEPS declares. That is the contract between
 * the two, and it is why the field list lives in one file rather than two.
 */

import { el, append, replace, must } from './dom.ts';
import { card } from './components.ts';
import { setTarget, type TargetId } from '../kit/target.ts';
import {
  WIZARD_STEPS,
  WIZARD_CLOUDS,
  WIZARD_CLOUD_TO_TARGET,
  type WizardField,
  type WizardItem,
  type WizardStep,
} from '../multicloud/wizard/steps.ts';
import {
  setCurrentCloud,
  setCurrentStep,
  validateStep,
  generateRecommendation,
  openFullViewWindow,
  openPrintView,
  exportRecommendationAsWord,
} from '../multicloud/wizard/engine.js';

function fieldControl(field: WizardField): HTMLElement {
  if (field.control === 'select') {
    const node = el('select', { attrs: { id: field.id } }) as HTMLSelectElement;
    // The originals open on an empty "Select..." so an unanswered question is
    // visibly unanswered rather than silently defaulted to the first option.
    node.appendChild(el('option', { text: 'Select...', attrs: { value: '' } }));
    for (const option of field.options ?? []) {
      node.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
    }
    return node;
  }

  if (field.control === 'multiselect') {
    // Several answers at once; the engine reads it with getMultiSelectValues.
    const node = el('select', { attrs: { id: field.id, multiple: 'multiple', size: '4' } }) as HTMLSelectElement;
    for (const option of field.options ?? []) {
      node.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
    }
    return node;
  }

  if (field.control === 'checkboxes') {
    // Several answers can be true at once, so these share a name rather than
    // carrying ids; the engine reads them with getCheckedValues(name).
    return el(
      'div',
      { class: 'checkbox-group' },
      ...(field.options ?? []).map((option) =>
        el(
          'label',
          { class: 'checkbox' },
          el('input', { attrs: { type: 'checkbox', name: field.id, value: option.value } }),
          el('span', { text: option.label }),
        ),
      ),
    );
  }

  if (field.control === 'textarea') {
    return el('textarea', {
      attrs: { id: field.id, rows: '3', ...(field.placeholder ? { placeholder: field.placeholder } : {}) },
    });
  }

  return el('input', {
    attrs: {
      id: field.id,
      type: field.control === 'number' ? 'number' : 'text',
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    },
  });
}

function fieldBlock(field: WizardField): HTMLElement {
  return el(
    'div',
    { class: 'field' },
    el(
      'div',
      { class: 'field-head' },
      el(
        'label',
        field.control === 'checkboxes' ? {} : { attrs: { for: field.id } },
        field.label,
        field.required ? el('span', { class: 'required', text: ' *' }) : null,
      ),
    ),
    fieldControl(field),
    field.hint ? el('div', { class: 'field-hint', text: field.hint }) : null,
  );
}

/**
 * One item: a question, or a sub-heading.
 *
 * A heading takes a grid cell of its own, exactly as it does in the original.
 * That is not cosmetic — it is what puts every question after it in the right
 * column.
 */
function itemBlock(item: WizardItem): HTMLElement {
  if (item.kind === 'heading') {
    return el('div', { class: 'field-group-title', text: item.text });
  }
  return fieldBlock(item);
}

function stepBlock(step: WizardStep): HTMLElement {
  const groups = (step.groups ?? []).map((group) =>
    el(
      'div',
      { class: 'path-group field-grid', attrs: { id: group.id, 'data-show-for': group.showFor } },
      ...group.items.map(itemBlock),
    ),
  );

  return el(
    'div',
    { class: 'wizard-step', attrs: { id: `step-${step.number}` } },
    el('div', { class: 'field-grid' }, ...step.items.map(itemBlock)),
    ...groups,
    el('div', { class: 'error', attrs: { id: `error-step-${step.number}` } }),
  );
}


/**
 * The recommendation's sections.
 *
 * The engine writes each piece into a named container, so these ids and this
 * order are the original's, not a choice. `notes` is the smaller print under
 * the main text; `extra` is the sizing matrix table.
 */
const RESULT_SECTIONS: readonly {
  readonly title: string;
  readonly main: string;
  readonly notes?: string;
  readonly extra?: string;
}[] = [
  { title: 'Compute pattern', main: 'computeMain', notes: 'computeNotes' },
  { title: 'Data & storage', main: 'dataMain', notes: 'dataNotes' },
  { title: 'Integration & messaging', main: 'integrationMain', notes: 'integrationNotes' },
  { title: 'Ops, resilience & governance', main: 'opsMain', notes: 'opsNotes' },
  { title: 'Security & network controls', main: 'securityMain', notes: 'securityNotes' },
  { title: 'Controls & cyber checklist', main: 'controlsMain' },
  { title: 'Migration & onboarding focus', main: 'migrationMain', notes: 'migrationNotes' },
  { title: 'DR pattern by cloud', main: 'drPatternMain' },
  { title: 'Assumptions & gaps', main: 'assumptionsMain' },
  { title: 'Sizing & environment footprint', main: 'sizingMain', notes: 'sizingNotes', extra: 'sizingMatrix' },
  { title: 'Implementation playbook · copy into Word', main: 'howToMain', notes: 'howToNotes' },
];

function resultSection(section: (typeof RESULT_SECTIONS)[number]): HTMLElement {
  return el(
    'div',
    { class: 'result-section' },
    el('h3', { text: section.title }),
    el('div', { attrs: { id: section.main } }),
    section.notes ? el('div', { class: 'result-notes', attrs: { id: section.notes } }) : null,
    section.extra ? el('div', { attrs: { id: section.extra } }) : null,
  );
}

export function mountMulticloudPage(root: HTMLElement): void {
  // Declared before anything that can reach them.
  let step = 1;

  const cloudPicker = el('select', { attrs: { id: 'cloudProvider' } }) as HTMLSelectElement;
  for (const cloud of WIZARD_CLOUDS) {
    cloudPicker.appendChild(el('option', { text: cloud.label, attrs: { value: cloud.value } }));
  }

  const title = el('h2', { attrs: { id: 'step-title' } });
  const subtitle = el('p', { class: 'muted', attrs: { id: 'step-subtitle' } });
  const counter = el('span', { class: 'step-counter', attrs: { id: 'step-counter' } });
  const miniHint = el('div', { class: 'section-note', attrs: { id: 'mini-hint' } });
  const pathLabel = el('span', { attrs: { id: 'path-label' } });
  // Only step 2 changes its questions by initiative type, so only step 2 says so.
  const pathNote = el('div', { class: 'path-note' }, pathLabel);

  const backBtn = el('button', { class: 'btn', text: '← Back', attrs: { id: 'backBtn' } });
  const nextBtn = el('button', { class: 'btn btn-primary', text: 'Next →', attrs: { id: 'nextBtn' } });

  const stepsPane = el('div', {}, ...WIZARD_STEPS.map(stepBlock));

  const summaryPills = el('div', { class: 'pill-row', attrs: { id: 'summaryPills' } });
  const resultsContent = el('div', { attrs: { id: 'resultsContent' }, style: { display: 'none' } });
  const emptyNote = el('p', {
    class: 'muted',
    text: 'Answer the four steps and press Generate recommendation to see the suggested services, migration path and onboarding playbook for the chosen cloud.',
  });
  const cloudTitle = el('h2', { attrs: { id: 'cloudTitle' } });
  const cloudBadge = el('span', { class: 'badge', attrs: { id: 'cloudBadge' } });
  const cloudSubtitle = el('p', { class: 'muted', attrs: { id: 'cloudSubtitle' } });

  const fullViewBtn = el('button', { class: 'btn', text: 'Full view', attrs: { id: 'fullViewBtn' } });
  const printBtn = el('button', { class: 'btn', text: 'Print', attrs: { id: 'printBtn' } });
  const wordBtn = el('button', { class: 'btn', text: 'Save as Word', attrs: { id: 'exportWordBtn' } });
  const generateBtn = el('button', { class: 'btn btn-primary', text: 'Generate recommendation' });

  append(
    root,
    el(
      'div',
      { class: 'wizard-grid' },
      el(
        'div',
        {},
        card(
          'Cloud',
          el(
            'div',
            { class: 'field' },
            el('div', { class: 'field-head' }, el('label', { text: 'Designing for' })),
            cloudPicker,
            el('div', {
              class: 'field-hint',
              text: 'Chosen once. It drives the services recommended here and the platform the generators open on.',
            }),
          ),
        ),
        el(
          'div',
          { class: 'card' },
          el(
            'div',
            { class: 'card-title wizard-head' },
            el('div', {}, title, subtitle),
            counter,
          ),
          pathNote,
          stepsPane,
          miniHint,
          el('div', { class: 'btn-row wizard-nav' }, backBtn, nextBtn),
        ),
      ),
      el(
        'div',
        {},
        el(
          'div',
          { class: 'card' },
          el('div', { class: 'card-title wizard-head' }, el('div', {}, cloudTitle, cloudSubtitle), cloudBadge),
          summaryPills,
          el('div', { class: 'btn-row' }, fullViewBtn, printBtn, wordBtn, generateBtn),
          emptyNote,
          resultsContent,
        ),
      ),
    ),
  );

  function showStep(next: number): void {
    step = Math.min(WIZARD_STEPS.length, Math.max(1, next));
    setCurrentStep(step);

    for (const definition of WIZARD_STEPS) {
      const node = must(`#step-${definition.number}`, stepsPane);
      node.classList.toggle('is-active', definition.number === step);
    }

    const current = WIZARD_STEPS[step - 1] as WizardStep;
    title.textContent = current.title;
    subtitle.textContent = current.subtitle;
    counter.textContent = `Step ${step} of ${WIZARD_STEPS.length}`;
    miniHint.textContent = `Step ${step} · ${current.hint}`;

    pathNote.style.display = step === 2 ? '' : 'none';
    (backBtn as HTMLButtonElement).disabled = step === 1;
    nextBtn.textContent = step === WIZARD_STEPS.length ? 'Finish' : 'Next →';
  }

  /**
   * Step 2 asks a different set of questions per initiative type, so only the
   * matching group is shown. Everything else stays in the DOM: the engine reads
   * answers by id, and hiding is not the same as removing.
   */
  function updatePathGroups(): void {
    const chosen = (document.getElementById('initiativeType') as HTMLSelectElement | null)?.value ?? '';
    const human: Record<string, string> = {
      'new-service': 'new service',
      'existing-service': 'existing service change',
      maintenance: 'maintenance / operations',
      migration: 'migration',
    };
    pathLabel.textContent = chosen
      ? `Showing the questions for a ${human[chosen] ?? 'initiative'}.`
      : 'Pick an initiative type in step 1 to see its questions here.';

    for (const definition of WIZARD_STEPS) {
      for (const group of definition.groups ?? []) {
        must(`#${group.id}`, stepsPane).classList.toggle('is-active', group.showFor === chosen);
      }
    }
  }

  function applyCloud(): void {
    const cloud = cloudPicker.value;
    setCurrentCloud(cloud);
    const label = WIZARD_CLOUDS.find((c) => c.value === cloud)?.label ?? cloud;
    cloudTitle.textContent = `${label} recommendation`;
    cloudBadge.textContent = label;
    cloudSubtitle.textContent = 'Based on your answers so far.';
    // The wizard is where the cloud is decided, so the generators learn it here
    // rather than asking a second time.
    const target = WIZARD_CLOUD_TO_TARGET[cloud];
    if (target) setTarget(target as TargetId, 'chosen in the decision wizard');
  }

  cloudPicker.addEventListener('change', applyCloud);

  stepsPane.addEventListener('change', (event) => {
    if ((event.target as HTMLElement).id === 'initiativeType') updatePathGroups();
  });

  nextBtn.addEventListener('click', () => {
    if (!validateStep(step)) return;
    if (step === WIZARD_STEPS.length) {
      generate();
      return;
    }
    showStep(step + 1);
  });
  backBtn.addEventListener('click', () => showStep(step - 1));
  function generate(): void {
    generateRecommendation();
    emptyNote.remove();
  }

  generateBtn.addEventListener('click', generate);
  fullViewBtn.addEventListener('click', () => openFullViewWindow());
  printBtn.addEventListener('click', () => openPrintView());
  wordBtn.addEventListener('click', () => exportRecommendationAsWord());

  // The engine fills these by id, so they exist from the start and the note
  // sits above them until there is something to show.
  append(resultsContent, ...RESULT_SECTIONS.map(resultSection));

  applyCloud();
  updatePathGroups();
  showStep(1);
}

const root = document.getElementById('multicloud-root');
if (root) mountMulticloudPage(root);

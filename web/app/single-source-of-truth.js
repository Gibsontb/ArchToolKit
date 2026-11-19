import { el, dropdown, textField, button, table, load, save, exportJson, exportCsv, jsonImport, platforms, today } from './workspace-controls.js';
import { offeringNames, offeringOptions } from './governance-offerings.js';
import { registryTools } from './registry-tools.js';
import { changedRecord, validateRegistryBackup } from './registry-operations.js';
import { downloadReport } from './workspace-reports.js';
import { card } from '../lib/ui/components.js';
import { loadInventory } from '../lib/kit/estate-store.js';
import { recordTypes, classifications, lifecycles, domains, validateRecord, recordIssues, registryIndex, inventoryRecords } from './registry-model.js';

const key = 'archtoolkit.registry.v1';
let records = load(key, []);
if (!Array.isArray(records) || !records.every(validateRecord)) records = [];
let index = registryIndex(records);
let editing = null;
let page = 0;
const pageSize = 50;
const root = document.getElementById('workspace-root');
const status = el('p', { attrs: { role: 'status' } });
const editor = el('div');
const output = el('div');
const selectedIds = new Set();
const actor = textField('Recorded by', load('archtoolkit.registry.actor.v1', ''));
actor.input.addEventListener('change', () => save('archtoolkit.registry.actor.v1', actor.input.value, status));
function commit(next) {
  records = next; editing = null;
  for (const id of selectedIds) if (!records.some(record => record.id === id)) selectedIds.delete(id);
  persist(); refreshOwners(); drawEditor(); render(); tools.refreshSelection(); tools.inspection.replaceChildren();
}
const tools = registryTools(() => records, commit, selectedIds, () => actor.input.value, status);
const search = textField('Search records');
const typeFilter = dropdown('Record type', ['', ...recordTypes]);
const ownerFilter = dropdown('Owner', ['']);
const domainFilter = dropdown('Domain', ['', ...domains]);
const platformFilter = dropdown('Platform', ['', ...platforms]);
const classFilter = dropdown('Classification', ['', ...classifications]);
const lifecycleFilter = dropdown('Lifecycle', ['', ...lifecycles]);
const issuesFilter = dropdown('Review findings', ['', 'With findings', 'Review overdue', 'Missing owner', 'Missing authoritative source', 'Possible duplicate name', 'Conflicting source systems', 'Dependency missing']);
const filters = el('div', { class: 'field-grid' }, ...[search, typeFilter, ownerFilter, domainFilter, platformFilter, classFilter, lifecycleFilter, issuesFilter].map(item => item.control));
const persist = () => { index = registryIndex(records); save(key, records, status); };
function refreshOwners() {
  const selected = ownerFilter.input.value;
  ownerFilter.input.replaceChildren(...['', ...new Set(records.map(record => record.owner).filter(Boolean))].sort().map(value => new Option(value || 'All owners', value)));
  ownerFilter.input.value = selected;
}
function matches(record) {
  const findings = recordIssues(record, index, today());
  return [record.id, record.name, record.owner, record.system, record.notes].join(' ').toLowerCase().includes(search.input.value.toLowerCase()) &&
    [[typeFilter, 'type'], [ownerFilter, 'owner'], [domainFilter, 'domain'], [platformFilter, 'platform'], [classFilter, 'classification'], [lifecycleFilter, 'lifecycle']].every(([filter, key]) => !filter.input.value || record[key] === filter.input.value) &&
    (!issuesFilter.input.value || (issuesFilter.input.value === 'With findings' ? findings.length > 0 : findings.includes(issuesFilter.input.value)));
}
function render() {
  const filtered = records.filter(matches);
  const maxPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  page = Math.min(page, maxPage);
  const rows = filtered.slice(page * pageSize, (page + 1) * pageSize).map(record => {
    const checkbox = el('input', { attrs: { type: 'checkbox', 'aria-label': 'Select record · ' + record.name } });
    checkbox.checked = selectedIds.has(record.id);
    checkbox.addEventListener('change', () => { checkbox.checked ? selectedIds.add(record.id) : selectedIds.delete(record.id); tools.refreshSelection(); });
    return [checkbox,
    el('div', {}, el('strong', { text: record.name }), el('p', { class: 'muted', text: record.id }), el('p', { text: record.type + ' · ' + record.domain })),
    el('div', {}, el('p', { text: record.owner || 'Unassigned' }), el('p', { text: record.system || 'Source unrecorded' }), el('p', { text: record.reference })),
    el('div', {}, el('p', { text: [record.platform, record.offering, record.region, record.environment].filter(Boolean).join(' · ') }), el('p', { text: record.classification + ' · ' + record.lifecycle })),
    el('div', {}, el('p', { text: record.review || 'No review date' }), el('p', { text: recordIssues(record, index, today()).join(' · ') || 'No findings' }), el('p', { text: record.dependencies.length + ' dependencies' })),
    el('div', { class: 'btn-row' },
      button('Edit', () => { editing = record.id; drawEditor(); editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }),
      button('History / impact', () => tools.inspect(record)),
      button('Merge / replace', () => tools.merge(record))),
  ]; });
  const previous = button('Previous', () => { page--; render(); });
  previous.disabled = page === 0;
  const next = button('Next', () => { page++; render(); });
  next.disabled = page === maxPage;
  output.replaceChildren(el('p', { text: filtered.length + ' matching / ' + records.length + ' total records · Page ' + (page + 1) + ' of ' + (maxPage + 1) }),
    filtered.length ? table(['Select', 'Record', 'Owner and authoritative source', 'Platform and handling', 'Review', 'Action'], rows) : el('p', { text: 'No matching records.' }),
    el('div', { class: 'btn-row' }, previous, next,
      button('Select all filtered', () => { filtered.forEach(record => selectedIds.add(record.id)); tools.refreshSelection(); render(); }),
      button('Clear selection', () => { selectedIds.clear(); tools.refreshSelection(); render(); })));
}
const sourceSystems = {
  Application: ['Service catalog', 'CMDB', 'Application portfolio', 'ServiceNow', 'Jira Service Management'],
  Dataset: ['Data catalog', 'Data warehouse', 'Data lake', 'Database', 'Microsoft Purview', 'Collibra'],
  Document: ['Document management system', 'SharePoint', 'Google Drive', 'Confluence', 'Git repository'],
  Infrastructure: ['VMware inventory', 'CMDB', 'Cloud asset inventory', 'ServiceNow', 'NetBox'],
  'Code repository': ['GitHub', 'GitLab', 'Azure DevOps', 'Bitbucket', 'Organization Git server'],
  Runbook: ['Operations knowledge base', 'Confluence', 'SharePoint', 'Git repository', 'ServiceNow'],
  Decision: ['Architecture decision register', 'Governance register', 'Confluence', 'SharePoint', 'Git repository'],
};
function existingOrCustom(label, options, current = '') {
  const values = ['', ...new Set([...options, ...(current ? [current] : [])]), 'Enter another value…'];
  const choice = dropdown(label, values, current);
  const custom = textField(label + ' — custom value');
  custom.control.hidden = true;
  choice.input.addEventListener('change', () => {
    custom.control.hidden = choice.input.value !== 'Enter another value…';
    custom.input.required = !custom.control.hidden;
  });
  return { input: choice.input, control: el('div', {}, choice.control, custom.control),
    value: () => choice.input.value === 'Enter another value…' ? custom.input.value.trim() : choice.input.value,
    update: options => {
      choice.input.replaceChildren(new Option('Select…', ''), ...options.map(value => new Option(value, value)), new Option('Enter another value…', 'Enter another value…'));
      choice.input.value = '';
      custom.control.hidden = true;
      custom.input.required = false;
      custom.input.value = '';
    } };
}
function drawEditor() {
  const current = records.find(record => record.id === editing) ?? {};
  const id = textField('Record ID', current.id ?? crypto.randomUUID());
  const name = textField('Name', current.name);
  const type = dropdown('Object type', recordTypes, current.type ?? 'Application');
  const domain = dropdown('Domain', domains, current.domain ?? 'Business services');
  const owner = textField('Owner', current.owner);
  const system = existingOrCustom('Authoritative system', [...sourceSystems[type.input.value], ...records.filter(record => record.type === type.input.value).map(record => record.system).filter(Boolean)], current.system);
  type.input.addEventListener('change', () => system.update([...new Set([...sourceSystems[type.input.value], ...records.filter(record => record.type === type.input.value).map(record => record.system).filter(Boolean)])]));
  const ownerRole = dropdown('Owner role', ['', 'Business owner', 'Data owner / steward', 'Application owner', 'Platform owner', 'Service owner', 'Records manager', 'Security owner', 'Architecture owner'], current.ownerRole ?? '');
  const classification = dropdown('Classification', classifications, current.classification ?? 'Unassessed');
  const lifecycle = dropdown('Lifecycle', lifecycles, current.lifecycle ?? 'Draft');
  const platform = dropdown('Platform', ['', ...platforms], current.platform);
  const offering = dropdown('Offering / deployment model', [''], '');
  const region = dropdown('Region / site', [''], '');
  const environment = dropdown('Environment', ['', 'Development', 'Test / QA', 'Staging', 'Production', 'Disaster recovery', 'Shared / multiple environments', 'Not applicable'], current.environment ?? '');
  function setChoices(item, values, previous) {
    item.input.replaceChildren(new Option('Select…', ''), ...values.map(value => new Option(value, value)));
    item.input.value = values.includes(previous) ? previous : '';
    item.input.disabled = !values.length;
  }
  function updateRegions(restore = false) {
    setChoices(region, offeringOptions(platform.input.value, offering.input.value).regions, restore ? current.region ?? '' : region.input.value);
  }
  function updateOfferings(restore = false) {
    setChoices(offering, offeringNames(platform.input.value), restore ? current.offering ?? '' : offering.input.value);
    updateRegions(restore);
  }
  updateOfferings(true);
  platform.input.addEventListener('change', () => updateOfferings());
  offering.input.addEventListener('change', () => updateRegions());
  const reference = textField('Authoritative URL / reference', current.reference);
  const review = textField('Review due', current.review ?? '', 'date');
  const retentionPolicy = dropdown('Retention policy', ['', 'Schedule not yet assigned', 'Event-based retention', 'Fixed-term retention', 'Permanent retention', 'Source-system policy', 'Pending records-owner decision'], current.retentionPolicy ?? '');
  const hold = dropdown('Disposition hold', ['', 'No hold recorded', 'Hold applies', 'Pending review'], current.hold ?? '');
  const retention = textField('Retention schedule / hold reference', current.retention);
  const cadence = dropdown('Review frequency', ['', 'Monthly', 'Quarterly', 'Every 6 months', 'Annually', 'Every 2 years', 'On change', 'Manual date'], current.cadence ?? '');
  function updateReviewDate() {
    const months = { Monthly: 1, Quarterly: 3, 'Every 6 months': 6, Annually: 12, 'Every 2 years': 24 }[cadence.input.value];
    if (!months) return;
    const base = verified.input.value || today();
    const [year, month, day] = base.split('-').map(Number);
    const end = new Date(year, month - 1 + months + 1, 0);
    const due = new Date(year, month - 1 + months, Math.min(day, end.getDate()));
    review.input.value = [due.getFullYear(), String(due.getMonth() + 1).padStart(2, '0'), String(due.getDate()).padStart(2, '0')].join('-');
  }
  cadence.input.addEventListener('change', updateReviewDate);
  review.input.addEventListener('change', () => { cadence.input.value = 'Manual date'; });
  const version = textField('Source version / revision', current.version ?? '');
  const verified = textField('Last verified', current.verified ?? '', 'date');
  verified.input.addEventListener('change', updateReviewDate);
  const notes = textField('Notes / change reason', current.notes);
  const fields = { id, name, type, domain, owner, ownerRole, system, classification, lifecycle, platform, offering, region, environment, reference, cadence, review, retentionPolicy, hold, retention, version, verified, notes };
  id.input.required = true;
  name.input.required = true;
  const dependencySearch = textField('Find a dependency by name or ID');
  const dependencyChoices = el('div');
  const selectedDependencies = new Set(current.dependencies ?? []);
  function drawDependencies() {
    const term = dependencySearch.input.value.toLowerCase();
    const choices = records.filter(record => record.id !== editing && (!term ? selectedDependencies.has(record.id) : (record.name + ' ' + record.id).toLowerCase().includes(term))).slice(0, 30);
    dependencyChoices.replaceChildren(...choices.map(record => {
      const input = el('input', { attrs: { type: 'checkbox' } });
      input.checked = selectedDependencies.has(record.id);
      input.addEventListener('change', () => input.checked ? selectedDependencies.add(record.id) : selectedDependencies.delete(record.id));
      return el('label', { class: 'checkbox' }, input, record.name + ' · ' + record.id);
    }));
  }
  dependencySearch.input.addEventListener('input', drawDependencies);
  drawDependencies();
  const submit = el('button', { class: 'btn btn-primary', text: editing ? 'Save changes' : 'Add record', attrs: { type: 'submit' } });
  const form = el('form', {}, el('div', { class: 'field-grid' }, ...Object.values(fields).map(item => item.control)),
    dependencySearch.control, dependencyChoices,
    el('p', { class: 'muted', text: 'Search to add dependencies. Showing up to 30 matches.' }),
    el('div', { class: 'btn-row' }, submit, button('New record', () => { editing = null; drawEditor(); })));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const record = Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, item.value ? item.value() : item.input.value.trim()]));
    record.dependencies = [...selectedDependencies];
    if (!validateRecord(record)) { status.textContent = 'Enter a valid ID and name.'; return; }
    if (records.some(item => item.id === record.id && item.id !== editing)) { status.textContent = 'That record ID is already registered.'; return; }
    const updated = changedRecord(editing ? current : null, { ...current, ...record }, actor.input.value, record.notes || (editing ? 'Edited record' : 'Created record'));
    const oldId = editing;
    const next = records.map(item => {
      if (item.id === oldId) return updated;
      if (!oldId || oldId === updated.id || !item.dependencies.includes(oldId)) return item;
      return changedRecord(item, { ...item, dependencies: item.dependencies.map(value => value === oldId ? updated.id : value) }, actor.input.value, 'Dependency updated after ID change');
    });
    if (!editing) next.push(updated);
    commit(next);
  });
  const dependents = records.filter(record => record.dependencies.includes(editing));
  editor.replaceChildren(card(editing ? 'Edit record' : 'Register an item', form,
    editing ? el('p', { text: 'Referenced by ' + dependents.length + ' records: ' + dependents.map(record => record.name).join(', ') }) : null,
    editing ? el('p', { class: 'muted', text: 'Last updated: ' + (current.updatedAt || 'Unknown') + ' · Recorded changes: ' + (current.history?.length ?? 0) }) : null));
}
for (const item of [typeFilter, ownerFilter, domainFilter, platformFilter, classFilter, lifecycleFilter, issuesFilter]) item.input.addEventListener('change', () => { page = 0; render(); });
search.input.addEventListener('input', () => { page = 0; render(); });
const inventoryButton = button('Import saved VMware inventory', async () => {
  inventoryButton.disabled = true;
  try {
    const estate = await loadInventory();
    if (!estate) { status.textContent = 'Load an estate in VMware Inventory first.'; return; }
    const additions = inventoryRecords(estate, records);
    commit([...records, ...additions.map(row => changedRecord(null, row, actor.input.value, 'Imported VMware inventory'))]);
    status.textContent += ' Added ' + additions.length + ' infrastructure records. Existing source records were skipped.';
  } catch { status.textContent = 'The saved inventory could not be loaded.'; }
  finally { inventoryButton.disabled = false; }
});
root.replaceChildren(card('Change attribution', actor.control), editor, tools.bulk, tools.review, tools.mergeArea, tools.inspection, card('Registry', filters, el('div', { class: 'btn-row' }, inventoryButton, tools.importer, tools.restore,
  button('Export full registry backup', () => { validateRegistryBackup({ schema: 'archtoolkit.registry.v1', records }); exportJson('registry', { schema: 'archtoolkit.registry.v1', records }); }),
  button('Download printable register', () => downloadReport('registry-report', 'Single Source of Truth register', [{ title: 'Filtered records', headers: ['ID', 'Name', 'Type', 'Owner', 'Source', 'Classification', 'Review', 'Findings'], rows: records.filter(matches).map(record => [record.id, record.name, record.type, record.owner, record.reference, record.classification, record.review, recordIssues(record, index, today()).join(' · ')]) }])),
  button('Export filtered CSV', () => exportCsv('registry', records.filter(matches).map(record => ({ ...record, dependencies: record.dependencies.join(' | '), findings: recordIssues(record, index, today()).join(' | ') }))))), status, output));
refreshOwners(); drawEditor(); render();

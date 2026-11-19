import { el, dropdown, textField, button, table, exportJson, exportCsv, jsonImport, today } from './workspace-controls.js';
import { card } from '../lib/ui/components.js';
import { classifications, validateRecord } from './registry-model.js';
import { changedRecord, recordChanges, validateRegistryBackup, applyRegistryImport, impactAnalysis, mergeRegistryRecords } from './registry-operations.js';
import { downloadReport } from './workspace-reports.js';

export function registryTools(getRecords, commit, selectedIds, actor, status) {
  const selectionCount = el('p');
  const review = el('div');
  const inspection = el('div');
  const mergeArea = el('div');
  let pending = [];
  let decisions = Object.create(null);
  let conflictPage = 0;
  const field = dropdown('Bulk edit field', ['Owner', 'Classification', 'Environment', 'Review date']);
  const value = el('div');
  let readValue = () => '';
  const reason = textField('Bulk change reason');
  function drawBulkValue() {
    const label = field.input.value;
    const control = label === 'Classification' ? dropdown('New classification', classifications) : label === 'Environment'
      ? dropdown('New environment', ['Development', 'Test / QA', 'Staging', 'Production', 'Disaster recovery', 'Shared / multiple environments', 'Not applicable'])
      : textField(label === 'Owner' ? 'New owner' : 'New review date', '', label === 'Review date' ? 'date' : 'text');
    value.replaceChildren(control.control); readValue = () => control.input.value.trim();
  }
  field.input.addEventListener('change', drawBulkValue); drawBulkValue();
  const bulk = card('Bulk editing', selectionCount, el('div', { class: 'field-grid' }, field.control, value, reason.control),
    button('Apply to selected records', () => {
      const next = readValue();
      if (!selectedIds.size || !next) { status.textContent = 'Select records and enter a new value.'; return; }
      const key = { Owner: 'owner', Classification: 'classification', Environment: 'environment', 'Review date': 'review' }[field.input.value];
      commit(getRecords().map(record => selectedIds.has(record.id) ? changedRecord(record, { ...record, [key]: next }, actor(), reason.input.value || 'Bulk edit ' + key) : record));
      status.textContent += ' Updated ' + selectedIds.size + ' selected records.';
    }));
  function refreshSelection() { selectionCount.textContent = selectedIds.size + ' records selected across pages and filters.'; }
  refreshSelection();
  const importer = jsonImport('Review registry import', value => {
    pending = validateRegistryBackup(value); decisions = Object.create(null); conflictPage = 0; drawImport();
  }, status);
  function drawImport() {
    const existing = new Map(getRecords().map(record => [record.id, record]));
    const conflicts = pending.filter(row => existing.has(row.id));
    conflictPage = Math.min(conflictPage, Math.max(0, Math.ceil(conflicts.length / 25) - 1));
    const defaultAction = dropdown('Default conflict action', ['Keep existing', 'Update existing', 'Import as copy']);
    defaultAction.input.addEventListener('change', () => {
      const action = { 'Keep existing': 'keep', 'Update existing': 'update', 'Import as copy': 'copy' }[defaultAction.input.value];
      for (const row of conflicts) decisions[row.id] = action;
      drawImport();
    });
    const options = [['keep', 'Keep existing'], ['update', 'Update existing'], ['copy', 'Import as copy']];
    const rows = conflicts.slice(conflictPage * 25, (conflictPage + 1) * 25).map(row => {
      const select = el('select', { attrs: { 'aria-label': 'Import action · ' + row.id } });
      options.forEach(([id, name]) => select.appendChild(new Option(name, id)));
      select.value = decisions[row.id] ?? 'keep'; select.addEventListener('change', () => { decisions[row.id] = select.value; });
      const changes = recordChanges(existing.get(row.id), row);
      return [row.name + ' · ' + row.id, changes.map(change => change.field + ': ' + JSON.stringify(change.before) + ' → ' + JSON.stringify(change.after)).join(' · ') || 'No field changes', select];
    });
    const previous = button('Previous conflicts', () => { conflictPage--; drawImport(); }); previous.disabled = conflictPage === 0;
    const next = button('Next conflicts', () => { conflictPage++; drawImport(); }); next.disabled = (conflictPage + 1) * 25 >= conflicts.length;
    review.replaceChildren(card('Import review', el('p', { text: pending.length + ' incoming records · ' + (pending.length - conflicts.length) + ' new · ' + conflicts.length + ' existing IDs' }), defaultAction.control,
      table(['Incoming record', 'Field differences', 'Decision'], rows), el('div', { class: 'btn-row' }, previous, next,
        button('Apply reviewed import', () => {
          const result = applyRegistryImport(getRecords(), pending, decisions, actor());
          if (new Set(result.map(record => record.id)).size !== result.length || !result.every(validateRecord)) { status.textContent = 'Import validation failed. Review the file.'; return; }
          commit(result); pending = []; review.replaceChildren();
        }, true), button('Cancel import', () => { pending = []; review.replaceChildren(); }))));
  }
  const restore = jsonImport('Restore registry backup', value => {
    const checked = validateRegistryBackup(value);
    if (!window.confirm('Replace the registry with this validated backup?')) return;
    exportJson('registry-before-restore', { schema: 'archtoolkit.registry.v1', records: getRecords() });
    selectedIds.clear(); commit(checked); refreshSelection();
  }, status);
  function inspect(record) {
    const impact = impactAnalysis(getRecords(), record.id);
    const history = [...(record.history ?? [])].reverse();
    const details = history.map(row => [row.at, row.actor || 'Not recorded', row.reason || row.change || '',
      (row.changes ?? []).map(change => change.field + ': ' + JSON.stringify(change.before) + ' → ' + JSON.stringify(change.after)).join(' · ') || 'Legacy change summary only']);
    const impactRows = [...impact.upstream.map(row => ['Depends on', row]), ...impact.downstream.map(row => ['Affected by changes here', row])]
      .map(([relation, row]) => [relation, row.depth, row.record?.name || row.id, row.record?.owner || 'Unassigned', row.record?.lifecycle || 'Missing record']);
    inspection.replaceChildren(card('History and dependencies · ' + record.name,
      button('Close details', () => inspection.replaceChildren()),
      table(['Relationship', 'Distance', 'Record', 'Owner', 'State'], impactRows),
      button('Download dependency report', () => downloadReport('registry-dependencies', record.name + ' — dependency impact', [{ title: 'Impact', headers: ['Relationship', 'Distance', 'Record', 'Owner', 'State'], rows: impactRows }])),
      table(['When', 'Recorded by', 'Reason', 'Before → after'], details)));
    inspection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function merge(source) {
    const search = textField('Find the surviving record');
    const targetSelect = el('select', { attrs: { 'aria-label': 'Surviving record' } });
    const choices = el('div');
    const reason = textField('Merge / replacement reason');
    let fields = {};
    function drawCandidates() {
      const matches = getRecords().filter(row => row.id !== source.id && row.type === source.type && !['Superseded', 'Archived'].includes(row.lifecycle) &&
        (row.name + ' ' + row.id).toLowerCase().includes(search.input.value.toLowerCase())).slice(0, 50);
      targetSelect.replaceChildren(new Option('Select surviving record…', ''), ...matches.map(row => new Option(row.name + ' · ' + row.id, row.id)));
      choices.replaceChildren(); fields = {};
    }
    targetSelect.addEventListener('change', () => {
      const target = getRecords().find(row => row.id === targetSelect.value); fields = {};
      if (!target) { choices.replaceChildren(); return; }
      const differences = recordChanges(target, source).filter(change => !['id','dependencies','sourceKey','sourceKeys','replacementId'].includes(change.field));
      choices.replaceChildren(table(['Field', 'Surviving value', 'Incoming value', 'Keep value from'], differences.map(change => {
        const select = dropdown('Merge field · ' + change.field, ['Surviving record', 'Incoming record']);
        fields[change.field] = target[change.field];
        select.input.addEventListener('change', () => { fields[change.field] = select.input.value === 'Incoming record' ? source[change.field] : target[change.field]; });
        return [change.field, JSON.stringify(target[change.field] ?? ''), JSON.stringify(source[change.field] ?? ''), select.control];
      })));
    });
    search.input.addEventListener('input', drawCandidates); drawCandidates();
    mergeArea.replaceChildren(card('Merge / replace · ' + source.name,
      el('p', { text: 'The surviving record keeps the chosen fields and combined dependencies. This record becomes Superseded and points to the survivor. Dependent records are redirected.' }),
      search.control, targetSelect, choices, reason.control, el('div', { class: 'btn-row' },
        button('Apply merge / replacement', () => {
          try {
            commit(mergeRegistryRecords(getRecords(), source.id, targetSelect.value, fields, actor(), reason.input.value));
            mergeArea.replaceChildren();
          } catch (error) { status.textContent = error.message; }
        }, true), button('Cancel merge', () => mergeArea.replaceChildren()))));
    mergeArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return { bulk, importer, restore, review, inspection, mergeArea, refreshSelection, inspect, merge };
}

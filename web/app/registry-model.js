export const recordTypes = ['Application', 'Dataset', 'Document', 'Infrastructure', 'Code repository', 'Runbook', 'Decision'];
export const classifications = ['Unassessed', 'Public', 'Internal', 'Confidential', 'Restricted', 'CUI', 'Classified'];
export const lifecycles = ['Draft', 'Active', 'Deprecated', 'Superseded', 'Archived'];
export const domains = ['Business services', 'Data', 'Platform', 'Network', 'Security', 'Operations', 'Governance', 'Other'];
export function validateRecord(record) {
  const required = ['id', 'name', 'type', 'domain', 'owner', 'system', 'classification', 'lifecycle', 'platform', 'reference', 'review', 'retention', 'notes'];
  return record && required.every(key => typeof record[key] === 'string') && record.id.trim() && record.name.trim() &&
    recordTypes.includes(record.type) && domains.includes(record.domain) && classifications.includes(record.classification) &&
    lifecycles.includes(record.lifecycle) && Array.isArray(record.dependencies) && record.dependencies.every(id => typeof id === 'string') &&
    (!record.review || /^\d{4}-\d{2}-\d{2}$/.test(record.review));
}
export function registryIndex(records) {
  const ids = new Set();
  const names = new Map();
  const sources = new Map();
  for (const record of records) {
    ids.add(record.id);
    const name = record.type + ':' + record.name.trim().toLowerCase();
    if (!['Superseded', 'Archived'].includes(record.lifecycle)) names.set(name, (names.get(name) ?? 0) + 1);
    if (record.reference) {
      const systems = sources.get(record.reference) ?? new Set();
      systems.add(record.system);
      sources.set(record.reference, systems);
    }
  }
  return { ids, names, sources };
}
export function recordIssues(record, index, date) {
  const issues = [];
  if (!record.owner.trim()) issues.push('Missing owner');
  if (!record.system.trim() || !record.reference.trim()) issues.push('Missing authoritative source');
  if (record.classification === 'Unassessed') issues.push('Classification unassessed');
  if (!record.review) issues.push('Review date missing');
  else if (record.review < date) issues.push('Review overdue');
  if (!record.retention.trim()) issues.push('Retention unrecorded');
  if (record.dependencies.some(id => !index.ids.has(id))) issues.push('Dependency missing');
  if (!['Superseded', 'Archived'].includes(record.lifecycle) && index.names.get(record.type + ':' + record.name.trim().toLowerCase()) > 1) issues.push('Possible duplicate name');
  if ((index.sources.get(record.reference)?.size ?? 0) > 1) issues.push('Conflicting source systems');
  return issues;
}
export function inventoryRecords(estate, existing) {
  const seen = new Set(existing.flatMap(record => [record.sourceKey, ...(record.sourceKeys ?? [])]).filter(Boolean));
  const records = [];
  for (const [kind, items] of [['host', estate.inventory.hosts], ['vm', estate.inventory.vms]]) {
    for (const item of items) {
      const sourceKey = JSON.stringify([kind, (item.vcenter ?? '').toLowerCase(), item.uuid ?? item.name]);
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      records.push({ id: crypto.randomUUID(), name: item.name, type: 'Infrastructure', domain: 'Platform', owner: '',
        system: 'VMware inventory', classification: 'Unassessed', lifecycle: 'Draft', platform: 'VCF / vSphere',
        reference: [estate.origin, kind, item.vcenter, item.name].filter(Boolean).join(' / '),
        review: '', retention: '', notes: 'Imported from ' + estate.origin, dependencies: [], sourceKey,
        updatedAt: new Date().toISOString() });
    }
  }
  return records;
}

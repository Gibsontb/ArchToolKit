import { validateRecord } from './registry-model.js';
const ignored = new Set(['history', 'updatedAt']);
export function recordChanges(before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(key => !ignored.has(key))
    .filter(key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null))
    .map(field => ({ field, before: structuredClone(before?.[field] ?? null), after: structuredClone(after?.[field] ?? null) }));
}
export function changedRecord(before, after, actor, reason) {
  const changes = recordChanges(before, after);
  return { ...after, updatedAt: new Date().toISOString(), history: [...(before?.history ?? after?.history ?? []),
    { at: new Date().toISOString(), actor: actor.trim() || 'Unspecified local user', reason, changes }] };
}
export function validateRegistryBackup(value) {
  if (value?.schema !== 'archtoolkit.registry.v1' || !Array.isArray(value.records) || !value.records.every(validateRecord) ||
    new Set(value.records.map(row => row.id)).size !== value.records.length) throw Error('Choose a valid registry backup with unique IDs.');
  for (const record of value.records) {
    if (record.history !== undefined && (!Array.isArray(record.history) || !record.history.every(row => row && typeof row === 'object' && typeof row.at === 'string'))) throw Error('Invalid record history.');
  }
  return structuredClone(value.records);
}
export function applyRegistryImport(records, incoming, choices, actor) {
  const result = structuredClone(records);
  const positions = new Map(result.map((row, index) => [row.id, index]));
  const renamed = new Map();
  for (const row of incoming) if (positions.has(row.id) && choices[row.id] === 'copy') renamed.set(row.id, crypto.randomUUID());
  for (const source of incoming) {
    const row = structuredClone(source);
    const position = positions.get(row.id);
    const choice = position === undefined ? 'add' : (Object.hasOwn(choices, row.id) ? choices[row.id] : 'keep');
    if (choice === 'keep') continue;
    row.dependencies = row.dependencies.map(id => renamed.get(id) ?? id);
    if (choice === 'copy') { row.id = renamed.get(row.id); delete row.sourceKey; delete row.sourceKeys; }
    const before = choice === 'update' ? result[position] : null;
    const imported = changedRecord(before, row, actor, choice === 'update' ? 'Updated from reviewed import' : 'Added from reviewed import');
    if (choice === 'update') result[position] = imported;
    else { positions.set(imported.id, result.length); result.push(imported); }
  }
  return result;
}
export function impactAnalysis(records, id) {
  const byId = new Map(records.map(row => [row.id, row]));
  const reverse = new Map();
  for (const row of records) for (const dependency of row.dependencies) {
    const dependents = reverse.get(dependency) ?? []; dependents.push(row.id); reverse.set(dependency, dependents);
  }
  const visit = next => {
    const seen = new Set([id]); const queue = [{ id, depth: 0 }]; const found = [];
    for (let i = 0; i < queue.length; i++) for (const child of next(queue[i].id)) {
      if (seen.has(child)) continue;
      seen.add(child); const row = { id: child, depth: queue[i].depth + 1, record: byId.get(child) };
      found.push(row); queue.push(row);
    }
    return found;
  };
  return { upstream: visit(key => byId.get(key)?.dependencies ?? []), downstream: visit(key => reverse.get(key) ?? []) };
}
export function mergeRegistryRecords(records, sourceId, targetId, fields, actor, reason) {
  const source = records.find(row => row.id === sourceId), target = records.find(row => row.id === targetId);
  if (!source || !target || sourceId === targetId || source.type !== target.type) throw Error('Select two distinct records of the same type.');
  const merged = { ...target, ...fields, id: targetId,
    dependencies: [...new Set([...target.dependencies, ...source.dependencies])].filter(id => id !== sourceId && id !== targetId),
    sourceKeys: [...new Set([target.sourceKey, source.sourceKey, ...(target.sourceKeys ?? []), ...(source.sourceKeys ?? [])].filter(Boolean))] };
  if (!validateRecord(merged)) throw Error('Merged record is invalid.');
  return records.map(record => {
    if (record.id === targetId) return changedRecord(target, merged, actor, reason || 'Merged record ' + sourceId);
    const dependencies = [...new Set(record.dependencies.map(id => id === sourceId ? targetId : id))].filter(id => id !== record.id);
    if (record.id === sourceId) return changedRecord(record, { ...record, lifecycle: 'Superseded', replacementId: targetId, dependencies }, actor, 'Superseded by ' + targetId);
    return JSON.stringify(dependencies) === JSON.stringify(record.dependencies) ? record : changedRecord(record, { ...record, dependencies }, actor, 'Dependency redirected after merge of ' + sourceId);
  });
}

export function newAssessment(profile = {}, evidence = {}, serviceChecks = []) {
  return { id: crypto.randomUUID(), archived: false, updatedAt: new Date().toISOString(),
    profile: { name: '', owner: '', organization: '', hosting: '', platform: '', offering: '', region: '', boundary: '', destination: '', authority: '', data: [], locations: [], requirements: [], ...profile }, evidence, serviceChecks };
}
export function validAssessment(value) {
  const p = value?.profile;
  return Boolean(p && typeof p === 'object' && !Array.isArray(p) && typeof p.name === 'string' && typeof p.owner === 'string' &&
    Object.values(p).every(item => typeof item === 'string' || (Array.isArray(item) && item.every(value => typeof value === 'string'))) &&
    ['data', 'locations', 'requirements'].every(key => Array.isArray(p[key])) &&
    value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence) &&
    Object.values(value.evidence).every(item => item && typeof item === 'object' && !Array.isArray(item) && Object.values(item).every(value => typeof value === 'string')) &&
    (value.serviceChecks === undefined || (Array.isArray(value.serviceChecks) && value.serviceChecks.every(row => row && ['service','platform','offering','region','status','reference','verified'].every(key => typeof row[key] === 'string')))));
}
export function validateWorkspace(value) {
  if (value?.schema !== 'archtoolkit.governance-workspace.v1' || !Array.isArray(value.assessments) || !value.assessments.length ||
    !value.assessments.every(item => validAssessment(item) && typeof item.id === 'string' && item.id && typeof item.archived === 'boolean') ||
    new Set(value.assessments.map(item => item.id)).size !== value.assessments.length || !value.assessments.some(item => item.id === value.activeId)) throw Error('Choose a valid Governance workspace backup.');
  return structuredClone(value);
}
export function evidenceFindings(row, date) {
  const issues = [];
  if (!row || row.applicability === 'Review required' || !row.applicability) issues.push('Applicability unresolved');
  if (row?.applicability === 'Not applicable') {
    if (!row.decision?.trim()) issues.push('Applicability rationale missing');
    return issues;
  }
  if (!row?.owner?.trim()) issues.push('Owner missing');
  if (!row?.link?.trim()) issues.push('Evidence reference missing');
  if (!row?.verified) issues.push('Verification date missing');
  if (row?.expiry && row.expiry < date) issues.push('Review overdue');
  if (row?.status !== 'Approved') issues.push('Approval outstanding');
  else if (!row.decision?.trim()) issues.push('Approver / decision missing');
  return issues;
}

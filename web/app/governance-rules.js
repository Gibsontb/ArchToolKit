export const dataCategories = ['Public', 'Internal', 'PII', 'PHI', 'Payment data', 'CUI', 'Export-controlled', 'Classified'];
export const jurisdictions = ['United States', 'EU / EEA', 'United Kingdom', 'Canada', 'Australia', 'Other'];
export const requirements = ['HIPAA', 'PCI DSS', 'GDPR', 'FISMA / RMF', 'FedRAMP', 'DoD CC SRG', 'GovRAMP', 'CJIS', 'Export controls', 'Agency product approval'];
const rules = {
  'HIPAA': ['https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html', 'Confirm covered-entity or business-associate scope, risk analysis, and applicable BAA.'],
  'PCI DSS': ['https://www.pcisecuritystandards.org/document_library/', 'Define the payment environment, validate scope, and record the applicable assessment.'],
  'GDPR': ['https://eur-lex.europa.eu/eli/reg/2016/679/oj', 'Confirm territorial scope, lawful basis, controller/processor roles, and transfer safeguards.'],
  'FISMA / RMF': ['https://csrc.nist.gov/pubs/sp/800/37/r2/final', 'Record system categorization, tailored controls, assessment evidence, and authorization decision.'],
  'FedRAMP': ['https://www.fedramp.gov/docs/authority/scope/', 'Determine use-case scope, exact offering and boundary, certification status, and agency responsibilities.'],
  'DoD CC SRG': ['https://www.cyber.mil/dccs/', 'Confirm the required impact level, offering approval, boundary, and mission-owner authorization.'],
  'GovRAMP': ['https://govramp.org/faqs', 'Confirm purchasing-body requirements and exact offering status.'],
  'CJIS': ['https://le.fbi.gov/cjis-division/cjis-security-policy-resource-center', 'Confirm CJI scope and applicable agreements with the responsible CJIS authority.'],
  'Export controls': ['https://www.bis.gov/regulations', 'Determine export jurisdiction, classification, destinations, access restrictions, and required permissions.'],
  'Agency product approval': ['https://csrc.nist.gov/pubs/sp/800/37/r2/final', 'Record applicable internal product, architecture, acquisition, and interconnection approvals.'],
};
export function evaluate(profile) {
  const candidates = new Map();
  const add = (id, reason) => {
    if (candidates.has(id)) candidates.get(id).reason += ' ' + reason;
    else candidates.set(id, { id, reason, source: rules[id][0], action: rules[id][1] });
  };
  for (const id of profile.requirements) if (Object.hasOwn(rules, id)) add(id, 'Selected for review.');
  if (profile.data.includes('PHI')) add('HIPAA', 'PHI selected.');
  if (profile.data.includes('Payment data')) add('PCI DSS', 'Payment data selected.');
  if (profile.data.includes('PII') && profile.locations.includes('EU / EEA')) add('GDPR', 'PII and EU / EEA selected.');
  if (['Federal civilian', 'DoD'].includes(profile.organization)) {
    add('FISMA / RMF', 'Federal system context selected.');
    add('Agency product approval', 'Federal product and architecture review context.');
    if (['Public cloud', 'Hybrid'].includes(profile.hosting)) add('FedRAMP', 'Federal cloud use selected.');
  }
  if (profile.organization === 'DoD' && ['Public cloud', 'Hybrid'].includes(profile.hosting)) add('DoD CC SRG', 'DoD cloud use selected.');
  if (profile.data.includes('Export-controlled')) add('Export controls', 'Export-controlled data selected.');
  const issues = [];
  if (profile.data.includes('Classified')) issues.push('Record the classification authority and receiving boundary approval before choosing the deployment environment.');
  if (profile.data.includes('CUI')) issues.push('Identify CUI categories and the applicable agency or contract handling requirements.');
  if (!profile.locations.length) issues.push('Select operating jurisdictions and record the permitted data locations.');
  if (!profile.owner.trim()) issues.push('Assign an assessment owner.');
  const base = [
    { id: 'boundary', reason: 'All assessments.', action: 'Document the data flow, system boundary, dependencies, and responsible owners.', source: 'https://csrc.nist.gov/pubs/sp/800/37/r2/final' },
    { id: 'access', reason: 'All assessments.', action: 'Record access roles, monitoring, recovery, retention, and incident response evidence.', source: 'https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final' },
  ];
  return { rows: [...base, ...candidates.values()], issues };
}

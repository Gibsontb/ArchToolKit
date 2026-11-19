import { el, dropdown, textField, checks, button, table, load, save, exportJson, exportCsv, jsonImport, platforms, today } from './workspace-controls.js';
import { offeringNames, offeringOptions } from './governance-offerings.js';
import { newAssessment, validAssessment, validateWorkspace, evidenceFindings } from './governance-workspace-model.js';
import { downloadReport } from './workspace-reports.js';
import { servicePanel, serviceFindings } from './governance-services.js';
import { card } from '../lib/ui/components.js';
import { dataCategories, jurisdictions, requirements, evaluate } from './governance-rules.js';

const key = 'archtoolkit.governance.workspace.v1';
const previous = load('archtoolkit.governance.assessment.v1', null);
let workspace;
try { workspace = validateWorkspace(load(key, null)); }
catch {
  const old = previous?.profile ? previous : { profile: {}, evidence: {} };
  const migrated = newAssessment(old.profile, old.evidence);
  if (!validAssessment(migrated)) { migrated.profile = newAssessment().profile; migrated.evidence = {}; }
  workspace = { schema: 'archtoolkit.governance-workspace.v1', activeId: migrated.id, assessments: [migrated] };
}
let state = workspace.assessments.find(item => item.id === workspace.activeId);
const root = document.getElementById('workspace-root');
const status = el('p', { attrs: { role: 'status' } });
function mount() {
  const p = state.profile;
  const assessmentSelect = el('select');
  for (const item of workspace.assessments) {
    const option = new Option((item.profile.name || 'Untitled assessment') + (item.archived ? ' (archived)' : ''), item.id);
    assessmentSelect.appendChild(option);
  }
  assessmentSelect.value = state.id;
  assessmentSelect.setAttribute('aria-label', 'Open assessment');
  assessmentSelect.addEventListener('change', () => {
    persist(); workspace.activeId = assessmentSelect.value; state = workspace.assessments.find(item => item.id === workspace.activeId);
    save(key, workspace, status); mount();
  });
  const name = textField('Assessment / initiative name', p.name);
  const owner = textField('Assessment owner', p.owner);
  const organization = dropdown('Organization', ['', 'Commercial', 'Federal civilian', 'DoD', 'State / local', 'Education'], p.organization);
  const hosting = dropdown('Hosting', ['', 'On-premises', 'Private cloud', 'Public cloud', 'Hybrid'], p.hosting);
  const platform = dropdown('Platform', ['', ...platforms], p.platform);
  const offering = dropdown('Exact offering', ['', 'Select a platform first'], '');
  const region = dropdown('Region / site', ['', 'Select a platform first'], '');
  const boundary = dropdown('Deployment boundary', ['', 'Select a platform first'], '');
  const data = checks('Data categories', dataCategories, p.data);
  const locations = checks('Operating jurisdictions', jurisdictions, p.locations);
  const selected = checks('Requirements to review', requirements, p.requirements);
  const destination = dropdown('Permitted data locations', [''], '');
  const authority = dropdown('Classification / handling authority', [''], '');
  const offeringSource = el('p', { class: 'muted' });
  function setChoices(item, values, previous) {
    item.input.replaceChildren(new Option('Select…', ''), ...values.map(value => new Option(value, value)));
    item.input.value = values.includes(previous) ? previous : '';
    item.input.disabled = !values.length;
  }
  function refreshOfferingChoices(restore = false) {
    const choices = offeringOptions(platform.input.value, offering.input.value);
    for (const [key, item, values] of [
      ['region', region, choices.regions], ['boundary', boundary, choices.boundaries],
      ['destination', destination, choices.destinations], ['authority', authority, choices.authorities],
    ]) setChoices(item, values, restore ? p[key] ?? '' : item.input.value);
    offeringSource.replaceChildren(...(choices.source ? [el('a', { text: 'Offering and region reference', attrs: { href: choices.source, target: '_blank', rel: 'noopener noreferrer' } })] : []));
  }
  function refreshPlatformChoices(restore = false) {
    setChoices(offering, offeringNames(platform.input.value), restore ? p.offering ?? '' : offering.input.value);
    refreshOfferingChoices(restore);
  }
  refreshPlatformChoices(true);
  platform.input.addEventListener('change', () => refreshPlatformChoices());
  offering.input.addEventListener('change', () => refreshOfferingChoices());
  const output = el('div');
  const profile = () => ({ name: name.input.value, owner: owner.input.value, organization: organization.input.value,
    hosting: hosting.input.value, platform: platform.input.value, offering: offering.input.value, region: region.input.value, boundary: boundary.input.value,
    destination: destination.input.value, authority: authority.input.value,
    data: data.value(), locations: locations.value(), requirements: selected.value() });
  const persist = () => {
    state.profile = profile(); state.updatedAt = new Date().toISOString();
    workspace.activeId = state.id; save(key, workspace, status);
    const option = [...assessmentSelect.options].find(item => item.value === state.id);
    if (option) option.textContent = (state.profile.name || 'Untitled assessment') + (state.archived ? ' (archived)' : '');
  };
  const report = () => {
    const current = profile();
    return { schema: 'archtoolkit.governance.v1', profile: current, evidence: state.evidence, serviceChecks: state.serviceChecks, ...evaluate(current) };
  };
  const summary = el('div');
  function renderSummary() {
    const result = evaluate(profile());
    const unresolved = result.rows.filter(row => evidenceFindings(state.evidence[row.id], today()).length);
    const overdue = result.rows.filter(row => state.evidence[row.id]?.expiry && state.evidence[row.id].expiry < today());
    const services = serviceFindings(profile(), state.serviceChecks ?? []);
    summary.replaceChildren(el('p', { text: unresolved.length + ' requirements with unresolved decisions or incomplete evidence · ' + overdue.length + ' overdue reviews · ' + services.length + ' service checks outstanding' }));
  }
  const services = servicePanel(profile, state, persist, renderSummary);
  function sections() {
    const r = report();
    return [
      { title: 'Assessment selections', headers: ['Field', 'Value'], rows: Object.entries(r.profile).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]) },
      { title: 'Open decisions', text: r.issues.join(' · ') || 'No profile findings.', headers: ['Requirement', 'Outstanding items'], rows: r.rows.map(row => [row.id, evidenceFindings(state.evidence[row.id], today()).join(' · ') || 'Evidence recorded']) },
      { title: 'Requirements and evidence', headers: ['Requirement', 'Trigger / action', 'Applicability / decision', 'Evidence', 'Owner / status', 'Verified / review due', 'Source'], rows: r.rows.map(row => {
        const e = state.evidence[row.id] ?? {};
        return [row.id, row.reason + ' ' + row.action, (e.applicability || 'Review required') + ' · ' + (e.decision || ''), e.link, (e.owner || '') + ' · ' + (e.status || 'Missing'), (e.verified || '') + ' / ' + (e.expiry || ''), row.source];
      }) },
      { title: 'Service availability checks', headers: ['Service', 'Offering / region', 'Status', 'Evidence', 'Verified'], rows: (state.serviceChecks ?? []).map(row => [row.service, row.offering + ' / ' + row.region, row.status, row.reference, row.verified]) },
    ];
  }
  function render() {
    const result = evaluate(profile());
    const rows = result.rows.map(rule => {
      const evidence = state.evidence[rule.id] ?? {};
      const applicability = dropdown('Applicability · ' + rule.id, ['Review required', 'Applicable', 'Not applicable'], evidence.applicability ?? 'Review required');
      const progress = dropdown('Evidence status · ' + rule.id, ['Missing', 'In progress', 'Ready', 'Approved'], evidence.status ?? 'Missing');
      const assignee = textField('Owner · ' + rule.id, evidence.owner ?? '');
      const link = textField('Evidence reference · ' + rule.id, evidence.link ?? '');
      const expiry = textField('Review / expiration · ' + rule.id, evidence.expiry ?? '', 'date');
      const verified = textField('Verified on · ' + rule.id, evidence.verified ?? '', 'date');
      const decision = textField('Decision rationale / approver · ' + rule.id, evidence.decision ?? '');
      const finding = el('p', { class: 'section-note' });
      function drawFinding() {
        const issues = [];
        if (verified.input.value && verified.input.value > today()) issues.push('Verification date is in the future');
        if (expiry.input.value && expiry.input.value < today()) issues.push('Review overdue');
        if (['Ready', 'Approved'].includes(progress.input.value) && (!assignee.input.value.trim() || !link.input.value.trim())) issues.push('Evidence owner and reference required');
        if (applicability.input.value === 'Not applicable' && !decision.input.value.trim()) issues.push('Record the applicability rationale');
        if (progress.input.value === 'Approved' && !decision.input.value.trim()) issues.push('Record the approver and decision');
        finding.hidden = !issues.length;
        finding.textContent = issues.join(' · ');
      }
      drawFinding();
      for (const item of [applicability, progress, assignee, link, expiry, verified, decision]) item.input.addEventListener('change', () => {
        state.evidence[rule.id] = { applicability: applicability.input.value, status: progress.input.value,
          owner: assignee.input.value, link: link.input.value, expiry: expiry.input.value, verified: verified.input.value, decision: decision.input.value };
        persist(); drawFinding(); renderSummary();
      });
      return [el('div', {}, el('strong', { text: rule.id }), el('p', { text: rule.reason }), el('a', { text: 'Rule source', attrs: { href: rule.source, target: '_blank', rel: 'noopener noreferrer' } })),
        el('div', {}, el('p', { text: rule.action }), applicability.control, decision.control),
        el('div', {}, progress.control, assignee.control, link.control, verified.control, expiry.control, finding)];
    });
    output.replaceChildren(
      el('p', { class: 'muted', text: 'Candidate requirements update with your selections. Record applicability and approval with the responsible owner.' }),
      ...result.issues.map(text => el('p', { class: 'section-note', text })),
      table(['Requirement / trigger', 'Action and applicability', 'Evidence'], rows));
    renderSummary();
  }
  const inputs = el('div', { class: 'field-grid' }, ...[name, owner, organization, hosting, platform, offering, region, boundary, destination, authority].map(item => item.control));
  const selection = el('div', { class: 'field-grid' }, data.control, locations.control, selected.control);
  for (const area of [inputs, selection]) area.addEventListener('change', () => { persist(); render(); if (area === inputs) void services.refresh(); });
  const importer = jsonImport('Import assessment', value => {
    if (value?.schema !== 'archtoolkit.governance.v1' || !validAssessment(value)) throw Error('Choose a valid Governance assessment export.');
    persist(); state = newAssessment(value.profile, value.evidence, value.serviceChecks ?? []);
    workspace.assessments.push(state); workspace.activeId = state.id; save(key, workspace, status); mount();
  }, status);
  const restore = jsonImport('Restore workspace backup', value => {
    const checked = validateWorkspace(value);
    if (!window.confirm('Replace the Governance workspace with this validated backup?')) return;
    exportJson('governance-before-restore', workspace);
    workspace = checked; state = workspace.assessments.find(item => item.id === workspace.activeId);
    save(key, workspace, status); mount();
  }, status);
  function activate(item) {
    workspace.assessments.push(item); workspace.activeId = item.id; state = item; save(key, workspace, status); mount();
  }
  const management = card('Assessments', assessmentSelect, el('div', { class: 'btn-row' },
    button('New assessment', () => { persist(); activate(newAssessment()); }),
    button('Duplicate assessment', () => { persist(); activate(newAssessment({ ...structuredClone(state.profile), name: (state.profile.name || 'Untitled assessment') + ' — copy' }, structuredClone(state.evidence), structuredClone(state.serviceChecks ?? []))); }),
    button(state.archived ? 'Unarchive assessment' : 'Archive assessment', () => { persist(); state.archived = !state.archived; save(key, workspace, status); mount(); }),
    button('Download workspace backup', () => { persist(); exportJson('governance-workspace-backup', validateWorkspace(workspace)); }), restore));
  root.replaceChildren(management, card('Governance assessment', inputs, offeringSource, selection, el('div', { class: 'btn-row' },
    button('Download printable report', () => { persist(); downloadReport('governance-report', state.profile.name || 'Governance assessment', sections()); }),
    button('Download assessment JSON', () => { persist(); exportJson('governance-assessment', report()); }),
    button('Download checklist CSV', () => { persist(); const r = report(); exportCsv('governance-checklist', r.rows.map(row => ({ requirement: row.id, trigger: row.reason, action: row.action, source: row.source, ...state.evidence[row.id] }))); }), importer), status), card('Assessment summary', summary), card('Service availability', services.element), card('Applicability and evidence register', output));
  render(); void services.refresh();
}
mount();

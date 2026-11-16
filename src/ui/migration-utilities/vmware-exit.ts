import { EXIT_TARGETS, EXIT_PROFILES, DATA_HANDLING, EXIT_PHASES, EXIT_POLICY_REFERENCES, federalChecks, vmwareExitProject, type DataHandling, type ExitProfile } from '../../multicloud/plan/dcexit/vmware-exit.ts';
import { card } from '../components.ts';
import { downloadFile, el, append } from '../dom.ts';
import { button, buttonRow, dropdown, labelled } from '../application-migration/kit.ts';
import { fill, note, rowsTable } from '../multicloud/pane-kit.ts';
import { planModel } from '../multicloud/plan-model.ts';
import { wavePlanFor } from '../multicloud/wave-model.ts';
import type { PaneContext } from '../plan-shell.ts';

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
const link = (href: string, text: string) => el('a', { text, attrs: { href } });

export function mount(root: HTMLElement, ctx: PaneContext): void {
  let source = 'VMware vSphere';
  let profile: ExitProfile = 'Department of State';
  let handling: DataHandling = 'Unassessed';
  const selected = new Set<string>();
  const controls = el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } });
  const checks = el('div', { attrs: { 'data-control': 'vmware-exit-checks' } });
  const status = el('p', { class: 'small', attrs: { role: 'status' } });
  const refresh = () => {
    fill(checks, el('ul', {}, ...federalChecks(profile, handling).map((text) => el('li', { text }))));
    status.textContent = `${selected.size} destinations selected`;
  };
  const download = button('Download project plan', () => {
    if (selected.size === 0) {
      status.textContent = 'Select at least one destination.';
      return;
    }
    try {
      const plan = ctx.session.plan();
      const model = planModel(plan);
      if (model.failure) throw new Error(model.failure);
      const waves = wavePlanFor(plan, model.decision);
      downloadFile('vmware-exit-project.md', vmwareExitProject(plan, waves, EXIT_TARGETS.filter((target) => selected.has(target.id)), source, profile, handling), 'text/markdown');
      status.textContent = 'Project plan downloaded.';
    } catch (e) {
      status.textContent = `Could not generate the project plan. ${e instanceof Error ? e.message : String(e)}`;
    }
  }, { primary: true, control: 'vmware-exit-download' });
  append(controls,
    labelled('VMware source', dropdown(options(['VMware vSphere', 'VMware Cloud Foundation']), source, (value) => { source = value; }, { label: 'VMware source' })),
    labelled('Governance profile', dropdown(options(EXIT_PROFILES), profile, (value) => { profile = value as ExitProfile; refresh(); }, { label: 'Governance profile' })),
    labelled('Data handling', dropdown(options(DATA_HANDLING), handling, (value) => { handling = value as DataHandling; refresh(); }, { label: 'Data handling' })));
  const destinationOption = (target: (typeof EXIT_TARGETS)[number]) => {
    const checkbox = el('input', { attrs: { type: 'checkbox', 'aria-label': `Include ${target.name}` } }) as HTMLInputElement;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(target.id);
      else selected.delete(target.id);
      refresh();
    });
    return el('label', { class: 'checkbox' }, checkbox, el('span', { text: target.name }));
  };
  const destinationGroups = [
    { label: 'Available in the ArchToolKit execution kit', targets: EXIT_TARGETS.filter((target) => target.delivery === 'existing-kit') },
    { label: 'Vendor workflows and government environments to qualify', targets: EXIT_TARGETS.filter((target) => target.delivery === 'integration-needed') },
  ];
  append(root,
    card('VMware exit project',
      controls,
      el('h3', { text: 'Choose destinations' }),
      ...destinationGroups.map(({ label, targets }) => el('fieldset', {},
        el('legend', { text: label }),
        el('div', { class: 'checkbox-grid' }, ...targets.map(destinationOption)))),
      note('Use unclassified metadata. You can include several destinations in the project plan.'),
      buttonRow(download, status)),
    card('Discovery through decommission',
      rowsTable(['Phase', 'Owner', 'Exit evidence'], EXIT_PHASES.map((phase) => [phase.name, phase.owner, phase.evidence])),
      el('p', {}, link('migration.html#sources', 'Import inventory and dependencies'), ' · ', link('#landing-zones', 'Design the landing zone'), ' · ',
        link('#waves', 'Plan waves'), ' · ', link('#generate', 'Generate Terraform and Ansible'), ' · ', link('#execute', 'Execute and track cutover'))),
    el('details', { class: 'card' },
      el('summary', { text: 'Source and destination coverage' }),
      rowsTable(['Platform', 'As a source', 'Transfer path'], EXIT_TARGETS.map((target) => [
        target.name, target.source,
        el('div', {}, target.transfer, target.reference ? el('div', {}, link(target.reference, 'Vendor documentation')) : null),
      ]))),
    card('Authorization and data handling', checks,
      el('details', {}, el('summary', { text: 'Policy references' }),
        el('ul', {}, ...EXIT_POLICY_REFERENCES.map(([title, url]) => el('li', {}, link(url, title)))))));
  refresh();
}

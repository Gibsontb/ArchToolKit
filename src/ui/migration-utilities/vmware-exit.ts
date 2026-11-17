import { EXIT_TARGETS, EXIT_PROFILES, DATA_HANDLING, HOSTED_VMWARE_SERVICES, PROJECT_DESTINATION_KEY, vmwareExitProject, type DataHandling, type ExitProfile } from '../../multicloud/plan/dcexit/vmware-exit.ts';
import { PLAN_MODE_OPTIONS, PLATFORM_OPTIONS, SOURCE_PLATFORM_OPTIONS, labelOf, overrideKey } from '../../multicloud/plan/options.ts';
import type { MovePath, PlanMode, SourcePlatform } from '../../multicloud/plan/types.ts';
import { EXEC_TARGET_VALUES, validPathsFor } from '../../multicloud/plan/execute/matrix.ts';
import { pathLabel } from '../../multicloud/plan/execute/paths.ts';
import { utilitiesFor } from '../../multicloud/change/index.ts';
import { compareApp } from '../../multicloud/plan/apps/compare.ts';
import { appWorkloads, appDatabases } from '../../multicloud/plan/apps/components.ts';
import { allFields } from '../../multicloud/wizard/steps.ts';
import { card } from '../components.ts';
import { downloadFile, el, append } from '../dom.ts';
import { button, buttonRow, dropdown, labelled } from '../application-migration/kit.ts';
import { fill, note, rowsTable } from '../multicloud/pane-kit.ts';
import { planModel } from '../multicloud/plan-model.ts';
import { wavePlanFor } from '../multicloud/wave-model.ts';

import type { PaneContext } from '../plan-shell.ts';

const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }));
const link = (href: string, text: string) => el('a', { text, attrs: { href } });
const governmentEnvironment: Readonly<Record<string, string>> = { aws: 'govcloud', azure: 'azure-government' };
const providerTargets = EXIT_TARGETS.filter((target) => !Object.values(governmentEnvironment).includes(target.id));
const fromOptions = [
  ...SOURCE_PLATFORM_OPTIONS.filter((option) => option.value !== 'other'),
  ...providerTargets.filter((target) => !SOURCE_PLATFORM_OPTIONS.some((option) => option.value === target.id))
    .map((target) => ({ value: target.id, label: target.name })),
  ...SOURCE_PLATFORM_OPTIONS.filter((option) => option.value === 'other'),
];
const deploymentOptions = [
  ...PLATFORM_OPTIONS,
  ...providerTargets.filter((target) => target.delivery === 'integration-needed')
    .map((target) => ({ value: target.id, label: target.name })),
];
const transferStyles = allFields().find((field) => field.id === 'cutoverStrategy')?.options ?? [];
const vmwareVendorMethods: Readonly<Record<string, readonly string[]>> = {
  ahv: ['Nutanix Move'],
  openshift: ['MTV warm migration', 'MTV cold migration'],
  'azure-local': ['Azure Migrate portal', 'Azure Migrate PowerShell', 'Azure Migrate CLI', 'Azure Migrate Terraform'],
  hyperv: ['VM conversion to Hyper-V', 'Rebuild and restore'],
  hpe: ['VM Essentials vCenter-to-HVM bulk migration'],
  openstack: ['Convert and import the VM image', 'Rebuild and restore'],
  olvm: ['virt-v2v', 'Oracle Linux Automation Manager'],
  proxmox: ['ESXi import wizard', 'Offline OVF and disk import'],
  harvester: ['Harvester VM Import'],
  govcloud: ['AWS Transform MGN, subject to GovCloud qualification'],
  'azure-government': ['Azure Migrate, subject to Azure Government qualification'],
};

export function sourceForPath(value: string): SourcePlatform | undefined {
  const mapped = value === 'vcf' || value === 'vmware-cloud' ? 'vsphere' : value === 'olvm' ? 'ovirt' : value;
  return SOURCE_PLATFORM_OPTIONS.find((option) => option.value === mapped)?.value;
}

export function projectPathOptions(from: string, to: string, mode: PlanMode): readonly MovePath[] {
  const source = sourceForPath(from);
  const target = EXEC_TARGET_VALUES.find((key) => key === to);
  return source && target && mode !== 'database' ? validPathsFor(source, target) : [];
}

export function mount(root: HTMLElement, ctx: PaneContext): void {
  const preset = new URLSearchParams(ctx.arg());
  const provider = preset.get('provider') ?? '';
  const preferredCutover = preset.get('cutover') ?? '';
  const requestedSource = preset.get('source') ?? '';
  const requestedEnvironment = preset.get('environment');
  const hostedKey = overrideKey('vmware-cloud', 'vendor-lz', 'service');
  const requestedHosted = preset.get('hosted') ?? ctx.session.plan().designOverrides[hostedKey];
  let hostedService = HOSTED_VMWARE_SERVICES.find((item) => item.value === requestedHosted)?.value ?? '';
  let source = fromOptions.some((entry) => entry.value === requestedSource) ? requestedSource : '';
  const platformPreset = provider === 'vcf' ? 'vmware' : provider;
  let platform = deploymentOptions.some((entry) => entry.value === platformPreset) ? platformPreset : '';
  let profile: ExitProfile = 'Department of State';
  let handling: DataHandling = 'Unassessed';
  let cutover = transferStyles.some((entry) => entry.value === preferredCutover) ? preferredCutover : '';
  const savedTarget = ctx.session.plan().designOverrides[PROJECT_DESTINATION_KEY];
  const savedProvider = Object.keys(governmentEnvironment).find((key) => governmentEnvironment[key] === savedTarget) ?? savedTarget;
  let destination = providerTargets.some((entry) => entry.id === provider) ? provider
    : providerTargets.some((entry) => entry.id === savedProvider) ? savedProvider! : '';
  const paths = new Map<string, string>();
  const environments = new Map<string, string>();
  if (provider && requestedEnvironment === governmentEnvironment[provider]) {
    environments.set(provider, requestedEnvironment);
  } else if (provider && requestedEnvironment === 'commercial') {
    environments.set(provider, provider);
  } else if (!provider && savedProvider && savedProvider !== savedTarget) {
    environments.set(savedProvider, savedTarget!);
  }
  const utilityPage = ctx.page === 'migration-utilities' ? '' : 'multicloud.html';
  const appPage = ctx.page === 'application-migration' ? '' : 'migration.html';
  const modeNow = (): PlanMode => ctx.session.plan().mode ?? 'migrate';
  const controls = () => el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } });
  let serviceId = '';

  function drawServiceReview(mode: 'assess' | 'retire'): void {
    const result = el('div', { class: 'stack' });
    const plan = ctx.session.plan();
    const compare = mode === 'assess';
    const renderService = () => {
      const current = ctx.session.plan();
      const app = current.apps.find((entry) => entry.id === serviceId);
      if (!app) { fill(result); return; }
      if (compare) {
        const comparison = compareApp(current, app.id);
        fill(result, rowsTable(['Platform', 'Eligibility', 'Score', 'Findings'], comparison.columns.map((column) => [
          column.label,
          column.verdict.eligible ? column.verdict.recommended ? 'Recommended' : column.verdict.withGaps ? 'Eligible with gaps' : 'Eligible' : 'Ineligible',
          String(column.verdict.score),
          column.findings.list.filter((finding) => finding.severity !== 'info').map((finding) => finding.message).join(' · '),
        ])));
        return;
      }
      const workloads = appWorkloads(current, app);
      const databases = appDatabases(current, app);
      const members = new Set([app.name, ...workloads.map((item) => item.name), ...databases.map((item) => item.name)]);
      const dependencies = current.edges.filter((edge) => members.has(edge.from) !== members.has(edge.to));
      const checks = [
        'Confirm owners and resolve dependencies before scheduling the shutdown.',
        'Check records retention and legal holds. Export the required data, take a final backup, and verify restore.',
        'Approve the change window, shutdown, rollback plan, and final decommissioning.',
        'After acceptance, remove monitoring, DNS, access and inventory entries and reconcile licenses and assets.',
      ];
      fill(result,
        rowsTable(['Servers', 'Databases', 'Cross-service dependencies'], [[String(workloads.length), String(databases.length), String(dependencies.length)]]),
        dependencies.length ? rowsTable(['From', 'To', 'Type'], dependencies.map((edge) => [edge.from, edge.to, edge.kind])) : null,
        button('Download retirement plan', () => downloadFile('service-retirement.md', [
          '# Retirement plan for ' + app.name, '',
          '## Scope', '', 'Servers: ' + (workloads.map((item) => item.name).join(', ') || 'None recorded'),
          'Databases: ' + (databases.map((item) => item.name).join(', ') || 'None recorded'), '',
          '## Dependencies to review', '',
          ...(dependencies.length ? dependencies.map((edge) => '- ' + edge.from + ' → ' + edge.to + ' (' + edge.kind + ')') : ['- None recorded. Verify with the application owner.']),
          '', '## Approval checklist', '', ...checks.map((text) => '- [ ] ' + text), '',
        ].join('\n'), 'text/markdown'), { primary: true }));
    };
    fill(root, card(labelOf(PLAN_MODE_OPTIONS, mode),
      plan.apps.length ? labelled('Application', dropdown(plan.apps.map((app) => ({ value: app.id, label: app.name })), serviceId, (value) => {
        serviceId = value;
        renderService();
      }, { label: 'Application', blank: 'Choose an application' })) : link(appPage + '#sources', 'Import application inventory'),
      compare ? link('../app/migration-readiness.html', 'Readiness assessment') : null,
      result));
    renderService();
  }

  function drawLandingZone(): void {
    const actions = el('div');
    const refresh = () => {
      const target = environments.get(platform) || (platform === 'vcf' ? 'vmware' : platform);
      fill(actions, target ? link(utilityPage + '#landing-zones:' + target, 'Open landing-zone design') : null);
    };
    fill(root, card('Build a landing zone', labelled('Platform',
      dropdown(deploymentOptions, platform, (value) => { platform = value; refresh(); }, {
        label: 'Platform', blank: 'Choose a platform',
      })), actions));
    refresh();
  }

  function drawOperations(mode: PlanMode): void {
    const picker = controls();
    const actions = el('div', { class: 'stack' });
    const refresh = () => {
      if (!platform) {
        fill(actions);
        return;
      }
      const native = PLATFORM_OPTIONS.find((option) => option.value === platform)?.value;
      if (!native) {
        const target = EXIT_TARGETS.find((entry) => entry.id === platform);
        fill(actions, note('This platform uses a vendor workflow. Toolkit deployment and operations integration is pending.'),
          target?.reference ? link(target.reference, 'Vendor documentation') : null);
        return;
      }
      const supported = utilitiesFor(native);
      const relevant = mode === 'new' ? supported.filter((utility) => utility.id === 'deploy-service') : supported.filter((utility) => utility.id !== 'deploy-service');
      fill(actions,
        mode === 'new' ? el('p', {}, link(appPage + '#app:/new-service:' + native, 'Open new-service design')) : null,
        relevant.length ? el('ul', {}, ...relevant.map((utility) => el('li', {}, link(
          utilityPage + '#utilities:' + utility.id + '/platform=' + encodeURIComponent(platform), utility.label))))
          : note('The toolkit has no utility for this action on the selected platform.'));
    };
    append(picker, labelled(mode === 'new' ? 'Deploy to' : 'Platform in use',
      dropdown(deploymentOptions, platform, (value) => { platform = value; refresh(); }, {
        label: mode === 'new' ? 'Deploy to' : 'Platform in use', blank: 'Choose a platform',
      })));
    fill(root, card(mode === 'new' ? 'Add a service' : mode === 'maintenance' ? 'Maintenance / operations' : 'Change an existing service', picker, actions));
    refresh();
  }

  function drawMigration(mode: PlanMode): void {
    const fields = controls();
    const destinationSettings = controls();
    const status = el('p', { class: 'small', attrs: { role: 'status' } });
    const targets = providerTargets.toSorted((a, b) => a.name.localeCompare(b.name));
    const selectedTarget = () => EXIT_TARGETS.find((entry) => entry.id === (environments.get(destination) || destination));
    const methodsFor = (target: (typeof EXIT_TARGETS)[number]) => {
      if (mode === 'database') return [];
      const available = projectPathOptions(source, target.id, mode);
      if (available.length) return available.map((value) => ({ value, label: pathLabel(value) }));
      return sourceForPath(source) === 'vsphere' ? options(vmwareVendorMethods[target.id] ?? []) : [];
    };

    const drawDestination = () => {
      const target = targets.find((item) => item.id === destination);
      if (!target) { fill(destinationSettings); return; }
      const pathDetail = el('div', { style: { flex: '1 1 10rem' } });
      const showPath = () => {
        const resolved = selectedTarget();
        const available = resolved && source ? methodsFor(resolved) : [];
        fill(pathDetail, resolved && available.length
          ? labelled('Migration path', dropdown(available, paths.get(resolved.id) ?? available[0]!.value,
            (value) => paths.set(resolved.id, value), { label: 'Migration path' }))
          : null);
        pathDetail.hidden = available.length === 0;
      };
      const government = EXIT_TARGETS.find((entry) => entry.id === governmentEnvironment[target.id]);
      fill(destinationSettings, target.id === 'vmware-cloud' ? labelled('Hosted VMware service', dropdown(HOSTED_VMWARE_SERVICES, hostedService, (value) => {
        hostedService = HOSTED_VMWARE_SERVICES.find((item) => item.value === value)?.value ?? '';
      }, { label: 'Hosted VMware service', blank: 'Choose a service' })) : null, government ? labelled('Cloud environment', dropdown([
        { value: target.id, label: 'Commercial' },
        { value: government.id, label: government.name },
      ], environments.get(target.id) ?? '', (value) => {
        environments.set(target.id, value);
        showPath();
      }, { label: 'Cloud environment', blank: 'Decide later' })) : null, pathDetail);
      showPath();
    };

    const ready = () => {
      if (source && destination) return true;
      status.textContent = 'Choose a source and destination.';
      return false;
    };
    const download = button('Download project plan', () => {
      const target = selectedTarget();
      if (!ready() || !target) return;
      try {
        const plan = ctx.session.plan();
        const model = planModel(plan);
        if (model.failure) throw new Error(model.failure);
        const waves = wavePlanFor(plan, model.decision);
        const available = methodsFor(target);
        const chosen = available.find((option) => option.value === paths.get(target.id)) ?? available[0];
        const sourceName = labelOf(fromOptions, source);
        const markdown = vmwareExitProject(plan, waves, [target], sourceName, profile, handling, {
          activity: labelOf(PLAN_MODE_OPTIONS, mode),
          cutover: labelOf(transferStyles, cutover),
          hostedService: labelOf(HOSTED_VMWARE_SERVICES, hostedService),
          paths: chosen ? { [target.id]: chosen.label } : {},
          environments: governmentEnvironment[target.id]
            ? { [target.id]: environments.get(target.id) ? 'Commercial' : 'Decide during planning' } : {},
        });
        downloadFile(sourceName.startsWith('VMware') ? 'vmware-exit-project.md' : 'migration-project.md', markdown, 'text/markdown');
        status.textContent = 'Project plan downloaded.';
      } catch (e) {
        status.textContent = 'Could not generate the project plan. ' + (e instanceof Error ? e.message : String(e));
      }
    }, { control: 'vmware-exit-download' });
    append(fields,
      labelled('Move from', dropdown(fromOptions, source, (value) => {
        source = value;
        paths.clear();
        status.textContent = '';
        drawDestination();
      }, { label: 'Move from', blank: 'Choose a source platform' })),
      labelled('Move to', dropdown(targets.map((target) => ({ value: target.id, label: target.name })), destination, (value) => {
        destination = value;
        status.textContent = '';
        drawDestination();
      }, { label: 'Move to', blank: 'Choose a destination platform' })),
      labelled('Cutover approach', dropdown(transferStyles, cutover, (value) => { cutover = value; }, { label: 'Cutover approach', blank: 'Decide later' })),
      labelled('Governance profile', dropdown(options(EXIT_PROFILES), profile, (value) => { profile = value as ExitProfile; }, { label: 'Governance profile' })),
      labelled('Data handling', dropdown(options(DATA_HANDLING), handling, (value) => { handling = value as DataHandling; }, { label: 'Data handling' })));
    const proceed = button(mode === 'database' ? 'Continue to databases' : 'Continue to source inventory', async () => {
      if (!ready()) return;
      const target = selectedTarget();
      if (target) {
        ctx.session.update((plan) => ({
          ...plan, designOverrides: {
            ...plan.designOverrides,
            [PROJECT_DESTINATION_KEY]: target.id,
            ...(target.id === 'vmware-cloud' ? { [hostedKey]: hostedService } : {}),
          },
        }));
      }
      if (mode === 'database' && ctx.page === 'migration-utilities') {
        await ctx.session.save();
        location.href = 'migration.html#databases';
      } else {
        ctx.go(mode === 'database' ? 'databases' : ctx.page === 'application-migration' ? 'sources' : 'source-inventory');
      }
    }, { primary: true, control: 'project-setup-continue' });
    fill(root, card(labelOf(PLAN_MODE_OPTIONS, mode), fields, destinationSettings, buttonRow(proceed, download, status)));
    drawDestination();
  }
  let rendered: PlanMode | undefined;
  const draw = () => {
    const mode = modeNow();
    if (mode === rendered) return;
    if (rendered !== undefined) paths.clear();
    rendered = mode;
    if (mode === 'assess' || mode === 'retire') drawServiceReview(mode);
    else if (mode === 'landing-zone') drawLandingZone();
    else if (mode === 'new' || mode === 'change' || mode === 'maintenance') drawOperations(mode);
    else drawMigration(mode);
  };
  ctx.session.subscribe(draw);
  draw();
}

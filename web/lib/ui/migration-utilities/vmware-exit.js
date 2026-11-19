import { EXIT_TARGETS, EXIT_PROFILES, DATA_HANDLING, HOSTED_VMWARE_SERVICES, PROJECT_CLOUD_REGIONS, PROJECT_DESTINATION_KEY, vmwareExitProject,                                     } from '../../multicloud/plan/dcexit/vmware-exit.js';
import { PLAN_MODE_OPTIONS, PLATFORM_OPTIONS, SOURCE_PLATFORM_OPTIONS, labelOf, overrideKey } from '../../multicloud/plan/options.js';
                                                                                         
import { EXEC_TARGET_VALUES, validPathsFor } from '../../multicloud/plan/execute/matrix.js';
import { pathLabel } from '../../multicloud/plan/execute/paths.js';
import { utilitiesFor } from '../../multicloud/change/index.js';
import { compareApp } from '../../multicloud/plan/apps/compare.js';
import { appWorkloads, appDatabases } from '../../multicloud/plan/apps/components.js';
import { allFields } from '../../multicloud/wizard/steps.js';
import { card } from '../components.js';
import { downloadFile, el, append } from '../dom.js';
import { button, buttonRow, dropdown, labelled } from '../application-migration/kit.js';
import { fill, note, rowsTable } from '../multicloud/pane-kit.js';
import { planModel } from '../multicloud/plan-model.js';
import { wavePlanFor } from '../multicloud/wave-model.js';
import { loadInventory } from '../../kit/estate-store.js';
import { zip } from '../../kit/archive.js';
import { PROXMOX_OVF_IMPORT } from '../../multicloud/plan/dcexit/proxmox.js';
import { prefillVmwareInventory } from '../multicloud/sources-model.js';
import { vendorLandingZoneCard } from '../multicloud/vendor-landing-zone.js';

                                                    

const options = (values                   ) => values.map((value) => ({ value, label: value }));
const link = (href        , text        ) => el('a', { text, attrs: { href } });
const governmentEnvironment                                   = { aws: 'govcloud', azure: 'azure-government' };
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
const operationsOptions = [
  ...deploymentOptions,
  ...fromOptions.filter((option) => option.value !== 'other'
    && !deploymentOptions.some((platform) => platform.value === option.value)),
];
const transferStyles = allFields().find((field) => field.id === 'cutoverStrategy')?.options ?? [];
const vmwareVendorMethods                                              = {
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

export function sourceForPath(value        )                             {
  const mapped = value === 'vcf' || value === 'vmware-cloud' ? 'vsphere' : value === 'olvm' ? 'ovirt' : value;
  return SOURCE_PLATFORM_OPTIONS.find((option) => option.value === mapped)?.value;
}

export function projectPathOptions(from        , to        , mode          )                      {
  const source = sourceForPath(from);
  const target = EXEC_TARGET_VALUES.find((key) => key === to);
  return source && target && mode !== 'database' ? validPathsFor(source, target) : [];
}

export function mount(root             , ctx             )       {
  const multiCloud = ctx.page === 'migration-utilities';
  const currentPlatformOptions = multiCloud ? operationsOptions : deploymentOptions;
  const preset = new URLSearchParams(ctx.arg());
  const provider = preset.get('provider') ?? '';
  const preferredCutover = preset.get('cutover') ?? '';
  const requestedSource = preset.get('source') ?? '';
  const requestedEnvironment = preset.get('environment');
  const requestedRegion = preset.get('region') ?? '';
  const hostedKey = overrideKey('vmware-cloud', 'vendor-lz', 'service');
  const requestedHosted = preset.get('hosted') ?? ctx.session.plan().designOverrides[hostedKey];
  let hostedService = HOSTED_VMWARE_SERVICES.find((item) => item.value === requestedHosted)?.value ?? '';
  let source = fromOptions.some((entry) => entry.value === requestedSource) ? requestedSource : '';
  const platformPreset = provider === 'vcf' ? 'vmware' : provider;
  let platform = currentPlatformOptions.some((entry) => entry.value === platformPreset) ? platformPreset : '';
  let profile              = 'Department of State';
  let handling               = 'Unassessed';
  let cutover = transferStyles.some((entry) => entry.value === preferredCutover) ? preferredCutover : '';
  const savedTarget = ctx.session.plan().designOverrides[PROJECT_DESTINATION_KEY];
  const savedProvider = Object.keys(governmentEnvironment).find((key) => governmentEnvironment[key] === savedTarget) ?? savedTarget;
  let destination = providerTargets.some((entry) => entry.id === provider) ? provider
    : providerTargets.some((entry) => entry.id === savedProvider) ? savedProvider  : '';
  const paths = new Map                ();
  const environments = new Map                ();
  if (provider && requestedEnvironment === governmentEnvironment[provider]) {
    environments.set(provider, requestedEnvironment);
  } else if (provider && requestedEnvironment === 'commercial') {
    environments.set(provider, provider);
  } else if (!provider && savedProvider && savedProvider !== savedTarget) {
    environments.set(savedProvider, savedTarget );
  }
  const primaryRegions = new Map                ();
  const initialTarget = environments.get(provider) || provider;
  if (multiCloud && PROJECT_CLOUD_REGIONS[initialTarget]?.includes(requestedRegion)) primaryRegions.set(initialTarget, requestedRegion);
  const utilityPage = ctx.page === 'migration-utilities' ? '' : 'multicloud.html';
  const appPage = ctx.page === 'application-migration' ? '' : 'migration.html';
  const modeNow = ()           => ctx.session.plan().mode ?? 'migrate';
  const controls = () => el('div', { class: 'btn-row', style: { flexWrap: 'wrap' } });
  let serviceId = '';

  function drawServiceReview(mode                     )       {
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

  function drawLandingZone()       {
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

  function drawOperations(mode          )       {
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
      dropdown(mode === 'new' ? deploymentOptions : currentPlatformOptions, platform, (value) => { platform = value; refresh(); }, {
        label: mode === 'new' ? 'Deploy to' : 'Platform in use', blank: 'Choose a platform',
      })));
    fill(root, card(mode === 'new' ? 'Add a service' : mode === 'maintenance' ? 'Maintenance / operations' : 'Change an existing service', picker, actions));
    refresh();
  }

  function drawMigration(mode          )       {
    const fields = controls();
    const destinationSettings = controls();
    const destinationSetup = el('div', { class: 'stack', attrs: { 'data-control': 'destination-setup' } });
    const outputs = el('div', { class: 'stack', attrs: { 'data-control': 'migration-outputs' } });
    const status = el('p', { class: 'small', attrs: { role: 'status' } });
    const targets = providerTargets.toSorted((a, b) => a.name.localeCompare(b.name));
    const selectedTarget = () => EXIT_TARGETS.find((entry) => entry.id === (environments.get(destination) || destination));
    const isVmwareToProxmox = () => selectedTarget()?.id === 'proxmox' && sourceForPath(source) === 'vsphere' && mode !== 'database';
    const methodsFor = (target                               ) => {
      if (mode === 'database') return [];
      const available = projectPathOptions(source, target.id, mode);
      if (available.length) return available.map((value) => ({ value, label: pathLabel(value) }));
      return sourceForPath(source) === 'vsphere' ? options(vmwareVendorMethods[target.id] ?? []) : [];
    };

    const drawDestination = () => {
      const target = targets.find((item) => item.id === destination);
      if (!target) {
        fill(destinationSettings);
        fill(destinationSetup);
        showOutputs();
        return;
      }
      const pathDetail = el('div', { style: { flex: '1 1 10rem' } });
      const regionDetail = el('div', { style: { flex: '1 1 10rem' } });
      const showPath = () => {
        const resolved = selectedTarget();
        const regions = multiCloud && resolved ? PROJECT_CLOUD_REGIONS[resolved.id] : undefined;
        fill(regionDetail, resolved && regions ? labelled('Primary region', dropdown(options(regions),
          primaryRegions.get(resolved.id) ?? '', (value) => primaryRegions.set(resolved.id, value),
          { label: 'Primary region', blank: 'Choose a region' })) : null);
        regionDetail.hidden = !regions;
        const available = resolved && source ? methodsFor(resolved) : [];
        fill(pathDetail, resolved && available.length
          ? labelled('Migration path', dropdown(available, paths.get(resolved.id) ?? available[0] .value,
            (value) => paths.set(resolved.id, value), { label: 'Migration path' }))
          : null);
        pathDetail.hidden = available.length === 0;
        if (!multiCloud || !resolved) return;
        showOutputs();
        if (isVmwareToProxmox()) {
          fill(destinationSetup, el('details', {},
            el('summary', { text: 'Proxmox VE setup, VMware migration steps and import script' }),
            vendorLandingZoneCard(ctx, resolved, true)));
        } else {
          const route = resolved.id === 'vcf' ? 'vmware' : resolved.id;
          fill(destinationSetup, el('details', {},
            el('summary', { text: resolved.name + ' migration setup' }),
            el('ol', {}, ...[resolved.landing, resolved.transfer, resolved.validate].map((text) => el('li', { text }))),
            link(utilityPage + '#landing-zones:' + route, 'Open ' + resolved.name + ' landing-zone design'),
            resolved.reference ? el('p', {}, link(resolved.reference, 'Vendor documentation')) : null));
        }
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
      }, { label: 'Cloud environment', blank: 'Decide later' })) : null, regionDetail, pathDetail);
      showPath();
    };

    const ready = () => {
      if (source && destination) return true;
      status.textContent = 'Choose a source and destination.';
      return false;
    };
    const prefill = async () => {
      if (!multiCloud || sourceForPath(source) !== 'vsphere' || handling === 'Classified') return;
      const estate = await loadInventory();
      if (!estate || sourceForPath(source) !== 'vsphere' || (handling                ) === 'Classified') return;
      const current = ctx.session.plan();
      const updated = prefillVmwareInventory(current, estate);
      if (updated !== current) ctx.session.update(() => updated, { immediate: true });
    };
    const openReport = (markdown        ) => {
      const dialog = el('dialog', {
        attrs: { 'aria-label': 'Full migration report' },
        style: { width: 'min(56rem, 94vw)', maxHeight: '90vh', overflow: 'auto' },
      })                     ;
      const report = el('div', { class: 'stack', attrs: { 'data-control': 'migration-report' } },
        ...markdown.trim().split(/\n{2,}/).map((block) => {
          const heading = /^(#{1,4}) (.+)$/.exec(block);
          if (heading) return el(heading[1] .length === 1 ? 'h2' : 'h3', { text: heading[2] });
          return el('p', { text: block, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });
        }));
      append(dialog, button('Close report', () => dialog.close()), report,
        button('Close report', () => dialog.close()));
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      append(root, dialog);
      dialog.showModal();
    };
    const downloadProject = async (output                             = 'plan') => {
      if (!ready()) return;
      try {
        await prefill();
        const target = selectedTarget();
        if (!ready() || !target) return;
        if (output === 'bundle' && (!isVmwareToProxmox() || handling === 'Classified')) return;
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
          primaryRegions: Object.fromEntries(primaryRegions),
          vmwareToProxmox: isVmwareToProxmox(),
          paths: chosen ? { [target.id]: chosen.label } : {},
          environments: governmentEnvironment[target.id]
            ? { [target.id]: environments.get(target.id) ? 'Commercial' : 'Decide during planning' } : {},
        });
        if (output === 'view') {
          openReport(markdown);
        } else if (output === 'bundle') {
          const archive = await zip({ 'migration-project.md': markdown, 'proxmox-ovf-import.sh': PROXMOX_OVF_IMPORT });
          downloadFile('vmware-to-proxmox.zip', archive, 'application/zip');
          status.textContent = 'Migration package downloaded.';
        } else {
          downloadFile(sourceForPath(source) === 'vsphere' ? 'vmware-exit-project.md' : 'migration-project.md', markdown, 'text/markdown');
          status.textContent = 'Project plan downloaded.';
        }
      } catch (e) {
        status.textContent = 'Could not generate the project plan. ' + (e instanceof Error ? e.message : String(e));
      }
    };
    const download = button('Download project plan', () => downloadProject(), { control: 'vmware-exit-download' });
    const showOutputs = () => {
      const target = selectedTarget();
      if (!multiCloud || !target || !source) { fill(outputs); return; }
      const bundle = isVmwareToProxmox() && handling !== 'Classified';
      const generator = target.delivery === 'existing-kit' && target.id !== 'vmware-cloud' && handling !== 'Classified';
      fill(outputs, card('Migration outputs',
        note(bundle ? 'The ZIP contains the Proxmox setup and migration runbook, plus the offline OVF import script.'
          : generator ? 'Download the procedures here. Generate infrastructure and automation files from the assigned workloads.'
            : 'Download the setup, migration and acceptance procedures for this route. Use the vendor tooling for execution.'),
        buttonRow(
          button('View full report', () => downloadProject('view'), { primary: true, control: 'view-migration-report' }),
          bundle ? button('Download Proxmox migration package', () => downloadProject('bundle'), { control: 'proxmox-migration-package' }) : null,
          download,
          generator ? link(utilityPage + '#generate', 'Generate infrastructure and automation files') : null,
        )));
    };
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
      labelled('Governance profile', dropdown(options(EXIT_PROFILES), profile, (value) => { profile = value               ; }, { label: 'Governance profile' })),
      labelled('Data handling', dropdown(options(DATA_HANDLING), handling, (value) => {
        handling = value                ;
        showOutputs();
      }, { label: 'Data handling' })));
    const proceed = button(mode === 'database' ? 'Continue to databases' : 'Continue to source inventory', async () => {
      if (!ready()) return;
      try {
        await prefill();
      } catch (error) {
        status.textContent = 'Could not prefill from VMware inventory. ' + (error instanceof Error ? error.message : String(error));
        return;
      }
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
    fill(root, card(labelOf(PLAN_MODE_OPTIONS, mode), fields, destinationSettings,
      buttonRow(proceed, multiCloud ? null : download, status)), outputs, destinationSetup);
    drawDestination();
  }
  let rendered                      ;
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

import { EXIT_TARGETS, HOSTED_VMWARE_SERVICES } from '../lib/multicloud/plan/dcexit/vmware-exit.js';
import { SOURCE_PLATFORM_OPTIONS } from '../lib/multicloud/plan/options.js';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, OCI_REGIONS } from '../lib/kit/regions.js';

const wizard = document.querySelector('.app-shell');
for (const button of wizard?.querySelectorAll('button.primary, button.secondary') ?? []) {
  button.classList.add('btn');
  if (button.classList.contains('primary')) button.classList.add('btn-primary');
}

const initiative = document.getElementById('initiativeType');
const cloud = document.getElementById('cloudProvider');
if (initiative && cloud) mountFlow(initiative, cloud);

function mountFlow(initiative, cloud) {
  const providers = { azure: 'azure', aws: 'aws', gcp: 'google', oci: 'oci' };
  const regions = { aws: AWS_REGIONS, azure: AZURE_REGIONS, google: GCP_REGIONS, oci: OCI_REGIONS };
  const scopes = { 'single-app': 'single', portfolio: 'migrate', 'dc-estate': 'dc-exit', 'db-only': 'database' };
  const activities = { 'new-service': 'new', 'existing-service': 'change', maintenance: 'maintenance',
    assess: 'assess', 'landing-zone': 'landing-zone', retire: 'retire' };
  const directInitiatives = new Set(['assess', 'landing-zone', 'retire']);
  const environments = {
    aws: { id: 'govcloud', name: 'AWS GovCloud (US)', regions: ['us-gov-east-1', 'us-gov-west-1'] },
    azure: { id: 'azure-government', name: 'Azure Government', regions: ['usgovarizona', 'usgovtexas', 'usgovvirginia'] },
  };
  const alternatives = EXIT_TARGETS.filter((target) => !Object.values(providers).includes(target.id)
    && target.id !== 'govcloud' && target.id !== 'azure-government');
  const byId = (id) => document.getElementById(id);
  const selectField = (id, title) => {
    const row = document.createElement('div');
    row.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = title;
    const select = document.createElement('select');
    select.id = id;
    row.append(label, select);
    return { row, select };
  };
  const setOptions = (select, rows, empty) => {
    const previous = select.value;
    select.replaceChildren(new Option(empty, ''), ...rows.map(({ label, value }) => new Option(label, value)));
    if (rows.some(({ value }) => value === previous)) select.value = previous;
  };
  const initiativeLabel = wizard.querySelector('label[for=initiativeType]');
  if (initiativeLabel?.firstChild) initiativeLabel.firstChild.textContent = 'Initiative ';
  const activityLabels = {
    'new-service': 'Add a new service',
    'existing-service': 'Change an existing service',
    maintenance: 'Maintain or operate a service',
    migration: 'Migrate workloads or data',
  };
  for (const option of initiative.options) option.textContent = activityLabels[option.value] || 'Choose an activity';
  initiative.options[0].after(new Option('Assess or compare platforms', 'assess'), new Option('Build a landing zone', 'landing-zone'));
  initiative.add(new Option('Retire a service', 'retire'));
  const targetOptions = [
    ...Array.from(cloud.options, ({ value, text }) => ({ value, label: text })),
    ...alternatives.map(({ id, name }) => ({ value: id, label: name })),
  ].toSorted((a, b) => a.label.localeCompare(b.label));
  setOptions(cloud, targetOptions, 'Choose a platform');
  cloud.prepend(new Option('N/A', 'na'));
  cloud.value = '';
  const previousCloudLabel = cloud.closest('label');
  const target = selectField('cloudProvider', 'Move to');
  target.select.replaceWith(cloud);
  previousCloudLabel.remove();
  const source = selectField('wizardSourcePlatform', 'Platform Type');
  const additionalSources = EXIT_TARGETS.filter(({ id }) => id !== 'govcloud' && id !== 'azure-government' && id !== 'olvm'
    && !SOURCE_PLATFORM_OPTIONS.some((option) => option.value === id));
  const sourceOptions = [...SOURCE_PLATFORM_OPTIONS, ...additionalSources.map(({ id, name }) => ({ value: id, label: name }))]
    .filter((option) => option.value !== 'other')
    .map((option) => option.value === 'vsphere' ? { ...option, label: 'Broadcom VMware vSphere' } : option)
    .toSorted((a, b) => a.label.localeCompare(b.label));
  setOptions(source.select, sourceOptions, 'Choose a source platform');
  const hosted = selectField('wizardHostedVmware', 'Hosted VMware service');
  setOptions(hosted.select, HOSTED_VMWARE_SERVICES, 'Choose a service');
  const architecture = byId('architectureType').closest('.field');
  initiative.closest('.field').after(architecture, source.row, target.row, hosted.row);

  const environment = selectField('wizardCloudEnvironment', 'Cloud environment');
  const region = selectField('wizardTargetRegion', 'Primary region');
  byId('regionCount').closest('.field').after(environment.row, region.row);
  const next = document.createElement('a');
  next.className = 'btn';
  next.id = 'continueProject';
  next.textContent = 'Continue to project setup';
  byId('generateBtn').after(next);
  const nextPage = '../app/multicloud.html#vmware-exit:';
  const effectivePlatform = () => initiative.value === 'new-service' && (!cloud.value || cloud.value === 'na') ? source.select : cloud;
  const platformValue = () => effectivePlatform().value === 'na' ? '' : effectivePlatform().value;
  const publicProvider = () => providers[platformValue()];
  const providerId = () => publicProvider() || platformValue();
  const needsPlatform = () => initiative.value !== 'assess' && initiative.value !== 'retire';
  const direct = () => directInitiatives.has(initiative.value);
  let addingService = false;
  let moveSource = '';
  let moveTarget = '';
  let servicePlatform = '';
  let serviceTarget = '';

  const updatePlatformFields = () => {
    const newService = initiative.value === 'new-service';
    if (newService === addingService) return;
    addingService = newService;
    if (newService) {
      moveSource = source.select.value;
      moveTarget = cloud.value;
      setOptions(source.select, targetOptions, 'Choose a platform');
      source.select.value = servicePlatform;
      cloud.value = serviceTarget;
    } else {
      servicePlatform = source.select.value;
      serviceTarget = cloud.value;
      setOptions(source.select, sourceOptions, 'Choose a source platform');
      source.select.value = moveSource;
      cloud.value = moveTarget;
    }
    cloud.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const updateLink = () => {
    const mode = activities[initiative.value] || (initiative.value === 'migration' ? scopes[byId('migrationScope').value] || 'migrate' : '');
    const query = new URLSearchParams({ mode });
    if (needsPlatform() && providerId()) query.set('provider', providerId());
    const choices = {
      source: initiative.value === 'migration' ? source.select.value : '',
      cutover: byId('cutoverStrategy').value,
      environment: environment.select.value,
      region: region.select.value,
      hosted: platformValue() === 'vmware-cloud' ? hosted.select.value : '',
    };
    for (const [key, value] of Object.entries(choices)) if (value) query.set(key, value);
    const spec = platformValue() === 'vcf' && initiative.value === 'new-service';
    next.textContent = spec ? 'Continue to VCF design' : 'Continue to project setup';
    next.href = spec ? '../app/vcf-spec.html' : nextPage + query;
    next.hidden = !initiative.value || (needsPlatform() && !providerId());
  };
  const updateRegions = () => {
    const id = providerId();
    const government = environments[id];
    const available = government && environment.select.value === government.id ? government.regions : regions[id] ?? [];
    setOptions(region.select, available.map((value) => ({ value, label: value })), 'Choose a region');
    region.row.hidden = !available.length;
    updateLink();
  };
  const updateCloud = () => {
    queueMicrotask(() => {
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.style.removeProperty('--accent-soft');
    });
    const government = environments[providerId()];
    hosted.row.hidden = !needsPlatform() || platformValue() !== 'vmware-cloud';
    const choices = government ? [{ value: 'commercial', label: 'Commercial' }, { value: government.id, label: government.name }] : [];
    setOptions(environment.select, choices, 'Decide later');
    environment.row.hidden = !choices.length;
    if (!publicProvider()) {
      byId('cloudSubtitle').textContent = providerId() ? effectivePlatform().selectedOptions[0].textContent : 'Choose an activity and platform to start.';
      byId('resultsContent').style.display = 'none';
      for (const id of ['fullViewBtn', 'printBtn', 'exportWordBtn']) byId(id).disabled = true;
    }
    byId('generateBtn').textContent = publicProvider() && !direct() ? 'Generate recommendation' : 'Continue';
    updateRegions();
  };
  const updateInitiative = () => {
    updatePlatformFields();
    hosted.row.hidden = !needsPlatform() || platformValue() !== 'vmware-cloud';
    updateLink();
    byId('generateBtn').textContent = publicProvider() && !direct() ? 'Generate recommendation' : 'Continue';
  };
  wizard.addEventListener('change', updateLink);
  cloud.addEventListener('change', updateCloud);
  initiative.addEventListener('change', updateInitiative);
  environment.select.addEventListener('change', updateRegions);
  source.select.addEventListener('change', () => {
    if (addingService) {
      cloud.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const broadSource = byId('sourceEnv');
    if (broadSource.value) return;
    if (['vsphere', 'vcf', 'vmware-cloud'].includes(source.select.value)) broadSource.value = 'onprem-vmware';
    else if (['aws', 'azure', 'google', 'oci'].includes(source.select.value)) broadSource.value = 'existing-cloud';
  });
  const continueForVendor = (event) => {
    if (!initiative.value || (needsPlatform() && !providerId())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.showStep(1);
      byId('error-step-1').textContent = 'Choose an activity and platform.';
      (!initiative.value ? initiative : effectivePlatform()).focus();
      return;
    }
    if (publicProvider() && !direct()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = next.href;
  };
  byId('generateBtn').addEventListener('click', continueForVendor, true);
  byId('nextBtn').addEventListener('click', (event) => {
    if (direct() || byId('step-counter').textContent.includes('Step 4')) continueForVendor(event);
  }, true);
  const initialize = () => { updateInitiative(); updateCloud(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
}

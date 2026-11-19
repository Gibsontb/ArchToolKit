import { toCsv } from '../core/csv.js';
import { estateTco } from '../vmware/estate-tco.js';
import { EXIT_TARGETS } from '../multicloud/plan/dcexit/vmware-exit.js';
import { button } from './application-migration/kit.js';
import { card, field, select } from './components.js';
import { downloadFile, el } from './dom.js';
import { fill, note, rowsTable } from './multicloud/pane-kit.js';
                                                                        
import { HOSTED_VMWARE_COST_SOURCES, PROXMOX_EUR_PER_SOCKET_YEAR, VENDOR_COST_DRIVERS } from '../vmware/vendor-cost-drivers.js';
import { cloudReferenceCost } from '../vmware/cloud-reference-cost.js';

const key = 'archtoolkit.estate-cost.tco.v1';
                                                                                                                                       
const pricingDocs                                   = {
  aws: 'https://docs.aws.amazon.com/pricing-calculator/latest/userguide/ec2-estimates.html',
  azure: 'https://learn.microsoft.com/azure/cost-management-billing/costs/pricing-calculator',
  google: 'https://cloud.google.com/pricing',
  oci: 'https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/signingup_topic-Estimating_Costs.htm',
};
const computeNames                                   = {
  aws: 'EC2', govcloud: 'EC2', azure: 'Azure Virtual Machines', 'azure-government': 'Azure Virtual Machines',
  google: 'Compute Engine', oci: 'OCI Compute',
};
const destinations = [
  { id: 'lease', name: 'On-premises leased equipment' },
  { id: 'colo', name: 'Colocation' },
  { id: 'managed', name: 'Managed private hosting' },
  ...EXIT_TARGETS.filter(({ id }) => pricingDocs[id]),
  ...EXIT_TARGETS.filter(({ id }) => !pricingDocs[id]),
  { id: 'custom', name: 'Custom hosting or cloud' },
];

export function estateTcoPanel(estimate                       , lifeYears              ,
  currency                      ) {
  let saved                         = {};
  let inventoryDefaults                        = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch { /* Use the defaults if browser settings are unavailable. */ }
  const output = el('div', { attrs: { 'data-control': 'estate-tco-results' } });
  const settings = (id        , fallback = '') => typeof saved[id] === 'string' ? saved[id]  : fallback;
  const save = (id        , value        ) => {
    saved = { ...saved, [id]: value };
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* Keep the values for this session. */ }
  };
  const number = (id        , label        , fallback = '', integer = false, write = save) => {
    const input = el('input', { attrs: { id: 'tco-' + id, type: 'number', min: '0', step: integer ? '1' : 'any' } })                    ;
    input.value = settings(id, fallback);
    input.addEventListener('input', () => {
      write(id, input.value);
      render();
    });
    return { id, fallback, input, control: field(label, input), value: () => input.validity.valid && input.value !== '' ? input.valueAsNumber : null };
  };
  const choice = (id        , label        , options                                             , fallback        ) => {
    const input = select(options, settings(id, fallback));
    input.id = 'tco-' + id;
    if (!input.value) input.value = fallback;
    input.addEventListener('change', () => { save(id, input.value); render(); });
    return { input, control: field(label, input) };
  };
  const hosts = number('hosts', 'Host count', '', true);
  const sizing = choice('sizing', 'Physical cores per host', [
    { value: 'custom', label: 'Enter the estate core count' },
    ...[16, 24, 32, 48, 64, 96, 128].map((cores) => ({ value: String(cores), label: String(cores) })),
  ], 'custom');
  const cores = number('cores', 'Total physical cores', '', true);
  const storageUnit = choice('storage-unit', 'Storage unit', [
    { value: 'tib', label: 'TiB' }, { value: 'gib', label: 'GiB' },
  ], 'tib');
  const storage = number('storage', 'Provisioned storage');
  const manual = el('div', { class: 'field-grid' }, hosts.control, sizing.control, cores.control, storageUnit.control, storage.control);
  const years = choice('years', 'Planning horizon', Array.from({ length: 10 }, (_, i) =>
    ({ value: String(i + 1), label: `${i + 1} year${i ? 's' : ''}` })), '5');
  const initial = choice('initial', 'On-premises hardware', [
    { value: 'existing', label: 'Use existing hardware' }, { value: 'purchase', label: 'Purchase hardware now' },
  ], 'existing');
  const sourceGrowth = number('source-growth', 'Annual on-premises operating cost growth (%)', '0');
  const hardwareGrowth = number('hardware-growth', 'Annual hardware price growth (%)', '0');
  const discountRate = number('discount-rate', 'Annual discount rate for present value (%)', '0');
  const refresh = number('refresh', 'Months until next hardware refresh', '', true);
  refresh.input.placeholder = 'Use hardware lifespan';
  const selected = choice('provider', 'Compare on-premises with', destinations.map(({ id, name }) => ({ value: id, label: name })),
    settings('compute') ? 'custom' : 'aws');
  const providerKey = (provider        , id        ) => provider === 'custom' ? id : provider + '-' + id;
  const providerSave = (id        , value        ) => save(providerKey(selected.input.value, id), value);
  const quoteNumber = (id        , label        , fallback = '', integer = false) =>
    number(id, label, fallback, integer, providerSave);
  const termInput = select([
    { value: 'on-demand', label: 'On-demand' }, { value: 'discount', label: 'Reserved or committed' },
  ], 'on-demand');
  termInput.id = 'tco-term';
  const cloudTerm = { input: termInput, control: field('Pricing term', termInput) };
  const basisOptions = [
    { value: 'resources', label: 'Separate vCPU and RAM rates' },
    { value: 'monthly', label: 'Monthly compute quote' },
    { value: 'hourly', label: 'Hourly instance rate' },
  ];
  const basis = select(basisOptions, 'resources');
  basis.id = 'tco-compute-basis';
  const compute = quoteNumber('compute', 'Base compute or hosting / month');
  const quantity = quoteNumber('units', 'Billable compute units', '1');
  const hours = quoteNumber('hours', 'Billable hours / month', '730');
  const hourly = quoteNumber('hourly', 'USD per compute unit-hour');
  const vcpu = quoteNumber('vcpu', 'Destination vCPUs');
  const vcpuRate = quoteNumber('vcpu-rate', 'vCPU rate (USD)');
  const ram = quoteNumber('ram', 'Destination RAM (GiB)');
  const ramRate = quoteNumber('ram-rate', 'RAM rate (USD per GiB)');
  const periods = [{ value: 'hour', label: 'Per hour' }, { value: 'month', label: 'Per month' }];
  const vcpuPeriod = select(periods, 'hour');
  const ramPeriod = select(periods, 'hour');
  vcpuPeriod.id = 'tco-vcpu-rate-period';
  ramPeriod.id = 'tco-ram-rate-period';
  const cpuPeriodControl = field('vCPU rate period', vcpuPeriod);
  const ramPeriodControl = field('RAM rate period', ramPeriod);
  const computeDiscount = quoteNumber('compute-discount', 'Compute discount (%)', '0');
  computeDiscount.input.max = '100';
  const cloudStorage = quoteNumber('cloud-storage', 'Storage and backup / month');
  const storageBasis = select([{value: 'units', label: 'Capacity × monthly rate'}, {value: 'quote', label: 'Monthly storage quote'}], 'units');
  storageBasis.id = 'tco-storage-basis';
  const disk = quoteNumber('disk', 'Destination storage (GiB)');
  const diskRate = quoteNumber('disk-rate', 'USD per GiB of storage / month');
  const backup = quoteNumber('backup', 'Backup and snapshots / month');
  const cloudServices = quoteNumber('cloud-services', 'Managed services and licences / month');
  const licenceMode = select([
    { value: 'bundled', label: 'Included in other costs' },
    { value: 'separate', label: 'Calculate vendor subscription separately' },
  ], 'bundled');
  const licenceSelection = field('Platform subscription', licenceMode);
  const licenceQuantity = quoteNumber('licence-quantity', 'Subscription units', '', true);
  const licenceUnitPrice = quoteNumber('licence-unit-price', 'USD per subscription unit');
  const proxmoxPlan = select([{ value: 'quote', label: 'Use a USD quote' },
    ...Object.entries(PROXMOX_EUR_PER_SOCKET_YEAR).map(([value, price]) => ({ value, label: `${value} · EUR ${price}/year` })),
  ], 'quote');
  const proxmoxSelection = field('Proxmox subscription tier', proxmoxPlan);
  const proxmoxFx = quoteNumber('proxmox-fx', 'EUR per USD for subscription');
  const cloudOps = quoteNumber('cloud-ops', 'Support, operations and facilities / month');
  const egress = quoteNumber('egress', 'Monthly billable egress (GiB)');
  const egressRate = quoteNumber('egress-rate', 'Egress USD per GiB');
  const cloudGrowth = quoteNumber('cloud-growth', 'Annual destination cost growth (%)', '0');
  const migration = quoteNumber('migration', 'One-time migration and setup', '0');
  const commitment = quoteNumber('commitment', 'Upfront commitment or equipment payment', '0');
  const overlap = quoteNumber('overlap', 'Dual-run months', '0', true);
  const region = el('input', { attrs: { type: 'text', id: 'tco-region' } })                    ;
  const pricingSource = el('div');
  const cloudFields = el('div', { class: 'field-grid' }, field('Region or quote reference', region),
    field('Compute input', basis), cloudTerm.control, compute.control, quantity.control, hourly.control, hours.control,
    vcpu.control, vcpuRate.control, cpuPeriodControl, ram.control, ramRate.control, ramPeriodControl, computeDiscount.control,
    commitment.control, field('Storage input', storageBasis), disk.control, diskRate.control, backup.control,
    cloudStorage.control, cloudServices.control, licenceSelection, licenceQuantity.control, licenceUnitPrice.control, proxmoxSelection, proxmoxFx.control,
    cloudOps.control, egress.control, egressRate.control,
    cloudGrowth.control, migration.control, overlap.control);
  const quoteInputs = [compute, quantity, hours, hourly, computeDiscount, commitment, cloudStorage, cloudServices,
    vcpu, vcpuRate, ram, ramRate, disk, diskRate, backup, licenceQuantity, licenceUnitPrice, proxmoxFx,
    cloudOps, egress, egressRate, cloudGrowth, migration, overlap];
  const get = (provider        , id        , fallback = '') => settings(providerKey(provider, id), inventoryDefaults[id] ?? fallback);
  const computeBasisFor = (provider        ) => get(provider, 'compute-basis', get(provider, 'compute') ? 'monthly' : 'resources');
  const storageBasisFor = (provider        ) => get(provider, 'storage-basis', get(provider, 'cloud-storage') ? 'quote' : 'units');
  const loadQuote = () => {
    const provider = selected.input.value;
    for (const item of quoteInputs) item.input.value = get(provider, item.id, item.fallback);
    basis.value = computeBasisFor(provider);
    storageBasis.value = storageBasisFor(provider);
    licenceMode.value = get(provider, 'licence-mode', 'bundled');
    proxmoxPlan.value = get(provider, 'proxmox-plan', 'quote');
    cloudTerm.input.value = get(provider, 'term', 'on-demand') === 'discount' ? 'discount' : 'on-demand';
    vcpuPeriod.value = get(provider, 'vcpu-rate-period') === 'month' ? 'month' : 'hour';
    ramPeriod.value = get(provider, 'ram-rate-period') === 'month' ? 'month' : 'hour';
    region.value = get(provider, 'region');
  };
  selected.input.addEventListener('change', () => { loadQuote(); render(); });
  for (const [input, id] of [[basis, 'compute-basis'], [storageBasis, 'storage-basis'], [cloudTerm.input, 'term'],
    [licenceMode, 'licence-mode'], [proxmoxPlan, 'proxmox-plan'], [vcpuPeriod, 'vcpu-rate-period'],
    [ramPeriod, 'ram-rate-period'], [region, 'region']]         ) {
    input.addEventListener(input === region ? 'input' : 'change', () => { providerSave(id, input.value); render(); });
  }
  loadQuote();
  const quoteFor = (provider        ) => {
    const cost = (id        , fallback = '') => {
      const text = get(provider, id, fallback);
      const value = Number(text);
      return text.trim() && Number.isFinite(value) && value >= 0 ? value : null;
    };
    const committed = get(provider, 'term') === 'discount';
    const discount = committed ? cost('compute-discount', '0') : 0;
    const commitmentCost = committed ? cost('commitment', '0') : 0;
    const computeBasis = computeBasisFor(provider);
    const quotedStorage = storageBasisFor(provider) === 'quote';
    const units = cost('units', '1');
    const usedHours = cost('hours', '730');
    const unitRate = cost('hourly');
    const product = (...parts                   ) => parts.some((part) => part === null)
      ? null : parts.reduce        ((value, part) => value * part , 1);
    const cpuRate = cost('vcpu-rate');
    const memoryRate = cost('ram-rate');
    const cpuMonths = product(cpuRate, get(provider, 'vcpu-rate-period') === 'month' ? 1 : usedHours);
    const ramMonths = product(memoryRate, get(provider, 'ram-rate-period') === 'month' ? 1 : usedHours);
    const cpuBase = computeBasis === 'resources' ? product(cost('vcpu'), cpuMonths) : null;
    const ramBase = computeBasis === 'resources' ? product(cost('ram'), ramMonths) : null;
    const base = computeBasis === 'resources' ? cpuBase === null || ramBase === null ? null : cpuBase + ramBase
      : computeBasis === 'hourly' ? product(units, usedHours, unitRate) : cost('compute');
    const storageCost = quotedStorage ? cost('cloud-storage') : product(cost('disk'), cost('disk-rate'));
    const backupCost = quotedStorage ? 0 : cost('backup');
    const serviceCost = cost('cloud-services');
    const operatingCost = cost('cloud-ops');
    const transfer = cost('egress');
    const transferRate = cost('egress-rate');
    const annualGrowth = cost('cloud-growth', '0');
    const setup = cost('migration', '0');
    const dualRunMonths = cost('overlap', '0');
    const factor = discount !== null && discount <= 100 ? 1 - discount / 100 : null;
    const computeMonthly = product(base, factor);
    const transferMonthly = product(transfer, transferRate);
    const licence = VENDOR_COST_DRIVERS[provider]?.licence;
    const licenceEnabled = licence && get(provider, 'licence-mode') === 'separate';
    const plan = get(provider, 'proxmox-plan', 'quote')                                            ;
    const eurQuote = provider === 'proxmox' ? PROXMOX_EUR_PER_SOCKET_YEAR[plan] : undefined;
    const fx = eurQuote === undefined ? null : cost('proxmox-fx');
    const licencePrice = eurQuote !== undefined ? fx && fx > 0 ? eurQuote / fx : null : cost('licence-unit-price', provider === 'hpe' ? '600' : '');
    const licenceCount = licence ? cost('licence-quantity') : null;
    const licenceCost = licenceEnabled ? product(licenceCount !== null && Number.isInteger(licenceCount) ? licenceCount : null,
      licencePrice, licence.period === 'year' ? 1 / 12 : 1) : 0;
    return {
      computeMonthly, vcpuMonthly: product(cpuBase, factor), ramMonthly: product(ramBase, factor),
      storageCost, backupCost, serviceCost, operatingCost, transferMonthly, licenceCost,
      annualGrowth, dualRunMonths, upfront: setup !== null && commitmentCost !== null ? setup + commitmentCost : null,
      scenario: computeMonthly === null || storageCost === null || backupCost === null || serviceCost === null || licenceCost === null ||
        operatingCost === null || transferMonthly === null || annualGrowth === null || setup === null ||
        commitmentCost === null || dualRunMonths === null || !Number.isInteger(dualRunMonths) ? null : {
          monthly: computeMonthly + storageCost + backupCost + serviceCost + operatingCost + transferMonthly + licenceCost,
          annualGrowth, upfront: setup + commitmentCost, dualRunMonths,
        },
    };
  };
  const manualQuantities = () => {
    const count = hosts.value();
    const disk = storage.value();
    return { hosts: count, cores: sizing.input.value === 'custom' ? cores.value() : count === null ? null : count * Number(sizing.input.value),
      tib: disk === null ? null : disk / (storageUnit.input.value === 'gib' ? 1024 : 1) };
  };
  let refreshMonthly = () => {};

  function render()       {
    const provider = selected.input.value;
    const reservation = cloudTerm.input.value === 'discount';
    const hourlyBasis = basis.value === 'hourly';
    const purchaseNow = initial.input.value === 'purchase';
    cores.control.hidden = sizing.input.value !== 'custom';
    computeDiscount.control.hidden = !reservation;
    commitment.control.hidden = !reservation;
    compute.control.hidden = basis.value !== 'monthly';
    for (const { control } of [quantity, hourly]) control.hidden = !hourlyBasis;
    hours.control.hidden = basis.value === 'monthly';
    for (const { control } of [vcpu, vcpuRate, ram, ramRate]) control.hidden = basis.value !== 'resources';
    cpuPeriodControl.hidden = basis.value !== 'resources';
    ramPeriodControl.hidden = basis.value !== 'resources';
    cloudStorage.control.hidden = storageBasis.value !== 'quote';
    for (const { control } of [disk, diskRate, backup]) control.hidden = storageBasis.value !== 'units';
    const computeLabel = compute.control.querySelector('label');
    if (computeLabel) computeLabel.textContent = (computeNames[provider] ?? 'Compute or hosting') + ' / month';
    const vendor = VENDOR_COST_DRIVERS[provider];
    const licence = vendor?.licence;
    const showLicence = Boolean(licence && licenceMode.value === 'separate');
    const proxmoxPreset = showLicence && provider === 'proxmox' && proxmoxPlan.value !== 'quote';
    licenceSelection.hidden = !licence;
    licenceQuantity.control.hidden = !showLicence;
    licenceUnitPrice.control.hidden = !showLicence || proxmoxPreset;
    proxmoxSelection.hidden = !showLicence || provider !== 'proxmox';
    proxmoxFx.control.hidden = !proxmoxPreset;
    if (licence) {
      licenceQuantity.control.querySelector('label') .textContent = 'Destination ' + licence.unitLabel;
      licenceUnitPrice.control.querySelector('label') .textContent = 'USD per unit / ' + licence.period;
      if (saved[providerKey(provider, 'licence-unit-price')] === undefined) licenceUnitPrice.input.value = provider === 'hpe' ? '600' : '';
    }
    fill(pricingSource,
      note('Select the billing period from your quote for each vCPU and RAM rate. Storage rates are monthly. Enter 0 for charges included in a quote.'),
      vendor ? note(vendor.details) : note('Use the supplier’s quote for equipment, facility space and power, connectivity, support and any upfront fees.'),
      provider === 'vmware-cloud'
        ? el('ul', {}, ...HOSTED_VMWARE_COST_SOURCES.map(({ label, url }) => el('li', {}, el('a', { attrs: { href: url }, text: label }))))
        : vendor ? el('a', { attrs: { href: vendor.url }, text: 'Vendor pricing and licensing source' }) : null);
    refresh.control.hidden = purchaseNow;
    refreshMonthly();
    const current = estimate();
    const vendorName = destinations.find(({ id }) => id === provider)?.name ?? 'Destination';
    const pricing = quoteFor(provider);
    const quote = pricing.scenario;
    const format = currency.format;
    const manualStorage = manualQuantities().tib;
    const destinationCpu = vcpu.value();
    const destinationRam = ram.value();
    const destinationDisk = disk.value() ?? (manualStorage === null ? null : manualStorage * 1024);
    const billableHours = hours.value();
    const reference = cloudReferenceCost(provider, destinationCpu, destinationRam, destinationDisk, billableHours);
    const resourcePricing = basis.value === 'resources';
    const hasComputeRate = resourcePricing ? [get(provider, 'vcpu-rate'), get(provider, 'ram-rate')].some((rate) => rate.trim() !== '')
      : get(provider, hourlyBasis ? 'hourly' : 'compute').trim() !== '';
    const useReferenceCompute = !hasComputeRate && pricing.computeMonthly === null && reference?.compute != null;
    const useReferenceStorage = pricing.storageCost === null && reference?.storage != null;
    const useReference = useReferenceCompute || useReferenceStorage;
    const lines                            = [];
    if (useReferenceCompute) lines.push(['Compute (reference)', reference .compute]);
    else if (resourcePricing) lines.push(['vCPU', pricing.vcpuMonthly], ['RAM', pricing.ramMonthly]);
    else lines.push(['Bundled compute', pricing.computeMonthly]);
    lines.push([useReferenceStorage ? 'Provisioned storage (reference)' :
      storageBasis.value === 'quote' ? 'Storage and backup quote' : 'Storage',
    useReferenceStorage ? reference .storage : pricing.storageCost]);
    if (storageBasis.value !== 'quote' || useReferenceStorage) {
      lines.push(['Backup and snapshots', useReferenceStorage && storageBasis.value === 'quote' ? null : pricing.backupCost]);
    }
    lines.push(['Managed services and licences', pricing.serviceCost],
      ['Support, operations and facilities', pricing.operatingCost], ['Billable egress', pricing.transferMonthly]);
    if (showLicence) lines.push(['Platform subscription', pricing.licenceCost]);
    const priced = lines.filter(([, value]) => value !== null);
    const monthly = quote?.monthly ?? (priced.some(([, value]) => value  > 0)
      ? priced.reduce((sum, [, value]) => sum + value , 0) : null);
    const excluded = lines.filter(([, value]) => value === null).map(([name]) => name);
    if (pricing.upfront === null) excluded.push('upfront charges');
    const quantityText = (value               ) => value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const basisByLine                                               = {
      'Compute (reference)': reference?.computeBasis,
      'Provisioned storage (reference)': reference?.storageBasis,
      vCPU: vcpuPeriod.value === 'month' ? 'Destination vCPUs × monthly USD per vCPU' : 'Destination vCPUs × billable hours × USD per vCPU-hour',
      RAM: ramPeriod.value === 'month' ? 'Destination RAM GiB × monthly USD per GiB' : 'Destination RAM GiB × billable hours × USD per GiB-hour',
      'Bundled compute': hourlyBasis ? 'Billable units × hours × USD per unit-hour, after any compute discount' : 'Entered monthly quote, after any compute discount',
      Storage: 'Destination storage GiB × USD per GiB-month',
      'Platform subscription': licence ? 'Destination ' + licence.unitLabel + ' × rate per unit / ' + licence.period + (licence.period === 'year' ? ' ÷ 12' : '') : undefined,
      'Billable egress': 'Billable GiB × USD per GiB',
    };
    const costBreakdown = el('div', { class: 'stack' },
      useReference || resourcePricing ? note(`Destination sizing used: ${quantityText(destinationCpu)} vCPUs · ${quantityText(destinationRam)} GiB RAM · ${quantityText(destinationDisk)} GiB provisioned storage · ${quantityText(billableHours)} hours/month.`) : null,
      priced.length ? rowsTable([vendorName + ' monthly costs included', 'Calculation basis', currency.code()],
        priced.map(([name, value]) => [name, basisByLine[name] ?? 'Entered monthly amount', format(value )])) : null,
      excluded.length ? note('Still to price: ' + excluded.join(', ') + '.') : null,
      useReference ? note(reference .label + '. Reference compute uses configured capacity for the selected workload scope. Confirm sizes against measured demand before budgeting.') : null,
      useReference ? el('div', { class: 'btn-row' },
        useReferenceCompute ? el('a', { attrs: { href: reference .computeUrl }, text: 'Compute price source' }) : null,
        useReferenceStorage ? el('a', { attrs: { href: reference .storageUrl }, text: 'Storage price source' }) : null) : null);
    const show = (value               ) => value === null ? 'No estimate yet' : format(value);
    const sourceAnnualGrowth = sourceGrowth.value();
    const hardwareAnnualGrowth = hardwareGrowth.value();
    const discount = discountRate.value();
    const lifespanMonths = Math.max(1, Math.round(lifeYears() * 12));
    const nextRefresh = purchaseNow || refresh.input.value === '' ? lifespanMonths : refresh.value();
    if (!current?.complete || current.capital === null || sourceAnnualGrowth === null || hardwareAnnualGrowth === null ||
      discount === null || nextRefresh === null || nextRefresh === 0) {
      fill(output, el('h3', { text: 'Side-by-side hosting comparison' }),
        note('Complete the capacity inputs and on-premises assumptions to calculate the comparison.'),
        rowsTable(['Measure', 'On premises', vendorName], [
          ['Monthly operating cost', 'Pending', show(monthly)],
        ]), costBreakdown);
      return;
    }
    const model = { years: Number(years.input.value), purchaseNow, refreshMonths: lifespanMonths, firstRefreshMonths: nextRefresh,
      hardwareCost: current.capital, sourceMonthly: current.operating, sourceGrowth: sourceAnnualGrowth, hardwareGrowth: hardwareAnnualGrowth, discountRate: discount };
    const scenario = quote;
    const totals = estateTco(scenario ? { ...model, cloud: scenario } : model);
    const baselineName = purchaseNow ? 'On premises · buy now' : 'On premises · keep existing';
    const storageMonthly = useReferenceStorage ? reference .storage : pricing.storageCost;
    const storageGap = storageMonthly === null ? null : storageMonthly - model.sourceMonthly;
    const benchmarkHeading = !quote && monthly !== null ? ' · Monthly benchmark' : '';
    fill(output,
      el('h3', { text: 'Side-by-side hosting comparison' }),
      rowsTable(['Measure', baselineName, vendorName + benchmarkHeading], [
        ['Month-one operating cost before overlap', format(model.sourceMonthly), show(monthly)],
        ['Upfront cost included', format(purchaseNow ? model.hardwareCost : 0), scenario ? show(pricing.upfront) : '—'],
        [`${model.years}-year cost`, format(totals.sourceTotal), scenario ? format(totals.cloudTotal) : 'Awaiting a complete quote'],
        ['Present value of costs', format(totals.sourcePresentValue), scenario ? format(totals.cloudPresentValue) : '—'],
        ...(quote ? [['Savings vs. selected on-premises option', '—', format(totals.sourceTotal - totals.cloudTotal)]] : []),
      ]),
      scenario ? note(`Destination forecast: ${scenario.annualGrowth}% annual cost growth · ${scenario.dualRunMonths} months of parallel on-premises operating cost · ${format(scenario.upfront)} upfront included.`) : null,
      !quote && monthly !== null ? note('The destination amount is a monthly benchmark for the priced items below. Enter a complete quote for the target workload scope to calculate multi-year TCO and break-even.') : null,
      storageMonthly !== null && storageGap !== null && storageGap > 0
        ? note(`Storage alone costs ${format(storageMonthly)}/month, exceeding the entire on-premises operating budget by ${format(storageGap)}/month before compute or other destination charges.`)
        : null,
      !quote && useReferenceStorage && destinationDisk !== null && destinationDisk > 0
        ? note(`At the current ${quantityText(destinationDisk)} GiB, the storage rate would have to stay below USD ${(model.sourceMonthly / destinationDisk).toFixed(4)} per GiB-month to leave any of the on-premises operating budget for compute and other costs.`)
        : null,
      costBreakdown,
      quote && totals.crossover !== null ? note(`The destination breaks even in month ${totals.crossover} and stays at or below on-premises cost through this forecast.`) : null,
      rowsTable(['Year', 'On-prem CapEx', 'On-prem OpEx', 'On-prem cumulative', ...(scenario
        ? ['Destination spend', 'Destination cumulative'] : [])],
        totals.rows.map((row) => [String(row.year), format(row.capital), format(row.operating), format(row.sourceTotal),
          ...(scenario ? [format(row.cloudSpend), format(row.cloudTotal)] : [])])),
      button('Download TCO comparison', () => downloadFile('estate-tco.csv', toCsv(totals.rows.map((row) => ({
        year: row.year, currency: currency.code(), onPremCapital: currency.csv(row.capital), onPremOperating: currency.csv(row.operating),
        onPremTotal: currency.csv(row.sourceTotal), onPremPresentValue: currency.csv(row.sourcePresentValue),
        ...(scenario ? { provider: vendorName, destinationBasis: 'Entered rates',
          destinationSpend: currency.csv(row.cloudSpend), destinationTotal: currency.csv(row.cloudTotal),
          destinationPresentValue: currency.csv(row.cloudPresentValue) } : {}),
      }))), 'text/csv'), { disabled: !currency.ready() }));
  }

  const inputs = card('On-premises capacity', manual);
  const forecast = card('Multi-year TCO',
    el('div', { class: 'field-grid' }, years.control, initial.control, refresh.control,
      sourceGrowth.control, hardwareGrowth.control, discountRate.control),
    selected.control,
    output, pricingSource, cloudFields,
    note('Cash-flow TCO counts hardware purchases and refreshes as CapEx. Existing hardware is assumed already paid for. The monthly baseline separately shows hardware amortization. During dual-run the cloud scenario also carries source OpEx.'),
    );
  return { inputs, forecast, render, manualQuantities,
    applyInventory: (quantities                                                                                                         ) => {
      // Replace quantities from this snapshot; never add them to a previous import.
      hosts.input.value=String(quantities.hosts); cores.input.value=quantities.cores===null?'':String(quantities.cores);
      sizing.input.value='custom';storageUnit.input.value='tib';storage.input.value=quantities.tib===null?'':String(quantities.tib);
      inventoryDefaults=Object.fromEntries(['vcpu','ram','disk'].map(id=>[id,String(quantities[id                       ]??'')]));
      loadQuote();render();
    },
    unitCosts: () => {
      const quote=quoteFor(selected.input.value);
      return { vcpu: quote.vcpuMonthly!==null&&vcpu.value() ? quote.vcpuMonthly/vcpu.value()  : null,
        ram: quote.ramMonthly!==null&&ram.value() ? quote.ramMonthly/ram.value()  : null,
        disk: quote.storageCost!==null&&disk.value() ? quote.storageCost/disk.value()  : null };
    },
    onChange: (drawMonthly            ) => { refreshMonthly = drawMonthly; } };
}

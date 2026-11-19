import { toCsv } from '../core/csv.ts';
import { COST_DRIVERS, EXAMPLE_ESTATE_RATES, estimateEstateQuantities, estimateEstateCost, inventoryDestinationQuantities, readEstateRates } from '../vmware/estate-cost.ts';
import { button, buttonRow } from './application-migration/kit.ts';
import { card, field, numberInput } from './components.ts';
import { downloadFile, el } from './dom.ts';
import { fill, note, rowsTable } from './multicloud/pane-kit.ts';
import { estateTcoPanel } from './estate-tco-panel.ts';
import { estateReportCurrency } from './estate-report-currency.ts';
import { mountEstateBar } from './estate-bar.ts';
import { estateCostInventory } from './estate-cost-inventory.ts';
import type { Inventory } from '../vmware/inventory.ts';

const key = 'archtoolkit.estate-cost.rates.v1';

function mount(root: HTMLElement): void {
  let inventory: Inventory | undefined;
  let inventoryOrigin = '';
  let rates = EXAMPLE_ESTATE_RATES;
  let rateSource = 'Illustrative planning rates';
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved && typeof saved.source === 'string') {
      rates = readEstateRates(saved.rates);
      rateSource = saved.source;
    }
  } catch { /* A stale or unavailable browser cache falls back to example rates. */ }

  const results = el('div', { attrs: { 'data-control': 'estate-cost-results' } });
  const sourceLabel = note('');
  const status = el('p', { attrs: { role: 'status' } });
  const rateFile = el('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } }) as HTMLInputElement;
  const estimateCurrent = (): ReturnType<typeof estimateEstateQuantities> => estimateEstateQuantities(tco.manualQuantities(), rates);
  const currency = estateReportCurrency(() => tco.render());
  const tco = estateTcoPanel(estimateCurrent, () => rates.lifeYears, currency);
  const importedRows = estateCostInventory(()=>inventory,()=>rates,()=>tco.unitCosts(),currency,()=> 'all',()=> 'provisioned');
  const render = () => tco.render();
  tco.onChange(() => {
    sourceLabel.textContent = 'Rate source: ' + rateSource;
    const estimate = estimateCurrent();
    const quantities = `${inventory ? 'Prefilled from '+inventoryOrigin+' · editable quantities' : 'Manual inputs'} · ${estimate.hosts ?? '—'} hosts · ${estimate.cores ?? '—'} physical cores · ${estimate.tib?.toFixed(2) ?? '—'} provisioned TiB`;
    importedRows.refresh();
    fill(results,
      el('h3', { text: (estimate.complete ? 'Estimated monthly cost · ' : 'Partial monthly estimate · ') + currency.format(estimate.subtotal) }),
      note(quantities),
      note('Rate source: ' + rateSource),
      rowsTable(['Cost category', 'Monthly ' + currency.code()], estimate.rows.map(([label, amount]) =>
        [label, amount === null ? 'Quantity missing' : currency.format(amount)])),
      !estimate.complete ? note('Enter the missing capacity quantities to complete the estimate.') : null,
      button('Download cost breakdown', () => {
        const source = /^[\s=+@-]/.test(rateSource) ? "'" + rateSource : rateSource;
        downloadFile('on-premises-cost.csv', toCsv([
          ...estimate.rows.map(([category, amount]) => ({ category, monthlyAmount: amount === null ? '' : currency.csv(amount), currency: currency.code(), rateSource: source })),
          { category: estimate.complete ? 'Estimated monthly total' : 'Partial monthly subtotal', monthlyAmount: currency.csv(estimate.subtotal), currency: currency.code(), rateSource: source },
        ]), 'text/csv');
      }, { disabled: !currency.ready() }));
  });
  const persist = (message: string) => {
    status.textContent = message;
    try { localStorage.setItem(key, JSON.stringify({ rates, source: rateSource })); }
    catch { status.textContent = 'Rates applied for this session. Browser storage is unavailable.'; }
  };
  const rateInputs = COST_DRIVERS.map(([id, label]) => {
    const input = numberInput(rates[id], {
      id: 'estate-cost-' + id, min: id === 'pue' ? '1' : '0', step: 'any', required: '',
    });
    input.addEventListener('input', () => {
      const value = input.valueAsNumber;
      if (!input.validity.valid || !Number.isFinite(value) || (id === 'lifeYears' && value === 0)) {
        input.setAttribute('aria-invalid', 'true');
        status.textContent = 'Enter a valid value for ' + label + '. The estimate uses its last valid value.';
        return;
      }
      input.removeAttribute('aria-invalid');
      if (value === rates[id]) return;
      rates = { ...rates, [id]: value };
      if (!rateSource.startsWith('Edited rates based on ')) rateSource = 'Edited rates based on ' + rateSource;
      persist('Estimate updated.');
      render();
    });
    input.addEventListener('blur', () => {
      if (!input.hasAttribute('aria-invalid')) return;
      input.value = String(rates[id]);
      input.removeAttribute('aria-invalid');
      status.textContent = 'Restored the last valid value for ' + label + '.';
    });
    return { id, input, control: field(label, input) };
  });
  const syncInputs = () => {
    for (const { id, input } of rateInputs) {
      input.value = String(rates[id]);
      input.removeAttribute('aria-invalid');
    }
  };

  rateFile.addEventListener('change', async () => {
    const file = rateFile.files?.[0];
    rateFile.value = '';
    if (!file) return;
    try {
      rates = readEstateRates(JSON.parse(await file.text()));
      rateSource = file.name;
      persist('Rate file applied.');
      syncInputs();
      render();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not read the rate file.';
    }
  });

  fill(root,
    card('Currency', currency.control),
    tco.inputs,
    card('As-is monthly estimate', results),
    card('Cost assumptions',
      note('Edit any USD rate below or import a rate file from your VCF Operations cost drivers, contracts, or invoices.'),
      buttonRow(button('Import rates', () => rateFile.click()), rateFile,
        button('Download current rates', () => downloadFile('estate-cost-rates.json', JSON.stringify(rates, null, 2))),
        button('Use example rates', () => {
          rates = EXAMPLE_ESTATE_RATES;
          rateSource = 'Illustrative planning rates';
          try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
          status.textContent = 'Illustrative rates applied.';
          syncInputs();
          render();
        })),
      status, sourceLabel, el('div', { class: 'field-grid' }, ...rateInputs.map(({ control }) => control)),
      note('The estimate annualizes hardware over its useful life and models a 730-hour month. Storage uses provisioned VM space. Licensing uses known physical cores before any contract-specific minimums. Avoid counting the same hardware and storage costs twice for HCI.'),
      el('a', { attrs: { href: 'https://knowledge.broadcom.com/external/article/403784' }, text: 'Broadcom cost driver methodology' })),
    tco.forecast, importedRows.element);
  render();
  void mountEstateBar(root, {
    purpose: 'prefill the Cost Calculator from this inventory',
    onEstate: entry => {
      inventory=entry?.inventory;inventoryOrigin=entry?.origin??'';
      if(entry){
        const baseline=estimateEstateCost(entry.inventory,rates);
        const destination=inventoryDestinationQuantities(entry.inventory.vms,'all','provisioned');
        tco.applyInventory({hosts:baseline.hosts,cores:baseline.unknownCores?null:baseline.cores,tib:baseline.complete?baseline.tib:null,...destination});
      } else render();
    },
  });
}

const root = document.getElementById('estate-cost-root');
if (root) mount(root);

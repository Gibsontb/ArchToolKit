import { field, select } from './components.ts';
import { el } from './dom.ts';
import { note } from './multicloud/pane-kit.ts';

export interface EstateReportCurrency {
  code(): string;
  ready(): boolean;
  format(usd: number): string;
  csv(usd: number): string;
}

const storageKey = 'archtoolkit.estate-cost.currency.v1';
const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', ...Intl.supportedValuesOf('currency')];

export function estateReportCurrency(onChange: () => void) {
  let saved: { code?: string; rates?: Record<string, string> } = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {}; } catch { /* Use USD. */ }
  const options = Array.from(new Set(currencies)).map((value) => ({ label: value, value }));
  const choice = select(options, saved.code ?? 'USD');
  if (!choice.value) choice.value = 'USD';
  const rateInput = el('input', { attrs: { type: 'number', min: '0', step: 'any' } }) as HTMLInputElement;
  const rateControl = field('Report currency units per USD', rateInput);
  const status = note('');
  let formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: choice.value, currencyDisplay: 'code' });
  const rate = () => choice.value === 'USD' ? 1 : rateInput.validity.valid && rateInput.valueAsNumber > 0 && Number.isFinite(rateInput.valueAsNumber)
    ? rateInput.valueAsNumber : null;
  const update = () => {
    rateControl.hidden = choice.value === 'USD';
    status.textContent = rate() === null ? 'Enter an exchange rate to display and export converted amounts.' : 'Rates and quotes are entered in USD. The report and CSV exports use the selected currency.';
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Use the selection for this session. */ }
    onChange();
  };
  const loadRate = () => {
    const value = saved.rates?.[choice.value];
    rateInput.value = typeof value === 'string' ? value : '';
  };
  choice.addEventListener('change', () => {
    saved = { ...saved, code: choice.value };
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: choice.value, currencyDisplay: 'code' });
    loadRate();
    update();
  });
  rateInput.addEventListener('input', () => {
    saved = { ...saved, rates: { ...saved.rates, [choice.value]: rateInput.value } };
    update();
  });
  loadRate();
  rateControl.hidden = choice.value === 'USD';
  status.textContent = rate() === null ? 'Enter an exchange rate to display and export converted amounts.' : 'Rates and quotes are entered in USD. The report and CSV exports use the selected currency.';
  return {
    control: el('div', {}, el('div', { class: 'field-grid' }, field('Report currency', choice), rateControl), status),
    code: () => choice.value,
    ready: () => rate() !== null,
    format: (usd: number) => { const fx = rate(); return fx === null ? '—' : formatter.format(usd * fx); },
    csv: (usd: number) => { const fx = rate(); return fx === null ? '' : (usd * fx).toFixed(formatter.resolvedOptions().maximumFractionDigits); },
  };
}

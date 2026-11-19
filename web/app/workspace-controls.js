import { el } from '../lib/ui/dom.js';
import { field, select } from '../lib/ui/components.js';
import { toCsv } from '../lib/core/csv.js';
import { downloadFile } from '../lib/ui/dom.js';

export { el, field, select };
export const platforms = ['On-premises', 'VCF / vSphere', 'AWS', 'Azure', 'Google Cloud', 'Oracle Cloud', 'Nutanix AHV', 'Hyper-V / Azure Local', 'OpenShift Virtualization', 'OpenStack', 'Proxmox VE', 'HPE VM Essentials', 'SUSE Virtualization', 'Oracle Linux Virtualization Manager', 'Other'];
export function dropdown(label, options, value = '') {
  const input = select(options.map(item => ({ value: item, label: item || 'Select…' })), value);
  return { input, control: field(label, input) };
}
export function textField(label, value = '', type = 'text') {
  const input = el('input', { attrs: { type } });
  input.value = value;
  return { input, control: field(label, input) };
}
export function checks(label, options, selected = []) {
  const inputs = options.map(value => {
    const input = el('input', { attrs: { type: 'checkbox', value } });
    input.checked = selected.includes(value);
    return { input, control: el('label', { class: 'checkbox' }, input, value) };
  });
  return { control: el('fieldset', { class: 'workspace-checks' }, el('legend', { text: label }), ...inputs.map(item => item.control)),
    value: () => inputs.filter(item => item.input.checked).map(item => item.input.value) };
}
export function button(label, action, primary = false) {
  return el('button', { text: label, class: primary ? 'btn btn-primary' : 'btn', attrs: { type: 'button' }, on: { click: action } });
}
export function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...headers.map(text => el('th', { text, attrs: { scope: 'col' } })))),
    el('tbody', {}, ...rows.map(row => el('tr', {}, ...row.map(cell => el('td', {}, cell)))))));
}
export function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; }
  catch { return fallback; }
}
export function save(key, data, status) {
  try { localStorage.setItem(key, JSON.stringify(data)); status.textContent = 'Saved in this browser.'; }
  catch { status.textContent = 'Browser storage is unavailable. Keep a JSON export before closing.'; }
}
export function exportJson(name, value) { downloadFile(name + '.json', JSON.stringify(value, null, 2), 'application/json'); }
export function exportCsv(name, rows) { downloadFile(name + '.csv', toCsv(rows), 'text/csv'); }
export function jsonImport(label, receive, status) {
  const input = el('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: true } });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try { receive(JSON.parse(await file.text())); }
    catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not import file.'; }
  });
  return el('span', {}, button(label, () => input.click()), input);
}
export const today = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
};

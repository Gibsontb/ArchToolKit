import { el, dropdown, textField, button, table, today } from './workspace-controls.js';
import { offeringOptions } from './governance-offerings.js';
const loaders = {
  AWS: () => import('../lib/cloud/service-catalog-aws.js').then(module => module.SERVICE_CATALOG_AWS),
  Azure: () => import('../lib/cloud/service-catalog-azure.js').then(module => module.SERVICE_CATALOG_AZURE),
  'Google Cloud': () => import('../lib/cloud/service-catalog-google.js').then(module => module.SERVICE_CATALOG_GOOGLE),
  'Oracle Cloud': () => import('../lib/cloud/service-catalog-oci.js').then(module => module.SERVICE_CATALOG_OCI),
};
export function servicePanel(profile, state, persist, summaryChanged) {
  state.serviceChecks ??= [];
  const root = el('div');
  let request = 0;
  async function refresh() {
    const token = ++request;
    const p = profile();
    const selector = dropdown('Required service', ['']);
    const custom = textField('Service name');
    const search = textField('Find a service');
    const list = el('div');
    const info = el('p', { class: 'muted', text: 'Record availability evidence for this exact offering and region. Unverified services remain outstanding.' });
    const source = offeringOptions(p.platform, p.offering).source;
    const add = button('Add required service', () => {
      const service = selector.input.value || custom.input.value.trim();
      if (!service || !p.offering || !p.region) { info.textContent = 'Select an offering, region and required service first.'; return; }
      if (state.serviceChecks.some(row => row.service === service && row.platform === p.platform && row.offering === p.offering && row.region === p.region)) return;
      state.serviceChecks.push({ service, platform: p.platform, offering: p.offering, region: p.region, status: 'Unverified', reference: '', verified: '' });
      persist(); draw(); summaryChanged();
    });
    function draw() {
      const rows = state.serviceChecks.filter(row => row.platform === p.platform && row.offering === p.offering && row.region === p.region);
      list.replaceChildren(rows.length ? table(['Service', 'Availability', 'Evidence', 'Action'], rows.map(row => {
        const status = dropdown('Availability · ' + row.service, ['Unverified', 'Available', 'Unavailable'], row.status);
        const reference = textField('Vendor evidence · ' + row.service, row.reference);
        const verified = textField('Verified on · ' + row.service, row.verified, 'date');
        const warning = el('p');
        function check() { warning.textContent = row.status === 'Available' && (!row.reference.trim() || !row.verified) ? 'Evidence and verification date required.' : ''; }
        check();
        for (const item of [status, reference, verified]) item.input.addEventListener('change', () => {
          Object.assign(row, { status: status.input.value, reference: reference.input.value, verified: verified.input.value });
          persist(); check(); summaryChanged();
        });
        return [row.service, status.control, el('div', {}, reference.control, verified.control, warning), button('Remove service', () => {
          state.serviceChecks = state.serviceChecks.filter(value => value !== row); persist(); draw(); summaryChanged();
        })];
      })) : el('p', { text: 'No services recorded for this offering and region.' }));
    }
    root.replaceChildren(info, source ? el('a', { text: 'Provider offering reference', attrs: { href: source, target: '_blank', rel: 'noopener noreferrer' } }) : null,
      el('div', { class: 'field-grid' }, search.control, selector.control, custom.control), add, list);
    draw();
    selector.input.disabled = true;
    if (loaders[p.platform]) {
      try {
        const catalog = await loaders[p.platform]();
        if (token !== request) return;
        const services = catalog.services.map(row => row.name).sort();
        function filter() {
          const selected = selector.input.value;
          const values = services.filter(value => value.toLowerCase().includes(search.input.value.toLowerCase()));
          selector.input.replaceChildren(new Option('Select…', ''), ...values.map(value => new Option(value, value)));
          selector.input.value = values.includes(selected) ? selected : '';
          selector.input.disabled = false;
        }
        search.input.addEventListener('input', filter); filter();
      } catch { info.textContent = 'Service catalog unavailable. Enter a service name and its verification evidence.'; }
    } else { search.control.hidden = true; selector.control.hidden = true; }
  }
  return { element: root, refresh };
}
export function serviceFindings(profile, checks) {
  return checks.filter(row => row.platform === profile.platform && row.offering === profile.offering && row.region === profile.region)
    .filter(row => row.status !== 'Available' || !row.reference.trim() || !row.verified || row.verified > today());
}

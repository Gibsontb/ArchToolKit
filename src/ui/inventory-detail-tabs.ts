import type { StoredEstate } from '../kit/estate-store.ts';
import { RVTOOLS_TABS } from '../vmware/rvtools.ts';
import { inventoryNetworks } from '../vmware/network-inventory.ts';
import { el, replace } from './dom.ts';
import { card, field, select, stat, statGrid } from './components.ts';
import { inventoryTableView } from './inventory-table-view.ts';
import { inventoryWorksheets } from './inventory-worksheets.ts';
import { mountInventoryTopology } from './inventory-topology.ts';
export function inventoryDetailTabs(entry: StoredEstate, overview: readonly HTMLElement[]): HTMLElement {
  const body = el('div', { class: 'stack', attrs: { role: 'tabpanel', id: 'inventory-detail-panel' } });
  const tabs = el('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Inventory worksheets' } });
  const sheets = inventoryWorksheets(entry);
  const labels = ['Overview','Networking','Topology',...RVTOOLS_TABS];
  let networking: HTMLElement | undefined;
  let topology: HTMLElement | undefined;
  function networks(): HTMLElement {
    const sections = inventoryNetworks(entry.inventory);
    const picker = select(sections.map(section => ({ value: section.id, label: section.label })), 'subnets');
    const rows = el('div');
    const draw = () => {
      const section = sections.find(value => value.id === picker.value)!;
      inventoryTableView(rows,section.label,section.columns,section.rows.map(row => section.columns.map(key => row[key] ?? '')));
    };
    picker.addEventListener('change', draw); draw();
    return el('div', { class: 'stack' },card('Networking',
      statGrid(...sections.filter(section => section.id !== 'dns').map(section => stat({ label: section.label, value: section.rows.length }))),
      el('p', { class: 'muted', text: 'Subnet ranges are calculated from recorded VMkernel IP addresses and masks, scoped by vCenter. They do not describe guest subnets, DHCP pools, reservations or free addresses. Blank values were not supplied by the source.' }),
      field('Networking view',picker),rows));
  }
  const buttons: HTMLButtonElement[] = [];
  function makeButton(label: string, index: number): HTMLButtonElement {
    const button = el('button', { class: 'tab', text: label, attrs: { type: 'button', role: 'tab', id: 'inventory-tab-'+index, 'aria-controls': 'inventory-detail-panel', 'aria-selected': 'false', tabindex: '-1' } });
    button.addEventListener('click', () => {
      sheets.cancel();
      for (const item of buttons) { item.classList.remove('active'); item.setAttribute('aria-selected','false');item.tabIndex=-1; }
      button.classList.add('active');button.setAttribute('aria-selected','true');button.tabIndex=0;
      body.setAttribute('aria-labelledby',button.id);
      if(label==='Overview')replace(body,...overview);
      else if(label==='Networking'){ networking ??= networks();replace(body,networking); }
      else if(label==='Topology'){ if(!topology){topology=el('div');mountInventoryTopology(topology,entry.inventory);}replace(body,topology); }
      else void sheets.show(body,label);
    });
    button.addEventListener('keydown',event => {
      if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
      event.preventDefault();
      const target = event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      buttons[target]!.focus();buttons[target]!.click();
    });
    return button;
  }
  buttons.push(...labels.map(makeButton));
  tabs.append(...buttons);
  void sheets.names().then(names => {
    for (const name of names) if (!labels.includes(name)) { labels.push(name); const button = makeButton(name, buttons.length); buttons.push(button); tabs.appendChild(button); }
  }).catch(() => { /* A worksheet read reports the source error in its panel. */ });
  buttons[0]!.click();
  return el('div', { class: 'stack', attrs: { 'data-control':'inventory-detail-tabs' } }, tabs, body);
}

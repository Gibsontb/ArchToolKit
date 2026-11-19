import { toCsv } from '../core/csv.js';
import { destinationVirtualDisk, estimateEstateQuantities, inventoryDestinationQuantities, isDestinationVm,                  
                                                 } from '../vmware/estate-cost.js';
                                                        
import { button, buttonRow } from './application-migration/kit.js';
import { field, select } from './components.js';
import { downloadFile, el } from './dom.js';
import { fill, note, rowsTable } from './multicloud/pane-kit.js';
                                                                        

                                                                                  
const known = (value                    ) => value && Number.isFinite(value) ? String(value) : '';
const csvSafe = (value        ) => /^[=+@\t\r\n-]/.test(value.trimStart()) ? "'" + value : value;

export function estateCostInventory(
  inventory                             , rates                   , unitCosts                 , currency                      ,
  scope                        , storage                          ,
) {
  const body = el('div', { class: 'stack' });
  const element = el('section', { attrs: { 'data-control': 'rvtools-cost-inventory' } },
    el('h3', { text: 'Complete RVTools host and VM inventory' }), body);
  let hostPage = 0;
  let vmPage = 0;
  let datastorePage = 0;
  let rowsPerPage = '25';
  const pageSizeChoice = select(['25', '100', 'all'].map((value) => ({ value, label: value === 'all' ? 'All rows' : value })), rowsPerPage);
  const pageControl = field('Rows per table', pageSizeChoice);
  const paged =    (data              , page        , set                        ,
    headers          , format                      , file        ) => {
    const pageSize = rowsPerPage === 'all' ? Math.max(data.length, 1) : Number(rowsPerPage);
    const lastPage = Math.max(0, Math.ceil(data.length / pageSize) - 1);
    const current = Math.min(page, lastPage);
    return el('div', { class: 'stack' },
      rowsTable(headers, data.slice(current * pageSize, (current + 1) * pageSize).map(format)),
      buttonRow(
        button('Previous', () => set(current - 1), { disabled: current === 0 }),
        note(`Page ${current + 1} of ${lastPage + 1} · ${data.length} rows`),
        button('Next', () => set(current + 1), { disabled: current === lastPage }),
        button('Download all rows as CSV', () => {
          const dataRows = data.map((row) => Object.fromEntries(format(row).map((value, index) => [headers[index], csvSafe(value)])));
          downloadFile(file, toCsv(dataRows, headers), 'text/csv');
        })));
  };
  const refresh = () => {
    const source = inventory();
    element.hidden = !source;
    if (!source) return;
    const physicalCores = source.hosts.reduce((sum, host) => sum + host.totalCores, 0);
    const physicalRam = source.hosts.reduce((sum, host) => sum + host.memoryGib, 0);
    const sockets = source.hosts.reduce((sum, host) => sum + host.cpuSockets, 0);
    const totals = (vms                  ) => vms.reduce((sum, vm) => ({
      vcpus: sum.vcpus + vm.vcpu, ram: sum.ram + vm.memoryGib, provisioned: sum.provisioned + vm.provisionedGib,
      used: sum.used + (vm.usedGib ?? 0), usedReported: sum.usedReported + (vm.usedGib === undefined ? 0 : 1),
    }), { vcpus: 0, ram: 0, provisioned: 0, used: 0, usedReported: 0 });
    const selectedScope = scope();
    const selectedStorage = storage();
    const isPriced = (vm                          ) => isDestinationVm(vm, selectedScope);
    const pricedVms = source.vms.filter(isPriced);
    const inventoryTotals = totals(source.vms);
    const workloadTotals = totals(pricedVms);
    const migrationQuantities = inventoryDestinationQuantities(source.vms, selectedScope, selectedStorage);
    const datastoreTotals = source.datastores.reduce((sum, store) => ({
      capacity: sum.capacity + store.capacityGib, free: sum.free + store.freeGib,
    }), { capacity: 0, free: 0 });
    const units = (value        ) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const platformRates = { ...rates(), sharedInfrastructurePurchase: 0, otherSoftwarePerMonth: 0, otherOperatingPerMonth: 0 };
    const price = unitCosts();
    const monthly = (total        ) => currency.ready() ? currency.format(total) : '';
    const vmCost = (quantity        , rate               ) => quantity > 0 && rate !== null ? monthly(quantity * rate) : '';
    fill(body,
      note(`${source.hosts.length} hosts · ${sockets} known sockets · ${physicalCores} known physical cores · ${units(physicalRam)} GiB of reported host RAM · ${source.clusters.length} clusters · ${source.datastores.length} datastores · ${source.networks.length} networks`),
      source.datastores.length ? note(`Reported datastore capacity: ${units(datastoreTotals.capacity)} GiB · Reported free: ${units(datastoreTotals.free)} GiB`) : null,
      rowsTable(['Inventory scope', 'Rows', 'vCPU', 'RAM GiB', 'Provisioned GiB', 'Reported used GiB'], [
        ['All VM records', String(source.vms.length), units(inventoryTotals.vcpus), units(inventoryTotals.ram), units(inventoryTotals.provisioned),
          `${units(inventoryTotals.used)} (${inventoryTotals.usedReported}/${source.vms.length} reported)`],
        ['Workloads included in pricing', String(pricedVms.length), units(workloadTotals.vcpus), units(workloadTotals.ram), units(workloadTotals.provisioned),
          `${units(workloadTotals.used)} (${workloadTotals.usedReported}/${pricedVms.length} reported)`],
      ]),
      note(`RVTools destination storage: ${migrationQuantities.disk === undefined ? 'missing data' : units(migrationQuantities.disk) + ' GiB'} · ${units(migrationQuantities.shared)} GiB of shared RDMs included at estate level. The vendor form may use a saved storage override.`),
      el('a', { attrs: { href: 'inventory.html' }, text: 'Open VMware Inventory for clusters, datastores, networks and import details' }),
      pageControl,
      el('h3', { text: 'Physical host builds' }),
      note('Host cost excludes shared infrastructure and VM storage. Empty fields were unavailable in the inventory.'),
      paged(source.hosts, hostPage, (next) => { hostPage = next; refresh(); },
        ['Host', 'vCenter', 'Cluster', 'Vendor / model', 'CPU model', 'Sockets', 'Cores / socket', 'Physical cores', 'RAM GiB',
          'ESXi version', 'Build', 'BIOS', 'NICs', 'Local disks', 'Estimated host / month (' + currency.code() + ')'],
        (host) => {
          const estimate = estimateEstateQuantities({ hosts: 1, cores: host.totalCores > 0 ? host.totalCores : null, tib: 0 }, platformRates);
          return [host.name, host.vcenter ?? '', host.cluster ?? '', [host.vendor, host.model].filter(Boolean).join(' '),
            host.cpuModel ?? '', known(host.cpuSockets), known(host.coresPerSocket), known(host.totalCores), known(host.memoryGib),
            host.esxVersion ?? '', host.build ?? '', host.biosVersion ?? '', known(host.nicCount),
            known(host.storageDevices?.length), estimate.complete ? monthly(estimate.subtotal) : ''];
        }, 'rvtools-host-build-costs.csv'),
      el('h3', { text: 'VM inventory and destination cost' }),
      note('All VM records are listed. Per-VM storage prices cover virtual disks. Shared RDMs are priced once at estate level.'),
      paged(source.vms, vmPage, (next) => { vmPage = next; refresh(); },
        ['VM', 'vCenter', 'Host', 'Cluster', 'Guest OS', 'VM hardware', 'Power', 'Pricing scope', 'vCPU', 'RAM GiB', 'Provisioned GiB',
          'Used GiB', 'RVTools destination disk GiB', 'Storage source', ...['vCPU', 'RAM', 'Storage'].map((label) => label + ' / month (' + currency.code() + ')')],
        (vm) => {
          const priced = isPriced(vm);
          const disk = priced ? destinationVirtualDisk(vm, selectedStorage) : undefined;
          return [vm.name, vm.vcenter ?? '', vm.host ?? '', vm.cluster ?? '', vm.guestOs ?? '', vm.hardwareVersion ?? '',
          vm.powerState, vm.template ? 'Template' : vm.srmPlaceholder ? 'SRM placeholder' : isPriced(vm) ? 'Priced workload' : 'Outside destination scope',
          known(vm.vcpu), known(vm.memoryGib), known(vm.provisionedGib), vm.usedGib === undefined ? '' : String(vm.usedGib),
          disk ? String(disk.gib) : '', disk?.source ?? '',
          ...(priced ? [vmCost(vm.vcpu, price.vcpu), vmCost(vm.memoryGib, price.ram), vmCost(disk?.gib ?? 0, price.disk)]
            : ['', '', ''])];
        }, 'rvtools-vm-costs.csv'),
      source.datastores.length ? el('h3', { text: 'Datastores' }) : null,
      source.datastores.length ? paged(source.datastores, datastorePage, (next) => { datastorePage = next; refresh(); },
        ['Datastore', 'vCenter', 'Type', 'Capacity GiB', 'Free GiB', 'Provisioned GiB'],
        (store) => [store.name, store.vcenter ?? '', store.typeDetail ?? store.type, String(store.capacityGib),
          String(store.freeGib), store.provisionedGib === undefined ? '' : String(store.provisionedGib)], 'rvtools-datastores.csv') : null);
  };
  pageSizeChoice.addEventListener('change', () => {
    rowsPerPage = pageSizeChoice.value;
    hostPage = 0;
    vmPage = 0;
    datastorePage = 0;
    refresh();
  });
  return { element, refresh };
}

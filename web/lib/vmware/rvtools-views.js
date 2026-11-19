                                                
export function importedWorksheet(inventory           , tab        )                                                            {
                                     
  const strip = (item        , excluded                   )      => Object.fromEntries(Object.entries(item).filter(([key]) => !excluded.includes(key)));
  const vmBase = (vm                          )      => ({ VM: vm.name, vcenter: vm.vcenter, host: vm.host, cluster: vm.cluster });
  const hostBase = (host                            )      => ({ Host: host.name, vcenter: host.vcenter, cluster: host.cluster });
  const vmDetails = (key                                                               )        => inventory.vms.flatMap(vm => (vm[key] ?? []).map(value => ({ ...vmBase(vm), ...value })));
  const hostDetails = (key                                                             )        => inventory.hosts.flatMap(host => (host[key] ?? []).map(value => ({ ...hostBase(host), ...value })));
  let values        = [];
  switch (tab) {
    case 'vInfo': values = inventory.vms.map(vm => strip(vm,['cpu','memory','disks','partitions','nics','cdroms','usbDevices','snapshots','tools'])); break;
    case 'vCPU': values = inventory.vms.map(vm => ({ ...vmBase(vm), vcpu: vm.vcpu, coresPerSocket: vm.coresPerSocket, cpuReadyPct: vm.cpuReadyPct, ...vm.cpu })); break;
    case 'vMemory': values = inventory.vms.map(vm => ({ ...vmBase(vm), memoryGib: vm.memoryGib, activeMemoryGib: vm.activeMemoryGib, ...vm.memory })); break;
    case 'vDisk': values = vmDetails('disks'); break;
    case 'vPartition': values = vmDetails('partitions'); break;
    case 'vNetwork': values = vmDetails('nics'); break;
    case 'vCD': values = vmDetails('cdroms'); break;
    case 'vUSB': values = vmDetails('usbDevices'); break;
    case 'vSnapshot': values = vmDetails('snapshots'); break;
    case 'vTools': values = inventory.vms.map(vm => ({ ...vmBase(vm), toolsVersion: vm.toolsVersion, toolsStatus: vm.toolsStatus, ...vm.tools })); break;
    case 'vSource': values = (inventory.vcenters ?? []).map(item => ({ ...item })); break;
    case 'vRP': values = (inventory.resourcePools ?? []).map(item => ({ ...item })); break;
    case 'vCluster': values = inventory.clusters.map(item => ({ ...item })); break;
    case 'vHost': values = inventory.hosts.map(host => strip(host,['hbas','physicalNics','standardSwitches','vmkernelAdapters','portGroups','storagePaths'])); break;
    case 'vHBA': values = hostDetails('hbas'); break;
    case 'vNIC': values = hostDetails('physicalNics'); break;
    case 'vSwitch': values = hostDetails('standardSwitches'); break;
    case 'vPort': values = inventory.networks.filter(item => item.kind === 'standard').map(item => ({ ...item })); break;
    case 'dvSwitch': values = (inventory.distributedSwitches ?? []).map(item => ({ ...item })); break;
    case 'dvPort': values = inventory.networks.filter(item => item.kind === 'distributed').map(item => ({ ...item })); break;
    case 'vSC_VMK': values = hostDetails('vmkernelAdapters'); break;
    case 'vDatastore': values = inventory.datastores.map(item => ({ ...item })); break;
    case 'vMultiPath': values = inventory.hosts.filter(host => host.storagePaths).map(host => ({ ...hostBase(host), ...host.storagePaths })); break;
    case 'vLicense': values = (inventory.licenses ?? []).map(item => ({ ...item })); break;
    case 'vFileInfo': values = (inventory.files ?? []).map(item => ({ ...item })); break;
    case 'vHealth': values = (inventory.health ?? []).map(item => ({ ...item })); break;
    case 'vMetaData': values = Object.entries(inventory.source.collectedPerVcenter ?? {}).map(([vcenter,collectedAt]) => ({ vcenter, collectedAt, toolVersion: inventory.source.toolVersion })); break;
  }
  const columns = [...new Set(values.flatMap(row => Object.keys(row)))];
  const display = (value         )         => value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
  const header = (key        ) => key === 'vcenter' ? 'vCenter' : key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/Gib\b/g,'(GiB)').replace(/^./,value=>value.toUpperCase());
  return { headers: columns.map(header), rows: values.map(row => columns.map(key => display(row[key]))), summary: tab === 'vMultiPath' };
}

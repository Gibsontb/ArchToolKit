import { parseIPv4, maskToPrefix, formatCidr, usableAddresses, parseCidr } from '../core/net.js';
import { computeTotals, scopedKey,                                    } from '../vmware/inventory.js';
import { assessHost } from '../vmware/readiness.js';
import { sourceClusters,                 } from './estate-plan.js';

                                      
                       
                           
                           
                         
                                
                                        
                                          
                                        
                                         
                             
                                        
                                         
                            
                            
                                       
 
                               
                       
                           
                                          
                        
                                          
                                       
                                         
                          
 

export function reviewEstateSizing(inventory           , plan            ) {
  const keys = new Set(plan.options.selected);
  if (plan.options.managementSource !== 'new') keys.add(plan.options.managementSource);
  const inScope = (vcenter                    , cluster                    ) => keys.has(scopedKey(vcenter, cluster ?? '(standalone)'));
  const hosts = inventory.hosts.filter(host => inScope(host.vcenter, host.cluster));
  const vms = inventory.vms.filter(vm => inScope(vm.vcenter, vm.cluster));
  const totals = computeTotals({ ...inventory, hosts, vms, vcenters: (inventory.vcenters??[]).filter(center=>hosts.some(host=>host.vcenter===center.name)), clusters: inventory.clusters.filter(cluster => inScope(cluster.vcenter, cluster.name)) });
  const grouped = new Map                         ();
  for (const host of hosts) {
    const key = scopedKey(host.vcenter, host.cluster ?? '(standalone)');
    const group = grouped.get(key) ?? [];
    group.push(host);
    grouped.set(key, group);
  }
  const networks                        = [];
  for (const [key, group] of grouped) {
    const knownCounts = group.map(host => host.physicalNics?.length ?? host.nicCount).filter((value)                  => value !== undefined);
    const speeds = group.map(host => {
      const values = (host.physicalNics ?? []).filter(nic => nic.linkUp !== false).map(nic => nic.speedMb).filter((value)                  => value !== undefined && value > 0);
      return values.length ? Math.max(...values) / 1000 : undefined;
    });
    const knownSpeeds = speeds.filter((value)                  => value !== undefined);
    const findings = new Set        ();
    for (const host of group) for (const check of assessHost(host).checks) {
      if (['nic-speed', 'nic-count'].includes(check.id) && check.status !== 'pass') findings.add(check.detail);
    }
    const names = new Set(group.map(host => host.name));
    const observedNetworks = new Set(group.flatMap(host => (host.vmkernelAdapters ?? []).map(nic => nic.portGroup).filter(Boolean)));
    for(const vm of vms)if((vm.vcenter??'')===(group[0] .vcenter??'')&&vm.host&&names.has(vm.host)){
      for(const name of vm.networks??[])observedNetworks.add(name);
      for(const nic of vm.nics??[])if(nic.network)observedNetworks.add(nic.network);
    }
    const vlans = inventory.networks.filter(network => (network.vcenter ?? '') === (group[0] .vcenter ?? '') && (network.host ? names.has(network.host) : observedNetworks.has(network.name)))
      .map(network => network.vlanId).filter(value => value !== undefined).map(String);
    networks.push({ key, cluster: group[0] .cluster ?? '(standalone)', vcenter: group[0] .vcenter ?? '', hosts: group.length,
      physicalNics: group.reduce((sum, host) => sum + (host.physicalNics?.length ?? 0), 0),
      ...(knownCounts.length === group.length ? { minimumReportedNics: Math.min(...knownCounts) } : {}),
      ...(knownSpeeds.length === group.length ? { minimumFastestNicGbps: Math.min(...knownSpeeds) } : {}),
      hostsWithUnknownNics: group.length - knownCounts.length, hostsWithUnknownSpeed: group.length - knownSpeeds.length,
      downLinks: group.reduce((sum, host) => sum + (host.physicalNics ?? []).filter(nic => nic.linkUp === false).length, 0),
      mtuValues: [...new Set(group.flatMap(host => (host.vmkernelAdapters ?? []).map(nic => nic.mtu).filter((value)                  => value !== undefined)))].sort((a,b) => a-b),
      vlanValues: [...new Set(vlans)].sort(), dnsHosts: group.filter(host => host.dnsServers?.length).length,
      ntpHosts: group.filter(host => host.ntpServers?.length).length, findings: [...findings],
    });
  }
  const subnetMap = new Map                                                                                                                                                  ();
  for (const host of hosts) for (const nic of host.vmkernelAdapters ?? []) {
    const ip = parseIPv4(nic.ip ?? ''), mask = parseIPv4(nic.subnetMask ?? '');
    const prefix = mask === null ? null : maskToPrefix(mask);
    if (ip === null || ip === 0 || mask === null || prefix === null || prefix === 0) continue;
    const network = { network: (ip & mask) >>> 0, prefix };
    const cidr = formatCidr(network), key = JSON.stringify([host.vcenter ?? '', cidr]);
    const entry = subnetMap.get(key) ?? { vcenter: host.vcenter ?? '', cidr, clusterKeys: new Set        (), ips: new Set        (), gateways: new Set        (), ports: new Set        (), usable: usableAddresses(network) };
    entry.clusterKeys.add(scopedKey(host.vcenter, host.cluster ?? '(standalone)'));
    entry.ips.add(nic.ip );
    const gateway = parseIPv4(nic.gateway ?? '');
    if (gateway !== null && ((gateway & mask) >>> 0) === network.network && nic.gateway) entry.gateways.add(nic.gateway);
    if (nic.portGroup) entry.ports.add(nic.portGroup);
    subnetMap.set(key,entry);
  }
  const subnets                 = [...subnetMap].map(([key,value]) => ({ key,vcenter:value.vcenter,cidr:value.cidr,clusterKeys:[...value.clusterKeys],observedIps:[...value.ips],gateways:[...value.gateways],portGroups:[...value.ports],usable:value.usable }));
  return { totals, importedHostCount: inventory.hosts.length, excludedHostCount: inventory.hosts.length - hosts.length, networks, subnets, sourceClusters: sourceClusters(inventory).filter(cluster => keys.has(cluster.key)) };
}
                                                                       

export function addressCapacityChecks(rows                                                             ) {
  const valid = rows.map(row => ({ ...row, parsed: row.cidr ? parseCidr(row.cidr) : null }));
  const needed = new Map               ();
  for(const row of valid)if(row.parsed){const key=formatCidr(row.parsed);needed.set(key,(needed.get(key)??0)+row.required);}
  return valid.map(row => {
    const capacity=row.parsed?usableAddresses(row.parsed):undefined;
    const combined=row.parsed?needed.get(formatCidr(row.parsed)) :row.required;
    let status = 'Range size sufficient; address availability unverified';
    if (!row.cidr) status = 'Subnet not selected';
    else if (!row.parsed) status = 'Invalid IPv4 CIDR';
    else if (capacity !== undefined && capacity < combined) status = 'Address range too small';
    return { role: row.role, cidr: row.cidr, required: row.required, combined, capacity, status };
  });
}

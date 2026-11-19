import type { Inventory } from './inventory.ts';
export interface TopologyNode { readonly id: string; readonly label: string; readonly detail: string; readonly column: number; readonly kind: string; readonly hostIndex?: number; readonly clusterKey?: string; readonly vcenter?: string }
export interface TopologyEdge { readonly from: string; readonly to: string; readonly relationship: string }
export function inventoryTopology(inventory: Inventory, hostIndex: number, network = '', offset = 0, limit = 40) {
  const host = inventory.hosts[hostIndex];
  const nodes: TopologyNode[] = [], edges: TopologyEdge[] = [];
  if (!host) return { nodes, edges, total: 0, shown: 0 };
  const node = (id: string, label: string, detail: string, column: number, kind: string) => {
    if (!nodes.some(value => value.id === id)) nodes.push({ id, label, detail, column, kind });
  };
  const edge = (from: string, to: string, relationship: string) => {
    if (!edges.some(value => value.from === from && value.to === to)) edges.push({ from, to, relationship });
  };
  node('host', host.name, [host.vcenter, host.cluster].filter(Boolean).join(' · '), 0, 'Host');
  const switchNames = new Set((host.standardSwitches ?? []).map(value => value.name));
  for (const sw of inventory.distributedSwitches ?? []) if (sw.vcenter === host.vcenter && sw.hostMembers?.includes(host.name)) switchNames.add(sw.name);
  const workloads = inventory.vms.filter(vm => vm.host === host.name && (vm.vcenter ?? '') === (host.vcenter ?? ''));
  const endpoints = workloads.flatMap(vm => (vm.nics ?? []).map((nic, index) => ({ id: 'vm:' + (vm.uuid ?? vm.name) + ':' + index, name: vm.name + ' / ' + nic.label, detail: [...(nic.ipv4 ?? []), ...(nic.ipv6 ?? []), nic.connected === false ? 'Disconnected' : ''].filter(Boolean).join(', ') || vm.ipAddress || 'IP not recorded', network: nic.network ?? '', sw: nic.switchName ?? '', kind: 'VM NIC', connected: nic.connected })))
    .concat((host.vmkernelAdapters ?? []).map(nic => ({ id: 'vmk:' + nic.name, name: nic.name, detail: [nic.ip, nic.subnetMask, nic.gateway ? 'Gateway ' + nic.gateway : ''].filter(Boolean).join(' · '), network: nic.portGroup ?? '', sw: '', kind: 'VMkernel', connected: true })));
  const matches = endpoints.filter(value => !network || value.network === network);
  const visible = matches.slice(offset, offset + limit);
  for (const endpoint of visible) {
    let switchName = endpoint.sw;
    if (!switchName && endpoint.network) {
      const candidates = inventory.networks.filter(group => group.name === endpoint.network && (group.vcenter ?? '') === (host.vcenter ?? '') && (!group.host || group.host === host.name));
      const choices = [...new Set(candidates.map(group => group.switchName).filter(Boolean))];
      if (choices.length === 1) switchName = choices[0]!;
    }
    node(endpoint.id, endpoint.name, endpoint.detail, 3, endpoint.kind);
    if (endpoint.network) {
      const groupId = JSON.stringify(['port', switchName, endpoint.network]);
      node(groupId, endpoint.network, switchName ? 'Port group / network' : 'Switch association unknown', 2, 'Network');
      edge(groupId, endpoint.id, endpoint.connected === false ? 'Adapter assigned to network; disconnected' : endpoint.connected === undefined ? 'Adapter assigned to network; connection state unknown' : 'Adapter connected to network');
      if (switchName) { switchNames.add(switchName); edge('switch:' + switchName, groupId, 'Switch contains port group'); }
    }
  }
  for (const nic of host.physicalNics ?? []) {
    node('pnic:' + nic.name, nic.name, [nic.speedMb === undefined ? '' : nic.speedMb + ' Mb/s', nic.linkUp === false ? 'Link down' : '', nic.mac].filter(Boolean).join(' · '), 0, 'Physical NIC');
    if (nic.switchName) { switchNames.add(nic.switchName); edge('pnic:' + nic.name, 'switch:' + nic.switchName, 'Recorded uplink association'); }
  }
  for (const name of switchNames) {
    node('switch:' + name, name, 'Virtual switch', 1, 'Switch'); edge('host', 'switch:' + name, 'Host virtual-switch association');
  }
  return { nodes, edges, total: matches.length, shown: visible.length };
}

/** Estate hierarchy, with host detail after choosing a cluster. Names remain vCenter-scoped. */
export function inventoryTopologyOverview(inventory: Inventory, vcenter = '', clusterKey = '') {
  const nodes: TopologyNode[] = [], edges: TopologyEdge[] = [];
  const buckets = new Map<string, { center: string; cluster: string; hosts: { index: number; host: Inventory['hosts'][number] }[] }>();
  const vmsByHost = new Map<string, Inventory['vms']>();
  const hostKey = (center: string | undefined, name: string) => JSON.stringify([center ?? '', name]);
  for (const vm of inventory.vms) {
    if (!vm.host) continue;
    const key = hostKey(vm.vcenter, vm.host); const list = vmsByHost.get(key) ?? []; list.push(vm); vmsByHost.set(key,list);
  }
  inventory.hosts.forEach((host,index) => {
    const center = host.vcenter ?? '', cluster = host.cluster ?? '';
    const key = JSON.stringify([center,cluster]);
    if ((vcenter && center !== vcenter) || (clusterKey && key !== clusterKey)) return;
    const bucket = buckets.get(key) ?? { center,cluster,hosts:[] }; bucket.hosts.push({ index,host }); buckets.set(key,bucket);
  });
  const centers = new Map<string,{hosts:number;vms:number}>();
  const centerVmCounts = new Map<string,number>();
  for(const vm of inventory.vms){
    const center=vm.vcenter??'';
    if((vcenter&&center!==vcenter)||(clusterKey&&JSON.stringify([center,vm.cluster??''])!==clusterKey))continue;
    centerVmCounts.set(center,(centerVmCounts.get(center)??0)+1);
  }
  if(!clusterKey)for(const center of inventory.vcenters??[]){
    if(!vcenter||center.name===vcenter)centers.set(center.name,{hosts:0,vms:centerVmCounts.get(center.name)??0});
  }
  let totalHosts = 0;
  for (const bucket of buckets.values()) {
    const centerId = 'center:' + bucket.center;
    const key = JSON.stringify([bucket.center,bucket.cluster]); const clusterId = 'cluster:' + key;
    const stats = centers.get(bucket.center) ?? { hosts:0,vms:centerVmCounts.get(bucket.center)??0 };
    const workloads = bucket.hosts.flatMap(({host}) => vmsByHost.get(hostKey(host.vcenter,host.name)) ?? []);
    stats.hosts += bucket.hosts.length; centers.set(bucket.center,stats); totalHosts += bucket.hosts.length;
    nodes.push({ id:clusterId,label:bucket.cluster || 'Unclustered hosts',detail:bucket.hosts.length+' hosts · '+workloads.length+' VM entries',column:1,kind:'Cluster',clusterKey:key,vcenter:bucket.center });
    edges.push({ from:centerId,to:clusterId,relationship:'vCenter manages cluster / host group' });
    if (clusterKey) {
      for (const {host,index} of bucket.hosts) {
        const hostId = 'host:'+index;
        const vms = vmsByHost.get(hostKey(host.vcenter,host.name)) ?? [];
        const switchNames = new Set((host.standardSwitches??[]).map(sw=>sw.name));
        for (const vm of vms) for (const nic of vm.nics??[]) if(nic.switchName)switchNames.add(nic.switchName);
        for (const sw of inventory.distributedSwitches??[]) if((sw.vcenter??'')===bucket.center && sw.hostMembers?.includes(host.name))switchNames.add(sw.name);
        nodes.push({ id:hostId,label:host.name,detail:vms.length+' VM entries · '+switchNames.size+' recorded virtual switches',column:2,kind:'Host',hostIndex:index });
        edges.push({ from:clusterId,to:hostId,relationship:'Cluster contains host' });
        for(const name of switchNames){
          const switchId=JSON.stringify(['switch',index,name]);
          nodes.push({id:switchId,label:name,detail:host.name,column:3,kind:'Switch',hostIndex:index});
          edges.push({from:hostId,to:switchId,relationship:'Host virtual-switch association'});
        }
      }
    } else {
      const hostId = 'hosts:'+key, networkId='networks:'+key;
      const networks = new Set<string>();let nicCount=0;
      for(const {host} of bucket.hosts){
        for(const nic of host.vmkernelAdapters??[])if(nic.portGroup)networks.add(nic.portGroup);
      }
      for(const vm of workloads)for(const nic of vm.nics??[]){
        nicCount++;if(nic.network)networks.add(nic.network);
      }
      nodes.push({ id:hostId,label:bucket.hosts.length+' hosts',detail:bucket.hosts.map(({host})=>host.name).join(', '),column:2,kind:'Host group',clusterKey:key,vcenter:bucket.center });
      nodes.push({ id:networkId,label:'Virtual networking',detail:networks.size+' network names · '+nicCount+' VM NICs',column:3,kind:'Network summary',clusterKey:key,vcenter:bucket.center });
      edges.push({from:clusterId,to:hostId,relationship:'Cluster host membership summary'},{from:hostId,to:networkId,relationship:'Recorded networking on member hosts'});
    }
  }
  for(const [name,stats] of centers)nodes.push({ id:'center:'+name,label:name||'vCenter not recorded',detail:stats.hosts+' hosts · '+stats.vms+' VM entries',column:0,kind:'vCenter',vcenter:name });
  return {nodes,edges,total:totalHosts,shown:totalHosts,vcenters:centers.size,clusters:[...buckets.values()].filter(bucket=>bucket.cluster).length,hostGroups:buckets.size};
}

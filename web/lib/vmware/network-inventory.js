import { parseIPv4, maskToPrefix, formatIPv4, formatCidr, usableRange } from '../core/net.js';
                                                       
                                                                                                                                                                      
export function inventoryNetworks(inventory           )                   {
  const rows = (id        , label        , columns          , values                          )                 => ({ id, label, columns, rows: values });
  const text = (value         )         => value === undefined || value === null || value === '' ? '' : Array.isArray(value) ? value.join(', ') : String(value);
  const bool = (value                     ) => value === undefined ? '' : value ? 'Yes' : 'No';
  const groups = new Map                     ();
  for (const net of inventory.networks) {
    const key = JSON.stringify([net.vcenter ?? '', net.name, net.switchName ?? '']);
    const vlans = groups.get(key) ?? new Set        ();
    if (net.vlanId !== undefined) vlans.add(String(net.vlanId));
    groups.set(key, vlans);
  }
  const vlanFor = (vcenter        , network        , switchName        )         => [...(groups.get(JSON.stringify([vcenter, network, switchName])) ?? [])].join(', ');
  const vmRows                          = [];
  for (const vm of inventory.vms) {
    const nics                   = vm.nics?.length ? vm.nics : [{ label: '', network: vm.networks?.join(', ') }];
    for (const nic of nics) vmRows.push({ vCenter: vm.vcenter ?? '', Cluster: vm.cluster ?? '', VM: vm.name, Host: vm.host ?? '',
      Adapter: nic.label, Type: nic.adapter ?? '', Network: nic.network ?? '', Switch: nic.switchName ?? '',
      VLAN: vlanFor(vm.vcenter ?? '', nic.network ?? '', nic.switchName ?? ''), IPv4: text(nic.ipv4), IPv6: text(nic.ipv6),
      'Primary IP': vm.ipAddress ?? '', MAC: nic.mac ?? '', Connected: bool(nic.connected), 'Starts connected': bool(nic.startsConnected) });
  }
  const kernel                          = [], physical                          = [], switches                          = [], dns                          = [];
  const subnets = new Map                                                                                                                                                                                ();
  for (const host of inventory.hosts) {
    const base = { vCenter: host.vcenter ?? '', Cluster: host.cluster ?? '', Host: host.name };
    dns.push({ ...base, 'DNS servers': text(host.dnsServers), Domain: host.domain ?? '', 'Search domains': text(host.dnsSearchDomains), 'NTP servers': text(host.ntpServers), DHCP: bool(host.dhcp) });
    for (const nic of host.vmkernelAdapters ?? []) {
      const ip = parseIPv4(nic.ip ?? ''), mask = parseIPv4(nic.subnetMask ?? '');
      const prefix = mask === null ? null : maskToPrefix(mask);
      let cidr = '';
      if (ip !== null && ip !== 0 && prefix !== null && prefix > 0 && mask !== null) {
        const network = { network: (ip & mask) >>> 0, prefix }; cidr = formatCidr(network);
        const key = JSON.stringify([host.vcenter ?? '', cidr]);
        const range = usableRange(network);
        const entry = subnets.get(key) ?? { vcenter: host.vcenter ?? '', cidr, first: formatIPv4(range.first), last: formatIPv4(range.last), hosts: new Set        (), ips: new Set        (), gateways: new Set        (), ports: new Set        (), clusters: new Set        () };
        entry.hosts.add(host.name); entry.ips.add(nic.ip );
        if (nic.gateway) entry.gateways.add(nic.gateway);
        if (nic.portGroup) entry.ports.add(nic.portGroup);
        if (host.cluster) entry.clusters.add(host.cluster);
        subnets.set(key, entry);
      }
      kernel.push({ ...base, Adapter: nic.name, IPv4: nic.ip ?? '', Mask: nic.subnetMask ?? '', CIDR: cidr, Gateway: nic.gateway ?? '', IPv6: nic.ipv6 ?? '', 'Port group': nic.portGroup ?? '', VLAN: text(nic.vlanId), MTU: text(nic.mtu), Services: text(nic.services), Stack: nic.stack ?? '', DHCP: bool(nic.dhcp), MAC: nic.mac ?? '' });
    }
    for (const nic of host.physicalNics ?? []) physical.push({ ...base, Adapter: nic.name, 'Speed (Mb/s)': text(nic.speedMb), 'Link up': bool(nic.linkUp), MAC: nic.mac ?? '', Driver: nic.driver ?? '', Firmware: nic.firmware ?? '', Switch: nic.switchName ?? '' });
    for (const sw of host.standardSwitches ?? []) switches.push({ ...base, Switch: sw.name, Kind: 'Standard', MTU: text(sw.mtu), Ports: text(sw.ports), 'Free ports': text(sw.freePorts), 'Teaming policy': sw.teamingPolicy ?? '', LACP: '', Uplinks: text(sw.uplinks) });
  }
  for (const sw of inventory.distributedSwitches ?? []) switches.push({ vCenter: sw.vcenter ?? '', Cluster: '', Host: text(sw.hostMembers), Switch: sw.name, Kind: 'Distributed', MTU: text(sw.maxMtu), Ports: text(sw.ports), 'Free ports': '', 'Teaming policy': '', LACP: sw.lacp ?? '', Uplinks: '' });
  return [
    rows('subnets','VMkernel subnets',['vCenter','CIDR','First usable','Last usable','Observed IPs','Hosts','Gateways','Port groups','Clusters'], [...subnets.values()].map(net => ({ vCenter: net.vcenter, CIDR: net.cidr, 'First usable': net.first, 'Last usable': net.last, 'Observed IPs': text([...net.ips]), Hosts: text([...net.hosts]), Gateways: text([...net.gateways]), 'Port groups': text([...net.ports]), Clusters: text([...net.clusters]) }))),
    rows('vms','VM networking',['vCenter','Cluster','VM','Host','Adapter','Type','Network','Switch','VLAN','IPv4','IPv6','Primary IP','MAC','Connected','Starts connected'], vmRows),
    rows('vmkernel','VMkernel adapters',['vCenter','Cluster','Host','Adapter','IPv4','Mask','CIDR','Gateway','IPv6','Port group','VLAN','MTU','Services','Stack','DHCP','MAC'], kernel),
    rows('ports','Port groups and VLANs',['vCenter','Host','Datacenter','Network','Kind','Switch','VLAN','Ports','Active uplinks','Standby uplinks','Teaming policy','Promiscuous','MAC changes','Forged transmits','Blocked'], inventory.networks.map(net => ({ vCenter: net.vcenter ?? '', Host: net.host ?? '', Datacenter: net.datacenter ?? '', Network: net.name, Kind: net.kind ?? '', Switch: net.switchName ?? '', VLAN: text(net.vlanId), Ports: text(net.ports), 'Active uplinks': text(net.activeUplinks), 'Standby uplinks': text(net.standbyUplinks), 'Teaming policy': net.teamingPolicy ?? '', Promiscuous: bool(net.promiscuous), 'MAC changes': bool(net.macChanges), 'Forged transmits': bool(net.forgedTransmits), Blocked: bool(net.blocked) }))),
    rows('physical','Physical NICs',['vCenter','Cluster','Host','Adapter','Speed (Mb/s)','Link up','MAC','Driver','Firmware','Switch'], physical),
    rows('switches','Virtual switches',['vCenter','Cluster','Host','Switch','Kind','MTU','Ports','Free ports','Teaming policy','LACP','Uplinks'], switches),
    rows('dns','Host DNS and NTP',['vCenter','Cluster','Host','DNS servers','Domain','Search domains','NTP servers','DHCP'], dns),
  ];
}

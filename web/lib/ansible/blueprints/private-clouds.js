/**
 * Hand-written private and other clouds playbooks: OpenStack, Proxmox VE,
 * oVirt, Hetzner Cloud, Foreman and Vultr — the network, access rules and
 * machine built together, as an engineer lays out a first environment.
 *
 * Every play talks to an API, so it runs on localhost; tokens and passwords
 * are vault_ variables the page lists in group_vars/all.yml.
 */

                                                        
import { items, on, playbookScenario } from './scenario.js';

/** `port` or `from-to` lines as [min, max]. */
function portRanges(value         )                     {
  return items(value).map((p) => {
    const [a, b] = p.split(/[-:]/).map((n) => Number(n.trim()));
    return [a ?? 0, Number.isFinite(b) ? (b          ) : (a ?? 0)];
  });
}

const LOCAL = { hosts: 'localhost', connection: 'local', gather_facts: false }         ;

export const PRIVATE_CLOUDS_PLAYBOOKS                       = [
  playbookScenario({
    id: 'pc_openstack_network_server',
    label: 'OpenStack – network, router and server',
    description:
      'A tenant network and subnet routed to the external network, a security group, an SSH keypair and a server booted on it.',
    group: 'Playbooks · OpenStack',
    inputs: [
      { id: 'cloud', label: 'Cloud', control: 'text', default: 'mycloud', hint: 'Entry in clouds.yaml' },
      { id: 'prefix', label: 'Name prefix', control: 'text', default: 'app', hint: 'Used for every resource name' },
      { id: 'cidr', label: 'Subnet CIDR', control: 'text', default: '10.20.0.0/24' },
      { id: 'dns_servers', label: 'DNS servers', control: 'textarea', default: '192.0.2.53\n198.51.100.53', hint: 'One per line' },
      { id: 'external_network', label: 'External network', control: 'text', default: 'public', hint: 'Router gateway network' },
      {
        id: 'allowed_ports',
        label: 'Allowed TCP ports',
        control: 'textarea',
        default: '22\n80\n443',
        hint: 'One per line; a range as 8000-8080',
      },
      { id: 'allowed_cidr', label: 'Allowed from', control: 'text', default: '203.0.113.0/24', hint: 'Source CIDR' },
      { id: 'public_key', label: 'SSH public key', control: 'text', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com' },
      { id: 'image', label: 'Image', control: 'text', default: 'ubuntu-24.04', hint: 'Name or ID' },
      { id: 'flavor', label: 'Flavor', control: 'text', default: 'm1.small', hint: 'Name or ID' },
      { id: 'server_name', label: 'Server name', control: 'text', default: 'app01' },
      { id: 'auto_ip', label: 'Floating IP', control: 'toggle', default: true, hint: 'Attach a public address' },
      { id: 'boot_from_volume', label: 'Boot from volume', control: 'toggle', default: false },
      {
        id: 'volume_size',
        label: 'Boot volume size (GB)',
        control: 'number',
        default: 40,
        min: 1,
        showWhen: { input: 'boot_from_volume', equals: ['true'] },
      },
    ],
    plays: (v) => {
      const p = v.prefix;
      const common = { cloud: '{{ os_cloud }}', state: 'present' };
      return [
        {
          name: 'Build an OpenStack network and server',
          ...LOCAL,
          vars: { os_cloud: v.cloud },
          tasks: [
            { name: 'Create the network', 'openstack.cloud.network': { ...common, name: `${p}-net` } },
            {
              name: 'Create the subnet',
              'openstack.cloud.subnet': {
                ...common,
                name: `${p}-subnet`,
                network: `${p}-net`,
                cidr: v.cidr,
                dns_nameservers: items(v.dns_servers),
              },
            },
            {
              name: 'Route the subnet to the external network',
              'openstack.cloud.router': {
                ...common,
                name: `${p}-router`,
                network: v.external_network,
                interfaces: [`${p}-subnet`],
              },
            },
            {
              name: 'Create the security group',
              'openstack.cloud.security_group': { ...common, name: `${p}-sg`, description: `Access to ${p} servers` },
            },
            {
              name: 'Allow inbound TCP {{ item[0] }}-{{ item[1] }}',
              'openstack.cloud.security_group_rule': {
                ...common,
                security_group: `${p}-sg`,
                protocol: 'tcp',
                port_range_min: '{{ item[0] }}',
                port_range_max: '{{ item[1] }}',
                remote_ip_prefix: v.allowed_cidr,
              },
              loop: portRanges(v.allowed_ports),
            },
            { name: 'Upload the SSH keypair', 'openstack.cloud.keypair': { ...common, name: `${p}-key`, public_key: v.public_key } },
            {
              name: 'Boot the server',
              'openstack.cloud.server': {
                ...common,
                name: v.server_name,
                image: v.image,
                flavor: v.flavor,
                key_name: `${p}-key`,
                network: `${p}-net`,
                security_groups: [`${p}-sg`],
                auto_ip: on(v.auto_ip),
                ...(on(v.boot_from_volume) ? { boot_from_volume: true, volume_size: Number(v.volume_size), terminate_volume: true } : {}),
              },
              register: 'server',
            },
            {
              name: 'Show the server addresses',
              'ansible.builtin.debug': { msg: '{{ server.server.access_ipv4 | default(server.server.addresses) }}' },
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'pc_proxmox_vm_clone',
    label: 'Proxmox VE – VM from template',
    description: 'Clone a KVM template, set CPU, memory and cloud-init (user, key, address), then start it.',
    group: 'Playbooks · Proxmox VE',
    inputs: [
      { id: 'api_host', label: 'API host', control: 'text', default: 'pve01.example.com' },
      { id: 'api_user', label: 'API user', control: 'text', default: 'ansible@pve' },
      { id: 'api_token_id', label: 'API token ID', control: 'text', default: 'automation', hint: 'Secret in vault_proxmox_token_secret' },
      { id: 'node', label: 'Node', control: 'text', default: 'pve01' },
      { id: 'template', label: 'Template VM name', control: 'text', default: 'ubuntu-2404-template' },
      { id: 'vm_name', label: 'VM name', control: 'text', default: 'app01' },
      { id: 'newid', label: 'VM ID', control: 'number', default: 120, min: 100 },
      { id: 'full_clone', label: 'Full clone', control: 'toggle', default: true, hint: 'Off = linked clone' },
      {
        id: 'storage',
        label: 'Target storage',
        control: 'text',
        default: 'local-lvm',
        showWhen: { input: 'full_clone', equals: ['true'] },
      },
      { id: 'cores', label: 'Cores', control: 'number', default: 2, min: 1 },
      { id: 'memory', label: 'Memory (MB)', control: 'number', default: 4096, min: 256 },
      { id: 'ipconfig', label: 'net0 IP config', control: 'text', default: 'ip=192.0.2.20/24,gw=192.0.2.1', hint: 'or ip=dhcp' },
      { id: 'ciuser', label: 'Cloud-init user', control: 'text', default: 'admin' },
      { id: 'ssh_key', label: 'SSH public key', control: 'text', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com' },
      { id: 'start', label: 'Start the VM', control: 'toggle', default: true },
    ],
    needs: () => ({ vault_proxmox_token_secret: 'Proxmox API token secret' }),
    plays: (v) => {
      const api = {
        api_host: '{{ proxmox_api_host }}',
        api_user: '{{ proxmox_api_user }}',
        api_token_id: '{{ proxmox_api_token_id }}',
        api_token_secret: '{{ vault_proxmox_token_secret }}',
      };
      const full = on(v.full_clone);
      return [
        {
          name: 'Clone a Proxmox VM from a template',
          ...LOCAL,
          vars: { proxmox_api_host: v.api_host, proxmox_api_user: v.api_user, proxmox_api_token_id: v.api_token_id },
          tasks: [
            {
              name: 'Clone the template',
              'community.proxmox.proxmox_kvm': {
                ...api,
                node: v.node,
                clone: v.template,
                name: v.vm_name,
                newid: Number(v.newid),
                full,
                ...(full ? { storage: v.storage } : {}),
                timeout: 600,
              },
              no_log: true,
            },
            {
              name: 'Set CPU, memory and cloud-init',
              'community.proxmox.proxmox_kvm': {
                ...api,
                node: v.node,
                vmid: Number(v.newid),
                cores: Number(v.cores),
                memory: Number(v.memory),
                ciuser: v.ciuser,
                sshkeys: v.ssh_key,
                ipconfig: { ipconfig0: v.ipconfig },
                update: true,
              },
              no_log: true,
            },
            ...(on(v.start)
              ? [
                  {
                    name: 'Start the VM',
                    'community.proxmox.proxmox_kvm': { ...api, node: v.node, vmid: Number(v.newid), state: 'started' },
                    no_log: true,
                  },
                ]
              : []),
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'pc_proxmox_lxc',
    label: 'Proxmox VE – LXC container',
    description: 'Create an unprivileged LXC container from a template with its root disk, network and SSH key, then start it.',
    group: 'Playbooks · Proxmox VE',
    inputs: [
      { id: 'api_host', label: 'API host', control: 'text', default: 'pve01.example.com' },
      { id: 'api_user', label: 'API user', control: 'text', default: 'ansible@pve' },
      { id: 'api_token_id', label: 'API token ID', control: 'text', default: 'automation', hint: 'Secret in vault_proxmox_token_secret' },
      { id: 'node', label: 'Node', control: 'text', default: 'pve01' },
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'web01.example.com' },
      { id: 'vmid', label: 'Container ID', control: 'number', default: 200, min: 100 },
      { id: 'ostemplate', label: 'OS template', control: 'text', default: 'local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst' },
      { id: 'storage', label: 'Root disk storage', control: 'text', default: 'local-lvm' },
      { id: 'disk_size', label: 'Root disk (GiB)', control: 'number', default: 8, min: 1 },
      { id: 'cores', label: 'Cores', control: 'number', default: 1, min: 1 },
      { id: 'memory', label: 'Memory (MB)', control: 'number', default: 1024, min: 64 },
      { id: 'bridge', label: 'Bridge', control: 'text', default: 'vmbr0' },
      { id: 'ip', label: 'IPv4', control: 'text', default: 'dhcp', hint: 'dhcp or 192.0.2.30/24' },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '', hint: 'For a static address' },
      { id: 'pubkey', label: 'SSH public key', control: 'text', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com' },
      { id: 'unprivileged', label: 'Unprivileged', control: 'toggle', default: true },
      { id: 'onboot', label: 'Start at boot', control: 'toggle', default: true },
    ],
    needs: () => ({ vault_proxmox_token_secret: 'Proxmox API token secret' }),
    plays: (v) => {
      const api = {
        api_host: '{{ proxmox_api_host }}',
        api_user: '{{ proxmox_api_user }}',
        api_token_id: '{{ proxmox_api_token_id }}',
        api_token_secret: '{{ vault_proxmox_token_secret }}',
      };
      const gw = String(v.gateway ?? '').trim();
      const net0 = `name=eth0,bridge=${v.bridge},ip=${v.ip}${gw ? `,gw=${gw}` : ''}`;
      return [
        {
          name: 'Create a Proxmox LXC container',
          ...LOCAL,
          vars: { proxmox_api_host: v.api_host, proxmox_api_user: v.api_user, proxmox_api_token_id: v.api_token_id },
          tasks: [
            {
              name: 'Create the container',
              'community.proxmox.proxmox': {
                ...api,
                node: v.node,
                vmid: Number(v.vmid),
                hostname: v.hostname,
                ostemplate: v.ostemplate,
                disk_volume: { storage: v.storage, size: Number(v.disk_size) },
                cores: Number(v.cores),
                memory: Number(v.memory),
                netif: { net0 },
                pubkey: v.pubkey,
                unprivileged: on(v.unprivileged),
                onboot: on(v.onboot),
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Start the container',
              'community.proxmox.proxmox': { ...api, node: v.node, vmid: Number(v.vmid), state: 'started' },
              no_log: true,
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'pc_ovirt_vm_template',
    label: 'oVirt / RHV – VM from template',
    description: 'Log in to the engine, create a VM from a template with a NIC and cloud-init, start it, and always log out.',
    group: 'Playbooks · oVirt',
    inputs: [
      { id: 'engine_url', label: 'Engine API URL', control: 'text', default: 'https://engine.example.com/ovirt-engine/api' },
      { id: 'username', label: 'User', control: 'text', default: 'admin@internal', hint: 'Password in vault_ovirt_password' },
      { id: 'ca_file', label: 'CA file', control: 'text', default: '/etc/pki/ovirt-engine/ca.pem', hint: 'Engine CA on the control node' },
      { id: 'cluster', label: 'Cluster', control: 'text', default: 'Default' },
      { id: 'template', label: 'Template', control: 'text', default: 'rhel9-template' },
      { id: 'vm_name', label: 'VM name', control: 'text', default: 'app01' },
      { id: 'memory', label: 'Memory', control: 'text', default: '4GiB' },
      { id: 'cpu_cores', label: 'CPU cores', control: 'number', default: 2, min: 1 },
      { id: 'vnic_profile', label: 'vNIC profile', control: 'text', default: 'ovirtmgmt' },
      {
        id: 'vm_type',
        label: 'Optimised for',
        control: 'select',
        options: [
          { value: 'server', label: 'Server' },
          { value: 'desktop', label: 'Desktop' },
          { value: 'high_performance', label: 'High performance' },
        ],
        default: 'server',
      },
      {
        id: 'boot_protocol',
        label: 'Address',
        control: 'select',
        options: [
          { value: 'dhcp', label: 'DHCP' },
          { value: 'static', label: 'Static' },
        ],
        default: 'dhcp',
      },
      { id: 'ip_address', label: 'IP address', control: 'text', default: '192.0.2.40', showWhen: { input: 'boot_protocol', equals: ['static'] } },
      { id: 'netmask', label: 'Netmask', control: 'text', default: '255.255.255.0', showWhen: { input: 'boot_protocol', equals: ['static'] } },
      { id: 'gateway', label: 'Gateway', control: 'text', default: '192.0.2.1', showWhen: { input: 'boot_protocol', equals: ['static'] } },
      { id: 'dns_servers', label: 'DNS servers', control: 'text', default: '192.0.2.53', hint: 'Space separated, at most two' },
      { id: 'ssh_key', label: 'SSH public key', control: 'text', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com' },
      { id: 'high_availability', label: 'Highly available', control: 'toggle', default: true },
    ],
    needs: () => ({ vault_ovirt_password: 'oVirt engine password' }),
    plays: (v) => {
      const static_ = v.boot_protocol === 'static';
      return [
        {
          name: 'Create an oVirt VM from a template',
          ...LOCAL,
          tasks: [
            {
              name: 'Build the VM, logging out whatever happens',
              block: [
                {
                  name: 'Log in to the engine',
                  'ovirt.ovirt.ovirt_auth': {
                    url: v.engine_url,
                    username: v.username,
                    password: '{{ vault_ovirt_password }}',
                    ca_file: v.ca_file,
                  },
                  no_log: true,
                },
                {
                  name: 'Create and start the VM',
                  'ovirt.ovirt.ovirt_vm': {
                    auth: '{{ ovirt_auth }}',
                    name: v.vm_name,
                    cluster: v.cluster,
                    template: v.template,
                    type: v.vm_type,
                    memory: v.memory,
                    cpu_cores: Number(v.cpu_cores),
                    high_availability: on(v.high_availability),
                    nics: [{ name: 'nic1', profile_name: v.vnic_profile }],
                    cloud_init: {
                      host_name: v.vm_name,
                      authorized_ssh_keys: v.ssh_key,
                      dns_servers: v.dns_servers,
                      nic_name: 'eth0',
                      nic_boot_protocol: v.boot_protocol,
                      ...(static_ ? { nic_ip_address: v.ip_address, nic_netmask: v.netmask, nic_gateway: v.gateway } : {}),
                    },
                    state: 'running',
                  },
                },
              ],
              always: [
                {
                  name: 'Log out of the engine',
                  'ovirt.ovirt.ovirt_auth': { state: 'absent', ovirt_auth: '{{ ovirt_auth }}' },
                  when: 'ovirt_auth is defined',
                },
              ],
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'pc_hetzner_server',
    label: 'Hetzner Cloud – network, firewall and server',
    description: 'An SSH key, a private network and subnet, a firewall with inbound rules, and a server attached to all three.',
    group: 'Playbooks · Hetzner Cloud',
    inputs: [
      { id: 'prefix', label: 'Name prefix', control: 'text', default: 'app' },
      { id: 'public_key', label: 'SSH public key', control: 'text', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com' },
      { id: 'network_range', label: 'Network range', control: 'text', default: '10.30.0.0/16' },
      { id: 'subnet_range', label: 'Subnet range', control: 'text', default: '10.30.1.0/24' },
      {
        id: 'network_zone',
        label: 'Network zone',
        control: 'select',
        options: [
          { value: 'eu-central', label: 'eu-central (fsn1, nbg1, hel1)' },
          { value: 'us-east', label: 'us-east (ash)' },
          { value: 'us-west', label: 'us-west (hil)' },
          { value: 'ap-southeast', label: 'ap-southeast (sin)' },
        ],
        default: 'eu-central',
      },
      {
        id: 'location',
        label: 'Location',
        control: 'combo',
        options: ['fsn1', 'nbg1', 'hel1', 'ash', 'hil', 'sin'].map((l) => ({ value: l, label: l })),
        default: 'fsn1',
        hint: 'Must be in the network zone',
      },
      { id: 'allowed_ports', label: 'Allowed TCP ports', control: 'textarea', default: '22\n80\n443', hint: 'One per line; a range as 8000-8080' },
      { id: 'allowed_cidrs', label: 'Allowed from', control: 'textarea', default: '0.0.0.0/0\n::/0', hint: 'One CIDR per line' },
      { id: 'server_name', label: 'Server name', control: 'text', default: 'app01' },
      { id: 'server_type', label: 'Server type', control: 'combo', options: ['cx22', 'cx32', 'cpx21', 'cpx31', 'cax21'].map((t) => ({ value: t, label: t })), default: 'cx22' },
      { id: 'image', label: 'Image', control: 'text', default: 'ubuntu-24.04' },
      { id: 'backups', label: 'Backups', control: 'toggle', default: false },
      { id: 'protect', label: 'Delete and rebuild protection', control: 'toggle', default: false },
    ],
    needs: () => ({ vault_hcloud_token: 'Hetzner Cloud API token (project read/write)' }),
    plays: (v) => {
      const p = v.prefix;
      const api = { api_token: '{{ vault_hcloud_token }}' };
      const rules = portRanges(v.allowed_ports).map(([a, b]) => ({
        description: a === b ? `tcp ${a}` : `tcp ${a}-${b}`,
        direction: 'in',
        protocol: 'tcp',
        port: a === b ? String(a) : `${a}-${b}`,
        source_ips: items(v.allowed_cidrs),
      }));
      return [
        {
          name: 'Build a Hetzner Cloud server',
          ...LOCAL,
          tasks: [
            { name: 'Upload the SSH key', 'hetzner.hcloud.ssh_key': { ...api, name: `${p}-key`, public_key: v.public_key, state: 'present' }, no_log: true },
            { name: 'Create the network', 'hetzner.hcloud.network': { ...api, name: `${p}-net`, ip_range: v.network_range, state: 'present' }, no_log: true },
            {
              name: 'Create the subnet',
              'hetzner.hcloud.subnetwork': {
                ...api,
                network: `${p}-net`,
                ip_range: v.subnet_range,
                network_zone: v.network_zone,
                type: 'cloud',
                state: 'present',
              },
              no_log: true,
            },
            { name: 'Create the firewall', 'hetzner.hcloud.firewall': { ...api, name: `${p}-fw`, rules, state: 'present' }, no_log: true },
            {
              name: 'Create the server',
              'hetzner.hcloud.server': {
                ...api,
                name: v.server_name,
                server_type: v.server_type,
                image: v.image,
                location: v.location,
                ssh_keys: [`${p}-key`],
                firewalls: [`${p}-fw`],
                private_networks: [`${p}-net`],
                backups: on(v.backups),
                delete_protection: on(v.protect),
                rebuild_protection: on(v.protect),
                labels: { role: p },
                state: 'present',
              },
              register: 'server',
              no_log: true,
            },
            { name: 'Show the server address', 'ansible.builtin.debug': { msg: '{{ server.hcloud_server.ipv4_address }}' } },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'pc_foreman_hostgroup_host',
    label: 'Foreman – host group and host',
    description: 'A host group carrying the OS, network and Puppet/Ansible defaults, and a host built from it.',
    group: 'Playbooks · Foreman',
    inputs: [
      { id: 'server_url', label: 'Foreman URL', control: 'text', default: 'https://foreman.example.com' },
      { id: 'username', label: 'User', control: 'text', default: 'admin', hint: 'Password in vault_foreman_password' },
      { id: 'organization', label: 'Organization', control: 'text', default: 'Example Org' },
      { id: 'location', label: 'Location', control: 'text', default: 'Datacenter 1' },
      { id: 'hostgroup', label: 'Host group', control: 'text', default: 'rhel9-web' },
      { id: 'operatingsystem', label: 'Operating system', control: 'text', default: 'RedHat 9.4', hint: 'Title as Foreman shows it' },
      { id: 'architecture', label: 'Architecture', control: 'select', options: [{ value: 'x86_64', label: 'x86_64' }, { value: 'aarch64', label: 'aarch64' }], default: 'x86_64' },
      { id: 'domain', label: 'Domain', control: 'text', default: 'example.com' },
      { id: 'subnet', label: 'Subnet', control: 'text', default: 'prod-192.0.2.0' },
      { id: 'ptable', label: 'Partition table', control: 'text', default: 'Kickstart default' },
      { id: 'medium', label: 'Installation medium', control: 'text', default: 'CentOS Stream 9 mirror' },
      {
        id: 'pxe_loader',
        label: 'PXE loader',
        control: 'select',
        options: ['Grub2 UEFI', 'Grub2 UEFI SecureBoot', 'PXELinux BIOS', 'iPXE Embedded'].map((l) => ({ value: l, label: l })),
        default: 'Grub2 UEFI',
      },
      { id: 'ansible_roles', label: 'Ansible roles', control: 'textarea', default: 'theforeman.foreman_scap_client', hint: 'One per line; leave empty for none' },
      { id: 'host_name', label: 'Host FQDN', control: 'text', default: 'web01.example.com' },
      { id: 'mac', label: 'MAC address', control: 'text', default: '52:54:00:12:34:56', hint: 'For PXE build' },
      { id: 'ip', label: 'IP address', control: 'text', default: '192.0.2.50' },
      { id: 'build', label: 'Build on next boot', control: 'toggle', default: true },
    ],
    needs: () => ({ vault_foreman_password: 'Foreman user password' }),
    plays: (v) => {
      const roles = items(v.ansible_roles);
      const api = { server_url: v.server_url, username: v.username, password: '{{ vault_foreman_password }}' };
      return [
        {
          name: 'Define a Foreman host group and host',
          ...LOCAL,
          tasks: [
            {
              name: 'Create the host group',
              'theforeman.foreman.hostgroup': {
                ...api,
                name: v.hostgroup,
                organizations: [v.organization],
                locations: [v.location],
                operatingsystem: v.operatingsystem,
                architecture: v.architecture,
                domain: v.domain,
                subnet: v.subnet,
                ptable: v.ptable,
                medium: v.medium,
                pxe_loader: v.pxe_loader,
                ...(roles.length > 0 ? { ansible_roles: roles } : {}),
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Create the host',
              'theforeman.foreman.host': {
                ...api,
                name: v.host_name,
                hostgroup: v.hostgroup,
                organization: v.organization,
                location: v.location,
                mac: v.mac,
                ip: v.ip,
                build: on(v.build),
                managed: true,
                state: 'present',
              },
              no_log: true,
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'pc_vultr_instance',
    label: 'Vultr – VPC, firewall and instance',
    description: 'An SSH key, a VPC, a firewall group with inbound rules, and an instance placed in all three.',
    group: 'Playbooks · Vultr',
    inputs: [
      { id: 'prefix', label: 'Name prefix', control: 'text', default: 'app' },
      {
        id: 'region',
        label: 'Region',
        control: 'combo',
        options: ['ams', 'fra', 'lhr', 'ewr', 'ord', 'lax', 'sgp', 'nrt', 'syd'].map((r) => ({ value: r, label: r })),
        default: 'fra',
      },
      { id: 'public_key', label: 'SSH public key', control: 'text', default: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample admin@example.com' },
      { id: 'vpc_subnet', label: 'VPC subnet', control: 'text', default: '10.40.0.0' },
      { id: 'vpc_mask', label: 'VPC mask bits', control: 'number', default: 24, min: 8, max: 29 },
      { id: 'allowed_ports', label: 'Allowed TCP ports', control: 'textarea', default: '22\n443', hint: 'One per line; a range as 8000:8080' },
      { id: 'allowed_cidr', label: 'Allowed from', control: 'text', default: '203.0.113.0/24' },
      { id: 'label', label: 'Instance label', control: 'text', default: 'app01' },
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'app01.example.com' },
      { id: 'plan', label: 'Plan', control: 'combo', options: ['vc2-1c-1gb', 'vc2-1c-2gb', 'vc2-2c-4gb', 'vhf-2c-4gb'].map((p) => ({ value: p, label: p })), default: 'vc2-1c-2gb' },
      { id: 'os', label: 'Operating system', control: 'text', default: 'Ubuntu 24.04 LTS x64' },
      { id: 'backups', label: 'Automatic backups', control: 'toggle', default: false },
      { id: 'enable_ipv6', label: 'IPv6', control: 'toggle', default: true },
    ],
    needs: () => ({ vault_vultr_api_key: 'Vultr API key' }),
    plays: (v) => {
      const p = v.prefix;
      const api = { api_key: '{{ vault_vultr_api_key }}' };
      const [net, bits] = String(v.allowed_cidr).split('/');
      return [
        {
          name: 'Build a Vultr instance',
          ...LOCAL,
          tasks: [
            { name: 'Upload the SSH key', 'vultr.cloud.ssh_key': { ...api, name: `${p}-key`, ssh_key: v.public_key }, no_log: true },
            {
              name: 'Create the VPC',
              'vultr.cloud.vpc': { ...api, description: `${p}-vpc`, region: v.region, v4_subnet: v.vpc_subnet, v4_subnet_mask: Number(v.vpc_mask) },
              no_log: true,
            },
            { name: 'Create the firewall group', 'vultr.cloud.firewall_group': { ...api, description: `${p}-fw` }, no_log: true },
            {
              name: 'Allow inbound TCP {{ item }}',
              'vultr.cloud.firewall_rule': {
                ...api,
                group: `${p}-fw`,
                protocol: 'tcp',
                port: '{{ item }}',
                ip_type: 'v4',
                subnet: net,
                subnet_size: Number(bits ?? 32),
              },
              loop: items(v.allowed_ports).map((x) => x.replace('-', ':')),
              no_log: true,
            },
            {
              name: 'Create the instance',
              'vultr.cloud.instance': {
                ...api,
                label: v.label,
                hostname: v.hostname,
                region: v.region,
                plan: v.plan,
                os: v.os,
                ssh_keys: [`${p}-key`],
                vpcs: [`${p}-vpc`],
                firewall_group: `${p}-fw`,
                backups: on(v.backups),
                enable_ipv6: on(v.enable_ipv6),
                tags: [p],
              },
              register: 'instance',
              no_log: true,
            },
            { name: 'Show the instance address', 'ansible.builtin.debug': { msg: '{{ instance.vultr_instance.main_ip }}' } },
          ],
        },
      ];
    },
  }),
];

/**
 * Ansible from the imported estate.
 *
 * Terraform declares where the VMs land; Ansible is what works on them and on
 * vCenter around the move. From the estate it can write three things without
 * anyone typing a VM name:
 *
 *  - **An inventory** of a cluster's VMs, grouped by OS, folder and cluster,
 *    with the address each guest reports — what every guest-side play before
 *    or after a migration runs against.
 *  - **Before the move**, a play against vCenter that removes the snapshots a
 *    replication tool will refuse or copy, gated off by default because it
 *    cannot be undone, and a report of everything else the readiness checks
 *    found (mounted ISOs, RDMs, stopped Tools) so the run log is the worklist.
 *  - **After the move**, a play against the target vCenter that recreates the
 *    DRS rules between the VMs and puts their custom attributes back.
 *
 * Module arguments are the collections' documented ones (community.vmware
 * 5.x). Credentials come from VMWARE_HOST, VMWARE_USER and VMWARE_PASSWORD,
 * which every community.vmware module reads.
 */

import { info, warning,              } from '../core/findings.js';
import { familyOf, isIp, isIpv6 } from '../core/ip.js';
                                                                     
import { assessVm } from '../vmware/vm-readiness.js';
import { vmsInScope,                  } from '../terraform/estate.js';
import { renderYaml,                } from './yaml.js';
import { playbookFiles } from './from-plays.js';

                                     
                                         
                               
 

                                            

function osOf(vm             )                      {
  const text = `${vm.guestOsTools ?? ''} ${vm.guestOs ?? ''} ${vm.guestDetail?.familyName ?? ''}`.toLowerCase();
  return text.includes('windows') ? 'windows' : 'linux';
}

/** A group name Ansible accepts: letters, digits, underscores. */
function groupName(prefix        , value        )         {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${prefix}_${cleaned || 'none'}`;
}

/** vSphere's folder argument: /datacenter/vm/path, from RVTools' /datacenter/path. */
export function vmFolder(vm             )                     {
  const parts = (vm.folder ?? '').split('/').filter(Boolean);
  if (parts.length === 0) return vm.datacenter ? `/${vm.datacenter}/vm` : undefined;
  const [dc, ...rest] = parts;
  return `/${dc}/vm${rest.length > 0 ? `/${rest.join('/')}` : ''}`;
}

/**
 * The address Ansible connects to: the primary IP when it is one, else the
 * first IPv4, else the first routable IPv6. Link-local fe80:: needs an
 * interface zone that means nothing on the control node, so it is skipped.
 * ansible_host takes a bare IPv6 literal, no brackets.
 */
export function hostAddress(vm             )                     {
  const usable = (ip        )          => isIp(ip) && !(isIpv6(ip) && /^fe[89ab]/i.test(ip.trim()));
  if (vm.ipAddress && usable(vm.ipAddress)) return vm.ipAddress.trim();
  const candidates = (vm.ipAddresses ?? []).map((ip) => ip.trim()).filter(usable);
  return candidates.find((ip) => familyOf(ip) === 4) ?? candidates[0];
}

function noEstate(inventory                              , scope             )            {
  if (!inventory) {
    return [
      warning('estate.ansible.no-estate', 'No estate is loaded, so there are no VMs to write.', {
        remediation: 'Import an RVTools export with the strip at the top of the page.',
      }),
    ];
  }
  if (!scope.cluster) return [warning('estate.ansible.no-cluster', 'Choose a source cluster.')];
  return [];
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export function estateInventoryFiles(
  inventory                              ,
  scope                                                                       ,
)                     {
  const findings = noEstate(inventory, scope);
  const { vms } = vmsInScope(inventory, { ...scope, includePoweredOff: scope.includePoweredOff ?? true });
  const selected = vms.filter((vm) => !scope.os || scope.os === 'all' || osOf(vm) === scope.os);

  const byOs                                                         = { windows: {}, linux: {} };
  const byFolder = new Map                                   ();
  const noAddress           = [];

  for (const vm of selected) {
    const address = hostAddress(vm);
    if (!address) noAddress.push(vm.name);
    const vars                            = {};
    if (address) vars.ansible_host = address;
    if (vm.dnsName && vm.dnsName !== vm.name) vars.dns_name = vm.dnsName;
    vars.vm_cluster = vm.cluster ?? '';
    if (vm.folder) vars.vm_folder = vm.folder;
    if (vm.guestOsTools ?? vm.guestOs) vars.guest_os = vm.guestOsTools ?? vm.guestOs ?? '';
    vars.power_state = vm.powerState;
    byOs[osOf(vm)][vm.name] = vars;
    const leaf = (vm.folder ?? '').split('/').filter(Boolean).pop();
    if (leaf) {
      const g = groupName('folder', leaf);
      const hosts = byFolder.get(g) ?? {};
      hosts[vm.name] = null;
      byFolder.set(g, hosts);
    }
  }

  const children                            = {};
  if (Object.keys(byOs.windows).length > 0) {
    children.windows = {
      hosts: byOs.windows,
      vars: {
        ansible_connection: 'winrm',
        ansible_port: scope.winrmPort ?? 5986,
        ansible_winrm_transport: 'kerberos',
        ansible_winrm_server_cert_validation: 'validate',
      },
    };
  }
  if (Object.keys(byOs.linux).length > 0) {
    children.linux = { hosts: byOs.linux, vars: { ansible_connection: 'ssh' } };
  }
  if (scope.cluster) {
    children[groupName('cluster', scope.cluster)] = {
      hosts: Object.fromEntries(selected.map((vm) => [vm.name, null])),
    };
  }
  for (const [g, hosts] of [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) children[g] = { hosts };

  if (noAddress.length > 0) {
    findings.push(
      info(
        'estate.ansible.no-address',
        `${noAddress.length} VM(s) report no usable IP address (Tools not running, or powered off) and are listed by name only: ${noAddress.slice(0, 5).join(', ')}${noAddress.length > 5 ? '…' : ''}.`,
        { remediation: 'They resolve through DNS if their names are registered; otherwise add ansible_host by hand.' },
      ),
    );
  }

  const yaml = renderYaml({ all: { children } }             , {
    header: [
      `Inventory of ${selected.length} VM(s) in ${scope.cluster || 'no cluster'}`,
      '',
      'Groups: windows and linux (with their connection settings), the source',
      'cluster, and one group per VM folder. Addresses are what VMware Tools',
      'reported when the estate was collected.',
      '',
      'Use with:  ansible-playbook -i hosts.yml <playbook>.yml',
    ].join('\n'),
  });
  return { files: { 'hosts.yml': yaml }, findings };
}

// ---------------------------------------------------------------------------
// Before the move
// ---------------------------------------------------------------------------

export function premigrationFiles(inventory                              , scope             )                     {
  const findings = noEstate(inventory, scope);
  const { vms } = vmsInScope(inventory, { ...scope, includePoweredOff: true });

  const withSnapshots = vms
    .filter((vm) => (vm.snapshotCount ?? 0) > 0)
    .map((vm) => ({ name: vm.name, datacenter: vm.datacenter ?? '', folder: vmFolder(vm) ?? '' }));

  const worklist                           = {};
  for (const vm of vms) {
    for (const f of assessVm(vm, inventory?.source.collectedAt)) {
      if (f.check.severity === 'note') continue;
      (worklist[f.check.title] ??= []).push(`${vm.name}: ${f.detail}`);
    }
  }

  const plays            = [
    {
      name: `Prepare ${scope.cluster || 'the cluster'} for migration`,
      hosts: 'localhost',
      gather_facts: false,
      vars: {
        // Removing snapshots cannot be undone; the run has to ask for it.
        remove_snapshots: false,
        vms_with_snapshots: withSnapshots,
        worklist,
      },
      tasks: [
        {
          name: 'Report what the readiness checks found',
          'ansible.builtin.debug': { msg: '{{ item.key }}: {{ item.value | length }} VM(s) — {{ item.value[:10] | join(", ") }}' },
          loop: '{{ worklist | dict2items }}',
          loop_control: { label: '{{ item.key }}' },
        },
        {
          name: 'Remove every snapshot on VMs that have them',
          'community.vmware.vmware_guest_snapshot': {
            datacenter: '{{ item.datacenter }}',
            folder: '{{ item.folder }}',
            name: '{{ item.name }}',
            state: 'remove_all',
          },
          loop: '{{ vms_with_snapshots }}',
          loop_control: { label: '{{ item.name }}' },
          when: 'remove_snapshots | bool',
        },
      ],
    },
  ]             ;

  const out = playbookFiles(plays, 'premigration', `Before moving ${scope.cluster || 'the cluster'}`);
  findings.push(...out.findings);
  if (withSnapshots.length > 0) {
    findings.push(
      info(
        'estate.ansible.snapshots',
        `${withSnapshots.length} VM(s) have snapshots. The play removes them only when run with -e remove_snapshots=true.`,
      ),
    );
  }
  return { files: { ...out.files }, findings };
}

// ---------------------------------------------------------------------------
// After the move
// ---------------------------------------------------------------------------

                                                           
                                    
                                 
                                    
 

export function postmigrationFiles(
  inventory                              ,
  options                      ,
)                     {
  const findings = noEstate(inventory, options);
  const { vms } = vmsInScope(inventory, { ...options, includePoweredOff: true });

  const rules = new Map                                          ();
  for (const vm of vms) {
    (vm.clusterRuleNames ?? []).forEach((rule, i) => {
      const kind = vm.clusterRules?.[i] ?? vm.clusterRules?.[0] ?? '';
      const entry = rules.get(rule) ?? { anti: /anti/i.test(kind), vms: [] };
      entry.vms.push(vm.name);
      rules.set(rule, entry);
    });
  }
  const drsRules = [...rules.entries()]
    .filter(([, r]) => r.vms.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, r]) => ({ name, affinity: !r.anti, vms: r.vms.sort() }));

  const attributes = options.carryAttributes
    ? vms
        .filter((vm) => Object.keys(vm.customAttributes ?? {}).length > 0)
        .map((vm) => ({
          name: vm.name,
          attributes: Object.entries(vm.customAttributes ?? {}).map(([name, value]) => ({ name, value })),
        }))
    : [];

  const plays            = [
    {
      name: `Restore ${options.cluster || 'the cluster'}'s rules and attributes on the target`,
      hosts: 'localhost',
      gather_facts: false,
      vars: {
        target_datacenter: options.targetDatacenter,
        target_cluster: options.targetCluster,
        drs_rules: drsRules,
        vm_attributes: attributes,
      },
      tasks: [
        {
          name: 'Recreate DRS rules between the migrated VMs',
          'community.vmware.vmware_vm_vm_drs_rule': {
            cluster_name: '{{ target_cluster }}',
            drs_rule_name: '{{ item.name }}',
            vms: '{{ item.vms }}',
            affinity_rule: '{{ item.affinity }}',
            enabled: true,
            mandatory: false,
            state: 'present',
          },
          loop: '{{ drs_rules }}',
          loop_control: { label: '{{ item.name }}' },
        },
        {
          name: 'Put custom attributes back on each VM',
          'community.vmware.vmware_guest_custom_attributes': {
            datacenter: '{{ target_datacenter }}',
            name: '{{ item.name }}',
            attributes: '{{ item.attributes }}',
            state: 'present',
          },
          loop: '{{ vm_attributes }}',
          loop_control: { label: '{{ item.name }}' },
        },
      ],
    },
  ]             ;

  const out = playbookFiles(plays, 'postmigration', `After moving ${options.cluster || 'the cluster'}`);
  findings.push(...out.findings);
  findings.push(
    info(
      'estate.ansible.post-summary',
      `${drsRules.length} DRS rule(s) and custom attributes for ${attributes.length} VM(s).`,
      { remediation: 'The custom attribute definitions must exist on the target vCenter first; the Terraform landing zone creates them.' },
    ),
  );
  return { files: { ...out.files }, findings };
}

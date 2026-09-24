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

import { info, warning, type Finding } from '../core/findings.ts';
import type { Inventory, InventoryVm } from '../vmware/inventory.ts';
import { assessVm } from '../vmware/vm-readiness.ts';
import { vmsInScope, type EstateScope } from '../terraform/estate.ts';
import { renderYaml, type YamlValue } from './yaml.ts';
import { playbookFiles } from './from-plays.ts';

export interface EstateAnsibleFiles {
  readonly files: Record<string, string>;
  readonly findings: Finding[];
}

type OsFilter = 'all' | 'windows' | 'linux';

function osOf(vm: InventoryVm): 'windows' | 'linux' {
  const text = `${vm.guestOsTools ?? ''} ${vm.guestOs ?? ''} ${vm.guestDetail?.familyName ?? ''}`.toLowerCase();
  return text.includes('windows') ? 'windows' : 'linux';
}

/** A group name Ansible accepts: letters, digits, underscores. */
function groupName(prefix: string, value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${prefix}_${cleaned || 'none'}`;
}

/** vSphere's folder argument: /datacenter/vm/path, from RVTools' /datacenter/path. */
export function vmFolder(vm: InventoryVm): string | undefined {
  const parts = (vm.folder ?? '').split('/').filter(Boolean);
  if (parts.length === 0) return vm.datacenter ? `/${vm.datacenter}/vm` : undefined;
  const [dc, ...rest] = parts;
  return `/${dc}/vm${rest.length > 0 ? `/${rest.join('/')}` : ''}`;
}

function noEstate(inventory: Inventory | null | undefined, scope: EstateScope): Finding[] {
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
  inventory: Inventory | null | undefined,
  scope: EstateScope & { readonly os?: OsFilter; readonly winrmPort?: number },
): EstateAnsibleFiles {
  const findings = noEstate(inventory, scope);
  const { vms } = vmsInScope(inventory, { ...scope, includePoweredOff: scope.includePoweredOff ?? true });
  const selected = vms.filter((vm) => !scope.os || scope.os === 'all' || osOf(vm) === scope.os);

  const byOs: Record<'windows' | 'linux', Record<string, YamlValue>> = { windows: {}, linux: {} };
  const byFolder = new Map<string, Record<string, YamlValue>>();
  const noAddress: string[] = [];

  for (const vm of selected) {
    const address = vm.ipAddress ?? vm.ipAddresses?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (!address) noAddress.push(vm.name);
    const vars: Record<string, YamlValue> = {};
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

  const children: Record<string, YamlValue> = {};
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
        `${noAddress.length} VM(s) report no IPv4 address (Tools not running, or powered off) and are listed by name only: ${noAddress.slice(0, 5).join(', ')}${noAddress.length > 5 ? '…' : ''}.`,
        { remediation: 'They resolve through DNS if their names are registered; otherwise add ansible_host by hand.' },
      ),
    );
  }

  const yaml = renderYaml({ all: { children } } as YamlValue, {
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

export function premigrationFiles(inventory: Inventory | null | undefined, scope: EstateScope): EstateAnsibleFiles {
  const findings = noEstate(inventory, scope);
  const { vms } = vmsInScope(inventory, { ...scope, includePoweredOff: true });

  const withSnapshots = vms
    .filter((vm) => (vm.snapshotCount ?? 0) > 0)
    .map((vm) => ({ name: vm.name, datacenter: vm.datacenter ?? '', folder: vmFolder(vm) ?? '' }));

  const worklist: Record<string, string[]> = {};
  for (const vm of vms) {
    for (const f of assessVm(vm, inventory?.source.collectedAt)) {
      if (f.check.severity === 'note') continue;
      (worklist[f.check.title] ??= []).push(`${vm.name}: ${f.detail}`);
    }
  }

  const plays: YamlValue = [
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
  ] as YamlValue;

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

export interface PostmigrationOptions extends EstateScope {
  readonly targetDatacenter: string;
  readonly targetCluster: string;
  readonly carryAttributes: boolean;
}

export function postmigrationFiles(
  inventory: Inventory | null | undefined,
  options: PostmigrationOptions,
): EstateAnsibleFiles {
  const findings = noEstate(inventory, options);
  const { vms } = vmsInScope(inventory, { ...options, includePoweredOff: true });

  const rules = new Map<string, { anti: boolean; vms: string[] }>();
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

  const plays: YamlValue = [
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
  ] as YamlValue;

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

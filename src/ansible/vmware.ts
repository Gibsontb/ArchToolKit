/**
 * vSphere playbooks, generated from the toolkit's own inventory model.
 *
 * This is where the three halves of the toolkit meet. The VMware tool reads an
 * estate into a canonical inventory; Terraform can express the target state of a
 * new one; and Ansible is what reads an existing estate and what reconfigures
 * it in place. So there are two directions here, and they are deliberately
 * separate:
 *
 *  - Collection: a playbook that gathers clusters, hosts and VMs and writes
 *    them to JSON, which the inventory importer can read back. It turns the
 *    toolkit's import step into something schedulable, and works where an
 *    RVTools export is not available.
 *  - Configuration: cluster settings taken from an inventory already imported,
 *    rendered as the tasks that would produce them. That is how an estate
 *    someone else built becomes something under version control.
 *
 * Every module name and every argument name below was read from the collection's
 * own documentation for the version the catalog holds, not from memory. Values
 * that are enumerations — DRS automation level, HA isolation response — are
 * checked against the choices the module actually accepts, because a plausible
 * spelling is rejected at run time with an error that names the argument and not
 * the value.
 *
 * No credentials are generated. Every module in vmware.vmware falls back to
 * VMWARE_HOST, VMWARE_USER, VMWARE_PASSWORD, VMWARE_PORT and
 * VMWARE_VALIDATE_CERTS, so the playbook can name none of them and still run.
 *
 * Verification: V-DOC (vmware.vmware 2.10.0 module documentation, retrieved
 * 2026-09-20).
 */

import { info, warning, type Finding } from '../core/findings.ts';
import type { Inventory, InventoryCluster } from '../vmware/inventory.ts';
import { emitPlaybook, type Play, type PlaybookTask, type PlaybookOutput } from './playbook.ts';

/** DRS automation levels vmware.vmware.cluster_drs accepts. */
export const DRS_BEHAVIORS = ['fullyAutomated', 'partiallyAutomated', 'manual'] as const;
export type DrsBehavior = (typeof DRS_BEHAVIORS)[number];

/** Host isolation responses vmware.vmware.cluster_ha accepts. */
export const HA_ISOLATION_RESPONSES = ['none', 'powerOff', 'shutdown'] as const;

export interface VmwarePlaybookOptions {
  /** Datacenter every task runs against. vSphere has no global scope. */
  readonly datacenter: string;
  /**
   * Where collected JSON is written, relative to the control node's working
   * directory. Each file is one of the inventory importer's inputs.
   */
  readonly outputDirectory?: string;
  /**
   * Trust the vCenter certificate. Left undefined the module's own default
   * applies, which is to validate — the right default, and not one to override
   * from a generator.
   */
  readonly validateCerts?: boolean;
}

/**
 * Normalise an automation level from whatever the source called it.
 *
 * RVTools writes "Fully Automated", PowerCLI writes "FullyAutomated", and the
 * API writes "fullyAutomated". All three mean the same cluster, and only one of
 * them is a value the module accepts.
 */
export function normaliseDrsBehavior(value: string | undefined): DrsBehavior | undefined {
  if (!value) return undefined;
  const flat = value.replace(/[\s_-]/g, '').toLowerCase();
  for (const behavior of DRS_BEHAVIORS) {
    if (behavior.toLowerCase() === flat) return behavior;
  }
  return undefined;
}

const CONNECTION_NOTE = [
  'Connection details come from the environment, not from this file:',
  '',
  '  VMWARE_HOST             vCenter FQDN',
  '  VMWARE_USER             username',
  '  VMWARE_PASSWORD         password',
  '  VMWARE_VALIDATE_CERTS   false only where the certificate is genuinely untrusted',
  '',
  'Every module in vmware.vmware reads those, so no credential appears here and',
  'none reaches version control.',
].join('\n');

/**
 * A playbook that reads an estate into JSON the inventory importer can load.
 *
 * The three gathers are separate tasks rather than one, because they fail
 * separately: a permissions problem on hosts should not cost the VM list.
 */
export function emitInventoryCollection(options: VmwarePlaybookOptions): PlaybookOutput {
  const outputDir = options.outputDirectory ?? './collected';
  const common: Record<string, string | boolean> = { datacenter: options.datacenter };
  if (options.validateCerts !== undefined) common.validate_certs = options.validateCerts;

  const write = (name: string, source: string): PlaybookTask => ({
    name: `Write ${name}.json`,
    module: 'ansible.builtin.copy',
    arguments: {
      // to_nice_json keeps the file readable and diffable, which matters when
      // two collections a week apart are compared to find what changed.
      content: `{{ ${source} | to_nice_json }}\n`,
      dest: `${outputDir}/${name}.json`,
      mode: '0644',
    },
  });

  const play: Play = {
    name: `Collect ${options.datacenter} into JSON`,
    hosts: 'localhost',
    // Nothing here touches the control node's own facts.
    gatherFacts: false,
    tasks: [
      {
        name: 'Make sure the output directory exists',
        module: 'ansible.builtin.file',
        arguments: { path: outputDir, state: 'directory', mode: '0755' },
      },
      {
        name: 'Gather clusters',
        module: 'vmware.vmware.cluster_info',
        arguments: { ...common },
        register: 'clusters',
      },
      {
        name: 'Gather ESXi hosts',
        module: 'vmware.vmware.esxi_info',
        arguments: { ...common },
        register: 'esxi_hosts',
      },
      {
        name: 'Gather virtual machines',
        module: 'vmware.vmware.vm_info',
        arguments: { ...common },
        register: 'virtual_machines',
      },
      write('clusters', 'clusters'),
      write('hosts', 'esxi_hosts'),
      write('vms', 'virtual_machines'),
    ],
  };

  return emitPlaybook([play], {
    header: [
      `Collect the ${options.datacenter} datacenter into JSON`,
      '',
      'Run with:  ansible-playbook -i inventory collect.yml',
      '',
      `Writes ${outputDir}/clusters.json, hosts.json and vms.json, which the`,
      "toolkit's inventory importer reads.",
      '',
      CONNECTION_NOTE,
    ].join('\n'),
  });
}

/**
 * Cluster settings as the tasks that would produce them.
 *
 * Only settings the inventory actually carries are emitted. An inventory that
 * does not record whether HA was on says nothing about HA, and writing
 * `enable: false` for a field that was simply not collected would turn a gap in
 * the data into a change to the estate.
 */
export function emitClusterConfiguration(
  clusters: readonly InventoryCluster[],
  options: VmwarePlaybookOptions,
): PlaybookOutput {
  const findings: Finding[] = [];
  const tasks: PlaybookTask[] = [];
  const common: Record<string, string | boolean> = {};
  if (options.validateCerts !== undefined) common.validate_certs = options.validateCerts;

  for (const cluster of clusters) {
    const datacenter = cluster.datacenter ?? options.datacenter;

    tasks.push({
      name: `Cluster ${cluster.name} exists`,
      module: 'vmware.vmware.cluster',
      arguments: { cluster: cluster.name, datacenter, state: 'present', ...common },
    });

    if (cluster.haEnabled !== undefined) {
      tasks.push({
        name: `HA on ${cluster.name}`,
        module: 'vmware.vmware.cluster_ha',
        arguments: { cluster: cluster.name, datacenter, enable: cluster.haEnabled, ...common },
      });
    } else {
      findings.push(
        info(
          'ansible.vmware.ha-unknown',
          `The inventory does not record HA for ${cluster.name}, so no HA task was written.`,
          { source: 'ArchToolKit' },
        ),
      );
    }

    if (cluster.drsEnabled !== undefined) {
      const behavior = normaliseDrsBehavior(cluster.drsAutomationLevel);
      if (cluster.drsAutomationLevel && !behavior) {
        findings.push(
          warning(
            'ansible.vmware.unknown-drs-level',
            `"${cluster.drsAutomationLevel}" on ${cluster.name} is not a DRS automation level the module accepts, so the level was left at the module's default.`,
            {
              remediation: `Use one of: ${DRS_BEHAVIORS.join(', ')}.`,
              source: 'vmware.vmware.cluster_drs documentation',
            },
          ),
        );
      }
      tasks.push({
        name: `DRS on ${cluster.name}`,
        module: 'vmware.vmware.cluster_drs',
        arguments: {
          cluster: cluster.name,
          datacenter,
          enable: cluster.drsEnabled,
          ...(behavior ? { drs_default_vm_behavior: behavior } : {}),
          ...common,
        },
      });
    }

    if (cluster.evcMode) {
      findings.push(
        warning(
          'ansible.vmware.evc-not-emitted',
          `${cluster.name} has EVC mode ${cluster.evcMode}, which vmware.vmware 2.10.0 has no module for.`,
          {
            remediation:
              'Set EVC in vCenter, or through community.vmware, which still carries a module for it.',
            source: 'vmware.vmware module list',
          },
        ),
      );
    }

    if (cluster.vsanEnabled) {
      findings.push(
        warning(
          'ansible.vmware.vsan-not-emitted',
          `${cluster.name} has vSAN enabled, and vmware.vmware 2.10.0 has no vSAN cluster module.`,
          {
            remediation:
              'Configure vSAN through vCenter or community.vmware; this playbook will not change it either way.',
            source: 'vmware.vmware module list',
          },
        ),
      );
    }
  }

  if (tasks.length === 0) {
    return {
      yaml: '',
      collections: [],
      findings: [
        warning(
          'ansible.vmware.no-clusters',
          'The inventory holds no clusters, so there was nothing to configure.',
          { remediation: 'Import an inventory first, on the VMware Inventory page.' },
        ),
      ],
    };
  }

  const play: Play = {
    name: 'Apply cluster configuration',
    hosts: 'localhost',
    gatherFacts: false,
    tasks,
  };

  const out = emitPlaybook([play], {
    header: [
      'Cluster configuration from an imported inventory.',
      '',
      'This describes clusters that already exist. Run it against the estate it',
      'was generated from only after a check run:',
      '',
      '  ansible-playbook -i inventory clusters.yml --check --diff',
      '',
      'Settings the inventory did not record are not written, so nothing here',
      'turns missing data into a change.',
      '',
      CONNECTION_NOTE,
    ].join('\n'),
  });

  return { ...out, findings: [...findings, ...out.findings] };
}

/** Both playbooks for one imported inventory, as files ready to write out. */
export function emitVmwareKit(
  inventory: Inventory,
  options: VmwarePlaybookOptions,
): { files: Readonly<Record<string, string>>; findings: readonly Finding[]; collections: readonly string[] } {
  const collection = emitInventoryCollection(options);
  const configuration = emitClusterConfiguration(inventory.clusters, options);

  const files: Record<string, string> = { 'collect.yml': collection.yaml };
  if (configuration.yaml) files['clusters.yml'] = configuration.yaml;

  return {
    files,
    findings: [...collection.findings, ...configuration.findings],
    collections: [...new Set([...collection.collections, ...configuration.collections])].sort(),
  };
}

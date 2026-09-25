/**
 * Hand-written storage and server hardware playbooks: NetApp ONTAP, Pure
 * FlashArray and FlashBlade, Dell PowerFlex and Dell iDRAC — the provisioning
 * runs a storage engineer repeats (SVM, volume and export; host, volume and
 * mapping) and a server hardware check.
 *
 * Every play talks to a management API from localhost; array passwords and
 * tokens are vault_ variables.
 */

                                                        
import { items, on, pairs, playbookScenario } from './scenario.js';

const LOCAL = { hosts: 'localhost', connection: 'local', gather_facts: false }         ;

export const STORAGE_PLAYBOOKS                       = [
  playbookScenario({
    id: 'stg_ontap_nfs_volume',
    label: 'NetApp ONTAP – SVM, NFS volume and export policy',
    description:
      'An NFS-enabled SVM, an export policy and rule for the client subnet, and a volume placed on the named aggregate or the one with the most free space.',
    group: 'Playbooks · NetApp ONTAP',
    inputs: [
      { id: 'cluster', label: 'Cluster management', control: 'text', default: 'cluster1.example.com' },
      { id: 'username', label: 'User', control: 'text', default: 'admin', hint: 'Password in vault_ontap_password' },
      { id: 'validate_certs', label: 'Validate certificates', control: 'toggle', default: true },
      { id: 'svm', label: 'SVM', control: 'text', default: 'svm_nfs01' },
      { id: 'create_svm', label: 'Create the SVM', control: 'toggle', default: true, hint: 'Off if it exists' },
      {
        id: 'aggregate_mode',
        label: 'Aggregate',
        control: 'select',
        options: [
          { value: 'auto', label: 'Most free space (looked up)' },
          { value: 'named', label: 'Named' },
        ],
        default: 'auto',
      },
      { id: 'aggregate', label: 'Aggregate name', control: 'text', default: 'aggr1_node1', showWhen: { input: 'aggregate_mode', equals: ['named'] } },
      { id: 'volume', label: 'Volume', control: 'text', default: 'vol_app01' },
      { id: 'size', label: 'Size', control: 'number', default: 500, min: 1 },
      {
        id: 'size_unit',
        label: 'Unit',
        control: 'select',
        options: [
          { value: 'gb', label: 'GB' },
          { value: 'tb', label: 'TB' },
        ],
        default: 'gb',
      },
      {
        id: 'space_guarantee',
        label: 'Provisioning',
        control: 'select',
        options: [
          { value: 'none', label: 'Thin' },
          { value: 'volume', label: 'Thick' },
        ],
        default: 'none',
      },
      { id: 'snapshot_policy', label: 'Snapshot policy', control: 'text', default: 'default' },
      { id: 'policy', label: 'Export policy', control: 'text', default: 'app01_clients' },
      { id: 'clients', label: 'Clients', control: 'textarea', default: '10.10.20.0/24', hint: 'Subnets, hosts or netgroups; one per line' },
      {
        id: 'nfs_protocol',
        label: 'NFS version',
        control: 'select',
        options: [
          { value: 'nfs3', label: 'NFSv3' },
          { value: 'nfs4', label: 'NFSv4' },
          { value: 'nfs', label: 'Any NFS' },
        ],
        default: 'nfs3',
      },
      {
        id: 'root_access',
        label: 'Root access',
        control: 'select',
        options: [
          { value: 'none', label: 'Squash root' },
          { value: 'sys', label: 'Allow root (sys)' },
        ],
        default: 'none',
      },
    ],
    needs: () => ({ vault_ontap_password: 'ONTAP cluster admin password' }),
    plays: (v) => {
      const auth = {
        hostname: v.cluster,
        username: v.username,
        password: '{{ vault_ontap_password }}',
        https: true,
        validate_certs: on(v.validate_certs),
      };
      const auto = v.aggregate_mode !== 'named';
      return [
        {
          name: 'Provision an NFS volume on ONTAP',
          ...LOCAL,
          tasks: [
            ...(auto
              ? [
                  {
                    name: 'Look up the aggregates',
                    'netapp.ontap.na_ontap_rest_info': {
                      ...auth,
                      gather_subset: ['storage/aggregates'],
                      fields: ['name', 'space.block_storage.available'],
                      use_python_keys: true,
                    },
                    register: 'aggr_info',
                    no_log: true,
                  },
                  {
                    name: 'Pick the aggregate with the most free space',
                    'ansible.builtin.set_fact': {
                      target_aggregate:
                        "{{ (aggr_info.ontap_info.storage_aggregates.records | sort(attribute='space.block_storage.available', reverse=true) | first).name }}",
                    },
                  },
                ]
              : [{ name: 'Use the named aggregate', 'ansible.builtin.set_fact': { target_aggregate: v.aggregate } }]),
            ...(on(v.create_svm)
              ? [
                  {
                    name: 'Create the SVM with NFS enabled',
                    'netapp.ontap.na_ontap_svm': {
                      ...auth,
                      name: v.svm,
                      aggr_list: ['{{ target_aggregate }}'],
                      services: { nfs: { allowed: true, enabled: true } },
                      comment: 'Managed by Ansible',
                      state: 'present',
                    },
                    no_log: true,
                  },
                ]
              : []),
            {
              name: 'Create the export policy',
              'netapp.ontap.na_ontap_export_policy': { ...auth, vserver: v.svm, name: v.policy, state: 'present' },
              no_log: true,
            },
            {
              name: 'Allow the clients',
              'netapp.ontap.na_ontap_export_policy_rule': {
                ...auth,
                vserver: v.svm,
                name: v.policy,
                rule_index: 1,
                client_match: items(v.clients),
                protocol: [v.nfs_protocol],
                ro_rule: ['sys'],
                rw_rule: ['sys'],
                super_user_security: [v.root_access],
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Create the volume',
              'netapp.ontap.na_ontap_volume': {
                ...auth,
                vserver: v.svm,
                name: v.volume,
                aggregate_name: '{{ target_aggregate }}',
                size: Number(v.size),
                size_unit: v.size_unit,
                space_guarantee: v.space_guarantee,
                snapshot_policy: v.snapshot_policy,
                percent_snapshot_space: 5,
                volume_security_style: 'unix',
                junction_path: `/${v.volume}`,
                export_policy: v.policy,
                wait_for_completion: true,
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
    id: 'stg_purefa_host_volume',
    label: 'Pure FlashArray – host, volume and connection',
    description: 'Register a host by its iSCSI IQN, FC WWNs or NVMe NQN, create a volume (optionally protected) and connect it to the host.',
    group: 'Playbooks · Pure FlashArray',
    inputs: [
      { id: 'fa_url', label: 'FlashArray', control: 'text', default: 'flasharray01.example.com' },
      { id: 'host', label: 'Host name', control: 'text', default: 'esx01' },
      {
        id: 'protocol',
        label: 'Protocol',
        control: 'select',
        options: [
          { value: 'iscsi', label: 'iSCSI' },
          { value: 'fc', label: 'Fibre Channel' },
          { value: 'nvme', label: 'NVMe' },
        ],
        default: 'iscsi',
      },
      {
        id: 'initiators',
        label: 'Initiators',
        control: 'textarea',
        default: 'iqn.1998-01.com.vmware:esx01-4a5b6c7d',
        hint: 'IQNs, WWNs or NQNs to match the protocol; one per line',
      },
      {
        id: 'personality',
        label: 'Personality',
        control: 'select',
        options: [
          { value: 'none', label: 'None (Linux, Windows)' },
          { value: 'esxi', label: 'ESXi' },
          { value: 'aix', label: 'AIX' },
          { value: 'solaris', label: 'Solaris' },
          { value: 'hpux', label: 'HP-UX' },
        ],
        default: 'esxi',
      },
      { id: 'volume', label: 'Volume', control: 'text', default: 'esx01-ds01' },
      { id: 'size', label: 'Size', control: 'text', default: '2T', hint: 'M, G, T or P' },
      { id: 'lun', label: 'LUN ID', control: 'number', default: 1, min: 1 },
      { id: 'pgroup', label: 'Protection group', control: 'text', default: '', hint: 'Existing group; empty for none' },
      { id: 'iops_qos', label: 'IOPS limit', control: 'text', default: '', hint: 'e.g. 20K; empty for none' },
    ],
    needs: () => ({ vault_purefa_api_token: 'FlashArray API token' }),
    plays: (v) => {
      const auth = { fa_url: v.fa_url, api_token: '{{ vault_purefa_api_token }}' };
      const ids = items(v.initiators);
      const initiators = v.protocol === 'fc' ? { wwns: ids } : v.protocol === 'nvme' ? { nqn: ids } : { iqn: ids };
      const pg = String(v.pgroup ?? '').trim();
      const qos = String(v.iops_qos ?? '').trim();
      return [
        {
          name: 'Present a FlashArray volume to a host',
          ...LOCAL,
          tasks: [
            {
              name: 'Create the host',
              'purestorage.flasharray.purefa_host': {
                ...auth,
                name: v.host,
                ...initiators,
                ...(v.personality !== 'none' ? { personality: v.personality } : {}),
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Create the volume',
              'purestorage.flasharray.purefa_volume': {
                ...auth,
                name: v.volume,
                size: v.size,
                ...(pg ? { add_to_pgs: [pg] } : {}),
                ...(qos ? { iops_qos: qos } : {}),
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Connect the volume to the host',
              'purestorage.flasharray.purefa_host': { ...auth, name: v.host, volume: v.volume, lun: Number(v.lun), state: 'present' },
              no_log: true,
            },
          ],
        },
      ];
    },
  }),

  playbookScenario({
    id: 'stg_purefb_nfs_filesystem',
    label: 'Pure FlashBlade – NFS filesystem and export policy',
    description: 'An NFS export policy with a client rule, and a filesystem exported through it.',
    group: 'Playbooks · Pure FlashBlade',
    inputs: [
      { id: 'fb_url', label: 'FlashBlade', control: 'text', default: 'flashblade01.example.com' },
      { id: 'filesystem', label: 'Filesystem', control: 'text', default: 'analytics01' },
      { id: 'size', label: 'Size', control: 'text', default: '10T', hint: 'M, G, T or P' },
      { id: 'hard_limit', label: 'Size is a hard limit', control: 'toggle', default: false },
      { id: 'nfsv3', label: 'NFSv3', control: 'toggle', default: true },
      { id: 'nfsv4', label: 'NFSv4.1', control: 'toggle', default: true },
      { id: 'snapshot', label: 'Snapshot directory', control: 'toggle', default: true },
      { id: 'policy', label: 'Export policy', control: 'text', default: 'analytics-clients' },
      { id: 'client', label: 'Clients', control: 'text', default: '10.10.30.0/24', hint: 'IP, subnet, netgroup or *' },
      {
        id: 'permission',
        label: 'Permission',
        control: 'select',
        options: [
          { value: 'rw', label: 'Read-write' },
          { value: 'ro', label: 'Read-only' },
        ],
        default: 'rw',
      },
      {
        id: 'access',
        label: 'Root access',
        control: 'select',
        options: [
          { value: 'root-squash', label: 'Squash root' },
          { value: 'all-squash', label: 'Squash everyone' },
          { value: 'no-squash', label: 'No squash' },
        ],
        default: 'root-squash',
      },
    ],
    needs: () => ({ vault_purefb_api_token: 'FlashBlade API token' }),
    plays: (v) => {
      const auth = { fb_url: v.fb_url, api_token: '{{ vault_purefb_api_token }}' };
      return [
        {
          name: 'Export a FlashBlade filesystem over NFS',
          ...LOCAL,
          tasks: [
            {
              name: 'Create the export policy with its client rule',
              'purestorage.flashblade.purefb_policy': {
                ...auth,
                name: v.policy,
                policy_type: 'nfs',
                client: v.client,
                permission: v.permission,
                access: v.access,
                security: ['sys'],
                state: 'present',
              },
              no_log: true,
            },
            {
              name: 'Create the filesystem',
              'purestorage.flashblade.purefb_fs': {
                ...auth,
                name: v.filesystem,
                size: v.size,
                hard_limit: on(v.hard_limit),
                nfsv3: on(v.nfsv3),
                nfsv4: on(v.nfsv4),
                snapshot: on(v.snapshot),
                export_policy: v.policy,
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
    id: 'stg_powerflex_volume',
    label: 'Dell PowerFlex – volume mapped to SDCs',
    description: 'Create a thin or thick volume in a storage pool and map it to one or more SDCs with optional limits.',
    group: 'Playbooks · Dell PowerFlex',
    inputs: [
      { id: 'gateway', label: 'Gateway / manager', control: 'text', default: 'powerflex-gw.example.com' },
      { id: 'username', label: 'User', control: 'text', default: 'admin', hint: 'Password in vault_powerflex_password' },
      { id: 'validate_certs', label: 'Validate certificates', control: 'toggle', default: true },
      { id: 'volume', label: 'Volume', control: 'text', default: 'app01-data' },
      { id: 'protection_domain', label: 'Protection domain', control: 'text', default: 'PD1' },
      { id: 'storage_pool', label: 'Storage pool', control: 'text', default: 'SP1' },
      { id: 'size', label: 'Size (GB)', control: 'number', default: 256, min: 8, hint: 'Rounded up to a multiple of 8' },
      {
        id: 'vol_type',
        label: 'Provisioning',
        control: 'select',
        options: [
          { value: 'THIN_PROVISIONED', label: 'Thin' },
          { value: 'THICK_PROVISIONED', label: 'Thick' },
        ],
        default: 'THIN_PROVISIONED',
      },
      { id: 'sdc_ips', label: 'SDC IPs', control: 'textarea', default: '10.10.40.11\n10.10.40.12', hint: 'One per line' },
      {
        id: 'access_mode',
        label: 'Access',
        control: 'select',
        options: [
          { value: 'READ_WRITE', label: 'Read-write' },
          { value: 'READ_ONLY', label: 'Read-only' },
        ],
        default: 'READ_WRITE',
      },
      { id: 'iops_limit', label: 'IOPS limit', control: 'number', default: 0, min: 0, hint: '0 = unlimited' },
    ],
    needs: () => ({ vault_powerflex_password: 'PowerFlex user password' }),
    plays: (v) => {
      const sdcs = items(v.sdc_ips);
      return [
        {
          name: 'Provision a PowerFlex volume',
          ...LOCAL,
          tasks: [
            {
              name: 'Create the volume and map it to the SDCs',
              'dellemc.powerflex.volume': {
                hostname: v.gateway,
                username: v.username,
                password: '{{ vault_powerflex_password }}',
                validate_certs: on(v.validate_certs),
                vol_name: v.volume,
                protection_domain_name: v.protection_domain,
                storage_pool_name: v.storage_pool,
                size: Number(v.size),
                cap_unit: 'GB',
                vol_type: v.vol_type,
                allow_multiple_mappings: sdcs.length > 1,
                sdc: sdcs.map((ip) => ({ sdc_ip: ip, access_mode: v.access_mode, iops_limit: Number(v.iops_limit) })),
                sdc_state: 'mapped',
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
    id: 'stg_idrac_inventory_bios',
    label: 'Dell iDRAC – firmware inventory, BIOS and iDRAC restart',
    description:
      'For each iDRAC: gather system and firmware inventory into JSON reports, optionally set BIOS attributes, and optionally restart the iDRAC.',
    group: 'Playbooks · Dell OpenManage',
    inputs: [
      { id: 'idracs', label: 'iDRAC addresses', control: 'textarea', default: 'idrac-r750-01.example.com\nidrac-r750-02.example.com', hint: 'One per line' },
      { id: 'idrac_user', label: 'iDRAC user', control: 'text', default: 'ansible', hint: 'Password in vault_idrac_password' },
      { id: 'report_dir', label: 'Report directory', control: 'text', default: 'reports/idrac', hint: 'On the control node' },
      { id: 'set_bios', label: 'Set BIOS attributes', control: 'toggle', default: false },
      {
        id: 'bios_attributes',
        label: 'BIOS attributes',
        control: 'textarea',
        default: 'SysProfile=PerfOptimized\nLogicalProc=Enabled\nBootMode=Uefi',
        hint: 'Name=Value, one per line',
        showWhen: { input: 'set_bios', equals: ['true'] },
      },
      {
        id: 'apply_time',
        label: 'Apply',
        control: 'select',
        options: [
          { value: 'OnReset', label: 'At next reboot' },
          { value: 'Immediate', label: 'Now (reboots the server)' },
        ],
        default: 'OnReset',
        showWhen: { input: 'set_bios', equals: ['true'] },
      },
      { id: 'restart_idrac', label: 'Restart the iDRAC afterwards', control: 'toggle', default: false, hint: 'Graceful; no factory reset' },
    ],
    needs: () => ({ vault_idrac_password: 'iDRAC user password' }),
    plays: (v) => {
      const auth = { idrac_ip: '{{ item }}', idrac_user: v.idrac_user, idrac_password: '{{ vault_idrac_password }}' };
      return [
        {
          name: 'Inventory and configure Dell PowerEdge servers',
          ...LOCAL,
          vars: { idrac_hosts: items(v.idracs), report_dir: v.report_dir },
          tasks: [
            { name: 'Create the report directory', 'ansible.builtin.file': { path: '{{ report_dir }}', state: 'directory', mode: '0750' } },
            {
              name: 'Check the Lifecycle Controller is ready',
              'dellemc.openmanage.idrac_lifecycle_controller_status_info': auth,
              loop: '{{ idrac_hosts }}',
              no_log: true,
            },
            {
              name: 'Gather the system inventory',
              'dellemc.openmanage.idrac_system_info': auth,
              loop: '{{ idrac_hosts }}',
              register: 'system_info',
              no_log: true,
            },
            {
              name: 'Gather the firmware inventory',
              'dellemc.openmanage.idrac_firmware_info': auth,
              loop: '{{ idrac_hosts }}',
              register: 'firmware_info',
              no_log: true,
            },
            {
              name: 'Write the reports',
              'ansible.builtin.copy': {
                dest: '{{ report_dir }}/{{ item.0.item }}.json',
                mode: '0640',
                content: '{{ {"system": item.0.system_info, "firmware": item.1.firmware_info} | to_nice_json }}',
              },
              loop: '{{ system_info.results | zip(firmware_info.results) | list }}',
              loop_control: { label: '{{ item.0.item }}' },
            },
            ...(on(v.set_bios)
              ? [
                  {
                    name: 'Set the BIOS attributes',
                    'dellemc.openmanage.idrac_bios': {
                      ...auth,
                      attributes: Object.fromEntries(pairs(v.bios_attributes)),
                      apply_time: v.apply_time,
                      job_wait: true,
                    },
                    loop: '{{ idrac_hosts }}',
                    no_log: true,
                  },
                ]
              : []),
            ...(on(v.restart_idrac)
              ? [
                  {
                    name: 'Restart the iDRAC',
                    'dellemc.openmanage.idrac_reset': { ...auth, wait_for_idrac: true },
                    loop: '{{ idrac_hosts }}',
                    no_log: true,
                  },
                ]
              : []),
          ],
        },
      ];
    },
  }),
];

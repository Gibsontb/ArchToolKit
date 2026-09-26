/**
 * app_sap_preconfigure: the OS preparation SAP notes ask for, on the hosts of
 * an SAP pattern (addendum A.4.2, SAP), through the roles of the
 * community.sap_install collection (roles, not modules):
 *
 *   community.sap_install.sap_general_preconfigure    every SAP host
 *   community.sap_install.sap_hana_preconfigure       SAP HANA hosts
 *   community.sap_install.sap_netweaver_preconfigure  NetWeaver / S/4HANA application hosts
 *
 * requirements.yml lists the collection (unpinned: the toolkit's module
 * catalog carries no version for it). The collection supports RHEL and SLES
 * for SAP; anything else is refused before a role runs.
 *
 * The roles' own variables are passed on the include (task vars):
 * sap_general_preconfigure_domain (the answer, else the host's DNS domain),
 * sap_general_preconfigure_modify_etc_hosts, and for each role
 * <role>_reboot_ok / <role>_fail_if_reboot_required, so a role reboots
 * (rather than fails) when its kernel settings need it. Checked against
 * community.sap_install 1.11.0.
 * https://github.com/sap-linuxlab/community.sap_install
 */

import type { TemplateValues } from '../../../kit/blueprint.ts';
import type { Role, Task } from '../../migration/roles/types.ts';
import { text, yes } from '../migration/common.ts';
import { patternBlueprint, select, YES_NO } from './common.ts';

export const SAP_COLLECTION = 'community.sap_install';

/** The collection roles, by what they prepare. Names to verify against the installed collection. */
export const SAP_ROLES = {
  general: `${SAP_COLLECTION}.sap_general_preconfigure`,
  hana: `${SAP_COLLECTION}.sap_hana_preconfigure`,
  netweaver: `${SAP_COLLECTION}.sap_netweaver_preconfigure`,
} as const;

const tasks: Task[] = [
  {
    name: 'Refuse anything but RHEL or SLES',
    'ansible.builtin.assert': {
      that: ["ansible_facts.distribution in ['RedHat', 'SLES', 'SLES_SAP', 'SUSE']"],
      fail_msg: 'community.sap_install prepares RHEL and SLES (for SAP) only; {{ ansible_facts.distribution }} is not one.',
      quiet: true,
    },
  },
  {
    name: 'General SAP preparation (SAP notes for every SAP host)',
    'ansible.builtin.include_role': { name: SAP_ROLES.general },
    vars: {
      sap_general_preconfigure_domain: "{{ sap_preconfigure_domain if sap_preconfigure_domain | length > 0 else ansible_facts['domain'] }}",
      sap_general_preconfigure_modify_etc_hosts: '{{ sap_preconfigure_modify_etc_hosts | bool }}',
      sap_general_preconfigure_fail_if_reboot_required: false,
      sap_general_preconfigure_reboot_ok: '{{ sap_preconfigure_reboot | bool }}',
    },
  },
  {
    name: 'SAP HANA preparation',
    'ansible.builtin.include_role': { name: SAP_ROLES.hana },
    vars: {
      sap_hana_preconfigure_fail_if_reboot_required: false,
      sap_hana_preconfigure_reboot_ok: '{{ sap_preconfigure_reboot | bool }}',
    },
    when: "sap_preconfigure_system in ['hana', 'both']",
  },
  {
    name: 'SAP NetWeaver / S/4HANA application server preparation',
    'ansible.builtin.include_role': { name: SAP_ROLES.netweaver },
    vars: {
      sap_netweaver_preconfigure_fail_if_reboot_required: false,
      sap_netweaver_preconfigure_reboot_ok: '{{ sap_preconfigure_reboot | bool }}',
    },
    when: "sap_preconfigure_system in ['netweaver', 'both']",
  },
];

export const SAP_PRECONFIGURE_ROLE: Role = {
  name: 'sap_preconfigure',
  description: 'the community.sap_install preconfigure roles for this host (general, then HANA and / or NetWeaver).',
  tasks,
  defaults: {
    sap_preconfigure_system: 'hana',
    sap_preconfigure_domain: '',
    sap_preconfigure_modify_etc_hosts: true,
    sap_preconfigure_reboot: true,
  },
};

export const APP_SAP_PRECONFIGURE = patternBlueprint({
  id: 'app_sap_preconfigure',
  label: 'SAP – OS preconfiguration (community.sap_install)',
  description:
    'Prepare RHEL or SLES hosts for SAP with the community.sap_install roles: sap_general_preconfigure on every host, then sap_hana_preconfigure (HANA) and / or sap_netweaver_preconfigure (application servers). The collection comes from requirements.yml; the roles reboot when their kernel settings need it.',
  hosts: { default: 'os_kind_linux', hint: 'The SAP hosts, e.g. app_<sid>:&os_kind_linux' },
  become: true,
  inputs: [
    select('system', 'SAP system on these hosts', [['hana', 'SAP HANA database'], ['netweaver', 'NetWeaver / S/4HANA application server'], ['both', 'Both (single-host system)']], 'hana'),
    { id: 'domain', label: 'SAP DNS domain', control: 'text', default: '', placeholder: 'sap.example.com', hint: "The FQDN suffix SAP names hosts with; empty = the host's own DNS domain" },
    select('modify_etc_hosts', 'Write the host into /etc/hosts', YES_NO, 'true', { hint: 'SAP note 1054467 (hostname resolution)' }),
    select('reboot', 'Reboot when the roles need it', YES_NO, 'true'),
  ],
  roles: () => [SAP_PRECONFIGURE_ROLE],
  collections: () => [SAP_COLLECTION],
  vars: (v: TemplateValues) => ({
    mig_sap_preconfigure_system: text(v.system, 'hana'),
    mig_sap_preconfigure_domain: text(v.domain),
    mig_sap_preconfigure_modify_etc_hosts: yes(v.modify_etc_hosts ?? 'true'),
    mig_sap_preconfigure_reboot: yes(v.reboot ?? 'true'),
  }),
});

/**
 * mig_linux_domain_join: the linux_ad_join role (realmd + SSSD).
 */

import { LINUX_AD_JOIN } from '../../migration/roles/index.ts';
import { FALSE_TRUE, migrationBlueprint, text, yes } from './common.ts';

export const MIG_LINUX_DOMAIN_JOIN = migrationBlueprint({
  id: 'mig_linux_domain_join',
  label: 'Migration – Join Linux hosts to the domain',
  description: 'Join Active Directory with realmd and SSSD using the vaulted join account, write sssd.conf (dynamic DNS for A and AAAA), turn on home directories and give an AD group sudo.',
  inputs: [
    { id: 'domain', label: 'Domain (DNS name)', control: 'text', default: 'corp.example.com' },
    { id: 'ou', label: 'OU', control: 'text', default: '', hint: 'Distinguished name; blank uses the default Computers container' },
    { id: 'fully_qualified_names', label: 'Log in as user@domain', control: 'select', options: FALSE_TRUE, default: 'false' },
    {
      id: 'gpo_access_control',
      label: 'GPO access control',
      control: 'select',
      options: [
        { value: 'permissive', label: 'Permissive (log what GPO would deny)' },
        { value: 'enforcing', label: 'Enforcing' },
        { value: 'disabled', label: 'Disabled' },
      ],
      default: 'permissive',
    },
    { id: 'sudo_group', label: 'AD group with sudo', control: 'text', default: 'linux-admins', hint: 'Blank for none' },
  ],
  become: true,
  roles: () => [LINUX_AD_JOIN],
  vars: (v) => ({
    mig_linux_ad_join_domain: text(v.domain, 'corp.example.com'),
    mig_linux_ad_join_ou: text(v.ou),
    mig_linux_ad_join_fully_qualified_names: yes(v.fully_qualified_names),
    mig_linux_ad_join_gpo_access_control: text(v.gpo_access_control, 'permissive'),
    mig_linux_ad_join_sudo_group: text(v.sudo_group),
  }),
});

/**
 * mig_windows_domain_join: the windows_ad_join role. The join account is
 * vault_domain_join_user / vault_domain_join_password; there is no fallback.
 */

import { WINDOWS_AD_JOIN } from '../../migration/roles/index.ts';
import { FALSE_TRUE, list, migrationBlueprint, text, yes } from './common.ts';

export const MIG_WINDOWS_DOMAIN_JOIN = migrationBlueprint({
  id: 'mig_windows_domain_join',
  label: 'Migration – Join Windows hosts to the domain',
  description: 'Point DNS at the domain controllers (IPv4 and IPv6) and join the domain with the vaulted join account, rebooting when the join needs it.',
  inputs: [
    { id: 'domain', label: 'Domain (DNS name)', control: 'text', default: 'corp.example.com' },
    { id: 'ou', label: 'OU', control: 'text', default: '', hint: 'Distinguished name; blank uses the default Computers container' },
    { id: 'dns_servers', label: 'Domain controllers (DNS)', control: 'text', default: '', hint: 'Addresses of both families, comma separated; blank leaves DNS as it is' },
    { id: 'switch_to_kerberos', label: 'Use Kerberos after the join', control: 'select', options: FALSE_TRUE, default: 'false', hint: 'Later plays connect as the join account' },
  ],
  roles: () => [WINDOWS_AD_JOIN],
  vars: (v) => ({
    mig_windows_ad_join_domain: text(v.domain, 'corp.example.com'),
    mig_windows_ad_join_ou: text(v.ou),
    mig_windows_ad_join_dns_servers: list(v.dns_servers),
    mig_windows_ad_join_switch_to_kerberos: yes(v.switch_to_kerberos),
  }),
});

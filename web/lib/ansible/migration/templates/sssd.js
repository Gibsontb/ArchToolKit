/**
 * sssd.conf for a host joined to Active Directory with realmd.
 *
 * `realm join` writes a first sssd.conf; this replaces it with the settings
 * the migration plan asks for: whether users log in as `user` or
 * `user@domain`, whether AD Group Policy decides who may log in, and dynamic
 * DNS updates so the host registers its new addresses (A and AAAA, with PTR)
 * in AD DNS after it moves.
 */

export const SSSD_CONF = `# Managed by Ansible (linux_ad_join). Local changes are replaced on the next run.
[sssd]
domains = {{ linux_ad_join_domain | lower }}
config_file_version = 2
services = nss, pam

[domain/{{ linux_ad_join_domain | lower }}]
id_provider = ad
access_provider = ad
ad_domain = {{ linux_ad_join_domain | lower }}
krb5_realm = {{ linux_ad_join_domain | upper }}
realmd_tags = manages-system joined-with-adcli
cache_credentials = True
krb5_store_password_if_offline = True
default_shell = /bin/bash
ldap_id_mapping = True
use_fully_qualified_names = {{ 'True' if linux_ad_join_fully_qualified_names | bool else 'False' }}
fallback_homedir = {{ '/home/%u@%d' if linux_ad_join_fully_qualified_names | bool else '/home/%u' }}
ad_gpo_access_control = {{ linux_ad_join_gpo_access_control }}
dyndns_update = True
dyndns_update_ptr = True
dyndns_refresh_interval = 43200
dyndns_ttl = 3600
`;

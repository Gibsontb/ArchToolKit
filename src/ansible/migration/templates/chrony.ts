/**
 * chrony.conf, with the time source each platform documents for its guests.
 *
 *   AWS     the Amazon Time Sync Service at 169.254.169.123, and fd00:ec2::123
 *           on Nitro instances with IPv6 (both answer; an unreachable one is
 *           skipped by chrony).
 *   Azure   the host clock through the Hyper-V PTP device, /dev/ptp_hyperv.
 *   Google  the metadata server, metadata.google.internal.
 *   OCI     169.254.169.254.
 *   vmware  the site NTP servers (linux_baseline_ntp_servers).
 *
 * Rendered by the linux_baseline role with ansible.builtin.template.
 */

export const CHRONY_CONF = `# Managed by Ansible (linux_baseline). Local changes are replaced on the next run.
{% if cloud_platform == 'aws' %}
# Amazon Time Sync Service (link-local IPv4, and IPv6 on Nitro instances)
server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4
server fd00:ec2::123 iburst minpoll 4 maxpoll 4
{% elif cloud_platform == 'azure' %}
# The Hyper-V host clock over PTP
refclock PHC /dev/ptp_hyperv poll 3 dpoll -2 offset 0 stratum 2
{% elif cloud_platform == 'google' %}
# The Compute Engine metadata server
server metadata.google.internal prefer iburst
{% elif cloud_platform == 'oci' %}
# The OCI time service
server 169.254.169.254 prefer iburst
{% endif %}
{% for server in linux_baseline_ntp_servers %}
server {{ server }} iburst
{% endfor %}

driftfile {{ '/var/lib/chrony/chrony.drift' if ansible_facts.os_family == 'Debian' else '/var/lib/chrony/drift' }}
makestep 1.0 3
rtcsync
logdir /var/log/chrony
`;

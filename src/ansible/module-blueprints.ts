/**
 * One blueprint per Ansible module, for every module in the Ansible package
 * (~90 collections) and oracle.oci — ~10,000 modules.
 *
 * The Ansible counterpart of src/terraform/schema-blueprints.ts, built the
 * same way: each module's options come from its own documentation
 * (`ansible-doc -j`, extracted by tools/fetch-ansible-schemas.mjs), so
 *
 *  - every option the module takes is a field — required ones up top,
 *    optional ones in a collapsible section, suboptions in their own;
 *  - an option with documented choices is a dropdown of exactly them;
 *  - a no_log option (a password, a token) is never a text box with a value:
 *    it is a vault variable, `{{ vault_x }}`;
 *  - a required option left empty becomes a variable, listed in
 *    group_vars/all.yml to fill in, rather than a guess.
 *
 * The output is the same project every Ansible blueprint downloads — the
 * playbook, requirements.yml pinned to the collection versions read, and
 * (added by withAnsibleProject) ansible.cfg, an inventory and a README. The
 * play is shaped for where the module runs: API modules from localhost,
 * network modules over network_cli or httpapi with their network OS set, and
 * everything else against inventory hosts.
 *
 * ~10,000 schemas cannot load with the page, so like the cloud Terraform
 * blueprints these are lazy: the index lists them, and a module's options are
 * fetched from web/data/ansible/<collection>/ when it is picked.
 */

import type { Blueprint, BlueprintGroup, BlueprintInput, BlueprintValues, SelectOption } from '../kit/blueprint.ts';
import { info, type Finding } from '../core/findings.ts';
import { renderYaml, type YamlValue } from './yaml.ts';
import { ANSIBLE_SCHEMA_INDEX } from './module-schema-index.ts';
import { DISCOVERED_MODULE_RULES } from './module-rules-data.ts';

// ------------------------------------------------------------------ data ---

/** s string, n number, b bool, ls/ln list, m dict, x any (JSON/YAML flow), h a group past the form's depth. */
type TypeCode = 's' | 'n' | 'b' | 'ls' | 'ln' | 'm' | 'x' | 'h';
/** [name, type, flags, description, choices | null, default?] */
type OptionRow = [string, TypeCode, string, string, (string[] | null)?, string?];
/** [name, mode, required, 0, group] — mode 1 a dict, 'l' a list of dicts. */
type GroupRow = [string, 1 | 'l', number, number, ModuleSchema];
interface ModuleSchema {
  readonly a: readonly OptionRow[];
  readonly b?: readonly GroupRow[];
  /** Short description. */
  readonly d?: string;
}
interface Index {
  readonly package: string | null;
  readonly core: string;
  readonly collections: Readonly<Record<string, string | null>>;
  /** FQCN → [schema file, short description]. */
  readonly modules: Readonly<Record<string, readonly [string, string]>>;
}

const INDEX = ANSIBLE_SCHEMA_INDEX as Index;

export function collectionOf(fqcn: string): string {
  return fqcn.split('.').slice(0, 2).join('.');
}

export function moduleNames(collection?: string): string[] {
  const all = Object.keys(INDEX.modules);
  return collection ? all.filter((m) => collectionOf(m) === collection) : all;
}

export function collectionVersion(collection: string): string | null {
  return INDEX.collections[collection] ?? null;
}

// --- schemas, a file at a time ---------------------------------------------

const LOADED = new Map<string, ModuleSchema>();
const FETCHING = new Map<string, Promise<void>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs: any = (globalThis as any).process?.getBuiltinModule?.('node:fs');

function schemaUrl(collection: string, file: string): URL {
  const base = import.meta.url.includes('/src/ansible/') ? '../../web/data/ansible/' : '../../data/ansible/';
  return new URL(`${base}${collection}/${file}.json`, import.meta.url);
}

function store(file: Record<string, ModuleSchema>): void {
  for (const [name, schema] of Object.entries(file)) LOADED.set(name, schema);
}

export function loadModule(fqcn: string): Promise<void> {
  if (LOADED.has(fqcn)) return Promise.resolve();
  const file = INDEX.modules[fqcn]?.[0];
  if (!file) return Promise.reject(new Error(`${fqcn}: not in the Ansible module index`));
  const collection = collectionOf(fqcn);
  const key = `${collection}/${file}`;
  let pending = FETCHING.get(key);
  if (!pending) {
    pending = fetch(schemaUrl(collection, file))
      .then((r) => {
        if (!r.ok) throw new Error(`${key}.json: HTTP ${r.status}`);
        return r.json() as Promise<Record<string, ModuleSchema>>;
      })
      .then(store)
      .catch((err: unknown) => {
        FETCHING.delete(key);
        throw err;
      });
    FETCHING.set(key, pending);
  }
  return pending;
}

export function moduleSchema(fqcn: string): ModuleSchema | undefined {
  const loaded = LOADED.get(fqcn);
  if (loaded || !nodeFs) return loaded;
  const file = INDEX.modules[fqcn]?.[0];
  if (!file) return undefined;
  store(JSON.parse(nodeFs.readFileSync(schemaUrl(collectionOf(fqcn), file), 'utf8')));
  return LOADED.get(fqcn);
}

// ------------------------------------------------------------- platforms ---

/** Where each collection's modules sit in the picker: platform, and heading within it. */
export interface Placement {
  readonly target: string;
  readonly heading: string;
}

const PLATFORM_OF: readonly (readonly [RegExp, string])[] = [
  [/^(amazon\.aws|community\.aws)$/, 'aws'],
  [/^azure\.azcollection$/, 'azure'],
  [/^google\.cloud$/, 'google'],
  [/^oracle\.oci$/, 'oci'],
  [/^(community\.vmware|vmware\.vmware|vmware\.vmware_rest)$/, 'vsphere'],
  [/^(ansible\.windows|community\.windows|microsoft\.ad|microsoft\.iis|chocolatey\.chocolatey)$/, 'windows'],
  [/^(ansible\.builtin|ansible\.posix|community\.general|community\.crypto|community\.libvirt|community\.sops)$/, 'linux'],
  [
    /^(cisco\.(ios|iosxr|nxos|aci|mso|meraki|intersight|ucs|ciscosmb)|arista\.eos|vyos\.vyos|junipernetworks\..*|fortinet\..*|check_point\.mgmt|f5networks\..*|ansible\.netcommon|ansible\.utils|community\.routeros|dellemc\.enterprise_sonic|infoblox\..*|netbox\.netbox|graphiant\.naas|wti\.remote|community\.ciscosmb|community\.dns)$/,
    'network',
  ],
  [/^(community\.docker|containers\.podman|kubernetes\.core|community\.okd|kubevirt\.core)$/, 'containers'],
  [
    /^(community\.postgresql|ansible\.mysql|ansible\.mariadb|community\.mysql|community\.mongodb|community\.proxysql|community\.clickhouse|lowlydba\.sqlserver|ravendb\.ravendb|community\.rabbitmq)$/,
    'databases',
  ],
  [
    /^(netapp\..*|netapp_eseries\..*|purestorage\..*|dellemc\..*|hitachivantara\..*|ibm\..*|infinidat\..*|ieisystem\..*|kaytus\..*|inspur\..*)$/,
    'storage',
  ],
  [/^(openstack\.cloud|ovirt\.ovirt|ngine_io\.cloudstack|hetzner\.hcloud|vultr\.cloud|cloudscale_ch\.cloud|community\.proxmox|community\.hrobot|theforeman\.foreman)$/, 'private-clouds'],
];

/** The platforms the per-module blueprints add to the page, beside the seven it had. */
export const NEW_PLATFORMS: Readonly<Record<string, string>> = {
  network: 'Network devices (Cisco, Arista, Juniper, Fortinet, F5, Check Point, …)',
  containers: 'Containers and Kubernetes',
  databases: 'Databases and messaging',
  storage: 'Storage and server hardware',
  'private-clouds': 'Private and other clouds (OpenStack, Proxmox, oVirt, Hetzner, …)',
  operations: 'Monitoring, security and everything else',
};

export function placementOf(collection: string, fqcn?: string): Placement {
  const target = PLATFORM_OF.find(([re]) => re.test(collection))?.[1] ?? 'operations';
  return { target, heading: fqcn ? headingOf(fqcn) : productOf(collection) };
}

// --------------------------------------------------------------- topics ---

/** Collections by the names people call them. */
const PRODUCTS: Readonly<Record<string, string>> = {
  'ansible.builtin': 'Linux built-ins',
  'ansible.posix': 'POSIX',
  'community.general': 'General',
  'community.crypto': 'Certificates and keys',
  'ansible.windows': 'Windows',
  'community.windows': 'Windows (community)',
  'microsoft.ad': 'Active Directory',
  'microsoft.iis': 'IIS',
  'chocolatey.chocolatey': 'Chocolatey',
  'amazon.aws': 'AWS',
  'community.aws': 'AWS (community)',
  'azure.azcollection': 'Azure',
  'google.cloud': 'Google Cloud',
  'oracle.oci': 'OCI',
  'community.vmware': 'vSphere (community)',
  'vmware.vmware': 'vSphere',
  'vmware.vmware_rest': 'vSphere REST',
  'cisco.ios': 'Cisco IOS',
  'cisco.iosxr': 'Cisco IOS XR',
  'cisco.nxos': 'Cisco NX-OS',
  'cisco.aci': 'Cisco ACI',
  'cisco.mso': 'Cisco MSO',
  'cisco.meraki': 'Cisco Meraki',
  'cisco.intersight': 'Cisco Intersight',
  'cisco.ucs': 'Cisco UCS',
  'community.ciscosmb': 'Cisco SMB',
  'arista.eos': 'Arista EOS',
  'vyos.vyos': 'VyOS',
  'fortinet.fortios': 'FortiOS',
  'fortinet.fortimanager': 'FortiManager',
  'check_point.mgmt': 'Check Point',
  'f5networks.f5_modules': 'F5 BIG-IP',
  'ansible.netcommon': 'Network common',
  'ansible.utils': 'Network utilities',
  'community.routeros': 'MikroTik RouterOS',
  'dellemc.enterprise_sonic': 'Dell Enterprise SONiC',
  'infoblox.nios_modules': 'Infoblox',
  'netbox.netbox': 'NetBox',
  'community.dns': 'DNS providers',
  'community.docker': 'Docker',
  'containers.podman': 'Podman',
  'kubernetes.core': 'Kubernetes',
  'community.okd': 'OpenShift',
  'kubevirt.core': 'KubeVirt',
  'community.postgresql': 'PostgreSQL',
  'ansible.mysql': 'MySQL',
  'ansible.mariadb': 'MariaDB',
  'community.mongodb': 'MongoDB',
  'community.proxysql': 'ProxySQL',
  'community.clickhouse': 'ClickHouse',
  'lowlydba.sqlserver': 'SQL Server',
  'community.rabbitmq': 'RabbitMQ',
  'ravendb.ravendb': 'RavenDB',
  'netapp.ontap': 'NetApp ONTAP',
  'netapp.storagegrid': 'NetApp StorageGRID',
  'netapp.cloudmanager': 'NetApp Cloud Manager',
  'netapp_eseries.santricity': 'NetApp E-Series',
  'purestorage.flasharray': 'Pure FlashArray',
  'purestorage.flashblade': 'Pure FlashBlade',
  'dellemc.openmanage': 'Dell OpenManage',
  'dellemc.powerflex': 'Dell PowerFlex',
  'dellemc.unity': 'Dell Unity',
  'ibm.storage_virtualize': 'IBM Storage Virtualize',
  'infinidat.infinibox': 'InfiniBox',
  'openstack.cloud': 'OpenStack',
  'community.proxmox': 'Proxmox',
  'ovirt.ovirt': 'oVirt',
  'ngine_io.cloudstack': 'CloudStack',
  'hetzner.hcloud': 'Hetzner Cloud',
  'vultr.cloud': 'Vultr',
  'cloudscale_ch.cloud': 'cloudscale.ch',
  'community.hrobot': 'Hetzner Robot',
  'theforeman.foreman': 'Foreman',
  'community.zabbix': 'Zabbix',
  'community.grafana': 'Grafana (community)',
  'grafana.grafana': 'Grafana',
  'telekom_mms.icinga_director': 'Icinga Director',
  'splunk.es': 'Splunk ES',
  'community.hashi_vault': 'HashiCorp Vault',
  'cyberark.pas': 'CyberArk',
  'community.sops': 'SOPS',
  'community.libvirt': 'libvirt',
  'community.sap_libs': 'SAP',
};

function productOf(collection: string): string {
  return PRODUCTS[collection] ?? collection;
}

/**
 * The general-purpose collections name modules by what they manage, with no
 * vendor prefix to read a topic from, so they are sorted the way Ansible's own
 * documentation once was: by task. First match wins.
 */
const TASKS: readonly (readonly [RegExp, string])[] = [
  [/^(cloudflare_dns|dnsimple|dnsmadeeasy|gandi_livedns|netcup_dns|nsupdate|ipwcli_dns|omapi_host|kea_command|ip2location|ipbase|ipify|ipinfoio|win_dhcp|win_dns|win_snmp|snmp_facts|lldp_facts|listen_ports_facts|win_listen_ports|ip_netns|pritunl|win_http_proxy|win_inet_proxy|win_net_adapter)/, 'DNS, DHCP and network services'],
  [/^(cargo|golang_package|pkg5|portinstall|appimage|android_sdk|ansible_galaxy_install|python_requirements_info|uv_python|rpm_ostree_pkg|win_psmodule|win_psrepository|win_psscript|win_scoop|win_webpicmd|win_dotnet_ngen|pulp_repo|swupd|syspatch|lbu|bootc)/, 'Packages and updates'],
  [/^(aix_|beadm|crypttab|logrotate|mksysb|nictagadm|pids|pmem|solaris_zone|sysrc|usb_facts|vdo|xfs_quota|zpool|simpleinit|osx_defaults|kdeconfig|gio_mime|xdg_mime|homectl|keyring|win_computer_description|win_initialize_disk|win_defrag|win_data_deduplication|win_eventlog|win_product_facts|win_whoami|win_regmerge|win_rds_|win_pssession)/, 'System, disks and networking'],
  [/^(pacemaker_|ibm_sa_|emc_vnx|ss_3par|vexata|kopia|infinity)/, 'Clusters, storage and backup'],
  [/^(google_chat|nexmo|win_msg|win_say|win_toast|alerta|taiga)/, 'Monitoring and notification'],
  [/^(decompress|iso_customize|read_csv|write_binary_file)/, 'Files and content'],
  [/^(java_cert|java_keystore|awall|krb_ticket|opendj|sssd)/, 'Security, firewall and certificates'],
  [/^(ali_instance|rhevm|serverless|cobbler|stacki|puppet)/, 'Cloud, virtualization and platforms'],
  [/^(hponcfg|wdc_redfish|win_wakeonlan)/, 'Remote hardware management'],
  [/^(make|win_pester|znode|win_rabbitmq_plugin)/, 'Tasks, control and facts'],
  [/^(win_)?(user|group|authorized_key|getent|sudoers|pam_limits|pamd|domain_user|domain_group|domain_membership|user_right|user_profile|local_policy|credential|auto_logon)/, 'Users, groups and access'],
  [/^(win_)?(apt|yum|dnf|dnf5|package|package_facts|pip|rpm_key|deb822|apt_key|apt_repository|yum_repository|zypper|pacman|apk|snap|flatpak|homebrew|macports|npm|gem|cpanm|composer|pear|easy_install|pipx|portage|pkgng|openbsd_pkg|opkg|swdepot|svr4pkg|slackpkg|urpmi|xbps|installp|layman|pkgin|pkgutil|sorcery|mas|bundler|yarn|pnpm|bower|maven|jenkins_plugin|chocolatey|win_package|win_updates|win_hotfix|win_feature|win_optional_feature|win_capability|dpkg|redhat_subscription|rhsm|rhn|copr)/, 'Packages and updates'],
  [/^(win_)?(copy|file|template|lineinfile|blockinfile|replace|fetch|stat|find|unarchive|archive|assemble|tempfile|slurp|ini_file|xml|json_patch|patch|acl|synchronize|get_url|uri|shortcut|robocopy|zip|unzip|path|share|mapped_drive|owner|acl_inheritance|xattr|filesize|iso_create|iso_extract|jenkins_job|sefcontext)/, 'Files and content'],
  [/^(win_)?(service|systemd|sysvinit|runit|supervisorctl|launchd|svc|openwrt_init|nssm|scheduled_task|cron|at|reboot|shutdown|daemontools|s6|monit|pm2|scheduled_task_stat)/, 'Services, jobs and power'],
  [/^(win_)?(command|shell|raw|script|expect|psexec|powershell|dsc|async_status|wait_for|wait_for_connection|pause|ping|debug|assert|fail|meta|set_fact|set_stats|add_host|group_by|include|import|include_tasks|include_role|import_tasks|import_role|include_vars|setup|gather_facts|validate_argument_spec)/, 'Tasks, control and facts'],
  [/^(win_)?(firewall|firewalld|ufw|iptables|nftables|ip6tables|selinux|seboolean|seport|semodule|selogin|sefcontext|apparmor|audit|defender|bitlocker|security_policy|certificate|cert|openssl|x509|acme|ecs|crypto|gpg|luks|sshkey|ssh_|keytab)/, 'Security, firewall and certificates'],
  [/^(win_)?(hostname|timezone|locale|sysctl|kernel|modprobe|mount|filesystem|lvg|lvol|lvm|parted|mdadm|zfs|btrfs|swap|pvs|partition|disk|volume|format|pagefile|regedit|reg_|environment|region|timezone|dns_client|route|netbios|hosts|nmcli|interfaces_file|iptables|ethtool|sysupgrade|alternatives|open_iscsi|iscsi|nfs|multipath|grub|dconf|gconftool|xfconf|kernel_blacklist|capabilities|facter|ohai|hwclock|power_plan|tuned)/, 'System, disks and networking'],
  [/^(keycloak|ipa|ldap|onepassword|bitwarden|lastpass|dsv|tss|manageiq|scim)/, 'Identity and secrets'],
  [/^(gitlab|github|bitbucket|git|hg|bzr|subversion|gitea|jira|jenkins|sonar)/, 'Source control and CI'],
  [/^(slack|mail|mattermost|telegram|discord|msteams|pagerduty|opsgenie|twilio|sendgrid|pushover|pushbullet|irc|jabber|mqtt|rocketchat|flowdock|hipchat|campfire|catapult|say|syslogger|logentries|datadog|newrelic|honeybadger|bearychat|typetalk|matrix|office_365|nagios|zabbix|icinga|sensu|monit|statsd|circonus|librato|logstash|airbrake|bigpanda|rollbar|stackdriver|uptimerobot|pingdom|spectrum|dynatrace|grove|cisco_webex|ntfy|gotify)/, 'Monitoring and notification'],
  [/^(redfish|idrac|ilo|hpilo|ipmi|lenovoxcc|imc|xcc|wakeonlan|dellemc|oneview|ocapi|manageiq)/, 'Remote hardware management'],
  [/^(proxmox|lxd|lxc|xenserver|xen|virt|vmadm|imgadm|vbox|ovh|scaleway|hwc|online|packet|profitbricks|linode|lxca|memset|nomad|consul|terraform|pulumi|heroku|cloud_init|one_|oneandone|rundeck|atomic|docker|podman|kubevirt|opennebula|pubnub|smartos|spotinst|alicloud|oracle|aerospike|udm|dimensiondata|rax|softlayer|webfaction|univention|nosh|utm|clc|sl_|oci)/, 'Cloud, virtualization and platforms'],
  [/^(mysql|postgresql|mssql|redis|mongodb|influxdb|elasticsearch|opensearch|cassandra|couchdb|riak|vertica|kibana|etcd|odbc|hana|sqlite|clickhouse|ldap_attrs|jdbc)/, 'Databases and data'],
  [/^(apache|nginx|haproxy|htpasswd|jboss|tomcat|django|supervisorctl|ejabberd|gunicorn|jenkins|deploy_helper|rabbitmq|kafka|activemq|solr|varnish|web|iis|win_iis)/, 'Web and middleware'],
];

/** Tokens that are a vendor prefix, not a topic. */
function vendorPrefix(names: readonly string[]): number {
  let depth = 0;
  for (;;) {
    const counts = new Map<string, number>();
    for (const n of names) {
      const token = n.split('_')[depth];
      if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const top = [...counts.values()].sort((a, b) => b - a)[0] ?? 0;
    if (top < names.length * 0.7 || depth >= 2) return depth;
    depth++;
  }
}

/** The clouds' module prefix, before the service name. */
const CLOUD_PREFIX: Readonly<Record<string, RegExp>> = {
  'amazon.aws': /^(aws_)?/,
  'community.aws': /^(aws_)?/,
  'azure.azcollection': /^azure_rm_/,
  'google.cloud': /^gcp_/,
  // OCI is left out: 2,000 modules are too many for ten areas, and its own
  // service names (oci_database_…, oci_network_…) make clean topics.
};

/** Service name → area, across AWS, Azure, Google Cloud and OCI. First match wins. */
const CLOUD_AREAS: readonly (readonly [RegExp, string])[] = [
  [/^(applicationfirewallpolicy|applicationsecuritygroup|publicipprefix|serviceendpointpolicy|virtualhub|vpnsite)/, 'Networking'],
  [/^(sshpublickey|vmsku|autoscale)/, 'Compute'],
  [/^vmbackuppolicy/, 'Storage and backup'],
  [/^(iot|appconfiguration)/, 'Serverless, apps and messaging'],
  [/^registration(assignment|definition)/, 'Identity and security'],
  [/^(ec2_(vpc|eip|eni|security_group|transit|vpn|customer_gateway|vgw|nat)|vpc|route53|elb|elbv2|directconnect|networkfirewall|cloudfront|api|apigateway|globalaccelerator|virtualnetwork|subnet|networkinterface|natgateway|loadbalancer|appgateway|applicationgateway|publicipaddress|privatedns|dns|routetable|route|expressroute|virtualwan|vpngateway|virtualnetworkgateway|localnetworkgateway|firewall|azurefirewall|ddosprotectionplan|bastionhost|cdn|afd|frontdoor|trafficmanager|ipgroup|networkwatcher|networkflowlog|privatelink|privateendpoint|servicenetworking|compute_(network|subnetwork|firewall|route|router|address|global_address|forwarding_rule|backend|target|url_map|health_check|ssl|vpn|interconnect|network_endpoint|packet_mirroring|security_policy)|network|load_balancer|waas|dns|vn_monitoring|network_firewall)/, 'Networking'],
  [/^(ec2|autoscaling|lightsail|batch|elasticbeanstalk|virtualmachine|vmss|availabilityset|dedicatedhost|hostgroup|image|gallery|capacityreservation|proximityplacementgroup|compute|appengine|tpu|instance|autoscaling|dedicated_vm|os_management|arcmachine|arcssh)/, 'Compute'],
  [/^(s3|efs|fsx|storagegateway|backup|glacier|storageaccount|storageblob|storageshare|manageddisk|multiplemanageddisks|diskaccess|diskencryptionset|snapshot|backupazurevm|backuppolicy|recoveryservices|filestore|storage|os|object_storage|file_storage|blockstorage|block_storage|volume)/, 'Storage and backup'],
  [/^(rds|dynamodb|elasticache|redshift|docdb|neptune|memorydb|dms|sql|cosmosdb|mariadb|mysql|postgresql|redis|sqlmanagedinstance|bigtable|spanner|alloydb|firestore|datastore|database|mysql|nosql|autonomous|golden_gate|goldengate)/, 'Databases'],
  [/^(ecs|eks|ecr|aks|containerinstance|containerregistry|openshiftmanagedcluster|container|artifact|artifacts|containerengine|container_engine|container_instances)/, 'Containers and Kubernetes'],
  [/^(lambda|stepfunctions|sqs|sns|ses|mq|msk|kinesis|eventbridge|cloudwatchevent|functionapp|webapp|appserviceplan|apimanagement|servicebus|eventhub|eventgrid|notificationhub|logicapp|cloudfunctions|cloudtasks|cloudscheduler|pubsub|functions|streaming|queue|events|ons|integration|apigateway|api_gateway)/, 'Serverless, apps and messaging'],
  [/^(iam|sts|kms|secretsmanager|acm|waf|wafv2|inspector|accessanalyzer|guardduty|securityhub|shield|macie|ad|keyvault|role|roledefinition|roleassignment|managementgroup|policy|lock|securitycenter|resourceidentity|userassigned|secret|iam|identity|vault|kms|certificates|cloud_guard|bastion|security|data_safe)/, 'Identity and security'],
  [/^(cloudwatch|cloudwatchlogs|cloudtrail|config|ssm|monitor|loganalytics|applicationinsights|log|logging|monitoring|apm|opsi|log_analytics|audit|announcements|management_agent)/, 'Monitoring and logging'],
  [/^(glue|athena|emr|opensearch|datafactory|databricks|hdinsight|synapse|bigquery|dataproc|dataflow|vertexai|ml|cognitive|ai|analytics|data|bds|ai_|oda|colab)/, 'Analytics, data and AI'],
  [/^(codebuild|codecommit|codepipeline|codedeploy|cloudformation|devtestlab|automation|deployment|cloudbuild|devops|resource_manager|resourcemanager|resourcegroup|template)/, 'DevOps and automation'],
];

const TOPIC_WORDS: Readonly<Record<string, string>> = {
  ec2: 'EC2', rds: 'RDS', iam: 'IAM', s3: 'S3', elb: 'ELB', ecs: 'ECS', efs: 'EFS', eks: 'EKS', sns: 'SNS', ses: 'SES', sqs: 'SQS',
  mq: 'MQ', api: 'API', cp: 'CP', idp: 'IdP', lsm: 'LSM', vcenter: 'vCenter', esxi: 'ESXi', vsan: 'vSAN',
  ucs: 'UCS', ssl: 'SSL', tls: 'TLS', sdwan: 'SD-WAN', ztna: 'ZTNA', nac: 'NAC', ipsec: 'IPsec', ipv6: 'IPv6',
  wanopt: 'WAN optimization', icap: 'ICAP', ssh: 'SSH', radius: 'RADIUS', tacacs: 'TACACS', fmg: 'FMG', fgt: 'FortiGate',
  os: 'Object storage', ai: 'AI', vpn: 'VPN', dns: 'DNS', dhcp: 'DHCP', ip: 'IP', bgp: 'BGP', ospf: 'OSPF', ntp: 'NTP',
  snmp: 'SNMP', aaa: 'AAA', acl: 'ACL', acls: 'ACLs', vlan: 'VLAN', vlans: 'VLANs', lag: 'LAG', lacp: 'LACP', l2: 'L2', l3: 'L3',
  l3out: 'L3Out', l4l7: 'L4-L7', epg: 'EPG', bd: 'Bridge domains', esg: 'ESG', vrf: 'VRF', waas: 'WAAS', opsi: 'Ops Insights',
  sm: 'Systems Manager', sase: 'SASE', mx: 'MX', ms: 'MS', mr: 'MR', ssid: 'SSID', pkg: 'Policy packages', pm: 'Policy manager',
  dvmdb: 'Device DB', devprof: 'Device profiles', fsp: 'FortiSwitch profiles', hotspot20: 'Hotspot 2.0', fmupdate: 'FortiGuard updates',
  switchcontroller: 'Switch controller', webfilter: 'Web filter', emailfilter: 'Email filter', dlp: 'DLP', ips: 'IPS', waf: 'WAF',
  sso: 'SSO', ldap: 'LDAP', saml: 'SAML', ha: 'HA', vip: 'VIP', gslb: 'GSLB', ltm: 'LTM', asm: 'ASM', apm: 'APM', gtm: 'GTM',
  svm: 'SVM', cifs: 'CIFS', nfs: 'NFS', iscsi: 'iSCSI', lun: 'LUNs', nvme: 'NVMe', snapmirror: 'SnapMirror', vm: 'VMs', vms: 'VMs',
};

function topicLabel(tokens: readonly string[]): string {
  const words = tokens.map((t) => TOPIC_WORDS[t] ?? t);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** FQCN → its "Product · Topic" heading, worked out once, on first use, for every collection. */
let HEADINGS: ReadonlyMap<string, string> | undefined;
function headings(): ReadonlyMap<string, string> {
  HEADINGS ??= computeHeadings();
  return HEADINGS;
}

function computeHeadings(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const byCollection = new Map<string, string[]>();
  for (const fqcn of Object.keys(INDEX.modules)) {
    const c = collectionOf(fqcn);
    if (!byCollection.has(c)) byCollection.set(c, []);
    (byCollection.get(c) as string[]).push(fqcn.split('.')[2] as string);
  }
  const general = /^(ansible\.builtin|ansible\.posix|community\.general|ansible\.windows|community\.windows)$/;
  for (const [collection, names] of byCollection) {
    const product = productOf(collection);
    const cloud = CLOUD_PREFIX[collection];
    if (cloud !== undefined) {
      // The clouds by service area, as their consoles group them.
      for (const name of names) {
        const service = name.replace(cloud, '');
        const area = CLOUD_AREAS.find(([re]) => re.test(service))?.[1] ?? 'Management and other';
        out.set(`${collection}.${name}`, `${product} · ${area}`);
      }
      continue;
    }
    if (general.test(collection)) {
      for (const name of names) {
        const task = TASKS.find(([re]) => re.test(name))?.[1] ?? 'Other';
        out.set(`${collection}.${name}`, `${product} · ${task}`);
      }
      continue;
    }
    // Small collections are one heading.
    if (names.length <= 30) {
      for (const name of names) out.set(`${collection}.${name}`, product);
      continue;
    }
    for (const [name, topic] of topicsFor(names)) out.set(`${collection}.${name}`, topic ? `${product} · ${topic}` : product);
  }
  return out;
}

/** Leading words that say what a module does, not what it manages (cp_mgmt_add_nat_rule). */
const VERBS = new Set([
  'add', 'delete', 'set', 'show', 'get', 'update', 'abort', 'run', 'install', 'uninstall', 'publish', 'discard', 'verify',
  'export', 'import', 'reset', 'assign', 'where', 'lock', 'unlock', 'login', 'logout', 'approve', 'reject', 'submit', 'test',
  'put', 'migrate', 'execute', 'check', 'create', 'remove', 'list', 'apply', 'enable', 'disable', 'start', 'stop', 'restart',
]);

/** A module's words for grouping: no vendor prefix, no leading verb, no _info / _facts twin marker. */
function words(name: string, skip: number): string[] {
  const tokens = name.replace(/_(info|facts)$/, '').split('_').slice(skip);
  while (tokens.length > 1 && VERBS.has(tokens[0] as string)) tokens.shift();
  return tokens;
}

/**
 * Topics for one collection's modules, by the word after the vendor prefix
 * (fortios_firewall_… → Firewall), with a topic too big to scan split once
 * more. A collection whose names do not fall into topics that way — most in
 * pairs of one, like Intersight's adapter_config_policy — is grouped by its
 * last word instead (… Policies, … Profiles); and one that fits neither is a
 * single heading rather than a heading of leftovers. '' means no topic.
 */
function topicsFor(names: readonly string[]): Map<string, string> {
  const skip = vendorPrefix(names);
  const by = (pick: (w: string[]) => string): Map<string, string[]> => {
    const groups = new Map<string, string[]>();
    for (const name of names) {
      const key = pick(words(name, skip)) || 'other';
      if (!groups.has(key)) groups.set(key, []);
      (groups.get(key) as string[]).push(name);
    }
    return groups;
  };
  // Tried in order, strictest first: by the leading word, topics of three or
  // more; then of two (a module with its _info twin); then by the last word;
  // the first that leaves no more than a quarter ungrouped wins.
  const leftover = (groups: Map<string, string[]>, min: number): number =>
    [...groups.values()].filter((g) => g.length < min).reduce((n, g) => n + g.length, 0);
  const attempts: readonly (readonly [boolean, number])[] = [[false, 3], [false, 2], [true, 3], [true, 2]];
  let chosen: { groups: Map<string, string[]>; suffix: boolean; min: number } | undefined;
  for (const [suffix, min] of attempts) {
    const groups = by((w) => (suffix ? w[w.length - 1] : w[0]) ?? '');
    if (leftover(groups, min) <= names.length * 0.25) {
      chosen = { groups, suffix, min };
      break;
    }
  }
  const out = new Map<string, string>();
  if (!chosen) {
    for (const name of names) out.set(name, '');
    return out;
  }
  const { groups, suffix, min } = chosen;
  const plural = (w: string): string => (suffix ? topicLabel([w.endsWith('y') ? `${w.slice(0, -1)}ies` : w.endsWith('s') ? w : `${w}s`]) : topicLabel([w]));
  for (const [key, members] of groups) {
    if (members.length < min) {
      for (const name of members) out.set(name, 'Other');
      continue;
    }
    if (members.length > 120 && !suffix) {
      // Split once more by the next word; what stays small keeps the topic's own name.
      const second = new Map<string, string[]>();
      for (const name of members) {
        const k = words(name, skip).slice(0, 2).join(' ');
        if (!second.has(k)) second.set(k, []);
        (second.get(k) as string[]).push(name);
      }
      for (const [k2, sub] of second) {
        const label = sub.length >= 5 ? topicLabel(k2.split(' ')) : topicLabel([key]);
        for (const name of sub) out.set(name, label);
      }
      continue;
    }
    for (const name of members) out.set(name, plural(key));
  }
  return out;
}

export function headingOf(fqcn: string): string {
  return headings().get(fqcn) ?? productOf(collectionOf(fqcn));
}

// ---------------------------------------------------------- how it runs ---

interface PlayShape {
  readonly hosts: string;
  readonly gather_facts: boolean;
  readonly become?: boolean;
  /** Play vars that make it runnable as it stands: connection, network OS. */
  readonly vars?: Readonly<Record<string, string>>;
}

const LOCAL: PlayShape = { hosts: 'localhost', gather_facts: false, vars: { ansible_connection: 'local' } };

/** Network platforms driven over SSH (network_cli): the group and the network OS. */
const NETWORK_CLI: Readonly<Record<string, string>> = {
  'cisco.ios': 'cisco.ios.ios',
  'cisco.iosxr': 'cisco.iosxr.iosxr',
  'cisco.nxos': 'cisco.nxos.nxos',
  'arista.eos': 'arista.eos.eos',
  'vyos.vyos': 'vyos.vyos.vyos',
  'dellemc.enterprise_sonic': 'dellemc.enterprise_sonic.sonic',
  'community.routeros': 'community.routeros.routeros',
  'community.ciscosmb': 'community.ciscosmb.ciscosmb',
};

/** Network platforms driven over their HTTP API (httpapi). */
const NETWORK_HTTPAPI: Readonly<Record<string, string>> = {
  'fortinet.fortios': 'fortinet.fortios.fortios',
  'fortinet.fortimanager': 'fortinet.fortimanager.fortimanager',
  'check_point.mgmt': 'check_point.mgmt.checkpoint',
};

/** Collections whose modules act on the managed host itself (everything else calls an API from localhost). */
const ON_HOST = /^(ansible\.builtin|ansible\.posix|community\.general|community\.crypto|community\.libvirt|community\.sops|ansible\.windows|community\.windows|microsoft\.ad|microsoft\.iis|chocolatey\.chocolatey|community\.docker|containers\.podman|community\.postgresql|ansible\.mysql|ansible\.mariadb|community\.mysql|community\.mongodb|community\.proxysql|community\.clickhouse|community\.rabbitmq|lowlydba\.sqlserver)$/;

function playShape(collection: string): PlayShape {
  const cli = NETWORK_CLI[collection];
  if (cli) {
    return { hosts: collection.split('.')[1] as string, gather_facts: false, vars: { ansible_connection: 'ansible.netcommon.network_cli', ansible_network_os: cli } };
  }
  const api = NETWORK_HTTPAPI[collection];
  if (api) {
    return { hosts: collection.split('.')[1] as string, gather_facts: false, vars: { ansible_connection: 'ansible.netcommon.httpapi', ansible_network_os: api } };
  }
  if (/^(ansible\.windows|community\.windows|microsoft\.|chocolatey\.)/.test(collection)) return { hosts: 'windows', gather_facts: false };
  if (ON_HOST.test(collection)) return { hosts: 'all', gather_facts: false, become: true };
  return LOCAL;
}

// ----------------------------------------------------------------- form ---

const OPTIONAL_SECTION = 'Optional options';

const TYPE_HINT: Readonly<Record<TypeCode, string>> = {
  s: '',
  n: 'number',
  b: '',
  ls: 'comma-separated list',
  ln: 'comma-separated numbers',
  m: 'one key=value per line, or JSON',
  x: 'JSON, or a YAML flow value: [a, b] / {k: v}',
  h: 'YAML flow or JSON for this whole group',
};

const TRUE_FALSE: readonly SelectOption[] = [
  { value: 'true', label: 'true' },
  { value: 'false', label: 'false' },
];

/** A name safe as an Ansible variable. */
function varName(path: readonly string[]): string {
  return path.join('_').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

function optionInput(row: OptionRow, path: readonly string[], section: string | undefined, showWhen: BlueprintInput['showWhen']): BlueprintInput {
  const [name, type, flags, description, rawChoices, fallback] = row;
  // Some modules document a blank or a repeat among their choices.
  const choices = rawChoices ? [...new Set(rawChoices.filter((c) => c !== ''))] : rawChoices;
  const required = flags.startsWith('r');
  const secret = flags.includes('s');
  const base = {
    id: `r.${[...path, name].join('.')}`,
    label: name,
    hint: [TYPE_HINT[type], required ? 'required' : fallback !== undefined ? `optional — module default ${fallback}` : 'optional'].filter(Boolean).join(' · '),
    ...(description ? { help: description } : {}),
    ...(section ? { section } : {}),
    ...(showWhen ? { showWhen } : {}),
  };
  if (secret) {
    const variable = `vault_${varName([...path, name])}`;
    return { ...base, control: 'text', default: required ? `{{ ${variable} }}` : '', placeholder: `{{ ${variable} }}`, hint: `${base.hint} · secret: a vault variable, never the value` };
  }
  if (type === 'b') {
    return required
      ? { ...base, control: 'select', options: TRUE_FALSE, default: fallback === 'true' ? 'true' : 'false' }
      : { ...base, control: 'select', options: TRUE_FALSE, blankLabel: `(module default${fallback !== undefined ? `: ${fallback}` : ''})` };
  }
  if (choices && choices.length > 0 && (type === 's' || type === 'n')) {
    // The documented choices are the ones the module accepts: a closed set.
    return {
      ...base,
      control: 'select',
      options: choices.map((c) => ({ value: c, label: c })),
      // Required: start on the documented default, else the first choice — a
      // variable would be checked against the choices by name and fail.
      // (A documented default that is not among the choices — some OCI modules — is not used.)
      ...(required
        ? { default: fallback !== undefined && fallback !== null && choices.includes(fallback) ? fallback : choices[0] }
        : fallback !== undefined && fallback !== null && !choices.includes(fallback)
          ? // The module's own default is not one of its choices, so it fails
            // unless one is given (some OCI modules: state defaults to present,
            // only absent allowed): start on the first valid one.
            { default: choices[0] }
          : { blankLabel: `(module default${fallback !== undefined ? `: ${fallback}` : ''})` }),
    };
  }
  if (choices && choices.length > 0 && type === 'ls') {
    return { ...base, control: 'checklist', options: choices.map((c) => ({ value: c, label: c })), default: required ? (fallback !== undefined && fallback !== null && choices.includes(fallback) ? fallback : choices[0]) : '' };
  }
  if (type === 'n') return { ...base, control: 'number', default: '' };
  if (type === 'm' || type === 'x' || type === 'h') return { ...base, control: 'textarea', default: '', placeholder: type === 'm' ? 'key=value' : '{"key": "value"}' };
  return { ...base, control: 'text', default: '' };
}

function groupInputs(schema: ModuleSchema, path: readonly string[], section: string | undefined, gate: BlueprintInput['showWhen'], out: BlueprintInput[]): void {
  for (const row of schema.a) {
    const where = path.length === 0 ? (row[2].startsWith('r') ? undefined : OPTIONAL_SECTION) : section;
    out.push(optionInput(row, path, where, gate));
  }
  for (const [name, mode, required, , child] of schema.b ?? []) {
    const childPath = [...path, name];
    const childSection = `Group: ${childPath.join(' › ')}`;
    let childGate = gate;
    if (!required) {
      const toggle = `b.${childPath.join('.')}`;
      out.push({
        id: toggle,
        label: `Include ${name}`,
        control: 'toggle',
        default: false,
        hint: mode === 'l' ? 'list of settings · one entry here; repeat it in the playbook for more' : 'group of settings',
        section: childSection,
        ...(gate ? { showWhen: gate } : {}),
      });
      childGate = { input: toggle, equals: ['true'] };
    }
    groupInputs(child, childPath, childSection, childGate, out);
  }
}

// ---------------------------------------------------------------- values ---

const JINJA = /^\s*\{\{.*\}\}\s*$/s;

interface Collected {
  readonly vars: Map<string, { description: string; secret: boolean }>;
  readonly findings: Finding[];
}

function parseFlow(text: string): YamlValue {
  try {
    return JSON.parse(text) as YamlValue;
  } catch {
    return text;
  }
}

function optionValue(row: OptionRow, raw: unknown, path: readonly string[], out: Collected): YamlValue | undefined {
  const [name, type, flags, description] = row;
  const required = flags.startsWith('r');
  let value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '') {
    if (!required) return undefined;
    // Required and not given: a variable, listed in group_vars/all.yml to fill in.
    const variable = flags.includes('s') ? `vault_${varName([...path, name])}` : varName([...path, name]);
    value = `{{ ${variable} }}`;
  }
  const ref = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(value);
  if (ref && !out.vars.has(ref[1] as string)) out.vars.set(ref[1] as string, { description: description || [...path, name].join('.'), secret: flags.includes('s') || (ref[1] as string).startsWith('vault_') });
  if (JINJA.test(value) && type !== 'ls' && type !== 'ln') return value;
  switch (type) {
    case 'n': {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case 'b':
      return value === 'true' || value === 'yes';
    case 'ls':
    case 'ln': {
      if (JINJA.test(value)) return value;
      if (value.startsWith('[')) return parseFlow(value);
      const items = value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      return type === 'ln' ? items.map((s) => (Number.isFinite(Number(s)) ? Number(s) : s)) : items;
    }
    case 'm': {
      if (value.startsWith('{')) return parseFlow(value);
      const dict: Record<string, YamlValue> = {};
      for (const line of value.split('\n')) {
        const m = /^\s*([^=:]+?)\s*[=:]\s*(.*?)\s*$/.exec(line);
        if (m) dict[m[1] as string] = m[2] as string;
      }
      return dict;
    }
    case 'x':
    case 'h':
      return parseFlow(value);
    default:
      return value;
  }
}

// ---------------------------------------------------------------- rules ---

/**
 * What a module checks in code rather than documents: "one of the following
 * is required", "state is present but any of the following are missing",
 * "parameters are required together". Found by
 * tools/discover-module-rules.mjs from ansible-lint's argument check; paths
 * are dotted through suboptions.
 */
interface ModuleRules {
  /** Groups of which one has to be set; the first stands in (as a variable, or its group included). */
  readonly oneOf?: readonly (readonly string[])[];
  /** Groups set together: once one is, the rest become variables too. */
  readonly allOf?: readonly (readonly string[])[];
  /** Fields that start other than empty, keyed by input id. */
  readonly defaults?: Readonly<Record<string, string | boolean>>;
  /** Files the task refers to, written beside the playbook so it runs as downloaded. */
  readonly files?: Readonly<Record<string, string>>;
  /** Options the module documents but rejects (a shared doc fragment that does not apply). */
  readonly omit?: readonly string[];
}

const STARTER_TASKS = `---
# A starting point: replace with the tasks to run.
- name: Say where these tasks come from
  ansible.builtin.debug:
    msg: Tasks from this file ran.
`;

/** Modules whose needs no ansible-lint message states. */
const MODULE_RULES: Readonly<Record<string, ModuleRules>> = {
  // These load another file; the placeholder names one to put beside the playbook.
  'ansible.builtin.import_tasks': { defaults: { 'r.file': 'tasks/main.yml' }, files: { 'tasks/main.yml': STARTER_TASKS } },
  'ansible.builtin.include_tasks': { defaults: { 'r.file': 'tasks/main.yml' }, files: { 'tasks/main.yml': STARTER_TASKS } },
  'ansible.builtin.import_role': { defaults: { 'r.name': 'my_role' }, files: { 'roles/my_role/tasks/main.yml': STARTER_TASKS } },
  'ansible.builtin.include_role': { defaults: { 'r.name': 'my_role' }, files: { 'roles/my_role/tasks/main.yml': STARTER_TASKS } },
  // Its documentation pulls in the collection's login fragment; the module takes ibox_* options instead.
  'infinidat.infinibox.infini_infinimetrics': { omit: ['user', 'password', 'system'] },
};

/** Options a module documents but rejects, which the checker must not ask for. */
export function omittedOptions(fqcn: string): readonly string[] {
  return rulesOf(fqcn).omit ?? [];
}

function rulesOf(fqcn: string): ModuleRules {
  const hand = MODULE_RULES[fqcn];
  const found = (DISCOVERED_MODULE_RULES as Readonly<Record<string, ModuleRules>>)[fqcn];
  if (!hand || !found) return hand ?? found ?? {};
  return {
    oneOf: [...(hand.oneOf ?? []), ...(found.oneOf ?? [])],
    allOf: [...(hand.allOf ?? []), ...(found.allOf ?? [])],
    defaults: { ...(found.defaults ?? {}), ...(hand.defaults ?? {}) },
    ...(hand.files ? { files: hand.files } : {}),
    ...(hand.omit ? { omit: hand.omit } : {}),
  };
}

/** The option row a dotted path names, if it names one. */
function optionAt(schema: ModuleSchema, path: string): OptionRow | undefined {
  const parts = path.split('.');
  const leaf = parts.pop() as string;
  let block: ModuleSchema | undefined = schema;
  for (const part of parts) block = block?.b?.find((b) => b[0] === part)?.[4];
  return block?.a.find((a) => a[0] === leaf);
}

/** The suboption group a dotted path names, if it names one. */
function groupAt(schema: ModuleSchema, path: string): GroupRow | undefined {
  let block: ModuleSchema | undefined = schema;
  let row: GroupRow | undefined;
  for (const part of path.split('.')) {
    row = block?.b?.find((b) => b[0] === part);
    if (!row) return undefined;
    block = row[4];
  }
  return row;
}

function applyRules(schema: ModuleSchema, rules: ModuleRules, values: BlueprintValues): BlueprintValues {
  const filled: Record<string, BlueprintValues[string]> = { ...values };
  // A required option counts as set: it is always written (as a variable when empty).
  const isSet = (path: string): boolean =>
    groupAt(schema, path)
      ? filled[`b.${path}`] === true || filled[`b.${path}`] === 'true'
      : String(filled[`r.${path}`] ?? '').trim() !== '' || !!optionAt(schema, path)?.[2].startsWith('r');
  const standIn = (path: string): void => {
    const parts = path.split('.');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('.');
      if (groupAt(schema, ancestor)) filled[`b.${ancestor}`] = true;
    }
    if (groupAt(schema, path)) filled[`b.${path}`] = true;
    else {
      // An option with documented choices stands in as its first choice: a
      // variable would be checked against the choices by name and fail.
      const row = optionAt(schema, path);
      const choice = row?.[4]?.find((c) => c !== '');
      filled[`r.${path}`] = choice ?? `{{ ${varName(parts)} }}`;
    }
  };
  for (const group of rules.oneOf ?? []) if (!group.some(isSet) && group[0]) standIn(group[0]);
  // For "together", an option with a module default is set too — the module
  // applies it (dnsmadeeasy: record_ttl defaults to 1800, so value and type follow).
  const hasDefault = (path: string): boolean => {
    const row = optionAt(schema, path);
    return row?.[5] !== undefined && row?.[5] !== null;
  };
  for (const group of rules.allOf ?? []) {
    if (group.some((p) => isSet(p) || hasDefault(p))) for (const path of group) if (!isSet(path) && !hasDefault(path)) standIn(path);
  }
  return filled;
}

function groupValue(schema: ModuleSchema, values: BlueprintValues, path: readonly string[], out: Collected): Record<string, YamlValue> {
  const args: Record<string, YamlValue> = {};
  for (const row of schema.a) {
    const v = optionValue(row, values[`r.${[...path, row[0]].join('.')}`], path, out);
    if (v !== undefined) args[row[0]] = v;
  }
  for (const [name, mode, required, , child] of schema.b ?? []) {
    const childPath = [...path, name];
    const toggle = values[`b.${childPath.join('.')}`];
    if (!required && toggle !== true && toggle !== 'true') continue;
    const inner = groupValue(child, values, childPath, out);
    args[name] = mode === 'l' ? [inner] : inner;
  }
  return args;
}

// --------------------------------------------------------------- files ---

function requirementsYml(collection: string): string | null {
  if (collection === 'ansible.builtin') return null;
  const version = collectionVersion(collection);
  const major = version ? Number(version.split('.')[0]) : NaN;
  const pin = version && Number.isFinite(major) ? `\n    version: '>=${version},<${major + 1}.0.0'` : '';
  return `# Collections this playbook needs.
#
# Install with:  ansible-galaxy collection install -r requirements.yml
---
collections:
  - name: ${collection}${pin}
`;
}

function varsYml(vars: Collected['vars']): string {
  const lines = [
    '# Values the playbook needs and has no answer for yet. Ansible reads this file',
    '# for every host (and localhost) on its own; fill these in before a real run.',
    '# A vault_ value is a secret: put it in an ansible-vault encrypted file',
    '# (ansible-vault create group_vars/all/vault.yml), never here.',
    '---',
  ];
  for (const [name, v] of vars) {
    lines.push(`# ${v.description.replace(/\s+/g, ' ').slice(0, 110)}`);
    lines.push(v.secret ? `# ${name}: set in vault.yml, not here` : `${name}: ''`);
  }
  return `${lines.join('\n')}\n`;
}

function fileName(name: string, fqcn: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || fqcn.split('.').pop()}.yml`;
}

// ------------------------------------------------------------- blueprint ---

interface Materialized {
  readonly inputs: readonly BlueprintInput[];
  readonly description: string;
  readonly build: Blueprint['build'];
}

const HOSTS_ID = 'hosts';

function materialize(fqcn: string, schema: ModuleSchema): Materialized {
  const collection = collectionOf(fqcn);
  const shape = playShape(collection);
  const rules = rulesOf(fqcn);
  if (rules.omit) {
    const omit = new Set(rules.omit);
    schema = { ...schema, a: schema.a.filter((row) => !omit.has(row[0])) };
  }
  const collected: BlueprintInput[] = [];
  groupInputs(schema, [], undefined, undefined, collected);
  // The rules' members say so beside them, and their defaults apply.
  const inputs: BlueprintInput[] = collected.map((input) => {
    const path = input.id.slice(2);
    const group = rules.oneOf?.find((g) => g.includes(path) && g.length > 1);
    const preset = rules.defaults?.[input.id];
    return {
      ...input,
      ...(preset !== undefined ? { default: preset } : {}),
      ...(group ? { hint: `${input.hint ?? ''} · set this or ${group.filter((g) => g !== path).join(' / ')}` } : {}),
    };
  });
  inputs.push({
    id: HOSTS_ID,
    label: 'Run against',
    control: 'text',
    default: shape.hosts,
    hint: shape.hosts === 'localhost' ? 'API module: runs from the control node' : 'inventory group or host pattern',
    section: 'Play',
  });
  if (shape.become !== undefined) {
    inputs.push({ id: 'become', label: 'Become (sudo / run as admin)', control: 'select', options: TRUE_FALSE, default: shape.become ? 'true' : 'false', section: 'Play' });
  }
  inputs.push({ id: 'check_mode', label: 'Check mode only (dry run)', control: 'select', options: TRUE_FALSE, default: 'false', section: 'Play' });

  const required = schema.a.filter((a) => a[2].startsWith('r')).length;
  const groups = (schema.b ?? []).length;
  const version = collectionVersion(collection);
  return {
    inputs,
    description:
      `${schema.d ? `${schema.d}. ` : ''}One ${fqcn} task, with every option ${collection}${version ? ` ${version}` : ''} documents: ` +
      `${required} required up top, ${schema.a.length - required} optional${groups > 0 ? `, and ${groups} group${groups === 1 ? '' : 's'} of suboptions` : ''} below. ` +
      'Any field takes a Jinja expression — {{ var }} — as well as a value.',
    build: (values: BlueprintValues, name: string) => {
      const out: Collected = { vars: new Map(), findings: [] };
      const args = groupValue(schema, applyRules(schema, rules, values), [], out);
      const hosts = String(values[HOSTS_ID] ?? '').trim() || shape.hosts;
      const play: Record<string, YamlValue> = {
        name: schema.d || fqcn,
        hosts,
        gather_facts: shape.gather_facts,
        ...(shape.become !== undefined ? { become: values.become === true || values.become === 'true' } : {}),
        ...(shape.vars ? { vars: { ...shape.vars } } : {}),
        tasks: [
          {
            name: schema.d || fqcn,
            [fqcn]: Object.keys(args).length > 0 ? args : null,
            ...(values.check_mode === true || values.check_mode === 'true' ? { check_mode: true } : {}),
          },
        ],
      };
      const playbook = fileName(name, fqcn);
      const header = [
        `${fqcn}${schema.d ? ` — ${schema.d}` : ''}`,
        '',
        `Run with:  ansible-playbook ${playbook} --check --diff`,
        '',
        'Credentials belong in the environment or an ansible-vault file, never in',
        'this playbook. Nothing here writes one.',
      ].join('\n');
      const files: Record<string, string> = { [playbook]: renderYaml([play] as YamlValue, { header }) };
      for (const [path, text] of Object.entries(rules.files ?? {})) files[path] = text;
      const requirements = requirementsYml(collection);
      if (requirements) files['requirements.yml'] = requirements;
      if (out.vars.size > 0) {
        files['group_vars/all.yml'] = varsYml(out.vars);
        out.findings.push(info('ansible.module.vars', `${out.vars.size} value${out.vars.size === 1 ? '' : 's'} to supply: fill in group_vars/all.yml (secrets in an ansible-vault file).`));
      }
      return { files, findings: out.findings };
    },
  };
}

/** The blueprint for one module: every option it documents, as a field. Lazy until picked. */
export function moduleBlueprint(fqcn: string): Blueprint {
  const [file, short] = INDEX.modules[fqcn] ?? [];
  if (!file) throw new Error(`${fqcn}: not in the Ansible module index`);
  const shortName = fqcn.split('.').pop() as string;
  let made: Materialized | undefined;
  const ready = (): Materialized | undefined => {
    if (made) return made;
    const schema = moduleSchema(fqcn);
    if (schema) made = materialize(fqcn, schema);
    return made;
  };
  const blueprint = {
    id: `mod_${fqcn.replace(/\./g, '_')}`,
    label: short ? `${shortName} — ${short}` : shortName,
    group: headingOf(fqcn),
    emits: [fqcn],
    get inputs(): readonly BlueprintInput[] {
      return ready()?.inputs ?? [];
    },
    get description(): string {
      return ready()?.description ?? `${short ?? fqcn}. Loading every option ${fqcn} takes…`;
    },
    build: (values: BlueprintValues, name: string) => {
      const m = ready();
      if (!m) throw new Error(`${fqcn}: its options have not loaded yet`);
      return m.build(values, name);
    },
  };
  // Added, not spread in: a spread would read the getters once, while empty.
  Object.defineProperty(blueprint, 'load', { enumerable: true, value: () => loadModule(fqcn) });
  return blueprint as Blueprint;
}

/** Every module of every collection, grouped into the platforms they belong to. */
export function moduleBlueprintsByPlatform(): ReadonlyMap<string, Blueprint[]> {
  const byTarget = new Map<string, Blueprint[]>();
  // Heading, then name: each heading's modules together, headings in order.
  const ordered = moduleNames().sort((a, b) => headingOf(a).localeCompare(headingOf(b)) || a.localeCompare(b));
  for (const fqcn of ordered) {
    const { target } = placementOf(collectionOf(fqcn));
    if (!byTarget.has(target)) byTarget.set(target, []);
    (byTarget.get(target) as Blueprint[]).push(moduleBlueprint(fqcn));
  }
  return byTarget;
}

/** The groups for platforms that had no Ansible blueprints before: their playbooks, then every module. */
export function newPlatformGroups(
  byTarget: ReadonlyMap<string, Blueprint[]>,
  playbooks: Readonly<Record<string, readonly Blueprint[]>> = {},
): BlueprintGroup[] {
  return Object.entries(NEW_PLATFORMS)
    .filter(([target]) => (byTarget.get(target) ?? []).length > 0)
    .map(([target, label]) => ({ target, label, blueprints: [...(playbooks[target] ?? []), ...(byTarget.get(target) ?? [])] }));
}

export const ANSIBLE_SCHEMA_SUMMARY = { package: INDEX.package, core: INDEX.core };

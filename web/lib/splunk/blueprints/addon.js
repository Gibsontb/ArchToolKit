/**
 * Splunk add-ons: one data source end to end, and onboarding what the toolkit
 * builds.
 *
 * An add-on is the one kind of Splunk app that goes to every tier, and that is
 * the point of it: the forwarder reads its inputs.conf and EVENT_BREAKER, the
 * indexer (or the heavy forwarder that parses) reads its line breaking and
 * timestamp settings, and the search head reads its extractions, aliases, event
 * types and tags. Each tier ignores the part that is not its job. Splitting a
 * TA into a "search head part" and an "indexer part" is how the two halves end
 * up at different versions, with a field alias on the search head pointing at
 * a field the indexer stopped producing a release ago.
 *
 * The custom TA exists because most of the value of Splunk data comes from the
 * Common Information Model, and most custom sources never reach it: the events
 * are indexed, the vendor's field names are extracted, and nothing in
 * Enterprise Security or any CIM-based app can see them because the tags are
 * missing or `action` says "OK" where the model expects "success".
 *
 * The onboarding blueprints take what the rest of the toolkit builds — the
 * network devices from the Network page, the VCF 9.1 estate from the VCF and
 * Automation and Operations pages, the VMs of the imported RVTools estate —
 * and produce what it takes to get their logs into Splunk: the device-side
 * configuration, the collector configuration, the official add-on to install,
 * and the searches that prove every expected source is actually reporting.
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { currentEstate } from '../../kit/estate-store.js';
import { PLATFORMS,               } from '../../network/device.js';
import { splunkBlueprint,                      } from '../from-app.js';
import { defaultMeta, foldSearch, splunkName, spreadCron,                } from '../splunk.js';
import { formatHostPort, isIpv6, urlHost } from '../../core/ip.js';
import { LISTEN_ON_IPV6 } from './forwarder.js';

/**
 * listenOnIPv6 for the collector's listeners (and SC4S_IPV6_ENABLE), with an
 * error when the devices are told to send to an IPv6 address nothing hears.
 */
function listenFor(values                 , target        , findings           )         {
  const choice = str(values, 'listen_ipv6', 'no');
  const listen = ['yes', 'only'].includes(choice) ? choice : 'no';
  if (listen === 'no' && isIpv6(target)) {
    findings.push(error('splunk.collector-ipv6-not-listening', `The collector is ${target}, an IPv6 address, but its listeners hear IPv4 only (listenOnIPv6 = no; SC4S without SC4S_IPV6_ENABLE). Nothing the devices send would arrive.`, { remediation: 'Set Listen on IPv6 to yes (dual-stack), or give the collector’s IPv4 address.', source: 'inputs.conf spec' }));
  }
  return listen;
}

/** The input for it, shared by the network and VMware onboarding. */
const LISTEN_INPUT                 = { id: 'listen_ipv6', label: 'Collector listens on IPv6', control: 'select', default: 'no', options: LISTEN_ON_IPV6, hint: 'listenOnIPv6 on the heavy forwarder stanzas, SC4S_IPV6_ENABLE for SC4S' };

const TIER = 'addon'         ;
const SRC = 'ArchToolKit';

// --- small helpers -----------------------------------------------------------
// Exported for the other onboarding blueprints (onboarding-more.ts).

/** Non-empty, non-comment lines of a textarea. */
export function linesOf(value        )           {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Something a shell, PowerShell or a syslog filter will accept as a host name or address. */
export function hostAddress(value                    )         {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) ? v : '';
}

/** An app id as Splunk writes them: TA-vendor-product and Splunk_TA_x are both legal. */
function appId(value        , fallback        )         {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || fallback;
}

/** A sourcetype: lower case, colon-separated, nothing a stanza header will trip on. */
function sourcetypeOf(value        , fallback        )         {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_.-]+/g, '_');
  return cleaned || fallback;
}

/** An index name Splunk accepts: lower case letters, digits, _ and -, not starting with _ or -. */
export function indexName(value        , fallback        )         {
  const cleaned = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+/, '');
  return cleaned || fallback;
}

/** A value quoted for SPL when it contains anything but word characters. */
export function splQuote(value        )         {
  return /^[\w.:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** A Python string literal. JSON's escaping is a subset of Python's. */
function py(value        )         {
  return JSON.stringify(value);
}

/** app.conf for an app that has to stand on its own: Splunk Cloud vetting and the deployer both read it. */
export function appConfLines(id        , label        , description        )           {
  return [
    '[install]',
    'state = enabled',
    'is_configured = false',
    '',
    '[ui]',
    'is_visible = false',
    `label = ${label}`,
    '',
    '[launcher]',
    'author = Automation',
    `description = ${description}`,
    'version = 1.0.0',
    '',
    '[package]',
    `id = ${id}`,
    '# Not on Splunkbase, so there is nothing to check for.',
    'check_for_updates = false',
    '',
    '[id]',
    `name = ${id}`,
    'version = 1.0.0',
  ];
}

export function csvCell(value                 )         {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// =============================================================================
// 1. The Common Information Model
// =============================================================================

/**
 * One dataset of a data model: the tags that put an event in it, and the
 * fields the model's searches read.
 *
 * `required` is what pytest-splunk-addon — Splunk's own CIM compliance test —
 * requires for the dataset (CIM 6.x reference, help.splunk.com). Where the
 * reference marks nothing as required, the dataset's recommended key fields
 * stand in, and the comment says so. `recommended` is the rest of what
 * correlation searches and dashboards commonly read.
 */
                      
                         
                         
                                       
                                   
                                                          
                         
                                        
                                           
 

                    
                      
                         
                                                         
                         
                                                                                            
                        
                                   
                                       
                                          
                                                                      
                                                                                                                  
                         
 

const CIM_MODELS                      = [
  {
    id: 'Authentication',
    label: 'Authentication',
    model: 'Authentication',
    root: 'Authentication',
    tags: ['authentication'],
    required: ['action', 'app', 'dest', 'src', 'user'],
    recommended: ['src_user', 'signature', 'signature_id', 'reason', 'vendor_product'],
    note: 'action must be one of success, failure, pending, error — the vendor’s own words ("OK", "DENIED") are what an EVAL maps.',
  },
  {
    id: 'Network_Traffic',
    label: 'Network Traffic',
    model: 'Network_Traffic',
    root: 'All_Traffic',
    tags: ['network', 'communicate'],
    required: ['action', 'app', 'dest', 'dest_zone', 'dvc', 'src', 'src_translated_ip', 'src_zone', 'transport'],
    recommended: ['bytes', 'bytes_in', 'bytes_out', 'dest_port', 'protocol', 'rule', 'src_port', 'user', 'vendor_product'],
    note: 'action is allowed, blocked or teardown; transport is tcp, udp or icmp, in lower case.',
  },
  {
    id: 'Web',
    label: 'Web (and Proxy)',
    model: 'Web',
    root: 'Web',
    tags: ['web'],
    required: ['action', 'bytes', 'bytes_in', 'bytes_out', 'category', 'dest', 'dest_port', 'http_method', 'http_user_agent', 'http_user_agent_length', 'src', 'status', 'url'],
    recommended: ['app', 'http_content_type', 'http_referrer', 'http_referrer_domain', 'url_domain', 'user', 'vendor_product'],
    datasets: {
      input: 'web_dataset',
      label: 'Web dataset',
      options: [
        { value: 'web', label: 'Web (servers)', tags: [] },
        { value: 'proxy', label: 'Proxy', tags: ['proxy'], node: 'Web.Proxy' },
      ],
    },
  },
  {
    id: 'Change',
    label: 'Change',
    model: 'Change',
    root: 'All_Changes',
    tags: ['change'],
    // image_id is listed against All_Changes in the 6.1 reference but only
    // means anything for instance changes; VERIFY against your CIM version.
    required: ['action', 'change_type', 'command', 'dest', 'dvc', 'object', 'object_attrs', 'object_category', 'object_id', 'object_path', 'status', 'user', 'vendor_product'],
    recommended: ['result', 'src'],
    datasets: {
      input: 'change_dataset',
      label: 'Change dataset',
      options: [
        { value: 'audit', label: 'Auditing changes', tags: ['audit'], node: 'All_Changes.Auditing_Changes' },
        { value: 'account', label: 'Account management', tags: ['account'], node: 'All_Changes.Account_Management', recommended: ['src_user', 'src_user_name', 'dest_nt_domain', 'src_nt_domain'] },
        { value: 'endpoint', label: 'Endpoint changes', tags: ['endpoint'], node: 'All_Changes.Endpoint_Changes' },
        { value: 'network', label: 'Network changes', tags: ['network'], node: 'All_Changes.Network_Changes' },
        { value: 'instance', label: 'Instance (cloud/VM) changes', tags: ['instance'], node: 'All_Changes.Instance_Changes', recommended: ['image_id', 'instance_type'] },
      ],
    },
  },
  {
    id: 'Endpoint_Processes',
    label: 'Endpoint — Processes',
    model: 'Endpoint',
    root: 'Processes',
    tags: ['process', 'report'],
    required: ['action', 'dest', 'parent_process_id', 'parent_process_name', 'parent_process_path', 'process', 'process_exec', 'process_id', 'process_name', 'process_path', 'user'],
    recommended: ['process_guid', 'process_hash', 'original_file_name', 'parent_process', 'vendor_product'],
  },
  {
    id: 'Endpoint_Services',
    label: 'Endpoint — Services',
    model: 'Endpoint',
    root: 'Services',
    tags: ['service', 'report'],
    required: ['dest', 'service', 'service_name', 'service_path', 'start_mode', 'status', 'user'],
    recommended: ['vendor_product'],
  },
  {
    id: 'Endpoint_Filesystem',
    label: 'Endpoint — Filesystem',
    model: 'Endpoint',
    root: 'Filesystem',
    tags: ['endpoint', 'filesystem'],
    required: ['action', 'dest', 'file_name', 'file_path', 'user'],
    recommended: ['file_hash', 'file_size', 'file_create_time', 'file_modify_time', 'vendor_product'],
  },
  {
    id: 'Intrusion_Detection',
    label: 'Intrusion Detection',
    model: 'Intrusion_Detection',
    root: 'IDS_Attacks',
    tags: ['ids', 'attack'],
    required: ['action', 'category', 'dvc', 'ids_type', 'severity', 'signature', 'transport'],
    recommended: ['dest', 'dest_port', 'src', 'src_port', 'signature_id', 'user', 'vendor_product'],
    note: 'ids_type is network, host, application or wireless; severity is critical, high, medium, low or informational.',
  },
  {
    id: 'Malware',
    label: 'Malware',
    model: 'Malware',
    root: 'Malware_Attacks',
    tags: ['malware', 'attack'],
    required: ['action', 'category', 'dest', 'file_name', 'file_path', 'signature'],
    recommended: ['date', 'file_hash', 'severity', 'user', 'vendor_product'],
    datasets: {
      input: 'malware_dataset',
      label: 'Malware dataset',
      options: [
        { value: 'attacks', label: 'Malware attacks (detections)', tags: [] },
        {
          value: 'operations',
          label: 'Malware operations (agent status, signature versions)',
          tags: ['operations'],
          required: ['dest', 'signature_version', 'vendor_product'],
          recommended: ['dest_nt_domain', 'product_version'],
        },
      ],
    },
  },
  {
    id: 'Vulnerabilities',
    label: 'Vulnerabilities',
    model: 'Vulnerabilities',
    root: 'Vulnerabilities',
    tags: ['report', 'vulnerability'],
    required: ['category', 'cve', 'cvss', 'dest', 'dvc', 'severity', 'signature'],
    recommended: ['signature_id', 'url', 'user', 'vendor_product', 'xref'],
  },
  {
    id: 'Alerts',
    label: 'Alerts',
    model: 'Alerts',
    root: 'Alerts',
    tags: ['alert'],
    // body is also listed but deprecated in favour of description.
    required: ['app', 'dest', 'id', 'severity', 'type'],
    recommended: ['description', 'signature', 'signature_id', 'src', 'user', 'user_name'],
    note: 'type is alarm, alert, event, task, warning or unknown.',
  },
  {
    id: 'Performance',
    label: 'Performance',
    model: 'Performance',
    root: 'All_Performance',
    tags: ['performance'],
    // The reference marks nothing required for Performance; these are the
    // recommended key fields the dataset's searches read.
    required: ['dest'],
    recommended: ['vendor_product'],
    datasets: {
      input: 'perf_dataset',
      label: 'Performance dataset',
      options: [
        { value: 'cpu', label: 'CPU', tags: ['cpu'], node: 'All_Performance.CPU', required: ['cpu_load_percent'] },
        { value: 'memory', label: 'Memory', tags: ['memory'], node: 'All_Performance.Memory', required: ['mem', 'mem_free', 'mem_used'] },
        { value: 'storage', label: 'Storage', tags: ['storage'], node: 'All_Performance.Storage', required: ['storage_free', 'storage_free_percent', 'storage_used', 'storage_used_percent'] },
        { value: 'network', label: 'Network', tags: ['network'], node: 'All_Performance.Network', required: ['thruput'] },
        { value: 'uptime', label: 'OS uptime', tags: ['os', 'uptime'], node: 'All_Performance.OS.Uptime', required: ['uptime'] },
        { value: 'facilities', label: 'Facilities', tags: ['facilities'], node: 'All_Performance.Facilities', required: ['temperature'] },
      ],
    },
  },
  {
    id: 'Inventory',
    label: 'Inventory',
    model: 'Inventory',
    root: 'All_Inventory',
    tags: ['inventory'],
    // As for Performance: recommended key fields, nothing marked required.
    required: ['dest'],
    recommended: ['vendor_product', 'version'],
    datasets: {
      input: 'inventory_dataset',
      label: 'Inventory dataset',
      options: [
        { value: 'os', label: 'Operating system', tags: ['system', 'version'], node: 'All_Inventory.OS', required: ['os'] },
        { value: 'cpu', label: 'CPU', tags: ['cpu'], node: 'All_Inventory.CPU', required: ['cpu_count', 'cpu_cores', 'cpu_mhz'] },
        { value: 'memory', label: 'Memory', tags: ['memory'], node: 'All_Inventory.Memory', required: ['mem'] },
        { value: 'network', label: 'Network', tags: ['network'], node: 'All_Inventory.Network', required: ['ip', 'mac', 'interface', 'dns'] },
        { value: 'storage', label: 'Storage', tags: ['storage'], node: 'All_Inventory.Storage', required: ['mount', 'storage'] },
        { value: 'user', label: 'User accounts', tags: ['user'], node: 'All_Inventory.User', required: ['user', 'user_id', 'shell'] },
        { value: 'virtual', label: 'Virtual machines', tags: ['virtual'], node: 'All_Inventory.Virtual_OS', required: ['hypervisor_id'] },
      ],
    },
  },
  {
    id: 'Email',
    label: 'Email',
    model: 'Email',
    root: 'All_Email',
    tags: ['email'],
    required: ['action', 'dest', 'internal_message_id', 'message_id', 'protocol', 'recipient', 'recipient_count', 'src', 'src_user', 'user'],
    recommended: ['recipient_domain', 'src_user_domain', 'signature', 'subject', 'vendor_product'],
    datasets: {
      input: 'email_dataset',
      label: 'Email dataset',
      options: [
        { value: 'all', label: 'All email', tags: [] },
        { value: 'delivery', label: 'Delivery', tags: ['delivery'], node: 'All_Email.Delivery' },
        { value: 'content', label: 'Content', tags: ['content'], node: 'All_Email.Content' },
        { value: 'filter', label: 'Filtering', tags: ['filter'], node: 'All_Email.Filtering' },
      ],
    },
  },
  {
    id: 'DLP',
    label: 'Data Loss Prevention',
    model: 'DLP',
    root: 'DLP_Incidents',
    tags: ['dlp', 'incident'],
    required: ['app'],
    recommended: ['action', 'category', 'dest', 'dlp_type', 'dvc', 'object', 'object_category', 'object_path', 'severity', 'signature', 'src', 'src_user', 'user', 'vendor_product'],
  },
  {
    id: 'Certificates',
    label: 'Certificates',
    model: 'Certificates',
    root: 'All_Certificates',
    tags: ['certificate'],
    required: [],
    recommended: ['dest', 'dest_port', 'src', 'src_port', 'transport'],
    datasets: {
      input: 'cert_dataset',
      label: 'Certificates dataset',
      options: [
        {
          value: 'ssl',
          label: 'SSL/TLS',
          // The dataset constraint is ssl OR tls; one of them is enough.
          tags: ['ssl'],
          node: 'All_Certificates.SSL',
          required: ['ssl_issuer', 'ssl_issuer_common_name', 'ssl_serial', 'ssl_subject', 'ssl_subject_common_name', 'ssl_subject_organization', 'ssl_validity_window'],
          recommended: ['ssl_start_time', 'ssl_end_time', 'ssl_hash'],
        },
      ],
    },
  },
  {
    id: 'Network_Resolution',
    label: 'Network Resolution (DNS)',
    model: 'Network_Resolution',
    root: 'DNS',
    tags: ['network', 'resolution', 'dns'],
    required: ['additional_answer_count', 'answer', 'answer_count', 'authority_answer_count', 'dest', 'message_type', 'query', 'query_count', 'query_type', 'record_type', 'reply_code', 'reply_code_id', 'response_time', 'src', 'transaction_id', 'transport'],
    recommended: ['ttl', 'vendor_product'],
    note: 'message_type is Query or Response.',
  },
  {
    id: 'Network_Sessions',
    label: 'Network Sessions (DHCP, VPN)',
    model: 'Network_Sessions',
    root: 'All_Sessions',
    tags: ['network', 'session'],
    required: ['action', 'dest_ip', 'dest_mac', 'signature', 'user'],
    recommended: ['dest_dns', 'dest_nt_host', 'src_dns', 'src_ip', 'src_mac', 'src_nt_host', 'vendor_product'],
    datasets: {
      input: 'session_dataset',
      label: 'Sessions dataset',
      options: [
        { value: 'vpn', label: 'VPN', tags: ['vpn'], node: 'All_Sessions.VPN' },
        { value: 'dhcp', label: 'DHCP', tags: ['dhcp'], node: 'All_Sessions.DHCP', required: ['lease_scope'], recommended: ['lease_duration'] },
        { value: 'start', label: 'Session start', tags: ['start'], node: 'All_Sessions.Session_Start' },
        { value: 'end', label: 'Session end', tags: ['end'], node: 'All_Sessions.Session_End' },
      ],
    },
  },
];

/** The follow-up dataset selects, one per model that has datasets. */
const CIM_DATASET_INPUTS                   = CIM_MODELS.filter((m) => m.datasets).map((m) => ({
  id: m.datasets .input,
  label: m.datasets .label,
  control: 'select'         ,
  default: m.datasets .options[0] .value,
  options: m.datasets .options.map((o) => ({ value: o.value, label: o.label })),
  showWhen: { input: 'cim_model', equals: [m.id] },
}));

// =============================================================================
// 2. Network devices
// =============================================================================

                           
                                                                        
                         
                                                                                           
                              
                                                                      
                                       
                             
                                                                      
                                       
     
                                                                       
                                                                     
                                                                          
     
                                                                                
                                                                 
                          
                       
                                                                        
                              
 

const NET                                              = {
  cisco_ios: {
    addon: 'Cisco Enterprise Networking (Catalyst) Add-on for Splunk (Splunkbase 7538), which SC4S references. It replaces the deprecated Cisco Networks Add-on (TA-cisco_ios, Splunkbase 1467): remove that one where it is installed, do not run both',
    sourcetype: 'cisco:ios',
    produces: ['cisco:ios'],
    firewall: false,
    sc4sKeys: ['cisco_ios'],
    hfPort: 5514,
    cim: 'Change, Authentication, Network_Traffic (ACL hits) — VERIFY per add-on version',
    sendsZone: true,
  },
  cisco_nxos: {
    addon: 'the same Catalyst add-on as IOS (Splunkbase 7538) — NX-OS arrives as cisco:ios; VERIFY NX-OS coverage in the add-on’s release notes',
    sourcetype: 'cisco:ios',
    produces: ['cisco:ios'],
    firewall: false,
    sc4sKeys: ['cisco_ios'],
    hfPort: 5514,
    cim: 'Change, Authentication — VERIFY',
    sendsZone: false,
  },
  cisco_wlc: {
    addon: 'the same Catalyst add-on as IOS (Splunkbase 7538) — the Catalyst 9800 is IOS-XE and arrives as cisco:ios',
    sourcetype: 'cisco:ios',
    produces: ['cisco:ios'],
    firewall: false,
    sc4sKeys: ['cisco_ios'],
    hfPort: 5514,
    cim: 'Change, Authentication, Network_Sessions (client association) — VERIFY',
    sendsZone: true,
  },
  cisco_asa: {
    addon: 'Splunk Add-on for Cisco ASA (Splunk_TA_cisco-asa, Splunkbase 1620)',
    sourcetype: 'cisco:asa',
    produces: ['cisco:asa'],
    firewall: true,
    sc4sKeys: ['cisco_asa'],
    hfPort: 5515,
    cim: 'Network_Traffic, Authentication, Change, Intrusion_Detection, Network_Sessions (VPN)',
    sendsZone: true,
  },
  arista_eos: {
    addon: 'none Splunk-supported for EOS syslog (Arista Networks Telemetry for Splunk, Splunkbase 1918, is streaming telemetry, not syslog) — build one with the custom TA blueprint',
    sourcetype: 'arista:eos',
    produces: ['arista:eos'],
    firewall: false,
    sc4sKeys: ['arista_eos'],
    sc4sBySource: { vendor: 'arista', product: 'eos' },
    hfPort: 5519,
    cim: 'none until a TA maps it',
    sendsZone: false,
  },
  panos: {
    addon: 'Splunk Add-on for Palo Alto Networks 4.0.0 (Splunkbase 7523, Splunk-supported; supersedes the Palo Alto Networks Add-on, Splunkbase 2757)',
    sourcetype: 'pan:firewall',
    produces: ['pan:traffic', 'pan:threat', 'pan:system', 'pan:config', 'pan:globalprotect', 'pan:userid'],
    firewall: true,
    sc4sKeys: ['pan_panos_log', 'pan_panos_traffic', 'pan_panos_threat', 'pan_panos_system', 'pan_panos_config', 'pan_panos_globalprotect', 'pan_panos_userid', 'pan_panos_hipmatch', 'pan_panos_correlation'],
    hfPort: 5516,
    cim: 'Network_Traffic, Intrusion_Detection, Web, Change, Authentication, Alerts',
    sendsZone: false,
  },
  fortios: {
    addon: 'Fortinet FortiGate Add-On for Splunk 1.6.10 (Splunk_TA_fortinet_fortigate, Splunkbase 2846, Fortinet-published, not Splunk-supported) — version 1.6 and later expects fortigate_* sourcetypes, earlier ones fgt_*',
    sourcetype: 'fortigate_log',
    produces: ['fortigate_traffic', 'fortigate_utm', 'fortigate_event'],
    firewall: true,
    sc4sKeys: ['fortinet_fortios_traffic', 'fortinet_fortios_utm', 'fortinet_fortios_event', 'fortinet_fortios_log'],
    hfPort: 5517,
    cim: 'Network_Traffic, Intrusion_Detection, Malware, Web, Authentication, Change',
    sendsZone: false,
  },
  f5: {
    addon: 'Splunk Add-on for F5 BIG-IP (Splunk_TA_f5-bigip, Splunkbase 2680)',
    sourcetype: 'f5:bigip:syslog',
    produces: ['f5:bigip:syslog', 'f5:bigip:asm:syslog', 'f5:bigip:apm:syslog'],
    firewall: false,
    sc4sKeys: ['f5_bigip'],
    sc4sBySource: { vendor: 'f5', product: 'bigip' },
    hfPort: 5518,
    cim: 'Authentication, Change, Web / Intrusion_Detection (ASM) — VERIFY',
    sendsZone: false,
  },
};

                  
                        
                      
                                     
                       
 

function parseDevices(value        )           {
  return linesOf(value).map((line) => {
    const [name, ip, platform] = line.split(/[,;\t]/).map((p) => p.trim());
    const known = platform && platform in PLATFORMS ? (platform            ) : null;
    return { name: hostAddress(name) || splunkName(name ?? '', 'device'), ip: hostAddress(ip), platform: known, raw: platform ?? '' };
  });
}

/** The lines that make one device send its syslog to the collector. */
function deviceConfig(d                                 , target        , port        , transport        , ntp        , tz        )           {
  // F5 lines are tmsh commands run from the BIG-IP bash shell, where the
  // comment is "#"; the Network page's "//" is for AS3 and iRules.
  const c = d.platform === 'f5' ? '#' : PLATFORMS[d.platform].comment;
  const utc = tz.toUpperCase() === 'UTC';
  const v6 = isIpv6(target);
  const hdr = [
    `${c} ${d.name} (${PLATFORMS[d.platform].label}) — send syslog to ${formatHostPort(target, port)} over ${transport.toUpperCase()}`,
    `${c} Capture first: the current logging and clock configuration, so the back-out is a paste.`,
  ];
  switch (d.platform) {
    case 'cisco_ios':
    case 'cisco_wlc':
      return [
        ...hdr,
        `${c}   show running-config | include ^logging|^service timestamps|^clock|^ntp`,
        `${c} Time: NTP, and a time stamp with milliseconds, the year and the zone,`,
        `${c} so the indexer never has to guess.`,
        ...(utc ? ['clock timezone UTC 0 0'] : [`${c} clock timezone ${tz} <offset>   (set to match the zone the TA expects)`]),
        `ntp server ${ntp}`,
        'service timestamps log datetime msec localtime show-timezone year',
        `${c} Identify the device by name, not by whichever interface the packet left from.`,
        'logging origin-id hostname',
        `${c} logging source-interface Loopback0   (uncomment with your management interface)`,
        'logging trap informational',
        // "!" is a comment only at the start of a line on IOS, NX-OS, ASA and EOS;
        // after a command it is part of the command, which is then rejected. Every
        // note in these device files is therefore a line of its own.
        // An IPv6 collector takes the ipv6 keyword: logging host ipv6 <address>.
        ...(transport === 'udp'
          ? [`logging host ${v6 ? 'ipv6 ' : ''}${target} transport udp port ${port}`]
          : transport === 'tls'
            ? [`${c} TLS needs a trustpoint and a TLS profile — VERIFY for your IOS-XE release.`, `logging host ${v6 ? 'ipv6 ' : ''}${target} transport tls port ${port}`]
            : [`logging host ${v6 ? 'ipv6 ' : ''}${target} transport tcp port ${port}`]),
        PLATFORMS[d.platform].save,
        `${c} Back out: no logging host ${v6 ? 'ipv6 ' : ''}${target}`,
      ];
    case 'cisco_nxos':
      return [
        ...hdr,
        `${c}   show running-config | include logging|clock|ntp`,
        ...(utc ? ['clock timezone UTC 0 0'] : [`${c} clock timezone ${tz} <hours> <minutes>`]),
        `ntp server ${ntp} use-vrf management`,
        'logging timestamp milliseconds',
        'logging origin-id hostname',
        `${c} NX-OS sends syslog over UDP, or over TLS with "secure"; there is no plain TCP. VERIFY on your release.`,
        ...(transport === 'tcp' ? [`${c} This sends UDP: TCP was chosen, and NX-OS has no plain TCP syslog.`] : []),
        transport === 'tls'
          ? `logging server ${target} 6 port ${port} secure use-vrf management`
          : `logging server ${target} 6 port ${port} use-vrf management`,
        'logging source-interface mgmt0',
        PLATFORMS[d.platform].save,
        `${c} Back out: no logging server ${target}`,
      ];
    case 'cisco_asa':
      return [
        ...hdr,
        `${c}   show running-config logging`,
        ...(utc ? ['clock timezone UTC 0'] : [`${c} clock timezone ${tz} <offset>`]),
        `ntp server ${ntp}`,
        'logging enable',
        `${c} RFC 5424 time stamps carry the year and the zone (ASA 9.10 and later).`,
        `${c} On older releases use "logging timestamp" and set TZ for these hosts.`,
        'logging timestamp rfc5424',
        'logging device-id hostname',
        'logging trap informational',
        `${c} permit-hostdown matters with TCP: without it, when the collector is`,
        `${c} unreachable the ASA stops passing new connections — the firewall fails`,
        `${c} closed because its logging did.`,
        'logging permit-hostdown',
        `${c} Replace "inside" with the name of the interface facing the collector.`,
        ...(v6 ? [`${c} VERIFY: an IPv6 syslog host on your ASA release, and IPv6 on that interface.`] : []),
        transport === 'udp'
          ? `logging host inside ${target} udp/${port}`
          : `logging host inside ${target} tcp/${port}${transport === 'tls' ? ' secure' : ''}`,
        PLATFORMS[d.platform].save,
        `${c} Back out: no logging host inside ${target}`,
      ];
    case 'arista_eos':
      return [
        ...hdr,
        `${c}   show running-config section logging`,
        `clock timezone ${utc ? 'UTC' : tz}`,
        `ntp server ${ntp}`,
        'logging format timestamp high-resolution',
        'logging format hostname fqdn',
        'logging trap informational',
        `${c} Add "vrf <MGMT>" after logging if the collector is reached through a management VRF.`,
        ...(transport === 'tls' ? [`${c} TLS needs an SSL profile: logging host … ssl-profile <name> — VERIFY.`] : []),
        `logging host ${target} ${port} protocol ${transport === 'udp' ? 'udp' : 'tcp'}`,
        PLATFORMS[d.platform].save,
        `${c} Back out: no logging host ${target}`,
      ];
    case 'panos':
      return [
        ...hdr,
        `${c}   show config running | match syslog`,
        `${c} Configure mode (or Panorama templates for managed firewalls). The add-on`,
        `${c} parses only the default log format — not custom, CEF or LEEF. VERIFY the`,
        `${c} exact set syntax on your PAN-OS release.`,
        'configure',
        `set deviceconfig system timezone ${utc ? 'UTC' : tz}`,
        `set deviceconfig system ntp-servers primary-ntp-server ntp-server-address ${ntp}`,
        `set shared log-settings syslog SPLUNK server splunk server ${target} transport ${transport === 'udp' ? 'UDP' : transport === 'tls' ? 'SSL' : 'TCP'} port ${port} format BSD facility LOG_USER`,
        `set shared log-settings system match-list all-system send-syslog SPLUNK filter "All Logs"`,
        `set shared log-settings config match-list all-config send-syslog SPLUNK filter "All Logs"`,
        `set shared log-settings profiles default match-list traffic log-type traffic filter "All Logs" send-syslog SPLUNK`,
        `set shared log-settings profiles default match-list threat log-type threat filter "All Logs" send-syslog SPLUNK`,
        `${c} Security rules only forward if their Log Forwarding profile is "default" (or names one that sends to SPLUNK).`,
        'commit',
        `${c} Back out: delete shared log-settings syslog SPLUNK (after removing the match-list references), commit`,
      ];
    case 'fortios':
      return [
        ...hdr,
        `${c}   show log syslogd setting`,
        'config system global',
        `${c} set timezone <index for ${tz}>   (FortiOS 7.x takes a zone name or index — VERIFY)`,
        'end',
        'config system ntp',
        '    set ntpsync enable',
        '    set type custom',
        '    config ntpserver',
        '        edit 1',
        `            set server "${ntp}"`,
        '        next',
        '    end',
        'end',
        ...(v6 ? [`${c} VERIFY: that "set server" takes an IPv6 address on your FortiOS release; if not, use a name with an AAAA record.`] : []),
        'config log syslogd setting',
        '    set status enable',
        `    set server "${target}"`,
        `${c} reliable = TCP (RFC 6587 framing); udp is the default`,
        `    set mode ${transport === 'udp' ? 'udp' : 'reliable'}`,
        ...(transport === 'tls' ? ['    set enc-algorithm high'] : []),
        `    set port ${port}`,
        '    set format default',
        'end',
        'config log syslogd filter',
        '    set forward-traffic enable',
        '    set local-traffic enable',
        '    set multicast-traffic disable',
        '    set sniffer-traffic disable',
        'end',
        `${c} Back out: config log syslogd setting / set status disable / end`,
      ];
    case 'f5':
      return [
        ...hdr,
        `${c}   tmsh list sys syslog`,
        `tmsh modify sys ntp servers replace-all-with { ${ntp} } timezone ${utc ? 'UTC' : tz}`,
        ...(transport === 'udp'
          ? [
              `${c} remote-servers is UDP only.`,
              ...(v6 ? [`${c} VERIFY: remote-servers takes an IPv6 host on your TMOS release.`] : []),
              `tmsh modify sys syslog remote-servers add { splunk { host ${target} remote-port ${port} } }`,
              `${c} Back out: tmsh modify sys syslog remote-servers delete { splunk }`,
            ]
          : [
              `${c} remote-servers sends UDP only; TCP goes through a syslog-ng include.`,
              `${c} VERIFY the include syntax on your TMOS release (K13080 and related articles).`,
              // syslog-ng connects over IPv6 only when told to: ip-protocol(6).
              `tmsh modify sys syslog include "destination d_splunk { tcp(\\"${target}\\" port(${port})${v6 ? ' ip-protocol(6)' : ''}); }; log { source(s_syslog_pipe); destination(d_splunk); };"`,
              `${c} Back out: tmsh modify sys syslog include none`,
            ]),
        'tmsh save sys config',
      ];
  }
}

// =============================================================================
// 3. VMware
// =============================================================================

                      
                        
                           
                           
                         
 

function estateHosts()                      {
  const inv = currentEstate()?.inventory;
  if (!inv) return null;
  return inv.hosts.map((h) => ({ name: h.name, vcenter: h.vcenter ?? '', cluster: h.cluster ?? '', state: (h.connectionState ?? 'connected').toLowerCase() }));
}

function estateVcenters()                  {
  const inv = currentEstate()?.inventory;
  if (!inv) return null;
  return [...new Set([...(inv.vcenters ?? []).map((v) => v.name), ...inv.hosts.map((h) => h.vcenter ?? '')].map((v) => v.trim()).filter(Boolean))].sort();
}

/** Short host name, lower case: ESXi sends its short name or its FQDN depending on how it was installed. */
function shortName(name        )         {
  return name.toLowerCase().split('.')[0] ?? name.toLowerCase();
}

// =============================================================================
// 4. The estate's VMs
// =============================================================================

                                                                                                                                                                

const CLASS_LABEL                                    = {
  windows_server: 'Windows servers',
  windows_dc: 'Windows domain controllers',
  windows_workstation: 'Windows workstations / VDI',
  linux_rhel: 'Linux — RHEL family (RHEL, CentOS, Rocky, Alma, Oracle)',
  linux_debian: 'Linux — Debian family (Debian, Ubuntu)',
  linux_suse: 'Linux — SUSE',
  linux_other: 'Linux — other',
  appliance: 'Appliances and other (no forwarder)',
  unknown: 'Unknown OS',
};

function classify(os        , name        , dcPattern               )          {
  const o = os.toLowerCase();
  if (!o.trim() || /^other\b|other \(3|other \(6/.test(o)) return 'unknown';
  if (/windows/.test(o)) {
    if (/server/.test(o)) return dcPattern && dcPattern.test(name) ? 'windows_dc' : 'windows_server';
    return 'windows_workstation';
  }
  // Photon is what VMware appliances run (vCenter, NSX, VCF Operations): a
  // forwarder on an appliance is unsupported and is gone at the next upgrade.
  if (/photon|appliance|freebsd|solaris|esx|netscaler|vyos/.test(o)) return 'appliance';
  if (/red hat|rhel|centos|rocky|alma|oracle linux/.test(o)) return 'linux_rhel';
  if (/ubuntu|debian/.test(o)) return 'linux_debian';
  if (/suse|sles/.test(o)) return 'linux_suse';
  if (/linux|fedora|amazon/.test(o)) return 'linux_other';
  return 'unknown';
}

// =============================================================================
// The blueprints
// =============================================================================

export const ADDON_BLUEPRINTS                             = [
  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_ta_custom',
    tier: TIER,
    label: 'Custom add-on (TA) mapped to the CIM',
    group: 'Add-ons',
    description:
      'A complete technology add-on for a source Splunkbase has nothing for: line breaking and timestamps for the indexers, EVENT_BREAKER for the forwarders, extractions, aliases and evals for the search heads, and the event types and tags that put it in a CIM data model — with a local parsing test against sample events and searches that measure how much of each required CIM field is populated.',
    inputs: [
      { id: 'app_name', label: 'Add-on name', control: 'text', default: 'TA-acme-widget', hint: 'TA-<vendor>-<product> by convention' },
      { id: 'vendor', label: 'Vendor', control: 'text', default: 'Acme' },
      { id: 'product', label: 'Product', control: 'text', default: 'Widget' },
      { id: 'sourcetype', label: 'Sourcetype', control: 'text', default: 'acme:widget:auth', hint: 'vendor:product:type — lower case' },
      { id: 'index', label: 'Index', control: 'text', default: 'acme' },
      { id: 'format', label: 'Event format', control: 'select', default: 'kv', options: [
        { value: 'kv', label: 'key=value pairs' },
        { value: 'json', label: 'JSON, one object per event' },
        { value: 'regex', label: 'Free text — extracted by regular expression' },
      ] },
      { id: 'line_breaker', label: 'LINE_BREAKER', control: 'text', default: '([\\r\\n]+)(?=\\d{4}-\\d{2}-\\d{2}T)', hint: 'The first capture group is the boundary and is discarded' },
      { id: 'linemerge', label: 'SHOULD_LINEMERGE', control: 'toggle', default: false, hint: 'Leave off: LINE_BREAKER alone is faster and predictable' },
      { id: 'time_prefix', label: 'TIME_PREFIX', control: 'text', default: '^', hint: 'Regex for what comes just before the timestamp' },
      { id: 'time_format', label: 'TIME_FORMAT', control: 'text', default: '%Y-%m-%dT%H:%M:%S.%3N%z', hint: 'strptime, with %3N/%6N for sub-seconds' },
      { id: 'lookahead', label: 'MAX_TIMESTAMP_LOOKAHEAD', control: 'number', default: 30, min: 1, max: 4096, hint: 'Characters after TIME_PREFIX' },
      { id: 'tz', label: 'TZ', control: 'text', default: '', placeholder: 'Europe/London', hint: 'Only when the timestamp has no zone of its own' },
      { id: 'truncate', label: 'TRUNCATE (bytes)', control: 'number', default: 10000, min: 0, max: 1000000 },
      { id: 'indexed_extractions', label: 'INDEXED_EXTRACTIONS = json', control: 'toggle', default: false, hint: 'Index-time JSON fields, parsed on the forwarder that reads the file', showWhen: { input: 'format', equals: ['json'] } },
      { id: 'kv_mode', label: 'KV_MODE', control: 'select', default: 'format', options: [
        { value: 'format', label: 'What the format needs' },
        { value: 'json', label: 'json' },
        { value: 'auto', label: 'auto' },
        { value: 'none', label: 'none' },
      ] },
      { id: 'extract_regex', label: 'EXTRACT regex', control: 'text', default: '^\\S+\\s+node=(?<dvc>\\S+)', hint: 'Named groups become fields; for free text this is the main extraction' },
      { id: 'drop_regex', label: 'Drop events matching', control: 'text', default: '', placeholder: 'level=DEBUG', hint: 'Sent to nullQueue at index time — never licensed' },
      { id: 'cim_model', label: 'CIM data model', control: 'select', default: 'Authentication', options: CIM_MODELS.map((m) => ({ value: m.id, label: m.label })) },
      ...CIM_DATASET_INPUTS,
      {
        id: 'field_map',
        label: 'Field mapping to the CIM',
        control: 'textarea',
        default: 'usr -> user\nclient_ip -> src\nserver -> dest\naction = case(result=="ok", "success", result=="fail", "failure", true(), "error")\napp = "acme:widget"\nsignature = "Widget login ".result',
        hint: 'vendor_field -> cim_field (alias), or cim_field = eval expression; one per line',
      },
      { id: 'native_fields', label: 'Fields already named as the CIM names them', control: 'text', default: 'reason', hint: 'Comma separated — counted as mapped' },
      { id: 'lookup', label: 'Lookup for event descriptions', control: 'toggle', default: true },
      { id: 'lookup_key', label: 'Lookup key field', control: 'text', default: 'event_id', showWhen: { input: 'lookup', equals: ['true'] } },
      { id: 'input_path', label: 'Monitor path (inputs.conf)', control: 'text', default: '/var/log/acme/widget.log' },
      {
        id: 'sample',
        label: 'Sample events',
        control: 'textarea',
        default:
          '2026-09-23T10:15:02.123+0000 node=widget01 event_id=4001 result=ok usr=alice client_ip=10.1.20.15 server=widget01.example.com method=password\n2026-09-23T10:15:09.871+0000 node=widget01 event_id=4002 result=fail usr=bob client_ip=10.1.20.99 server=widget01.example.com method=password reason="bad password"',
        hint: 'Raw, as the source writes them — ops/test_parsing.py runs the settings against these',
      },
    ],
    app: (values                 )            => {
      const app = appId(str(values, 'app_name', 'TA-acme-widget'), 'TA-custom');
      const vendor = str(values, 'vendor', 'Acme');
      const product = str(values, 'product', 'Widget');
      const st = sourcetypeOf(str(values, 'sourcetype', 'acme:widget:auth'), 'custom:log');
      const stName = splunkName(st, 'custom');
      const index = indexName(str(values, 'index', 'acme'), 'main');
      const format = str(values, 'format', 'kv');
      const lineBreaker = str(values, 'line_breaker', '([\\r\\n]+)');
      const linemerge = bool(values, 'linemerge', false);
      const timePrefix = str(values, 'time_prefix', '');
      const timeFormat = str(values, 'time_format', '');
      const lookahead = Math.max(1, Math.round(num(values, 'lookahead', 30)));
      const tz = str(values, 'tz', '');
      const truncate = Math.max(0, Math.round(num(values, 'truncate', 10000)));
      const indexed = format === 'json' && bool(values, 'indexed_extractions', false);
      const kvChoice = str(values, 'kv_mode', 'format');
      const kvMode = kvChoice === 'format' ? (format === 'json' ? (indexed ? 'none' : 'json') : 'none') : kvChoice;
      const extractRegex = str(values, 'extract_regex', '');
      const dropRegex = str(values, 'drop_regex', '');
      const model = CIM_MODELS.find((m) => m.id === str(values, 'cim_model', 'Authentication')) ?? CIM_MODELS[0] ;
      const dataset = model.datasets ? (model.datasets.options.find((o) => o.value === str(values, model.datasets .input, model.datasets .options[0] .value)) ?? model.datasets.options[0] ) : null;
      const tags = [...model.tags, ...(dataset?.tags ?? [])];
      const required = [...new Set([...model.required, ...(dataset?.required ?? [])])];
      const recommended = [...new Set([...model.recommended, ...(dataset?.recommended ?? [])])].filter((f) => !required.includes(f));
      const lookup = bool(values, 'lookup', true);
      const lookupKey = splunkName(str(values, 'lookup_key', 'event_id'), 'event_id');
      const inputPath = str(values, 'input_path', '/var/log/custom.log');
      const sample = String(values['sample'] ?? '').replace(/\r\n/g, '\n');
      const findings            = [];

      // --- the mapping --------------------------------------------------------
      const aliases                                 = [];
      const evals                                 = [];
      for (const line of linesOf(str(values, 'field_map', ''))) {
        const alias = /^([A-Za-z_][\w.:-]*)\s*->\s*([A-Za-z_]\w*)$/.exec(line);
        const ev = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(line);
        if (alias) aliases.push({ from: alias[1] , to: alias[2]  });
        else if (ev) evals.push({ to: ev[1] , expr: ev[2] .trim() });
        else findings.push(warning('splunk.ta-map-unparsed', `This mapping line was not understood and is left out: "${line}". Use "vendor_field -> cim_field" or "cim_field = <eval expression>".`, { source: SRC }));
      }
      const extracted = [...extractRegex.matchAll(/\(\?P?<([A-Za-z_]\w*)>/g)].map((m) => m[1] );
      const native = str(values, 'native_fields', '').split(/[,\s]+/).filter(Boolean);
      const covered = new Set([...aliases.map((a) => a.to), ...evals.map((e) => e.to), ...extracted, ...native, 'vendor', 'product', 'vendor_product', ...(lookup ? ['description'] : [])]);
      const missing = required.filter((f) => !covered.has(f));
      const missingRec = recommended.filter((f) => !covered.has(f));
      const modelLabel = `${model.label}${dataset && dataset.tags.length > 0 ? ` / ${dataset.label}` : ''}`;

      // --- findings -----------------------------------------------------------
      if (missing.length > 0) {
        findings.push(
          warning('splunk.ta-cim-missing-required', `The mapping leaves ${missing.length} field${missing.length === 1 ? '' : 's'} the ${modelLabel} data model requires unpopulated: ${missing.join(', ')}. The events will be tagged into the model, and every search that reads ${missing.length === 1 ? 'that field' : 'those fields'} will see "unknown" or nothing.`, {
            remediation: 'Map each one from a vendor field (->), compute it with an EVAL (=), or list it as native if the source already uses that name. Where the source genuinely has no such value, an EVAL to a constant ("unknown", the device name) is better than leaving it out — the coverage search then says so honestly.',
            source: 'Splunk CIM reference (pytest-splunk-addon required fields)',
          }),
        );
      }
      if (missingRec.length > 0) {
        findings.push(info('splunk.ta-cim-missing-recommended', `Recommended ${modelLabel} fields not mapped: ${missingRec.join(', ')}.`, { source: 'Splunk CIM reference' }));
      }
      if (linemerge) {
        findings.push(
          warning('splunk.ta-linemerge', 'SHOULD_LINEMERGE = true makes the indexer break the stream into lines and then re-merge them with a second set of rules (BREAK_ONLY_BEFORE, MUST_BREAK_AFTER and the timestamp heuristics). It is the single most expensive thing in the parsing pipeline, and the merged events it produces are harder to predict than the ones a LINE_BREAKER that matches the real event boundary would.', {
            remediation: 'Set SHOULD_LINEMERGE = false and write a LINE_BREAKER whose capture group matches the newline(s) before each new event, with a lookahead for what an event starts with.',
            source: 'Splunk Getting Data In: configure event line breaking',
          }),
        );
      }
      if (!timeFormat) {
        findings.push(
          warning('splunk.ta-no-time-format', 'No TIME_FORMAT: the indexer tries every pattern in datetime.xml against each event. That is slow, and on a source with more than one date-like string in it, it is also wrong some of the time — silently, by picking the other one.', {
            remediation: 'Give TIME_PREFIX, TIME_FORMAT and MAX_TIMESTAMP_LOOKAHEAD together, and prove them with ops/test_parsing.py.',
            source: SRC,
          }),
        );
      } else if (!/%z|%Z|%::?z|%s/.test(timeFormat) && !tz) {
        findings.push(info('splunk.ta-no-zone', 'The timestamp has no zone and TZ is not set, so each indexer (or heavy forwarder) interprets it in its own system time zone. That is right only if every parsing node and the source agree.', { source: SRC }));
      }
      if (indexed && kvMode === 'json') {
        findings.push(
          error('splunk.ta-double-json', 'INDEXED_EXTRACTIONS = json with KV_MODE = json extracts every field twice: once at index time and again at search time. Every field becomes a two-value field with the same value in it, and stats count by it double counts.', {
            remediation: 'With INDEXED_EXTRACTIONS keep KV_MODE = none and AUTO_KV_JSON = false on the search heads; or drop INDEXED_EXTRACTIONS and let KV_MODE = json do it at search time, which is usually the better choice.',
            source: 'Splunk props.conf reference',
          }),
        );
      }
      if (format === 'json' && kvMode !== 'json' && !indexed) {
        findings.push(warning('splunk.ta-json-no-kv', 'JSON events with neither KV_MODE = json nor INDEXED_EXTRACTIONS: no JSON field will be extracted.', { source: SRC }));
      }
      if (format === 'regex' && extracted.length === 0) {
        findings.push(warning('splunk.ta-regex-no-groups', 'Free-text format with an EXTRACT regex that has no named groups: nothing will be extracted.', { source: SRC }));
      }
      if (!/\([^?]/.test(lineBreaker)) {
        findings.push(error('splunk.ta-line-breaker-group', 'LINE_BREAKER must contain a capturing group: the text it captures is the boundary between events, and without one Splunk ignores the setting.', { source: 'Splunk props.conf reference' }));
      }
      if (truncate === 0) {
        findings.push(warning('splunk.ta-truncate-0', 'TRUNCATE = 0 means no limit: one runaway event (a stack trace with no newline, a binary blob) can take the whole parsing pipeline on that indexer with it.', { source: SRC }));
      }
      if (!sample.trim()) {
        findings.push(info('splunk.ta-no-sample', 'No sample events: ops/test_parsing.py has nothing to test the line breaking and timestamps against. Paste a few real events, including the longest and oddest one you can find.', { source: SRC }));
      }

      // --- props --------------------------------------------------------------
      const lookupName = `${stName}_descriptions`;
      const reportLines =
        format === 'kv'
          ? [
              '# key=value through two transforms rather than KV_MODE = auto, so the',
              '# rules are explicit: quoted values first (they may contain spaces),',
              '# then bare ones. Both repeat across the event because the key comes',
              '# from the match ($1::$2).',
              `REPORT-kv = ${stName}_kv_quoted, ${stName}_kv_plain`,
            ]
          : [];
      const tzLine = tz ? ['# The source writes local time with no zone; this is the zone it writes.', `TZ = ${tz}`] : [];

      const props           = [
        `# ${vendor} ${product} — one stanza, read by every tier for the part it owns.`,
        '',
        `[${st}]`,
        '# --- Index time: the indexers, or the heavy forwarder that parses ------',
        '# These apply only to data indexed after they are in place.',
        '',
        '# Break on LINE_BREAKER alone. Line merging is the most expensive stage',
        '# of the pipeline and the least predictable one.',
        `SHOULD_LINEMERGE = ${linemerge ? 'true' : 'false'}`,
        '# The first capture group is the boundary between events and is thrown',
        '# away; the lookahead says what the next event starts with.',
        `LINE_BREAKER = ${lineBreaker}`,
        ...(timePrefix ? ['# Where the timestamp starts: a regex for what precedes it.', `TIME_PREFIX = ${timePrefix}`] : ['# No TIME_PREFIX: the timestamp search starts at the beginning of the event.']),
        ...(timeFormat ? ['# Exactly how it is written. Without this Splunk guesses per event.', `TIME_FORMAT = ${timeFormat}`] : ['# No TIME_FORMAT — see the finding. Splunk will guess from datetime.xml.']),
        '# How far past TIME_PREFIX to look. Just longer than the timestamp, so a',
        '# date-like string later in the event is never mistaken for it.',
        `MAX_TIMESTAMP_LOOKAHEAD = ${lookahead}`,
        ...tzLine,
        '# Longest event allowed, in bytes; anything longer is cut, and the cut',
        '# is logged by LineBreakingProcessor in _internal.',
        `TRUNCATE = ${truncate}`,
        'CHARSET = UTF-8',
        ...(dropRegex ? ['# Events matching the drop regex go to the nullQueue: never indexed, never licensed.', `TRANSFORMS-drop = ${stName}_drop`] : []),
        ...(indexed
          ? [
              '# Structured parsing happens on the forwarder that reads the file — a',
              '# universal forwarder included — not on the indexer. With it, the',
              '# indexers do not re-parse the data, and TIMESTAMP_FIELDS names the',
              '# JSON field that holds the time. VERIFY the field name.',
              'INDEXED_EXTRACTIONS = json',
              'TIMESTAMP_FIELDS = timestamp',
            ]
          : []),
        '',
        '# --- Universal forwarder -------------------------------------------------',
        '# A UF does not parse, but with EVENT_BREAKER it knows where events end,',
        '# so it can switch indexers between events instead of waiting for the',
        '# file to go quiet — without it one busy file sticks to one indexer.',
        'EVENT_BREAKER_ENABLE = true',
        `EVENT_BREAKER = ${lineBreaker}`,
        '',
        '# --- Search time: the search heads -----------------------------------------',
        '# Order of operations: EXTRACT, REPORT, KV_MODE, FIELDALIAS, EVAL, LOOKUP.',
        '# So an EVAL can read an alias, and a LOOKUP can read an EVAL — but one',
        '# EVAL cannot read another EVAL, because they all run at once.',
        ...(kvMode === 'json' ? ['# JSON fields at search time; nested keys come out as a.b.c.'] : []),
        ...(indexed ? ['# With INDEXED_EXTRACTIONS the fields already exist; do not extract them again.', 'AUTO_KV_JSON = false'] : []),
        `KV_MODE = ${kvMode}`,
        ...(extractRegex ? ['# Named groups become fields. Inline, so it is visible here.', `EXTRACT-${stName} = ${extractRegex}`] : []),
        ...reportLines,
        ...(aliases.length > 0
          ? [
              '# Vendor names to CIM names. Aliases keep the original field too, and',
              '# since 7.2 an alias overwrites a field of the same name that already',
              '# exists; use ASNEW where the CIM name might already be present.',
              `FIELDALIAS-cim = ${aliases.map((a) => `${/^\w+$/.test(a.from) ? a.from : `"${a.from}"`} AS ${a.to}`).join(' ')}`,
            ]
          : []),
        '# Vendor and product: what CIM-based apps group sources by.',
        `EVAL-vendor = "${vendor.replace(/"/g, '')}"`,
        `EVAL-product = "${product.replace(/"/g, '')}"`,
        `EVAL-vendor_product = "${`${vendor} ${product}`.replace(/"/g, '')}"`,
        ...evals.flatMap((e) => [`EVAL-${e.to} = ${e.expr}`]),
        ...(lookup
          ? ['# Descriptions for event codes, from lookups/' + lookupName + '.csv.', `LOOKUP-descriptions = ${lookupName} ${lookupKey} OUTPUTNEW description`]
          : []),
      ];

      const transforms           = [
        ...(format === 'kv'
          ? [
              `[${stName}_kv_quoted]`,
              'REGEX = ([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"',
              'FORMAT = $1::$2',
              '',
              `[${stName}_kv_plain]`,
              '# A value that does not start with a quote, up to the next space.',
              'REGEX = ([A-Za-z_][A-Za-z0-9_]*)=([^"\\s]\\S*)',
              'FORMAT = $1::$2',
              '',
            ]
          : []),
        ...(dropRegex
          ? [
              `[${stName}_drop]`,
              '# Index time: on the indexers or the parsing heavy forwarder.',
              `REGEX = ${dropRegex}`,
              'DEST_KEY = queue',
              'FORMAT = nullQueue',
              '',
            ]
          : []),
        ...(lookup
          ? [
              `[${lookupName}]`,
              `filename = ${lookupName}.csv`,
              'case_sensitive_match = false',
              'max_matches = 1',
              '',
            ]
          : []),
      ];

      const eventtype = `${stName}_${splunkName(model.id, 'cim')}${dataset && dataset.tags.length > 0 ? `_${dataset.value}` : ''}`;
      const nodeName = dataset?.node;
      const dm = `${model.model}.${model.root}`;
      const where = `${nodeName ? `nodename=${nodeName} ` : ''}sourcetype=${splQuote(st)}`;
      const covSearchName = `${app} - CIM field coverage`;
      const dmSearchName = `${app} - events in the ${model.model} data model`;
      const coverage = [
        `index=${index} sourcetype=${splQuote(st)} earliest=-4h`,
        `| stats count as events, ${required.map((f) => `count(${f}) as ${f}`).join(', ') || 'count(dest) as dest'}`,
        `| foreach ${(required.length > 0 ? required : ['dest']).join(' ')} [ eval <<FIELD>> = round('<<FIELD>>' / events * 100, 1) ]`,
        '| transpose column_name=field',
        '| rename "row 1" as pct_populated',
        '| where field!="events"',
        '| sort pct_populated',
      ];
      const inModel = [`| tstats summariesonly=false count from datamodel=${dm} where ${where} earliest=-4h by sourcetype`];

      const testScript           = [
        '#!/usr/bin/env python3',
        '"""Apply this add-on\'s line breaking and timestamp settings to ops/sample.log.',
        '',
        'Splunk tells you a LINE_BREAKER or TIME_FORMAT is wrong only by producing',
        'wrong events, after they are indexed, where they stay wrong. This runs the',
        'same regexes over the sample first and prints each event and the time it',
        'would get. Python re is close to PCRE for these, not identical: a pattern',
        'that passes here is very likely right, and one that fails is certainly',
        'wrong. The final check is still a test index (see DEPLOY.md).',
        '',
        'Usage: python3 test_parsing.py [sample file]',
        '"""',
        'import datetime',
        'import pathlib',
        'import re',
        'import sys',
        '',
        `LINE_BREAKER = ${py(lineBreaker)}`,
        `TIME_PREFIX = ${py(timePrefix)}`,
        `TIME_FORMAT = ${py(timeFormat)}`,
        `LOOKAHEAD = ${lookahead}`,
        `TRUNCATE = ${truncate}`,
        `EXTRACT = ${py(extractRegex)}`,
        `SHOULD_LINEMERGE = ${linemerge ? 'True' : 'False'}`,
        '',
        '',
        'def pcre(rx):',
        '    # PCRE named groups (?<name>...) are (?P<name>...) in Python.',
        "    return re.sub(r'\\(\\?<(?=[A-Za-z_])', '(?P<', rx)",
        '',
        '',
        'def strptime_format(fmt):',
        '    # Splunk sub-second tokens; Python %f takes 1 to 6 digits.',
        "    for token in ('%9N', '%6N', '%3N', '%N'):",
        "        fmt = fmt.replace(token, '%f')",
        '    return fmt',
        '',
        '',
        'def break_events(data):',
        '    rx = re.compile(pcre(LINE_BREAKER))',
        '    if rx.groups < 1:',
        '        sys.exit("LINE_BREAKER has no capture group; Splunk would ignore it.")',
        '    events, start = [], 0',
        '    for m in rx.finditer(data):',
        '        if m.start(1) < start or m.end(1) == m.start(1):',
        '            continue',
        '        if m.start(1) > start:',
        '            events.append(data[start:m.start(1)])',
        '        start = m.end(1)',
        '    if start < len(data):',
        '        events.append(data[start:])',
        '    return [e for e in events if e.strip()]',
        '',
        '',
        'def find_time(event):',
        '    text = event',
        '    if TIME_PREFIX:',
        '        m = re.search(pcre(TIME_PREFIX), event)',
        '        if not m:',
        '            return None, "TIME_PREFIX did not match"',
        '        text = event[m.end():]',
        '    text = text[:LOOKAHEAD]',
        '    if not TIME_FORMAT:',
        '        return None, "no TIME_FORMAT: Splunk would guess"',
        "    if TIME_FORMAT.startswith('%s'):",
        "        m = re.match(r'\\d{9,10}(\\.\\d+)?', text)",
        '        if m:',
        '            return datetime.datetime.fromtimestamp(float(m.group(0)), datetime.timezone.utc), None',
        '        return None, "no epoch seconds after TIME_PREFIX"',
        '    fmt = strptime_format(TIME_FORMAT)',
        '    for end in range(len(text), 0, -1):',
        '        try:',
        '            return datetime.datetime.strptime(text[:end], fmt), None',
        '        except ValueError:',
        '            continue',
        '    return None, "nothing matching %r in the %d characters after TIME_PREFIX" % (TIME_FORMAT, LOOKAHEAD)',
        '',
        '',
        'def main():',
        "    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent / 'sample.log'",
        "    data = path.read_text(encoding='utf-8')",
        '    # The generated app starts every file with a comment banner; skip it.',
        "    if data.startswith('# ') and '\\n\\n' in data[:2000]:",
        "        data = data.split('\\n\\n', 1)[1]",
        '    if SHOULD_LINEMERGE:',
        '        print("SHOULD_LINEMERGE is true: Splunk would re-merge lines after this; the result below is only the LINE_BREAKER stage.")',
        '    events = break_events(data)',
        '    extract = re.compile(pcre(EXTRACT)) if EXTRACT else None',
        '    failures = 0',
        '    print("%d event(s) from %s" % (len(events), path))',
        '    for n, event in enumerate(events, 1):',
        '        when, why = find_time(event)',
        "        size = len(event.encode('utf-8'))",
        "        first = event.splitlines()[0] if event.splitlines() else ''",
        '        print("--- event %d, %d bytes, %d line(s)" % (n, size, len(event.splitlines())))',
        '        print("    " + (first[:160] + ("..." if len(first) > 160 else "")))',
        '        if when:',
        '            print("    time:  " + when.isoformat())',
        '        else:',
        '            failures += 1',
        '            print("    time:  FAILED - " + why)',
        '        if TRUNCATE and size > TRUNCATE:',
        '            failures += 1',
        '            print("    TRUNCATE: event is longer than %d bytes and would be cut" % TRUNCATE)',
        '        if extract:',
        '            m = extract.search(event)',
        '            print("    EXTRACT: " + (str(m.groupdict()) if m else "no match"))',
        '    if not events:',
        '        failures += 1',
        '        print("No events: the sample is empty or LINE_BREAKER consumed everything.")',
        '    print("OK" if failures == 0 else "%d problem(s)" % failures)',
        '    return 1 if failures else 0',
        '',
        '',
        "if __name__ == '__main__':",
        '    sys.exit(main())',
      ];

      const readme = [
        `CIM mapping for ${st}: ${modelLabel}`,
        '',
        `Tags applied (through eventtype ${eventtype}): ${tags.join(', ')}`,
        '',
        'Field                          Required  Mapped by',
        ...[...required.map((f) => ({ f, r: 'yes' })), ...recommended.map((f) => ({ f, r: 'no' }))].map(({ f, r }) => {
          const how = aliases.find((a) => a.to === f)
            ? `alias of ${aliases.find((a) => a.to === f) .from}`
            : evals.find((e) => e.to === f)
              ? 'EVAL'
              : extracted.includes(f)
                ? 'EXTRACT'
                : native.includes(f)
                  ? 'native'
                  : ['vendor', 'product', 'vendor_product'].includes(f)
                    ? 'EVAL (vendor/product)'
                    : '-- NOT MAPPED --';
          return `${f.padEnd(31)}${r.padEnd(10)}${how}`;
        }),
        '',
        ...(model.note ? [`Note: ${model.note}`, ''] : []),
        'Required = required by pytest-splunk-addon for this dataset in the CIM 6.x',
        'reference. VERIFY against the CIM version installed on your search heads',
        '(| rest /services/apps/local/Splunk_SA_CIM | table version).',
      ];

      return {
        tier: TIER,
        title: `${vendor} ${product} add-on: ${st} into ${index}, mapped to ${modelLabel}`,
        app,
        activation: 'bundle',
        notes: [
          'One copy of this add-on goes to every tier: the search heads (deployer), the indexers (cluster manager), any heavy forwarder that parses this data, and the forwarders that collect it (deployment server). Each tier uses its part and ignores the rest.',
          `Index-time settings — LINE_BREAKER, TIME_*, TRUNCATE${dropRegex ? ', the nullQueue transform' : ''} — take effect on whichever node parses the data first: the indexers, or a heavy forwarder in front of them. They do not apply to data indexed before they were deployed.`,
          `inputs.conf ships with the input enabled: every node that receives this add-on and has the file reads it. On search heads and indexers that do not have the file it reads nothing; to keep them from ever reading it, set disabled = 1 in their local/inputs.conf.`,
          `Run python3 ops/test_parsing.py before deploying: it applies the line breaking and timestamp settings to ops/sample.log (the sample events from the form) and prints each event and the time it would get.`,
          `Then index the sample into a test index with the add-on in place (Settings > Add data > Upload, sourcetype ${st}) and run the coverage search. ops/CIM_MAPPING.txt lists every field the model needs and what maps it.`,
          `The index (${index}) is not created here; create it on the indexers first (the splunk_index blueprint).`,
          'Splunk Cloud: package this as a private app (splunk-appinspect, then ACS app install). App vetting rejects scripts outside bin/, so leave ops/ out of the package you upload.',
        ],
        before: [
          'python3 ops/test_parsing.py   # every event breaks where it should and gets the right time',
          `| rest /services/data/indexes | search title=${index} | table title, splunk_server`,
          `$SPLUNK_HOME/bin/splunk btool props list ${st} --debug   # on an indexer: nothing else already defines this sourcetype`,
          `| rest /services/apps/local/Splunk_SA_CIM | table title, version   # CIM add-on present on the search heads`,
          `index=${index} sourcetype=${splQuote(st)} earliest=-24h | head 1   # nothing indexed under this name yet — or plan for the old events keeping old parsing`,
        ],
        files: {
          'default/app.conf': appConfLines(app, `${vendor} ${product} add-on`, `Parsing, extraction and CIM mapping for ${st}`),
          'default/props.conf': props,
          ...(transforms.length > 0 ? { 'default/transforms.conf': transforms } : {}),
          'default/eventtypes.conf': [
            `# One event type for ${st}, which the tags hang off. No index in the`,
            '# search: event types are applied to whatever the user searched, and',
            '# naming an index here would stop the tags working if the data moves.',
            `[${eventtype}]`,
            `search = sourcetype=${splQuote(st)}`,
            `description = ${vendor} ${product} events for the ${modelLabel} data model`,
            'priority = 5',
          ],
          'default/tags.conf': [
            `# The tags the ${modelLabel} dataset's constraint requires. An event with`,
            '# every field mapped but one tag missing is simply not in the data model.',
            `[eventtype=${eventtype}]`,
            ...tags.map((t) => `${t} = enabled`),
          ],
          'default/inputs.conf': [
            '# Enabled: every node with this add-on that has the file reads it.',
            '# Set disabled = 1 in local/inputs.conf on nodes that must not.',
            `[monitor://${inputPath}]`,
            'disabled = 0',
            `index = ${index}`,
            `sourcetype = ${st}`,
            '# Rotated copies are the same data again.',
            'blacklist = (\\.\\d+$|\\.gz$|\\.bz2$|-\\d{8}$)',
          ],
          'default/savedsearches.conf': [
            '# Reports, not alerts: run them after deployment and after any change',
            '# to the mapping.',
            `[${covSearchName}]`,
            `description = Percentage of ${st} events in the last 4 hours with each field the ${modelLabel} data model requires. Anything under 100 is a gap in the mapping or in the data.`,
            ...foldSearch(coverage),
            'dispatch.earliest_time = -4h',
            'dispatch.latest_time = now',
            'enableSched = 0',
            '',
            `[${dmSearchName}]`,
            `description = Whether ${st} events actually land in ${dm}${nodeName ? ` (${nodeName})` : ''} — the tags and the event type working, not just the fields.`,
            ...foldSearch(inModel),
            'dispatch.earliest_time = -4h',
            'dispatch.latest_time = now',
            'enableSched = 0',
          ],
          ...(lookup
            ? {
                [`lookups/${lookupName}.csv`]: [`${lookupKey},description`, '4001,Successful login', '4002,Failed login', '4003,Account locked'],
              }
            : {}),
          'metadata/default.meta': defaultMeta(),
          'ops/sample.log': sample ? sample.split('\n') : ['# paste sample events here'],
          'ops/test_parsing.py': testScript,
          'ops/CIM_MAPPING.txt': readme,
        },
        verify: [
          `index=${index} sourcetype=${splQuote(st)} earliest=-15m | eval lag_s=_indextime-_time | stats count, avg(lag_s) as avg_lag_s, max(lag_s) as max_lag_s, max(linecount) as max_lines`,
          `index=_internal sourcetype=splunkd (component=DateParserVerbose OR component=LineBreakingProcessor OR component=AggregatorMiningProcessor) log_level=WARN data_sourcetype=${splQuote(st)} earliest=-1h | stats count by component, log_level`,
          `| savedsearch "${covSearchName}"`,
          `| savedsearch "${dmSearchName}"`,
          `index=${index} sourcetype=${splQuote(st)} earliest=-1h | stats count by eventtype, tag`,
          `$SPLUNK_HOME/bin/splunk btool props list ${st} --debug   # on a search head and an indexer: this app wins`,
        ],
        backout: [
          `Remove ${app} from the deployer (splunk apply shcluster-bundle), the cluster manager (splunk apply cluster-bundle) and deployment-apps (splunk reload deploy-server)`,
          '# Events already indexed keep the parsing they got; search-time fields and tags disappear with the app.',
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_network',
    tier: TIER,
    label: 'Onboard network devices',
    group: 'Onboard what you built',
    description:
      'The network devices from the Network page into Splunk: per platform the official add-on and sourcetype, SC4S or heavy-forwarder collection, the exact lines each device needs to send syslog with a zone-qualified timestamp, and searches and an alert for any device that stops reporting.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_network_onboarding' },
      {
        id: 'devices',
        label: 'Devices',
        control: 'textarea',
        default: 'core-sw01, 10.0.0.11, cisco_ios\ndc-leaf01, 10.0.0.21, cisco_nxos\nwlc01, 10.0.0.31, cisco_wlc\nedge-fw01, 10.0.1.1, cisco_asa\ndc-fw01, 10.0.1.11, panos\nbr-fw01, 10.0.1.21, fortios\nlb01, 10.0.2.11, f5\nspine01, 10.0.0.41, arista_eos',
        hint: `hostname, ip, platform — one per line. Platforms: ${Object.keys(PLATFORMS).join(', ')}`,
      },
      { id: 'collector', label: 'Collected by', control: 'select', default: 'sc4s', options: [
        { value: 'sc4s', label: 'Splunk Connect for Syslog (SC4S)' },
        { value: 'hf', label: 'Heavy forwarder, a port per sourcetype' },
      ] },
      { id: 'collector_ip', label: 'Collector address', control: 'text', default: '10.0.5.10', hint: 'What the devices send to, IPv4 or IPv6 — a VIP if there are several' },
      { id: 'transport', label: 'Transport', control: 'select', default: 'tcp', options: [
        { value: 'tcp', label: 'TCP' },
        { value: 'tls', label: 'TLS' },
        { value: 'udp', label: 'UDP' },
      ] },
      LISTEN_INPUT,
      { id: 'netops_index', label: 'Network operations index', control: 'text', default: 'netops' },
      { id: 'netfw_index', label: 'Firewall index', control: 'text', default: 'netfw' },
      { id: 'ntp', label: 'NTP server', control: 'text', default: '10.0.0.1' },
      { id: 'tz', label: 'Device clock time zone', control: 'text', default: 'UTC', hint: 'UTC everywhere is the answer that never needs fixing' },
      { id: 'silent_minutes', label: 'Alert when a device is silent for (minutes)', control: 'number', default: 60, min: 5, max: 10080 },
      { id: 'alert_email', label: 'Alert email', control: 'text', default: '', placeholder: 'netops@example.com' },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_network_onboarding'), 'org_network_onboarding');
      const devices = parseDevices(str(values, 'devices', ''));
      const known = devices.filter((d)                                       => d.platform !== null);
      const unknown = devices.filter((d) => d.platform === null);
      const collector = str(values, 'collector', 'sc4s');
      const target = hostAddress(str(values, 'collector_ip', '')) || '<collector>';
      const transport = str(values, 'transport', 'tcp');
      const netops = indexName(str(values, 'netops_index', 'netops'), 'netops');
      const netfw = indexName(str(values, 'netfw_index', 'netfw'), 'netfw');
      const ntp = hostAddress(str(values, 'ntp', '')) || '<ntp server>';
      const tz = str(values, 'tz', 'UTC');
      const utc = /^(utc|gmt|etc\/utc|z)$/i.test(tz);
      const silent = Math.max(5, Math.round(num(values, 'silent_minutes', 60)));
      const email = str(values, 'alert_email', '');
      const platforms = [...new Set(known.map((d) => d.platform))];
      const indexOf = (p          ) => (NET[p].firewall ? netfw : netops);
      const indexes = [...new Set(platforms.map(indexOf))];
      const portOf = (p          ) => (collector === 'hf' ? NET[p].hfPort : transport === 'tls' ? 6514 : 514);
      const findings            = [];
      const listenV6 = listenFor(values, target, findings);
      const v6Line = listenV6 !== 'no' ? [`listenOnIPv6 = ${listenV6}`] : [];

      if (unknown.length > 0) {
        findings.push(
          warning('splunk.net-unknown-platform', `${unknown.length} device${unknown.length === 1 ? ' has' : 's have'} a platform the Network page does not know: ${unknown.map((d) => `${d.name} ("${d.raw}")`).join(', ')}. They get no configuration, no add-on and no sourcetype, and are left out of the missing-device alert.`, {
            remediation: `Use one of ${Object.keys(PLATFORMS).join(', ')} — the same platform ids as the Network page.`,
            source: SRC,
          }),
        );
      }
      if (devices.length === 0) findings.push(warning('splunk.net-no-devices', 'No devices listed.', { source: SRC }));
      const firewalls = known.filter((d) => NET[d.platform].firewall);
      if (transport === 'udp' && firewalls.length > 0) {
        findings.push(
          warning('splunk.net-udp-firewall', `UDP syslog from ${firewalls.length} firewall${firewalls.length === 1 ? '' : 's'}. A firewall at load logs thousands of events a second; UDP drops them with no record anywhere once a socket buffer fills or the collector restarts, and those are exactly the moments an incident needs them. Behind a load balancer UDP also reorders and splits multi-packet messages.`, {
            remediation: 'Use TCP (or TLS). On the ASA keep "logging permit-hostdown" so a collector outage does not stop traffic. If UDP is unavoidable, send it to SC4S, which is built for it, and raise net.core.rmem_max on the collector.',
            source: 'SC4S documentation; vendor guidance',
          }),
        );
      }
      const zoneless = known.filter((d) => !NET[d.platform].sendsZone);
      if (!utc && zoneless.length > 0) {
        findings.push(
          warning('splunk.net-no-timezone', `${zoneless.length} device${zoneless.length === 1 ? '' : 's'} (${[...new Set(zoneless.map((d) => PLATFORMS[d.platform].label))].join(', ')}) send BSD-style syslog timestamps with no year and no zone, in ${tz}. Splunk will read them in the collector's zone unless told otherwise, and every event is then off by the difference — silently, and by a different amount on each side of a daylight-saving change.`, {
            remediation: collector === 'hf'
              ? 'The props.conf in this app sets TZ per host for them; better still, run every device clock in UTC.'
              : 'Set SC4S_DEFAULT_TIMEZONE, or a per-host time zone in SC4S (see ops/sc4s/env_file.snippet); better still, run every device clock in UTC.',
            source: SRC,
          }),
        );
      }
      if (transport === 'tcp' && known.some((d) => d.platform === 'cisco_nxos')) {
        findings.push(info('splunk.net-nxos-udp', 'NX-OS sends syslog over UDP or TLS only; with TCP chosen, the Nexus devices are configured for UDP to the same port, and the collector listens for it.', { source: SRC }));
      }
      if (transport === 'tls') {
        findings.push(info('splunk.net-tls', 'TLS syslog needs the collector certificate trusted on every device (a trustpoint on Cisco, a certificate profile on PAN-OS, a CA on FortiOS). The device-side lines mark where; test one device before rolling out.', { source: SRC }));
      }

      // --- device configuration -------------------------------------------------
      const deviceFiles                           = {};
      for (const d of known) {
        const ext = PLATFORMS[d.platform].extension === '.cfg' ? '.cfg' : '.txt';
        deviceFiles[`ops/device-config/${splunkName(d.name, 'device')}${ext}`] = deviceConfig(d, target, portOf(d.platform), transport, ntp, utc ? 'UTC' : tz);
      }

      // --- collector --------------------------------------------------------------
      const hfPorts = [...new Map(platforms.map((p) => [NET[p].hfPort, p])).entries()].sort((a, b) => a[0] - b[0]);
      const hfInputs           = [
        '# Heavy forwarder syslog listeners: one port per sourcetype, so the',
        '# sourcetype is known from the port and no guessing is needed.',
        '# Deploy as its own app to the heavy forwarders only, not with the rest',
        '# of this app — a listener on a search head is a port nobody meant to open.',
        '# Ports under 1024 need root; these are above it on purpose.',
        '',
        ...hfPorts.flatMap(([port, p]) => [
          `# ${PLATFORMS[p].label}${platforms.filter((q) => NET[q].hfPort === port && q !== p).map((q) => `, ${PLATFORMS[q].label}`).join('')}`,
          transport === 'udp' ? `[udp://${port}]` : transport === 'tls' ? `[tcp-ssl:${port}]` : `[tcp://${port}]`,
          `sourcetype = ${NET[p].sourcetype}`,
          `index = ${indexOf(p)}`,
          '# Host from the sending address; the add-ons re-read the host from the',
          '# syslog header where the device puts its name there.',
          'connection_host = ip',
          ...v6Line,
          ...(transport === 'udp' ? ['# Keep the device’s own header rather than prepending the receive time.', 'no_appending_timestamp = true'] : []),
          '# A bounded in-memory queue plus a disk queue for when the indexers push back.',
          'queueSize = 10MB',
          'persistentQueueSize = 5GB',
          '',
        ]),
        ...(transport === 'tcp' && platforms.includes('cisco_nxos')
          ? [
              '# NX-OS has no plain TCP syslog: it sends UDP to the same port number.',
              `[udp://${NET.cisco_nxos.hfPort}]`,
              `sourcetype = ${NET.cisco_nxos.sourcetype}`,
              `index = ${indexOf('cisco_nxos')}`,
              'connection_host = ip',
              ...v6Line,
              'no_appending_timestamp = true',
              '',
            ]
          : []),
        ...(transport === 'tls'
          ? [
              '[SSL]',
              '# Certificate and key for the listener. The key password, if any, goes in',
              '# local/inputs.conf on the host (Splunk encrypts it on restart) — not here.',
              'serverCert = $SPLUNK_HOME/etc/auth/mycerts/syslog-server.pem',
              'requireClientCert = false',
              'sslVersions = tls1.2',
            ]
          : []),
      ];

      const bySource = platforms.filter((p) => NET[p].sc4sBySource);
      const sc4sFiles                           =
        collector === 'sc4s'
          ? {
              'ops/sc4s/splunk_metadata.csv': [
                '# Merge into /opt/sc4s/local/context/splunk_metadata.csv, then restart SC4S.',
                '# Overrides the index for each source; SC4S defaults are netops and netfw',
                '# too, but PAN threat and some Fortinet types default elsewhere. VERIFY the',
                '# key names against the SC4S version you run.',
                ...platforms.flatMap((p) => NET[p].sc4sKeys.map((k) => `${k},index,${indexOf(p)}`)).filter((v, i, a) => a.indexOf(v) === i),
              ],
              'ops/sc4s/env_file.snippet': [
                '# Add to /opt/sc4s/env_file, then restart SC4S.',
                '# SC4S listens on 514 TCP and UDP by default and identifies most of these',
                '# sources from the message itself.',
                ...(listenV6 !== 'no' ? ['# Listeners on IPv6 as well as IPv4.', 'SC4S_IPV6_ENABLE=yes'] : []),
                ...(transport === 'tls' ? ['SC4S_SOURCE_TLS_ENABLE=yes', '# TLS listens on 6514 by default; the certificate goes in /opt/sc4s/tls/. VERIFY for your SC4S version.'] : []),
                ...(!utc ? [`# Devices send ${tz} with no zone in the timestamp.`, `SC4S_DEFAULT_TIMEZONE=${tz}`] : []),
                '# PAN-OS: SC4S prefers IETF framing on a dedicated port (601) — about a',
                '# third faster than BSD. Optional; VERIFY the variable for your version.',
                ...(platforms.includes('panos') ? ['# SC4S_LISTEN_PAN_PANOS_TCP_PORT=5516'] : []),
              ],
              ...(bySource.length > 0
                ? {
                    // SC4S 2.x and later identify a source by sender with an app-parser
                    // (docs: each source's page, e.g. sources/vendor/Spectracom and
                    // Cisco/cisco_meraki). The 1.x pair - a filter in
                    // local/context/vendor_product_by_source.conf plus a CSV row
                    // "f_name,sc4s_vendor_product,vendor_product" - is deprecated for this
                    // since 2.0 (upgrade notes: sc4s_vendor_product is read-only), and
                    // an app-parser still using vendor_product() stops SC4S starting.
                    ...Object.fromEntries(
                      bySource.map((p) => {
                        const { vendor, product } = NET[p].sc4sBySource ;
                        const ds = known.filter((d) => d.platform === p);
                        const name = `app-vps-${splunkName(app, 'org')}-${vendor}_${product}`;
                        return [
                          `ops/sc4s/app_parsers/${name}.conf`,
                          [
                            `# Copy to /opt/sc4s/local/config/app_parsers/${name}.conf, then restart SC4S.`,
                            `# ${PLATFORMS[p].label} cannot be told apart from the message alone${p === 'arista_eos' ? ' (it is otherwise taken for Cisco IOS)' : ''},`,
                            `# so SC4S identifies it by sender and sets vendor ${vendor}, product ${product}:`,
                            `# the splunk_metadata.csv key ${vendor}_${product}. The SC4S docs show both`,
                            '# local/config/app_parsers and local/config/app-parsers for this directory -',
                            '# VERIFY which your SC4S version reads.',
                            `application ${name}[sc4s-vps] {`,
                            '    filter {',
                            ...ds.map((d, i) => `        ${i > 0 ? 'or ' : ''}${d.ip ? (isIpv6(d.ip) ? `netmask6(${d.ip}/128)` : `netmask(${d.ip}/32)`) : `host("${d.name}*" type(glob))`}`),
                            '    };',
                            '    parser {',
                            '        p_set_netsource_fields(',
                            `            vendor('${vendor}')`,
                            `            product('${product}')`,
                            '        );',
                            '    };',
                            '};',
                          ],
                        ]         ;
                      }),
                    ),
                  }
                : {}),
            }
          : {};

      // --- props: time zone per host, heavy forwarder only -----------------------
      const tzProps = collector === 'hf' && !utc && zoneless.length > 0
        ? [
            '# Index time, on the heavy forwarder that parses this syslog. These',
            `# devices write ${tz} with no zone in the timestamp.`,
            ...zoneless.flatMap((d) => [`[host::${d.ip || d.name}]`, `TZ = ${tz}`, '']),
          ]
        : [];

      // --- expected devices and the missing-device alert -------------------------
      const expected = [
        'device,ip,platform,index,sourcetype',
        ...known.map((d) => [d.name.toLowerCase(), d.ip, d.platform, indexOf(d.platform), NET[d.platform].sourcetype].map(csvCell).join(',')),
      ];
      const indexList = indexes.length > 0 ? indexes.join(', ') : netops;
      const alertName = `Network device silent for ${silent} minutes`;
      const cron = spreadCron(alertName, 15);
      const alertSearch = [
        '| inputlookup expected_network_devices.csv',
        '| eval key=mvappend(lower(device), ip)',
        '| mvexpand key',
        `| join type=left key [| tstats latest(_time) as last_seen where index IN (${indexList}) earliest=-7d by host | eval key=lower(host) | fields key, last_seen]`,
        '| stats max(last_seen) as last_seen, values(platform) as platform, values(ip) as ip by device',
        `| where isnull(last_seen) OR last_seen < relative_time(now(), "-${silent}m")`,
        '| eval last_seen=if(isnull(last_seen), "not in 7 days", strftime(last_seen, "%Y-%m-%d %H:%M:%S %Z"))',
        '| table device, ip, platform, last_seen',
      ];
      const hostList = known.flatMap((d) => [d.name.toLowerCase(), ...(d.ip ? [d.ip] : [])]);

      return {
        tier: TIER,
        title: `Onboard ${known.length} network device${known.length === 1 ? '' : 's'} into ${indexList} through ${collector === 'sc4s' ? 'SC4S' : 'a heavy forwarder'}`,
        app,
        activation: 'restart',
        notes: [
          ...platforms.map((p) => `${PLATFORMS[p].label}: add-on — ${NET[p].addon}. Collector sourcetype ${NET[p].sourcetype}${NET[p].produces.join(',') !== NET[p].sourcetype ? `, which the add-on splits into ${NET[p].produces.join(', ')}` : ''}. Index ${indexOf(p)}. CIM: ${NET[p].cim}.`),
          'Install each add-on on the search heads and on the tier that parses the syslog (the indexers, or the heavy forwarder). SC4S does its own parsing and sends over HEC, so with SC4S the add-ons are needed on the search heads (and indexers for any index-time parts) but nothing is installed on SC4S itself.',
          'ops/device-config/ has one file per device with the lines to paste — NTP, clock, time stamp format, the logging destination and the back-out. Capture the running config first; the first comment line in each file says what to show.',
          collector === 'sc4s'
            ? `SC4S on ${target}: port 514 (${transport.toUpperCase()}). ops/sc4s/ holds the index overrides${bySource.length > 0 ? ' and, in ops/sc4s/app_parsers/, the app-parsers that identify by sender the sources SC4S cannot identify from the message' : ''}.`
            : `Heavy forwarder on ${target}: ops/heavy_forwarder/inputs.conf opens ${hfPorts.map(([port]) => port).join(', ')} (${transport.toUpperCase()}). Deploy it as a separate app to the heavy forwarders only.`,
          'NTP on every device before anything else. A device with a drifting clock produces events that are in Splunk and cannot be found, because they are filed under the wrong time.',
          `The alert "${alertName}" compares lookups/expected_network_devices.csv with what has actually arrived, by host name and by IP. Keep the CSV current as devices come and go, or it alerts on the retired ones.`,
          ...(platforms.includes('cisco_asa') ? ['ASA with TCP: "logging permit-hostdown" is in the configuration for a reason. Without it, when the collector is down, the ASA stops permitting new connections.'] : []),
        ],
        before: [
          `| rest /services/data/indexes | search title IN (${indexList}) | table title, splunk_server`,
          `| rest /services/apps/local | search title IN (TA-cisco_ios, Splunk_TA_cisco-asa, Splunk_TA_paloalto, Splunk_TA_paloalto_networks, Splunk_TA_fortinet_fortigate, Splunk_TA_f5-bigip) OR label="*Cisco*Networking*" | table title, label, version, splunk_server   # TA-cisco_ios is deprecated: replace it with the Catalyst add-on (7538). VERIFY that add-on's app folder name`,
          collector === 'sc4s' ? `ss -ltnup | grep -E ':(514|6514)\\b'   # on ${target}: SC4S listening` : `ss -ltnup | grep -E ':(${hfPorts.map(([port]) => port).join('|')})\\b'   # on ${target}: nothing already on these ports`,
          'show ntp associations   # (IOS/NX-OS/ASA; "show ntp status" on EOS, "diagnose sys ntp status" on FortiOS) — synchronised before logging is turned on',
        ],
        files: {
          'default/app.conf': appConfLines(app, 'Network device onboarding', 'Expected network devices and the missing-device alert'),
          'default/transforms.conf': [
            '[expected_network_devices]',
            'filename = expected_network_devices.csv',
            'case_sensitive_match = false',
          ],
          'lookups/expected_network_devices.csv': expected,
          'default/savedsearches.conf': [
            `[${alertName}]`,
            `description = Every device in expected_network_devices.csv that has sent nothing to ${indexList} for ${silent} minutes.`,
            ...foldSearch(alertSearch),
            'dispatch.earliest_time = -7d',
            'dispatch.latest_time = now',
            'enableSched = 1',
            `cron_schedule = ${cron}`,
            'counttype = number of events',
            'relation = greater than',
            'quantity = 0',
            'alert.track = 1',
            'alert.severity = 4',
            '# One alert per device, then quiet for four hours, rather than the same',
            '# device every fifteen minutes all night.',
            'alert.digest_mode = 0',
            'alert.suppress = 1',
            'alert.suppress.fields = device',
            'alert.suppress.period = 4h',
            ...(email ? ['action.email = 1', `action.email.to = ${email}`, `action.email.subject = Network device silent: $result.device$`] : []),
          ],
          ...(tzProps.length > 0 ? { 'default/props.conf': tzProps } : {}),
          'metadata/default.meta': defaultMeta(),
          ...(collector === 'hf' ? { 'ops/heavy_forwarder/inputs.conf': hfInputs } : {}),
          ...sc4sFiles,
          ...deviceFiles,
        },
        verify: [
          `| tstats latest(_time) as last_seen, count where index IN (${indexList}) host IN (${hostList.length > 0 ? hostList.join(', ') : '*'}) earliest=-1h by host, sourcetype | eval last_seen=strftime(last_seen, "%F %T")`,
          `| tstats count where index IN (${indexList}) earliest=-24h by host, _time span=1h | stats avg(count) as avg_per_hour, min(count) as min_per_hour by host | sort min_per_hour   # rate, and gaps`,
          `index IN (${indexList}) earliest=-15m | eval skew_s=_indextime-_time | stats avg(skew_s) as avg_skew_s, min(skew_s) as min_skew_s by host, sourcetype   # hours of skew = a time zone problem; negative = events from the future`,
          `| savedsearch "${alertName}"   # should return nothing once every device is sending`,
          ...known.slice(0, 10).map((d) => `index=${indexOf(d.platform)} (host=${d.name.toLowerCase()}${d.ip ? ` OR host=${d.ip}` : ''}) earliest=-15m | stats count by sourcetype   # ${d.name}`),
          ...(platforms.includes('panos') ? [`index=${netfw} sourcetype=pan:* earliest=-15m | stats count by sourcetype   # pan:traffic and pan:threat, not only pan:firewall`] : []),
          ...(platforms.includes('fortios') ? [`index=${netfw} sourcetype=fortigate_* earliest=-15m | stats count by sourcetype   # fortigate_traffic/utm/event`] : []),
        ],
        backout: [
          'On each device: the "Back out" line at the end of its file in ops/device-config/',
          `Remove ${app} from the search heads${collector === 'hf' ? ', and the listener app from the heavy forwarders (restart them)' : ', and the ops/sc4s/ entries from SC4S (restart it)'}`,
          '# Events already indexed stay until the index retention removes them.',
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_vmware',
    tier: TIER,
    label: 'Onboard the VCF / vSphere estate',
    group: 'Onboard what you built',
    description:
      'ESXi, vCenter and NSX syslog straight to Splunk with the official ESXi and vCenter log add-ons, and SDDC Manager, VCF Operations and VCF Automation through VCF Operations for Logs forwarding — with a PowerCLI script for the hosts, a REST script for vCenter and NSX (both apply when run; --dry-run previews), and a search for every expected component that is not reporting.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_vmware_onboarding' },
      { id: 'use_estate', label: 'ESXi hosts and vCenters from the imported estate', control: 'toggle', default: true, hint: 'Falls back to the lists below when no estate is loaded' },
      { id: 'esxi_hosts', label: 'ESXi hosts', control: 'textarea', default: 'esx01.example.com\nesx02.example.com\nesx03.example.com\nesx04.example.com' },
      { id: 'vcenters', label: 'vCenters', control: 'textarea', default: 'vc01.example.com' },
      { id: 'nsx_nodes', label: 'NSX Manager nodes', control: 'textarea', default: 'nsx01a.example.com\nnsx01b.example.com\nnsx01c.example.com', hint: 'Each node, not the cluster VIP' },
      { id: 'sddc_manager', label: 'SDDC Manager', control: 'text', default: 'sddc01.example.com' },
      { id: 'vcf_ops_logs', label: 'VCF Operations for Logs', control: 'text', default: 'vcfops-logs01.example.com', hint: 'The log management node that forwards to Splunk' },
      { id: 'path', label: 'Route', control: 'select', default: 'direct', options: [
        { value: 'direct', label: 'ESXi, vCenter, NSX direct; the rest through VCF Operations for Logs' },
        { value: 'via_logs', label: 'Everything through VCF Operations for Logs forwarding' },
        { value: 'both', label: 'Both — direct and forwarded' },
      ] },
      { id: 'collector', label: 'Collected by', control: 'select', default: 'sc4s', options: [
        { value: 'sc4s', label: 'Splunk Connect for Syslog (SC4S)' },
        { value: 'hf', label: 'Heavy forwarder' },
      ] },
      { id: 'collector_host', label: 'Collector', control: 'text', default: 'syslog01.example.com' },
      { id: 'transport', label: 'Transport', control: 'select', default: 'tcp', options: [
        { value: 'tcp', label: 'TCP' },
        { value: 'tls', label: 'TLS' },
        { value: 'udp', label: 'UDP' },
      ] },
      LISTEN_INPUT,
      { id: 'esxi_index', label: 'ESXi index', control: 'text', default: 'vmware-esxilog' },
      { id: 'vc_index', label: 'vCenter index', control: 'text', default: 'vmware-vclog' },
      { id: 'vcf_index', label: 'NSX and VCF index', control: 'text', default: 'vcf', hint: 'Match the Splunk index on vcflog91_forwarding' },
      { id: 'silent_minutes', label: 'Alert when a component is silent for (minutes)', control: 'number', default: 60, min: 5, max: 10080 },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_vmware_onboarding'), 'org_vmware_onboarding');
      const useEstate = bool(values, 'use_estate', true);
      const estate = estateHosts();
      const estateVc = estateVcenters();
      const typedEsxi = linesOf(str(values, 'esxi_hosts', '')).map(hostAddress).filter(Boolean);
      const typedVc = linesOf(str(values, 'vcenters', '')).map(hostAddress).filter(Boolean);
      const fromEstate = useEstate && estate !== null;
      const reachable = fromEstate ? estate .filter((h) => h.state === 'connected') : [];
      const unreachable = fromEstate ? estate .filter((h) => h.state !== 'connected') : [];
      const esxi = fromEstate ? reachable.map((h) => hostAddress(h.name)).filter(Boolean) : typedEsxi;
      const vcenters = useEstate && estateVc && estateVc.length > 0 ? estateVc.map(hostAddress).filter(Boolean) : typedVc;
      const nsx = linesOf(str(values, 'nsx_nodes', '')).map(hostAddress).filter(Boolean);
      const sddc = hostAddress(str(values, 'sddc_manager', ''));
      const opsLogs = hostAddress(str(values, 'vcf_ops_logs', ''));
      const path = str(values, 'path', 'direct');
      const direct = path !== 'via_logs';
      const collector = str(values, 'collector', 'sc4s');
      const target = hostAddress(str(values, 'collector_host', '')) || '<collector>';
      const transport = str(values, 'transport', 'tcp');
      const esxiIndex = indexName(str(values, 'esxi_index', 'vmware-esxilog'), 'vmware-esxilog');
      const vcIndex = indexName(str(values, 'vc_index', 'vmware-vclog'), 'vmware-vclog');
      const vcfIndex = indexName(str(values, 'vcf_index', 'vcf'), 'vcf');
      const silent = Math.max(5, Math.round(num(values, 'silent_minutes', 60)));
      // ESXi to 1514 is what the ESXi logs add-on documents; the others get a
      // port of their own on a heavy forwarder so the sourcetype is known.
      const port = { esxi: collector === 'hf' ? 1514 : transport === 'tls' ? 6514 : 514, vc: collector === 'hf' ? 1517 : transport === 'tls' ? 6514 : 514, nsx: collector === 'hf' ? 1518 : transport === 'tls' ? 6514 : 514, fwd: collector === 'hf' ? 1519 : transport === 'tls' ? 6514 : 514 };
      if (collector === 'sc4s' && transport !== 'tls') port.esxi = 514;
      const esxiScheme = transport === 'tls' ? 'ssl' : transport;
      // An IPv6 collector in a URL is bracketed: tcp://[2001:db8::10]:1514.
      const esxiTarget = `${esxiScheme}://${urlHost(target)}:${port.esxi}`;
      const findings            = [];
      const listenV6 = listenFor(values, target, findings);
      const v6Line = listenV6 !== 'no' ? [`listenOnIPv6 = ${listenV6}`] : [];

      if (useEstate && !estate) {
        findings.push(info('splunk.vmw-no-estate', 'No estate is loaded, so the ESXi and vCenter lists on the form were used. Import an RVTools export and every host in it is listed for you.', { source: SRC }));
      }
      if (unreachable.length > 0) {
        findings.push(
          warning('splunk.vmw-host-unreachable', `${unreachable.length} ESXi host${unreachable.length === 1 ? ' is' : 's are'} not connected in the estate (${unreachable.slice(0, 8).map((h) => `${h.name}: ${h.state}`).join(', ')}${unreachable.length > 8 ? ', …' : ''}). They are left out of the script, so they will have no syslog target — and a host that is disconnected is the one whose logs you will want.`, {
            remediation: 'Reconnect them and run the script again, or set Syslog.global.logHost on each from its own host client or with esxcli.',
            source: SRC,
          }),
        );
      }
      if (estate && !useEstate) {
        const listed = new Set(typedEsxi.map(shortName));
        const left = estate.filter((h) => !listed.has(shortName(h.name)));
        if (left.length > 0) {
          findings.push(
            warning('splunk.vmw-estate-not-listed', `${left.length} of the ${estate.length} ESXi hosts in the imported estate are not in the list on the form (${left.slice(0, 8).map((h) => h.name).join(', ')}${left.length > 8 ? ', …' : ''}), so they get no syslog target and are not expected by the missing-host search.`, {
              remediation: 'Turn on "from the imported estate", or add them to the list.',
              source: SRC,
            }),
          );
        }
      }
      if (esxi.length === 0) findings.push(warning('splunk.vmw-no-esxi', 'No ESXi hosts: none will get a syslog target.', { source: SRC }));
      if (transport === 'udp') {
        findings.push(
          warning('splunk.vmw-udp', 'UDP syslog from ESXi, vCenter and NSX drops events under load and during collector restarts, with no record that it did — and a host in trouble is a host logging a lot. Behind a load balancer UDP also splits and reorders the multi-line events ESXi writes.', {
            remediation: 'Use TCP (the ESXi logs add-on documents TCP 1514) or TLS.',
            source: 'Splunk Add-on for VMware ESXi Logs documentation; SC4S documentation',
          }),
        );
      }
      if (path === 'both') {
        findings.push(
          warning('splunk.vmw-duplicate', 'Direct and forwarded both on: VCF Operations for Logs already receives ESXi, vCenter and NSX logs, so forwarding everything from it as well as sending direct indexes each of those events twice — double the licence and doubled counts in every search.', {
            remediation: 'Use the direct route, and filter the VCF Operations for Logs forwarding rule (vcflog91_forwarding) to the components that are not sent direct: SDDC Manager, VCF Operations, VCF Automation.',
            source: SRC,
          }),
        );
      }
      if (transport === 'tls') {
        findings.push(info('splunk.vmw-tls', 'TLS from ESXi validates the collector certificate: its CA must be in the host trust store (managed from vCenter in 8.x/9.x), or the host logs "certificate verify failed" and sends nothing. VERIFY on a single host first.', { source: SRC }));
      }

      const expected                                                  = [
        ...esxi.map((h) => ({ host: h, role: 'esxi', index: direct ? esxiIndex : vcfIndex })),
        ...vcenters.map((h) => ({ host: h, role: 'vcenter', index: direct ? vcIndex : vcfIndex })),
        ...nsx.map((h) => ({ host: h, role: 'nsx_manager', index: vcfIndex })),
        ...(sddc ? [{ host: sddc, role: 'sddc_manager', index: vcfIndex }] : []),
      ];
      const indexes = [...new Set(expected.map((e) => e.index))];
      const indexList = indexes.length > 0 ? indexes.join(', ') : vcfIndex;
      const alertName = `VMware component silent for ${silent} minutes`;

      const ps1           = [
        '# Point every ESXi host in esxi-hosts.txt at the Splunk syslog collector.',
        '# Adds the target to Syslog.global.logHost (keeping any existing target,',
        '# such as VCF Operations for Logs), opens the syslog firewall ruleset,',
        '# reloads syslog and sends a test mark.',
        '# Applies when run; -DryRun previews.',
        '#',
        '# Credentials never go on the command line. Either:',
        '#   -CredentialFile <path>  a PSCredential saved with',
        '#       Get-Credential | Export-Clixml -Path $HOME\\.vcf\\vcenter.cred',
        '#     (encrypted with DPAPI on Windows, for that user on that machine only;',
        '#     on Linux and macOS Export-Clixml does NOT encrypt it — use the prompt)',
        '#   or nothing, and you are prompted by Get-Credential.',
        '# VCF 9.1 API tokens: VERIFY whether your PowerCLI (VCF.PowerCLI 9.x)',
        '# Connect-VIServer accepts one; until then use a PSCredential.',
        '#',
        `# Usage: pwsh ./esxi-syslog.ps1 -VCenter ${vcenters[0] ?? 'vc01.example.com'} [-CredentialFile <path>] [-DryRun] [-Replace]`,
        'param(',
        '  [Parameter(Mandatory = $true)][string]$VCenter,',
        '  [string]$CredentialFile,',
        "  [string]$HostsFile = (Join-Path $PSScriptRoot 'esxi-hosts.txt'),",
        `  [string]$Target = '${esxiTarget}',`,
        '  [switch]$Replace,',
        '  [switch]$DryRun',
        ')',
        "$ErrorActionPreference = 'Stop'",
        '$Execute = -not $DryRun',
        'if ($CredentialFile) { $cred = Import-Clixml -Path $CredentialFile } else { $cred = Get-Credential -Message "vCenter $VCenter" }',
        'Connect-VIServer -Server $VCenter -Credential $cred | Out-Null',
        '# Hosts not found in this vCenter are collected; the script exits 1 with the',
        '# list at the end, so a partial run never looks like a clean one.',
        '$missing = [System.Collections.Generic.List[string]]::new()',
        'try {',
        "  foreach ($name in Get-Content $HostsFile | Where-Object { $_ -and -not $_.StartsWith('#') }) {",
        '    $vmhost = Get-VMHost -Name $name.Trim() -ErrorAction SilentlyContinue',
        '    if (-not $vmhost) { Write-Warning "$name is not in $VCenter"; $missing.Add($name.Trim()); continue }',
        '    $setting = Get-AdvancedSetting -Entity $vmhost -Name Syslog.global.logHost',
        "    $current = @(\"$($setting.Value)\" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })",
        '    if ($current -contains $Target -and -not $Replace) { Write-Host "$name already sends to $Target"; continue }',
        "    $new = if ($Replace) { $Target } else { (@($current) + $Target) -join ',' }",
        '    if (-not $Execute) {',
        '      Write-Host "DRY RUN: $name  logHost \'$($setting.Value)\' -> \'$new\'; enable firewall ruleset syslog; esxcli system syslog reload"',
        '      continue',
        '    }',
        '    $setting | Set-AdvancedSetting -Value $new -Confirm:$false | Out-Null',
        "    Get-VMHostFirewallException -VMHost $vmhost -Name 'syslog' | Set-VMHostFirewallException -Enabled $true | Out-Null",
        '    $esxcli = Get-EsxCli -VMHost $vmhost -V2',
        '    $esxcli.system.syslog.reload.Invoke() | Out-Null',
        '    $esxcli.system.syslog.mark.Invoke(@{ message = "syslog test from $name" }) | Out-Null',
        '    Write-Host "$name -> $new"',
        '  }',
        '} finally {',
        '  Disconnect-VIServer -Server $VCenter -Confirm:$false',
        '}',
        'if ($missing.Count -gt 0) {',
        '  Write-Error "$($missing.Count) host(s) not found in ${VCenter}: $($missing -join \', \')" -ErrorAction Continue',
        '  exit 1',
        '}',
      ];

      const proto = transport === 'udp' ? 'UDP' : transport === 'tls' ? 'TLS' : 'TCP';
      const sh           = [
        '# Point vCenter (appliance log forwarding) and each NSX Manager node at the',
        '# Splunk syslog collector. Applies when run; --dry-run previews.',
        '#',
        '# Credentials: curl netrc files, mode 600, never on a command line:',
        '#   ~/.vcf/vcenter.netrc   machine vc01.example.com login administrator@vsphere.local password ...',
        '#   ~/.vcf/nsx.netrc       machine nsx01a.example.com login admin password ...',
        '# CACERT=<bundle> to verify the appliances’ certificates (VMCA root, NSX CA).',
        '#',
        '# Usage: bash vcf-syslog.sh [--dry-run]',
        'set -euo pipefail',
        'EXECUTE=1; [[ "${1:-}" == "--dry-run" ]] && EXECUTE=0',
        'VC_NETRC="${VC_NETRC:-$HOME/.vcf/vcenter.netrc}"',
        'NSX_NETRC="${NSX_NETRC:-$HOME/.vcf/nsx.netrc}"',
        `TARGET_HOST="${target}"`,
        `VC_PORT=${direct ? port.vc : port.fwd}`,
        `NSX_PORT=${port.nsx}`,
        `PROTOCOL="${proto}"`,
        `VCENTERS=(${direct ? vcenters.map((v) => `"${v}"`).join(' ') : ''})`,
        `NSX_NODES=(${direct ? nsx.map((v) => `"${v}"`).join(' ') : ''})`,
        '',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }',
        'umask 077',
        'HDR="$(mktemp)"; trap \'rm -f "$HDR"\' EXIT',
        'CURL=(curl --silent --show-error --fail)',
        '[[ -n "${CACERT:-}" ]] && CURL+=(--cacert "$CACERT")',
        'private() {',
        '  [[ -f "$1" ]] || { echo "Missing $1" >&2; exit 1; }',
        '  [[ "$(stat -c %a "$1")" == "600" ]] || { echo "$1 must be mode 600" >&2; exit 1; }',
        '}',
        '',
        '# --- vCenter: GET/PUT /api/appliance/logging/forwarding --------------------',
        '# At most three forwarding targets per appliance; this adds one and keeps',
        '# the rest. VERIFY the body shape on your vCenter 9.x API reference.',
        '(( ${#VCENTERS[@]} )) && private "$VC_NETRC"',
        '# A target that cannot be added is recorded, and the script exits 1 at the end.',
        'FAILED=()',
        'for vc in "${VCENTERS[@]}"; do',
        '  echo "== vCenter $vc"',
        '  # The session id is a JSON string; jq -e with "strings" fails on null or',
        '  # anything else, so "null" never becomes a session header.',
        '  sid="$("${CURL[@]}" --netrc-file "$VC_NETRC" -X POST "https://$vc/api/session" | jq -er \'strings | select(length > 0)\')" \\',
        '    || { echo "   no session id from $vc" >&2; exit 1; }',
        '  printf "vmware-api-session-id: %s\\n" "$sid" > "$HDR"',
        '  current="$("${CURL[@]}" -H @"$HDR" "https://$vc/api/appliance/logging/forwarding")"',
        '  echo "   now: $current"',
        '  if jq -e --arg h "$TARGET_HOST" \'any(.[]; .hostname == $h)\' <<<"$current" >/dev/null; then',
        '    echo "   already forwarding to $TARGET_HOST"',
        '  elif (( $(jq length <<<"$current") >= 3 )); then',
        '    echo "   three targets already configured (the maximum); remove one first" >&2',
        '    FAILED+=("vCenter $vc")',
        '  else',
        '    body="$(jq -c --arg h "$TARGET_HOST" --argjson p "$VC_PORT" --arg proto "$PROTOCOL" \'{cfg_list: (. + [{hostname: $h, port: $p, protocol: $proto}])}\' <<<"$current")"',
        '    if (( EXECUTE )); then',
        '      "${CURL[@]}" -X PUT -H @"$HDR" -H "Content-Type: application/json" -d "$body" "https://$vc/api/appliance/logging/forwarding"',
        '      "${CURL[@]}" -X POST -H @"$HDR" -H "Content-Type: application/json" -d \'{"send_test_message": true}\' "https://$vc/api/appliance/logging/forwarding?action=test"; echo',
        '    else',
        '      echo "   DRY RUN: PUT /api/appliance/logging/forwarding $body"',
        '    fi',
        '  fi',
        '  "${CURL[@]}" -X DELETE -H @"$HDR" "https://$vc/api/session" >/dev/null || true',
        'done',
        '',
        '# --- NSX: /api/v1/node/services/syslog/exporters on each Manager node -------',
        '# The node API configures the node it is sent to, so run it against every',
        '# Manager node, not the cluster VIP. Edges: the same path under',
        '# /api/v1/transport-nodes/<edge-id>/node/..., or "set logging-server" on the',
        '# edge CLI. TLS exporters also need tls_ca_pem. VERIFY on NSX 9.x.',
        '(( ${#NSX_NODES[@]} )) && private "$NSX_NETRC"',
        'for node in "${NSX_NODES[@]}"; do',
        '  echo "== NSX $node"',
        '  current="$("${CURL[@]}" --netrc-file "$NSX_NETRC" "https://$node/api/v1/node/services/syslog/exporters")"',
        '  if jq -e --arg h "$TARGET_HOST" \'any(.results[]?; .server == $h)\' <<<"$current" >/dev/null; then',
        '    echo "   already exporting to $TARGET_HOST"; continue',
        '  fi',
        '  body="$(jq -nc --arg h "$TARGET_HOST" --argjson p "$NSX_PORT" --arg proto "$PROTOCOL" \'{exporter_name: "splunk", server: $h, port: $p, protocol: $proto, level: "INFO"}\')"',
        '  if (( EXECUTE )); then',
        '    "${CURL[@]}" --netrc-file "$NSX_NETRC" -X POST -H "Content-Type: application/json" -d "$body" "https://$node/api/v1/node/services/syslog/exporters"; echo',
        '  else',
        '    echo "   DRY RUN: POST /api/v1/node/services/syslog/exporters $body"',
        '  fi',
        'done',
        'if (( ${#FAILED[@]} > 0 )); then',
        '  printf "Not configured: %s\\n" "${FAILED[@]}" >&2',
        '  exit 1',
        'fi',
      ];

      const sc4sFiles                           =
        collector === 'sc4s'
          ? {
              'ops/sc4s/splunk_metadata.csv': [
                '# Merge into /opt/sc4s/local/context/splunk_metadata.csv, then restart SC4S.',
                '# SC4S sourcetypes these vmware:esxlog:<program>, vmware:vclog:<program>',
                '# and vmware:nsxlog:<program>, which is what the ESXi and vCenter log',
                '# add-ons expect; their default index is infraops (main in the next major',
                '# release, which also renames the keys and sourcetypes — VERIFY for the',
                '# version you run; both spellings are listed).',
                `vmware_vsphere_esx,index,${direct ? esxiIndex : vcfIndex}`,
                `vmware_vsphere_vc,index,${direct ? vcIndex : vcfIndex}`,
                `vmware_vsphere_vcenter,index,${direct ? vcIndex : vcfIndex}`,
                `vmware_vsphere_nsx,index,${vcfIndex}`,
                `vmware_vsphere_nsxfw,index,${vcfIndex}`,
              ],
              'ops/sc4s/env_file.snippet': [
                '# Add to /opt/sc4s/env_file, then restart SC4S.',
                '# vSphere is identified from the message on the default port. A dedicated',
                '# port removes the guesswork (and the misidentified ESXi auth/shell',
                '# events people see on 514). VERIFY variable names for your version.',
                `SC4S_LISTEN_VMWARE_VSPHERE_${transport === 'udp' ? 'UDP' : transport === 'tls' ? 'TLS' : 'TCP'}_PORT=1514`,
                ...(transport === 'tls' ? ['SC4S_SOURCE_TLS_ENABLE=yes'] : []),
                ...(listenV6 !== 'no' ? ['# Listeners on IPv6 as well as IPv4.', 'SC4S_IPV6_ENABLE=yes'] : []),
                '# With the dedicated port, point ESXi at 1514 instead of 514: run',
                `# esxi-syslog.ps1 with -Target ${esxiScheme}://${urlHost(target)}:1514`,
              ],
            }
          : {};

      const hfInputs           = [
        '# Heavy forwarder listeners for the VCF estate. Deploy as its own app to the',
        '# heavy forwarders only.',
        '',
        '# ESXi — the Splunk Add-on for VMware ESXi Logs (Splunk_TA_esxilogs) takes',
        '# vmw-syslog and splits it into vmware:esxlog:<component> at index time,',
        '# so it must be on this heavy forwarder too.',
        transport === 'udp' ? `[udp://${port.esxi}]` : transport === 'tls' ? `[tcp-ssl:${port.esxi}]` : `[tcp://${port.esxi}]`,
        'sourcetype = vmw-syslog',
        `index = ${direct ? esxiIndex : vcfIndex}`,
        'connection_host = dns',
        ...v6Line,
        '',
        '# vCenter — the Splunk Add-on for vCenter Logs (Splunk_TA_vcenter). Its',
        '# documented method is an rsyslog imfile template on the appliance to port',
        '# 1517; appliance log forwarding (what the script sets) sends RFC 5424',
        '# instead. VERIFY the add-on sourcetypes it as vmware:vclog:* before relying',
        '# on it; SC4S handles the RFC 5424 form natively.',
        transport === 'udp' ? `[udp://${port.vc}]` : transport === 'tls' ? `[tcp-ssl:${port.vc}]` : `[tcp://${port.vc}]`,
        'sourcetype = vclog',
        `index = ${direct ? vcIndex : vcfIndex}`,
        'connection_host = dns',
        ...v6Line,
        '',
        '# NSX — no Splunk-supported add-on. The sourcetype name follows SC4S’s',
        '# convention so a TA written later (splunk_ta_custom) can match on it.',
        transport === 'udp' ? `[udp://${port.nsx}]` : transport === 'tls' ? `[tcp-ssl:${port.nsx}]` : `[tcp://${port.nsx}]`,
        'sourcetype = vmware:nsxlog',
        `index = ${vcfIndex}`,
        'connection_host = dns',
        ...v6Line,
        '',
        '# Forwarded from VCF Operations for Logs (SDDC Manager, VCF Operations,',
        '# VCF Automation). Local sourcetype name; no Splunkbase add-on parses these.',
        transport === 'udp' ? `[udp://${port.fwd}]` : transport === 'tls' ? `[tcp-ssl:${port.fwd}]` : `[tcp://${port.fwd}]`,
        'sourcetype = vcf:syslog',
        `index = ${vcfIndex}`,
        'connection_host = none',
        ...v6Line,
        '',
        ...(transport === 'tls'
          ? ['[SSL]', '# Key password, if any, in local/inputs.conf on the host — not here.', 'serverCert = $SPLUNK_HOME/etc/auth/mycerts/syslog-server.pem', 'requireClientCert = false', 'sslVersions = tls1.2']
          : []),
      ];

      const alertSearch = [
        '| inputlookup expected_vmware_hosts.csv',
        '| eval key=lower(mvindex(split(host, "."), 0))',
        `| join type=left key [| tstats latest(_time) as last_seen, count where index IN (${indexList}) earliest=-7d by host | eval key=lower(mvindex(split(host, "."), 0)) | stats max(last_seen) as last_seen, sum(count) as events by key]`,
        `| where isnull(last_seen) OR last_seen < relative_time(now(), "-${silent}m")`,
        '| eval last_seen=if(isnull(last_seen), "not in 7 days", strftime(last_seen, "%Y-%m-%d %H:%M:%S %Z"))',
        '| table host, role, index, last_seen',
      ];

      return {
        tier: TIER,
        title: `Onboard ${esxi.length} ESXi host${esxi.length === 1 ? '' : 's'}, ${vcenters.length} vCenter${vcenters.length === 1 ? '' : 's'}, NSX and VCF management into Splunk`,
        app,
        activation: 'restart',
        notes: [
          fromEstate ? `ESXi hosts and vCenters come from the imported estate (${currentEstate()?.origin ?? 'current estate'}): ${reachable.length} connected host${reachable.length === 1 ? '' : 's'}.` : 'ESXi hosts and vCenters come from the lists on the form.',
          'ESXi: Splunk Add-on for VMware ESXi Logs (Splunk_TA_esxilogs, Splunkbase 5603). Incoming vmw-syslog is split into vmware:esxlog:<component> (hostd, vpxa, vmkernel, fdm, …) at index time, so install it on the search heads and the parsing tier. Documented index vmware-esxilog; TCP 1514 is its preferred port.',
          'vCenter: Splunk Add-on for vCenter Logs (Splunk_TA_vcenter, Splunkbase 5601) — vmware:vclog:vpxd and related sourcetypes, index vmware-vclog. Appliance log forwarding is the supported way to send vCenter logs; the add-on’s own rsyslog-template method edits the appliance and is lost on upgrade.',
          'NSX: no Splunk-supported add-on. The community "VMware NSX add-on" (Splunkbase 6805) maps NSX syslog to the CIM, including IDS, but is not supported by Splunk; or write your own with the custom TA blueprint.',
          'SDDC Manager, VCF Operations, VCF Operations for Logs and VCF Automation: no Splunkbase add-on for any of them (VERIFY). In VCF 9.1 they already send to VCF Operations for Logs; forward from there to Splunk with the "Forward filtered logs out of VCF Operations (9.1)" blueprint (vcflog91_forwarding) on the Automation and Operations page, destination "Splunk", index ' + vcfIndex + '.',
          direct
            ? 'On that forwarding rule, filter out the ESXi, vCenter and NSX sources — they reach Splunk directly here, and forwarding them too indexes every event twice.'
            : 'Everything reaches Splunk through VCF Operations for Logs, so the ESXi and vCenter add-ons will not recognise the events: they arrive with the forwarding rule’s framing, not as vmw-syslog. VERIFY what your forwarding rule sends before relying on either add-on.',
          'ops/esxi-syslog.ps1 appends the Splunk target to Syslog.global.logHost, so an existing target (VCF Operations for Logs) stays. -Replace overwrites instead.',
          'ops/vcf-syslog.sh sets vCenter appliance forwarding (at most three targets) and an exporter on each NSX Manager node. Both scripts apply when run; -DryRun / --dry-run previews.',
          'The Splunk Add-on for VMware (Splunk_TA_vmware, with a data collection node) collects performance and inventory through the vSphere API. It is a different thing from these log add-ons and is not configured here.',
          `Create the indexes first: ${indexes.join(', ')}.`,
        ],
        before: [
          `| rest /services/data/indexes | search title IN (${indexList}) | table title, splunk_server`,
          '| rest /services/apps/local | search title IN (Splunk_TA_esxilogs, Splunk_TA_vcenter) | table title, version, splunk_server',
          `pwsh ./ops/esxi-syslog.ps1 -VCenter ${vcenters[0] ?? '<vcenter>'} -DryRun   # shows each host’s current logHost`,
          'bash ops/vcf-syslog.sh --dry-run   # shows current vCenter forwarding and NSX exporters',
          `nc -vz ${target} ${port.esxi}   # from an ESXi host (nc is on ESXi): the collector is reachable`,
        ],
        files: {
          'default/app.conf': appConfLines(app, 'VMware onboarding', 'Expected VCF and vSphere log sources and the missing-component alert'),
          'default/transforms.conf': ['[expected_vmware_hosts]', 'filename = expected_vmware_hosts.csv', 'case_sensitive_match = false'],
          'lookups/expected_vmware_hosts.csv': ['host,role,index', ...expected.map((e) => [e.host.toLowerCase(), e.role, e.index].map(csvCell).join(','))],
          'default/savedsearches.conf': [
            `[${alertName}]`,
            `description = Every ESXi host, vCenter, NSX node and VCF component in expected_vmware_hosts.csv that has sent nothing for ${silent} minutes. Matched on short host name, because ESXi sends its short name or its FQDN depending on how it was installed.`,
            ...foldSearch(alertSearch),
            'dispatch.earliest_time = -7d',
            'dispatch.latest_time = now',
            'enableSched = 1',
            `cron_schedule = ${spreadCron(alertName, 15)}`,
            'counttype = number of events',
            'relation = greater than',
            'quantity = 0',
            'alert.track = 1',
            'alert.severity = 4',
            'alert.digest_mode = 0',
            'alert.suppress = 1',
            'alert.suppress.fields = host',
            'alert.suppress.period = 4h',
          ],
          'metadata/default.meta': defaultMeta(),
          'ops/esxi-hosts.txt': esxi.length > 0 ? esxi : ['# no ESXi hosts'],
          'ops/esxi-syslog.ps1': ps1,
          'ops/vcf-syslog.sh': sh,
          ...(collector === 'hf' ? { 'ops/heavy_forwarder/inputs.conf': hfInputs } : {}),
          ...sc4sFiles,
        },
        verify: [
          `| savedsearch "${alertName}"   # nothing, once every component is sending`,
          `| tstats count, latest(_time) as last_seen where index IN (${indexList}) earliest=-1h by host, sourcetype | eval last_seen=strftime(last_seen, "%F %T")`,
          `index=${direct ? esxiIndex : vcfIndex} sourcetype=vmware:esxlog:* earliest=-15m | stats count by sourcetype   # hostd, vpxa, vmkernel — not only vmw-syslog`,
          `index=${direct ? esxiIndex : vcfIndex} "syslog test" earliest=-1h | stats count by host   # the mark each host sent`,
          'esxcli system syslog config get   # on a host: Remote Host lists the collector',
          `index=${direct ? vcIndex : vcfIndex} sourcetype=vmware:vclog* earliest=-15m | stats count by host, sourcetype`,
          `index=${vcfIndex} earliest=-15m | stats count by host, sourcetype   # NSX, SDDC Manager, VCF Operations, VCF Automation`,
        ],
        backout: [
          'ESXi: pwsh ./ops/esxi-syslog.ps1 -DryRun shows the old value; set it back with Get-AdvancedSetting -Name Syslog.global.logHost | Set-AdvancedSetting -Value <old>, then esxcli system syslog reload',
          'vCenter: PUT /api/appliance/logging/forwarding with the cfg_list as it was (the script prints it)',
          'NSX: DELETE /api/v1/node/services/syslog/exporters/splunk on each Manager node',
          `Remove ${app} from the search heads${collector === 'hf' ? ' and the listener app from the heavy forwarders' : ' and the ops/sc4s entries from SC4S'}`,
        ],
        findings,
      };
    },
  }),

  // ---------------------------------------------------------------------------
  splunkBlueprint({
    id: 'splunk_onboard_estate',
    tier: TIER,
    label: 'Onboard the imported VM estate',
    group: 'Onboard what you built',
    description:
      'The imported estate’s VMs sorted by guest OS into deployment server classes — Windows servers, domain controllers, workstations, Linux families — each mapped to the Windows or Linux inputs app, with install target lists for the forwarder install scripts, a licence estimate per class, and a CSV of where every VM went and why.',
    inputs: [
      { id: 'app_name', label: 'App name', control: 'text', default: 'org_estate_onboarding' },
      { id: 'use_estate', label: 'VMs from the imported estate', control: 'toggle', default: true, hint: 'Falls back to the list below when no estate is loaded' },
      { id: 'vms', label: 'VMs', control: 'textarea', default: 'dc01,Microsoft Windows Server 2022 (64-bit)\ndc02,Microsoft Windows Server 2022 (64-bit)\napp01,Microsoft Windows Server 2019 (64-bit)\nvdi-001,Microsoft Windows 11 (64-bit)\nweb01,Red Hat Enterprise Linux 9 (64-bit)\ndb01,Ubuntu Linux (64-bit)\nvcsa01,VMware Photon OS (64-bit)', hint: 'name, guest OS[, poweredOn|poweredOff] — one per line' },
      { id: 'skip_off', label: 'Skip powered-off VMs and templates', control: 'toggle', default: true },
      { id: 'dc_pattern', label: 'Domain controllers are named like', control: 'text', default: '^(dc|ad)[0-9-]', hint: 'Regex on the VM name — RVTools cannot tell a DC from a member server' },
      { id: 'prefix', label: 'Server class prefix', control: 'text', default: 'org' },
      { id: 'win_server_app', label: 'Windows server inputs app', control: 'text', default: 'org_windows_inputs', hint: 'From "Windows event logs, Sysmon and perfmon" (splunk_windows_inputs), role Member servers' },
      { id: 'win_dc_app', label: 'Domain controller inputs app', control: 'text', default: 'org_windows_dc_inputs', hint: 'The same blueprint, role Domain controllers, under its own app name' },
      { id: 'win_ws_app', label: 'Workstation inputs app', control: 'text', default: 'org_windows_ws_inputs', hint: 'The same blueprint, role Workstations' },
      { id: 'linux_app', label: 'Linux inputs app', control: 'text', default: 'org_linux_inputs', hint: 'From "Linux logs, journald and OS metrics" (splunk_linux_inputs)' },
      { id: 'nix_ta', label: 'Also deploy Splunk_TA_nix to Linux', control: 'toggle', default: true, hint: 'Carries the OS metric scripts the Linux inputs app enables' },
      { id: 'outputs_app', label: 'Outputs app', control: 'text', default: 'org_forwarder_outputs', hint: 'From splunk_outputs' },
      { id: 'gb_win_server', label: 'GB/day per Windows server', control: 'number', default: 0.3, min: 0, max: 100 },
      { id: 'gb_dc', label: 'GB/day per domain controller', control: 'number', default: 3, min: 0, max: 500 },
      { id: 'gb_ws', label: 'GB/day per workstation', control: 'number', default: 0.05, min: 0, max: 100 },
      { id: 'gb_linux', label: 'GB/day per Linux server', control: 'number', default: 0.15, min: 0, max: 100 },
      { id: 'licence_gb', label: 'Licence (GB/day) available for this', control: 'number', default: 100, min: 0, max: 1000000 },
      { id: 'unknown_pct', label: 'Warn when unknown OS exceeds (%)', control: 'number', default: 10, min: 0, max: 100 },
    ],
    app: (values                 )            => {
      const app = splunkName(str(values, 'app_name', 'org_estate_onboarding'), 'org_estate_onboarding');
      const prefix = splunkName(str(values, 'prefix', 'org'), 'org');
      const skipOff = bool(values, 'skip_off', true);
      let dcPattern                = null;
      const findings            = [];
      try {
        const p = str(values, 'dc_pattern', '');
        dcPattern = p ? new RegExp(p, 'i') : null;
      } catch {
        findings.push(warning('splunk.estate-dc-pattern', 'The domain controller pattern is not a valid regular expression, so no VM is treated as a DC.', { source: SRC }));
      }
      const apps = {
        winServer: splunkName(str(values, 'win_server_app', 'org_windows_inputs'), 'org_windows_inputs'),
        winDc: splunkName(str(values, 'win_dc_app', 'org_windows_dc_inputs'), 'org_windows_dc_inputs'),
        winWs: splunkName(str(values, 'win_ws_app', 'org_windows_ws_inputs'), 'org_windows_ws_inputs'),
        linux: splunkName(str(values, 'linux_app', 'org_linux_inputs'), 'org_linux_inputs'),
        outputs: splunkName(str(values, 'outputs_app', 'org_forwarder_outputs'), 'org_forwarder_outputs'),
      };
      const nixTa = bool(values, 'nix_ta', true);
      const gb                                    = {
        windows_server: Math.max(0, num(values, 'gb_win_server', 0.3)),
        windows_dc: Math.max(0, num(values, 'gb_dc', 3)),
        windows_workstation: Math.max(0, num(values, 'gb_ws', 0.05)),
        linux_rhel: Math.max(0, num(values, 'gb_linux', 0.15)),
        linux_debian: Math.max(0, num(values, 'gb_linux', 0.15)),
        linux_suse: Math.max(0, num(values, 'gb_linux', 0.15)),
        linux_other: Math.max(0, num(values, 'gb_linux', 0.15)),
        appliance: 0,
        unknown: 0,
      };
      const licence = Math.max(0, num(values, 'licence_gb', 100));
      const unknownPct = Math.max(0, num(values, 'unknown_pct', 10));

      // --- the VMs ----------------------------------------------------------------
                                                                                                                                                    
      const inventory = bool(values, 'use_estate', true) ? currentEstate()?.inventory : undefined;
      const source                                                                                    = inventory
        ? inventory.vms.filter((v) => !v.srmPlaceholder).map((v) => ({
            name: v.name,
            address: hostAddress(v.dnsName) || hostAddress(v.name) || hostAddress(v.ipAddress),
            os: v.guestOsTools || v.guestOs || '',
            power: v.powerState,
            template: Boolean(v.template),
          }))
        : linesOf(str(values, 'vms', '')).map((line) => {
            const parts = line.split(',').map((p) => p.trim());
            const name = parts[0] ?? '';
            const last = parts[parts.length - 1] ?? '';
            const power = parts.length >= 3 && /^powered(on|off)$|^suspended$/i.test(last) ? last : 'poweredOn';
            const os = (parts.length >= 3 && power === last ? parts.slice(1, -1) : parts.slice(1)).join(', ');
            return { name, address: hostAddress(name), os, power: /off/i.test(power) ? 'poweredOff' : /susp/i.test(power) ? 'suspended' : 'poweredOn', template: false };
          });
      if (bool(values, 'use_estate', true) && !inventory) {
        findings.push(info('splunk.estate-none', 'No estate is loaded, so the VM list on the form was used. Import an RVTools export and every VM is classified from what VMware Tools reports.', { source: SRC }));
      }

      const rows        = source.map((v) => {
        const cls = classify(v.os, v.name, dcPattern);
        let included = true;
        let reason = '';
        if (v.template) {
          included = false;
          reason = 'template';
        } else if (skipOff && v.power !== 'poweredOn') {
          included = false;
          reason = v.power;
        } else if (cls === 'appliance') {
          included = false;
          reason = 'appliance — collect by syslog, not a forwarder';
        } else if (cls === 'unknown') {
          included = false;
          reason = 'guest OS unknown';
        } else if (!v.address) {
          included = false;
          reason = 'no usable host name or address';
        }
        return { ...v, cls, included, reason };
      });

      const classes                                                                         = [
        { cls: 'windows_server', name: `${prefix}_windows_servers`, apps: [apps.winServer], machineTypes: 'windows-x64' },
        { cls: 'windows_dc', name: `${prefix}_windows_dcs`, apps: [apps.winDc], machineTypes: 'windows-x64' },
        { cls: 'windows_workstation', name: `${prefix}_windows_workstations`, apps: [apps.winWs], machineTypes: 'windows-x64' },
        { cls: 'linux_rhel', name: `${prefix}_linux_rhel`, apps: [apps.linux, ...(nixTa ? ['Splunk_TA_nix'] : [])], machineTypes: 'linux-x86_64, linux-aarch64' },
        { cls: 'linux_debian', name: `${prefix}_linux_debian`, apps: [apps.linux, ...(nixTa ? ['Splunk_TA_nix'] : [])], machineTypes: 'linux-x86_64, linux-aarch64' },
        { cls: 'linux_suse', name: `${prefix}_linux_suse`, apps: [apps.linux, ...(nixTa ? ['Splunk_TA_nix'] : [])], machineTypes: 'linux-x86_64, linux-aarch64' },
        { cls: 'linux_other', name: `${prefix}_linux_other`, apps: [apps.linux, ...(nixTa ? ['Splunk_TA_nix'] : [])], machineTypes: 'linux-x86_64, linux-aarch64' },
      ];
      const classOf = (c         ) => classes.find((k) => k.cls === c);
      const members = (c         ) => [...new Set(rows.filter((r) => r.included && r.cls === c).map((r) => r.address))].sort();
      const allIncluded = [...new Set(rows.filter((r) => r.included).map((r) => r.address))].sort();
      const considered = rows.filter((r) => !r.template && (!skipOff || r.power === 'poweredOn'));
      const unknown = considered.filter((r) => r.cls === 'unknown');

      const volume = (Object.keys(CLASS_LABEL)             ).map((c) => ({ cls: c, count: members(c).length, gb: members(c).length * gb[c] }));
      const total = Math.round(volume.reduce((s, v) => s + v.gb, 0) * 100) / 100;

      if (considered.length > 0 && (unknown.length / considered.length) * 100 > unknownPct) {
        findings.push(
          warning('splunk.estate-unknown-os', `${unknown.length} of ${considered.length} VMs (${Math.round((unknown.length / considered.length) * 100)}%) have no guest OS Splunk can place: VMware Tools is not running or not installed, or the configured OS is "Other". They get no forwarder and no inputs, and they are exactly the machines nobody is watching.`, {
            remediation: 'Fix VMware Tools on them (the configured OS is often wrong; the Tools-reported one is not), re-export RVTools, and re-run — or list them by hand with their OS.',
            source: SRC,
          }),
        );
      }
      if (licence > 0 && total > licence) {
        findings.push(
          warning('splunk.estate-over-licence', `The estimate is ${total} GB/day against ${licence} GB/day available. Onboarding all of it at once takes the deployment into licence warnings in the first week — and five warnings in a rolling 30 days blocks search on Splunk Enterprise licences that enforce it.`, {
            remediation: 'Onboard in waves by server class, measure each wave with the licence search in DEPLOY.md, and trim the noisiest sources (the Windows lean profile, domain controller 4662 filtering) before the next.',
            source: SRC,
          }),
        );
      }
      if (allIncluded.length === 0) findings.push(warning('splunk.estate-empty', 'No VMs end up in any server class.', { source: SRC }));
      const dcs = members('windows_dc').length;
      if (dcPattern && dcs === 0 && members('windows_server').length > 0) {
        findings.push(info('splunk.estate-no-dcs', 'No Windows server matched the domain controller pattern. If there are DCs in this estate they are in the member-server class and will get the member-server inputs — without the 4662 filtering a DC needs.', { source: SRC }));
      }

      // --- serverclass.conf -----------------------------------------------------
      const INLINE_MAX = 500;
      // A whitelist entry is matched against the client's host name, DNS name,
      // IP and client name. The estate gives the guest's FQDN where Tools
      // reported one, and a forwarder often reports only its short name, so
      // both are listed.
      const entries = (hosts          ) => [...new Set(hosts.flatMap((h) => (/^\d+\.\d+\.\d+\.\d+$|:/.test(h) || !h.includes('.') ? [h] : [h, h.split('.')[0] ])))];
      const serverclass           = [
        '# Merge into $SPLUNK_HOME/etc/system/local/serverclass.conf on the deployment',
        '# server (or an app’s local/ directory there), then: splunk reload deploy-server',
        '# Whitelists match the client’s host name, DNS name, IP or client name.',
        '# machineTypesFilter stops a Linux app landing on a Windows host whose',
        '# name happens to match.',
        '',
        '[global]',
        '# Restart only where an app needs it (inputs do; the apps below say so).',
        'restartSplunkd = false',
        '',
        `[serverClass:${prefix}_all_forwarders]`,
        '# Every forwarder in the estate gets the outputs app.',
        ...(allIncluded.length <= INLINE_MAX
          ? entries(allIncluded).map((h, i) => `whitelist.${i} = ${h}`)
          : [`whitelist.from_pathname = etc/apps/${app}/lookups/${prefix}_all_forwarders.csv`, 'whitelist.select_field = host']),
        '',
        `[serverClass:${prefix}_all_forwarders:app:${apps.outputs}]`,
        'restartSplunkd = true',
        'stateOnClient = enabled',
        '',
        ...classes.flatMap((k) => {
          const hosts = members(k.cls);
          if (hosts.length === 0) return [`# ${k.name}: no VMs in this estate`, ''];
          return [
            `# ${CLASS_LABEL[k.cls]} — ${hosts.length} VM${hosts.length === 1 ? '' : 's'}, about ${Math.round(hosts.length * gb[k.cls] * 100) / 100} GB/day`,
            `[serverClass:${k.name}]`,
            ...(hosts.length <= INLINE_MAX
              ? entries(hosts).map((h, i) => `whitelist.${i} = ${h}`)
              : [`# ${hosts.length} hosts: read from a CSV rather than listed inline. VERIFY the path is relative to $SPLUNK_HOME.`, `whitelist.from_pathname = etc/apps/${app}/lookups/${k.name}.csv`, 'whitelist.select_field = host']),
            `machineTypesFilter = ${k.machineTypes}`,
            '',
            ...k.apps.flatMap((a) => [`[serverClass:${k.name}:app:${a}]`, 'restartSplunkd = true', 'stateOnClient = enabled', '']),
          ];
        }),
      ];

      const bigLists                           = {};
      if (allIncluded.length > INLINE_MAX) bigLists[`lookups/${prefix}_all_forwarders.csv`] = ['host', ...entries(allIncluded)];
      for (const k of classes) {
        const hosts = members(k.cls);
        if (hosts.length > INLINE_MAX) bigLists[`lookups/${k.name}.csv`] = ['host', ...entries(hosts)];
      }

      const windowsTargets = [...new Set([...members('windows_server'), ...members('windows_dc'), ...members('windows_workstation')])].sort();
      const linuxTargets = [...new Set([...members('linux_rhel'), ...members('linux_debian'), ...members('linux_suse'), ...members('linux_other')])].sort();

      const vmCsv = [
        'vm,host,guest_os,power_state,class,serverclass,included,reason,est_gb_day',
        ...rows
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) =>
            [r.name, r.address, r.os, r.power, r.cls, r.included ? (classOf(r.cls)?.name ?? '') : '', r.included ? 'yes' : 'no', r.reason, r.included ? gb[r.cls] : 0].map(csvCell).join(','),
          ),
      ];
      const lookupCsv = [
        'host,serverclass,est_gb_day',
        ...rows.filter((r) => r.included).map((r) => [r.address.toLowerCase(), classOf(r.cls)?.name ?? '', gb[r.cls]].map(csvCell).join(',')),
      ];
      const volumeCsv = [
        'class,label,vms,gb_per_vm_day,gb_day',
        ...volume.filter((v) => v.count > 0).map((v) => [v.cls, CLASS_LABEL[v.cls], v.count, gb[v.cls], Math.round(v.gb * 100) / 100].map(csvCell).join(',')),
        ['total', '', allIncluded.length, '', total].map(csvCell).join(','),
      ];

      const skipped = rows.filter((r) => !r.included);
      const skippedBy = [...new Set(skipped.map((r) => r.reason))].map((reason) => `${skipped.filter((r) => r.reason === reason).length} ${reason}`).join(', ');

      return {
        tier: TIER,
        title: `Onboard ${allIncluded.length} VM${allIncluded.length === 1 ? '' : 's'} in ${classes.filter((k) => members(k.cls).length > 0).length} server classes, about ${total} GB/day`,
        app,
        activation: 'reload',
        notes: [
          inventory ? `VMs come from the imported estate (${currentEstate()?.origin ?? 'current estate'}), classified by the guest OS VMware Tools reports, falling back to the configured one.` : 'VMs come from the list on the form.',
          `Included: ${volume.filter((v) => v.count > 0 && gb[v.cls] > 0).map((v) => `${v.count} ${CLASS_LABEL[v.cls].toLowerCase()}`).join(', ') || 'none'}. Left out: ${skippedBy || 'none'}. ops/vm-serverclass.csv has every VM and the reason.`,
          `Build the inputs apps first with the forwarder-tier blueprints: "Windows event logs, Sysmon and perfmon" (splunk_windows_inputs) three times — Member servers as ${apps.winServer}, Domain controllers as ${apps.winDc}, Workstations as ${apps.winWs} — and "Linux logs, journald and OS metrics" (splunk_linux_inputs) as ${apps.linux}; the outputs app with splunk_outputs as ${apps.outputs}. Put them all in $SPLUNK_HOME/etc/deployment-apps on the deployment server.`,
          `Install the forwarder with "Universal forwarder install and deployment client" (splunk_uf_install), using ops/uf-targets-windows.txt and ops/uf-targets-linux.txt as its host lists. Forwarders arrive, phone home, and pick up their apps from these classes.`,
          `The licence estimate is a planning number: ${total} GB/day from the per-class figures on the form. Measure the first wave (the licence search below) and replace the figures with what you see before onboarding the rest.`,
          'Appliances (Photon OS — vCenter, NSX, VCF Operations — and anything else marked as an appliance) get no forwarder: it is unsupported on them and removed at the next upgrade. Collect them by syslog (the VCF onboarding blueprint).',
          'Domain controllers are recognised by name only (the pattern on the form). Check the DC class against Active Directory — Get-ADDomainController -Filter * — before deploying: a DC in the member-server class gets no 4662 filtering and becomes the largest source in the deployment.',
        ],
        before: [
          '$SPLUNK_HOME/bin/splunk btool serverclass list --debug   # on the deployment server: existing classes that might also match these hosts',
          `ls $SPLUNK_HOME/etc/deployment-apps/   # ${[apps.outputs, apps.winServer, apps.winDc, apps.winWs, apps.linux, ...(nixTa ? ['Splunk_TA_nix'] : [])].join(', ')} present`,
          '| rest /services/deployment/server/clients splunk_server=local | stats count by utsname   # what has already phoned home',
          'index=_internal source=*license_usage.log* type=RolloverSummary earliest=-30d | timechart span=1d sum(b) as bytes | eval GB=round(bytes/1024/1024/1024,2)   # current daily use, on the licence manager',
        ],
        files: {
          'default/app.conf': appConfLines(app, 'Estate onboarding', 'Estate VMs by deployment server class, with the licence estimate'),
          'default/transforms.conf': ['[estate_serverclass]', 'filename = estate_serverclass.csv', 'case_sensitive_match = false'],
          'lookups/estate_serverclass.csv': lookupCsv,
          ...bigLists,
          'metadata/default.meta': defaultMeta(),
          'ops/deployment-server/serverclass.conf': serverclass,
          'ops/uf-targets-windows.txt': windowsTargets.length > 0 ? windowsTargets : ['# no Windows hosts'],
          'ops/uf-targets-linux.txt': linuxTargets.length > 0 ? linuxTargets : ['# no Linux hosts'],
          'ops/vm-serverclass.csv': vmCsv,
          'ops/licence-estimate.csv': volumeCsv,
        },
        verify: [
          'splunk reload deploy-server   # on the deployment server, after merging serverclass.conf',
          '| rest /services/deployment/server/clients splunk_server=local | table hostname, ip, utsname, serverClasses, lastPhoneHomeTime',
          `| inputlookup estate_serverclass.csv | join type=left host [| rest /services/deployment/server/clients splunk_server=local | eval host=lower(hostname) | fields host, lastPhoneHomeTime] | where isnull(lastPhoneHomeTime) | stats count by serverclass   # expected forwarders not yet phoning home`,
          'index=_internal source=*license_usage.log* type=Usage earliest=-1d@d latest=@d | stats sum(b) as bytes by h | eval host=lower(h) | lookup estate_serverclass.csv host OUTPUT serverclass, est_gb_day | stats sum(bytes) as bytes, sum(est_gb_day) as estimate_gb by serverclass | eval actual_gb=round(bytes/1024/1024/1024,2)   # actual against estimate, per class (h is blank when the licence manager squashes hosts)',
        ],
        backout: [
          `Remove the ${prefix}_* server classes from serverclass.conf on the deployment server, then: splunk reload deploy-server`,
          '# Forwarders then remove the apps those classes delivered (stateOnClient) and restart; the forwarders themselves stay installed.',
        ],
        findings,
      };
    },
  }),
];

/**
 * The Splunk fields whose answers come from a known set, offered as dropdowns.
 *
 * Every Splunk blueprint names indexes, sourcetypes, time ranges and the like
 * in free text. Where the answer is one of a known set the field becomes a
 * dropdown you can still type into ("Other — type a value…"), and the same
 * field offers the same choices in every blueprint. Indexes defined in the
 * Index blueprint on this page are offered first.
 */

                                                                        

const group = (name        , values                   )                 => values.map((value) => ({ value, label: value, group: name }));

/** The key under which the page remembers index names defined on it. */
export const INDEX_MEMORY = 'splunk.indexes';

const EVENT_INDEXES                          = [
  ...group('Operating systems', ['os', 'wineventlog', 'windows', 'linux', 'sysmon']),
  ...group('Network', ['network', 'netfw', 'netops', 'netproxy', 'netdns', 'netids']),
  ...group('VMware and VCF', ['vmware-esxilog', 'vmware-vclog', 'vcf', 'nsx']),
  ...group('Cloud and containers', ['aws', 'azure', 'gcp', 'k8s_logs']),
  ...group('Applications', ['app', 'app_prod', 'app_nonprod', 'web', 'db', 'cmdb']),
  ...group('Splunk defaults', ['main', 'summary']),
];

const METRICS_INDEXES                          = [...group('Metrics', ['os_metrics', 'app_metrics', 'k8s_metrics', 'vmware_metrics', 'em_metrics'])];

const SOURCETYPES                          = [
  ...group('Windows', ['XmlWinEventLog', 'WinEventLog:Security', 'WinEventLog:System', 'WinEventLog:Application', 'XmlWinEventLog:Microsoft-Windows-Sysmon/Operational', 'Perfmon:CPU', 'Perfmon:Memory']),
  ...group('Linux and Unix', ['linux_secure', 'syslog', 'linux_audit', 'journald', 'df', 'cpu', 'vmstat']),
  ...group('Network', ['cisco:asa', 'cisco:ios', 'cisco:ftd:syslog', 'pan:traffic', 'pan:threat', 'pan:system', 'pan:config', 'fortigate_traffic', 'fortigate_utm', 'fortigate_event', 'juniper:junos:firewall', 'sc4s:fallback']),
  ...group('VMware and VCF', ['vmware:esxlog', 'vmware:vclog', 'vmware:nsxlog', 'vcf:syslog', 'vmw-syslog']),
  ...group('Cloud', ['aws:cloudtrail', 'aws:cloudwatchlogs:vpcflow', 'aws:s3:accesslogs', 'aws:config', 'mscs:azure:eventhub', 'azure:monitor:aad', 'azure:monitor:activity', 'google:gcp:pubsub:message']),
  ...group('Web and applications', ['access_combined', 'app:json', 'app:events', '_json']),
];

const TIME_RANGES                          = [
  { value: '-15m@m', label: 'Last 15 minutes' },
  { value: '-60m@m', label: 'Last 60 minutes' },
  { value: '-4h@h', label: 'Last 4 hours' },
  { value: '-24h@h', label: 'Last 24 hours' },
  { value: '-7d@d', label: 'Last 7 days' },
  { value: '-30d@d', label: 'Last 30 days' },
];

const TIMEZONES                          = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
].map((value) => ({ value, label: value }));

const AWS_REGIONS                          = group('AWS', [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2', 'ca-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'sa-east-1', 'me-central-1', 'af-south-1',
]);

const FIELDS                          = group('Common fields', ['host', 'src', 'src_ip', 'dest', 'dest_ip', 'user', 'signature', 'action', 'app', 'status', 'sourcetype', 'source', 'environment']);

const TIME_FORMATS                          = [
  { value: '%Y-%m-%dT%H:%M:%S.%3N%z', label: 'ISO 8601 with milliseconds and zone (2026-09-24T10:15:30.123+0000)' },
  { value: '%Y-%m-%dT%H:%M:%S%z', label: 'ISO 8601 with zone (2026-09-24T10:15:30+0000)' },
  { value: '%Y-%m-%d %H:%M:%S', label: 'Date and time (2026-09-24 10:15:30)' },
  { value: '%Y-%m-%d %H:%M:%S,%3N', label: 'Date and time with milliseconds, comma (log4j)' },
  { value: '%b %d %H:%M:%S', label: 'Syslog RFC 3164 (Sep 24 10:15:30)' },
  { value: '%d/%b/%Y:%H:%M:%S %z', label: 'Apache access log (24/Sep/2026:10:15:30 +0000)' },
  { value: '%s', label: 'Epoch seconds' },
  { value: '%s%3N', label: 'Epoch milliseconds' },
];

const LINE_BREAKERS                          = [
  { value: '([\\r\\n]+)', label: 'Every line is an event' },
  { value: '([\\r\\n]+)(?=\\d{4}-\\d{2}-\\d{2}T)', label: 'New event at an ISO date (2026-09-24T…)' },
  { value: '([\\r\\n]+)(?=\\d{4}-\\d{2}-\\d{2} )', label: 'New event at a date and time (2026-09-24 …)' },
  { value: '([\\r\\n]+)(?=\\w{3} +\\d{1,2} \\d{2}:)', label: 'New event at a syslog date (Sep 24 10:…)' },
  { value: '([\\r\\n]+)(?=\\{)', label: 'New event at a JSON object' },
];

const REPLICATION                          = [
  { value: 'origin:2,total:3', label: 'origin:2,total:3 — two copies at the origin site, three in all' },
  { value: 'origin:1,total:2', label: 'origin:1,total:2 — one at the origin, two in all' },
  { value: 'origin:2,total:4', label: 'origin:2,total:4 — two at each of two sites' },
  { value: 'origin:1,site1:1,site2:1,total:3', label: 'origin:1,site1:1,site2:1,total:3 — one per named site' },
];

const QUEUE_SIZES                          = ['auto', '1MB', '5MB', '10MB', '20MB', '50MB'].map((value) => ({ value, label: value }));
const KV_DELIMS                          = [
  { value: '=', label: '= (key=value)' },
  { value: ':', label: ': (key:value)' },
];
const PAIR_DELIMS                          = [
  { value: ',', label: ', (comma)' },
  { value: ' ', label: 'space' },
  { value: ';', label: '; (semicolon)' },
  { value: '|', label: '| (pipe)' },
];

                  
                                            
                                                           
                          
 

/** Field id → its choices. Only single-value fields: a list stays typed. */
const CHOICES                                   = {
  index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  default_index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  esxi_index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  vc_index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  vcf_index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  netfw_index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  netops_index: { options: EVENT_INDEXES, offer: INDEX_MEMORY },
  metrics_index: { options: METRICS_INDEXES, offer: INDEX_MEMORY },
  sourcetype: { options: SOURCETYPES },
  timerange: { options: TIME_RANGES },
  tz: { options: TIMEZONES },
  throttle_field: { options: FIELDS },
  aggregation_field: { options: FIELDS },
  filter_field: { options: FIELDS },
  time_format: { options: TIME_FORMATS },
  line_breaker: { options: LINE_BREAKERS },
  site_rf: { options: REPLICATION },
  site_sf: { options: REPLICATION },
  queue_size: { options: QUEUE_SIZES },
  kv_delims: { options: KV_DELIMS },
  pair_delims: { options: PAIR_DELIMS },
};

/** Blueprint ids whose `region` is an AWS region (S3 for SmartStore and Ingest Actions). */
const AWS_REGION_BLUEPRINTS = new Set(['splunk_smartstore', 'splunk_ingest_actions']);

/** The input, as a dropdown when its answers are known. A field that is already a dropdown is left alone. */
export function withSplunkChoices(input                , blueprintId        )                 {
  if (input.control !== 'text') return input;
  if (input.id === 'index_name' && blueprintId === 'splunk_index') return { ...input, remember: INDEX_MEMORY };
  const choice = input.id === 'region' && AWS_REGION_BLUEPRINTS.has(blueprintId) ? { options: AWS_REGIONS } : CHOICES[input.id];
  if (!choice) return input;
  // The field's own default stays on offer even when it is not one of the common answers.
  const own = String(input.default ?? '');
  const options = own && !choice.options.some((o) => o.value === own) ? [{ value: own, label: own }, ...choice.options] : choice.options;
  return { ...input, control: 'combo', options, ...(choice.offer ? { offer: choice.offer } : {}) };
}

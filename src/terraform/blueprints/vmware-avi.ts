/**
 * Hand-written avi scenario blueprints: several resources built together.
 *
 *   Applications  an HTTP(S) virtual service with its pool, health monitor,
 *                 VIP and certificate; an L4 TCP/UDP virtual service; a
 *                 blue/green pool group; the same HTTP(S) service behind a WAF
 *                 policy, and with an HTTP policy set of redirects and headers
 *   Global        a GSLB service spread across two sites
 *   Platform      a vCenter cloud and a sized Service Engine group
 *
 * Avi objects point at each other through `*_ref` arguments holding the other
 * object's `.id` (its API URL). System objects every controller ships with —
 * application, network and SSL profiles, the default cloud and SE group — are
 * looked up by name rather than created. Avi's provider types nearly every
 * scalar as a string, so numbers and booleans are written quoted.
 */

import type { Blueprint, BlueprintInput } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { scenario, q, qlist, items, pairs, ident, on, n } from './scenario-common.ts';
import { data, list, output, resource, sensitiveVariable, uniqueIdents, type Blk, type Item } from './hcl-builder.ts';

// --- helpers -------------------------------------------------------------------

/** An Avi scalar: the provider types numbers and booleans as strings. */
function s(value: string | number | boolean): string {
  return q(String(value));
}

function ipType(addr: string): string {
  return addr.includes(':') ? 'V6' : 'V4';
}

function ipAddr(block: string, addr: string): Blk {
  return { b: block, body: [['addr', q(addr)], ['type', q(ipType(addr))]] };
}

interface Server {
  readonly addr: string;
  readonly port: string;
}

/** "10.0.0.1:8080", "10.0.0.1", "[2001:db8::1]:8080" or "2001:db8::1", one per line. */
function parseServers(value: unknown, defaultPort: string, findings: Finding[], path: string): Server[] {
  const out: Server[] = [];
  for (const line of items(String(value ?? '').replace(/\s+/g, '\n'))) {
    const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(line);
    const v4 = /^([\d.]+)(?::(\d+))?$/.exec(line);
    if (v6) out.push({ addr: v6[1] as string, port: v6[2] ?? defaultPort });
    else if (v4) out.push({ addr: v4[1] as string, port: v4[2] ?? defaultPort });
    else if (/^[0-9a-f:]+$/i.test(line) && line.includes(':')) out.push({ addr: line, port: defaultPort });
    else findings.push(error('avi.pool.server', `"${line}" is not ip:port.`, { path, remediation: 'Write IPv6 servers as [2001:db8::10]:8080.' }));
  }
  if (out.length === 0) findings.push(warning('avi.pool.empty', 'The pool has no servers yet.', { path }));
  return out;
}

function serverBlocks(servers: readonly Server[], extra: (i: number) => Item[] = () => []): Blk[] {
  return servers.map((srv, i) => ({ b: 'servers', body: [['port', s(srv.port)], ['enabled', s(true)], ...extra(i), ipAddr('ip', srv.addr)] }));
}

const CLOUD_INPUTS: BlueprintInput[] = [
  { id: 'cloud_name', label: 'Cloud', control: 'text', default: 'Default-Cloud', hint: 'existing, looked up' },
  { id: 'se_group_name', label: 'Service Engine group', control: 'text', default: 'Default-Group', hint: 'existing, looked up' },
];

function cloudLookups(v: Record<string, unknown>): string[] {
  return [
    data('avi_cloud', 'cloud', [['name', q(v.cloud_name)]]),
    data('avi_serviceenginegroup', 'se', [['name', q(v.se_group_name)], ['cloud_ref', 'data.avi_cloud.cloud.id']]),
  ];
}

function vipInputs(defaultAddress: string, section?: string): BlueprintInput[] {
  const at = section ? { section } : {};
  return [
    {
      id: 'vip_mode',
      label: 'VIP address',
      control: 'select',
      options: [
        { value: 'static', label: 'Static address' },
        { value: 'auto', label: 'Allocate from a network (IPAM)' },
      ],
      default: 'static',
      ...at,
    },
    { id: 'vip_address', label: 'VIP', control: 'text', default: defaultAddress, hint: 'IPv4 or IPv6', showWhen: { input: 'vip_mode', equals: ['static'] }, ...at },
    { id: 'vip_network', label: 'VIP network', control: 'text', default: 'vip-net-01', hint: 'Avi network, looked up', showWhen: { input: 'vip_mode', equals: ['auto'] }, ...at },
    { id: 'vip_subnet', label: 'VIP subnet', control: 'text', default: '10.10.50.0/24', showWhen: { input: 'vip_mode', equals: ['auto'] }, ...at },
    { id: 'fqdn', label: 'FQDN', control: 'text', default: '', hint: 'registered through the cloud DNS profile; empty for none', ...at },
  ];
}

/** The VsVip, plus the network lookup an allocated VIP needs. */
function vsvip(name: string, v: Record<string, unknown>, findings: Finding[]): string[] {
  const out: string[] = [];
  let vip: Blk;
  if (v.vip_mode === 'auto') {
    const [subnet = '', mask = ''] = String(v.vip_subnet ?? '').split('/');
    if (mask === '') findings.push(error('avi.vip.subnet', 'The VIP subnet needs a prefix length, such as 10.10.50.0/24.', { path: 'vip_subnet' }));
    out.push(data('avi_network', 'vip', [['name', q(v.vip_network)], ['cloud_ref', 'data.avi_cloud.cloud.id']]));
    vip = {
      b: 'vip',
      body: [
        ['vip_id', s(0)],
        ['auto_allocate_ip', s(true)],
        ['auto_allocate_ip_type', q(ipType(subnet) === 'V6' ? 'V6_ONLY' : 'V4_ONLY')],
        { b: 'ipam_network_subnet', body: [['network_ref', 'data.avi_network.vip.id'], { b: 'subnet', body: [['mask', s(mask || 24)], ipAddr('ip_addr', subnet)] }] },
      ],
    };
  } else {
    const addr = String(v.vip_address ?? '').trim();
    vip = { b: 'vip', body: [['vip_id', s(0)], ipAddr(ipType(addr) === 'V6' ? 'ip6_address' : 'ip_address', addr)] };
  }
  const fqdn = String(v.fqdn ?? '').trim();
  out.push(
    resource('avi_vsvip', 'this', [
      ['name', q(`${name}-vip`)],
      ['cloud_ref', 'data.avi_cloud.cloud.id'],
      vip,
      fqdn !== '' && { b: 'dns_info', body: [['fqdn', q(fqdn)]] },
    ]),
  );
  return out;
}

const LB_ALGORITHM_OPTIONS = [
  { value: 'LB_ALGORITHM_LEAST_CONNECTIONS', label: 'Least connections' },
  { value: 'LB_ALGORITHM_ROUND_ROBIN', label: 'Round robin' },
  { value: 'LB_ALGORITHM_FASTEST_RESPONSE', label: 'Fastest response' },
  { value: 'LB_ALGORITHM_LEAST_LOAD', label: 'Least load' },
  { value: 'LB_ALGORITHM_CONSISTENT_HASH', label: 'Consistent hash (source IP)' },
  { value: 'LB_ALGORITHM_FEWEST_SERVERS', label: 'Fewest servers' },
  { value: 'LB_ALGORITHM_RANDOM', label: 'Random' },
];

const HTTP_CODE_OPTIONS = [
  { value: 'HTTP_2XX', label: '2xx' },
  { value: 'HTTP_3XX', label: '3xx' },
  { value: 'HTTP_4XX', label: '4xx' },
  { value: 'HTTP_5XX', label: '5xx' },
];

/** Monitor timers, shared by every monitor these scenarios create. */
const MONITOR_TIMER_INPUTS: BlueprintInput[] = [
  { id: 'hm_interval', label: 'Send interval', control: 'number', default: 10, hint: 'seconds', section: 'Health monitor timers' },
  { id: 'hm_timeout', label: 'Receive timeout', control: 'number', default: 4, hint: 'seconds, less than the interval', section: 'Health monitor timers' },
  { id: 'hm_up', label: 'Successful checks to mark up', control: 'number', default: 2, section: 'Health monitor timers' },
  { id: 'hm_down', label: 'Failed checks to mark down', control: 'number', default: 3, section: 'Health monitor timers' },
];

function monitorTimers(v: Record<string, unknown>): Item[] {
  return [
    ['send_interval', s(n(v.hm_interval, 10))],
    ['receive_timeout', s(n(v.hm_timeout, 4))],
    ['successful_checks', s(n(v.hm_up, 2))],
    ['failed_checks', s(n(v.hm_down, 3))],
  ];
}

/** An HTTP or HTTPS GET monitor. */
function httpMonitor(name: string, v: Record<string, unknown>, tls: boolean): string {
  const codes = items(v.hm_codes);
  return resource('avi_healthmonitor', 'this', [
    ['name', q(`${name}-hm`)],
    ['type', q(tls ? 'HEALTH_MONITOR_HTTPS' : 'HEALTH_MONITOR_HTTP')],
    ...monitorTimers(v),
    {
      b: tls ? 'https_monitor' : 'http_monitor',
      body: [
        ['http_request', q(`GET ${v.hm_path || '/'} HTTP/1.0`)],
        ['http_response_code', qlist((codes.length > 0 ? codes : ['HTTP_2XX']).join(','))],
        tls && { b: 'ssl_attributes', body: [['ssl_profile_ref', 'data.avi_sslprofile.standard.id']] },
      ],
    },
  ]);
}

// --- HTTP(S) virtual service, shared by three scenarios --------------------------

/** The inputs of an HTTP(S) virtual service, in `section` when it is not the scenario's focus. */
function httpVsInputs(section?: string): BlueprintInput[] {
  const at = section ? { section } : {};
  return [
    { id: 'vs_name', label: 'Virtual service name', control: 'text', default: 'www-prod', ...at },
    ...CLOUD_INPUTS.map((i) => ({ ...i, ...at })),
    ...vipInputs('10.10.50.10', section),
    { id: 'servers', label: 'Pool servers', control: 'textarea', default: '10.10.10.11:8080\n10.10.10.12:8080\n10.10.10.13:8080', hint: 'ip:port, one per line', ...at },
    { id: 'server_port', label: 'Default server port', control: 'number', default: 8080, hint: 'for servers given without one', ...at },
    { id: 'lb_algorithm', label: 'Load balancing', control: 'select', options: LB_ALGORITHM_OPTIONS, default: 'LB_ALGORITHM_LEAST_CONNECTIONS', ...at },
    {
      id: 'persistence',
      label: 'Persistence',
      control: 'select',
      options: [
        { value: 'System-Persistence-Http-Cookie', label: 'HTTP cookie' },
        { value: 'System-Persistence-Client-IP', label: 'Client IP' },
      ],
      blankLabel: 'None',
      ...at,
    },
    { id: 'server_tls', label: 'Re-encrypt to the servers', control: 'toggle', default: false, hint: 'servers listen on TLS', ...at },
    { id: 'hm_path', label: 'Health check path', control: 'text', default: '/healthz', ...at },
    { id: 'hm_codes', label: 'Healthy response codes', control: 'checklist', options: HTTP_CODE_OPTIONS, default: 'HTTP_2XX,HTTP_3XX', ...at },
    { id: 'tls', label: 'HTTPS', control: 'select', options: [{ value: 'true', label: 'HTTPS on 443 (System-Secure-HTTP)' }, { value: 'false', label: 'HTTP on 80 only (System-HTTP)' }], default: 'true', ...at },
    {
      id: 'cert_source',
      label: 'Certificate',
      control: 'select',
      options: [
        { value: 'existing', label: 'Existing certificate on the controller' },
        { value: 'import', label: 'Import PEM (var.tls_certificate, var.tls_private_key)' },
      ],
      default: 'existing',
      showWhen: { input: 'tls', equals: ['true'] },
      ...at,
    },
    { id: 'cert_name', label: 'Certificate name', control: 'text', default: 'System-Default-Cert', hint: 'looked up', showWhen: { input: 'cert_source', equals: ['existing'] }, ...at },
    { id: 'cert_object_name', label: 'Name for the imported certificate', control: 'text', default: 'www.example.com', showWhen: { input: 'cert_source', equals: ['import'] }, ...at },
    { id: 'redirect_http', label: 'Redirect HTTP to HTTPS', control: 'toggle', default: true, hint: 'listens on 80 too', showWhen: { input: 'tls', equals: ['true'] }, ...at },
    ...MONITOR_TIMER_INPUTS,
  ];
}

const HTTP_VS_EMITS = ['avi_healthmonitor', 'avi_pool', 'avi_vsvip', 'avi_sslkeyandcertificate', 'avi_httppolicyset', 'avi_virtualservice'];

interface HttpVsExtras {
  readonly wafPolicyRef?: string;
  /** HTTP policy sets to attach, in order. */
  readonly httpPolicyRefs?: readonly string[];
}

function httpVirtualService(v: Record<string, unknown>, findings: Finding[], extras: HttpVsExtras = {}): string[] {
  const name = String(v.vs_name ?? 'vs').trim() || 'vs';
  const tls = on(v.tls);
  const serverTls = on(v.server_tls);
  const importCert = tls && v.cert_source === 'import';
  const redirect = tls && on(v.redirect_http);
  const persistence = String(v.persistence ?? '').trim();
  const servers = parseServers(v.servers, String(n(v.server_port, 80)), findings, 'servers');
  const out: string[] = [
    ...cloudLookups(v),
    data('avi_applicationprofile', 'http', [['name', q(tls ? 'System-Secure-HTTP' : 'System-HTTP')]]),
    tls || serverTls ? data('avi_sslprofile', 'standard', [['name', q('System-Standard')]]) : '',
    persistence !== '' ? data('avi_applicationpersistenceprofile', 'this', [['name', q(persistence)]]) : '',
    tls && !importCert ? data('avi_sslkeyandcertificate', 'this', [['name', q(v.cert_name)]]) : '',
  ];
  if (importCert) {
    out.push(
      `variable "tls_certificate" {\n  description = "PEM certificate (and chain) for ${name}"\n  type        = string\n}`,
      sensitiveVariable('tls_private_key', `PEM private key for ${name}`),
      resource('avi_sslkeyandcertificate', 'this', [
        ['name', q(v.cert_object_name)],
        ['type', q('SSL_CERTIFICATE_TYPE_VIRTUALSERVICE')],
        ['format', q('SSL_PEM')],
        ['key', 'var.tls_private_key'],
        { b: 'certificate', body: [['certificate', 'var.tls_certificate']] },
      ]),
    );
  }
  out.push(httpMonitor(name, v, serverTls));
  out.push(
    resource('avi_pool', 'this', [
      ['name', q(`${name}-pool`)],
      ['cloud_ref', 'data.avi_cloud.cloud.id'],
      ['lb_algorithm', q(v.lb_algorithm)],
      v.lb_algorithm === 'LB_ALGORITHM_CONSISTENT_HASH' && ['lb_algorithm_hash', q('LB_ALGORITHM_CONSISTENT_HASH_SOURCE_IP_ADDRESS')],
      ['default_server_port', s(n(v.server_port, 80))],
      ['health_monitor_refs', list(['avi_healthmonitor.this.id'])],
      persistence !== '' && ['application_persistence_profile_ref', 'data.avi_applicationpersistenceprofile.this.id'],
      serverTls && ['ssl_profile_ref', 'data.avi_sslprofile.standard.id'],
      ...serverBlocks(servers),
    ]),
  );
  out.push(...vsvip(name, v, findings));
  const policies = [...(extras.httpPolicyRefs ?? [])];
  if (redirect) {
    out.push(
      resource('avi_httppolicyset', 'redirect', [
        ['name', q(`${name}-http-to-https`)],
        {
          b: 'http_security_policy',
          body: [
            {
              b: 'rules',
              body: [
                ['name', q('http-to-https')],
                ['index', s(1)],
                ['enable', s(true)],
                { b: 'match', body: [{ b: 'vs_port', body: [['match_criteria', q('IS_IN')], ['ports', '[80]']] }] },
                { b: 'action', body: [['action', q('HTTP_SECURITY_ACTION_REDIRECT_TO_HTTPS')], ['https_port', s(443)]] },
              ],
            },
          ],
        },
      ]),
    );
    policies.unshift('avi_httppolicyset.redirect.id');
  }
  const certRef = importCert ? 'avi_sslkeyandcertificate.this.id' : 'data.avi_sslkeyandcertificate.this.id';
  out.push(
    resource('avi_virtualservice', 'this', [
      ['name', q(name)],
      ['cloud_ref', 'data.avi_cloud.cloud.id'],
      ['se_group_ref', 'data.avi_serviceenginegroup.se.id'],
      ['vsvip_ref', 'avi_vsvip.this.id'],
      ['pool_ref', 'avi_pool.this.id'],
      ['application_profile_ref', 'data.avi_applicationprofile.http.id'],
      tls && ['ssl_profile_ref', 'data.avi_sslprofile.standard.id'],
      tls && ['ssl_key_and_certificate_refs', list([certRef])],
      extras.wafPolicyRef !== undefined && ['waf_policy_ref', extras.wafPolicyRef],
      { b: 'services', body: tls ? [['port', s(443)], ['enable_ssl', s(true)]] : [['port', s(80)]] },
      redirect && { b: 'services', body: [['port', s(80)], ['enable_ssl', s(false)]] },
      // Lower index is evaluated first.
      ...policies.map((ref, i): Blk => ({ b: 'http_policies', body: [['http_policy_set_ref', ref], ['index', s(11 + i)]] })),
    ]),
  );
  out.push(output('virtualservice_id', 'avi_virtualservice.this.id', 'API reference of the virtual service'));
  out.push(output('vip', 'avi_vsvip.this.vip', 'The VIP as allocated or configured'));
  return out.filter(Boolean);
}

// --- the scenarios -----------------------------------------------------------

const httpsVs = scenario('avi', {
  id: 'avi_https_vs',
  label: 'HTTP(S) virtual service',
  description:
    'A web application behind Avi: HTTP(S) health monitor, a pool of servers, a VIP (static or allocated from IPAM), a certificate (existing, or imported with the key kept in a sensitive variable), and the virtual service — with an HTTP-to-HTTPS redirect.',
  inputs: httpVsInputs(),
  emits: HTTP_VS_EMITS,
  body: (v) => {
    const findings: Finding[] = [];
    return { hcl: httpVirtualService(v, findings).join('\n\n'), findings };
  },
});

const L4_PROFILE_OPTIONS = [
  { value: 'System-TCP-Proxy', label: 'TCP proxy (full proxy, TCP optimisations)' },
  { value: 'System-TCP-Fast-Path', label: 'TCP fast path (packet-level, lowest latency)' },
  { value: 'System-UDP-Fast-Path', label: 'UDP fast path' },
  { value: 'System-UDP-Per-Pkt', label: 'UDP per packet (DNS, syslog)' },
];

const l4Vs = scenario('avi', {
  id: 'avi_l4_vs',
  label: 'L4 TCP/UDP virtual service',
  description:
    'A layer-4 virtual service for a non-HTTP protocol: System-L4-Application with a TCP proxy or TCP/UDP fast-path network profile, one or more service ports, a pool of servers and a TCP or ping health monitor.',
  inputs: [
    { id: 'vs_name', label: 'Virtual service name', control: 'text', default: 'pg-prod' },
    ...CLOUD_INPUTS,
    { id: 'network_profile', label: 'Network profile', control: 'select', options: L4_PROFILE_OPTIONS, default: 'System-TCP-Proxy' },
    { id: 'ports', label: 'Service ports', control: 'text', default: '5432', hint: 'comma-separated; ranges like 5000-5010' },
    ...vipInputs('10.10.50.20'),
    { id: 'servers', label: 'Pool servers', control: 'textarea', default: '10.10.30.11:5432\n10.10.30.12:5432', hint: 'ip:port, one per line' },
    { id: 'server_port', label: 'Default server port', control: 'number', default: 5432, hint: 'for servers given without one' },
    { id: 'lb_algorithm', label: 'Load balancing', control: 'select', options: LB_ALGORITHM_OPTIONS, default: 'LB_ALGORITHM_LEAST_CONNECTIONS' },
    { id: 'preserve_client_ip', label: 'Persist clients by source IP', control: 'toggle', default: false, hint: 'System-Persistence-Client-IP' },
    ...MONITOR_TIMER_INPUTS,
  ],
  emits: ['avi_healthmonitor', 'avi_pool', 'avi_vsvip', 'avi_virtualservice'],
  body: (v) => {
    const findings: Finding[] = [];
    const name = String(v.vs_name ?? 'vs').trim() || 'vs';
    const udp = String(v.network_profile).includes('UDP');
    const servers = parseServers(v.servers, String(n(v.server_port, 80)), findings, 'servers');
    const out: string[] = [
      ...cloudLookups(v),
      data('avi_applicationprofile', 'l4', [['name', q('System-L4-Application')]]),
      data('avi_networkprofile', 'this', [['name', q(v.network_profile)]]),
      on(v.preserve_client_ip) ? data('avi_applicationpersistenceprofile', 'this', [['name', q('System-Persistence-Client-IP')]]) : '',
    ];
    // TCP gets a monitor of its own; UDP services rarely answer a probe, so they get ICMP.
    if (udp) out.push(data('avi_healthmonitor', 'this', [['name', q('System-Ping')]]));
    else out.push(resource('avi_healthmonitor', 'this', [['name', q(`${name}-hm`)], ['type', q('HEALTH_MONITOR_TCP')], ...monitorTimers(v), { b: 'tcp_monitor', body: [['tcp_half_open', s(false)]] }]));
    const monitorRef = udp ? 'data.avi_healthmonitor.this.id' : 'avi_healthmonitor.this.id';
    out.push(
      resource('avi_pool', 'this', [
        ['name', q(`${name}-pool`)],
        ['cloud_ref', 'data.avi_cloud.cloud.id'],
        ['lb_algorithm', q(v.lb_algorithm)],
        v.lb_algorithm === 'LB_ALGORITHM_CONSISTENT_HASH' && ['lb_algorithm_hash', q('LB_ALGORITHM_CONSISTENT_HASH_SOURCE_IP_ADDRESS')],
        ['default_server_port', s(n(v.server_port, 80))],
        ['health_monitor_refs', list([monitorRef])],
        on(v.preserve_client_ip) && ['application_persistence_profile_ref', 'data.avi_applicationpersistenceprofile.this.id'],
        ...serverBlocks(servers),
      ]),
    );
    out.push(...vsvip(name, v, findings));
    const services = items(v.ports).map((p): Blk => {
      const [start = '', end = ''] = p.split('-').map((x) => x.trim());
      if (!/^\d+$/.test(start) || (end !== '' && !/^\d+$/.test(end))) findings.push(error('avi.l4.port', `"${p}" is not a port or port range.`, { path: 'ports' }));
      return { b: 'services', body: [['port', s(start)], end !== '' && ['port_range_end', s(end)]] };
    });
    out.push(
      resource('avi_virtualservice', 'this', [
        ['name', q(name)],
        ['cloud_ref', 'data.avi_cloud.cloud.id'],
        ['se_group_ref', 'data.avi_serviceenginegroup.se.id'],
        ['vsvip_ref', 'avi_vsvip.this.id'],
        ['pool_ref', 'avi_pool.this.id'],
        ['application_profile_ref', 'data.avi_applicationprofile.l4.id'],
        ['network_profile_ref', 'data.avi_networkprofile.this.id'],
        ...services,
      ]),
    );
    out.push(output('virtualservice_id', 'avi_virtualservice.this.id', 'API reference of the virtual service'));
    return { hcl: out.filter(Boolean).join('\n\n'), findings };
  },
});

const blueGreen = scenario('avi', {
  id: 'avi_pool_group_blue_green',
  label: 'Blue/green pool group',
  description:
    'Two pools — blue (current release) and green (next) — in one pool group behind an HTTP(S) virtual service, either splitting traffic by ratio for a canary or keeping green as a priority standby that only takes traffic when blue is down.',
  inputs: [
    { id: 'vs_name', label: 'Virtual service name', control: 'text', default: 'app-prod' },
    ...CLOUD_INPUTS,
    {
      id: 'mode',
      label: 'Traffic',
      control: 'select',
      options: [
        { value: 'ratio', label: 'Split by ratio (canary)' },
        { value: 'priority', label: 'Blue active, green standby (priority)' },
      ],
      default: 'ratio',
    },
    { id: 'blue_ratio', label: 'Blue share', control: 'number', default: 90, hint: 'relative weight, 1–1000', showWhen: { input: 'mode', equals: ['ratio'] } },
    { id: 'green_ratio', label: 'Green share', control: 'number', default: 10, hint: 'relative weight, 1–1000', showWhen: { input: 'mode', equals: ['ratio'] } },
    { id: 'blue_servers', label: 'Blue servers', control: 'textarea', default: '10.10.10.21:8080\n10.10.10.22:8080', hint: 'ip:port, one per line' },
    { id: 'green_servers', label: 'Green servers', control: 'textarea', default: '10.10.10.31:8080\n10.10.10.32:8080', hint: 'ip:port, one per line' },
    { id: 'server_port', label: 'Default server port', control: 'number', default: 8080 },
    { id: 'lb_algorithm', label: 'Load balancing in each pool', control: 'select', options: LB_ALGORITHM_OPTIONS, default: 'LB_ALGORITHM_LEAST_CONNECTIONS' },
    { id: 'hm_path', label: 'Health check path', control: 'text', default: '/healthz' },
    { id: 'hm_codes', label: 'Healthy response codes', control: 'checklist', options: HTTP_CODE_OPTIONS, default: 'HTTP_2XX' },
    { id: 'tls', label: 'HTTPS', control: 'select', options: [{ value: 'true', label: 'HTTPS on 443 (existing certificate)' }, { value: 'false', label: 'HTTP on 80' }], default: 'true' },
    { id: 'cert_name', label: 'Certificate', control: 'text', default: 'System-Default-Cert', hint: 'existing, looked up', showWhen: { input: 'tls', equals: ['true'] } },
    ...vipInputs('10.10.50.30', 'VIP'),
    ...MONITOR_TIMER_INPUTS,
  ],
  emits: ['avi_healthmonitor', 'avi_pool', 'avi_poolgroup', 'avi_vsvip', 'avi_virtualservice'],
  body: (v) => {
    const findings: Finding[] = [];
    const name = String(v.vs_name ?? 'app').trim() || 'app';
    const tls = on(v.tls);
    const port = String(n(v.server_port, 80));
    const out: string[] = [
      ...cloudLookups(v),
      data('avi_applicationprofile', 'http', [['name', q(tls ? 'System-Secure-HTTP' : 'System-HTTP')]]),
      tls ? data('avi_sslprofile', 'standard', [['name', q('System-Standard')]]) : '',
      tls ? data('avi_sslkeyandcertificate', 'this', [['name', q(v.cert_name)]]) : '',
      httpMonitor(name, v, false),
    ];
    for (const colour of ['blue', 'green']) {
      out.push(
        resource('avi_pool', colour, [
          ['name', q(`${name}-${colour}`)],
          ['cloud_ref', 'data.avi_cloud.cloud.id'],
          ['lb_algorithm', q(v.lb_algorithm)],
          v.lb_algorithm === 'LB_ALGORITHM_CONSISTENT_HASH' && ['lb_algorithm_hash', q('LB_ALGORITHM_CONSISTENT_HASH_SOURCE_IP_ADDRESS')],
          ['default_server_port', s(port)],
          ['health_monitor_refs', list(['avi_healthmonitor.this.id'])],
          ...serverBlocks(parseServers(v[`${colour}_servers`], port, findings, `${colour}_servers`)),
        ]),
      );
    }
    const ratio = v.mode === 'ratio';
    // Higher priority labels win; members of equal priority share traffic by ratio.
    const member = (colour: string, weight: number, priority: number): Blk => ({
      b: 'members',
      body: [['pool_ref', `avi_pool.${colour}.id`], ['ratio', s(weight)], ['priority_label', s(priority)]],
    });
    out.push(
      resource('avi_poolgroup', 'this', [
        ['name', q(`${name}-blue-green`)],
        ['cloud_ref', 'data.avi_cloud.cloud.id'],
        ratio ? member('blue', n(v.blue_ratio, 90), 10) : member('blue', 1, 20),
        ratio ? member('green', n(v.green_ratio, 10), 10) : member('green', 1, 10),
      ]),
    );
    out.push(...vsvip(name, v, findings));
    out.push(
      resource('avi_virtualservice', 'this', [
        ['name', q(name)],
        ['cloud_ref', 'data.avi_cloud.cloud.id'],
        ['se_group_ref', 'data.avi_serviceenginegroup.se.id'],
        ['vsvip_ref', 'avi_vsvip.this.id'],
        ['pool_group_ref', 'avi_poolgroup.this.id'],
        ['application_profile_ref', 'data.avi_applicationprofile.http.id'],
        tls && ['ssl_profile_ref', 'data.avi_sslprofile.standard.id'],
        tls && ['ssl_key_and_certificate_refs', list(['data.avi_sslkeyandcertificate.this.id'])],
        { b: 'services', body: tls ? [['port', s(443)], ['enable_ssl', s(true)]] : [['port', s(80)]] },
      ]),
    );
    out.push(output('poolgroup_id', 'avi_poolgroup.this.id', 'API reference of the pool group; change the member ratios to shift traffic'));
    return { hcl: out.filter(Boolean).join('\n\n'), findings };
  },
});

const wafVs = scenario('avi', {
  id: 'avi_waf_vs',
  label: 'WAF policy on an HTTP(S) virtual service',
  description:
    'An Avi WAF policy built on the system WAF profile and the controller\'s CRS rule set — in detection or enforcement mode, at a chosen paranoia level, with allow-list rules for trusted clients and paths — protecting an HTTP(S) virtual service.',
  inputs: [
    { id: 'waf_name', label: 'WAF policy name', control: 'text', default: 'www-prod-waf' },
    {
      id: 'waf_mode',
      label: 'Mode',
      control: 'select',
      options: [
        { value: 'WAF_MODE_DETECTION_ONLY', label: 'Detection only (log, do not block)' },
        { value: 'WAF_MODE_ENFORCEMENT', label: 'Enforcement (block)' },
      ],
      default: 'WAF_MODE_DETECTION_ONLY',
      help: 'Run in detection first and tune false positives before enforcing.',
    },
    {
      id: 'paranoia',
      label: 'Paranoia level',
      control: 'select',
      options: [
        { value: 'WAF_PARANOIA_LEVEL_LOW', label: 'Low' },
        { value: 'WAF_PARANOIA_LEVEL_MEDIUM', label: 'Medium' },
        { value: 'WAF_PARANOIA_LEVEL_HIGH', label: 'High' },
        { value: 'WAF_PARANOIA_LEVEL_EXTREME', label: 'Extreme' },
      ],
      default: 'WAF_PARANOIA_LEVEL_LOW',
    },
    { id: 'waf_profile', label: 'WAF profile', control: 'text', default: 'System-WAF-Profile', hint: 'existing, looked up' },
    { id: 'crs_name', label: 'CRS release', control: 'text', default: '', hint: 'name of an installed CRS; empty for the controller default' },
    { id: 'auto_update_crs', label: 'Keep the CRS up to date', control: 'toggle', default: true },
    { id: 'allow_ips', label: 'Bypass WAF for clients', control: 'text', default: '10.0.0.0/24', hint: 'CIDRs, comma-separated — scanners, monitoring; empty for none' },
    { id: 'allow_paths', label: 'Bypass WAF for paths', control: 'text', default: '/healthz, /static/', hint: 'path prefixes, comma-separated; empty for none' },
    {
      id: 'failure_mode',
      label: 'If the WAF engine fails',
      control: 'select',
      options: [
        { value: 'WAF_FAILURE_MODE_OPEN', label: 'Fail open (pass traffic)' },
        { value: 'WAF_FAILURE_MODE_CLOSED', label: 'Fail closed (block traffic)' },
      ],
      default: 'WAF_FAILURE_MODE_OPEN',
      section: 'Advanced',
    },
    ...httpVsInputs('Virtual service'),
  ],
  emits: ['avi_wafpolicy', ...HTTP_VS_EMITS],
  body: (v) => {
    const findings: Finding[] = [];
    const crs = String(v.crs_name ?? '').trim();
    const allowIps = items(v.allow_ips);
    const allowPaths = items(v.allow_paths);
    const rules: Blk[] = [];
    if (allowIps.length > 0) {
      rules.push({
        b: 'rules',
        body: [
          ['name', q('trusted-clients')],
          ['index', s(rules.length)],
          ['enable', s(true)],
          ['actions', qlist('WAF_POLICY_ALLOWLIST_ACTION_BYPASS')],
          {
            b: 'match',
            body: [
              {
                b: 'client_ip',
                body: [
                  ['match_criteria', q('IS_IN')],
                  ...allowIps.map((cidr): Blk => {
                    const [addr = '', mask = ipType(addr) === 'V6' ? '128' : '32'] = cidr.split('/');
                    return { b: 'prefixes', body: [['mask', s(mask)], ipAddr('ip_addr', addr)] };
                  }),
                ],
              },
            ],
          },
        ],
      });
    }
    if (allowPaths.length > 0) {
      rules.push({
        b: 'rules',
        body: [
          ['name', q('bypass-paths')],
          ['index', s(rules.length)],
          ['enable', s(true)],
          ['actions', qlist('WAF_POLICY_ALLOWLIST_ACTION_BYPASS')],
          { b: 'match', body: [{ b: 'path', body: [['match_criteria', q('BEGINS_WITH')], ['match_str', qlist(allowPaths.join(','))]] }] },
        ],
      });
    }
    const out: string[] = [
      data('avi_wafprofile', 'this', [['name', q(v.waf_profile)]]),
      crs !== '' ? data('avi_wafcrs', 'this', [['name', q(crs)]]) : '',
      resource('avi_wafpolicy', 'this', [
        ['name', q(v.waf_name)],
        ['waf_profile_ref', 'data.avi_wafprofile.this.id'],
        crs !== '' && ['waf_crs_ref', 'data.avi_wafcrs.this.id'],
        ['mode', q(v.waf_mode)],
        ['paranoia_level', q(v.paranoia)],
        ['failure_mode', q(v.failure_mode)],
        ['auto_update_crs', s(on(v.auto_update_crs))],
        // Rules may switch a request back to detection only when delegation is allowed.
        ['allow_mode_delegation', s(true)],
        rules.length > 0 && { b: 'allowlist', body: rules },
      ]),
      ...httpVirtualService(v, findings, { wafPolicyRef: 'avi_wafpolicy.this.id' }),
    ];
    return { hcl: out.filter(Boolean).join('\n\n'), findings };
  },
});

const SECURITY_HEADERS: Record<string, [string, string]> = {
  hsts: ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  frame: ['X-Frame-Options', 'SAMEORIGIN'],
  nosniff: ['X-Content-Type-Options', 'nosniff'],
  referrer: ['Referrer-Policy', 'strict-origin-when-cross-origin'],
};

function hdrAction(action: string, header: string, value?: string): Blk {
  return {
    b: 'hdr_action',
    body: [['action', q(action)], { b: 'hdr', body: [['name', q(header)], value !== undefined && { b: 'value', body: [['val', q(value)]] }] }],
  };
}

/** A redirect target as Avi tokenises it: one literal string token. */
function token(block: string, value: string): Blk {
  return { b: block, body: [['type', q('URI_PARAM_TYPE_TOKENIZED')], { b: 'tokens', body: [['type', q('URI_TOKEN_TYPE_STRING')], ['str_value', q(value)]] }] };
}

const httpPolicy = scenario('avi', {
  id: 'avi_http_policy_set',
  label: 'HTTP policy set: redirects and headers',
  description:
    'An HTTP policy set on an HTTP(S) virtual service: apex-to-www host redirect, permanent redirects for moved paths, request headers added for the servers, and security headers added (and the Server header removed) on the way back.',
  inputs: [
    { id: 'policy_name', label: 'Policy set name', control: 'text', default: 'www-prod-rules' },
    { id: 'apex_host', label: 'Redirect this host', control: 'text', default: 'example.com', hint: 'e.g. the apex; empty for none' },
    { id: 'canonical_host', label: 'to this host', control: 'text', default: 'www.example.com' },
    { id: 'path_redirects', label: 'Path redirects', control: 'textarea', default: '/old-shop=/shop\n/blog=/news', hint: '/from=/to, one per line (301)' },
    { id: 'request_headers', label: 'Add request headers', control: 'textarea', default: 'X-Forwarded-Proto=https\nX-Request-Source=avi', hint: 'Header=value, one per line' },
    {
      id: 'security_headers',
      label: 'Add response headers',
      control: 'checklist',
      options: [
        { value: 'hsts', label: 'Strict-Transport-Security' },
        { value: 'frame', label: 'X-Frame-Options' },
        { value: 'nosniff', label: 'X-Content-Type-Options' },
        { value: 'referrer', label: 'Referrer-Policy' },
      ],
      default: 'hsts,frame,nosniff,referrer',
    },
    { id: 'remove_server_header', label: 'Remove the Server header', control: 'toggle', default: true },
    ...httpVsInputs('Virtual service'),
  ],
  emits: [...HTTP_VS_EMITS],
  body: (v) => {
    const findings: Finding[] = [];
    const scheme = on(v.tls) ? 'HTTPS' : 'HTTP';
    const request: Blk[] = [];
    const rule = (name: string, body: Item[]): Blk => ({ b: 'rules', body: [['name', q(name)], ['index', s(request.length + 1)], ['enable', s(true)], ...body] });
    const apex = String(v.apex_host ?? '').trim();
    if (apex !== '') {
      request.push(
        rule('canonical-host', [
          { b: 'match', body: [{ b: 'host_hdr', body: [['match_criteria', q('HDR_EQUALS')], ['value', qlist(apex)]] }] },
          { b: 'redirect_action', body: [['protocol', q(scheme)], ['keep_query', s(true)], ['status_code', q('HTTP_REDIRECT_STATUS_CODE_301')], token('host', String(v.canonical_host))] },
        ]),
      );
    }
    for (const [from, to] of pairs(v.path_redirects)) {
      if (!from.startsWith('/') || !to.startsWith('/')) findings.push(warning('avi.policy.path', `Redirect "${from}=${to}": both paths should start with /.`, { path: 'path_redirects' }));
      request.push(
        rule(`redirect-${ident(from, 'path').replace(/_/g, '-')}`, [
          { b: 'match', body: [{ b: 'path', body: [['match_criteria', q('EQUALS')], ['match_str', qlist(from)]] }] },
          // Avi adds the leading slash to a redirect path itself.
          { b: 'redirect_action', body: [['protocol', q(scheme)], ['keep_query', s(true)], ['status_code', q('HTTP_REDIRECT_STATUS_CODE_301')], token('path', to.replace(/^\/+/, ''))] },
        ]),
      );
    }
    const addHeaders = pairs(v.request_headers);
    if (addHeaders.length > 0) request.push(rule('request-headers', addHeaders.map(([h, value]) => hdrAction('HTTP_ADD_HDR', h, value))));

    const response: Item[] = [
      ...items(v.security_headers)
        .map((key) => SECURITY_HEADERS[key])
        .filter((h): h is [string, string] => h !== undefined)
        .map(([h, value]) => hdrAction('HTTP_ADD_HDR', h, value)),
      on(v.remove_server_header) && hdrAction('HTTP_REMOVE_HDR', 'Server'),
    ].filter(Boolean);
    const out: string[] = [
      resource('avi_httppolicyset', 'this', [
        ['name', q(v.policy_name)],
        request.length > 0 && { b: 'http_request_policy', body: request },
        response.length > 0 && { b: 'http_response_policy', body: [{ b: 'rules', body: [['name', q('response-headers')], ['index', s(1)], ['enable', s(true)], ...response] }] },
      ]),
      ...httpVirtualService(v, findings, { httpPolicyRefs: ['avi_httppolicyset.this.id'] }),
    ];
    return { hcl: out.join('\n\n'), findings };
  },
});

const gslb = scenario('avi', {
  id: 'avi_gslb_service',
  label: 'GSLB service across two sites',
  description:
    'A GSLB service answering for one FQDN from two sites — active/standby by priority, or active/active — with a GSLB health monitor and a short TTL. Assumes GSLB is already configured between the controllers.',
  inputs: [
    { id: 'gslb_name', label: 'GSLB service name', control: 'text', default: 'www-gslb' },
    { id: 'domain_names', label: 'FQDNs', control: 'text', default: 'www.gslb.example.com', hint: 'comma-separated, in a GSLB DNS subdomain' },
    {
      id: 'mode',
      label: 'Sites',
      control: 'select',
      options: [
        { value: 'active_standby', label: 'Active/standby (site B only when site A is down)' },
        { value: 'active_active', label: 'Active/active' },
      ],
      default: 'active_standby',
    },
    { id: 'site_a_name', label: 'Site A', control: 'text', default: 'dc1' },
    { id: 'site_a_members', label: 'Site A members', control: 'text', default: '10.10.50.10', hint: 'VIP addresses, comma-separated' },
    { id: 'site_b_name', label: 'Site B', control: 'text', default: 'dc2' },
    { id: 'site_b_members', label: 'Site B members', control: 'text', default: '10.20.50.10', hint: 'VIP addresses, comma-separated' },
    {
      id: 'algorithm',
      label: 'Within a site',
      control: 'select',
      options: [
        { value: 'GSLB_ALGORITHM_ROUND_ROBIN', label: 'Round robin' },
        { value: 'GSLB_ALGORITHM_CONSISTENT_HASH', label: 'Consistent hash (client IP)' },
        { value: 'GSLB_ALGORITHM_GEO', label: 'Geo' },
      ],
      default: 'GSLB_ALGORITHM_ROUND_ROBIN',
    },
    {
      id: 'monitor',
      label: 'Health monitor',
      control: 'select',
      options: [
        { value: 'System-GSLB-HTTPS', label: 'GSLB HTTPS' },
        { value: 'System-GSLB-HTTP', label: 'GSLB HTTP' },
        { value: 'System-GSLB-TCP', label: 'GSLB TCP' },
        { value: 'System-GSLB-Ping', label: 'GSLB ping' },
      ],
      default: 'System-GSLB-HTTPS',
    },
    { id: 'ttl', label: 'DNS TTL', control: 'number', default: 30, hint: 'seconds', section: 'Advanced' },
    { id: 'min_members', label: 'Minimum healthy members', control: 'number', default: 1, section: 'Advanced' },
  ],
  emits: ['avi_gslbservice'],
  body: (v) => {
    const activeStandby = v.mode === 'active_standby';
    const group = (site: string, members: string[], priority: number): Blk => ({
      b: 'groups',
      body: [
        ['name', q(site)],
        ['priority', s(priority)],
        ['algorithm', q(v.algorithm)],
        v.algorithm === 'GSLB_ALGORITHM_CONSISTENT_HASH' && ['consistent_hash_mask', s(24)],
        ...members.map((addr): Blk => ({ b: 'members', body: [['enabled', s(true)], ['ratio', s(1)], ipAddr('ip', addr)] })),
      ],
    });
    return [
      data('avi_healthmonitor', 'gslb', [['name', q(v.monitor)]]),
      resource('avi_gslbservice', 'this', [
        ['name', q(v.gslb_name)],
        ['domain_names', qlist(v.domain_names)],
        ['enabled', s(true)],
        ['pool_algorithm', q('GSLB_SERVICE_ALGORITHM_PRIORITY')],
        ['health_monitor_refs', list(['data.avi_healthmonitor.gslb.id'])],
        ['controller_health_status_enabled', s(true)],
        ['ttl', s(n(v.ttl, 30))],
        ['min_members', s(n(v.min_members, 1))],
        // Traffic goes to the highest-priority group with healthy members.
        group(String(v.site_a_name), items(v.site_a_members), 20),
        group(String(v.site_b_name), items(v.site_b_members), activeStandby ? 10 : 20),
      ]),
      output('gslbservice_id', 'avi_gslbservice.this.id', 'API reference of the GSLB service'),
    ].join('\n\n');
  },
});

const vcenterCloud = scenario('avi', {
  id: 'avi_vcenter_cloud',
  label: 'vCenter cloud + Service Engine group',
  description:
    'A vCenter cloud with write access (Avi deploys its own Service Engines), its management network, optional IPAM/DNS profiles, and a Service Engine group sized for production: HA mode, SE count and buffer, vCPU/memory/disk, folder and datastores.',
  inputs: [
    { id: 'cloud_name', label: 'Cloud name', control: 'text', default: 'vcenter-01' },
    { id: 'vcenter_url', label: 'vCenter', control: 'text', default: 'vcenter.example.com' },
    { id: 'vcenter_username', label: 'vCenter user', control: 'text', default: 'svc-avi@vsphere.local', hint: 'password from var.vcenter_password' },
    { id: 'datacenter', label: 'Datacenter', control: 'text', default: 'dc01' },
    { id: 'management_network', label: 'SE management port group', control: 'text', default: 'pg-avi-mgmt' },
    { id: 'mgmt_dhcp', label: 'Management addressing', control: 'select', options: [{ value: 'true', label: 'DHCP' }, { value: 'false', label: 'Static subnet' }], default: 'true' },
    { id: 'mgmt_subnet', label: 'Management subnet', control: 'text', default: '10.0.20.0/24', showWhen: { input: 'mgmt_dhcp', equals: ['false'] } },
    { id: 'ipam_profile', label: 'IPAM profile', control: 'text', default: '', hint: 'existing, looked up; empty for none' },
    { id: 'dns_profile', label: 'DNS profile', control: 'text', default: '', hint: 'existing, looked up; empty for none' },
    { id: 'content_library', label: 'Content library for SE images', control: 'text', default: '', hint: 'empty to upload the OVA directly', section: 'Cloud' },
    {
      id: 'license_type',
      label: 'Licensing',
      control: 'select',
      options: [
        { value: 'LIC_CORES', label: 'Per core' },
        { value: 'LIC_SOCKETS', label: 'Per socket' },
      ],
      default: 'LIC_CORES',
      section: 'Cloud',
    },
    { id: 'seg_name', label: 'SE group name', control: 'text', default: 'se-group-apps' },
    {
      id: 'ha_mode',
      label: 'SE HA mode',
      control: 'select',
      options: [
        { value: 'HA_MODE_SHARED_PAIR', label: 'Active/active (elastic, N+M with each VS on two SEs)' },
        { value: 'HA_MODE_SHARED', label: 'N+M buffer (elastic)' },
        { value: 'HA_MODE_LEGACY_ACTIVE_STANDBY', label: 'Legacy active/standby' },
      ],
      default: 'HA_MODE_SHARED_PAIR',
    },
    { id: 'max_se', label: 'Maximum SEs', control: 'number', default: 10 },
    { id: 'buffer_se', label: 'Buffer SEs', control: 'number', default: 1, hint: 'spare capacity for failover', showWhen: { input: 'ha_mode', equals: ['HA_MODE_SHARED', 'HA_MODE_SHARED_PAIR'] } },
    { id: 'vcpus_per_se', label: 'vCPUs per SE', control: 'number', default: 2 },
    { id: 'memory_per_se', label: 'Memory per SE', control: 'number', default: 4096, hint: 'MB' },
    { id: 'disk_per_se', label: 'Disk per SE', control: 'number', default: 25, hint: 'GB' },
    { id: 'max_vs_per_se', label: 'Virtual services per SE', control: 'number', default: 10, section: 'SE group' },
    { id: 'se_name_prefix', label: 'SE name prefix', control: 'text', default: 'avi', section: 'SE group' },
    { id: 'vcenter_folder', label: 'vCenter folder', control: 'text', default: 'AviSeFolder', section: 'SE group' },
    { id: 'datastores', label: 'Datastores', control: 'text', default: 'vsanDatastore', hint: 'comma-separated; empty for any shared datastore', section: 'SE group' },
    { id: 'placement', label: 'Placement', control: 'select', options: [{ value: 'PLACEMENT_ALGO_PACKED', label: 'Packed (fewest SEs)' }, { value: 'PLACEMENT_ALGO_DISTRIBUTED', label: 'Distributed (spread load)' }], default: 'PLACEMENT_ALGO_PACKED', section: 'SE group' },
  ],
  emits: ['avi_cloud', 'avi_serviceenginegroup'],
  body: (v) => {
    const findings: Finding[] = [];
    const dhcp = on(v.mgmt_dhcp);
    const ipam = String(v.ipam_profile ?? '').trim();
    const dns = String(v.dns_profile ?? '').trim();
    const contentLib = String(v.content_library ?? '').trim();
    const [mgmtAddr = '', mgmtMask = ''] = String(v.mgmt_subnet ?? '').split('/');
    if (!dhcp && mgmtMask === '') findings.push(error('avi.cloud.mgmt-subnet', 'The management subnet needs a prefix length, such as 10.0.20.0/24.', { path: 'mgmt_subnet' }));
    const datastores = items(v.datastores);
    const legacy = v.ha_mode === 'HA_MODE_LEGACY_ACTIVE_STANDBY';
    return {
      hcl: [
        sensitiveVariable('vcenter_password', `Password of ${v.vcenter_username} on ${v.vcenter_url}`),
        ipam !== '' ? data('avi_ipamdnsproviderprofile', 'ipam', [['name', q(ipam)]]) : '',
        dns !== '' ? data('avi_ipamdnsproviderprofile', 'dns', [['name', q(dns)]]) : '',
        resource('avi_cloud', 'vcenter', [
          ['name', q(v.cloud_name)],
          ['vtype', q('CLOUD_VCENTER')],
          ['dhcp_enabled', s(dhcp)],
          ['license_type', q(v.license_type)],
          ipam !== '' && ['ipam_provider_ref', 'data.avi_ipamdnsproviderprofile.ipam.id'],
          dns !== '' && ['dns_provider_ref', 'data.avi_ipamdnsproviderprofile.dns.id'],
          {
            b: 'vcenter_configuration',
            body: [
              ['vcenter_url', q(v.vcenter_url)],
              ['username', q(v.vcenter_username)],
              ['password', 'var.vcenter_password'],
              ['datacenter', q(v.datacenter)],
              // Write access: the controller creates, sizes and deletes the SE VMs itself.
              ['privilege', q('WRITE_ACCESS')],
              ['management_network', q(`/api/vimgrnwruntime/?name=${v.management_network}`)],
              ['use_content_lib', s(contentLib !== '')],
              contentLib !== '' && { b: 'content_lib', body: [['name', q(contentLib)]] },
              !dhcp && { b: 'management_ip_subnet', body: [['mask', s(mgmtMask || 24)], ipAddr('ip_addr', mgmtAddr)] },
            ],
          },
        ]),
        resource('avi_serviceenginegroup', 'this', [
          ['name', q(v.seg_name)],
          ['cloud_ref', 'avi_cloud.vcenter.id'],
          ['ha_mode', q(v.ha_mode)],
          legacy && ['active_standby', s(true)],
          ['algo', q(v.placement)],
          ['max_se', s(n(v.max_se, 10))],
          !legacy && ['buffer_se', s(n(v.buffer_se, 1))],
          v.ha_mode === 'HA_MODE_SHARED_PAIR' && ['min_scaleout_per_vs', s(2)],
          ['max_vs_per_se', s(n(v.max_vs_per_se, 10))],
          ['vcpus_per_se', s(n(v.vcpus_per_se, 2))],
          ['memory_per_se', s(n(v.memory_per_se, 4096))],
          ['disk_per_se', s(n(v.disk_per_se, 25))],
          ['se_name_prefix', q(v.se_name_prefix)],
          ['vcenter_folder', q(v.vcenter_folder)],
          ['vcenter_datastore_mode', q(datastores.length > 0 ? 'VCENTER_DATASTORE_SHARED' : 'VCENTER_DATASTORE_ANY')],
          ['vcenter_datastores_include', s(datastores.length > 0)],
          ...datastores.map((d): Blk => ({ b: 'vcenter_datastores', body: [['datastore_name', q(d)]] })),
        ]),
        output('cloud_id', 'avi_cloud.vcenter.id', 'API reference of the cloud'),
        output('se_group_id', 'avi_serviceenginegroup.this.id', 'API reference of the Service Engine group'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      findings,
    };
  },
});

export const AVI_SCENARIOS: readonly Blueprint[] = [httpsVs, l4Vs, blueGreen, wafVs, httpPolicy, gslb, vcenterCloud];


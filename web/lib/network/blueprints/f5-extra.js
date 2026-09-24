/**
 * F5 BIG-IP, the rest of it.
 *
 * The first file publishes an application. These are the pieces around it: a
 * UDP or DNS virtual server, a redirect-only listener, custom monitors, SNAT
 * pools, a client SSL profile that serves more than one certificate by SNI,
 * TCP and HTTP profile tuning, and the two operational actions — removing a
 * tenant, and taking a pool member out of service for maintenance.
 *
 * All AS3 declarations, so each one is a whole tenant. That matters: AS3
 * replaces the tenant it is given, so a declaration must contain everything
 * that tenant should have.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint, withPush,                      } from '../from-change.js';
import { listOf,                   } from '../device.js';
import { byFamily, formatHostPort, isIp, urlHost } from '../../core/ip.js';
import { as3Members, parseMembers, tmshMember, virtualFindings } from './f5-common.js';

const PLATFORM = 'f5'         ;

function declaration(tenant        , application        , label        , body                         )           {
  return JSON.stringify(
    {
      $schema: 'https://raw.githubusercontent.com/F5Networks/f5-appsvcs-extension/main/schema/latest/as3-schema.json',
      class: 'AS3',
      action: 'deploy',
      persist: true,
      declaration: {
        class: 'ADC',
        schemaVersion: '3.45.0',
        id: `vcf-${application.toLowerCase()}`,
        label,
        remark: ' review before deploying.',
        [tenant]: { class: 'Tenant', [application]: { class: 'Application', template: 'generic', ...body } },
      },
    },
    null,
    2,
  ).split('\n');
}

const clean = (value        , fallback        )         => (str({ v: value }, 'v', fallback) || fallback).replace(/[^A-Za-z0-9_]/g, '_');

const BLUEPRINTS                             = [
  deviceBlueprint({
    id: 'f5_udp_virtual',
    platform: PLATFORM,
    label: 'UDP virtual server (DNS, RADIUS, syslog)',
    group: 'Applications',
    description: 'A layer 4 UDP listener with a pool and a protocol-aware monitor — for DNS, RADIUS, syslog or NTP.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'dns_service' },
      { id: 'virtual_address', label: 'Virtual address', control: 'text', default: '203.0.113.53' },
      { id: 'port', label: 'Port', control: 'number', default: 53, min: 1, max: 65535 },
      { id: 'pool_members', label: 'Pool members', control: 'textarea', default: '10.20.60.11:53\n10.20.60.12:53' },
      { id: 'monitor', label: 'Monitor', control: 'select', default: 'dns', options: [
        { value: 'dns', label: 'DNS — resolves a name' },
        { value: 'udp', label: 'UDP — a send and an expected reply' },
        { value: 'icmp', label: 'ICMP — the host answers' },
      ] },
      { id: 'monitor_query', label: 'Name to resolve', control: 'text', default: 'health.corp.local', showWhen: { input: 'monitor', equals: ['dns'] } },
      { id: 'idle_timeout', label: 'Idle timeout (seconds)', control: 'number', default: 60, min: 5 },
      { id: 'snat', label: 'SNAT automap', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'service'), 'service');
      const address = str(values, 'virtual_address', '');
      const port = num(values, 'port', 53);
      const pool = parseMembers(str(values, 'pool_members', ''), port);
      const monitorKind = str(values, 'monitor', 'dns');
      const snat = bool(values, 'snat', true) ? 'auto' : 'none';
      const checked = virtualFindings(address, pool, snat);
      const findings            = [...checked.findings];
      if (pool.servers.length === 0) findings.push(error('network.f5.no-members', 'The pool has no members.', { source: 'ArchToolKit' }));

      const monitor =
        monitorKind === 'dns'
          ? { class: 'Monitor', monitorType: 'dns', queryName: str(values, 'monitor_query', 'health.corp.local'), queryType: 'a', interval: 5, timeout: 16 }
          : monitorKind === 'udp'
            ? { class: 'Monitor', monitorType: 'udp', send: 'health', receive: '', interval: 5, timeout: 16 }
            : { class: 'Monitor', monitorType: 'icmp', interval: 5, timeout: 16 };

      return {
        platform: PLATFORM,
        title: `UDP virtual server ${formatHostPort(address, port)} for ${app}`,
        impact: 'brief',
        notes: [
          'A UDP monitor that expects no reply proves only that the port is open on the BIG-IP’s side. Use a protocol monitor — DNS here — where one exists.',
          'UDP has no connection, so the idle timeout is what decides when a "session" ends. Too long and the table fills; too short and long-lived flows break.',
          'AS3 replaces the whole tenant: capture the current declaration first.',
          ...checked.notes,
        ],
        before: [`curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`, `tmsh list ltm virtual /${tenant}/${app}/service`],
        config: declaration(tenant, app, `${app} on ${formatHostPort(address, port)}`, {
          [`${app}_monitor`]: monitor,
          [`${app}_udp`]: { class: 'UDP_Profile', idleTimeout: num(values, 'idle_timeout', 60) },
          [`${app}_pool`]: { class: 'Pool', loadBalancingMode: 'least-connections-member', monitors: [{ use: `${app}_monitor` }], members: as3Members(pool, { shareNodes: true }) },
          service: {
            class: 'Service_UDP',
            virtualAddresses: [address],
            virtualPort: port,
            pool: `${app}_pool`,
            profileUDP: { use: `${app}_udp` },
            snat,
          },
        }),
        verify: [`tmsh show ltm pool /${tenant}/${app}/${app}_pool members`, `tmsh show ltm virtual /${tenant}/${app}/service`, `dig @${address} ${str(values, 'monitor_query', 'health.corp.local')}`],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: { module: 'f5networks.f5_bigip.bigip_as3_deploy', args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' }, hosts: 'bigips' },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_redirect_virtual',
    platform: PLATFORM,
    label: 'HTTP to HTTPS redirect listener',
    group: 'Applications',
    description: 'A port 80 listener that redirects everything to HTTPS, for an address whose HTTPS service lives elsewhere.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'redirects' },
      { id: 'virtual_address', label: 'Virtual address', control: 'text', default: '203.0.113.20' },
      { id: 'target', label: 'Redirect to', control: 'text', default: '', hint: 'Empty redirects to the same host over HTTPS' },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'redirects'), 'redirects');
      const address = str(values, 'virtual_address', '');
      const target = str(values, 'target', '');
      const findings            = [];
      if (!isIp(address)) findings.push(error('network.f5.bad-virtual-address', 'The virtual address is not a valid IPv4 or IPv6 address.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `HTTP redirect listener on ${formatHostPort(address, 80)}`,
        impact: 'brief',
        notes: [
          'Use this only where the HTTPS service is in another tenant or on another device. A Service_HTTPS with `redirect80` already does this for its own address, and two listeners on one address will conflict.',
          'AS3 replaces the whole tenant.',
        ],
        before: [`tmsh list ltm virtual /${tenant}/${app}/service`, `curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`],
        config: declaration(tenant, app, `HTTP redirect on ${address}`, {
          service: {
            class: 'Service_HTTP',
            virtualAddresses: [address],
            virtualPort: 80,
            snat: 'auto',
            policyEndpoint: { use: `${app}_redirect_policy` },
          },
          [`${app}_redirect_policy`]: {
            class: 'Endpoint_Policy',
            rules: [
              {
                name: 'redirect_to_https',
                conditions: [],
                actions: [{ type: 'httpRedirect', location: target || 'https://[HTTP::host][HTTP::uri]', event: 'request' }],
              },
            ],
            strategy: 'first-match',
          },
        }),
        verify: [`curl -skI http://${urlHost(address)}/`, `tmsh show ltm virtual /${tenant}/${app}/service`],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: { module: 'f5networks.f5_bigip.bigip_as3_deploy', args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' }, hosts: 'bigips' },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_monitors',
    platform: PLATFORM,
    label: 'Custom health monitors',
    group: 'Profiles',
    description: 'Monitors that check the application rather than the port: an HTTP request with an expected body, an HTTPS one, a TCP send and receive, and an external script hook.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'monitors' },
      { id: 'http_path', label: 'HTTP path', control: 'text', default: '/health' },
      { id: 'http_host', label: 'Host header', control: 'text', default: 'app.corp.local' },
      { id: 'expect', label: 'Expected in the response', control: 'text', default: '"status":"ok"' },
      { id: 'interval', label: 'Interval (seconds)', control: 'number', default: 5, min: 1, max: 3600 },
      { id: 'timeout', label: 'Timeout (seconds)', control: 'number', default: 16, min: 2, hint: 'Usually three intervals plus one' },
      { id: 'https', label: 'Also an HTTPS version', control: 'toggle', default: true },
      { id: 'tcp_receive', label: 'TCP receive string', control: 'text', default: '', hint: 'Optional TCP monitor: what the service answers with' },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'monitors'), 'monitors');
      const path = str(values, 'http_path', '/health');
      const host = str(values, 'http_host', '');
      const expect = str(values, 'expect', '');
      const interval = num(values, 'interval', 5);
      const timeout = num(values, 'timeout', 16);
      const tcp = str(values, 'tcp_receive', '');
      const findings            = [];
      if (timeout <= interval) {
        findings.push(
          warning('network.f5.monitor-timeout', 'The timeout should be longer than the interval — the usual rule is three intervals plus one second. A shorter timeout marks healthy members down.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (!expect) {
        findings.push(
          warning('network.f5.monitor-no-receive', 'Without an expected string, the monitor passes on any response — including a 500 error page.', { source: 'ArchToolKit' }),
        );
      }

      const send = `GET ${path} HTTP/1.1\\r\\nHost: ${host}\\r\\nConnection: Close\\r\\n\\r\\n`;

      return {
        platform: PLATFORM,
        title: 'Custom health monitors',
        impact: 'none',
        notes: [
          'A monitor is the difference between "the port is open" and "the application works". Point it at something that touches the database, not a static file.',
          'Monitors in their own tenant can be referenced by name from other declarations, but AS3 replaces tenants wholesale — keep shared monitors in a tenant of their own and never mix them with applications.',
        ],
        before: [`tmsh list ltm monitor http /${tenant}/${app}/`, `curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`],
        config: declaration(tenant, app, 'Custom monitors', {
          http_health: { class: 'Monitor', monitorType: 'http', send, receive: expect, interval, timeout },
          ...(bool(values, 'https', true) ? { https_health: { class: 'Monitor', monitorType: 'https', send, receive: expect, interval, timeout } } : {}),
          ...(tcp ? { tcp_health: { class: 'Monitor', monitorType: 'tcp', send: 'health\\r\\n', receive: tcp, interval, timeout } } : {}),
        }),
        verify: [`tmsh list ltm monitor http /${tenant}/${app}/http_health`, 'tmsh show ltm pool <pool> members', 'Watch the pool members stay up for one full interval cycle.'],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: { module: 'f5networks.f5_bigip.bigip_as3_deploy', args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' }, hosts: 'bigips' },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_snat_pool',
    platform: PLATFORM,
    label: 'SNAT pool',
    group: 'Profiles',
    description: 'A pool of source addresses for translation, for when automap runs out of ports or the servers need to see a predictable source.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'shared_snat' },
      { id: 'addresses', label: 'SNAT addresses', control: 'textarea', default: '10.20.30.240\n10.20.30.241' },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'shared_snat'), 'shared_snat');
      // A SNAT address is one address, not a network; a /32 or /128 is read as the address.
      const entries = listOf(str(values, 'addresses', '').replace(/\n/g, ',')).map((a) => a.replace(/\/(32|128)$/, ''));
      const usable = entries.filter((a) => isIp(a));
      const invalid = entries.filter((a) => !isIp(a));
      const typed = byFamily(usable);
      const findings            = [];
      if (invalid.length > 0) {
        findings.push(error('network.f5.bad-snat-address', `Not a single IPv4 or IPv6 address: ${invalid.join(', ')}.`, { source: 'ArchToolKit' }));
      }
      if (usable.length === 0) findings.push(error('network.f5.no-snat-addresses', 'A SNAT pool with no addresses translates nothing.', { source: 'ArchToolKit' }));
      if (usable.length === 1) {
        findings.push(
          warning('network.f5.snat-port-exhaustion', 'One SNAT address gives about 64,000 concurrent connections per destination. A busy application will exhaust it and fail in a way that looks like a network problem.', {
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `SNAT pool with ${usable.length} address(es)`,
        impact: 'brief',
        notes: [
          'The servers must route back to the BIG-IP for these addresses, and anything filtering between them has to permit them.',
          'Changing a live virtual server from automap to a SNAT pool changes the source address the servers see — check the application and any allow-lists first.',
          ...(typed.v4.length > 0 && typed.v6.length > 0
            ? ['The pool holds both families. The BIG-IP picks a SNAT address of the same family as the pool member it is connecting to, so each family needs enough addresses of its own.']
            : []),
        ],
        before: [`curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`, 'tmsh list ltm snatpool'],
        config: declaration(tenant, app, 'SNAT pool', {
          [`${app}_snatpool`]: { class: 'SNAT_Pool', snatAddresses: usable },
        }),
        verify: ['tmsh list ltm snatpool', 'tmsh show sys connection | head', 'Check the servers see the new source addresses.'],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: { module: 'f5networks.f5_bigip.bigip_as3_deploy', args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' }, hosts: 'bigips' },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_client_ssl',
    platform: PLATFORM,
    label: 'Client SSL profile with SNI',
    group: 'Profiles',
    description: 'A TLS profile serving more than one certificate by SNI, with the cipher policy and the protocol versions pinned.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'tls_profiles' },
      { id: 'certificates', label: 'Certificates on the device', control: 'textarea', default: '/Common/wildcard-corp\n/Common/api-corp', hint: 'One per line; they must already exist' },
      { id: 'default_certificate', label: 'Default certificate', control: 'text', default: '/Common/wildcard-corp', hint: 'Served when the client sends no SNI' },
      { id: 'minimum_tls', label: 'Minimum TLS version', control: 'select', default: 'tls1_2', options: [{ value: 'tls1_2', label: 'TLS 1.2' }, { value: 'tls1_3', label: 'TLS 1.3 only' }] },
      { id: 'cipher_group', label: 'Cipher group', control: 'text', default: '/Common/f5-default', hint: 'A cipher group or rule that already exists' },
      { id: 'hsts', label: 'Add HSTS', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'tls'), 'tls');
      const certificates = listOf(str(values, 'certificates', '').replace(/\n/g, ','));
      const minimum = str(values, 'minimum_tls', 'tls1_2');
      const findings            = [];
      if (certificates.length === 0) findings.push(error('network.f5.no-certificate', 'No certificate was named, so the profile would serve nothing.', { source: 'ArchToolKit' }));
      findings.push(
        warning('network.f5.certificate-reference', 'The certificates are referenced, not carried. Import them on the BIG-IP first — nothing here uploads a key.', { source: 'ArchToolKit' }),
      );
      if (minimum === 'tls1_3') {
        findings.push(
          warning('network.f5.tls13-only', 'TLS 1.3 only will refuse older clients outright, including some payment terminals and embedded devices.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Client SSL profile serving ${certificates.length} certificate(s)`,
        impact: 'brief',
        notes: [
          'SNI lets one virtual server present the right certificate per hostname. A client that sends no SNI gets the default one, which is why there has to be a sensible default.',
          'Changing the minimum TLS version on a live listener disconnects anything that cannot negotiate it, immediately.',
        ],
        before: [`curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`, 'tmsh list ltm profile client-ssl', 'tmsh list sys file ssl-cert'],
        config: declaration(tenant, app, 'Client SSL with SNI', {
          [`${app}_clientssl`]: {
            class: 'TLS_Server',
            certificates: certificates.map((certificate, index) => ({
              certificate: `cert_${index}`,
              ...(certificate === str(values, 'default_certificate', '') || index === 0 ? { matchToSNI: undefined } : {}),
            })),
            ciphers: undefined,
            cipherGroup: { bigip: str(values, 'cipher_group', '/Common/f5-default') },
            tls1_2Enabled: minimum === 'tls1_2',
            tls1_3Enabled: true,
            tls1_1Enabled: false,
            tls1_0Enabled: false,
            ...(bool(values, 'hsts', true) ? { insertEmptyFragmentsEnabled: false } : {}),
          },
          ...Object.fromEntries(certificates.map((certificate, index) => [`cert_${index}`, { class: 'Certificate', certificate: { bigip: certificate }, privateKey: { bigip: certificate } }])),
        }),
        verify: [
          `tmsh list ltm profile client-ssl /${tenant}/${app}/${app}_clientssl`,
          `openssl s_client -connect <virtual>:443 -servername ${certificates[0] ?? 'host'} | head`,
          'Check an older client can still connect, if you support any.',
        ],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: { module: 'f5networks.f5_bigip.bigip_as3_deploy', args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' }, hosts: 'bigips' },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_pool_member_maintenance',
    platform: PLATFORM,
    label: 'Take a pool member out of service',
    group: 'Operations',
    description: 'Disable or force a member offline for maintenance, and the commands that drain it gracefully and put it back.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application', control: 'text', default: 'web_app' },
      { id: 'pool', label: 'Pool name', control: 'text', default: 'web_app_pool' },
      { id: 'member', label: 'Member address', control: 'text', default: '10.20.30.11' },
      { id: 'port', label: 'Member port', control: 'number', default: 8080, min: 1, max: 65535 },
      { id: 'mode', label: 'How', control: 'select', default: 'disable', options: [
        { value: 'disable', label: 'Disable — existing connections finish, no new ones' },
        { value: 'offline', label: 'Force offline — existing connections dropped too' },
      ] },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'web_app'), 'web_app');
      const pool = str(values, 'pool', 'pool');
      const member = str(values, 'member', '');
      const port = num(values, 'port', 8080);
      const offline = str(values, 'mode', 'disable') === 'offline';
      const path = `/${tenant}/${app}`;
      // tmsh names an IPv6 member address.port, an IPv4 one address:port.
      const name = tmshMember(member, port);
      const findings            = [];
      if (!isIp(member)) findings.push(error('network.f5.bad-member', 'The member address is not a valid IPv4 or IPv6 address.', { source: 'ArchToolKit' }));

      return {
        platform: PLATFORM,
        title: `${offline ? 'Force offline' : 'Disable'} ${name} in ${pool}`,
        impact: offline ? 'outage' : 'brief',
        notes: [
          'This is a tmsh action, not a declaration: AS3 would replace the tenant, and a maintenance state does not belong in the declaration.',
          offline
            ? 'Force offline drops the connections the member is serving. Use disable and wait for the count to reach zero unless you need it gone now.'
            : 'Disable stops new connections but lets existing ones finish. Watch the connection count before you touch the server.',
          'Check the pool still has enough members up to carry the load before taking one out.',
        ],
        before: [`tmsh show ltm pool ${path}/${pool} members`, `tmsh show sys connection ss-server-addr ${member} | wc -l`],
        config: [
          `tmsh modify ltm pool ${path}/${pool} members modify { ${name} { state ${offline ? 'user-down' : 'user-up'} session user-disabled } }`,
          ...(offline ? [`tmsh delete sys connection ss-server-addr ${member}`] : []),
        ],
        verify: [`tmsh show ltm pool ${path}/${pool} members`, `tmsh show sys connection ss-server-addr ${member} | wc -l`, 'Watch the application through the virtual server.'],
        backout: [`tmsh modify ltm pool ${path}/${pool} members modify { ${name} { state user-up session user-enabled } }`, `tmsh show ltm pool ${path}/${pool} members`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_remove_tenant',
    platform: PLATFORM,
    label: 'Remove an application (tenant)',
    group: 'Operations',
    description: 'Delete a tenant and everything in it — the decommission half of AS3, with the capture that makes it reversible.',
    inputs: [
      { id: 'tenant', label: 'Tenant to remove', control: 'text', default: 'Prod' },
      { id: 'confirm', label: 'I have captured the current declaration', control: 'toggle', default: false },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const confirmed = bool(values, 'confirm', false);
      const findings            = [];
      if (!confirmed) {
        findings.push(
          error('network.f5.not-captured', 'Capture the tenant’s current declaration before removing it. Without it there is no back-out.', {
            remediation: `curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`,
            source: 'ArchToolKit',
          }),
        );
      }

      return {
        platform: PLATFORM,
        title: `Remove tenant ${tenant} and every application in it`,
        impact: 'outage',
        notes: [
          'This deletes every virtual server, pool, monitor and profile in the tenant. Whatever was being served stops being served.',
          'The back-out is re-posting the declaration captured first. There is no other undo.',
          'Check DNS is not still pointing at the virtual addresses before you remove them.',
        ],
        before: [
          `curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`,
          `tmsh show ltm virtual /${tenant}/ | head -40`,
          `tmsh show sys connection | grep ${tenant} | wc -l`,
        ],
        config: [
          `# Remove the tenant. There is no undo but the file captured above.`,
          `curl -sku $USER -X DELETE https://bigip/mgmt/shared/appsvcs/declare/${tenant}`,
        ],
        verify: [`curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant}`, `tmsh list ltm virtual /${tenant}/`, 'Confirm nothing is still trying to reach the virtual addresses.'],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: {
          module: 'f5networks.f5_bigip.bigip_as3_deploy',
          args: { tenant, state: 'absent' },
          hosts: 'bigips',
        },
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'f5_http_profile',
    platform: PLATFORM,
    label: 'HTTP profile with compression and caching',
    group: 'Profiles',
    description: 'HTTP tuning: X-Forwarded-For, compression, a caching profile and the header the application needs to know it was TLS.',
    inputs: [
      { id: 'tenant', label: 'Tenant', control: 'text', default: 'Prod' },
      { id: 'application', label: 'Application name', control: 'text', default: 'http_profiles' },
      { id: 'xff', label: 'Insert X-Forwarded-For', control: 'toggle', default: true },
      { id: 'ssl_header', label: 'Tell the application it was HTTPS', control: 'toggle', default: true, hint: 'Inserts X-Forwarded-Proto: https' },
      { id: 'compression', label: 'Compression', control: 'toggle', default: true },
      { id: 'caching', label: 'Cache static content', control: 'toggle', default: false },
      { id: 'cache_size_mb', label: 'Cache size (MB)', control: 'number', default: 100, min: 1, max: 4096, showWhen: { input: 'caching', equals: ['true'] } },
    ],
    change: (values                 )               => {
      const tenant = clean(str(values, 'tenant', 'Prod'), 'Prod');
      const app = clean(str(values, 'application', 'http_profiles'), 'http_profiles');
      const compression = bool(values, 'compression', true);
      const caching = bool(values, 'caching', false);

      return {
        platform: PLATFORM,
        title: 'HTTP profile: XFF, compression, caching',
        impact: 'brief',
        notes: [
          'X-Forwarded-For is how the application sees the real client address. Without it every log line says the BIG-IP.',
          ...(compression ? ['Compression costs CPU on the BIG-IP and saves bandwidth. On an internal application it is usually the wrong trade.'] : []),
          ...(caching ? ['Caching serves stale content when the rules are wrong. Start with images and static assets only.'] : []),
          'Applying a new profile to a live virtual server resets connections using the old one.',
        ],
        before: [`curl -sku $USER https://bigip/mgmt/shared/appsvcs/declare/${tenant} > ${tenant}-before.json`, 'tmsh list ltm profile http'],
        config: declaration(tenant, app, 'HTTP profiles', {
          [`${app}_http`]: {
            class: 'HTTP_Profile',
            xForwardedFor: bool(values, 'xff', true),
            ...(bool(values, 'ssl_header', true) ? { insertHeader: { name: 'X-Forwarded-Proto', value: 'https' } } : {}),
            ...(caching ? { cacheSize: num(values, 'cache_size_mb', 100), cacheMaxAge: 3600, cacheMaxEntries: 10000 } : {}),
          },
          ...(compression ? { [`${app}_compress`]: { class: 'HTTP_Compress', contentTypeIncludes: ['text/', 'application/json', 'application/javascript'], minimumSize: 1024 } } : {}),
        }),
        verify: [`tmsh list ltm profile http /${tenant}/${app}/${app}_http`, 'curl -skI https://<virtual>/ | grep -i encoding', 'Check the application logs show the real client addresses.'],
        backout: [`curl -sku $USER -X POST https://bigip/mgmt/shared/appsvcs/declare -d @${tenant}-before.json`],
        push: { module: 'f5networks.f5_bigip.bigip_as3_deploy', args: { content: `{{ lookup('file', '${app}.json') }}`, tenant, state: 'present' }, hosts: 'bigips' },
      };
    },
  }),
];

/** The one change here that is an action rather than a declaration has its own module. */
const PUSHES                                                                                            = {
  f5_pool_member_maintenance: (values) => ({
    module: 'f5networks.f5_modules.bigip_pool_member',
    args: {
      provider: '{{ provider }}',
      pool: str(values, 'pool', 'pool'),
      partition: clean(str(values, 'tenant', 'Prod'), 'Prod'),
      host: str(values, 'member', ''),
      port: num(values, 'port', 8080),
      state: str(values, 'mode', 'disable') === 'offline' ? 'forced_offline' : 'disabled',
    },
    hosts: 'bigips',
  }),
};

export const F5_EXTRA                             = BLUEPRINTS.map((blueprint) => {
  const push = PUSHES[blueprint.id];
  return push ? withPush(blueprint, push) : blueprint;
});

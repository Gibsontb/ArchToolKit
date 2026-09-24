/**
 * IPv6 in the Splunk blueprints.
 *
 * Splunk takes IPv6 in the places a network touches it: listeners
 * (listenOnIPv6, per stanza or in server.conf [general]), acceptFrom, server
 * lists written [address]:port with connectUsingIpVersion to reach them, SC4S
 * (SC4S_IPV6_ENABLE), and Splunk Cloud's separate IPv6 allow lists
 * (ipallowlists-v6). ACS outbound ports stay IPv4 and refuse IPv6. IPv4 input
 * writes what it always did.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { SPLUNK_BLUEPRINTS } from './blueprints/index.ts';
import { hostRegexOf } from './blueprints/forwarder.ts';

function blueprint(id: string) {
  const found = SPLUNK_BLUEPRINTS.flatMap((g) => g.blueprints).find((b) => b.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function build(id: string, overrides: BlueprintValues = {}) {
  const b = blueprint(id);
  return b.build({ ...defaultValues(b), ...overrides }, id);
}

const codes = (out: ReturnType<typeof build>, severity?: string) => (out.findings ?? []).filter((f) => !severity || f.severity === severity).map((f) => f.code);
const file = (out: ReturnType<typeof build>, suffix: string) => String(Object.entries(out.files).find(([path]) => path.endsWith(suffix))?.[1] ?? '');
const all = (out: ReturnType<typeof build>) => Object.values(out.files).map(String).join('\n');

describe('splunk_acs_network: IPv4 and IPv6 allow lists', () => {
  it('writes only the IPv4 list from IPv4 subnets, as before', () => {
    const out = build('splunk_acs_network');
    expect(codes(out, 'error')).toEqual([]);
    expect(file(out, 'allowlist-search-api.txt')).toContain('203.0.113.0/24');
    expect(Object.keys(out.files).some((p) => p.endsWith('-v6.txt'))).toBe(false);
    expect(all(out)).not.toContain('ipallowlists-v6  body');
  });

  it('puts IPv6 subnets in their own list and file, never mixed into the IPv4 one', () => {
    const out = build('splunk_acs_network', { subnets: '203.0.113.0/24\n2001:DB8:AB::/48\n2001:db8:cd::1/128' });
    expect(codes(out, 'error')).toEqual([]);
    const v4 = file(out, 'allowlist-search-api.txt');
    const v6 = file(out, 'allowlist-search-api-v6.txt');
    expect(v4).toContain('203.0.113.0/24');
    expect(v4).not.toContain('2001:');
    expect(v6).toContain('2001:db8:ab::/48');
    expect(v6).toContain('2001:db8:cd::1/128');
    expect(v6).not.toContain('203.0.113.0');
    const sh = file(out, 'acs-network.sh');
    expect(sh).toContain('AL="/access/$FEATURE/ipallowlists$SUFFIX"');
    expect(sh).toContain('OPEN="::/0"');
    expect(sh).toContain('--ipv6) V6=1');
    expect(all(out)).toContain('ipallowlists-v6');
  });

  it('refuses ::/0 and IPv6 host bits, and warns on unique-local, link-local and too-wide IPv6', () => {
    expect(codes(build('splunk_acs_network', { subnets: '::/0' }), 'error')).toContain('splunk.acs-allowlist-open');
    expect(codes(build('splunk_acs_network', { subnets: '2001:db8::1/64' }), 'error')).toContain('splunk.acs-allowlist-host-bits');
    expect(codes(build('splunk_acs_network', { subnets: 'fd00:1::/64' }), 'warning')).toContain('splunk.acs-allowlist-private');
    expect(codes(build('splunk_acs_network', { subnets: 'fe80::/64' }), 'warning')).toContain('splunk.acs-allowlist-private');
    expect(codes(build('splunk_acs_network', { subnets: '2000::/16' }), 'warning')).toContain('splunk.acs-allowlist-wide');
    expect(codes(build('splunk_acs_network', { subnets: '2001:db8::/48' }))).not.toContain('splunk.acs-allowlist-private');
    expect(codes(build('splunk_acs_network', { subnets: '10.1.0.0/16' }), 'warning')).toContain('splunk.acs-allowlist-private');
  });

  it('refuses IPv6 outbound-port destinations: ACS outbound ports are IPv4', () => {
    const out = build('splunk_acs_network', { outbound: true, outbound_subnets: '198.51.100.40/32\n2001:db8::40/128' });
    expect(codes(out, 'error')).toContain('splunk.acs-outbound-ipv6');
    expect(file(out, 'outbound-ports.spec')).not.toContain('2001:db8');
    expect(file(out, 'outbound-ports.spec')).toContain('198.51.100.40/32');
  });
});

describe('splunk_network_input: listenOnIPv6 and acceptFrom', () => {
  it('writes no IPv6 setting by default', () => {
    const out = build('splunk_network_input');
    expect(codes(out, 'error')).toEqual([]);
    expect(all(out)).not.toContain('listenOnIPv6');
    expect(all(out)).not.toContain('acceptFrom');
    expect(file(out, 'transforms.conf')).toContain('REGEX = ^host::10\\.0\\.1\\.');
  });

  it('listens dual-stack per stanza, accepts IPv6 networks and routes an IPv6 /48', () => {
    const out = build('splunk_network_input', { listen_ipv6: 'yes', accept_from: '10.0.0.0/8, 2001:db8::/32, !2001:db8:bad::/48', routes: '10.0.1.0/24 | cisco:ios | network\n2001:db8:10::/48 | pan:traffic | security' });
    expect(codes(out, 'error')).toEqual([]);
    const inputs = file(out, 'inputs.conf');
    expect(inputs).toContain('listenOnIPv6 = yes');
    expect(inputs).toContain('acceptFrom = 10.0.0.0/8, 2001:db8::/32, !2001:db8:bad::/48');
    expect(file(out, 'transforms.conf')).toContain('REGEX = ^host::2001:db8:10:');
    expect(file(out, 'props.conf')).toContain('route_1_sourcetype');
  });

  it('puts HEC’s IPv6 switch in server.conf [general], where splunkd reads it', () => {
    const out = build('splunk_network_input', { protocol: 'hec', listen_ipv6: 'yes', accept_from: '2001:db8::/32' });
    expect(file(out, 'server.conf')).toContain('[general]');
    expect(file(out, 'server.conf')).toContain('listenOnIPv6 = yes');
    expect(file(out, 'inputs.conf')).toContain('acceptFrom = 2001:db8::/32');
    expect(file(out, 'inputs.conf')).not.toContain('listenOnIPv6');
  });

  it('warns when an IPv6 network is named but the listener hears IPv4 only, and refuses a bad route', () => {
    expect(codes(build('splunk_network_input', { accept_from: '2001:db8::/32' }), 'warning')).toContain('splunk.input-ipv6-not-listening');
    expect(codes(build('splunk_network_input', { listen_ipv6: 'only', accept_from: '10.0.0.0/8' }), 'warning')).toContain('splunk.input-ipv4-not-listening');
    expect(codes(build('splunk_network_input', { listen_ipv6: 'yes', routes: '2001:db8::/40 | x | y' }), 'error')).toContain('splunk.route-ipv6-prefix');
    expect(codes(build('splunk_network_input', { accept_from: 'bad:::entry:' }), 'error')).toContain('splunk.accept-from-invalid');
  });

  it('builds host regexes that match only the address as inet_ntop writes it', () => {
    expect(hostRegexOf('2001:db8:10::/48')).toBe('^host::2001:db8:10:');
    expect(hostRegexOf('2001:db8:0:1::/64')).toBe('^host::2001:db8:0:1:');
    expect(hostRegexOf('2001:db8::/48')).toBe(null);
    expect(hostRegexOf('2001:DB8::5')).toBe('^host::2001:db8::5$');
    expect(hostRegexOf('10.0.1.0/24')).toBe('^host::10\\.0\\.1\\.');
  });
});

describe('splunk_outputs: [IPv6]:port and connectUsingIpVersion', () => {
  it('writes the IPv4 list unchanged and no server.conf', () => {
    const out = build('splunk_outputs');
    expect(file(out, 'outputs.conf')).toContain('server = idx01.example.com:9997, idx02.example.com:9997, idx03.example.com:9997');
    expect(Object.keys(out.files).some((p) => p.endsWith('server.conf'))).toBe(false);
  });

  it('brackets an IPv6 indexer and sets 4-first so a default forwarder reaches it', () => {
    const out = build('splunk_outputs', { indexers: '10.0.0.21:9997\n[2001:DB8::22]:9997' });
    expect(codes(out, 'error')).toEqual([]);
    expect(file(out, 'outputs.conf')).toContain('server = 10.0.0.21:9997, [2001:db8::22]:9997');
    expect(file(out, 'server.conf')).toContain('connectUsingIpVersion = 4-first');
  });

  it('refuses an unbracketed IPv6 indexer and a family the connect setting forbids', () => {
    expect(codes(build('splunk_outputs', { indexers: '2001:db8::22:9997\nidx02.example.com:9997' }), 'error')).toContain('splunk.outputs-ipv6-brackets');
    expect(codes(build('splunk_outputs', { indexers: '[2001:db8::22]:9997\nidx02.example.com:9997', ip_version: '4-only' }), 'error')).toContain('splunk.outputs-ipv6-unreachable');
    expect(codes(build('splunk_outputs', { indexers: '[2001:db8::22]:9997\n10.0.0.2:9997', ip_version: '6-only' }), 'error')).toContain('splunk.outputs-ipv4-unreachable');
  });
});

describe('heavy forwarder: routing, HEC and SC4S', () => {
  it('writes IPv6 indexer groups and syslog receivers in brackets, with connectUsingIpVersion', () => {
    const out = build('splunk_hf_routing', { groups: 'primary_indexers | [2001:db8::31]:9997, idx2.corp.example.com:9997\nsoc_siem | soc-idx.partner.example.com:9997', syslog_groups: 'legacy_siem | [2001:db8::514]:514 | tcp' });
    expect(codes(out, 'error')).toEqual([]);
    expect(file(out, 'outputs.conf')).toContain('server = [2001:db8::31]:9997, idx2.corp.example.com:9997');
    expect(file(out, 'outputs.conf')).toContain('server = [2001:db8::514]:514');
    expect(file(out, 'server.conf')).toContain('connectUsingIpVersion = 4-first');
    expect(Object.keys(build('splunk_hf_routing').files).some((p) => p.endsWith('server.conf'))).toBe(false);
  });

  it('sets HEC’s listenOnIPv6 in server.conf and acceptFrom on [http]', () => {
    const out = build('splunk_hec', { listen_ipv6: 'yes', accept_from: '10.0.0.0/8, 2001:db8::/32' });
    expect(codes(out, 'error')).toEqual([]);
    expect(file(out, 'server.conf')).toContain('listenOnIPv6 = yes');
    expect(file(out, 'inputs.conf')).toContain('acceptFrom = 10.0.0.0/8, 2001:db8::/32');
    expect(Object.keys(build('splunk_hec').files).some((p) => p.endsWith('server.conf'))).toBe(false);
  });

  it('turns on SC4S_IPV6_ENABLE only when asked', () => {
    expect(all(build('splunk_sc4s'))).not.toContain('SC4S_IPV6_ENABLE');
    expect(all(build('splunk_sc4s', { ipv6: true }))).toContain('SC4S_IPV6_ENABLE=yes');
  });
});

describe('onboarding, deployment server and search peers', () => {
  it('sends IOS syslog to an IPv6 collector with the ipv6 keyword, and refuses an IPv4-only listener for it', () => {
    const refused = build('splunk_onboard_network', { collector_ip: '2001:db8::514' });
    expect(codes(refused, 'error')).toContain('splunk.collector-ipv6-not-listening');
    const out = build('splunk_onboard_network', { collector_ip: '2001:db8::514', listen_ipv6: 'yes', collector: 'hf' });
    expect(codes(out)).not.toContain('splunk.collector-ipv6-not-listening');
    expect(all(out)).toContain('logging host ipv6 2001:db8::514 transport tcp port');
    expect(all(out)).toContain('listenOnIPv6 = yes');
    expect(all(build('splunk_onboard_network', { collector_ip: '10.0.5.10' }))).not.toContain('logging host ipv6');
  });

  it('brackets an IPv6 collector in the ESXi log host URL', () => {
    const out = build('splunk_onboard_vmware', { collector_host: '2001:db8::514', listen_ipv6: 'yes' });
    expect(all(out)).toContain('://[2001:db8::514]:');
  });

  it('writes an IPv6 deployment server as [address]:port', () => {
    const out = build('splunk_uf_install', { deployment_server: '[2001:db8::89]:8089' });
    expect(all(out)).toContain('targetUri = [2001:db8::89]:8089');
    expect(all(build('splunk_uf_install'))).toContain('targetUri = ds01.example.com:8089');
  });

  it('accepts an IPv6 search peer and writes its URI in brackets', () => {
    const out = build('splunk_distsearch_peers', { peers: '2001:db8::1 | 8089 | admin\nidx02.example.com | 8089 | admin' });
    expect(codes(out, 'error')).toEqual([]);
    expect(all(out)).toContain('https://[2001:db8::1]:8089');
  });
});

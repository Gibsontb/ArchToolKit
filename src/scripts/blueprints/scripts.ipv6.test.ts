/**
 * Dual-stack in the scripts that touch addresses.
 *
 * The firewall script is the one that matters: a rule set that filters IPv4
 * and leaves IPv6 open is a security hole that looks like a finished job, and
 * a rule set that drops ICMPv6 breaks IPv6 a few minutes after it goes on.
 * The rest — the DNS and DHCP report, the batch inventory — just have to see
 * the IPv6 half of the estate as well as the IPv4 half.
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { defaultValues } from '../../kit/blueprint.ts';
import { hasErrors } from '../../core/findings.ts';
import { renderScript, type Script } from '../script.ts';
import { scriptFor } from './index.ts';

function run(id: string, overrides: Record<string, unknown> = {}): { script: Script; text: string } {
  const blueprint = scriptFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  const script = blueprint.script({ ...defaultValues(blueprint), ...overrides } as never, id);
  return { script, text: renderScript(script, id) };
}

const codes = (script: Script) => (script.findings ?? []).map((f) => f.code);

/** The lines of one bash function, from its opening line to the closing brace. */
function fn(text: string, name: string): string {
  const start = text.indexOf(`${name}() {`);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end);
}

const RULES = '22/tcp | 10.0.1.0/24 | SSH v4\n22/tcp | 2001:db8:0:1::/64 | SSH v6\n443/tcp | any | HTTPS';

describe('sh_firewall_rules: IPv6', () => {
  it('accepts IPv6 sources, and builds with no errors from its defaults', () => {
    const { script } = run('sh_firewall_rules');
    expect(hasErrors(script.findings ?? [])).toBe(false);
    const { script: mine } = run('sh_firewall_rules', { rules: RULES });
    expect(hasErrors(mine.findings ?? [])).toBe(false);
  });

  it('writes ip6 saddr for IPv6 sources and ip saddr for IPv4, in one inet table', () => {
    const { text } = run('sh_firewall_rules', { rules: RULES, backend: 'nftables' });
    const nft = fn(text, 'apply_nftables');
    expect(nft).toContain('table inet filter {');
    expect(nft).toContain('    ip saddr 10.0.1.0/24 tcp dport 22 accept comment "SSH v4"');
    expect(nft).toContain('    ip6 saddr 2001:db8:0:1::/64 tcp dport 22 accept comment "SSH v6"');
    // "any" is both families: no address match at all.
    expect(nft).toContain('    tcp dport 443 accept comment "HTTPS"');
    expect(nft).not.toContain('ip saddr 2001');
    expect(nft).not.toContain('ip6 saddr 10.');
  });

  it('keeps the IPv4 rule lines exactly as they were', () => {
    const { text } = run('sh_firewall_rules', { rules: '22/tcp | 10.0.1.0/24 | SSH from management', backend: 'iptables' });
    expect(text).toContain('  iptables -A INPUT -p tcp --dport 22 -s 10.0.1.0/24 -m comment --comment "SSH from management" -j ACCEPT');
    expect(text).toContain('  iptables -A INPUT -p icmp -j ACCEPT');
  });

  it('writes ip6tables rules and the same default policy as iptables', () => {
    const { text } = run('sh_firewall_rules', { rules: RULES, backend: 'iptables' });
    const ipt = fn(text, 'apply_iptables');
    expect(ipt).toContain('    ip6tables -P INPUT DROP');
    expect(ipt).toContain('  iptables -P INPUT DROP');
    expect(ipt).toContain('    ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    expect(ipt).toContain('    ip6tables -A INPUT -p tcp --dport 22 -s 2001:db8:0:1::/64 -m comment --comment "SSH v6" -j ACCEPT');
    expect(ipt).toContain('    ip6tables -A INPUT -p tcp --dport 443 -m comment --comment "HTTPS" -j ACCEPT');
    expect(ipt).toContain('  iptables -A INPUT -p tcp --dport 443 -m comment --comment "HTTPS" -j ACCEPT');
    // Never a family in the other family's tool.
    expect(ipt).not.toContain('iptables -A INPUT -p tcp --dport 22 -s 2001');
    expect(ipt).not.toContain('ip6tables -A INPUT -p tcp --dport 22 -s 10.');
    // Backed up and restored with the IPv4 rules.
    expect(text).toContain('ip6tables-save > "$BACKUP6"');
    expect(text).toContain('ip6tables-restore < "$BACKUP6"');
  });

  it('treats 0.0.0.0/0 as IPv4 only and ::/0 as IPv6 only', () => {
    const { text } = run('sh_firewall_rules', { rules: '22/tcp | 10.0.1.0/24 | SSH\n80/tcp | 0.0.0.0/0 | web4\n8080/tcp | ::/0 | web6', backend: 'iptables' });
    const ipt = fn(text, 'apply_iptables');
    expect(ipt).toContain('  iptables -A INPUT -p tcp --dport 80 -m comment --comment "web4" -j ACCEPT');
    expect(ipt).not.toContain('ip6tables -A INPUT -p tcp --dport 80 ');
    expect(ipt).toContain('    ip6tables -A INPUT -p tcp --dport 8080 -m comment --comment "web6" -j ACCEPT');
    expect(ipt).not.toContain('  iptables -A INPUT -p tcp --dport 8080 ');
    const { text: nftText } = run('sh_firewall_rules', { rules: '22/tcp | 10.0.1.0/24 | SSH\n80/tcp | 0.0.0.0/0 | web4\n8080/tcp | ::/0 | web6', backend: 'nftables' });
    expect(nftText).toContain('ip saddr 0.0.0.0/0 tcp dport 80 accept');
    expect(nftText).toContain('ip6 saddr ::/0 tcp dport 8080 accept');
  });

  it('writes the rich-rule family from the source instead of always ipv4', () => {
    const { text } = run('sh_firewall_rules', { rules: RULES, backend: 'firewalld' });
    expect(text).toContain(`--add-rich-rule='rule family="ipv4" source address="10.0.1.0/24" port port="22" protocol="tcp" accept'`);
    expect(text).toContain(`--add-rich-rule='rule family="ipv6" source address="2001:db8:0:1::/64" port port="22" protocol="tcp" accept'`);
    expect(text).toContain('firewall-cmd --permanent --add-port=443/tcp');
    expect(text).not.toContain('family="ipv4" source address="2001');
  });

  it('keeps neighbour discovery and packet-too-big when ping is turned off', () => {
    const { text: nft } = run('sh_firewall_rules', { rules: RULES, backend: 'nftables', allow_icmp: false });
    expect(nft).toContain('icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem, mld-listener-query, nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept');
    expect(nft).not.toContain('ip protocol icmp accept');
    const { text: ipt } = run('sh_firewall_rules', { rules: RULES, backend: 'iptables', allow_icmp: false });
    for (const type of ['neighbour-solicitation', 'neighbour-advertisement', 'router-advertisement', 'packet-too-big']) {
      expect(ipt).toContain(`ip6tables -A INPUT -p ipv6-icmp --icmpv6-type ${type} -j ACCEPT`);
    }
    expect(ipt).not.toContain('iptables -A INPUT -p icmp -j ACCEPT');
  });

  it('never writes REJECT as a chain policy, which neither tool accepts', () => {
    const { text } = run('sh_firewall_rules', { rules: RULES, default_policy: 'reject', backend: 'iptables' });
    expect(text).not.toContain('-P INPUT REJECT');
    expect(text).toContain('  iptables -A INPUT -j REJECT --reject-with icmp-port-unreachable');
    expect(text).toContain('    ip6tables -A INPUT -j REJECT --reject-with icmp6-port-unreachable');
    const { text: nft } = run('sh_firewall_rules', { rules: RULES, default_policy: 'reject', backend: 'nftables' });
    expect(nft).not.toContain('policy reject');
    expect(nft).toContain('reject with icmpx type port-unreachable');
  });

  it('refuses a source that is neither family, and warns about SSH from ::/0 or any', () => {
    const bad = run('sh_firewall_rules', { rules: '22/tcp | 10.0.1.0/24 | SSH\n80/tcp | 2001:db8::zz/64 | web' }).script;
    expect(codes(bad)).toContain('scripts.sh.bad-source');
    expect(hasErrors(bad.findings ?? [])).toBe(true);
    expect(codes(run('sh_firewall_rules', { rules: '22/tcp | ::/0 | SSH' }).script)).toContain('scripts.sh.ssh-from-anywhere');
    expect(codes(run('sh_firewall_rules', { rules: '22/tcp | any | SSH' }).script)).toContain('scripts.sh.ssh-from-anywhere');
  });

  it('writes a network with host bits set as the network, and says so', () => {
    const { script, text } = run('sh_firewall_rules', { rules: '22/tcp | 2001:db8:0:1::5/64 | SSH', backend: 'nftables' });
    expect(text).toContain('ip6 saddr 2001:db8:0:1::/64 tcp dport 22');
    expect(codes(script)).toContain('scripts.sh.source-host-bits');
    // Uncompressed but otherwise correct: no warning.
    expect(codes(run('sh_firewall_rules', { rules: '22/tcp | 2001:0db8:0000:0001::/64 | SSH' }).script)).not.toContain('scripts.sh.source-host-bits');
  });
});

describe('ps_dns_dhcp_report: IPv6', () => {
  it('reads AAAA records beside A records, and DHCPv6 scopes beside IPv4 ones', () => {
    const { text } = run('ps_dns_dhcp_report');
    expect(text).toContain("foreach ($rrType in @('A', 'AAAA')) {");
    expect(text).toContain('$record.RecordData.IPv6Address.IPAddressToString');
    expect(text).toContain('Get-DhcpServerv6Scope -ComputerName $server -ErrorAction Stop');
    expect(text).toContain('Get-DhcpServerv6ScopeStatistics -ComputerName $server -Prefix $scope.Prefix');
    // One A and one AAAA for a name is dual-stack, not a duplicate.
    expect(text).toContain('Group-Object Zone, Name, Type');
  });

  it('keeps the IPv4 half as it was, and drops the IPv6 half when asked', () => {
    const { text } = run('ps_dns_dhcp_report', { include_ipv6: false });
    expect(text).toContain('Get-DhcpServerv4Scope -ComputerName $server -ErrorAction Stop');
    expect(text).toContain('$record.RecordData.IPv4Address.IPAddressToString');
    expect(text).toContain("foreach ($rrType in @('A')) {");
    expect(text).not.toContain('Get-DhcpServerv6Scope');
  });
});

describe('cmd inventory and diagnostics: IPv6', () => {
  it('records the global IPv6 address beside the IPv4 one', () => {
    const { text } = run('cmd_system_inventory');
    expect(text).toContain('findstr /r /c:"^ *IPv6 Address"');
    expect(text).toContain('tokens=1,* delims=:');
    expect(text).toContain('echo ComputerName,Domain,IPAddress,IPv6Address,');
    expect(text).toContain('findstr /c:"IPv4 Address"');
  });

  it('pings a name over each family, and an IPv6 literal as it is', () => {
    const blueprint = scriptFor('cmd_diagnostics');
    if (!blueprint) throw new Error('no cmd_diagnostics');
    const byName = renderScript(blueprint.script({ ...defaultValues(blueprint), focus: 'network', target_host: 'app.example.com' } as never, blueprint.id), blueprint.id);
    expect(byName).toContain('ping -6 -n 4 app.example.com');
    expect(byName).toContain('netsh interface ipv6 show neighbors');
    const byV6 = renderScript(blueprint.script({ ...defaultValues(blueprint), focus: 'network', target_host: '2001:db8::1' } as never, blueprint.id), blueprint.id);
    expect(byV6).toContain('ping -n 10 2001:db8::1');
    expect(byV6).not.toContain('ping -4');
  });
});

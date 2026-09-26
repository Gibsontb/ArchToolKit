import { describe, it } from 'node:test';
import { expect } from '../../../testing/expect.ts';
import { classifyType } from '../../../terraform/catalog.ts';
import { resourceSchema } from '../../../terraform/schema-blueprints.ts';
import type { HclBlock } from '../../../terraform/hcl.ts';
import type { CloudTarget } from '../../../terraform/providers.ts';
import type { Plan, Platform } from '../types.ts';
import { ruleSet, vipKey, parseService, rangeToCidrs, canonicalCidr, type ParsedConfig } from './model.ts';
import { parseAsa } from './parse-asa.ts';
import { parsePanos } from './parse-panos.ts';
import { parseFortios } from './parse-fortios.ts';
import { parseBigipConf, parseAs3, f5Destination } from './parse-f5.ts';
import { parseRulesCsv, parseVipsCsv } from './parse-csv.ts';
import { emitTerraform } from './emit.ts';
import {
  classifyEndpoint,
  mergeSources,
  netsecContext,
  parseDeviceConfig,
  rulesFromFlows,
  translate,
  translateConfigs,
  type NetsecContext,
  type TranslatedRule,
} from './translate.ts';

/* ------------------------------------------------------------------ fixtures --- */

const ASA = `hostname edge-asa
object network WEB-NET
 subnet 10.1.1.0 255.255.255.0
object network WEB-NET6
 subnet 2001:db8:1:1::/64
object-group network WEB
 network-object object WEB-NET
 network-object object WEB-NET6
object-group network APP
 network-object host 10.1.2.10
 network-object host 2001:db8:1:2::10
object network DB
 host 10.1.3.10
object network SHOP-WEB-PUBLIC
 host 10.1.1.10
 nat (inside,outside) static 203.0.113.20
object-group service APP-PORTS tcp
 port-object eq 8443
!
access-list INSIDE remark web to app
access-list INSIDE extended permit tcp object-group WEB object-group APP object-group APP-PORTS log
access-list INSIDE extended permit tcp host 10.1.2.10 object DB eq 1433
access-list INSIDE extended permit tcp 10.50.0.0 255.255.0.0 host 10.1.2.10 eq https
access-list INSIDE extended permit tcp any any eq ssh
access-list INSIDE extended deny ip any object DB
access-list INSIDE extended permit tcp host 10.1.4.10 host 10.1.2.10 eq 8443
access-list INSIDE extended permit tcp host 10.1.5.10 object DB eq 1433
access-list INSIDE extended permit tcp any4 object WEB-NET eq 443
access-group INSIDE in interface inside
nat (inside,outside) source dynamic WEB-NET interface
`;

const PANOS = `set address WEB-NET ip-netmask 10.1.1.0/24
set address WEB-NET6 ip-netmask 2001:db8:1:1::/64
set address-group WEB static [ WEB-NET WEB-NET6 ]
set address APP4 ip-netmask 10.1.2.10
set address APP6 ip-netmask 2001:db8:1:2::10
set address-group APP static [ APP4 APP6 ]
set address DB ip-netmask 10.1.3.10/32
set address OFFICE ip-netmask 10.50.0.0/16
set address ANY4 ip-netmask 0.0.0.0/0
set service tcp-8443 protocol tcp port 8443
set service tcp-1433 protocol tcp port 1433
set rulebase security rules web-app from trust to trust source WEB destination APP service tcp-8443 action allow
set rulebase security rules app-db source APP4 destination DB service tcp-1433 action allow
set rulebase security rules office-app source OFFICE destination APP4 service service-https action allow
set rulebase security rules ssh source any destination any application ssh service application-default action allow
set rulebase security rules deny-db source any destination DB service any action deny
set rulebase security rules crm-shop source 10.1.4.10 destination APP4 service tcp-8443 action allow
set vsys vsys1 rulebase security rules hr-db source 10.1.5.10 destination DB service tcp-1433 action allow
set rulebase security rules web-in from untrust
set rulebase security rules web-in to trust
set rulebase security rules web-in source ANY4
set rulebase security rules web-in destination WEB-NET
set rulebase security rules web-in service service-https
set rulebase security rules web-in action allow
set rulebase security rules old-rule source OFFICE destination DB service tcp-1433 action allow disabled yes
set rulebase nat rules web-snat source WEB-NET destination any service any source-translation dynamic-ip-and-port interface-address interface ethernet1/1
`;

const FORTIOS = `config firewall address
    edit "WEB-NET"
        set subnet 10.1.1.0 255.255.255.0
    next
    edit "APP4"
        set subnet 10.1.2.10 255.255.255.255
    next
    edit "DB"
        set subnet 10.1.3.10/32
    next
    edit "OFFICE"
        set subnet 10.50.0.0 255.255.0.0
    next
    edit "CRM"
        set subnet 10.1.4.10 255.255.255.255
    next
    edit "HR"
        set subnet 10.1.5.10 255.255.255.255
    next
end
config firewall address6
    edit "WEB-NET6"
        set ip6 2001:db8:1:1::/64
    next
    edit "APP6"
        set ip6 2001:db8:1:2::10/128
    next
end
config firewall service custom
    edit "tcp-8443"
        set tcp-portrange 8443
    next
    edit "tcp-1433"
        set tcp-portrange 1433
    next
end
config firewall policy
    edit 1
        set name "web-app"
        set srcintf "port2"
        set dstintf "port3"
        set srcaddr "WEB-NET"
        set dstaddr "APP4"
        set srcaddr6 "WEB-NET6"
        set dstaddr6 "APP6"
        set action accept
        set schedule "always"
        set service "tcp-8443"
        set logtraffic all
    next
    edit 2
        set name "app-db"
        set srcaddr "APP4"
        set dstaddr "DB"
        set action accept
        set service "tcp-1433"
    next
    edit 3
        set name "office-app"
        set srcaddr "OFFICE"
        set dstaddr "APP4"
        set action accept
        set service "HTTPS"
    next
    edit 4
        set name "ssh"
        set srcaddr "all"
        set dstaddr "all"
        set srcaddr6 "all"
        set dstaddr6 "all"
        set action accept
        set service "SSH"
    next
    edit 5
        set name "deny-db"
        set srcaddr "all"
        set srcaddr6 "all"
        set dstaddr "DB"
        set service "ALL"
    next
    edit 6
        set name "crm-shop"
        set srcaddr "CRM"
        set dstaddr "APP4"
        set action accept
        set service "tcp-8443"
    next
    edit 7
        set name "hr-db"
        set srcaddr "HR"
        set dstaddr "DB"
        set action accept
        set service "tcp-1433"
    next
    edit 8
        set name "web-in"
        set srcaddr "all"
        set dstaddr "WEB-NET"
        set action accept
        set service "HTTPS"
        set nat enable
    next
end
`;

const RULES_CSV = `name,src,dst,service,action
web-app,10.1.1.0/24 2001:db8:1:1::/64,10.1.2.10 2001:db8:1:2::10,tcp/8443,allow
app-db,10.1.2.10,10.1.3.10,tcp/1433,allow
office-app,10.50.0.0/16,10.1.2.10,tcp/443,permit
ssh,any,any,tcp/22,allow
deny-db,any,10.1.3.10,any,deny
crm-shop,10.1.4.10,10.1.2.10,tcp/8443,allow
hr-db,10.1.5.10,10.1.3.10,tcp/1433,allow
web-in,0.0.0.0/0,10.1.1.0/24,https,allow
`;

const BIGIP = `ltm monitor http /Common/mon_health {
    defaults-from /Common/http
    send "GET /health HTTP/1.1\\r\\nHost: shop\\r\\n\\r\\n"
}
ltm node /Common/web1 {
    address 10.1.1.10
}
ltm pool /Common/pool_web {
    members {
        /Common/web1:80 {
            address 10.1.1.10
        }
        /Common/10.1.1.11:80 {
            address 10.1.1.11
        }
    }
    monitor /Common/mon_health
}
ltm pool /Common/pool_app6 {
    members {
        /Common/2001:db8:1:2::10.8443 {
            address 2001:db8:1:2::10
        }
    }
    monitor /Common/tcp
}
ltm virtual /Common/vs_shop {
    destination /Common/203.0.113.10:443
    ip-protocol tcp
    pool /Common/pool_web
    profiles {
        /Common/http { }
        /Common/clientssl {
            context clientside
        }
        /Common/tcp { }
    }
    persist {
        /Common/cookie {
            default yes
        }
    }
}
ltm virtual /Common/vs_app6 {
    destination /Common/2001:db8:100::10.8443
    ip-protocol tcp
    pool /Common/pool_app6
    profiles { /Common/tcp { } }
    persist { /Common/source_addr { default yes } }
}
`;

const AS3 = JSON.stringify({
  class: 'AS3',
  declaration: {
    class: 'ADC',
    schemaVersion: '3.50.0',
    Shop: {
      class: 'Tenant',
      App: {
        class: 'Application',
        vs_shop: { class: 'Service_HTTPS', virtualAddresses: ['203.0.113.10'], virtualPort: 443, pool: 'pool_web', serverTLS: 'tls', persistenceMethods: ['cookie'] },
        pool_web: { class: 'Pool', monitors: [{ use: 'mon_health' }], members: [{ servicePort: 80, serverAddresses: ['10.1.1.10', '10.1.1.11'] }] },
        mon_health: { class: 'Monitor', monitorType: 'http', send: 'GET /health HTTP/1.1\r\n\r\n' },
        tls: { class: 'TLS_Server', certificates: [{ certificate: 'cert' }] },
        vs_app6: { class: 'Service_TCP', virtualAddresses: ['2001:db8:100::10'], virtualPort: 8443, pool: 'pool_app6' },
        pool_app6: { class: 'Pool', monitors: ['tcp'], members: [{ servicePort: 8443, serverAddresses: ['2001:db8:1:2::10'] }] },
      },
    },
  },
});

const VIPS_CSV = `vip,port,protocol,members,monitor,persistence,tls
203.0.113.10,443,https,10.1.1.10:80 10.1.1.11:80,http:/health,cookie,terminate
2001:db8:100::10,8443,tcp,[2001:db8:1:2::10]:8443,tcp,source-ip,none
`;

function ctx(shop: Platform = 'aws', hr: Platform = 'azure'): NetsecContext {
  const s = (id: string, app: string, component: string, platform: Platform, ...addresses: string[]) => ({ id, name: id, app, component, platform, addresses });
  return {
    servers: [
      s('shop-web-1', 'shop', 'web', shop, '10.1.1.10', '2001:db8:1:1::10'),
      s('shop-web-2', 'shop', 'web', shop, '10.1.1.11', '2001:db8:1:1::11'),
      s('shop-app-1', 'shop', 'app', shop, '10.1.2.10', '2001:db8:1:2::10'),
      s('shop-db-1', 'shop', 'db', shop, '10.1.3.10'),
      s('crm-app-1', 'crm', 'app', shop, '10.1.4.10'),
      s('hr-app-1', 'hr', 'app', hr, '10.1.5.10'),
    ],
    sites: [{ name: 'office', cidrs: ['10.50.0.0/16', '2001:db8:50::/48'] }],
    external: [{ id: 'bank-sftp', kind: 'partner-allowlist', party: 'Bank', direction: 'out', protocol: 'sftp', endpoint: 'sftp.bank.example', currentIps: ['203.0.113.20'], noticeDays: 30 }],
  };
}

/** A block against the provider schema: every attribute and nested block exists, required ones are set. */
function schemaProblems(block: HclBlock): string[] {
  const type = block.labels?.[0] as string;
  const schema = resourceSchema(type) as { a: [string, string, string][]; b?: [string, unknown, number, number, unknown][] } | undefined;
  if (!schema) return [`${type}: no schema`];
  const out: string[] = [];
  const META = new Set(['for_each', 'count', 'depends_on', 'provider', 'lifecycle']);
  const walk = (b: HclBlock, s: { a: [string, string, string][]; b?: [string, unknown, number, number, unknown][] }, path: string): void => {
    const attrs = new Set(s.a.map((a) => a[0]));
    const blocks = new Map((s.b ?? []).map((x) => [x[0], x]));
    for (const a of b.attributes ?? []) if (!attrs.has(a.name) && !META.has(a.name)) out.push(`${path}.${a.name}: not in the schema`);
    for (const a of s.a) if (a[2].startsWith('r') && !(b.attributes ?? []).some((x) => x.name === a[0])) out.push(`${path}.${a[0]}: required and missing`);
    for (const c of b.blocks ?? []) {
      const def = blocks.get(c.type);
      if (!def) {
        out.push(`${path}.${c.type}: block not in the schema`);
        continue;
      }
      walk(c, def[4] as never, `${path}.${c.type}`);
    }
  };
  walk(block, schema, type);
  return out;
}

const target = (type: string): CloudTarget => (type.startsWith('azurerm_') ? 'azure' : (type.split('_')[0] as CloudTarget));

/* --------------------------------------------------------------------- tests --- */

describe('netsec model', () => {
  it('reads services, ranges and CIDRs of both families', () => {
    expect(parseService('tcp/443')).toEqual({ protocol: 'tcp', from: 443, to: 443 });
    expect(parseService('udp/8000-8080')).toEqual({ protocol: 'udp', from: 8000, to: 8080 });
    expect(parseService('https')).toEqual({ protocol: 'tcp', from: 443, to: 443 });
    expect(parseService('icmp')).toEqual({ protocol: 'icmp' });
    expect(rangeToCidrs('10.0.0.0', '10.0.0.255')).toEqual(['10.0.0.0/24']);
    expect(rangeToCidrs('10.0.0.1', '10.0.0.2')).toEqual(['10.0.0.1/32', '10.0.0.2/32']);
    expect(canonicalCidr('2001:db8::1')).toBe('2001:db8::1/128');
    expect(canonicalCidr('10.1.1.5/24')).toBe('10.1.1.0/24');
  });
});

describe('parsers: the same rules from every vendor', () => {
  const asa = parseAsa(ASA, 'edge-asa');
  const panos = parsePanos(PANOS, 'pa-01');
  const forti = parseFortios(FORTIOS, 'fgt-01');
  const csv = parseRulesCsv(RULES_CSV);

  it('ASA, PAN-OS, FortiOS and the CSV parse into the same rule set', () => {
    const expected = ruleSet(csv.rules);
    expect(expected).toHaveLength(8);
    expect(ruleSet(asa.rules)).toEqual(expected);
    expect(ruleSet(panos.rules)).toEqual(expected);
    expect(ruleSet(forti.rules)).toEqual(expected);
  });

  it('keeps IPv6 addresses in the rules', () => {
    const webApp = asa.rules[0];
    expect(webApp?.from).toContain('2001:db8:1:1::/64');
    expect(webApp?.to).toContain('2001:db8:1:2::10/128');
  });

  it('records where each rule came from', () => {
    expect(asa.rules[0]?.source).toEqual({ device: 'edge-asa', line: 21 });
    expect(asa.rules[0]?.fromZone).toBe('inside');
    expect(forti.rules.find((r) => r.name === 'web-app')?.source.line).toBeGreaterThan(0);
  });

  it('keeps a disabled rule, marked, and reads FortiOS policies without an action as deny', () => {
    expect(panos.rules.find((r) => r.name === 'old-rule')?.disabled).toBe(true);
    expect(forti.rules.find((r) => r.name === 'deny-db')?.action).toBe('deny');
  });

  it('reads NAT from ASA, PAN-OS and FortiOS', () => {
    expect(asa.nats.find((n) => n.kind === 'static')?.mapped).toEqual(['203.0.113.20/32']);
    expect(asa.nats.find((n) => n.kind === 'source')?.mapped).toEqual(['interface']);
    expect(panos.nats[0]?.kind).toBe('source');
    expect(forti.nats.find((n) => n.name === 'web-in-snat')?.kind).toBe('source');
  });

  it('leaves an App-ID it cannot resolve for review', () => {
    const p = parsePanos('set rulebase security rules odd source any destination 10.1.2.10 application some-app service application-default action allow');
    expect(p.rules[0]?.unresolved).toEqual(['app:some-app']);
  });

  it('dispatches by the Network page platform id', () => {
    expect(parseDeviceConfig('cisco_asa', ASA)?.rules.length).toBe(8);
    expect(parseDeviceConfig('juniper_junos', '')).toBeNull();
  });
});

describe('parsers: F5 and vips.csv give the same VIPs', () => {
  it('bigip.conf, AS3 and vips.csv agree, IPv6 included', () => {
    const keys = (c: ParsedConfig): string[] => c.vips.map(vipKey).sort();
    const csv = keys(parseVipsCsv(VIPS_CSV));
    expect(csv).toHaveLength(2);
    expect(keys(parseBigipConf(BIGIP))).toEqual(csv);
    expect(keys(parseAs3(AS3))).toEqual(csv);
  });
  it('reads F5 destinations of both families', () => {
    expect(f5Destination('/Common/10.0.0.10:443')).toEqual({ address: '10.0.0.10', port: 443 });
    expect(f5Destination('/Common/2001:db8::10.443')).toEqual({ address: '2001:db8::10', port: 443 });
    expect(f5Destination('/Common/10.0.0.10%2:80')).toEqual({ address: '10.0.0.10', port: 80 });
  });
  it('keeps the monitor path', () => {
    expect(parseBigipConf(BIGIP).vips[0]?.monitorPath).toBe('/health');
  });
});

describe('translation', () => {
  const t = translateConfigs([parseAsa(ASA, 'edge-asa'), parseBigipConf(BIGIP, 'bigip')], ctx());
  const find = (pred: (r: TranslatedRule) => boolean): TranslatedRule | undefined => t.rules.find(pred);

  it('classifies endpoints as tier, site, internet or unknown', () => {
    const c = ctx();
    expect(classifyEndpoint('10.1.2.10/32', c)[0]?.kind).toBe('tier');
    expect(classifyEndpoint('2001:db8:1:2::10/128', c)[0]?.component).toBe('app');
    expect(classifyEndpoint('10.50.1.0/24', c)[0]?.kind).toBe('site');
    expect(classifyEndpoint('198.51.100.7/32', c)[0]?.kind).toBe('internet');
    expect(classifyEndpoint('172.20.0.0/16', c)[0]?.kind).toBe('unknown');
  });

  it('app-internal rules become security-group rules', () => {
    const webApp = find((r) => r.from.component === 'web' && r.to.component === 'app');
    expect(webApp?.scope).toBe('app-internal');
    expect(webApp?.platform).toBe('aws');
    expect(find((r) => r.from.component === 'app' && r.to.component === 'db' && r.from.app === 'shop')?.scope).toBe('app-internal');
    expect(find((r) => r.from.app === 'crm')?.scope).toBe('app-to-app');
  });

  it('site rules become the cloud firewall (and the tier group), cross-platform too', () => {
    const office = find((r) => r.from.kind === 'site');
    expect(office?.scope).toBe('cloud-firewall');
    expect(office?.alsoSecurityGroup).toBe(true);
    const hr = find((r) => r.from.app === 'hr');
    expect(hr?.scope).toBe('cloud-firewall');
    expect(hr?.platform).toBe('aws');
  });

  it('any-any is not translated: a finding', () => {
    const ssh = find((r) => r.services.some((s) => s.from === 22));
    expect(ssh?.scope).toBe('review');
    expect(t.findings.some((f) => f.code === 'netsec.review')).toBe(true);
  });

  it('keeps deny rules as information and sends internet traffic to the app ingress', () => {
    expect(find((r) => r.action === 'deny')?.scope).toBe('deny');
    expect(find((r) => r.from.kind === 'any' && r.to.component === 'web')?.scope).toBe('internet-ingress');
  });

  it('VIPs become ingress items', () => {
    const shop = t.ingress.find((i) => i.name === 'vs_shop');
    expect(shop?.app).toBe('shop');
    expect(shop?.platform).toBe('aws');
    expect(shop?.blueprint).toBe('aws_app_ingress');
    expect(shop?.ingress).toEqual({ fqdns: [], exposure: 'public', lb: 'l7', tls: 'terminate', waf: true });
    expect(shop?.healthCheck).toEqual({ kind: 'http', path: '/health', port: 80 });
    expect(shop?.types).toContain('aws_lb');
    const app6 = t.ingress.find((i) => i.name === 'vs_app6');
    expect(app6?.members[0]?.server).toBe('shop-app-1');
    expect(app6?.ingress.lb).toBe('l4');
  });

  it('NAT becomes public IPs and cloud NAT, and the egress list names partners to notify', () => {
    expect(t.nat.find((n) => n.nat.kind === 'static')?.becomes).toBe('public-ip');
    expect(t.nat.find((n) => n.nat.kind === 'static')?.types).toContain('aws_eip');
    expect(t.nat.find((n) => n.nat.kind === 'source')?.types).toContain('aws_nat_gateway');
    expect(t.egress.find((e) => e.current === '203.0.113.20/32')?.notices).toEqual(['bank-sftp']);
  });

  it('merges config and flows: both, unused and undocumented', () => {
    const config = parseRulesCsv(RULES_CSV).rules;
    const flows = rulesFromFlows([
      { sourceIp: '10.1.1.10', destIp: '10.1.2.10', destPort: 8443, protocol: 'tcp', lastSeen: '2026-09-20' },
      { sourceIp: '10.1.2.10', destIp: '10.1.3.10', destPort: 5432, protocol: 'tcp', lastSeen: '2026-09-20' },
      { sourceIp: '10.1.5.10', destIp: '10.1.3.10', destPort: 1433, protocol: 'tcp', lastSeen: '2026-01-01' },
    ]);
    const merged = mergeSources(config, flows, { today: '2026-09-26' });
    const origin = (name: string): string | undefined => merged.rules.find((r) => r.rule.name === name)?.origin;
    expect(origin('web-app')).toBe('both');
    expect(origin('app-db')).toBe('config');
    expect(origin('hr-db')).toBe('config');
    expect(merged.rules.some((r) => r.origin === 'flows')).toBe(true);
    expect(merged.findings.filter((f) => f.code === 'netsec.undocumented')).toHaveLength(1);
    expect(merged.findings.some((f) => f.code === 'netsec.unused' && f.message.includes('app-db'))).toBe(true);
    const translated = translate({ rules: merged.rules }, ctx());
    const webApp = translated.rules.find((r) => r.from.component === 'web' && r.to.component === 'app');
    expect(webApp?.origin).toBe('both');
    expect(translated.rules.find((r) => r.origin === 'flows')?.services[0]).toEqual({ protocol: 'tcp', from: 5432, to: 5432 });
  });

  it('builds its context from a plan', () => {
    const plan = {
      workloads: [{ id: 'w1', name: 'shop-app-1', app: 'shop', role: 'app', pin: 'oci', facts: { ipAddresses: ['10.1.2.10', '2001:db8:1:2::10'] } }],
      requirements: { sites: [{ name: 'hq', cidrs: ['10.50.0.0/16'] }] },
      dcExit: { infra: [{ id: 's1', category: 'subnet', name: '10.1.2.0/24', site: 'dc1', facts: {} }], external: [] },
    } as unknown as Plan;
    const c = netsecContext(plan);
    expect(c.servers[0]?.platform).toBe('oci');
    expect(c.sites.map((s) => s.name)).toEqual(['hq', 'dc1']);
  });
});

describe('emitted Terraform', () => {
  for (const shop of ['aws', 'azure', 'google', 'oci', 'vmware'] as const) {
    it(`${shop}: every type is in the catalogue and every block matches the provider schema`, () => {
      const hr: Platform = shop === 'aws' ? 'azure' : 'aws';
      const t = translateConfigs([parseAsa(ASA, 'edge-asa'), parseFortios(FORTIOS, 'fgt')], ctx(shop, hr));
      const out = emitTerraform(t, { prefix: 'shop' });
      const own = out.platforms.find((p) => p.platform === shop);
      expect(own).toBeDefined();
      for (const p of out.platforms) {
        for (const type of p.types) expect(`${type}: ${classifyType(target(type.startsWith('nsxt_') ? 'nsxt' : type), type)}`).toBe(`${type}: resource`);
        const problems = p.blocks.filter((b) => b.type === 'resource').flatMap(schemaProblems);
        expect(problems).toEqual([]);
      }
      expect(own?.text).not.toContain('Generated by');
    });
  }

  it('writes both families: AWS rules carry cidr_ipv6 and icmpv6 where the source is IPv6', () => {
    const t = translateConfigs([parseRulesCsv(`${RULES_CSV}v6-office,2001:db8:50::/48,10.1.2.10 2001:db8:1:2::10,icmp,allow\n`)], ctx());
    const aws = emitTerraform(t).files['netsec/aws.tf'] as string;
    expect(aws).toContain('cidr_ipv6');
    expect(aws).toContain('"icmpv6"');
    expect(aws).toContain('referenced_security_group_id');
    expect(aws).toContain('aws_networkfirewall_rule_group');
  });

  it('writes NSX DFW groups by tag with IPv4 and IPv6 rules for VMware targets', () => {
    const t = translateConfigs([parseAsa(ASA)], ctx('vmware', 'aws'));
    const text = emitTerraform(t).files['netsec/vmware.tf'] as string;
    expect(text).toContain('resource "nsxt_policy_group" "shop_web"');
    expect(text).toContain('value       = "shop|web"');
    expect(text).toContain('ip_version');
    expect(text).toContain('"IPV4_IPV6"');
    expect(text).toContain('resource "nsxt_policy_security_policy" "shop"');
  });

  it('lists the review rules and the generated rules with their origin', () => {
    const out = emitTerraform(translateConfigs([parseAsa(ASA)], ctx()));
    expect(out.files['netsec/review.csv']).toContain('any to any is not translated');
    expect(out.files['netsec/rules.csv']).toContain('app-internal');
    expect(out.files['netsec/rules.csv']?.split('\n')[0]).toBe('id,scope,platform,from,to,services,action,origin,sources,why');
  });
});

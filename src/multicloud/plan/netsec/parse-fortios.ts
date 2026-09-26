/**
 * FortiOS into the netsec model.
 *
 * The configuration is split into its `config … end` sections by the Network
 * page's `fortiSections` (network/full-config.ts); each section's `edit … next`
 * entries, and the tables nested inside them (`config realservers`), are read
 * here. A multi-VDOM configuration (`config vdom` / `edit root`) is read
 * through the same entry reader.
 *
 * Covered: `firewall address` / `address6` (ipmask, iprange, fqdn),
 * `addrgrp` / `addrgrp6`, `service custom` / `service group`, `policy`
 * (IPv4 and IPv6 addresses in one policy, as FortiOS 6.4+ writes them, and the
 * older `policy6`), `vip` / `vip6` (static NAT, port forwarding, and
 * `server-load-balance` virtual servers), and `ldb-monitor`.
 */

import { fortiSections } from '../../../network/full-config.ts';
import { info, warning, type Finding } from '../../../core/findings.ts';
import {
  canonicalCidr,
  finishRule,
  fromMask,
  parseService,
  rangeToCidrs,
  tokens,
  type FwRule,
  type FwService,
  type LbVip,
  type MonitorKind,
  type NatRule,
  type ParsedConfig,
  type Persistence,
  type VipProtocol,
} from './model.ts';

export interface FortiEdit {
  readonly name: string;
  readonly sets: ReadonlyMap<string, readonly string[]>;
  readonly tables: ReadonlyMap<string, readonly FortiEdit[]>;
}

/** Read `edit … next` entries (with nested `config … end` tables) from a section's lines. */
export function fortiEdits(lines: readonly string[]): FortiEdit[] {
  let i = 0;
  const readEntries = (): FortiEdit[] => {
    const out: FortiEdit[] = [];
    while (i < lines.length) {
      const t = tokens((lines[i] as string).trim());
      if (t[0] === 'end') {
        i += 1;
        return out;
      }
      if (t[0] === 'edit') {
        i += 1;
        const sets = new Map<string, string[]>();
        const tables = new Map<string, FortiEdit[]>();
        while (i < lines.length) {
          const u = tokens((lines[i] as string).trim());
          if (u[0] === 'next') {
            i += 1;
            break;
          }
          if (u[0] === 'set' && u[1]) {
            sets.set(u[1], u.slice(2));
            i += 1;
          } else if (u[0] === 'config' && u.length > 1) {
            i += 1;
            tables.set(u.slice(1).join(' '), readEntries());
          } else i += 1;
        }
        out.push({ name: t.slice(1).join(' '), sets, tables });
        continue;
      }
      i += 1;
    }
    return out;
  };
  return readEntries();
}

/** Predefined FortiOS services, as a factory default configuration has them. */
const PREDEFINED: Readonly<Record<string, readonly string[]>> = {
  ALL: ['any'],
  ALL_TCP: ['tcp'],
  ALL_UDP: ['udp'],
  ALL_ICMP: ['icmp'],
  ALL_ICMP6: ['icmp'],
  PING: ['icmp'],
  PING6: ['icmp'],
  HTTP: ['tcp/80'],
  HTTPS: ['tcp/443'],
  SSH: ['tcp/22'],
  TELNET: ['tcp/23'],
  FTP: ['tcp/21'],
  SMTP: ['tcp/25'],
  DNS: ['tcp/53', 'udp/53'],
  NTP: ['tcp/123', 'udp/123'],
  LDAP: ['tcp/389'],
  RDP: ['tcp/3389'],
  'MS-SQL': ['tcp/1433', 'tcp/1434'],
  MYSQL: ['tcp/3306'],
  SNMP: ['udp/161-162'],
  SMB: ['tcp/445'],
  SAMBA: ['tcp/139'],
  KERBEROS: ['tcp/88', 'udp/88'],
};

const one = (sets: ReadonlyMap<string, readonly string[]>, key: string): string | undefined => sets.get(key)?.[0];

/** Line numbers of each `edit` under each top-level `config` path. */
function editLines(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const stack: string[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const t = tokens(raw.trim());
    if (t[0] === 'config') stack.push(t.slice(1).join(' '));
    else if (t[0] === 'end') stack.pop();
    else if (t[0] === 'edit') {
      const key = `${stack[stack.length - 1] ?? ''}|${t.slice(1).join(' ')}`;
      if (!out.has(key)) out.set(key, idx + 1);
    }
  });
  return out;
}

export function parseFortios(text: string, device = 'fortios'): ParsedConfig {
  const findings: Finding[] = [];
  const lineOf = editLines(text);

  // Sections, with a VDOM's own sections lifted out of `config vdom`.
  const sections = new Map<string, FortiEdit[]>();
  const add = (path: string, edits: readonly FortiEdit[]): void => {
    sections.set(path, [...(sections.get(path) ?? []), ...edits]);
  };
  for (const section of fortiSections(text.split(/\r?\n/))) {
    if (section.path === 'vdom' || section.path === 'global') {
      for (const vdom of fortiEdits([...section.entries, 'end'])) for (const [path, edits] of vdom.tables) add(path, edits);
      continue;
    }
    add(section.path, fortiEdits([...section.entries, 'end']));
  }
  const edits = (path: string): readonly FortiEdit[] => sections.get(path) ?? [];

  const addresses = new Map<string, string[]>();
  addresses.set('all', ['0.0.0.0/0']);
  addresses.set('all6', ['::/0']);
  for (const e of edits('firewall address')) {
    const type = one(e.sets, 'type') ?? 'ipmask';
    if (e.name === 'all') continue;
    if (type === 'ipmask') {
      const s = e.sets.get('subnet') ?? [];
      const c = s[1] ? fromMask(s[0] as string, s[1]) : canonicalCidr(s[0] ?? '');
      addresses.set(e.name, [c ?? `?${e.name}`]);
    } else if (type === 'iprange') {
      addresses.set(e.name, rangeToCidrs(one(e.sets, 'start-ip') ?? '', one(e.sets, 'end-ip') ?? '') ?? [`?${e.name}`]);
    } else if (type === 'fqdn') addresses.set(e.name, [`fqdn:${one(e.sets, 'fqdn') ?? e.name}`]);
    else addresses.set(e.name, [`?${e.name}`]);
  }
  for (const e of edits('firewall address6')) {
    if (e.name === 'all') {
      addresses.set('all6', ['::/0']);
      continue;
    }
    const ip6 = one(e.sets, 'ip6');
    const fqdn = one(e.sets, 'fqdn');
    addresses.set(`${e.name}`, [ip6 ? canonicalCidr(ip6) ?? `?${e.name}` : fqdn ? `fqdn:${fqdn}` : `?${e.name}`]);
  }
  const groups = [...edits('firewall addrgrp'), ...edits('firewall addrgrp6')];
  for (let pass = 0; pass < 3; pass += 1) {
    for (const g of groups) addresses.set(g.name, (g.sets.get('member') ?? []).flatMap((m) => addresses.get(m) ?? [`?${m}`]));
  }

  // VIPs: a policy to a VIP is a rule to the servers behind it.
  const nats: NatRule[] = [];
  const vips: LbVip[] = [];
  const monitors = new Map<string, { kind: MonitorKind; path?: string }>();
  for (const m of edits('firewall ldb-monitor')) {
    const type = one(m.sets, 'type') ?? 'tcp';
    const path = one(m.sets, 'http-get');
    monitors.set(m.name, { kind: type === 'ping' ? 'icmp' : type === 'http' ? 'http' : type === 'https' ? 'https' : type === 'udp' ? 'udp' : 'tcp', ...(path ? { path } : {}) });
  }
  for (const path of ['firewall vip', 'firewall vip6']) {
    for (const v of edits(path)) {
      const line = lineOf.get(`${path}|${v.name}`) ?? 0;
      const extip = (one(v.sets, 'extip') ?? '').split('-')[0] as string;
      const extport = Number((one(v.sets, 'extport') ?? '').split('-')[0]) || undefined;
      if (one(v.sets, 'type') === 'server-load-balance') {
        const real = v.tables.get('realservers') ?? [];
        const pool = real.map((r) => ({ address: one(r.sets, 'ip') ?? '', port: Number(one(r.sets, 'port') ?? extport ?? 0) })).filter((m) => m.address);
        addresses.set(v.name, pool.map((m) => canonicalCidr(m.address) ?? `?${m.address}`));
        const serverType = one(v.sets, 'server-type') ?? 'tcp';
        const protocol: VipProtocol = serverType === 'http' ? 'http' : serverType === 'https' || serverType === 'ssl' ? 'https' : serverType === 'udp' ? 'udp' : 'tcp';
        const persist = one(v.sets, 'persistence');
        const persistence: Persistence = persist === 'http-cookie' ? 'cookie' : persist === 'ssl-session-id' ? 'source-ip' : 'none';
        const monitorName = v.sets.get('monitor')?.[0];
        const monitor = monitorName ? monitors.get(monitorName) : undefined;
        vips.push({
          name: v.name,
          vip: extip,
          port: extport ?? 0,
          protocol,
          pool,
          monitor: monitor?.kind ?? 'none',
          ...(monitor?.path ? { monitorPath: monitor.path } : {}),
          persistence,
          tls: protocol === 'https' ? 'terminate' : 'none',
          source: { device, line },
        });
        continue;
      }
      const mappedRaw = (v.sets.get('mappedip') ?? [])[0] ?? '';
      const [first = '', last] = mappedRaw.split('-');
      const real = last ? rangeToCidrs(first, last) ?? [`?${mappedRaw}`] : [canonicalCidr(first) ?? `?${mappedRaw}`];
      addresses.set(v.name, real);
      const portForward = one(v.sets, 'portforward') === 'enable';
      const proto = one(v.sets, 'protocol') === 'udp' ? 'udp' : 'tcp';
      const mappedPort = Number(one(v.sets, 'mappedport') ?? extport);
      nats.push({
        name: v.name,
        kind: portForward ? 'destination' : 'static',
        real,
        mapped: [canonicalCidr(extip) ?? `?${extip}`],
        ...(portForward && mappedPort ? { service: { protocol: proto, from: mappedPort, to: mappedPort } } : {}),
        ...(portForward && extport ? { mappedPort: extport } : {}),
        source: { device, line },
      });
    }
  }

  const services = new Map<string, FwService[]>();
  for (const s of edits('firewall service custom')) {
    const out: FwService[] = [];
    const proto = (one(s.sets, 'protocol') ?? 'TCP/UDP/SCTP').toUpperCase();
    if (proto === 'ICMP' || proto === 'ICMP6') out.push({ protocol: 'icmp' });
    else if (proto === 'IP') out.push({ protocol: 'any' });
    else {
      for (const [key, protocol] of [['tcp-portrange', 'tcp'], ['udp-portrange', 'udp']] as const) {
        for (const r of s.sets.get(key) ?? []) {
          const dst = r.split(':')[0] as string;
          const parsed = parseService(`${protocol}/${dst}`);
          if (parsed) out.push(parsed);
        }
      }
    }
    services.set(s.name, out);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const g of edits('firewall service group')) services.set(g.name, (g.sets.get('member') ?? []).flatMap((m) => lookupService(m, services)));
  }

  const rules: FwRule[] = [];
  for (const path of ['firewall policy', 'firewall policy6']) {
    for (const p of edits(path)) {
      const line = lineOf.get(`${path}|${p.name}`) ?? 0;
      // `all` is 0.0.0.0/0 in srcaddr and ::/0 in srcaddr6.
      const addr = (key: string): string[] =>
        (p.sets.get(key) ?? []).flatMap((m) => (m === 'all' && (key.endsWith('6') || path === 'firewall policy6') ? ['::/0'] : addresses.get(m) ?? [`?${m}`]));
      const from = [...addr('srcaddr'), ...addr('srcaddr6')];
      const to = [...addr('dstaddr'), ...addr('dstaddr6')];
      const unresolved: string[] = [];
      const svc: FwService[] = [];
      for (const name of p.sets.get('service') ?? []) {
        const found = lookupService(name, services);
        if (found.length) svc.push(...found);
        else unresolved.push(`service:${name}`);
      }
      if (one(p.sets, 'srcaddr-negate') === 'enable') unresolved.push('negated source');
      if (one(p.sets, 'dstaddr-negate') === 'enable') unresolved.push('negated destination');
      const name = one(p.sets, 'name') ?? `policy-${p.name}`;
      rules.push({
        name,
        from,
        to,
        services: svc,
        // FortiOS's default action is deny: a policy without `set action accept` blocks.
        action: one(p.sets, 'action') === 'accept' ? 'allow' : 'deny',
        log: (one(p.sets, 'logtraffic') ?? 'utm') !== 'disable',
        disabled: one(p.sets, 'status') === 'disable',
        fromZone: p.sets.get('srcintf')?.join(' '),
        toZone: p.sets.get('dstintf')?.join(' '),
        source: { device, line },
        ...(unresolved.length ? { unresolved } : {}),
      });
      for (const u of unresolved) findings.push(info('netsec.fortios.unresolved', `Policy ${name}: ${u} is not resolved, so the rule is listed for review.`, { path: `${device}:${line}` }));
      if (one(p.sets, 'nat') === 'enable') {
        const pools = p.sets.get('poolname') ?? [];
        nats.push({ name: `${name}-snat`, kind: 'source', real: from, mapped: pools.length ? pools.map((x) => `?pool:${x}`) : ['interface'], source: { device, line } });
      }
    }
  }
  if (rules.length === 0) findings.push(warning('netsec.fortios.no-policy', `No firewall policy was found in ${device}.`));

  return { device, platform: 'fortios', rules: rules.map(finishRule), nats, vips, findings };
}

function lookupService(name: string, services: ReadonlyMap<string, FwService[]>): FwService[] {
  const own = services.get(name);
  if (own) return own;
  return (PREDEFINED[name] ?? []).map((s) => parseService(s)).filter((s): s is FwService => s !== null);
}

/**
 * The one model every firewall and load-balancer configuration is read into
 * (addendum A.5.5.1).
 *
 * An ASA access list, a PAN-OS security rule, a FortiOS policy and a CSV row
 * say the same thing in four syntaxes: these sources may reach these
 * destinations on these services. The parsers turn each into an `FwRule`, with
 * every object and group resolved to addresses, so the translation to cloud
 * security groups, NSGs, firewall policies and the NSX distributed firewall is
 * written once.
 *
 * Addresses are kept as canonical CIDR text of either family (`10.1.2.0/24`,
 * `2001:db8:1::/64`, a host as /32 or /128). Three other forms exist, each for
 * a reason the translation needs to see:
 *   - `any` means every address of both families (an ASA `any`, a PAN-OS `any`);
 *   - `fqdn:<name>` is an FQDN object, which a security group cannot hold;
 *   - `?<name>` is a name the parser could not resolve, which is never guessed.
 */

import { familyOf, parseCidrAny, type Family } from '../../../core/ip.ts';
import { parseIPv4, formatIPv4, maskToPrefix } from '../../../core/net.ts';
import type { Finding } from '../../../core/findings.ts';

/** The configuration a rule was read from: the Network page's platform ids, or the CSV import. */
export type NetsecSource = 'cisco_asa' | 'panos' | 'fortios' | 'f5' | 'csv' | 'flows';

export type FwAction = 'allow' | 'deny';
export type FwProtocol = 'tcp' | 'udp' | 'icmp' | 'any';

/** One service: a protocol and, for TCP and UDP, a destination port range (absent = every port). */
export interface FwService {
  readonly protocol: FwProtocol;
  readonly from?: number;
  readonly to?: number;
}

/** Where a rule came from: the device (or file) and the line it starts on (1-based). */
export interface RuleOrigin {
  readonly device: string;
  readonly line: number;
}

export interface FwRule {
  readonly name: string;
  /** Canonical CIDRs, `any`, `fqdn:<name>` or `?<unresolved>`. */
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly services: readonly FwService[];
  readonly action: FwAction;
  readonly log: boolean;
  readonly source: RuleOrigin;
  /** Disabled in the configuration: kept for the record, never translated. */
  readonly disabled?: boolean;
  /**
   * What the parser could not turn into addresses or ports (a negated source,
   * an App-ID with no default port it knows): the rule is listed for review,
   * not translated.
   */
  readonly unresolved?: readonly string[];
  /** Zones or interfaces, as the device names them (information only). */
  readonly fromZone?: string;
  readonly toZone?: string;
  /** Flows only: when the flow was last seen (ISO date), and how often. */
  readonly lastSeen?: string;
  readonly observations?: number;
}

/**
 * A NAT rule. `source` hides inside addresses behind others (the egress
 * addresses partners allow-list); `static` and `destination` publish an inside
 * address on an outside one.
 */
export type NatKind = 'source' | 'static' | 'destination';
export interface NatRule {
  readonly name: string;
  readonly kind: NatKind;
  /** The inside (real) addresses. */
  readonly real: readonly string[];
  /** The outside (mapped) addresses; `interface` when it is the egress interface's address. */
  readonly mapped: readonly string[];
  readonly service?: FwService;
  /** The mapped (outside) port, when it differs. */
  readonly mappedPort?: number;
  readonly source: RuleOrigin;
}

export type VipProtocol = 'tcp' | 'udp' | 'http' | 'https';
export type Persistence = 'none' | 'source-ip' | 'cookie';
export type VipTls = 'none' | 'terminate' | 'passthrough';
export type MonitorKind = 'tcp' | 'http' | 'https' | 'icmp' | 'udp' | 'none';
export interface PoolMember {
  readonly address: string;
  readonly port: number;
}
export interface LbVip {
  readonly name: string;
  /** The virtual address (bare, either family). */
  readonly vip: string;
  readonly port: number;
  readonly protocol: VipProtocol;
  readonly pool: readonly PoolMember[];
  readonly monitor: MonitorKind;
  /** The monitor's HTTP path, where one is set. */
  readonly monitorPath?: string;
  readonly persistence: Persistence;
  readonly tls: VipTls;
  readonly source: RuleOrigin;
}

/** Everything read from one configuration file. */
export interface ParsedConfig {
  readonly device: string;
  readonly platform: NetsecSource;
  readonly rules: readonly FwRule[];
  readonly nats: readonly NatRule[];
  readonly vips: readonly LbVip[];
  readonly findings: readonly Finding[];
}

export const ANY = 'any';

/* --------------------------------------------------------------- addresses --- */

/** A host or network as canonical CIDR text, or null. `10.1.1.5` → `10.1.1.5/32`. */
export function canonicalCidr(text: string): string | null {
  const c = parseCidrAny(text);
  if (!c) return null;
  return `${c.prefix === (c.family === 4 ? 32 : 128) ? c.address : c.network}/${c.prefix}`;
}

/** `10.1.1.0 255.255.255.0` → `10.1.1.0/24`. */
export function fromMask(address: string, mask: string): string | null {
  const m = parseIPv4(mask);
  if (m === null) return null;
  const prefix = maskToPrefix(m);
  if (prefix === null) return null;
  return canonicalCidr(`${address}/${prefix}`);
}

/** The smallest set of IPv4 CIDRs covering a range; null for IPv6 or a malformed range. */
export function rangeToCidrs(first: string, last: string): string[] | null {
  const a = parseIPv4(first.trim());
  const b = parseIPv4(last.trim());
  if (a === null || b === null || b < a) return null;
  const out: string[] = [];
  let cur = a;
  while (cur <= b) {
    let size = 32;
    while (size > 0) {
      const block = 2 ** (32 - (size - 1));
      if (cur % block !== 0 || cur + block - 1 > b) break;
      size -= 1;
    }
    out.push(`${formatIPv4(cur)}/${size}`);
    cur += 2 ** (32 - size);
    if (out.length > 256) return null;
  }
  return out;
}

export function familyOfEndpoint(endpoint: string): Family | null {
  if (endpoint === ANY || endpoint.startsWith('fqdn:') || endpoint.startsWith('?')) return null;
  return familyOf(endpoint);
}

/** `0.0.0.0/0`, `::/0` and `any` all mean everywhere. */
export function isAnyEndpoint(endpoint: string): boolean {
  return endpoint === ANY || endpoint === '0.0.0.0/0' || endpoint === '::/0';
}

/**
 * Endpoints as a sorted, unique list, with "everything in both families"
 * written one way: `0.0.0.0/0` plus `::/0` (FortiOS `all` in both address
 * tables) is the same as an ASA or PAN-OS `any`.
 */
export function normaliseEndpoints(list: readonly string[]): string[] {
  const set = new Set(list);
  if (set.has(ANY) || (set.has('0.0.0.0/0') && set.has('::/0'))) return [ANY];
  return [...set].sort();
}

/** Every parser's last step: endpoints normalised, duplicate services dropped. */
export function finishRule(rule: FwRule): FwRule {
  const seen = new Set<string>();
  const services = rule.services.filter((s) => {
    const k = serviceText(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const anyService = services.some((s) => s.protocol === 'any');
  return { ...rule, from: normaliseEndpoints(rule.from), to: normaliseEndpoints(rule.to), services: anyService ? [{ protocol: 'any' }] : services };
}

/* ---------------------------------------------------------------- services --- */

/** Well-known port names as ASA, PAN-OS and FortiOS configurations spell them. */
export const PORT_NAMES: Readonly<Record<string, number>> = {
  ftp: 21,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  dns: 53,
  www: 80,
  http: 80,
  kerberos: 88,
  pop3: 110,
  ntp: 123,
  'netbios-ssn': 139,
  imap4: 143,
  snmp: 161,
  ldap: 389,
  https: 443,
  smb: 445,
  syslog: 514,
  ldaps: 636,
  sqlnet: 1521,
  'ms-sql': 1433,
  mysql: 3306,
  rdp: 3389,
  postgres: 5432,
};

export function portOf(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n <= 65535 ? n : null;
  }
  return PORT_NAMES[t] ?? null;
}

/** `tcp/443`, `udp/53`, `tcp/8000-8080`, `icmp`, `any`. */
export function serviceText(s: FwService): string {
  if (s.protocol === 'any' || s.protocol === 'icmp') return s.protocol;
  if (s.from === undefined) return `${s.protocol}/any`;
  return s.to !== undefined && s.to !== s.from ? `${s.protocol}/${s.from}-${s.to}` : `${s.protocol}/${s.from}`;
}

/** Read `tcp/443`, `tcp:443`, `udp/53`, `tcp/8000-8080`, `icmp`, `any`, `https`. */
export function parseService(text: string): FwService | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  if (t === 'any' || t === 'ip' || t === 'all') return { protocol: 'any' };
  if (t === 'icmp' || t === 'icmp6' || t === 'icmpv6' || t === 'ping') return { protocol: 'icmp' };
  const m = /^(tcp|udp)(?:[/:](.+))?$/.exec(t);
  if (m) {
    const protocol = m[1] as 'tcp' | 'udp';
    if (!m[2] || m[2] === 'any') return { protocol };
    const range = /^(\d+)-(\d+)$/.exec(m[2]);
    if (range) return port(protocol, Number(range[1]), Number(range[2]));
    const p = portOf(m[2]);
    return p === null ? null : { protocol, from: p, to: p };
  }
  const named = PORT_NAMES[t];
  return named !== undefined ? { protocol: 'tcp', from: named, to: named } : null;
}

export function port(protocol: 'tcp' | 'udp', from: number, to: number = from): FwService | null {
  if (!(from >= 0 && to <= 65535 && from <= to)) return null;
  return { protocol, from, to };
}

/** Does `s` allow traffic on protocol/port. */
export function serviceCovers(s: FwService, protocol: string, destPort?: number): boolean {
  if (s.protocol === 'any') return true;
  if (s.protocol !== protocol.toLowerCase()) return false;
  if (s.from === undefined || destPort === undefined) return true;
  return destPort >= s.from && destPort <= (s.to ?? s.from);
}

/* -------------------------------------------------------------- comparison --- */

const sortUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * A rule without its name and origin: what it allows. Two configurations that
 * allow the same thing produce the same keys, whatever their syntax.
 */
export function ruleKey(rule: FwRule): string {
  const services = sortUnique(rule.services.map(serviceText));
  return `${rule.action} ${sortUnique(rule.from).join(',')} > ${sortUnique(rule.to).join(',')} : ${services.join(',')}`;
}

export function vipKey(v: LbVip): string {
  const members = sortUnique(v.pool.map((m) => `${canonicalCidr(m.address) ?? m.address}:${m.port}`));
  return `${canonicalCidr(v.vip) ?? v.vip}:${v.port}/${v.protocol} -> ${members.join(',')} monitor=${v.monitor} persist=${v.persistence} tls=${v.tls}`;
}

/** The enabled rules of a set as sorted keys, for comparing two sources. */
export function ruleSet(rules: readonly FwRule[]): string[] {
  return sortUnique(rules.filter((r) => !r.disabled).map(ruleKey));
}

/* -------------------------------------------------------------- tokenising --- */

/**
 * Split a configuration line on whitespace, keeping quoted strings whole and
 * reading PAN-OS's `[ a b c ]` as one token per member inside `[` `]` markers.
 */
export function tokens(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? (m[3] as string));
  return out;
}

/** Lines of a configuration with their 1-based numbers, CRLF and trailing space removed. */
export function numberedLines(text: string): { readonly n: number; readonly text: string }[] {
  return text.split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t.replace(/\s+$/, '') }));
}

/**
 * Firewall rules, load-balancer VIPs and NAT from the old estate, translated
 * to what they become in the target (addendum A.5.5.1).
 *
 *  1. Every rule endpoint is classified by address: an app tier (the plan's
 *     servers, by `WorkloadFacts.ipAddresses`, either family), a site CIDR,
 *     the internet, or unknown.
 *  2. The rule is mapped by scope:
 *       - tier → tier in one app: security-group rules in the app stack
 *         (NSX DFW on VMware targets);
 *       - app → app on one platform: security groups that reference each other;
 *       - across platforms, or to or from a site: the landing zone's cloud
 *         firewall (and, for traffic arriving at a tier, the tier's own
 *         security group, which is default-deny);
 *       - internet → tier: the app ingress with a WAF.
 *  3. What cannot be classified (unknown endpoints, `any` to `any`, an FQDN
 *     object, an App-ID with unknown ports) is listed, not translated:
 *     finding `netsec.review`.
 *  4. Deny rules are kept as information: security groups are default-deny.
 *  5. VIPs become `<p>_app_ingress` items.
 *  6. NAT becomes cloud NAT or public IPs, and the partner-notice egress list.
 *
 * Accepted dependency-map flows (A.10.1) produce the same rule model, and the
 * two sources are merged: a rule is `config`, `flows` or `both`, a config rule
 * no flow has used in 30 days is `netsec.unused` (kept), and a flow no config
 * rule allows is `netsec.undocumented`.
 */

import { containsAny, familyOf, overlapsAny, parseCidrAny, type Family } from '../../../core/ip.ts';
import { error, info, warning, type Finding } from '../../../core/findings.ts';
import { PLATFORM_INFO } from '../../platforms.ts';
import { rowById } from '../../../terraform/equivalence.ts';
import type { AppIngress, ExternalLink, Plan, PlanDecision, Platform } from '../types.ts';
import {
  ANY,
  canonicalCidr,
  isAnyEndpoint,
  serviceCovers,
  serviceText,
  type FwRule,
  type FwService,
  type LbVip,
  type NatRule,
  type NetsecSource,
  type ParsedConfig,
} from './model.ts';
import { parseAsa } from './parse-asa.ts';
import { parsePanos } from './parse-panos.ts';
import { parseFortios } from './parse-fortios.ts';
import { parseF5 } from './parse-f5.ts';
import { parseRulesCsv, parseVipsCsv } from './parse-csv.ts';

/* ------------------------------------------------------------- dispatcher --- */

/** Parse one configuration by the Network page's platform id (or `csv` / `vips-csv`). */
export function parseDeviceConfig(platform: string, text: string, device?: string): ParsedConfig | null {
  switch (platform) {
    case 'cisco_asa':
    case 'cisco_fmc':
      return parseAsa(text, device);
    case 'panos':
      return parsePanos(text, device);
    case 'fortios':
      return parseFortios(text, device);
    case 'f5':
      return parseF5(text, device);
    case 'csv':
      return parseRulesCsv(text, device);
    case 'vips-csv':
      return parseVipsCsv(text, device);
    default:
      return null;
  }
}

/** The platforms `parseDeviceConfig` reads, for a dropdown. */
export const NETSEC_PARSERS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'cisco_asa', label: 'Cisco ASA / FTD (ASA syntax)' },
  { id: 'panos', label: 'Palo Alto PAN-OS (set format)' },
  { id: 'fortios', label: 'Fortinet FortiOS' },
  { id: 'f5', label: 'F5 BIG-IP (bigip.conf or AS3)' },
  { id: 'csv', label: 'firewall-rules.csv' },
  { id: 'vips-csv', label: 'vips.csv' },
];

/* ---------------------------------------------------------------- context --- */

export interface NetsecServer {
  readonly id: string;
  readonly name: string;
  readonly app: string;
  /** The tier the server is in: its role (web, app, db …). */
  readonly component: string;
  readonly platform?: Platform;
  /** Addresses of either family. */
  readonly addresses: readonly string[];
}
export interface NetsecSite {
  readonly name: string;
  readonly cidrs: readonly string[];
}
export interface NetsecContext {
  readonly servers: readonly NetsecServer[];
  readonly sites: readonly NetsecSite[];
  /** External links (A.2.9), for the partner-notice egress list. */
  readonly external?: readonly ExternalLink[];
}

/**
 * The classification context from a plan: its servers (with the platform the
 * decision chose, or the pin), its sites, the data-centre subnets (as the site
 * they are at) and the external links.
 */
export function netsecContext(plan: Plan, decision?: PlanDecision): NetsecContext {
  const servers: NetsecServer[] = plan.workloads.map((w) => {
    const platform = decision?.items[w.id]?.chosen?.platform ?? w.pin;
    return {
      id: w.id,
      name: w.name,
      app: w.app,
      component: w.role,
      ...(platform ? { platform } : {}),
      addresses: w.facts?.ipAddresses ?? [],
    };
  });
  const sites: NetsecSite[] = plan.requirements.sites.map((s) => ({ name: s.name, cidrs: s.cidrs }));
  for (const item of plan.dcExit?.infra ?? []) {
    if (item.category !== 'subnet') continue;
    const cidr = canonicalCidr(item.facts.cidr ?? item.name);
    if (cidr) sites.push({ name: item.site ?? item.name, cidrs: [cidr] });
  }
  return { servers, sites, ...(plan.dcExit ? { external: plan.dcExit.external } : {}) };
}

/* --------------------------------------------------------- classification --- */

export type EndpointKind = 'tier' | 'site' | 'internet' | 'any' | 'fqdn' | 'unknown';
export interface Endpoint {
  readonly kind: EndpointKind;
  readonly app?: string;
  readonly component?: string;
  readonly platform?: Platform;
  readonly site?: string;
  /** The addresses the endpoint stands for (the servers', for a tier). */
  readonly cidrs: readonly string[];
  /** What the endpoint was written as, for the review list. */
  readonly written: readonly string[];
}

const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', 'fc00::/7', 'fe80::/10', '::1/128'];

export function isPrivate(cidr: string): boolean {
  return PRIVATE.some((p) => familyOf(p) === familyOf(cidr) && overlapsAny(p, cidr) && (parseCidrAny(cidr)?.prefix ?? 0) >= (parseCidrAny(p)?.prefix ?? 0));
}

const endpointKey = (e: Endpoint): string => `${e.kind}|${e.app ?? ''}|${e.component ?? ''}|${e.site ?? ''}|${e.platform ?? ''}`;

/** One written endpoint → the endpoints it stands for (several tiers when a range covers them). */
export function classifyEndpoint(written: string, ctx: NetsecContext): Endpoint[] {
  if (isAnyEndpoint(written)) return [{ kind: 'any', cidrs: written === ANY ? ['0.0.0.0/0', '::/0'] : [written], written: [written] }];
  if (written.startsWith('fqdn:')) return [{ kind: 'fqdn', cidrs: [], written: [written] }];
  const c = parseCidrAny(written);
  if (!c || written.startsWith('?')) return [{ kind: 'unknown', cidrs: [], written: [written] }];

  const groups = new Map<string, { server: NetsecServer; addrs: string[] }[]>();
  for (const s of ctx.servers) {
    const inside = s.addresses.filter((a) => containsAny(written, a.split('/')[0] as string));
    if (inside.length === 0) continue;
    const k = `${s.app}|${s.component}`;
    groups.set(k, [...(groups.get(k) ?? []), { server: s, addrs: inside }]);
  }
  if (groups.size > 0) {
    return [...groups.values()].map((members) => {
      const first = (members[0] as { server: NetsecServer }).server;
      const platforms = new Set(members.map((m) => m.server.platform));
      return {
        kind: 'tier',
        app: first.app,
        component: first.component,
        ...(platforms.size === 1 && first.platform ? { platform: first.platform } : {}),
        cidrs: members.flatMap((m) => m.addrs.map((a) => canonicalCidr(a) as string)),
        written: [written],
      };
    });
  }
  const site = ctx.sites.find((s) => s.cidrs.some((sc) => overlapsAny(sc, written)));
  if (site) return [{ kind: 'site', site: site.name, cidrs: [written], written: [written] }];
  if (!isPrivate(written)) return [{ kind: 'internet', cidrs: [written], written: [written] }];
  return [{ kind: 'unknown', cidrs: [written], written: [written] }];
}

/** Classify a list and merge what lands in the same place. */
function classifyAll(list: readonly string[], ctx: NetsecContext): Endpoint[] {
  const merged = new Map<string, Endpoint>();
  for (const w of list) {
    for (const e of classifyEndpoint(w, ctx)) {
      const k = endpointKey(e);
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, cidrs: [...new Set([...prev.cidrs, ...e.cidrs])], written: [...prev.written, ...e.written] } : e);
    }
  }
  return [...merged.values()];
}

/* ------------------------------------------------------------ translation --- */

export type RuleScope = 'app-internal' | 'app-to-app' | 'cloud-firewall' | 'internet-ingress' | 'on-premises' | 'deny' | 'review' | 'disabled';
export type RuleOriginKind = 'config' | 'flows' | 'both';

export interface TranslatedRule {
  readonly id: string;
  readonly scope: RuleScope;
  /** The platform whose security group or firewall carries the rule. */
  readonly platform?: Platform;
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly services: readonly FwService[];
  readonly action: 'allow' | 'deny';
  readonly origin: RuleOriginKind;
  /** Source rules, `device:line name`. */
  readonly sources: readonly string[];
  /** For a cloud-firewall rule arriving at a tier: the tier's security group gets the rule too. */
  readonly alsoSecurityGroup?: boolean;
  /** Why the rule is where it is, in a line. */
  readonly why: string;
}

/** A config rule or a flow, with where it came from, before translation. */
export interface SourcedRule {
  readonly rule: FwRule;
  readonly origin: RuleOriginKind;
}

function scopeOf(from: Endpoint, to: Endpoint): { scope: RuleScope; platform?: Platform; also?: boolean; why: string } {
  const unknown = (e: Endpoint): boolean => e.kind === 'unknown' || e.kind === 'fqdn';
  if (unknown(from) || unknown(to)) return { scope: 'review', why: `${unknown(from) ? 'source' : 'destination'} ${[...(unknown(from) ? from : to).written].join(' ')} is not a known server, site or public address` };
  if (from.kind === 'any' && to.kind === 'any') return { scope: 'review', why: 'any to any is not translated' };
  if (to.kind === 'tier' && (from.kind === 'any' || from.kind === 'internet')) {
    return { scope: 'internet-ingress', ...(to.platform ? { platform: to.platform } : {}), why: 'inbound from the internet: through the app ingress and its WAF' };
  }
  if (from.kind === 'tier' && to.kind === 'tier') {
    if (!from.platform || !to.platform) return { scope: 'review', why: 'a server in the rule has no target platform yet' };
    if (from.platform !== to.platform) return { scope: 'cloud-firewall', platform: to.platform, also: true, why: `${from.platform} to ${to.platform}: across platforms, through the landing zone firewall` };
    if (from.app === to.app) return { scope: 'app-internal', platform: to.platform, why: `inside ${to.app}: a security-group rule in the app stack` };
    return { scope: 'app-to-app', platform: to.platform, why: `${from.app} to ${to.app} on one platform: security groups referencing each other` };
  }
  if (to.kind === 'tier' && from.kind === 'site') {
    if (!to.platform) return { scope: 'review', why: 'the destination server has no target platform yet' };
    return { scope: 'cloud-firewall', platform: to.platform, also: true, why: `from site ${from.site}: through the landing zone firewall` };
  }
  if (from.kind === 'tier' && (to.kind === 'site' || to.kind === 'internet' || to.kind === 'any')) {
    if (!from.platform) return { scope: 'review', why: 'the source server has no target platform yet' };
    return { scope: 'cloud-firewall', platform: from.platform, why: to.kind === 'site' ? `to site ${to.site}: through the landing zone firewall` : 'outbound: through the landing zone firewall' };
  }
  return { scope: 'on-premises', why: 'neither end is a server that moves: stays with the on-premises network until the exit' };
}

/**
 * Merge config rules with flow rules. A config rule is `both` when a flow it
 * allows was seen in the last `unusedDays`; otherwise `config`, and
 * `netsec.unused` when flows were supplied at all. A flow no enabled allow rule
 * covers is `flows`, with `netsec.undocumented`.
 */
export function mergeSources(
  config: readonly FwRule[],
  flows: readonly FwRule[],
  options: { readonly today?: string; readonly unusedDays?: number } = {},
): { readonly rules: readonly SourcedRule[]; readonly findings: readonly Finding[] } {
  const findings: Finding[] = [];
  const today = options.today ? Date.parse(options.today) : Date.now();
  const window = (options.unusedDays ?? 30) * 86_400_000;
  const covers = (rule: FwRule, flow: FwRule): boolean => {
    const addr = (f: string): string => f.split('/')[0] as string;
    const inList = (list: readonly string[], ip: string): boolean => list.some((c) => c === ANY || (parseCidrAny(c) !== null && containsAny(c, ip)));
    const s = flow.services[0];
    return (
      inList(rule.from, addr(flow.from[0] ?? '')) &&
      inList(rule.to, addr(flow.to[0] ?? '')) &&
      !!s &&
      rule.services.some((rs) => serviceCovers(rs, s.protocol, s.from))
    );
  };
  const out: SourcedRule[] = [];
  const used = new Set<FwRule>();
  for (const flow of flows) {
    const hit = config.filter((r) => r.action === 'allow' && !r.disabled && covers(r, flow));
    if (hit.length === 0) {
      out.push({ rule: flow, origin: 'flows' });
      findings.push(warning('netsec.undocumented', `Flow ${flow.from.join(' ')} → ${flow.to.join(' ')} ${flow.services.map(serviceText).join(' ')} has no firewall rule allowing it.`, { path: flow.name }));
      continue;
    }
    const recent = !flow.lastSeen || today - Date.parse(flow.lastSeen) <= window;
    if (recent) for (const r of hit) used.add(r);
  }
  for (const r of config) {
    const origin: RuleOriginKind = used.has(r) ? 'both' : 'config';
    out.push({ rule: r, origin });
    if (flows.length > 0 && origin === 'config' && r.action === 'allow' && !r.disabled) {
      findings.push(
        info('netsec.unused', `Rule ${r.name} (${r.source.device}:${r.source.line}) has no observed flow in ${options.unusedDays ?? 30} days. It is kept; remove it if it is no longer needed.`, {
          path: `${r.source.device}:${r.source.line}`,
        }),
      );
    }
  }
  return { rules: out, findings };
}

/**
 * A flow (flows.csv, A.10.1). The fields this engine reads from WP-21's
 * `FlowRecord` (discovery/flows.ts): any of its records can be passed as is.
 */
export interface FlowRecord {
  readonly sourceIp: string;
  readonly destIp: string;
  readonly destPort: number;
  readonly protocol: string;
  readonly observations?: number;
  readonly lastSeen?: string;
}

/** Accepted flows as rules, one per flow. */
export function rulesFromFlows(flows: readonly FlowRecord[]): FwRule[] {
  return flows.flatMap((f, i) => {
    const from = canonicalCidr(f.sourceIp);
    const to = canonicalCidr(f.destIp);
    const proto = f.protocol.toLowerCase();
    if (!from || !to) return [];
    const service: FwService = proto === 'tcp' || proto === 'udp' ? { protocol: proto, from: f.destPort, to: f.destPort } : proto.startsWith('icmp') ? { protocol: 'icmp' } : { protocol: 'any' };
    return [
      {
        name: `flow-${i + 1}`,
        from: [from],
        to: [to],
        services: [service],
        action: 'allow' as const,
        log: false,
        source: { device: 'flows', line: i + 2 },
        ...(f.lastSeen ? { lastSeen: f.lastSeen } : {}),
        ...(f.observations !== undefined ? { observations: f.observations } : {}),
      },
    ];
  });
}

export interface IngressItem {
  readonly name: string;
  readonly app?: string;
  readonly platform?: Platform;
  /** The blueprint that builds it: `<terraform target>_app_ingress` (A.4.10). */
  readonly blueprint?: string;
  readonly listener: { readonly port: number; readonly protocol: LbVip['protocol'] };
  readonly members: readonly { readonly server?: string; readonly address: string; readonly port: number }[];
  readonly healthCheck: { readonly kind: LbVip['monitor']; readonly path?: string; readonly port: number };
  readonly persistence: LbVip['persistence'];
  readonly ingress: AppIngress;
  /** The Terraform types the ingress uses on the platform (equivalence map lb.l7 / lb.l4). */
  readonly types: readonly string[];
  readonly vip: LbVip;
}

export interface NatItem {
  readonly nat: NatRule;
  readonly platform?: Platform;
  readonly becomes: 'cloud-nat' | 'public-ip';
  /** Terraform types (equivalence map network.nat / network.public-ip). */
  readonly types: readonly string[];
}

/** An egress address partners allow-list today, and whose traffic it carries. */
export interface EgressEntry {
  readonly current: string;
  readonly inside: readonly string[];
  readonly apps: readonly string[];
  readonly platform?: Platform;
  /** External links whose current IPs include it: they need a notice. */
  readonly notices: readonly string[];
}

export interface Translation {
  readonly rules: readonly TranslatedRule[];
  readonly ingress: readonly IngressItem[];
  readonly nat: readonly NatItem[];
  readonly egress: readonly EgressEntry[];
  readonly findings: readonly Finding[];
}

const typesOf = (rowId: string, platform: Platform | undefined): string[] => {
  const cell = platform ? rowById(rowId)?.per[platform] : undefined;
  return cell && cell.none === undefined ? [...cell.primary, ...(cell.supporting ?? [])] : [];
};

const sameServices = (a: readonly FwService[], b: readonly FwService[]): boolean => a.map(serviceText).sort().join() === b.map(serviceText).sort().join();

/** Translate rules (config, flows or both), VIPs and NAT against the plan's context. */
export function translate(
  input: { readonly rules: readonly SourcedRule[]; readonly vips?: readonly LbVip[]; readonly nats?: readonly NatRule[] },
  ctx: NetsecContext,
): Translation {
  const findings: Finding[] = [];
  const out: TranslatedRule[] = [];

  for (const { rule, origin } of input.rules) {
    const src = `${rule.source.device}:${rule.source.line} ${rule.name}`;
    const fromEps = classifyAll(rule.from, ctx);
    const toEps = classifyAll(rule.to, ctx);
    for (const from of fromEps) {
      for (const to of toEps) {
        let decided = scopeOf(from, to);
        if (rule.disabled) decided = { scope: 'disabled', why: 'disabled in the configuration' };
        else if (rule.unresolved?.length) decided = { scope: 'review', why: `not resolved: ${rule.unresolved.join(', ')}` };
        else if (rule.action === 'deny') decided = { scope: 'deny', ...(decided.platform ? { platform: decided.platform } : {}), why: 'deny rules are kept as information: cloud security groups are default-deny' };
        // One translated rule per scope, ends and services, whichever configurations said it.
        const existing = out.find(
          (r) => r.scope === decided.scope && r.action === rule.action && endpointKey(r.from) === endpointKey(from) && endpointKey(r.to) === endpointKey(to) && sameServices(r.services, rule.services),
        );
        if (existing) {
          const idx = out.indexOf(existing);
          const mergedOrigin: RuleOriginKind = existing.origin === origin ? origin : 'both';
          out[idx] = {
            ...existing,
            origin: mergedOrigin,
            sources: [...existing.sources, src],
            from: { ...existing.from, cidrs: [...new Set([...existing.from.cidrs, ...from.cidrs])] },
            to: { ...existing.to, cidrs: [...new Set([...existing.to.cidrs, ...to.cidrs])] },
          };
          continue;
        }
        out.push({
          id: `r${out.length + 1}`,
          scope: decided.scope,
          ...(decided.platform ? { platform: decided.platform } : {}),
          from,
          to,
          services: rule.services,
          action: rule.action,
          origin,
          sources: [src],
          ...(decided.also ? { alsoSecurityGroup: true } : {}),
          why: decided.why,
        });
      }
    }
  }
  for (const r of out) {
    if (r.scope === 'review') {
      findings.push(warning('netsec.review', `${r.sources.join('; ')}: ${r.why}. Listed for review, not translated.`, { path: r.id, remediation: 'Name the addresses (a server, a site CIDR) or split the rule, then re-run the translation.' }));
    }
  }

  // VIPs → ingress items.
  const ingress: IngressItem[] = [];
  for (const v of input.vips ?? []) {
    const members = v.pool.map((m) => {
      const server = ctx.servers.find((s) => s.addresses.some((a) => a.split('/')[0] === m.address));
      return { ...(server ? { server: server.name } : {}), address: m.address, port: m.port, app: server?.app, platform: server?.platform };
    });
    const apps = [...new Set(members.map((m) => m.app).filter((a): a is string => !!a))];
    const platforms = [...new Set(members.map((m) => m.platform).filter((p): p is Platform => !!p))];
    const platform = platforms.length === 1 ? platforms[0] : undefined;
    if (apps.length !== 1) findings.push(warning('netsec.vip-app', `VIP ${v.name}: its pool members ${apps.length === 0 ? 'are not servers in the plan' : `belong to ${apps.join(', ')}`}, so no single app ingress can take it.`, { path: v.name }));
    if (platforms.length > 1) findings.push(warning('netsec.vip-platform', `VIP ${v.name}: pool members land on ${platforms.join(' and ')}; one load balancer cannot span them.`, { path: v.name }));
    const l7 = v.protocol === 'http' || v.protocol === 'https';
    const exposure = isPrivate(canonicalCidr(v.vip) ?? v.vip) ? 'internal' : 'public';
    ingress.push({
      name: v.name,
      ...(apps.length === 1 ? { app: apps[0] } : {}),
      ...(platform ? { platform, blueprint: `${PLATFORM_INFO[platform].terraform}_app_ingress` } : {}),
      listener: { port: v.port, protocol: v.protocol },
      members: members.map(({ server, address, port }) => ({ ...(server ? { server } : {}), address, port })),
      healthCheck: { kind: v.monitor, ...(v.monitorPath ? { path: v.monitorPath } : {}), port: v.pool[0]?.port ?? v.port },
      persistence: v.persistence,
      ingress: { fqdns: [], exposure, lb: l7 ? 'l7' : 'l4', tls: v.tls === 'terminate' ? 'terminate' : 'passthrough', waf: exposure === 'public' && l7 },
      types: typesOf(l7 ? 'lb.l7' : 'lb.l4', platform),
      vip: v,
    });
  }

  // NAT → cloud NAT or public IPs; source NAT addresses → the egress list.
  const nat: NatItem[] = [];
  const egress = new Map<string, EgressEntry>();
  for (const n of input.nats ?? []) {
    const inside = classifyAll(n.real, ctx).filter((e) => e.kind === 'tier');
    const platforms = [...new Set(inside.map((e) => e.platform).filter((p): p is Platform => !!p))];
    const platform = platforms.length === 1 ? platforms[0] : undefined;
    const becomes = n.kind === 'source' ? 'cloud-nat' : 'public-ip';
    nat.push({ nat: n, ...(platform ? { platform } : {}), becomes, types: typesOf(becomes === 'cloud-nat' ? 'network.nat' : 'network.public-ip', platform) });
    for (const m of n.mapped) {
      if (m === 'interface' || m.startsWith('?')) {
        if (m !== 'interface') findings.push(info('netsec.nat-mapped', `NAT ${n.name}: mapped address ${m.slice(1)} is not resolved; add it to the egress list by hand.`, { path: n.name }));
        continue;
      }
      const current = m;
      const prev = egress.get(current);
      const apps = [...new Set([...(prev?.apps ?? []), ...inside.map((e) => e.app as string)])];
      const notices = (ctx.external ?? []).filter((l) => l.currentIps.some((ip) => containsAny(current, ip))).map((l) => l.id);
      egress.set(current, { current, inside: [...new Set([...(prev?.inside ?? []), ...n.real])], apps, ...(platform ? { platform } : {}), notices: [...new Set([...(prev?.notices ?? []), ...notices])] });
    }
  }
  for (const e of egress.values()) {
    if (e.notices.length) findings.push(info('netsec.egress-notice', `Egress address ${e.current} is allow-listed by ${e.notices.join(', ')}: they need notice of the new egress address.`, { path: e.current }));
  }
  if ((input.rules.length > 0 || (input.vips ?? []).length > 0) && ctx.servers.every((s) => s.addresses.length === 0)) {
    findings.push(error('netsec.no-addresses', 'No server in the plan has an IP address, so no rule endpoint can be matched to an app tier.', { remediation: 'Import the estate with its IP addresses (RVTools vNetwork, or the collectors).' }));
  }
  return { rules: out, ingress, nat, egress: [...egress.values()], findings };
}

/** Parsed configurations (and optional flows) to a translation, in one call. */
export function translateConfigs(
  configs: readonly ParsedConfig[],
  ctx: NetsecContext,
  options: { readonly flows?: readonly FlowRecord[]; readonly today?: string; readonly unusedDays?: number } = {},
): Translation {
  const config = configs.flatMap((c) => c.rules);
  const merged = mergeSources(config, rulesFromFlows(options.flows ?? []), options);
  const t = translate({ rules: merged.rules, vips: configs.flatMap((c) => c.vips), nats: configs.flatMap((c) => c.nats) }, ctx);
  return { ...t, findings: [...configs.flatMap((c) => c.findings), ...merged.findings, ...t.findings] };
}

/** The rule's family split: which of its CIDRs are IPv4 and which IPv6. */
export function byFamilyOf(cidrs: readonly string[]): Record<Family, string[]> {
  const out: Record<Family, string[]> = { 4: [], 6: [] };
  for (const c of cidrs) {
    const f = familyOf(c);
    if (f) out[f].push(c);
  }
  return out;
}

export type { NetsecSource };

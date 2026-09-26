/**
 * Cisco ASA (and FTD in ASA syntax) into the netsec model.
 *
 * Objects and object groups are read with the Network page's block reader
 * (`blocksOf` in network/full-config.ts): an ASA configuration is the same
 * indented-block shape as IOS. Access lists and NAT are top-level lines, read
 * with their line numbers so every rule can say where it came from.
 *
 * Covered: `object network` (host / subnet / range / fqdn, and object NAT),
 * `object-group network` (network-object, group-object), `object service`,
 * `object-group service` (with or without a protocol: port-object and
 * service-object), `object-group protocol`, `access-list … extended`,
 * `access-group` (which lists are applied, and on which interface), and
 * twice-NAT `nat (in,out) source static|dynamic …`. IPv6 appears as
 * `2001:db8::/64` operands, `host 2001:db8::1` and `any6`.
 */

import { blocksOf } from '../../../network/full-config.ts';
import { info, warning, type Finding } from '../../../core/findings.ts';
import {
  ANY,
  finishRule,
  canonicalCidr,
  fromMask,
  numberedLines,
  port,
  portOf,
  rangeToCidrs,
  tokens,
  type FwRule,
  type FwService,
  type NatRule,
  type ParsedConfig,
} from './model.ts';

interface AsaObjects {
  readonly networks: Map<string, string[]>;
  readonly services: Map<string, FwService[]>;
  readonly protocols: Map<string, string[]>;
}

const PORT_OPS = new Set(['eq', 'range', 'gt', 'lt', 'neq']);

/** `eq 443` / `range 8000 8080` / `gt 1023` at `at`: the port range and how many tokens it used. */
function portSpec(t: readonly string[], at: number): { from: number; to: number; used: number } | null {
  const op = t[at];
  if (op === 'eq') {
    const p = portOf(t[at + 1] ?? '');
    return p === null ? null : { from: p, to: p, used: 2 };
  }
  if (op === 'range') {
    const a = portOf(t[at + 1] ?? '');
    const b = portOf(t[at + 2] ?? '');
    return a === null || b === null ? null : { from: a, to: b, used: 3 };
  }
  if (op === 'gt') {
    const p = portOf(t[at + 1] ?? '');
    return p === null ? null : { from: p + 1, to: 65535, used: 2 };
  }
  if (op === 'lt') {
    const p = portOf(t[at + 1] ?? '');
    return p === null ? null : { from: 0, to: p - 1, used: 2 };
  }
  return null;
}

function protoService(proto: string, range?: { from: number; to: number }): FwService | null {
  const p = proto.toLowerCase();
  if (p === 'ip') return { protocol: 'any' };
  if (p === 'icmp' || p === 'icmp6') return { protocol: 'icmp' };
  if (p === 'tcp' || p === 'udp') return range ? port(p, range.from, range.to) : { protocol: p };
  if (p === 'tcp-udp') return null;
  return null;
}

/** A network operand inside an object body or group: the tokens after the keyword. */
function networkOperand(t: readonly string[], objects: AsaObjects): string[] | null {
  const [a = '', b] = t;
  if (a === 'host' && b) return [canonicalCidr(b) ?? `?${b}`];
  if (a === 'object' && b) return objects.networks.get(b) ?? [`?${b}`];
  if (b && /^\d+\.\d+\.\d+\.\d+$/.test(b)) {
    const c = fromMask(a, b);
    return c ? [c] : null;
  }
  const c = canonicalCidr(a);
  return c ? [c] : null;
}

function readObjects(text: string, findings: Finding[]): AsaObjects {
  const objects: AsaObjects = { networks: new Map(), services: new Map(), protocols: new Map() };
  const blocks = blocksOf(text.split(/\r?\n/));
  // Groups can refer to groups defined later; two passes settle the common cases.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const block of blocks) {
      const h = tokens(block.header);
      const body = block.body.map((l) => tokens(l.trim()));
      if (h[0] === 'object' && h[1] === 'network' && h[2]) {
        const out: string[] = [];
        for (const t of body) {
          if (t[0] === 'host' && t[1]) out.push(canonicalCidr(t[1]) ?? `?${t[1]}`);
          else if (t[0] === 'subnet' && t[1]) out.push((t[2] ? fromMask(t[1], t[2]) : canonicalCidr(t[1])) ?? `?${t[1]}`);
          else if (t[0] === 'range' && t[1] && t[2]) out.push(...(rangeToCidrs(t[1], t[2]) ?? [`?${t[1]}-${t[2]}`]));
          else if (t[0] === 'fqdn') out.push(`fqdn:${t[t.length - 1]}`);
        }
        objects.networks.set(h[2], out);
      } else if (h[0] === 'object-group' && h[1] === 'network' && h[2]) {
        const out: string[] = [];
        for (const t of body) {
          if (t[0] === 'network-object') out.push(...(networkOperand(t.slice(1), objects) ?? [`?${t.slice(1).join(' ')}`]));
          else if (t[0] === 'group-object' && t[1]) out.push(...(objects.networks.get(t[1]) ?? [`?${t[1]}`]));
        }
        objects.networks.set(h[2], out);
      } else if (h[0] === 'object' && h[1] === 'service' && h[2]) {
        const out: FwService[] = [];
        for (const t of body) {
          if (t[0] !== 'service' || !t[1]) continue;
          const d = t.indexOf('destination');
          const range = d >= 0 ? portSpec(t, d + 1) : null;
          const s = protoService(t[1], range ?? undefined);
          if (s) out.push(s);
        }
        objects.services.set(h[2], out);
      } else if (h[0] === 'object-group' && h[1] === 'service' && h[2]) {
        const groupProto = h[3];
        const out: FwService[] = [];
        for (const t of body) {
          if (t[0] === 'port-object') {
            const r = portSpec(t, 1);
            const protos = groupProto === 'tcp-udp' ? ['tcp', 'udp'] : groupProto ? [groupProto] : [];
            for (const p of protos) {
              const s = protoService(p, r ?? undefined);
              if (s) out.push(s);
            }
          } else if (t[0] === 'service-object') {
            if (t[1] === 'object' && t[2]) {
              out.push(...(objects.services.get(t[2]) ?? []));
              continue;
            }
            const d = t.indexOf('destination');
            const r = portSpec(t, d >= 0 ? d + 1 : 2);
            const protos = t[1] === 'tcp-udp' ? ['tcp', 'udp'] : [t[1] ?? ''];
            for (const p of protos) {
              const s = protoService(p, r ?? undefined);
              if (s) out.push(s);
            }
          } else if (t[0] === 'group-object' && t[1]) {
            out.push(...(objects.services.get(t[1]) ?? []));
          }
        }
        objects.services.set(h[2], out);
      } else if (h[0] === 'object-group' && h[1] === 'protocol' && h[2]) {
        objects.protocols.set(h[2], body.filter((t) => t[0] === 'protocol-object' && t[1]).map((t) => t[1] as string));
      }
    }
  }
  for (const [name, list] of objects.networks) {
    if (list.length === 0) findings.push(warning('netsec.asa.empty-object', `Network object ${name} has no addresses the parser could read.`));
  }
  return objects;
}

/** An address operand in an access list, at `at`: the addresses and the tokens used. */
function aclAddress(t: readonly string[], at: number, objects: AsaObjects): { addrs: string[]; used: number } | null {
  const a = t[at];
  if (a === undefined) return null;
  if (a === 'any') return { addrs: [ANY], used: 1 };
  if (a === 'any4') return { addrs: ['0.0.0.0/0'], used: 1 };
  if (a === 'any6') return { addrs: ['::/0'], used: 1 };
  if (a === 'host' && t[at + 1]) return { addrs: [canonicalCidr(t[at + 1] as string) ?? `?${t[at + 1]}`], used: 2 };
  if ((a === 'object' || a === 'object-group') && t[at + 1]) {
    const name = t[at + 1] as string;
    return { addrs: objects.networks.get(name) ?? [`?${name}`], used: 2 };
  }
  if (a === 'interface' && t[at + 1]) return { addrs: [`?interface:${t[at + 1]}`], used: 2 };
  const next = t[at + 1];
  if (next && /^\d+\.\d+\.\d+\.\d+$/.test(next) && /^\d+\.\d+\.\d+\.\d+$/.test(a)) {
    const c = fromMask(a, next);
    return c ? { addrs: [c], used: 2 } : null;
  }
  const c = canonicalCidr(a);
  return c ? { addrs: [c], used: 1 } : null;
}

export function parseAsa(text: string, device = 'asa'): ParsedConfig {
  const findings: Finding[] = [];
  const objects = readObjects(text, findings);
  const rules: FwRule[] = [];
  const nats: NatRule[] = [];
  const applied = new Map<string, string>();
  const counters = new Map<string, number>();

  const lines = numberedLines(text);
  for (const { text: line } of lines) {
    const m = /^access-group\s+(\S+)\s+(in|out)\s+interface\s+(\S+)/.exec(line);
    if (m) applied.set(m[1] as string, m[3] as string);
  }

  let currentObject: string | null = null;
  for (const { n, text: line } of lines) {
    if (/^\S/.test(line)) currentObject = /^object network (\S+)/.exec(line)?.[1] ?? null;
    const t = tokens(line.trim());

    // Object NAT, inside `object network X`: nat (inside,outside) static|dynamic MAPPED
    if (/^\s/.test(line) && currentObject && t[0] === 'nat') {
      const kind = t[2] === 'static' ? 'static' : 'source';
      const mappedName = t[3] ?? '';
      nats.push({
        name: `${currentObject}-nat`,
        kind,
        real: objects.networks.get(currentObject) ?? [`?${currentObject}`],
        mapped: mappedName === 'interface' ? ['interface'] : objects.networks.get(mappedName) ?? [canonicalCidr(mappedName) ?? `?${mappedName}`],
        source: { device, line: n },
      });
      continue;
    }

    const si = t.indexOf('source');
    if (t[0] === 'nat' && si > 0 && si <= 3) {
      // nat (inside,outside) [after-auto] source static|dynamic REAL MAPPED …
      const kind = t[si + 1] === 'static' ? 'static' : 'source';
      const realName = t[si + 2] ?? '';
      const mappedName = t[si + 3] ?? '';
      const real = objects.networks.get(realName) ?? [canonicalCidr(realName) ?? `?${realName}`];
      const mapped = mappedName === 'interface' ? ['interface'] : objects.networks.get(mappedName) ?? [canonicalCidr(mappedName) ?? `?${mappedName}`];
      nats.push({ name: `nat-${n}`, kind, real, mapped, source: { device, line: n } });
      continue;
    }

    if (t[0] !== 'access-list') continue;
    const acl = t[1] as string;
    let i = 2;
    if (t[i] === 'line') i += 2;
    if (t[i] === 'remark' || t[i] === 'standard' || t[i] === 'ethertype' || t[i] === 'webtype') continue;
    if (t[i] === 'extended') i += 1;
    const action = t[i];
    if (action !== 'permit' && action !== 'deny') continue;
    i += 1;

    // Protocol: tcp | udp | icmp | ip | object SVC | object-group SVC-or-PROTO
    let services: FwService[] = [];
    let protoForPorts: string[] = [];
    const p = t[i] ?? '';
    if ((p === 'object' || p === 'object-group') && t[i + 1]) {
      const name = t[i + 1] as string;
      if (objects.services.has(name)) services = [...(objects.services.get(name) as FwService[])];
      else if (objects.protocols.has(name)) protoForPorts = objects.protocols.get(name) as string[];
      else findings.push(warning('netsec.asa.unresolved', `${acl} line ${n}: service ${name} is not defined in this file.`, { path: `${device}:${n}` }));
      i += 2;
    } else {
      protoForPorts = [p];
      i += 1;
    }

    const src = aclAddress(t, i, objects);
    if (!src) {
      findings.push(warning('netsec.asa.unparsed', `${acl} line ${n}: the source operand could not be read.`, { path: `${device}:${n}` }));
      continue;
    }
    i += src.used;
    // A source port, which the cloud rules have no use for.
    if (PORT_OPS.has(t[i] ?? '')) i += t[i] === 'range' ? 3 : 2;
    const dst = aclAddress(t, i, objects);
    if (!dst) {
      findings.push(warning('netsec.asa.unparsed', `${acl} line ${n}: the destination operand could not be read.`, { path: `${device}:${n}` }));
      continue;
    }
    i += dst.used;

    let range: { from: number; to: number } | undefined;
    const spec = portSpec(t, i);
    if (spec) {
      range = { from: spec.from, to: spec.to };
      i += spec.used;
    } else if (t[i] === 'object-group' && t[i + 1] && objects.services.has(t[i + 1] as string)) {
      // A port group on the destination (object-group service NAME tcp).
      services.push(...(objects.services.get(t[i + 1] as string) as FwService[]));
      protoForPorts = [];
      i += 2;
    }
    for (const proto of protoForPorts) {
      const s = protoService(proto, range);
      if (s) services.push(s);
      else findings.push(info('netsec.asa.protocol', `${acl} line ${n}: protocol ${proto} is kept as "any".`, { path: `${device}:${n}` }));
    }
    if (services.length === 0) services = [{ protocol: 'any' }];

    const rest = t.slice(i);
    const index = (counters.get(acl) ?? 0) + 1;
    counters.set(acl, index);
    rules.push({
      name: `${acl}-${index}`,
      from: src.addrs,
      to: dst.addrs,
      services,
      action: action === 'permit' ? 'allow' : 'deny',
      log: rest.includes('log'),
      disabled: rest.includes('inactive'),
      fromZone: applied.get(acl),
      source: { device, line: n },
    });
  }

  const unapplied = [...new Set(rules.map((r) => r.name.replace(/-\d+$/, '')))].filter((acl) => applied.size > 0 && !applied.has(acl));
  for (const acl of unapplied) {
    findings.push(info('netsec.asa.unapplied', `Access list ${acl} is not bound by an access-group; its rules are read, but check that it is in use.`, { path: device }));
  }
  return { device, platform: 'cisco_asa', rules: rules.map(finishRule), nats, vips: [], findings };
}

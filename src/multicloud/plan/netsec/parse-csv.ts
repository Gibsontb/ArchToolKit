/**
 * The vendor-neutral imports (addendum A.5.5.1, "Any"):
 *   - `firewall-rules.csv`: `name,src,dst,service,action`;
 *   - `vips.csv`: `vip,port,protocol,members,monitor`.
 *
 * Columns are found by header (with the usual aliases), never by position.
 * A list cell holds several values separated by spaces, semicolons or `|`
 * (`10.1.1.0/24 2001:db8:1::/64`, `tcp/443;tcp/8443`). Members are
 * `address:port`, an IPv6 member `[2001:db8::10]:80`.
 */

import { parseCsvRecords, pick } from '../../../core/csv.ts';
import { splitHostPort } from '../../../core/ip.ts';
import { warning, type Finding } from '../../../core/findings.ts';
import {
  ANY,
  canonicalCidr,
  finishRule,
  parseService,
  type FwRule,
  type FwService,
  type LbVip,
  type MonitorKind,
  type ParsedConfig,
  type Persistence,
  type PoolMember,
  type VipProtocol,
  type VipTls,
} from './model.ts';

const split = (cell: string | undefined): string[] => (cell ?? '').split(/[\s;|]+/).map((s) => s.trim()).filter(Boolean);

function endpoint(text: string): string {
  const t = text.trim();
  if (/^(any|\*|all)$/i.test(t)) return ANY;
  const c = canonicalCidr(t);
  if (c) return c;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return `fqdn:${t.toLowerCase()}`;
  return `?${t}`;
}

export function parseRulesCsv(text: string, device = 'firewall-rules.csv'): ParsedConfig {
  const findings: Finding[] = [];
  const rules: FwRule[] = [];
  parseCsvRecords(text).forEach((row, idx) => {
    const line = idx + 2;
    const name = pick(row, 'name', 'rule', 'rule name') ?? `rule-${idx + 1}`;
    const src = split(pick(row, 'src', 'source', 'from', 'source address'));
    const dst = split(pick(row, 'dst', 'destination', 'to', 'destination address'));
    const serviceCells = split(pick(row, 'service', 'services', 'port', 'ports'));
    const services: FwService[] = [];
    const unresolved: string[] = [];
    for (const s of serviceCells.length ? serviceCells : ['any']) {
      const parsed = parseService(s);
      if (parsed) services.push(parsed);
      else unresolved.push(`service:${s}`);
    }
    const actionText = (pick(row, 'action') ?? 'allow').toLowerCase();
    const action = /^(allow|permit|accept|pass)$/.test(actionText) ? 'allow' : 'deny';
    if (src.length === 0 || dst.length === 0) {
      findings.push(warning('netsec.csv.row', `Row ${line} (${name}) has no source or destination.`, { path: `${device}:${line}` }));
      return;
    }
    rules.push(
      finishRule({
        name,
        from: src.map(endpoint),
        to: dst.map(endpoint),
        services,
        action,
        log: false,
        source: { device, line },
        ...(unresolved.length ? { unresolved } : {}),
      }),
    );
  });
  return { device, platform: 'csv', rules, nats: [], vips: [], findings };
}

const PROTOCOLS: readonly VipProtocol[] = ['tcp', 'udp', 'http', 'https'];
const MONITORS: readonly MonitorKind[] = ['tcp', 'http', 'https', 'icmp', 'udp', 'none'];

export function parseVipsCsv(text: string, device = 'vips.csv'): ParsedConfig {
  const findings: Finding[] = [];
  const vips: LbVip[] = [];
  parseCsvRecords(text).forEach((row, idx) => {
    const line = idx + 2;
    const vip = (pick(row, 'vip', 'address', 'virtual address') ?? '').trim();
    const port = Number(pick(row, 'port', 'virtual port') ?? 0);
    const protoText = (pick(row, 'protocol') ?? 'tcp').toLowerCase() as VipProtocol;
    const protocol: VipProtocol = PROTOCOLS.includes(protoText) ? protoText : 'tcp';
    const members: PoolMember[] = [];
    for (const m of split(pick(row, 'members', 'pool', 'servers'))) {
      const hp = splitHostPort(m);
      if (hp.port === null) findings.push(warning('netsec.csv.member', `Row ${line}: member ${m} has no port.`, { path: `${device}:${line}` }));
      else members.push({ address: hp.host, port: hp.port });
    }
    const monText = (pick(row, 'monitor', 'health check') ?? 'none').toLowerCase();
    const [kind = 'none', ...rest] = monText.split(/[\s:]+/);
    const monitor: MonitorKind = MONITORS.includes(kind as MonitorKind) ? (kind as MonitorKind) : 'tcp';
    const persistText = (pick(row, 'persistence') ?? 'none').toLowerCase();
    const persistence: Persistence = persistText === 'cookie' ? 'cookie' : /source/.test(persistText) ? 'source-ip' : 'none';
    const tlsText = (pick(row, 'tls') ?? '').toLowerCase();
    const tls: VipTls = tlsText === 'terminate' || tlsText === 'passthrough' ? tlsText : protocol === 'https' ? 'terminate' : 'none';
    if (!vip || !canonicalCidr(vip)) {
      findings.push(warning('netsec.csv.vip', `Row ${line}: "${vip}" is not an address.`, { path: `${device}:${line}` }));
      return;
    }
    vips.push({
      name: pick(row, 'name') ?? `vip-${idx + 1}`,
      vip,
      port,
      protocol,
      pool: members,
      monitor,
      ...(rest[0]?.startsWith('/') ? { monitorPath: rest[0] } : {}),
      persistence,
      tls,
      source: { device, line },
    });
  });
  return { device, platform: 'csv', rules: [], nats: [], vips, findings };
}

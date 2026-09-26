/**
 * Dependency discovery from network flows (addendum A.10.1).
 *
 * Typed "Depends on" cells are what people remember; flows are what the
 * servers actually do. Three sources arrive here through one format,
 * `flows.csv`:
 *
 *   source_ip,dest_ip,dest_port,protocol,observations,first_seen,last_seen,bytes[,process,dest_name]
 *
 *  1. VCF Operations for Networks, through the generated `networks-flows.sh`
 *     (networks-flows.ts), which writes flows.csv itself;
 *  2. any NetFlow / IPFIX collector's CSV (nfdump `-o csv`, a SIEM export, VPC
 *     flow logs), mapped by header aliases — never by column position;
 *  3. the generated guest capture (`ss` / `netstat` / `Get-NetTCPConnection`,
 *     capture.ts), aggregated per remote, port and process.
 *
 * The IPs are matched to the plan's servers (`WorkloadFacts.ipAddresses`, both
 * families) and to sites; anything else is external. The result is a list of
 * *proposed* edges for a review grid. Nothing is accepted automatically:
 * `acceptEdges` writes only the edges the user ticked.
 */

import { parseCsv } from '../../../core/csv.ts';
import { containsAny, familyOf, parseCidrAny } from '../../../core/ip.ts';
import { info, warning, type Finding } from '../../../core/findings.ts';
import type { DependencyEdge, EdgeKind, Plan, Workload } from '../types.ts';

// ---------------------------------------------------------------------------
// The canonical record and file
// ---------------------------------------------------------------------------

export interface FlowRecord {
  readonly sourceIp: string;
  readonly destIp: string;
  readonly destPort: number;
  /** 'tcp' | 'udp' | 'icmp' | another name, lower case. */
  readonly protocol: string;
  /** How many times the flow was seen (samples, flow records). */
  readonly observations: number;
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  readonly bytes?: number;
  /** The process on the source side, when the capture saw it. */
  readonly process?: string;
  /** A name for the destination (reverse DNS, the collector's name for it). */
  readonly destName?: string;
}

export const FLOWS_CSV_COLUMNS = Object.freeze([
  'source_ip', 'dest_ip', 'dest_port', 'protocol', 'observations', 'first_seen', 'last_seen', 'bytes', 'process', 'dest_name',
] as const);
/** The first eight columns are the addendum's; process and dest_name are optional extras. */
export const FLOWS_CSV_HEADER = FLOWS_CSV_COLUMNS.join(',');

export type FlowField =
  | 'sourceIp' | 'destIp' | 'destPort' | 'sourcePort' | 'protocol' | 'observations'
  | 'firstSeen' | 'lastSeen' | 'bytes' | 'process' | 'destName';
export const REQUIRED_FLOW_FIELDS: readonly FlowField[] = Object.freeze(['sourceIp', 'destIp', 'destPort']);

/**
 * Header spellings per field, from the collectors people actually export
 * from. Matching ignores case, spaces and punctuation, so "Src IP", "src_ip"
 * and "srcip" are one alias. The canonical flows.csv name is first.
 *
 * - nfdump `-o csv`: ts, te, sa, da, sp, dp, pr, ibyt (verify against the
 *   collector's nfdump version; 1.6 and 1.7 differ in the trailing columns).
 * - AWS VPC flow logs: srcaddr, dstaddr, srcport, dstport, protocol, bytes,
 *   start, end (https://docs.aws.amazon.com/vpc/latest/userguide/flow-log-records.html).
 * - IPFIX information elements: sourceIPv4Address, destinationTransportPort,
 *   protocolIdentifier, octetDeltaCount, flowStartSeconds (RFC 7012 / IANA).
 * - nProbe / NetFlow v9 names: IPV4_SRC_ADDR, L4_DST_PORT, IN_BYTES.
 * - VCF Operations for Networks CSV export of a flow search: "Source IP
 *   Address", "Destination IP Address", "Port", "Protocol" (verify on the
 *   instance; the column set follows the search's selected properties).
 */
export const FLOW_HEADER_ALIASES: Readonly<Record<FlowField, readonly string[]>> = Object.freeze({
  sourceIp: ['source_ip', 'src ip', 'srcip', 'sa', 'srcaddr', 'source address', 'source ip address', 'sourceipv4address',
    'sourceipv6address', 'ipv4_src_addr', 'ipv6_src_addr', 'src', 'source', 'client ip', 'src_addr', 'sourceip'],
  destIp: ['dest_ip', 'dst ip', 'dstip', 'da', 'dstaddr', 'destination address', 'destination ip address', 'destinationipv4address',
    'destinationipv6address', 'ipv4_dst_addr', 'ipv6_dst_addr', 'dst', 'destination', 'server ip', 'dst_addr', 'destinationip', 'dest ip'],
  destPort: ['dest_port', 'dst port', 'dstport', 'dp', 'destination port', 'port', 'destinationtransportport', 'l4_dst_port',
    'dpt', 'service port', 'dst_port'],
  sourcePort: ['source_port', 'src port', 'srcport', 'sp', 'sourcetransportport', 'l4_src_port', 'spt', 'source port'],
  protocol: ['protocol', 'proto', 'pr', 'protocolidentifier', 'ip protocol', 'transport', 'l4 protocol'],
  observations: ['observations', 'flows', 'flow count', 'fl', 'records', 'sessions', 'connections', 'count', 'hits'],
  firstSeen: ['first_seen', 'ts', 'start', 'first', 'flowstartseconds', 'flowstartmilliseconds', 'first seen', 'start time', 'first_switched'],
  lastSeen: ['last_seen', 'te', 'end', 'last', 'flowendseconds', 'flowendmilliseconds', 'last seen', 'end time', 'last_switched'],
  bytes: ['bytes', 'ibyt', 'byt', 'octets', 'octetdeltacount', 'in_bytes', 'total bytes', 'bytes total'],
  process: ['process', 'process name', 'program', 'processname', 'image'],
  destName: ['dest_name', 'destination name', 'dst host', 'dest host', 'destination hostname', 'rdns', 'reverse dns', 'server name', 'destination vm', 'dst name'],
});

/** Header → field mapping: the file's own header text per field. */
export type FlowMapping = Readonly<Partial<Record<FlowField, string>>>;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A stable key for a set of headers, so the mapping dialog's answer can be
 * remembered for the next file with the same layout.
 */
export function headerSetKey(headers: readonly string[]): string {
  return [...new Set(headers.map(norm).filter(Boolean))].sort().join('|');
}

export interface HeaderMapping {
  readonly mapping: FlowMapping;
  /** Required fields no header matched: the dialog asks for these. */
  readonly missing: readonly FlowField[];
  /** Headers not used by the mapping. */
  readonly unused: readonly string[];
  readonly key: string;
}

/**
 * Map a file's headers to flow fields by alias. A remembered mapping (from the
 * dialog, for this header set) wins over the aliases, field by field.
 */
export function mapFlowHeaders(headers: readonly string[], remembered: FlowMapping = {}): HeaderMapping {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (!byNorm.has(norm(h))) byNorm.set(norm(h), h);
  const used = new Set<string>();
  const mapping: Partial<Record<FlowField, string>> = {};
  const fields = Object.keys(FLOW_HEADER_ALIASES) as FlowField[];
  for (const field of fields) {
    const given = remembered[field];
    if (given !== undefined && headers.includes(given)) {
      mapping[field] = given;
      used.add(given);
    }
  }
  for (const field of fields) {
    if (mapping[field] !== undefined) continue;
    for (const alias of FLOW_HEADER_ALIASES[field]) {
      const header = byNorm.get(norm(alias));
      if (header !== undefined && !used.has(header)) {
        mapping[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return {
    mapping,
    missing: REQUIRED_FLOW_FIELDS.filter((f) => mapping[f] === undefined),
    unused: headers.filter((h) => !used.has(h)),
    key: headerSetKey(headers),
  };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const PROTOCOL_NUMBERS: Readonly<Record<string, string>> = { '1': 'icmp', '6': 'tcp', '17': 'udp', '58': 'icmp', '132': 'sctp' };

/** 6 → tcp, "TCP" → tcp, "IPv6-ICMP" → icmp. */
export function normaliseProtocol(raw: string | undefined): string {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return 'tcp';
  if (PROTOCOL_NUMBERS[t]) return PROTOCOL_NUMBERS[t] as string;
  if (t.includes('icmp')) return 'icmp';
  if (t.startsWith('tcp')) return 'tcp';
  if (t.startsWith('udp')) return 'udp';
  return t;
}

/**
 * An address as the plan stores it: IPv6 compressed, IPv4-mapped IPv6 and
 * zone ids stripped, brackets removed. '' when it is not an address.
 */
export function canonicalIp(raw: string | undefined): string {
  let t = String(raw ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
  if (mapped) t = mapped[1] as string;
  if (!t || t.includes('/') || familyOf(t) === null) return '';
  return parseCidrAny(t)?.address ?? '';
}

/** Epoch seconds or milliseconds, or a date-time, as ISO; the text as given otherwise. */
export function normaliseTime(raw: string | undefined): string | undefined {
  const t = String(raw ?? '').trim();
  if (!t) return undefined;
  if (/^\d{9,13}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    return new Date(n > 1e11 ? n : n * 1000).toISOString().replace('.000Z', 'Z');
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (m) return `${m[1]}T${m[2]}${m[4] ?? ''}`;
  return t;
}

const num = (raw: string | undefined): number | undefined => {
  const t = String(raw ?? '').trim().replace(/,/g, '');
  if (!t) return undefined;
  // nfdump prints "1.2 M" for large counters in some formats.
  const m = /^([\d.]+)\s*([kmg])?$/i.exec(t);
  if (!m) return undefined;
  const scale = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'g'] ?? 1;
  const n = Number(m[1]) * scale;
  return Number.isFinite(n) ? n : undefined;
};

/** The IANA dynamic range starts at 49152; Linux's default ephemeral range at 32768. */
export const EPHEMERAL_FROM = 32768;

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface FlowImport {
  readonly flows: readonly FlowRecord[];
  readonly mapping: FlowMapping;
  readonly missing: readonly FlowField[];
  readonly headers: readonly string[];
  /** The header-set key the mapping dialog remembers its answer under. */
  readonly key: string;
  readonly skipped: number;
  readonly findings: readonly Finding[];
}

/**
 * Parse a flows file of any of the supported layouts. When a required column
 * cannot be found, `missing` names it and `flows` is empty: the page shows the
 * mapping dialog and calls again with `mapping`.
 */
export function importFlows(text: string, options: { readonly mapping?: FlowMapping } = {}): FlowImport {
  const table = parseCsv(text);
  const headers = table.headers.map((h) => h.trim());
  const mapped = mapFlowHeaders(headers, options.mapping);
  const base = { mapping: mapped.mapping, missing: mapped.missing, headers, key: mapped.key };
  if (mapped.missing.length > 0) {
    return {
      ...base, flows: [], skipped: table.rows.length,
      findings: [warning('flows.mapping-needed', `The flows file has no column for ${mapped.missing.join(', ')}; choose the columns to use.`, {
        remediation: `Pick the column for each of: ${mapped.missing.join(', ')}. The choice is remembered for files with the same headers.`,
      })],
    };
  }
  const col = (field: FlowField): number => (mapped.mapping[field] === undefined ? -1 : headers.indexOf(mapped.mapping[field] as string));
  const at = (row: readonly string[], field: FlowField): string | undefined => {
    const i = col(field);
    return i < 0 ? undefined : row[i];
  };
  const flows: FlowRecord[] = [];
  let skipped = 0;
  let flipped = 0;
  const headerLine = headers.map(norm).join('|');
  for (const row of table.rows) {
    // Concatenated per-host files repeat the header; nfdump appends a summary.
    if (row.map((c) => norm(c)).join('|') === headerLine) continue;
    let src = canonicalIp(at(row, 'sourceIp'));
    let dst = canonicalIp(at(row, 'destIp'));
    let port = num(at(row, 'destPort'));
    const sport = num(at(row, 'sourcePort'));
    if (!src || !dst || port === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
      skipped += 1;
      continue;
    }
    // A unidirectional collector records the reply too: 10.0.0.5:1433 → client:51234.
    // A well-known source port talking to an ephemeral one is that reply.
    if (sport !== undefined && sport < EPHEMERAL_FROM && port >= EPHEMERAL_FROM) {
      [src, dst] = [dst, src];
      port = sport;
      flipped += 1;
    }
    const observations = num(at(row, 'observations'));
    const bytes = num(at(row, 'bytes'));
    const first = normaliseTime(at(row, 'firstSeen'));
    const last = normaliseTime(at(row, 'lastSeen'));
    const process = (at(row, 'process') ?? '').trim();
    const destName = (at(row, 'destName') ?? '').trim();
    flows.push({
      sourceIp: src, destIp: dst, destPort: port, protocol: normaliseProtocol(at(row, 'protocol')),
      observations: observations !== undefined && observations > 0 ? Math.round(observations) : 1,
      ...(first ? { firstSeen: first } : {}),
      ...(last ? { lastSeen: last } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(process ? { process } : {}),
      ...(destName ? { destName } : {}),
    });
  }
  const findings: Finding[] = [];
  if (skipped > 0) findings.push(info('flows.rows-skipped', `${skipped} row(s) had no usable source, destination or port and were skipped.`));
  if (flipped > 0) findings.push(info('flows.replies-flipped', `${flipped} reply flow(s) (well-known source port to an ephemeral port) were turned round to client → server.`));
  return { ...base, flows: aggregateFlows(flows), skipped, findings };
}

const flowKey = (f: Pick<FlowRecord, 'sourceIp' | 'destIp' | 'destPort' | 'protocol'>): string =>
  `${f.sourceIp}\u0000${f.destIp}\u0000${f.destPort}\u0000${f.protocol}`;

/** Merge records with the same source, destination, port and protocol. Sorted, so the output is stable. */
export function aggregateFlows(flows: readonly FlowRecord[]): FlowRecord[] {
  const out = new Map<string, FlowRecord & { processes: Set<string> }>();
  for (const raw of flows) {
    const f = { ...raw, sourceIp: canonicalIp(raw.sourceIp) || raw.sourceIp, destIp: canonicalIp(raw.destIp) || raw.destIp };
    const key = flowKey(f);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...f, processes: new Set(f.process ? [f.process] : []) });
      continue;
    }
    if (f.process) prev.processes.add(f.process);
    const first = [prev.firstSeen, f.firstSeen].filter((x): x is string => !!x).sort()[0];
    const last = [prev.lastSeen, f.lastSeen].filter((x): x is string => !!x).sort().pop();
    const bytes = prev.bytes === undefined && f.bytes === undefined ? undefined : (prev.bytes ?? 0) + (f.bytes ?? 0);
    out.set(key, {
      ...prev,
      observations: prev.observations + f.observations,
      ...(first ? { firstSeen: first } : {}),
      ...(last ? { lastSeen: last } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(prev.destName || f.destName ? { destName: prev.destName ?? f.destName } : {}),
    });
  }
  return [...out.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => {
      const { processes, process: _p, ...rest } = v;
      const process = [...processes].sort().join(' ');
      return { ...rest, ...(process ? { process } : {}) };
    });
}

const csvField = (v: string | number | undefined): string => {
  const t = v === undefined ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** flows.csv, canonical columns. */
export function flowsCsv(flows: readonly FlowRecord[]): string {
  const lines = [FLOWS_CSV_HEADER];
  for (const f of flows) {
    lines.push([f.sourceIp, f.destIp, f.destPort, f.protocol, f.observations, f.firstSeen, f.lastSeen, f.bytes, f.process, f.destName].map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Port classes: the proposed edge kind
// ---------------------------------------------------------------------------

export type PortClass = 'database' | 'cache' | 'messaging' | 'ldap' | 'kerberos' | 'smtp' | 'file-transfer'
  | 'web' | 'dns' | 'ntp' | 'file-share' | 'management' | 'other';
export interface PortClassInfo {
  readonly cls: PortClass;
  readonly label: string;
  readonly kind: EdgeKind;
  readonly ports: readonly number[];
}

/**
 * A.10.1: database, cache, messaging, LDAP and Kerberos are synchronous (the
 * caller waits on them, so they move together); SMTP and batch file transfer
 * are asynchronous. Web, DNS, NTP and file shares are request/response and so
 * sync. Management traffic (RDP, WinRM, SSH) is shown, as async, because it is
 * rarely an application dependency. Ports are the vendors' defaults.
 */
export const PORT_CLASSES: readonly PortClassInfo[] = Object.freeze([
  { cls: 'database', label: 'Database', kind: 'sync', ports: [1433, 1434, 1521, 1522, 1526, 3306, 33060, 5432, 5433, 6432, 27017, 27018, 27019, 50000, 50001, 9042, 9160, 9200, 9300, 9088, 30013, 30015, 30041, 5000] },
  { cls: 'cache', label: 'Cache', kind: 'sync', ports: [6379, 6380, 26379, 11211] },
  { cls: 'messaging', label: 'Messaging', kind: 'sync', ports: [5671, 5672, 9092, 9093, 1414, 61616, 4222, 1883, 8883] },
  { cls: 'ldap', label: 'LDAP', kind: 'sync', ports: [389, 636, 3268, 3269] },
  { cls: 'kerberos', label: 'Kerberos', kind: 'sync', ports: [88, 464] },
  { cls: 'smtp', label: 'SMTP', kind: 'async', ports: [25, 465, 587] },
  { cls: 'file-transfer', label: 'Batch file transfer', kind: 'async', ports: [20, 21, 69, 873, 989, 990] },
  { cls: 'web', label: 'Web / API', kind: 'sync', ports: [80, 443, 8000, 8080, 8443, 8888] },
  { cls: 'dns', label: 'DNS', kind: 'sync', ports: [53] },
  { cls: 'ntp', label: 'NTP', kind: 'sync', ports: [123] },
  { cls: 'file-share', label: 'File share (SMB / NFS)', kind: 'sync', ports: [445, 139, 2049, 111] },
  { cls: 'management', label: 'Management (SSH / RDP / WinRM)', kind: 'async', ports: [22, 3389, 5985, 5986] },
]);
const BY_PORT = new Map<number, PortClassInfo>();
for (const c of PORT_CLASSES) for (const p of c.ports) if (!BY_PORT.has(p)) BY_PORT.set(p, c);

export function portClass(port: number): PortClassInfo {
  return BY_PORT.get(port) ?? { cls: 'other', label: 'Other (request / response)', kind: 'sync', ports: [] };
}

// ---------------------------------------------------------------------------
// Matching and the review grid
// ---------------------------------------------------------------------------

export type EndpointKind = 'workload' | 'site' | 'external';
export interface ProposedEdge {
  /** A workload name, `site:<name>` or `external:<ip>`. */
  readonly from: string;
  readonly to: string;
  readonly fromKind: EndpointKind;
  readonly toKind: EndpointKind;
  readonly port: number;
  readonly protocol: string;
  readonly observations: number;
  readonly bytes?: number;
  readonly process?: string;
  /** The name the collector gave an external destination (reverse DNS). */
  readonly destName?: string;
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  readonly portClass: PortClass;
  readonly proposedKind: EdgeKind;
  readonly reason: string;
  /** Always false when proposed: the user ticks Accept. */
  readonly accept: boolean;
}

/** The review grid's columns (A.10.1). */
export const REVIEW_COLUMNS = Object.freeze(['From', 'To', 'Port', 'Proto', 'Observations', 'Process', 'Proposed kind', 'Accept'] as const);

/** IP → workload name, from `facts.ipAddresses` (both families). */
export function ipIndex(workloads: readonly Workload[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of workloads) {
    for (const ip of w.facts?.ipAddresses ?? []) {
      const c = canonicalIp(ip);
      if (c && !out.has(c)) out.set(c, w.name);
    }
  }
  return out;
}

export interface ProposeResult {
  readonly edges: readonly ProposedEdge[];
  /** Addresses seen that are neither a server nor a site. */
  readonly external: readonly { readonly ip: string; readonly name?: string; readonly observations: number }[];
  readonly findings: readonly Finding[];
}

/**
 * Turn flows into proposed edges. A flow between two unknown addresses is
 * dropped (it is not the plan's); a flow from a server to itself is dropped.
 * Edges are merged per (from, to, port, protocol).
 */
export function proposeEdges(flows: readonly FlowRecord[], plan: Pick<Plan, 'workloads' | 'requirements'>): ProposeResult {
  const byIp = ipIndex(plan.workloads);
  const sites = plan.requirements.sites;
  const resolve = (ip: string): { id: string; kind: EndpointKind } => {
    const w = byIp.get(ip);
    if (w) return { id: w, kind: 'workload' };
    const site = sites.find((s) => s.cidrs.some((c) => containsAny(c, ip)));
    if (site) return { id: `site:${site.name}`, kind: 'site' };
    return { id: `external:${ip}`, kind: 'external' };
  };
  const merged = new Map<string, ProposedEdge>();
  const external = new Map<string, { ip: string; name?: string; observations: number }>();
  let unrelated = 0;
  for (const f of flows) {
    const a = resolve(canonicalIp(f.sourceIp) || f.sourceIp);
    const b = resolve(canonicalIp(f.destIp) || f.destIp);
    if (a.kind !== 'workload' && b.kind !== 'workload') {
      unrelated += 1;
      continue;
    }
    if (a.kind === 'workload' && a.id === b.id) continue;
    for (const [end, ip, name] of [[a, a.id.slice('external:'.length), undefined], [b, b.id.slice('external:'.length), f.destName]] as const) {
      if (end.kind !== 'external') continue;
      const prev = external.get(ip) ?? { ip, observations: 0, ...(name ? { name } : {}) };
      external.set(ip, { ...prev, observations: prev.observations + f.observations });
    }
    const pc = portClass(f.destPort);
    const key = `${a.id}\u0000${b.id}\u0000${f.destPort}\u0000${f.protocol}`;
    const prev = merged.get(key);
    const process = [...new Set([...(prev?.process?.split(' ') ?? []), ...(f.process?.split(' ') ?? [])].filter(Boolean))].sort().join(' ');
    const bytes = prev?.bytes === undefined && f.bytes === undefined ? undefined : (prev?.bytes ?? 0) + (f.bytes ?? 0);
    const first = [prev?.firstSeen, f.firstSeen].filter((x): x is string => !!x).sort()[0];
    const last = [prev?.lastSeen, f.lastSeen].filter((x): x is string => !!x).sort().pop();
    const destName = prev?.destName ?? (b.kind === 'external' ? f.destName : undefined);
    merged.set(key, {
      from: a.id, to: b.id, fromKind: a.kind, toKind: b.kind,
      port: f.destPort, protocol: f.protocol,
      observations: (prev?.observations ?? 0) + f.observations,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(process ? { process } : {}),
      ...(destName ? { destName } : {}),
      ...(first ? { firstSeen: first } : {}),
      ...(last ? { lastSeen: last } : {}),
      portClass: pc.cls, proposedKind: pc.kind,
      reason: `${pc.label} port ${f.destPort}/${f.protocol}: ${pc.kind === 'sync' ? 'the caller waits on it' : 'queued or batch, the caller does not wait'}.`,
      accept: false,
    });
  }
  const edges = [...merged.values()].sort((x, y) => (x.from + x.to + String(x.port).padStart(5, '0')).localeCompare(y.from + y.to + String(y.port).padStart(5, '0')));
  const findings: Finding[] = [];
  if (unrelated > 0) findings.push(info('flows.unrelated', `${unrelated} flow(s) had neither end on a server in the plan and were left out.`));
  const ext = [...external.values()].sort((x, y) => x.ip.localeCompare(y.ip));
  if (ext.length > 0) {
    findings.push(info('flows.external', `${ext.length} address(es) are outside the plan and its sites; they are grouped as external. Check them against the partner and SaaS list.`));
  }
  const noIps = plan.workloads.filter((w) => (w.facts?.ipAddresses ?? []).length === 0).length;
  if (noIps > 0) findings.push(warning('flows.servers-without-ips', `${noIps} server(s) have no IP addresses in the plan, so flows cannot be matched to them.`, { remediation: 'Import the estate again with guest IPs (VMware Tools) or fill the IP facts.' }));
  return { edges, external: ext, findings };
}

/** The review grid's rows, as text, in REVIEW_COLUMNS order. */
export function reviewRows(edges: readonly ProposedEdge[]): string[][] {
  return edges.map((e) => [e.from, e.to, String(e.port), e.protocol, String(e.observations), e.process ?? '', e.proposedKind, e.accept ? 'yes' : 'no']);
}

/**
 * Write the accepted edges into the plan: a `DependencyEdge` each (the kind the
 * user chose, replacing an edge between the same two ends), and the target in
 * the source workload's "Depends on". Only edges whose `from` is a server in
 * the plan write anything; an inbound edge from a site or an external address
 * is for the security rules, not for "Depends on".
 */
export function acceptEdges(plan: Plan, accepted: readonly Pick<ProposedEdge, 'from' | 'to' | 'fromKind' | 'toKind' | 'proposedKind'>[]): Plan {
  const names = new Set(plan.workloads.map((w) => w.name));
  const edges = new Map<string, DependencyEdge>(plan.edges.map((e) => [`${e.from}\u0000${e.to}`, e]));
  const addTo = new Map<string, Set<string>>();
  for (const e of accepted) {
    if (e.fromKind !== 'workload' || !names.has(e.from)) continue;
    if (e.toKind === 'external') continue;
    edges.set(`${e.from}\u0000${e.to}`, { from: e.from, to: e.to, kind: e.proposedKind });
    const set = addTo.get(e.from) ?? new Set<string>();
    set.add(e.to);
    addTo.set(e.from, set);
  }
  if (addTo.size === 0) return plan;
  const workloads = plan.workloads.map((w) => {
    const add = addTo.get(w.name);
    if (!add) return w;
    const dependsOn = [...w.dependsOn];
    for (const t of add) if (!dependsOn.includes(t)) dependsOn.push(t);
    if (dependsOn.length === w.dependsOn.length) return w;
    const edited = w.edited?.includes('dependsOn') ? w.edited : [...(w.edited ?? []), 'dependsOn' as const];
    return { ...w, dependsOn, edited };
  });
  return { ...plan, workloads, edges: [...edges.values()] };
}

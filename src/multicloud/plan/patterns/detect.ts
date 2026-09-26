/**
 * Workload-type detection (addendum A.3.7).
 *
 * `detectType(workload, facts)` weighs five signals per candidate type
 * (`detect-data.ts`): installed software / services 0.6, listening ports 0.3,
 * name / annotation 0.2, appliance guest id / annotation 0.4, and the OS /
 * origin, which is decisive for non-x86. The outcome:
 * - confidence ≥ 0.7: detected (shown with a "?" until the user confirms);
 * - 0.4–0.7: "unknown — confirm", with the finding `type.confirm` listing the
 *   candidates and their evidence;
 * - under 0.4: the generic type by OS, with no finding.
 *
 * Nothing is inferred silently: `applyDetection` never changes a user-set
 * type, and the app's pattern is proposed (`proposePattern`), not set.
 */

import { info, type Finding } from '../../../core/findings.ts';
import { OS_CATALOG } from '../os.ts';
import type { AppPattern, ListeningPort, Workload, WorkloadDetection, WorkloadType } from '../types.ts';
import { patternsForType } from './catalog.ts';
import { CONFIRM_THRESHOLD, DETECTED_THRESHOLD, DETECTORS, SIGNAL_WEIGHTS, type Detector, type PortMatch, type Signal } from './detect-data.ts';

/** Facts beyond `Workload.facts` that a collector may give (all optional). */
export interface DetectionFacts {
  readonly software?: readonly string[];
  readonly services?: readonly string[];
  readonly listening?: readonly ListeningPort[];
  readonly guestOsRaw?: string;
  /** vSphere guest id (e.g. 'other3xLinux64Guest'). */
  readonly guestId?: string;
  /** vSphere annotation / notes, or the product name of an OVA. */
  readonly annotation?: string;
  /** SMB shares published. */
  readonly shares?: number;
  /** Concurrent RDP sessions seen. */
  readonly sessions?: number;
  /** Printers shared. */
  readonly sharedPrinters?: number;
}

export type DetectionOutcome = 'detected' | 'confirm' | 'generic';

export interface Detection {
  /** The detected type; `unknown` in the confirm band; the generic type by OS below it. */
  readonly type: WorkloadType;
  readonly confidence: number;
  readonly evidence: readonly string[];
  /** Every type with any evidence, best first. */
  readonly candidates: readonly { readonly type: WorkloadType; readonly confidence: number; readonly evidence: readonly string[] }[];
  readonly outcome: DetectionOutcome;
}

const round = (n: number): number => Math.round(n * 100) / 100;

function portMatches(m: PortMatch, port: number): boolean {
  if (typeof m === 'number') return m === port;
  if (typeof m === 'function') return m(port);
  return port >= m[0] && port <= m[1];
}

/** The non-x86 type from the origin (decisive), if any. */
function fromOrigin(w: Workload, osText: string): WorkloadType | undefined {
  switch (w.origin) {
    case 'power':
      // Linux on Power is scored like any Linux server.
      if (/linux/i.test(osText)) return undefined;
      return /\b(ibm ?i|os\/?400|i5\/os)\b/i.test(osText) ? 'ibm-i' : 'aix';
    case 'sparc': return /linux/i.test(osText) ? undefined : 'solaris-sparc';
    case 'itanium': return /openvms/i.test(osText) ? undefined : 'hp-ux';
    case 'pa-risc': return 'hp-ux';
    case 'mainframe': return 'mainframe';
    default: break;
  }
  if (/solaris/i.test(osText)) return /sparc/i.test(osText) ? 'solaris-sparc' : 'solaris-x86';
  if (/\baix\b/i.test(osText)) return 'aix';
  if (/hp-?ux/i.test(osText)) return 'hp-ux';
  if (/z\/os|os\/390/i.test(osText)) return 'mainframe';
  return undefined;
}

function genericFor(w: Workload): WorkloadType {
  return OS_CATALOG[w.os]?.kind === 'windows' ? 'generic-windows' : 'generic-linux';
}

function score(d: Detector, w: Workload, f: DetectionFacts): { confidence: number; evidence: string[] } {
  const evidence: string[] = [];
  const hit = new Set<Signal>();
  if (d.os && OS_CATALOG[w.os]?.kind !== d.os) return { confidence: 0, evidence };
  const software = [...(w.facts?.software ?? []), ...(f.software ?? [])];
  const ports = [...(w.facts?.listening ?? []), ...(f.listening ?? [])];
  // Listening process names count as services (a collector may see the process, not the service).
  const services = [...(w.facts?.services ?? []), ...(f.services ?? []), ...ports.map((p) => p.process ?? '').filter((p) => p !== '')];
  const matched = d.ports ? ports.filter((p) => d.ports!.some((m) => portMatches(m, p.port))).map((p) => p.port) : [];

  const softwareOk = d.softwareNeed === 'sharedPrinters>0' ? (f.sharedPrinters ?? 0) > 0
    : d.softwareNeed === 'shares>10' ? (f.shares ?? 0) > 10
      : d.softwareNeed === 'ports' ? matched.length > 0 : true;
  if (softwareOk) {
    const sw = software.find((s) => d.software?.some((r) => r.test(s)));
    if (sw) { hit.add('software'); evidence.push(`software "${sw}"`); }
    const svc = services.find((s) => d.services?.some((r) => r.test(s)));
    if (svc) { hit.add('software'); evidence.push(`service "${svc}"`); }
  }

  if (d.ports) {
    const extraOk = d.portsNeed === 'sessions>2' ? (f.sessions ?? 0) > 2 : d.portsNeed === 'shares>10' ? (f.shares ?? 0) > 10
      : d.softwareNeed === 'sharedPrinters>0' ? (f.sharedPrinters ?? 0) > 0 : true;
    if (matched.length > 0 && extraOk) {
      hit.add('ports');
      evidence.push(`listening on ${[...new Set(matched)].sort((a, b) => a - b).join(', ')}${d.portsNeed ? ` (${d.portsNeed})` : ''}`);
    }
  }
  if (d.type === 'print' && (f.sharedPrinters ?? 0) > 0 && !hit.has('ports')) {
    hit.add('ports');
    evidence.push(`${f.sharedPrinters} shared printer(s)`);
  }

  if (d.name && (d.name.test(w.name) || (f.annotation !== undefined && d.name.test(f.annotation)))) {
    hit.add('name');
    evidence.push(`name "${d.name.test(w.name) ? w.name : f.annotation}"`);
  }
  const applianceText = [f.guestId, f.annotation, f.guestOsRaw ?? w.facts?.guestOsRaw].filter((x): x is string => !!x).join(' | ');
  if (d.appliance && d.appliance.test(applianceText)) {
    hit.add('appliance');
    evidence.push(`appliance "${applianceText}"`);
  }
  let confidence = 0;
  for (const s of hit) confidence += SIGNAL_WEIGHTS[s];
  return { confidence: round(Math.min(1, confidence)), evidence };
}

/** Detect the workload's type from its facts (and any extra facts a collector gave). */
export function detectType(w: Workload, facts: DetectionFacts = {}): Detection {
  const osText = [facts.guestOsRaw, w.facts?.guestOsRaw].filter(Boolean).join(' ');
  const decisive = fromOrigin(w, osText);
  if (decisive) {
    const evidence = [w.origin && w.origin !== 'vsphere' ? `origin ${w.origin}` : `OS "${osText}"`];
    return { type: decisive, confidence: 1, evidence, candidates: [{ type: decisive, confidence: 1, evidence }], outcome: 'detected' };
  }
  const candidates = DETECTORS
    .map((d) => ({ type: d.type, ...score(d, w, facts) }))
    .filter((c) => c.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || DETECTORS.findIndex((d) => d.type === a.type) - DETECTORS.findIndex((d) => d.type === b.type));
  const best = candidates[0];
  if (best && best.confidence >= DETECTED_THRESHOLD) return { type: best.type, confidence: best.confidence, evidence: best.evidence, candidates, outcome: 'detected' };
  if (best && best.confidence >= CONFIRM_THRESHOLD) return { type: 'unknown', confidence: best.confidence, evidence: best.evidence, candidates, outcome: 'confirm' };
  return { type: genericFor(w), confidence: best?.confidence ?? 0, evidence: best?.evidence ?? [], candidates, outcome: 'generic' };
}

/** The `type.confirm` finding for a detection in the confirm band. */
export function confirmFinding(w: Workload, d: Detection): Finding | undefined {
  if (d.outcome !== 'confirm') return undefined;
  const list = d.candidates.filter((c) => c.confidence >= CONFIRM_THRESHOLD).map((c) => `${c.type} ${c.confidence} (${c.evidence.join('; ')})`);
  return info('type.confirm', `${w.name}: unknown — confirm. Candidates: ${list.join(' · ')}.`, {
    path: `workloads.${w.id}.workloadType`,
    remediation: 'Set the Type cell to the right workload type (or generic).',
  });
}

/**
 * Record a detection on a workload. Writes `facts.detection` always; sets
 * `workloadType` (with `typeConfirmed: false`) only when the user has not set
 * it (it is not in `edited`, and not confirmed).
 */
export function applyDetection(w: Workload, d: Detection): { workload: Workload; findings: Finding[] } {
  const detection: WorkloadDetection = { type: d.type, confidence: d.confidence, evidence: d.evidence };
  const userSet = (w.edited ?? []).includes('workloadType') || w.typeConfirmed === true;
  const facts = { ...(w.facts ?? {}), detection };
  const workload: Workload = userSet ? { ...w, facts } : { ...w, facts, workloadType: d.type, typeConfirmed: false };
  const f = userSet ? undefined : confirmFinding(w, d);
  return { workload, findings: f ? [f] : [] };
}

/** Detect every workload of a plan's rows; `extra` gives collector facts by workload name. */
export function detectWorkloads(workloads: readonly Workload[], extra: Readonly<Record<string, DetectionFacts>> = {}): { workloads: Workload[]; findings: Finding[] } {
  const out: Workload[] = [];
  const findings: Finding[] = [];
  for (const w of workloads) {
    const r = applyDetection(w, detectType(w, extra[w.name] ?? {}));
    out.push(r.workload);
    findings.push(...r.findings);
  }
  return { workloads: out, findings };
}

/** A type counts toward the proposal when confirmed, set by the user, or detected. */
function typeForProposal(w: Workload): WorkloadType | undefined {
  const t = w.workloadType;
  if (t && t !== 'unknown') return t;
  const d = w.facts?.detection;
  return d && d.confidence >= DETECTED_THRESHOLD ? d.type : undefined;
}

const TYPE_PREFERENCE: Readonly<Partial<Record<WorkloadType, AppPattern>>> = {
  'sap-hana': 'sap-s4hana', 'sap-netweaver': 'sap-ecc-anydb', 'sap-java': 'sap-netweaver-java',
  'citrix-vda': 'citrix-vad', 'citrix-infra': 'citrix-vad', 'rds-host': 'rds', 'nas-gateway': 'nas',
  'k8s-node': 'kubernetes', 'openshift-node': 'openshift',
};
const IGNORED: ReadonlySet<WorkloadType> = new Set(['generic-windows', 'generic-linux', 'db-host', 'unknown']);

/**
 * The app's pattern proposed from its dominant type (a dropdown default, not
 * set): the most frequent non-generic type among its workloads, weighting
 * confirmed ones double. SAP HANA with NetWeaver proposes S/4HANA; NetWeaver
 * without HANA proposes ECC on anyDB. Undefined = generic.
 */
export function proposePattern(workloads: readonly Workload[]): AppPattern | undefined {
  const counts = new Map<WorkloadType, number>();
  for (const w of workloads) {
    const t = typeForProposal(w);
    if (!t || IGNORED.has(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + (w.typeConfirmed || (w.edited ?? []).includes('workloadType') ? 2 : 1));
  }
  if (counts.has('sap-hana')) return 'sap-s4hana';
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return undefined;
  return TYPE_PREFERENCE[best[0]] ?? patternsForType(best[0])[0];
}

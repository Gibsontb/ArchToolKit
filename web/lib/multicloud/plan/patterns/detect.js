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

import { info,              } from '../../../core/findings.js';
import { OS_CATALOG } from '../os.js';
                                                                                                        
import { patternsForType } from './catalog.js';
import { CONFIRM_THRESHOLD, DETECTED_THRESHOLD, DETECTORS, SIGNAL_WEIGHTS,                                            } from './detect-data.js';

/** Facts beyond `Workload.facts` that a collector may give (all optional). */
                                 
                                        
                                        
                                                
                               
                                                       
                            
                                                                   
                               
                              
                           
                                      
                             
                         
                                   
 

                                                                  

                            
                                                                                           
                              
                              
                                       
                                                  
                                                                                                                                     
                                     
 

const round = (n        )         => Math.round(n * 100) / 100;

function portMatches(m           , port        )          {
  if (typeof m === 'number') return m === port;
  if (typeof m === 'function') return m(port);
  return port >= m[0] && port <= m[1];
}

/** The non-x86 type from the origin (decisive), if any. */
function fromOrigin(w          , osText        )                           {
  switch (w.origin) {
    case 'power': return /\b(ibm ?i|os\/?400|i5\/os)\b/i.test(osText) ? 'ibm-i' : 'aix';
    case 'sparc': return 'solaris-sparc';
    case 'itanium':
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

function genericFor(w          )               {
  return OS_CATALOG[w.os]?.kind === 'windows' ? 'generic-windows' : 'generic-linux';
}

function score(d          , w          , f                )                                             {
  const evidence           = [];
  const hit = new Set        ();
  const software = [...(w.facts?.software ?? []), ...(f.software ?? [])];
  const services = [...(w.facts?.services ?? []), ...(f.services ?? [])];
  const ports = [...(w.facts?.listening ?? []), ...(f.listening ?? [])];

  const sw = software.find((s) => d.software?.some((r) => r.test(s)));
  if (sw) { hit.add('software'); evidence.push(`software "${sw}"`); }
  const svc = services.find((s) => d.services?.some((r) => r.test(s)));
  if (svc) { hit.add('software'); evidence.push(`service "${svc}"`); }

  if (d.ports) {
    const matched = ports.filter((p) => d.ports .some((m) => portMatches(m, p.port))).map((p) => p.port);
    const extraOk = d.portsNeed === 'sessions>2' ? (f.sessions ?? 0) > 2 : d.portsNeed === 'shares>10' ? (f.shares ?? 0) > 10 : true;
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
  const applianceText = [f.guestId, f.annotation, f.guestOsRaw ?? w.facts?.guestOsRaw].filter((x)              => !!x).join(' | ');
  if (d.appliance && d.appliance.test(applianceText)) {
    hit.add('appliance');
    evidence.push(`appliance "${applianceText}"`);
  }
  let confidence = 0;
  for (const s of hit) confidence += SIGNAL_WEIGHTS[s];
  return { confidence: round(Math.min(1, confidence)), evidence };
}

/** Detect the workload's type from its facts (and any extra facts a collector gave). */
export function detectType(w          , facts                 = {})            {
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
export function confirmFinding(w          , d           )                      {
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
export function applyDetection(w          , d           )                                              {
  const detection                    = { type: d.type, confidence: d.confidence, evidence: d.evidence };
  const userSet = (w.edited ?? []).includes('workloadType') || w.typeConfirmed === true;
  const facts = { ...(w.facts ?? {}), detection };
  const workload           = userSet ? { ...w, facts } : { ...w, facts, workloadType: d.type, typeConfirmed: false };
  const f = userSet ? undefined : confirmFinding(w, d);
  return { workload, findings: f ? [f] : [] };
}

/** Detect every workload of a plan's rows; `extra` gives collector facts by workload name. */
export function detectWorkloads(workloads                     , extra                                           = {})                                                 {
  const out             = [];
  const findings            = [];
  for (const w of workloads) {
    const r = applyDetection(w, detectType(w, extra[w.name] ?? {}));
    out.push(r.workload);
    findings.push(...r.findings);
  }
  return { workloads: out, findings };
}

/** A type counts toward the proposal when confirmed, set by the user, or detected. */
function typeForProposal(w          )                           {
  const t = w.workloadType;
  if (t && t !== 'unknown') return t;
  const d = w.facts?.detection;
  return d && d.confidence >= DETECTED_THRESHOLD ? d.type : undefined;
}

const TYPE_PREFERENCE                                                      = {
  'sap-hana': 'sap-s4hana', 'sap-netweaver': 'sap-ecc-anydb', 'sap-java': 'sap-netweaver-java',
  'citrix-vda': 'citrix-vad', 'citrix-infra': 'citrix-vad', 'rds-host': 'rds', 'nas-gateway': 'nas',
  'k8s-node': 'kubernetes', 'openshift-node': 'openshift',
};
const IGNORED                            = new Set(['generic-windows', 'generic-linux', 'db-host', 'unknown']);

/**
 * The app's pattern proposed from its dominant type (a dropdown default, not
 * set): the most frequent non-generic type among its workloads, weighting
 * confirmed ones double. SAP HANA with NetWeaver proposes S/4HANA; NetWeaver
 * without HANA proposes ECC on anyDB. Undefined = generic.
 */
export function proposePattern(workloads                     )                         {
  const counts = new Map                      ();
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

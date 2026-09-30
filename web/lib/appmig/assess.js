/**
 * The Stage 1 assessment: what the answers say, worked out the way the two
 * original tools did, and reported rather than decided.
 *
 *   - Readiness score (0–100): the evaluator's six weighted ratings.
 *   - Hard gates: the evaluator's order (Retire, then Repurchase, then Retain),
 *     which settle the route before the score does.
 *   - Suggested route: the gates, else the evaluator's score bands.
 *   - Risk: the evaluator's points for criticality, RTO, RPO, integrations
 *     and compliance.
 *   - Signals: the wizard's warnings, section by section.
 *
 * The user picks the route; the suggestion is only shown beside it.
 */

import { FIELDS, RATINGS,                        } from './sections.js';
import {
  CARDS,
  SCREENS,
  continuityProblems,
  continuityProgress,
  continuitySignals,
  identityProblems,
  identityProgress,
  identitySignals,
  loadProblems,
  loadProgress,
  loadSignals,
                 
              
} from './model.js';

export const ROUTES = [
  { value: 'retire', label: 'Retire (decommission)' },
  { value: 'retain', label: 'Retain (stay where it is)' },
  { value: 'rehost', label: 'Rehost (lift and shift)' },
  { value: 'relocate', label: 'Relocate (VMware Cloud Foundation in the cloud)' },
  { value: 'replatform', label: 'Replatform (minor cloud optimisations)' },
  { value: 'refactor', label: 'Refactor / modernise' },
  { value: 'repurchase', label: 'Repurchase (SaaS)' },
]         ;

/** Where a section's answers live: the first three in their own typed records, the rest in `sections`. */
export function answersFor(app           , card        )          {
  if (card === 'identity') return app.identity                      ;
  if (card === 'continuity') return app.continuity                      ;
  if (card === 'load') return app.load                      ;
  const existing = app.sections[card];
  if (existing) return existing           ;
  const fresh          = {};
  app.sections[card] = fresh;
  return fresh;
}

const str = (a         , k        )         => (typeof a[k] === 'string' ? (a[k]          ) : '');
const list = (a         , k        )           => (Array.isArray(a[k]) ? (a[k]             ).filter((x)              => typeof x === 'string') : []);
const rows = (a         , k        )        => (Array.isArray(a[k]) ? (a[k]             ).filter((x)           => typeof x === 'object' && x !== null) : []);

/** Answered and asked, for any section, counting only the questions currently shown. */
export function progress(app           , card        )                                   {
  if (card === 'identity') return identityProgress(app.identity);
  if (card === 'continuity') return continuityProgress(app.continuity);
  if (card === 'load') return loadProgress(app.load);
  const a = answersFor(app, card);
  const shown = FIELDS[card].filter((f) => !f.showIf || f.showIf(a));
  const answered = shown.filter((f) => {
    const v = a[f.key];
    return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim() !== '';
  }).length;
  return { answered, of: shown.length };
}

/** What a section still needs. */
export function problems(app           , card        , all                      )           {
  if (card === 'identity') return identityProblems(app, all).map((p) => p.message);
  if (card === 'continuity') return continuityProblems(app.continuity);
  if (card === 'load') return loadProblems(app.load);
  const a = answersFor(app, card);
  const out           = [];
  for (const f of FIELDS[card]) {
    if (f.showIf && !f.showIf(a)) continue;
    if (f.required && !str(a, f.key).trim()) out.push(`${f.label} is needed.`);
    if (f.kind === 'rows')
      rows(a, f.key).forEach((row, n) => {
        for (const c of f.columns ?? [])
          if (c.numeric && (row[c.key] ?? '').trim() && !/^\d+(\.\d+)?$/.test((row[c.key] ?? '').replace(/,/g, '')))
            out.push(`${f.label}, row ${n + 1}: ${c.label} should be a number.`);
      });
  }
  return out;
}

// --- Score, gates, risk and route ---------------------------------------------

/** The evaluator's readiness score: each rating 1–5 as 0–100, inverted where high is bad, weighted. Null until all six are rated. */
export function readiness(app           )                {
  const a = answersFor(app, 'ratings');
  let total = 0;
  let weights = 0;
  for (const r of RATINGS) {
    const v = Number(str(a, r.key));
    if (!v) return null;
    const pct = ((v - 1) / 4) * 100;
    total += (r.inverted ? 100 - pct : pct) * r.weight;
    weights += r.weight;
  }
  return Math.round(total / weights);
}

                             
                         
                           
 

/** The gates first, in the evaluator's order; then the score bands. */
export function suggestedRoute(app           )                    {
  const gates = new Set(list(answersFor(app, 'gates'), 'gates'));
  if (gates.has('obsolete')) return { route: 'retire', because: 'It is marked obsolete / no longer used.' };
  if (gates.has('saas') && !gates.has('mustStay')) return { route: 'repurchase', because: 'A vendor SaaS replacement exists.' };
  if (gates.has('mustStay')) return { route: 'retain', because: 'Policy says it must stay on-prem.' };
  if (gates.has('hardware')) return { route: 'retain', because: 'It is bound to hardware or an appliance.' };
  if (gates.has('mainframe')) return { route: 'retain', because: 'It depends on a mainframe.' };
  const score = readiness(app);
  if (score === null) return null;
  const band = score >= 80 ? 'refactor' : score >= 60 ? 'replatform' : score >= 40 ? 'rehost' : score >= 20 ? 'retain' : 'retire';
  return { route: band, because: `Readiness score ${score}: the evaluator's bands are 80+ Refactor, 60+ Replatform, 40+ Rehost, 20+ Retain, below that Retire.` };
}

                       
                                            
                          
                             
 

/** The evaluator's risk points: High at 8+, Medium at 5+. */
export function risk(app           )       {
  const reasons           = [];
  let points = 0;
  const add = (n        , why        ) => {
    if (n > 0) {
      points += n;
      reasons.push(`${why} (+${n})`);
    }
  };
  const c = app.continuity;
  add({ tier0: 3, tier1: 2, tier2: 1 }[c.criticality] ?? 0, 'Criticality');
  add({ mins: 2, hour: 2, 'few-hours': 1 }[c.rto] ?? 0, 'Tight RTO');
  add({ zero: 2, '15min': 2, hour: 1 }[c.rpo] ?? 0, 'Tight RPO');
  const integrations = rows(answersFor(app, 'connections'), 'integrations').length;
  add(integrations >= 20 ? 2 : integrations >= 10 ? 1 : 0, `${integrations} integrations`);
  const compliance = list(answersFor(app, 'security'), 'compliance');
  add(compliance.some((x) => x.startsWith('fedramp') || x === 'itar' || x === 'cjis') ? 2 : compliance.length > 0 ? 1 : 0, 'Compliance scope');
  return { level: points >= 8 ? 'High' : points >= 5 ? 'Medium' : 'Low', points, reasons };
}

// --- Signals --------------------------------------------------------------------

/** What every section's answers mean, in the order of the sections. Facts, not decisions. */
export function signals(app           )                                     {
  const what = answersFor(app, 'what');
  const servers = rows(answersFor(app, 'servers'), 'servers');
  const data = answersFor(app, 'data');
  const conn = answersFor(app, 'connections');
  const sec = answersFor(app, 'security');
  const net = answersFor(app, 'network');
  const gates = new Set(list(answersFor(app, 'gates'), 'gates'));
  const ops = answersFor(app, 'operations');

  const byCard                           = {
    identity: identitySignals(app.identity),
    continuity: continuitySignals(app.continuity),
    load: loadSignals(app.load),
    what: [],
    servers: [],
    data: [],
    connections: [],
    security: [],
    network: [],
    gates: [],
    ratings: [],
    operations: [],
  };

  const skills = list(what, 'skills');
  const arch = str(what, 'architecture');
  if (arch === 'Microservices (containers)' && skills.includes('containers')) byCard.what.push('Containers and a team that knows them: a managed Kubernetes or container service is the natural target.');
  if (arch === 'Legacy app / VM-centric' || arch === 'Monolith (single deployable)') byCard.what.push('A monolith or VM-centric app: Rehost or Replatform first; Refactor is a separate, larger project.');
  if (str(what, 'traffic') === 'spiky' && (skills.includes('serverless') || skills.includes('paas'))) byCard.what.push('Spiky traffic and a PaaS / serverless team: scale-to-demand platforms fit well.');
  if (str(what, 'sessions') === 'sticky') byCard.what.push('Sticky in-memory sessions: scaling out needs session affinity on the load balancer, or moving sessions to a shared cache.');
  if (str(what, 'state') === 'disk') byCard.what.push('State on local disk: it needs persistent block storage, and cannot simply scale out.');
  if (str(what, 'latency') === 'strict') byCard.what.push('Strict latency: keep it close to its users and to what it calls, in the same region.');
  const old = rows(what, 'languages').filter((r) => ['VB6', 'PowerBuilder', 'Delphi', 'ColdFusion', 'COBOL', 'ASP.NET WebForms', '.NET Framework', 'Java 8'].includes(r['language'] ?? ''));
  if (old.length > 0) byCard.what.push(`${old.map((r) => r['language']).join(', ')}: older runtimes limit the managed platforms it can run on; Rehost is usually the first step.`);
  if (str(what, 'opsMaturity') === 'basic') byCard.what.push('Basic operations: prefer managed services, which take patching and failover off the team.');

  if (servers.length > 0) {
    const vcpu = servers.reduce((n, r) => n + (Number(r['vcpu']) || 0), 0);
    const ram = servers.reduce((n, r) => n + (Number(r['ramGb']) || 0), 0);
    const disk = servers.reduce((n, r) => n + (Number(r['diskGb']) || 0), 0);
    byCard.servers.push(`${servers.length} server${servers.length === 1 ? '' : 's'}: ${vcpu} vCPU, ${ram} GB RAM, ${disk} GB disk in all.`);
    const eol = servers.filter((r) => /2008|2012|RHEL 6|CentOS|Ubuntu 16|SLES 12/.test(r['os'] ?? ''));
    if (eol.length > 0) byCard.servers.push(`${eol.length} on an operating system past or near end of support: upgrade before or during the move, or budget for extended support.`);
    const unix = servers.filter((r) => /AIX|HP-UX|Solaris|z\/OS/.test(r['os'] ?? ''));
    if (unix.length > 0) byCard.servers.push(`${unix.length} on AIX, HP-UX, Solaris or z/OS: these do not run on cloud x86; they need a replatform, a specialist host, or to stay.`);
    const idle = servers.filter((r) => r['cpuPeak'] && Number(r['cpuPeak']) < 20);
    if (idle.length > 0) byCard.servers.push(`${idle.length} peak under 20% CPU: size them down at the target.`);
    if (servers.some((r) => r['cluster'] && r['cluster'] !== 'None')) byCard.servers.push('Clustered servers: the cluster type decides the target (shared disks and RAC need specific services).');
  }

  const dbs = rows(data, 'databases');
  if (dbs.some((d) => /Oracle/.test(d['engine'] ?? ''))) byCard.data.push('Oracle: licensing and RAC decide the target (managed Oracle, Oracle Database@, or self-managed on VMs).');
  if (dbs.some((d) => /SQL Server/.test(d['engine'] ?? '') && (d['features'] ?? '').trim())) byCard.data.push('SQL Server with special features: check each against the managed service before choosing it.');
  const regulated = ['regulated', 'ps-l4', 'ps-l5', 'ps-l6'].includes(str(data, 'sensitivity'));
  if (regulated) byCard.data.push('Regulated or public-sector data: government or sovereign regions, private endpoints and customer-managed keys.');
  if (['heavy', 'very-heavy'].includes(str(data, 'ingest')) || ['l', 'xl'].includes(str(data, 'volume'))) byCard.data.push('Large data or heavy change: plan an initial bulk copy (or a transfer appliance) and continuous sync up to cutover.');
  if (['long', 'very-long'].includes(str(data, 'retention'))) byCard.data.push('Long retention: tier old data to cool or archive storage.');

  const integrations = rows(conn, 'integrations');
  const stay = integrations.filter((r) => r['onPremOnly'] === 'yes');
  const fast = integrations.filter((r) => r['latencySensitive'] === 'yes');
  if (stay.length > 0) byCard.connections.push(`${stay.length} integration${stay.length === 1 ? '' : 's'} stay on-prem: they need hybrid connectivity (VPN or a private link) sized for their traffic.`);
  if (fast.length > 0) byCard.connections.push(`${fast.length} latency-sensitive integration${fast.length === 1 ? '' : 's'}: move those systems in the same wave, or keep the link short.`);
  if (['Active Directory (AD)', 'Kerberos', 'LDAP'].includes(str(conn, 'signIn'))) byCard.connections.push('AD, Kerberos or LDAP sign-in: domain controllers (or a managed directory) have to be reachable from the target.');

  const compliance = list(sec, 'compliance');
  if (compliance.some((x) => x.startsWith('fedramp') || x === 'itar' || x === 'cjis') || str(sec, 'sovereignty') === 'yes')
    byCard.security.push('FedRAMP, ITAR, CJIS or sovereignty: the target has to be a government or sovereign region with the matching authorisation.');
  if (regulated && str(sec, 'baseline') === 'minimal') byCard.security.push('Regulated data on a minimal baseline: raise the baseline as part of the move.');
  if (regulated && str(sec, 'secops') === 'basic') byCard.security.push('Regulated data with basic logging: central logging and alerting are needed.');
  if (str(sec, 'protection') === 'at-rest') byCard.security.push('At-rest encryption only: add TLS for data in transit.');
  if (str(sec, 'secrets') === 'basic') byCard.security.push('Secrets in configuration: move them to a secrets manager at cutover.');

  if (str(net, 'exposure') === 'internet') byCard.network.push('Internet-facing: it needs a WAF and DDoS protection in front of it at the target.');
  if (str(net, 'perimeter') === 'legacy-fw') byCard.network.push('A legacy firewall in the path: its rules have to be rebuilt as cloud security rules.');
  if (['2', '2-active', '3plus'].includes(str(net, 'regions'))) byCard.network.push('More than one region: global traffic management and data replication between regions.');
  if (str(net, 'loadBalancer') && str(net, 'loadBalancer') !== 'None') byCard.network.push(`${str(net, 'loadBalancer')} today: its virtual servers, health checks and certificates have to be rebuilt at the target.`);

  if (gates.has('licence')) byCard.gates.push('Licence tied to hardware or cores: check what the licence allows in the cloud before choosing instance sizes.');
  if (gates.has('vendorNoCloud')) byCard.gates.push('The vendor will not support it in the cloud: Rehost keeps it unchanged, but support is at your risk; Retain or Repurchase may be safer.');
  if (gates.has('hardcoded')) byCard.gates.push('Hard-coded IPs or hostnames: keep the addresses, or change the configuration before cutover.');

  const score = readiness(app);
  if (score !== null) byCard.ratings.push(`Readiness score ${score} of 100.`);

  if (str(ops, 'backup') === 'None') byCard.operations.push('No backup today: the target needs one from day one.');
  if (str(ops, 'patching') === 'Not patched') byCard.operations.push('Not patched: expect findings on the first scan at the target.');
  if (str(ops, 'monitoring') === 'None') byCard.operations.push('No monitoring today: set it up before cutover so there is a baseline to compare against.');

  // In the order the steps ask them.
  const order = SCREENS.flatMap((s) => [...s.cards]);
  return order.map((id) => ({ card: CARDS.find((c) => c.id === id)?.title ?? id, says: byCard[id] })).filter((x) => x.says.length > 0);
}

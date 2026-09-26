/**
 * Coupling remediation (addendum A.2.9): each resolved reference becomes an
 * action by rule, with a severity, a due date and, where it applies, a
 * proposed dependency edge, a jobs-inventory row or an external-link
 * candidate. Nothing is applied: edges are proposals (Accept / Ignore, as
 * with flows), and "Create tasks" turns actions into item-linked RAID issues.
 *
 * | Reference                                            | Action                                  | Severity |
 * |------------------------------------------------------|-----------------------------------------|----------|
 * | IP literal of a server that re-IPs in its wave       | replace with FQDN before cutover        | blocker for that wave |
 * | hosts entry                                          | remove; rely on DNS                     | warning  |
 * | UNC, share or connection string to another app       | suggest a dependency edge               | info     |
 * | licence bound to a MAC / host id                     | request a re-host licence (due T−30)    | warning  |
 * | certificate binding                                  | reissue or rebind (SANs, expiry)        | error when it expires in the wave window |
 * | SMTP relay                                           | point at the target relay               | warning  |
 * | service account                                      | exists in target AD / use gMSA          | warning  |
 * | scheduled job                                        | added to the jobs inventory             | info     |
 * | SNMP / NTP / time zone                               | reconfigure to the target sources       | info     |
 */

import { info,              } from '../../../core/findings.js';
import { itemId } from '../options.js';
                                                                                                                                           
import { isIpv4, isIpv6,                                                                            } from './import.js';

                                                                        
                                                         

                                                                                                  

                                  
                                          
                                                                       
                                                                     
                                                                                                          
                                                      
                                                                                    
                       
                                                                                         
                                       
 

                         
                       
                             
                        
                            
                           
                          
                       
                                                                
                          
 

                                    
                              
                            
                       
                          
                            
 

                                 
                                            
                      
                        
                          
                       
                                      
                         
                
                         
                            
                              
                          
                                      
                                            
                         
                  
                        
                                  
                                                                       
                                    
                                 
                        
                                        
 

export const COUPLING_GRID_COLUMNS = Object.freeze(['Server', 'Category', 'Where', 'Value (masked)', 'Points to', 'Resolves to', 'Action', 'Due', 'Status']         );

/** Days before the wave start: G1 Ready is T−5; a re-host licence has the vendor's lead time, T−30. */
export const DUE_BEFORE_WAVE = 5;
export const LICENCE_LEAD_DAYS = 30;
export const RELAY_TEXT = 'the target relay (Amazon SES, Azure Communication Services, or the landing zone\'s own relay)';

export function addDays(iso        , days        )         {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const today = ()         => new Date().toISOString().slice(0, 10);

/** RFC 1918, shared address space (RFC 6598), IPv6 ULA; and bare host names (no dot) are internal too. */
export function isPrivate(point        )          {
  if (isIpv4(point)) return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(point);
  if (isIpv6(point)) return /^f[cd]/i.test(point);
  return !point.includes('.');
}

function describe(res            )         {
  if (res.kind === 'server') return `server ${res.name}${res.app ? ` (app ${res.app})` : ''}`;
  if (res.kind === 'site') return res.name ?? 'site';
  return 'external';
}

const JOB_TARGET                                   = {
  cron: 'ansible.builtin.cron on the target host',
  'systemd-timer': 'a systemd timer on the target host (ansible.builtin.copy + ansible.builtin.systemd_service)',
  'task-scheduler': 'Register-ScheduledTask through ansible.windows.win_powershell on the target host',
};

/**
 * Actions for resolved references. Self references were dropped on import;
 * a reference with several points gives one action with the worst severity.
 */
export function couplingActions(resolved                        , ctx                 )                                                                                                                             {
  const byName = new Map(ctx.workloads.map((w) => [w.name.toLowerCase(), w]));
  const strategyOf = ctx.ipStrategyOf ?? ((w          )             => w.ipStrategy ?? 're-ip');
  const on = ctx.on ?? today();
  const actions                   = [];
  const jobs           = [];
  const edges = new Map                        ();
  const external                      = [];

  for (const { ref, resolutions } of resolved) {
    const self = byName.get(ref.server.toLowerCase());
    const app = self?.app ?? '';
    const selfWave = ctx.waveOf?.(ref.server);
    const servers = resolutions.filter((r) => r.kind === 'server' && r.name?.toLowerCase() !== ref.server.toLowerCase());
    const base = {
      id: `${ref.server}|${ref.category}|${ref.where}`,
      server: ref.server, app, category: ref.category, where: ref.where, value: ref.value,
      pointsTo: ref.points.join(', '),
      resolvesTo: resolutions.length > 0 ? [...new Set(resolutions.map(describe))].join('; ') : (ref.category === 'scheduled-job' || ref.category === 'service-account' ? 'this server' : '—'),
      status: 'open'         ,
      items: [itemId('workload', ref.server), ...servers.map((s) => itemId('workload', s.name ))],
    };
    const dueFor = (w                        , lead = DUE_BEFORE_WAVE)                                  =>
      w ? { wave: w.n, ...(w.start ? { due: addDays(w.start, -lead) } : {}) } : {};
    const push = (rule        , action        , severity                  , extra                          = {})       => {
      // One reference can give several actions (a hosts line is also a blocker): the rule, and the edge's target, keep ids unique.
      const id = `${base.id}|${rule}${extra.edge ? `|${extra.edge.to}` : ''}`;
      actions.push({ ...base, rule, action, severity, ...dueFor(selfWave), ...extra, id });
    };

    // 1. IP literals of servers that re-IP: a blocker for the wave the address changes in.
    const reIp = servers.filter((r) => (isIpv4(r.point) || isIpv6(r.point)) && (() => { const w = byName.get(r.name .toLowerCase()); return !!w && strategyOf(w) === 're-ip'; })());
    const literalCategories                              = ['hosts', 'config', 'connection-string', 'smtp', 'share', 'printer', 'snmp', 'time', 'licence'];
    if (reIp.length > 0 && literalCategories.includes(ref.category)) {
      const waves = reIp.map((r) => ctx.waveOf?.(r.name )).filter((w)                  => !!w).sort((a, b) => a.n - b.n);
      push('coupling.ip-literal-reip', `Replace ${reIp.map((r) => r.point).join(', ')} with the FQDN before cutover: ${reIp.map((r) => r.name).join(', ')} gets a new address.`, 'blocker', dueFor(waves[0] ?? selfWave));
    }

    switch (ref.category) {
      case 'hosts':
        push('coupling.hosts-entry', 'Remove the hosts entry; rely on DNS.', 'warning');
        break;
      case 'licence':
        push('coupling.licence-binding', `Request a re-host licence from the vendor (${ref.binding === 'mac' ? `bound to MAC ${ref.mac ?? ''}` : 'bound to a host id'}); allow the vendor's lead time.`, 'warning', dueFor(selfWave, LICENCE_LEAD_DAYS));
        break;
      case 'certificate': {
        const end = selfWave?.end ?? selfWave?.start;
        const expiresInWindow = !!ref.notAfter && ref.notAfter <= (end ?? on);
        const sans = ref.sans && ref.sans.length > 0 ? ` SANs: ${ref.sans.join(', ')}.` : '';
        push('coupling.certificate', `Reissue or rebind the certificate ${ref.subject ?? ref.value}${ref.notAfter ? ` (expires ${ref.notAfter})` : ''}.${sans}`, expiresInWindow ? 'error' : 'warning');
        break;
      }
      case 'smtp':
        push('coupling.smtp-relay', `Point the mail settings at ${RELAY_TEXT}.`, 'warning');
        break;
      case 'service-account': {
        const local = /^\.\\|^[^\\@]+$/.test(ref.value) && !/\\/.test(ref.value);
        push('coupling.service-account', local
          ? `Local account ${ref.value}: create it on the target (or use a domain gMSA).`
          : `Make sure ${ref.value} exists in the target directory, or move the service to a gMSA.`, 'warning');
        break;
      }
      case 'scheduled-job': {
        const scheduler = ref.scheduler ?? 'other';
        const job         = {
          job: ref.where, scheduler, host: ref.server, schedule: ref.schedule ?? '', command: ref.value, runsAs: ref.runAs ?? '', app,
          target: JOB_TARGET[scheduler] ?? 'the target scheduler (or the cloud scheduler: EventBridge Scheduler, Cloud Scheduler, OCI Resource Scheduler)',
        };
        jobs.push(job);
        push('coupling.scheduled-job', 'Added to the jobs inventory: recreate it on the target (see the Jobs grid).', 'info', { job });
        break;
      }
      case 'snmp':
      case 'time':
        push('coupling.monitoring-time', ref.category === 'snmp' ? 'Reconfigure the SNMP trap target to the target monitoring.' : `Reconfigure the time source to the target's${ref.timezone ? ` (time zone ${ref.timezone})` : ''}.`, 'info');
        break;
      case 'printer':
        push('coupling.printer', 'Re-map the printer to the target print service, or keep its port reachable from the target network.', 'info');
        break;
      default:
        break;
    }

    // 2. References to other apps' servers: a proposed dependency edge.
    const kind           = ref.category === 'smtp' ? 'async' : 'sync';
    const otherApps = servers.filter((r) => r.app && r.app !== app);
    if (['config', 'connection-string', 'share'].includes(ref.category) && otherApps.length > 0 && app) {
      for (const r of otherApps) {
        const edge                 = { from: app, to: r.app , kind };
        edges.set(`${edge.from}|${edge.to}|${edge.kind}`, edge);
        push('coupling.dependency', `Accept or ignore the dependency ${app} → ${r.app} (${ref.category}).`, 'info', { edge });
      }
    } else if (ref.category === 'share' && servers.length > 0) {
      push('coupling.share', 'Re-point the mount to the target file service, or keep the share reachable from the target network.', 'warning');
    }

    // 3. External endpoints: candidates for the external-link register (egress allow-lists, notices).
    const unplaced = resolutions.filter((r) => r.kind === 'external');
    const internalPoint = (p        )          => isPrivate(p) || (ctx.domains ?? []).some((d) => p.toLowerCase().endsWith(`.${d.toLowerCase()}`));
    const internal = unplaced.filter((r) => internalPoint(r.point));
    const outside = unplaced.filter((r) => !internalPoint(r.point));
    const contentCategories                              = ['config', 'connection-string', 'smtp', 'share'];
    if (internal.length > 0 && contentCategories.includes(ref.category)) {
      push('coupling.unplaced', `${internal.map((r) => r.point).join(', ')} is in private address space but not in the plan: add the server or the site, or mark it outside scope.`, 'info');
    }
    if (outside.length > 0 && contentCategories.includes(ref.category)) {
      let last                               ;
      for (const r of outside) {
        last = { kind: ref.category === 'share' ? 'sftp' : 'outbound-saas', endpoint: r.point, app, server: ref.server, protocol: ref.category === 'smtp' ? 'smtp' : /https?:\/\//i.test(ref.value) ? 'https' : 'tcp' };
        external.push(last);
      }
      push('coupling.external', `External endpoint${outside.length === 1 ? '' : 's'} ${outside.map((r) => r.point).join(', ')}: confirm the partner allow-lists and the new egress addresses.`, 'info', last ? { external: last } : {});
    } else if (servers.length > 0 && reIp.length === 0 && ['config', 'connection-string'].includes(ref.category) && servers.some((r) => isIpv4(r.point) || isIpv6(r.point))) {
      push('coupling.ip-literal', 'Prefer the FQDN to the IP literal (the address does not change in this plan).', 'info');
    }
  }

  const findings            = [];
  const blockers = actions.filter((a) => a.severity === 'blocker');
  if (blockers.length > 0) {
    const waves = [...new Set(blockers.map((a) => a.wave).filter((n)              => n !== undefined))].sort((a, b) => a - b);
    findings.push(info('coupling.blockers', `${blockers.length} coupling blocker${blockers.length === 1 ? '' : 's'} (IP literals of re-addressed servers)${waves.length > 0 ? ` for wave${waves.length === 1 ? '' : 's'} ${waves.join(', ')}` : ''}.`, {
      remediation: 'Replace the literals with FQDNs, or mark the actions done; gate G1 stays closed while they are open.',
    }));
  }
  return { actions, jobs, edges: [...edges.values()], external, findings };
}

const ISSUE_SEVERITY                                                    = { blocker: 'sev1', error: 'sev2', warning: 'sev3', info: 'sev4' };

/**
 * "Create tasks": open actions as item-linked RAID issues (origin `coupling`)
 * with their due dates. Info actions are left out unless asked for (the jobs
 * inventory and the edge review carry them).
 */
export function couplingIssues(actions                           , opts                                             = {})              {
  const opened = opts.opened ?? today();
  return actions
    .filter((a) => a.status === 'open' && (opts.includeInfo || a.severity !== 'info'))
    .map((a) => ({
      id: `coupling:${a.id}`,
      issue: `${a.server}: ${a.action} (${a.category} at ${a.where})`,
      severity: ISSUE_SEVERITY[a.severity],
      ...(a.wave !== undefined ? { wave: a.wave } : {}),
      blocks: a.severity === 'blocker' ? [...a.items] : [],
      opened,
      ...(a.due ? { due: a.due } : {}),
      status: 'open'         ,
      origin: 'coupling'         ,
    }));
}

/** The Coupling tab's grid rows, in `COUPLING_GRID_COLUMNS` order. */
export function couplingGrid(actions                           )             {
  return actions.map((a) => [a.server, a.category, a.where, a.value, a.pointsTo, a.resolvesTo, a.action, a.due ?? '', a.status]);
}

                                
                                      
                        
                          
                         
                        
 

const ORDER                              = ['blocker', 'error', 'warning', 'info'];

/** The remediation checklist per app: its actions, worst first, then by due date. */
export function remediationByApp(actions                           )                                  {
  const out                                  = {};
  const sorted = [...actions].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.server.localeCompare(b.server));
  for (const a of sorted) {
    if (a.status !== 'open') continue;
    const key = a.app || '(no app)';
    (out[key] ??= []).push({ severity: a.severity, text: a.action, server: a.server, where: a.where, ...(a.due ? { due: a.due } : {}) });
  }
  return out;
}

/** One app's checklist as Markdown (for the app design document and the runbook). */
export function remediationMarkdown(app        , items                          )         {
  const lines = [`## Coupling remediation: ${app}`, ''];
  if (items.length === 0) return [...lines, 'No open coupling actions.', ''].join('\n');
  for (const i of items) lines.push(`- [ ] **${i.severity}** ${i.server}: ${i.text} _(${i.where}${i.due ? `; due ${i.due}` : ''})_`);
  return [...lines, ''].join('\n');
}

/**
 * The wave lookup the rules need, from the wave plan: a workload name to its
 * wave number and dates (through the move groups' item ids).
 */
export function waveLookup(plan                                                                            , workloads                     )                                           {
  const waveByItem = new Map                ();
  for (const g of plan.groups) for (const it of g.items) waveByItem.set(it, g.wave);
  const dates = new Map(plan.waves.map((w) => [w.n, w]));
  const byName = new Map(workloads.map((w) => [w.name.toLowerCase(), w.id]));
  return (name        ) => {
    const id = byName.get(name.toLowerCase()) ?? itemId('workload', name);
    const n = waveByItem.get(id);
    if (n === undefined) return undefined;
    const w = dates.get(n);
    return { n, ...(w?.start ? { start: w.start } : {}), ...(w?.end ? { end: w.end } : {}) };
  };
}

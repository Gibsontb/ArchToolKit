/**
 * The data-centre exit programme (addendum A.5.5.2, A.10.9).
 *
 * After the application waves come the exit waves, dated, each step with its
 * rollback:
 *   - per subnet: unextend (HCX) or retire the VLAN, after its last app wave;
 *   - firewall rule retirement, then the firewall device;
 *   - circuit cuts, in cut order: the internet breakout first, the MPLS last;
 *   - storage-array retirement once its shares, backups and archives are
 *     dispositioned;
 *   - DNS / DHCP / IPAM / NTP retirement;
 *   - hardware removal and sanitisation;
 *   - contract terminations, on their terminate-by dates.
 *
 * Each step belongs after the last application wave that still uses what it
 * retires (a subnet by its servers' addresses and named apps, a circuit by the
 * subnets at its sites), so the exit waves interleave with the app waves: E1
 * follows the earliest app wave that frees anything, the last exit wave follows
 * the last app wave. A step's date is its app wave's end plus the dual-running
 * days (sources stay powered off, circuits live, until then).
 *
 * A circuit cut's rollback is generated for the device's platform through the
 * Network page's change blueprints: the handoff (`plan-to-network`) opens
 * network.html on the BGP-peer or static-route blueprint for the device, filled
 * with the circuit's values. That change is the rollback (it re-creates the
 * session or routes); its back-out is the cut.
 *
 * The lights-out checklist (`lights-out.md`, and the programme gate G5) is
 * computed from every grid.
 */

import { containsAny, parseCidrAny } from '../../../core/ip.js';
import { error, info, warning,              } from '../../../core/findings.js';
                                                                                                                          
import { canDispose, checkAssets, contractTasks, NIST_800_88,                     } from './contracts.js';
import { archivesDispositioned, checkArchives } from './archive.js';

/* ------------------------------------------------------------ fact names --- */

/** The circuit kinds of the Network grid, in cut order: the internet breakout first, the MPLS last. */
export const CIRCUIT_KINDS = ['internet', 'vpn', 'p2p', 'dark-fibre', 'mpls']         ;
                                                         
export const DEVICE_KINDS = ['switch', 'router', 'firewall', 'load-balancer', 'wlc', 'proxy']         ;
export const NET_SERVICE_KINDS = ['dns', 'dhcp', 'ipam', 'ntp', 'proxy']         ;
export const IP_STRATEGIES                        = ['re-ip', 'keep-ip-l2-extension', 'keep-ip-cloud'];

/* ---------------------------------------------------------------- inputs --- */

                            
                          
                                          
                                                
                                               
                                                                     
                                                  
                                       
                                                                   
                          
                           
 

/** Wave numbers and end dates from a wave plan (move groups → waves), with app pins. */
export function wavesFromPlan(plan      , wavePlan           )                                                                                   {
  const waveOf = new Map                ();
  const waveEnds = new Map                ();
  if (wavePlan) {
    const groupWave = new Map                ();
    for (const w of wavePlan.waves) {
      if (w.kind === 'exit') continue;
      for (const g of w.groups) groupWave.set(g, w.n);
      if (w.end) waveEnds.set(w.n, w.end);
    }
    for (const g of wavePlan.groups) {
      const n = groupWave.get(g.id) ?? g.wave;
      for (const item of g.items) waveOf.set(item, n);
    }
  }
  const pinned = new Map(plan.apps.filter((a) => a.wave !== undefined).map((a) => [a.name, a.wave          ]));
  for (const w of plan.workloads) {
    if (!waveOf.has(w.id) && pinned.has(w.app)) waveOf.set(w.id, pinned.get(w.app)          );
  }
  return { waveOf, waveEnds };
}

/* ----------------------------------------------------------------- output --- */

                                                                                                                                                               
const KIND_ORDER                                         = {
  subnet: 10,
  'firewall-rules': 20,
  firewall: 30,
  circuit: 40,
  'network-device': 50,
  'storage-array': 60,
  'net-service': 70,
  hardware: 80,
  contract: 90,
};

/** A device change for network.html, prefilled from the circuit (the `plan-to-network` payload). */
                                       
                           
                          
                                                             
                            
                                         
                             
                                                                       
                         
                            
                         
                                                     
                        
 
                                       
                           
                                                    
 

                           
                      
                              
                         
                         
                          
                            
                                                           
                             
                            
                         
                                                     
 

                           
                         
                                                                               
                     
                             
                         
                                      
 

                               
                                      
                                              
                                        
 

/* ---------------------------------------------------------------- helpers --- */

const DAY = 86_400_000;
const addDays = (iso        , days        )         => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const list = (v                    )           => (v ?? '').split(/[\s,;|]+/).map((s) => s.trim()).filter(Boolean);
const byCategory = (dc        , c                       )              => dc.infra.filter((i) => i.category === c);
const leaving = (i           )          => i.disposition !== 'stays' && i.disposition !== 'n/a';

                                 
                      
                        
                         
                         
                                
                                                                    
                                    
                            
                                        
                                                                                
                                      
 

/**
 * The re-IP or keep-IP decision per subnet (A.10.9). `re-ip` is the default.
 * `keep-ip-l2-extension` needs every server in the subnet on a VMware target;
 * `keep-ip-cloud` needs the whole subnet to move in one wave.
 */
export function subnetDecisions(input           )                                                                       {
  const findings            = [];
  const subnets                   = [];
  const waveOfApp = new Map                  ();
  for (const w of input.workloads) {
    const n = input.waveOf.get(w.id);
    if (n !== undefined) waveOfApp.set(w.app, [...(waveOfApp.get(w.app) ?? []), n]);
  }
  for (const s of byCategory(input.dcExit, 'subnet')) {
    const cidr = parseCidrAny(s.facts.cidr ?? s.name) ? (s.facts.cidr ?? s.name) : undefined;
    const members = cidr ? input.workloads.filter((w) => (w.facts?.ipAddresses ?? []).some((a) => containsAny(cidr, a.split('/')[0]          ))) : [];
    const waves = [
      ...members.map((w) => input.waveOf.get(w.id)).filter((n)              => n !== undefined),
      ...list(s.facts.apps).flatMap((a) => waveOfApp.get(a) ?? []),
    ];
    const uniq = [...new Set(waves)].sort((a, b) => a - b);
    const strategy = (IP_STRATEGIES.find((x) => x === s.facts.strategy) ?? 're-ip')              ;
    const lastWave = uniq.length ? (uniq[uniq.length - 1]          ) : 0;
    const notices = cidr ? input.dcExit.external.filter((l) => l.currentIps.some((ip) => containsAny(cidr, ip))).map((l) => l.id) : [];
    subnets.push({ id: s.id, name: s.name, ...(cidr ? { cidr } : {}), ...(s.site ? { site: s.site } : {}), strategy, waves: uniq, lastWave, workloads: members.map((w) => w.name), notices });

    if (!cidr) findings.push(warning('dc.subnet-cidr', `Subnet ${s.name} has no CIDR, so its servers cannot be found by address.`, { path: `infra.${s.id}` }));
    if (strategy === 'keep-ip-l2-extension') {
      const off = members.filter((w) => input.targetOf?.(w.id) !== undefined && input.targetOf?.(w.id) !== 'vmware');
      if (off.length) {
        findings.push(
          error('ip.l2-needs-vmware', `Subnet ${s.name}: an L2 extension (HCX Network Extension) needs VMware targets, but ${off.map((w) => w.name).join(', ')} ${off.length === 1 ? 'goes' : 'go'} elsewhere.`, {
            path: `infra.${s.id}`,
            remediation: 'Re-IP the subnet, or keep its servers on a VMware target.',
          }),
        );
      }
    }
    if (strategy === 'keep-ip-cloud' && uniq.length > 1) {
      findings.push(
        warning('ip.keep-ip-spans-waves', `Subnet ${s.name} keeps its range in the cloud but its servers move in waves ${uniq.join(', ')}: the on-premises route can only be withdrawn once the subnet is empty.`, {
          path: `infra.${s.id}`,
          remediation: 'Move the subnet in one wave, or re-IP it.',
        }),
      );
    }
    if (strategy === 're-ip' && notices.length) {
      findings.push(info('ip.re-ip-notice', `Subnet ${s.name} is re-addressed: ${notices.join(', ')} allow-list addresses in it and need notice.`, { path: `infra.${s.id}` }));
    }
  }
  return { subnets, findings };
}

/* ----------------------------------------------------- network handoffs --- */

                                                        
const asNum = (v                    )                              => (v === undefined || v === '' ? undefined : /^\d+$/.test(v) ? Number(v) : v);
const defined = (o                                                       )         => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''))          ;

/** Per Network-page platform: the BGP-peer blueprint and how a circuit's facts fill it. */
export const BGP_BLUEPRINTS                                                                                                                                                              = {
  cisco_ios: { blueprint: 'ios_bgp_peer', values: (f, c) => defined({ local_as: asNum(f.localAs), neighbor: f.neighbor, remote_as: asNum(f.remoteAs), peer_description: c, router_id: f.routerId }) },
  cisco_nxos: { blueprint: 'nxos_bgp_neighbor', values: (f, c) => defined({ local_as: asNum(f.localAs), neighbor: f.neighbor, remote_as: asNum(f.remoteAs), peer_description: c, router_id: f.routerId }) },
  cisco_iosxr: { blueprint: 'iosxr_bgp_neighbor', values: (f, c) => defined({ asn: f.localAs, neighbor: f.neighbor, remote_as: f.remoteAs, neighbor_description: c, router_id: f.routerId }) },
  cisco_asa: { blueprint: 'asa_bgp', values: (f) => defined({ asn: asNum(f.localAs), neighbors: f.neighbor && f.remoteAs ? `${f.neighbor} ${f.remoteAs}` : undefined, router_id: f.routerId }) },
  cisco_fmc: { blueprint: 'fmc_bgp', values: (f, c, d) => defined({ device: d, asn: f.localAs, neighbor: f.neighbor, remote_as: f.remoteAs, neighbor_description: c, router_id: f.routerId }) },
  arista_eos: { blueprint: 'eos_bgp_underlay', values: (f) => defined({ local_as: asNum(f.localAs), peers: f.neighbor && f.remoteAs ? `${f.neighbor} ${f.remoteAs}` : undefined, router_id: f.routerId }) },
  juniper_junos: { blueprint: 'junos_bgp', values: (f, c) => defined({ group: c.toUpperCase().replace(/[^A-Z0-9-]+/g, '-'), type: 'external', local_as: asNum(f.localAs), peer_as: asNum(f.remoteAs), neighbors: f.neighbor }) },
  aruba_aoscx: { blueprint: 'aoscx_bgp_peer', values: (f, c) => defined({ local_as: asNum(f.localAs), neighbor: f.neighbor, remote_as: asNum(f.remoteAs), peer_description: c, router_id: f.routerId }) },
};

/** Per Network-page platform: the static-route blueprint, one change per prefix where it takes one. */
export const STATIC_BLUEPRINTS                                                                                                                                                                                                                        = {
  cisco_ios: { blueprint: 'ios_static_route', perPrefix: true, values: (p, f) => defined({ prefix: p[0], next_hop: f.nextHop }) },
  cisco_nxos: { blueprint: 'nxos_static_route', perPrefix: true, values: (p, f) => defined({ prefix: p[0], next_hop: f.nextHop, interface: f.interface }) },
  cisco_iosxr: { blueprint: 'iosxr_static_route', perPrefix: true, values: (p, f, c) => defined({ prefix: p[0], next_hop: f.nextHop, interface: f.interface, route_description: c }) },
  cisco_asa: { blueprint: 'asa_static_route', perPrefix: true, values: (p, f) => defined({ destination: p[0], gateway: f.nextHop, interface: f.interface, track: false }) },
  cisco_fmc: { blueprint: 'fmc_static_route', perPrefix: true, values: (p, f, _c, d) => defined({ device: d, destination: p[0], gateway: f.nextHop, ifname: f.interface }) },
  arista_eos: { blueprint: 'eos_static_route', perPrefix: true, values: (p, f, c) => defined({ prefix: p[0], next_hop: f.nextHop, route_name: c }) },
  juniper_junos: { blueprint: 'junos_static_route', perPrefix: false, values: (p, f) => defined({ prefixes: p.join(', '), next_hop: f.nextHop }) },
  aruba_aoscx: { blueprint: 'aoscx_static_route', perPrefix: false, values: (p, f) => defined({ prefixes: p.join(', '), next_hop: f.nextHop }) },
  panos: { blueprint: 'panos_static_route', perPrefix: true, values: (p, f, c) => defined({ destination: p[0], next_hop: f.nextHop, interface: f.interface, route_name: `${c}-${(p[0] ?? '').replace(/[^0-9a-f]+/gi, '-')}`.slice(0, 31), monitor: false }) },
  fortios: { blueprint: 'fortios_static_route', perPrefix: true, values: (p, f) => defined({ prefix: p[0], gateway: f.nextHop, device: f.interface }) },
  f5: { blueprint: 'f5_static_routes', perPrefix: false, values: (p, f) => defined({ routes: p.map((x) => `${x} ${f.nextHop ?? ''}`.trim()).join('\n'), default_gateway: '' }) },
};

function circuitHandoffs(circuit           , devices                      , exitWave        , date                    , findings           )                         {
  const f = circuit.facts;
  const deviceName = f.device ?? '';
  if (!deviceName) return [];
  const device = devices.find((d) => d.name === deviceName || d.id === deviceName);
  const platform = device?.facts.platform ?? f.platform ?? '';
  const out                         = [];
  const note = `Rollback for the ${circuit.name} cut: this change re-creates what the cut removes. Apply its back-out to cut the circuit; apply the change itself to roll back.`;
  const base = { circuit: circuit.name, device: deviceName, platform, exitWave, ...(date ? { date } : {}), note };
  if (f.neighbor && f.remoteAs) {
    const bgp = BGP_BLUEPRINTS[platform];
    if (bgp) out.push({ ...base, blueprint: bgp.blueprint, values: bgp.values(f, circuit.name, deviceName), label: `${circuit.name}: BGP ${f.neighbor} (AS ${f.remoteAs}) on ${deviceName}` });
    else findings.push(warning('dc.circuit-platform', `Circuit ${circuit.name}: the Network page has no BGP blueprint for ${platform || 'an unnamed platform'}; write the rollback by hand.`, { path: `infra.${circuit.id}` }));
  }
  const prefixes = list(f.prefixes);
  if (prefixes.length && f.nextHop) {
    const st = STATIC_BLUEPRINTS[platform];
    if (st) {
      const groups = st.perPrefix ? prefixes.map((p) => [p]) : [prefixes];
      for (const g of groups) out.push({ ...base, blueprint: st.blueprint, values: st.values(g, f, circuit.name, deviceName), label: `${circuit.name}: static route${g.length > 1 ? 's' : ''} ${g.join(', ')} via ${f.nextHop} on ${deviceName}` });
    } else findings.push(warning('dc.circuit-platform', `Circuit ${circuit.name}: the Network page has no static-route blueprint for ${platform || 'an unnamed platform'}; write the rollback by hand.`, { path: `infra.${circuit.id}` }));
  }
  if (out.length === 0) findings.push(info('dc.circuit-no-routing', `Circuit ${circuit.name}: no BGP neighbour or static routes are recorded on ${deviceName}, so no device change is prefilled.`, { path: `infra.${circuit.id}` }));
  return out;
}

/**
 * Where network.html opens for one handed-off change: the platform and
 * blueprint, and the values the blueprint has inputs for. Null when the
 * platform or blueprint is not one the page builds (a stale payload).
 * `groups` is the Network page's blueprint list, passed in so this module
 * does not load every device blueprint.
 */
export function handoffOpening(
  change                      ,
  groups                                                                                                                                                      ,
)                                                                                                                                 {
  const group = groups.find((g) => g.target === change.platform);
  const blueprint = group?.blueprints.find((b) => b.id === change.blueprint);
  if (!group || !blueprint) return null;
  const known = new Set(blueprint.inputs.map((i) => i.id));
  const values         = {};
  const dropped           = [];
  for (const [k, v] of Object.entries(change.values)) {
    if (known.has(k)) values[k] = v;
    else dropped.push(k);
  }
  values.__name = `${change.circuit} rollback`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { platform: group.target, blueprint: blueprint.id, values, dropped };
}

/** The `plan-to-network` payload: every circuit-cut device change in the programme. */
export function networkHandoff(seq              , planId         )                       {
  return { ...(planId ? { planId } : {}), changes: seq.waves.flatMap((w) => w.steps.flatMap((s) => s.handoff ?? [])) };
}

/* --------------------------------------------------------------- sequence --- */

export function exitSequence(input           )               {
  const dc = input.dcExit;
  const findings            = [];
  const decisions = subnetDecisions(input);
  findings.push(...decisions.findings);
  const allWaves = [...input.waveOf.values()];
  const lastAppWave = allWaves.length ? Math.max(...allWaves) : 0;
  const lastAt = (sites                   )         => {
    const subs = sites.length ? decisions.subnets.filter((s) => s.site !== undefined && sites.includes(s.site)) : decisions.subnets;
    return subs.length ? Math.max(...subs.map((s) => s.lastWave)) : lastAppWave;
  };

                                                                                                                
  const drafts          = [];
  const override = (item           , computed        )         => {
    if (item.afterWave === undefined) return computed;
    if (item.afterWave < computed) {
      findings.push(
        error('dc.cut-too-early', `${item.name} is set to go after wave ${item.afterWave}, but wave ${computed} still uses it.`, { path: `infra.${item.id}`, remediation: `Move it to after wave ${computed} or later.` }),
      );
      return computed;
    }
    return item.afterWave;
  };

  // Subnets: unextend or retire, after the last wave that uses each.
  for (const s of decisions.subnets) {
    const item = dc.infra.find((i) => i.id === s.id)             ;
    if (!leaving(item)) continue;
    const vlan = item.facts.vlan ? `VLAN ${item.facts.vlan} ` : '';
    const l2 = s.strategy === 'keep-ip-l2-extension';
    drafts.push({
      id: `exit-subnet-${s.id}`,
      kind: 'subnet',
      item: s.id,
      title: `${l2 ? 'Unextend' : 'Retire'} ${vlan}${s.cidr ?? s.name}`,
      action: l2
        ? `Unextend the HCX Network Extension for ${vlan}${s.cidr ?? s.name}, move the gateway to the target segment, and withdraw the on-premises route.`
        : s.strategy === 'keep-ip-cloud'
          ? `Withdraw the on-premises route for ${s.cidr ?? s.name} and advertise it from the target; retire ${vlan}(SVI, trunks, DHCP scope).`
          : `Retire ${vlan}${s.cidr ?? s.name}: remove the SVI / gateway, the VLAN from trunks, and its DHCP scope.`,
      rollback: l2 ? 'Re-extend the network with HCX Network Extension and move the gateway back.' : 'Restore the VLAN, SVI and route from the pre-change configuration backup.',
      afterWave: override(item, s.lastWave),
    });
  }

  // Firewalls: rule retirement, then the device.
  const devices = byCategory(dc, 'network-device');
  for (const d of devices.filter((x) => leaving(x) && (x.facts.kind ?? '') === 'firewall')) {
    const after = override(d, lastAt(d.site ? [d.site] : []));
    drafts.push({
      id: `exit-fwrules-${d.id}`,
      kind: 'firewall-rules',
      item: d.id,
      title: `Retire the migrated rules on ${d.name}`,
      action: `Disable, then remove, the rules on ${d.name} whose servers have moved (the translated rules now carry them); keep the saved rule base.`,
      rollback: `Re-apply the saved rule base on ${d.name}.`,
      afterWave: after,
    });
    drafts.push({
      id: `exit-fw-${d.id}`,
      kind: 'firewall',
      item: d.id,
      title: `Decommission firewall ${d.name}`,
      action: `Take a final configuration backup, then shut down and disconnect ${d.name}.`,
      rollback: `Reconnect and power on ${d.name}; its configuration is unchanged.`,
      afterWave: after,
    });
  }

  // Circuits: after the subnets at their sites; the internet first, the MPLS last.
  const circuits = byCategory(dc, 'circuit').filter(leaving);
  const computedCircuit = new Map                ();
  for (const c of circuits) computedCircuit.set(c.id, lastAt(list(c.facts.sites).length ? list(c.facts.sites) : c.site ? [c.site] : []));
  for (const c of circuits) {
    const kind = (CIRCUIT_KINDS.find((k) => k === c.facts.kind) ?? 'p2p')               ;
    let after = computedCircuit.get(c.id)          ;
    if (kind === 'mpls') {
      // The MPLS carries every site: it goes last among the circuits that share a site with it.
      const sites = list(c.facts.sites);
      for (const o of circuits) if (o !== c && (sites.length === 0 || list(o.facts.sites).some((s) => sites.includes(s)))) after = Math.max(after, computedCircuit.get(o.id)          );
    }
    after = override(c, after);
    const order = Number(c.facts.cutOrder);
    drafts.push({
      id: `exit-circuit-${c.id}`,
      kind: 'circuit',
      item: c.id,
      title: `Cut ${kind} circuit ${c.name}${c.facts.provider ? ` (${c.facts.provider})` : ''}`,
      action: `Shut the BGP session or remove the static routes over ${c.name}${c.facts.device ? ` on ${c.facts.device}` : ''}, confirm no traffic for the agreed period, then ask the provider to cease the circuit.`,
      rollback: 'Re-enable the BGP session or restore the static routes (the prefilled device change), before the provider ceases the circuit.',
      afterWave: after,
      circuitOrder: Number.isFinite(order) && c.facts.cutOrder ? order : CIRCUIT_KINDS.indexOf(kind) * 100,
      circuit: c,
    });
  }

  // Other network devices at a site: after its circuits and subnets.
  for (const d of devices.filter((x) => leaving(x) && (x.facts.kind ?? '') !== 'firewall')) {
    const atSite = circuits.filter((c) => !d.site || list(c.facts.sites).includes(d.site) || c.site === d.site).map((c) => computedCircuit.get(c.id)          );
    drafts.push({
      id: `exit-device-${d.id}`,
      kind: 'network-device',
      item: d.id,
      title: `Decommission ${d.facts.kind ?? 'device'} ${d.name}`,
      action: `Take a final configuration backup, then shut down and disconnect ${d.name}.`,
      rollback: `Reconnect and power on ${d.name}.`,
      afterWave: override(d, Math.max(lastAt(d.site ? [d.site] : []), ...atSite)),
    });
  }

  // Storage arrays: after the apps that use them, once shares, backups and archives are dispositioned.
  const openData = [...byCategory(dc, 'backup'), ...byCategory(dc, 'archive')].filter((i) => !i.disposition);
  for (const a of byCategory(dc, 'storage-array').filter(leaving)) {
    const apps = list(a.facts.apps);
    const waves = input.workloads.filter((w) => apps.includes(w.app)).map((w) => input.waveOf.get(w.id)).filter((n)              => n !== undefined);
    const after = override(a, apps.length ? (waves.length ? Math.max(...waves) : lastAppWave) : lastAppWave);
    const blocking = openData.filter((i) => !a.site || !i.site || i.site === a.site);
    if (blocking.length) {
      findings.push(
        warning('dc.array-blocked', `Array ${a.name} cannot be retired while ${blocking.map((i) => i.name).join(', ')} ${blocking.length === 1 ? 'has' : 'have'} no disposition.`, { path: `infra.${a.id}` }),
      );
    }
    drafts.push({
      id: `exit-array-${a.id}`,
      kind: 'storage-array',
      item: a.id,
      title: `Retire storage array ${a.name}`,
      action: `Confirm the shares, backups and archives on ${a.name} are migrated or dispositioned, unpresent its LUNs and shares, and power it off.`,
      rollback: `Power on ${a.name} and re-present the LUNs and shares; the data is untouched until sanitisation.`,
      afterWave: after,
    });
  }

  // DNS / DHCP / IPAM / NTP: last.
  for (const s of byCategory(dc, 'net-service').filter(leaving)) {
    const kind = s.facts.kind ?? 'service';
    if (kind === 'dhcp') {
      const remaining = decisions.subnets.filter((x) => x.lastWave > lastAppWave);
      if (remaining.length) findings.push(info('dc.dhcp', `DHCP server ${s.name} still serves subnets that move later.`, { path: `infra.${s.id}` }));
    }
    drafts.push({
      id: `exit-service-${s.id}`,
      kind: 'net-service',
      item: s.id,
      title: `Retire ${kind.toUpperCase()} ${s.name}`,
      action:
        kind === 'dns'
          ? `Confirm the zones are served by their target (cloud private zones or the retained DNS) and conditional forwarders point there, then retire ${s.name}.`
          : kind === 'dhcp'
            ? `Every subnet it served has moved: retire ${s.name} (Export-DhcpServer first, for the record).`
            : `Point every client at the target ${kind.toUpperCase()} and retire ${s.name}.`,
      rollback: `Power on ${s.name}; its configuration is unchanged.`,
      afterWave: override(s, lastAppWave),
    });
  }

  // Hardware removal and sanitisation.
  const dataAssets = dc.assets.filter((a) => a.containsData);
  if (dc.assets.length) {
    drafts.push({
      id: 'exit-hardware',
      kind: 'hardware',
      title: `Remove ${dc.assets.length} asset${dc.assets.length === 1 ? '' : 's'} and sanitise ${dataAssets.length} that hold data`,
      action: `Sanitise every data-bearing asset per NIST SP 800-88 (clear, purge or destroy) and record each certificate id (${NIST_800_88}); remove the hardware within ${dc.hardwareRemovalDays} days; update the asset register.`,
      rollback: 'None once media is sanitised: confirm the dual-running period has ended before starting.',
      afterWave: lastAppWave,
    });
  }

  // Contracts.
  const contracts = contractTasks(dc, input.today ?? new Date().toISOString().slice(0, 10));
  findings.push(...contracts.findings);

  // Exit waves: one per distinct afterWave, in order.
  const afters = [...new Set(drafts.map((d) => d.afterWave))].sort((a, b) => a - b);
  if (contracts.tasks.length && afters.length === 0) afters.push(lastAppWave);
  const labelOf = new Map(afters.map((a, i) => [a, `E${i + 1}`]));
  const dateOf = (after        )                     => {
    const end = input.waveEnds?.get(after);
    return end ? addDays(end, dc.dualRunningDays) : undefined;
  };
  const waves             = afters.map((after, i) => {
    const label = labelOf.get(after)          ;
    const date = dateOf(after);
    const steps             = drafts
      .filter((d) => d.afterWave === after)
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.circuitOrder ?? 0) - (b.circuitOrder ?? 0) || a.id.localeCompare(b.id))
      .map(({ circuitOrder: _o, circuit, ...d }) => {
        const stepDate = d.kind === 'hardware' ? (dc.exitDate ?? date) : date;
        const handoff = circuit ? circuitHandoffs(circuit, devices, label, date, findings) : [];
        return { ...d, exitWave: label, ...(stepDate ? { date: stepDate } : {}), ...(handoff.length ? { handoff } : {}) };
      });
    if (i === afters.length - 1) {
      for (const t of contracts.tasks) {
        steps.push({
          id: `exit-contract-${t.id}`,
          kind: 'contract',
          item: t.id,
          title: `Terminate ${t.kind} contract ${t.id} (${t.vendor})`,
          action: `Give notice to ${t.vendor} by ${t.terminateBy ?? 'the date the contract allows'} (${t.noticeDays} days before ${t.ends}${dc.exitDate && dc.exitDate < t.ends ? ` or the exit date ${dc.exitDate}` : ''}).`,
          rollback: 'None once notice is given; confirm the exit date first.',
          afterWave: after,
          exitWave: label,
          ...(t.terminateBy ? { date: t.terminateBy } : {}),
        });
      }
    }
    return { label, n: lastAppWave + i + 1, afterWave: after, ...(date ? { date } : {}), steps };
  });

  if (dc.exitDate) {
    for (const w of waves) {
      if (w.date && w.date > dc.exitDate) {
        findings.push(error('dc.after-exit-date', `Exit wave ${w.label} (${w.date}) falls after the exit date ${dc.exitDate}.`, { path: 'dcExit.exitDate', remediation: 'Bring the app waves forward, shorten dual running, or move the exit date.' }));
      }
    }
  }
  return { waves, subnets: decisions.subnets, findings };
}

/** The exit waves as `Wave` records (`kind: 'exit'`), for the wave plan and waves.csv. */
export function exitWaves(seq              )         {
  return seq.waves.map((w) => ({ n: w.n, groups: w.steps.map((s) => s.id), kind: 'exit'         , name: w.label, ...(w.date ? { start: w.date, end: w.date } : {}), gates: w === seq.waves[seq.waves.length - 1] ? ['G5'         ] : [] }));
}

/** `exit-sequence.md`: the dated programme, each step with its rollback. */
export function exitSequenceMarkdown(seq              )         {
  const out           = ['# Data-centre exit sequence', ''];
  for (const w of seq.waves) {
    out.push(`## ${w.label}: after app wave ${w.afterWave}${w.date ? ` (${w.date})` : ''}`, '');
    for (const s of w.steps) {
      out.push(`- **${s.title}**${s.date && s.date !== w.date ? ` (${s.date})` : ''}`, `  - Do: ${s.action}`, `  - Rollback: ${s.rollback}`);
      for (const h of s.handoff ?? []) out.push(`  - Device change (network.html): ${h.label} [${h.platform} / ${h.blueprint}]`);
    }
    out.push('');
  }
  if (seq.waves.length === 0) out.push('Nothing in the data centre is marked to leave yet.', '');
  return out.join('\n');
}

/* ------------------------------------------------------------- lights-out --- */

                                  
                                                                               
                                                
                                                                     
                                 
                                      
                          
 

const done = (i           )          => /^(yes|done|true)$/i.test(i.facts.done ?? '');

/** The lights-out checklist, as the G5 gate's criteria. */
export function lightsOut(dc        , status                  = {})                  {
  const today = status.today ?? new Date().toISOString().slice(0, 10);
  const undisposed = dc.infra.filter((i) => !i.disposition || (leaving(i) && !done(i)));
  const powered = status.poweredOnSources ?? [];
  const uncut = byCategory(dc, 'circuit').filter((c) => leaving(c) && !done(c) && !c.facts.cutOn);
  const contracts = contractTasks(dc, today, status.contractStatus).tasks.filter((t) => t.status !== 'terminated');
  const unsanitised = dc.assets.filter((a) => !canDispose(a) || !a.disposedOn);
  const archives = archivesDispositioned(dc.infra, today);
  const unregistered = dc.assets.filter((a) => !a.registerUpdated);
  const names = (xs                                          )         => xs.slice(0, 5).map((x) => x.name ?? x.id).join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '');
  return [
    { id: 'lo.dispositions', auto: true, met: undisposed.length === 0, detail: undisposed.length ? `Not done: ${names(undisposed)}.` : 'Every item has its final disposition done.' },
    { id: 'lo.powered-off', auto: status.poweredOnSources !== undefined, met: status.poweredOnSources !== undefined && powered.length === 0, detail: status.poweredOnSources === undefined ? 'Reconcile with the latest estate import.' : powered.length ? `Still powered on: ${powered.slice(0, 5).join(', ')}.` : 'No source VM or host is powered on.' },
    { id: 'lo.circuits', auto: true, met: uncut.length === 0, detail: uncut.length ? `Not cut: ${names(uncut)}.` : 'Every circuit is cut.' },
    { id: 'lo.contracts', auto: status.contractStatus !== undefined, met: contracts.length === 0, detail: contracts.length ? `Not terminated: ${contracts.map((c) => c.id).slice(0, 5).join(', ')}.` : 'Every contract is terminated.' },
    { id: 'lo.sanitised', auto: true, met: unsanitised.length === 0, detail: unsanitised.length ? `Not sanitised and disposed with a certificate: ${names(unsanitised)}.` : 'Every asset is sanitised (NIST SP 800-88) with a certificate.' },
    { id: 'lo.archives', auto: true, met: archives.done, detail: archives.done ? 'Every archive is dispositioned.' : `Open: ${archives.open.slice(0, 5).join(', ')}.` },
    { id: 'lo.register', auto: true, met: unregistered.length === 0 && status.cmdbUpdated === true, detail: unregistered.length ? `Asset register not updated: ${names(unregistered)}.` : status.cmdbUpdated ? 'The CMDB and asset register are updated.' : 'Confirm the CMDB is updated.' },
    { id: 'lo.evidence', auto: false, met: status.evidenceComplete === true, detail: status.evidenceComplete ? 'The evidence pack is complete.' : 'Complete the evidence pack (A.10.13).' },
  ];
}

const LIGHTS_OUT_TEXT                                   = {
  'lo.dispositions': 'Every item has its final disposition done',
  'lo.powered-off': 'No source VM or host is powered on (reconciled with the latest estate)',
  'lo.circuits': 'Every circuit is cut',
  'lo.contracts': 'Every contract is terminated',
  'lo.sanitised': 'Every asset is sanitised, with a certificate',
  'lo.archives': 'Every archive is dispositioned',
  'lo.register': 'The CMDB and asset register are updated',
  'lo.evidence': 'The evidence pack is complete',
};

/** `lights-out.md`. */
export function lightsOutMarkdown(criteria                          )         {
  const lines = ['# Lights-out checklist (gate G5)', ''];
  for (const c of criteria) lines.push(`- [${c.met ? 'x' : ' '}] ${LIGHTS_OUT_TEXT[c.id] ?? c.id}: ${c.detail}`);
  lines.push('');
  return lines.join('\n');
}

/** Every rule check on the data-centre exit grids, in one call. */
export function checkDcExit(dc        , today        )            {
  return [...checkArchives(dc.infra, today), ...checkAssets(dc.assets), ...contractTasks(dc, today).findings];
}


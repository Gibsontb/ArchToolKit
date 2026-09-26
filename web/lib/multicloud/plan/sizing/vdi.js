/**
 * The `vdi` engine (addendum A.2.8.7, A.4.5).
 *
 * - Multi-session hosts: concurrent users ÷ (users per vCPU × vCPU per host),
 *   density light 6, medium 4, heavy 2 users per vCPU, hosts of 8–24 vCPU
 *   (Microsoft's session-host sizing guidelines).
 * - Single-session (persistent) desktops: 2 vCPU / 8 GiB light, 4 / 16
 *   medium, 8 / 32 heavy, one per user.
 * - AWS: persistent → WorkSpaces Personal, non-persistent → WorkSpaces Pools,
 *   bundle by persona. OCI: Secure Desktops pools (one desktop per user).
 * - Profiles (FSLogix): users × profile GiB × 1.2.
 * - AVD scaling plan: max = the peak host count, min = the off-peak share
 *   (an assumption, editable).
 */

import { warning,              } from '../../../core/findings.js';
                                                                                           
                                               
import { appPlanOf, chooseInstance, isPattern, num, reason, rec, str,                      } from './server.js';

                                                   
export const SESSION_DENSITY                                    = { light: 6, medium: 4, heavy: 2 };
export const SINGLE_SESSION                                                       = { light: [2, 8], medium: [4, 16], heavy: [8, 32] };
/** WorkSpaces bundle by persona (recalled bundle specs; verify). */
export const WORKSPACES_BUNDLE                                    = { light: 'Performance', medium: 'Power', heavy: 'PowerPro' };
export const VDI_SOURCES = {
  density: 'https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/session-host-virtual-machine-sizing-guidelines',
  workspaces: 'https://docs.aws.amazon.com/workspaces/latest/adminguide/managing-wsp-pools.html',
  fslogix: 'https://learn.microsoft.com/en-us/fslogix/concepts-container-storage-options',
  avd: 'https://learn.microsoft.com/en-us/azure/virtual-desktop/autoscale-scaling-plan',
}         ;

                           
                             
                         
                                 
                            
                               
                              
                        
                            
 

export function sizeVdi(i          , platform          , policy                 )                                             {
  const rows              = [];
  const findings            = [];
  const concurrent = Math.ceil(i.users * i.concurrentPct / 100);
  const families                   = i.gpu ? ['gpu'] : ['general', 'memory', 'compute'];
  const offPeak = (policy.assumptions['vdi.offPeakPct'] ?? 20) / 100;

  if (platform === 'aws') {
    const pool = !i.persistent;
    const count = pool ? concurrent : i.users;
    rows.push({
      key: `vdi:${i.component}`, demand: { users: i.users, concurrent }, choice: `WorkSpaces ${pool ? 'Pools' : 'Personal'} ${WORKSPACES_BUNDLE[i.persona]}`,
      detail: { service: pool ? 'aws_workspaces_pool' : 'aws_workspaces_workspace', bundle: WORKSPACES_BUNDLE[i.persona], count },
      fits: true,
      reasons: [reason(`${pool ? 'Non-persistent → WorkSpaces Pools sized for the concurrent users' : 'Persistent → WorkSpaces Personal, one per user'}: ${count}.`, { source: VDI_SOURCES.workspaces }), reason(`Bundle ${WORKSPACES_BUNDLE[i.persona]} for a ${i.persona} persona (verify the bundle's vCPU / memory).`, { assumption: true })],
      alternatives: Object.values(WORKSPACES_BUNDLE).filter((b) => b !== WORKSPACES_BUNDLE[i.persona]),
    });
  } else if (i.persistent || platform === 'oci') {
    const [v, r] = SINGLE_SESSION[i.persona];
    const count = platform === 'oci' && !i.persistent ? concurrent : i.users;
    const c = chooseInstance(platform, v, r, { families, allowArm: false, latest: policy.latestGeneration, burstable: false });
    if (!c.fit) findings.push(warning('size.vdi.no-type', `No ${platform} type for a ${v} vCPU / ${r} GiB desktop.`));
    rows.push({
      key: `vdi:${i.component}`, demand: { users: i.users, concurrent, vcpu: v, ramGib: r }, choice: c.fit?.type ?? '',
      detail: { mode: platform === 'oci' ? 'Secure Desktops pool' : 'single-session', count, ...(c.fit?.ocpus ? { ocpus: c.fit.ocpus } : {}) },
      fits: !!c.fit,
      reasons: [reason(`${count} single-session desktop(s) of ${v} vCPU / ${r} GiB (${i.persona}).`, { source: VDI_SOURCES.density }), ...c.reasons],
      alternatives: c.alternatives,
    });
  } else {
    const vcpu = Math.min(24, Math.max(8, i.hostVcpu));
    const perHost = SESSION_DENSITY[i.persona] * vcpu;
    const hosts = Math.max(1, Math.ceil(concurrent / perHost));
    const c = chooseInstance(platform, vcpu, vcpu * 4, { families, allowArm: false, latest: policy.latestGeneration, burstable: false });
    if (!c.fit) findings.push(warning('size.vdi.no-type', `No ${platform} session-host type with ${vcpu} vCPU.`));
    const min = Math.max(1, Math.ceil(hosts * offPeak));
    rows.push({
      key: `vdi:${i.component}`, demand: { users: i.users, concurrent }, choice: c.fit?.type ?? '',
      detail: { mode: 'multi-session', hosts, usersPerHost: perHost, ...(platform === 'azure' ? { scalingMin: min, scalingMax: hosts } : {}) },
      fits: !!c.fit,
      reasons: [
        reason(`${concurrent} concurrent users ÷ (${SESSION_DENSITY[i.persona]} per vCPU × ${vcpu} vCPU) → ${hosts} session host(s).`, { source: VDI_SOURCES.density }),
        reason(`${vcpu * 4} GiB per host (4 GiB per vCPU).`, { assumption: true }),
        ...(platform === 'azure' ? [reason(`AVD scaling plan: min ${min} (off-peak ${Math.round(offPeak * 100)}%), max ${hosts}.`, { source: VDI_SOURCES.avd, assumption: true })] : []),
        ...c.reasons,
      ],
      alternatives: c.alternatives,
    });
  }
  const profilesGib = Math.ceil(i.users * i.profileGib * 1.2);
  rows.push({
    key: `vdi-profiles:${i.component}`, demand: { users: i.users, profileGib: i.profileGib }, choice: `${profilesGib} GiB`,
    detail: { store: platform === 'azure' ? 'Azure Files premium (FSLogix)' : platform === 'aws' ? 'FSx for Windows (profiles)' : 'file share (profiles)', sizeGib: profilesGib },
    fits: true, reasons: [reason(`${i.users} users × ${i.profileGib} GiB × 1.2.`, { source: VDI_SOURCES.fslogix })], alternatives: [],
  });
  return { rows, findings };
}

export const vdiEngine                         = {
  id: 'vdi',
  applies: (c) => isPattern(c) && (c.tierPattern === 'vdi-service' || ['citrix-vda', 'rds-host', 'horizon'].includes(c.workloadType ?? '') || c.tier === 'vdi'),
  inputs(c              , plan      )           {
    const a = appPlanOf(c, plan)?.answers ?? {};
    const app = plan.apps.find((x) => x.id === appPlanOf(c, plan)?.app);
    const persona = str(c, 'vdi.persona', a['persona'] ?? 'medium');
    return {
      component: c.id,
      users: num(c, 'vdi.users', Number(a['users'] ?? app?.users ?? 0)),
      concurrentPct: num(c, 'vdi.concurrentPct', Number(a['concurrentPct'] ?? 100)),
      persona: (['light', 'medium', 'heavy'].includes(persona) ? persona : 'medium')           ,
      persistent: str(c, 'vdi.persistent', a['persistent'] ?? 'no') === 'yes',
      profileGib: num(c, 'vdi.profileGib', Number(a['profileGib'] ?? 30)),
      gpu: str(c, 'vdi.gpu', a['gpu'] ?? 'no') === 'yes',
      hostVcpu: num(c, 'vdi.hostVcpu', 16),
    };
  },
  size(input, platform, policy) {
    const r = sizeVdi(input, platform, policy);
    return rec('vdi', platform, r.rows, r.findings);
  },
};
